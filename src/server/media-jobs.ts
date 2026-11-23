// Video jobs of a user (stage 0.7). NanoGPT's video generation is asynchronous and takes minutes; the plugin remembers each
// job so the browser can come back to it after a reload and so a plugin restart does not lose it.
//
//   <user root>/nanovia/media-jobs.json     { version: 1, jobs: StoredJob[] }   at most 100, atomic writes, mode 0600
//   <user root>/nanovia/media/<id>.mp4      the saved file of a completed job
//
// The file name is built from the job id (the `runId` NanoGPT gave, checked against ID_PATTERN so it can hold no path
// separator) and never from anything a client sent: GET /media/files/:id looks the id up among the user's own jobs first.
// All metadata I/O is synchronous (a read-modify-write never interleaves with another request); the file download streams
// into a `.part` file and is renamed into place when complete.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isRecord, parseCost } from '../domain/usage';
import type { MediaCost, MediaOutput, VideoJob, VideoStatus } from '../shared/contracts-media';
import { USER_DIR_NAME, writeFileAtomic } from './store';
import type { Logger } from './types';

export const JOBS_FILE = 'media-jobs.json';
export const JOBS_FILE_VERSION = 1;
export const MEDIA_DIR = 'media';
export const MAX_JOBS = 100;
/** Job ids come from NanoGPT (`vid_…`); anything else is refused before it can become a file name. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const isJobId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

/** A job as stored: the contract's VideoJob plus what the plugin needs to carry it across a restart. */
export interface StoredJob extends VideoJob {
    /** The ST secret id of the key that submitted it (null = the active key); the same key must poll it. */
    keyId: string | null;
    /** `at` of the usage record written at submit: the day file an `adjust` line goes into. */
    usageAt: number;
    /** The final cost (or the refund of a failure) was already written to the usage log. */
    adjusted: boolean;
}

export const TERMINAL: readonly VideoStatus[] = ['completed', 'failed', 'expired'];
export const isTerminal = (status: VideoStatus): boolean => TERMINAL.includes(status);

export class FileTooLarge extends Error {
    constructor() {
        super('file too large');
        this.name = 'FileTooLarge';
    }
}

export interface MediaJobStore {
    /** The user's jobs, newest first. */
    list(userRoot: string): StoredJob[];
    get(userRoot: string, id: string): StoredJob | null;
    /** Adds or replaces a job (matched by id). Over the cap the oldest jobs go, with their files. */
    put(userRoot: string, job: StoredJob): void;
    /** Forgets a job and deletes its file. Returns what was removed, null when there was no such job. */
    remove(userRoot: string, id: string): StoredJob | null;
    /** Where the saved copy of a job lives (does not say whether it exists). The id must be a job id. */
    filePath(userRoot: string, id: string): string;
    /** The saved copy exists. */
    hasFile(userRoot: string, id: string): boolean;
    /** Deletes the saved copy of a job id (no error when there is none), whether or not the job is still known. */
    discardFile(userRoot: string, id: string): void;
    /**
     * Streams `source` into the job's file (a `.part` file renamed when complete). At most `maxBytes`: more rejects with
     * FileTooLarge and leaves nothing behind. Resolves with the size.
     */
    saveFile(userRoot: string, id: string, source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<number>;
}

export interface MediaJobOptions {
    log: Logger;
    maxJobs?: number;
}

const STATUSES: readonly VideoStatus[] = ['queued', 'running', 'completed', 'failed', 'expired'];
const SOURCES = ['response', 'lookup', 'estimate', 'unknown'] as const;

function number(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function costOf(raw: unknown): MediaCost {
    const c = isRecord(raw) ? raw : {};
    const source = SOURCES.find((s) => s === c['source']) ?? 'unknown';
    const usd = parseCost(c['usd']);
    return {
        usd,
        source: usd === null ? 'unknown' : source,
        estimateUsd: parseCost(c['estimateUsd']),
        paymentSource: typeof c['paymentSource'] === 'string' ? c['paymentSource'] : null,
        remainingUsd: parseCost(c['remainingUsd']),
    };
}

function outputOf(raw: unknown): MediaOutput | null {
    if (!isRecord(raw) || raw['kind'] !== 'video') return null;
    const url = typeof raw['url'] === 'string' && /^https?:\/\//i.test(raw['url']) ? raw['url'] : undefined;
    const file = typeof raw['file'] === 'string' ? raw['file'] : undefined;
    const bytes = number(raw['bytes']);
    return {
        kind: 'video',
        mime: typeof raw['mime'] === 'string' && raw['mime'] ? raw['mime'] : 'video/mp4',
        ...(url ? { url } : {}),
        ...(file ? { file } : {}),
        ...(bytes !== null ? { bytes } : {}),
    };
}

/** One entry of the jobs file; null when it is not a usable job (a bad id never becomes a file name). */
export function normalizeStoredJob(raw: unknown): StoredJob | null {
    if (!isRecord(raw) || !isJobId(raw['id'])) return null;
    const status = STATUSES.find((s) => s === raw['status']);
    const createdAt = number(raw['createdAt']);
    if (!status || createdAt === null || typeof raw['model'] !== 'string') return null;
    const progress = number(raw['progress']);
    return {
        id: raw['id'],
        model: raw['model'],
        prompt: typeof raw['prompt'] === 'string' ? raw['prompt'] : '',
        status,
        progress: progress === null ? null : Math.min(1, Math.max(0, progress)),
        createdAt,
        updatedAt: number(raw['updatedAt']) ?? createdAt,
        cost: costOf(raw['cost']),
        connectionId: typeof raw['connectionId'] === 'string' ? raw['connectionId'] : null,
        output: outputOf(raw['output']),
        error: typeof raw['error'] === 'string' ? raw['error'] : null,
        keyId: typeof raw['keyId'] === 'string' ? raw['keyId'] : null,
        usageAt: number(raw['usageAt']) ?? createdAt,
        adjusted: raw['adjusted'] === true,
    };
}

export function createMediaJobStore(options: MediaJobOptions): MediaJobStore {
    const { log } = options;
    const maxJobs = Math.max(1, options.maxJobs ?? MAX_JOBS);
    /** Loaded once per user root, then kept: every change goes through this store and is written at once. */
    const cache = new Map<string, StoredJob[]>();

    const dir = (userRoot: string): string => path.join(userRoot, USER_DIR_NAME);
    const mediaDir = (userRoot: string): string => path.join(dir(userRoot), MEDIA_DIR);
    const jobsFile = (userRoot: string): string => path.join(dir(userRoot), JOBS_FILE);

    function filePath(userRoot: string, id: string): string {
        if (!isJobId(id)) throw new Error('not a job id');
        return path.join(mediaDir(userRoot), `${id}.mp4`);
    }

    function removeFile(userRoot: string, id: string): void {
        try {
            fs.rmSync(filePath(userRoot, id), { force: true });
        } catch (error) {
            log.warn(`a saved video could not be deleted (${error instanceof Error ? error.message : 'io error'})`);
        }
    }

    function load(userRoot: string): StoredJob[] {
        const held = cache.get(userRoot);
        if (held) return held;
        let jobs: StoredJob[] = [];
        try {
            const raw: unknown = JSON.parse(fs.readFileSync(jobsFile(userRoot), 'utf8'));
            const list = isRecord(raw) && Array.isArray(raw['jobs']) ? (raw['jobs'] as unknown[]) : [];
            const seen = new Set<string>();
            for (const item of list) {
                const job = normalizeStoredJob(item);
                if (!job || seen.has(job.id)) continue;
                seen.add(job.id);
                jobs.push(job);
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (code !== 'ENOENT') log.warn('media-jobs.json is unreadable and is treated as empty');
            jobs = [];
        }
        jobs.sort((a, b) => b.createdAt - a.createdAt);
        // Half-saved downloads of a run that died in the middle are of no use.
        try {
            for (const name of fs.readdirSync(mediaDir(userRoot))) {
                if (name.endsWith('.part')) fs.rmSync(path.join(mediaDir(userRoot), name), { force: true });
            }
        } catch {
            // no media directory yet
        }
        cache.set(userRoot, jobs);
        return jobs;
    }

    function persist(userRoot: string, jobs: StoredJob[]): void {
        fs.mkdirSync(dir(userRoot), { recursive: true });
        writeFileAtomic(jobsFile(userRoot), `${JSON.stringify({ version: JOBS_FILE_VERSION, jobs }, null, 1)}\n`);
    }

    return {
        list: (userRoot) => load(userRoot).map((job) => structuredClone(job)),

        get(userRoot, id) {
            const job = load(userRoot).find((j) => j.id === id);
            return job ? structuredClone(job) : null;
        },

        put(userRoot, job) {
            const jobs = load(userRoot);
            const index = jobs.findIndex((j) => j.id === job.id);
            const next = structuredClone(job);
            if (index >= 0) jobs[index] = next;
            else jobs.unshift(next);
            jobs.sort((a, b) => b.createdAt - a.createdAt);
            while (jobs.length > maxJobs) {
                const dropped = jobs.pop();
                if (dropped) removeFile(userRoot, dropped.id);
            }
            persist(userRoot, jobs);
        },

        remove(userRoot, id) {
            const jobs = load(userRoot);
            const index = jobs.findIndex((j) => j.id === id);
            if (index < 0) return null;
            const [removed] = jobs.splice(index, 1);
            persist(userRoot, jobs);
            removeFile(userRoot, id);
            return removed ? structuredClone(removed) : null;
        },

        filePath,

        discardFile: removeFile,

        hasFile(userRoot, id) {
            try {
                return fs.statSync(filePath(userRoot, id)).isFile();
            } catch {
                return false;
            }
        },

        async saveFile(userRoot, id, source, maxBytes) {
            const target = filePath(userRoot, id);
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const part = `${target}.${randomBytes(4).toString('hex')}.part`;
            const handle = await fsp.open(part, 'w', 0o600);
            let size = 0;
            try {
                for await (const chunk of source) {
                    size += chunk.length;
                    if (size > maxBytes) throw new FileTooLarge();
                    await handle.write(chunk);
                }
                await handle.close();
                await fsp.rename(part, target);
                return size;
            } catch (error) {
                await handle.close().catch(() => {});
                await fsp.rm(part, { force: true });
                throw error;
            }
        },
    };
}
