// Video jobs (stage 0.7). NanoGPT's video generation is asynchronous: `POST /api/generate-video` answers 202 with a `runId`,
// `GET /api/video/status?requestId=` reports progress, and a finished video is a link that expires in about a day. The
// plugin therefore keeps each job (media-jobs.ts), asks NanoGPT about a job that is not finished when the browser asks
// the plugin (never more often than every `pollIntervalMs`), and on completion downloads the file into the user's own
// folder, so the video outlives NanoGPT's copy.
//
// NOTHING HERE WAS EXERCISED AGAINST THE LIVE SERVICE (video was not probed: it costs real money). The status is read in both
// documented shapes (domain/media-wire.ts parseVideoStatus), the cost at submit is an estimate and the final figure comes
// with the completed status (an `adjust` line in the usage log); a failed job is assumed refunded as the docs say.
// There is no cancel upstream: DELETE only forgets the job and its file here.
import { estimateVideoCost } from '../../domain/media';
import { buildVideoBody, requestedSeconds } from '../../domain/media-request';
import { parseVideoStatus, parseVideoSubmit } from '../../domain/media-wire';
import type { MediaCost, VideoJob, VideoRequest } from '../../shared/contracts-media';
import { contentTypeOf, MediaCallError, openPublic } from '../media-call';
import { FileTooLarge, isJobId, isTerminal, type StoredJob } from '../media-jobs';
import type { SecretValue } from '../secret-value';
import type { ServerDeps } from '../types';
import { HttpError, type RequestUser } from './http';
import {
    answerJson,
    failedCall,
    isOk,
    mediaRequest,
    modelFor,
    upstreamFailure,
    writeUsage,
    type CallRecord,
} from './media-api';
import { resolveKey } from './nanogpt';

/** A job nobody finished within a day is given up on (NanoGPT keeps results about that long). */
const STALE_AFTER_MS = 24 * 60 * 60_000;
/** How many polls in a row may say "no such job" (after the first minute) before the job is given up on. */
const MAX_MISSES = 5;
/** How many times a failing download is retried (one per poll) before the job keeps its link only. */
const MAX_DOWNLOAD_TRIES = 3;
const MAX_ANSWER = 1024 * 1024;

interface PollState {
    lastPollAt: number;
    misses: number;
    downloadTries: number;
}

interface VideoState {
    polls: Map<string, PollState>;
    inflight: Map<string, Promise<StoredJob>>;
}

const states = new WeakMap<object, VideoState>();

function stateOf(deps: ServerDeps): VideoState {
    let state = states.get(deps);
    if (!state) {
        state = { polls: new Map(), inflight: new Map() };
        states.set(deps, state);
    }
    return state;
}

const keyOf = (user: RequestUser, id: string): string => `${user.root}\u0000${id}`;

/** A stored job as the contract's VideoJob (the plugin's own bookkeeping stays inside). */
export function toVideoJob(job: StoredJob): VideoJob {
    return {
        id: job.id,
        model: job.model,
        prompt: job.prompt,
        status: job.status,
        progress: job.progress,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        cost: job.cost,
        connectionId: job.connectionId,
        output: job.output,
        error: job.error,
    };
}

/* ------------------------------------------------------------------------------------------------ submit */

export async function submitVideo(deps: ServerDeps, user: RequestUser, request: VideoRequest): Promise<VideoJob> {
    const model = await modelFor(deps, 'video', request.model);
    const key = resolveKey(deps, user, request.keyId ?? null);
    const started = deps.now();
    const record: CallRecord = {
        deps,
        user,
        medium: 'video',
        model: request.model,
        connectionId: request.connectionId ?? null,
        started,
    };
    let answer;
    try {
        answer = await mediaRequest(
            deps,
            key,
            {
                method: 'POST',
                path: '/api/generate-video',
                body: JSON.stringify(buildVideoBody(model, request)),
                billing: request.billing ?? 'auto',
                timeoutMs: deps.media.timeouts.videoSubmitMs,
            },
            MAX_ANSWER,
        );
    } catch (error) {
        throw await failedCall(record, error as HttpError);
    }
    if (!isOk(answer.status)) throw await failedCall(record, upstreamFailure(key, answer));
    const parsed = parseVideoSubmit(answerJson(key, answer));
    if (!isJobId(parsed.runId)) {
        throw await failedCall(
            record,
            new HttpError(502, 'upstream_error', 'NanoGPT accepted the video but gave no usable job id'),
        );
    }

    const estimate = estimateVideoCost(model, {
        ...(request.duration !== undefined ? { duration: request.duration } : {}),
        ...(request.resolution ? { resolution: request.resolution } : {}),
    });
    const usd = parsed.usd ?? estimate;
    const cost: MediaCost = {
        usd,
        source: parsed.usd !== null ? 'response' : estimate !== null ? 'estimate' : 'unknown',
        estimateUsd: estimate,
        paymentSource: parsed.paymentSource,
        remainingUsd: parsed.remainingUsd,
    };
    const job: StoredJob = {
        id: parsed.runId,
        model: request.model,
        prompt: request.prompt,
        status: 'queued',
        progress: null,
        createdAt: started,
        updatedAt: started,
        cost,
        connectionId: request.connectionId ?? null,
        output: null,
        error: null,
        keyId: request.keyId ?? null,
        usageAt: started,
        adjusted: false,
    };
    deps.media.jobs.put(user.root, job);
    await writeUsage(record, {
        requestId: parsed.runId,
        units: requestedSeconds(request),
        usd: cost.usd,
        costSource: cost.source,
        paymentSource: parsed.paymentSource,
        status: answer.status,
        error: null,
    });
    return toVideoJob(job);
}

/* ------------------------------------------------------------------------------------------------ read, poll */

export function listVideos(deps: ServerDeps, user: RequestUser): VideoJob[] {
    return deps.media.jobs.list(user.root).map(toVideoJob);
}

/** The job, polled at NanoGPT first when it is not finished and the last poll is old enough. */
export async function getVideo(deps: ServerDeps, user: RequestUser, id: string): Promise<VideoJob> {
    if (!isJobId(id)) throw new HttpError(404, 'not_found', 'No such video job');
    const job = deps.media.jobs.get(user.root, id);
    if (!job) throw new HttpError(404, 'not_found', 'No such video job');
    const state = stateOf(deps);
    const key = keyOf(user, id);
    const waiting = state.inflight.get(key);
    if (waiting) return toVideoJob(await waiting);

    const due =
        needsWork(deps, user, job) && deps.now() - (state.polls.get(key)?.lastPollAt ?? 0) >= deps.media.pollIntervalMs;
    if (!due) return toVideoJob(job);
    const work = refresh(deps, user, job).finally(() => {
        if (state.inflight.get(key) === work) state.inflight.delete(key);
    });
    state.inflight.set(key, work);
    return toVideoJob(await work);
}

/** Not finished, or finished but its file is not saved yet (and there is a link to save it from). */
function needsWork(deps: ServerDeps, user: RequestUser, job: StoredJob): boolean {
    if (!isTerminal(job.status)) return true;
    return (
        job.status === 'completed' &&
        job.output?.url !== undefined &&
        !deps.media.jobs.hasFile(user.root, job.id) &&
        (stateOf(deps).polls.get(keyOf(user, job.id))?.downloadTries ?? 0) < MAX_DOWNLOAD_TRIES
    );
}

function pollState(deps: ServerDeps, user: RequestUser, id: string): PollState {
    const state = stateOf(deps);
    const key = keyOf(user, id);
    let poll = state.polls.get(key);
    if (!poll) {
        poll = { lastPollAt: 0, misses: 0, downloadTries: 0 };
        state.polls.set(key, poll);
    }
    return poll;
}

/** The key that submitted the job; when it was deleted since, the active key (a job is the account's, not the key's, to read). */
function keyFor(deps: ServerDeps, user: RequestUser, job: StoredJob): SecretValue | null {
    try {
        return resolveKey(deps, user, job.keyId);
    } catch {
        try {
            return resolveKey(deps, user, null);
        } catch {
            return null;
        }
    }
}

/** Absolute http(s) URL of a link NanoGPT gave (it may be a path on the media host). */
function absoluteUrl(deps: ServerDeps, url: string): string {
    return new URL(url, `${deps.config.mediaBase.replace(/\/+$/, '')}/`).toString();
}

async function refresh(deps: ServerDeps, user: RequestUser, job: StoredJob): Promise<StoredJob> {
    const poll = pollState(deps, user, job.id);
    poll.lastPollAt = deps.now();
    const now = deps.now();
    let current = job;

    // 1. Ask NanoGPT while the job is not finished.
    if (!isTerminal(current.status)) {
        const key = keyFor(deps, user, current);
        if (!key) return current;
        let answer;
        try {
            answer = await mediaRequest(
                deps,
                key,
                {
                    method: 'GET',
                    path: `/api/video/status?requestId=${encodeURIComponent(current.id)}`,
                    timeoutMs: deps.media.timeouts.videoStatusMs,
                },
                MAX_ANSWER,
            );
        } catch {
            return current; // NanoGPT unreachable or slow: the job is what it was, the next poll tries again
        }
        if (answer.status === 404) {
            poll.misses += 1;
            // Right after the submit NanoGPT may not know the job yet; a job still unknown a minute later is gone.
            if (now - current.createdAt > 60_000 && poll.misses >= MAX_MISSES) {
                current = await finish(deps, user, current, key, {
                    status: 'failed',
                    error: 'NanoGPT no longer knows this job',
                    usd: null,
                });
            }
            return current;
        }
        if (!isOk(answer.status)) return current;
        poll.misses = 0;
        const parsed = parseVideoStatus(answerJson(key, answer));
        if (parsed.status === 'failed' || parsed.status === 'expired') {
            const error = parsed.error !== null ? key.redact(parsed.error) : 'The job failed';
            current = await finish(deps, user, current, key, { status: parsed.status, error, usd: parsed.usd });
        } else if (parsed.status === 'completed' && parsed.url !== null) {
            const link = absoluteUrl(deps, parsed.url);
            current = {
                ...current,
                status: 'completed',
                progress: 1,
                updatedAt: now,
                output: { kind: 'video', mime: 'video/mp4', url: link },
                cost: parsed.usd !== null ? { ...current.cost, usd: parsed.usd, source: 'response' } : current.cost,
            };
            deps.media.jobs.put(user.root, current);
            if (parsed.usd !== null) current = await adjustCost(deps, user, current, parsed.usd, 'response');
            else current = await markAdjusted(deps, user, current);
        } else {
            // Queued, running, an unknown word, or "completed" with no link yet: still in flight.
            const status = parsed.status === 'queued' || parsed.status === 'running' ? parsed.status : current.status;
            const progress = parsed.progress ?? current.progress;
            if (status !== current.status || progress !== current.progress) {
                current = { ...current, status, progress, updatedAt: now };
                deps.media.jobs.put(user.root, current);
            }
        }
        if (current.status === 'queued' || current.status === 'running') {
            if (now - current.createdAt > STALE_AFTER_MS) {
                current = await finish(deps, user, current, key, {
                    status: 'expired',
                    error: 'NanoGPT stopped reporting this job',
                    usd: null,
                });
            }
            return current;
        }
    }

    // 2. A finished job whose file is not saved yet: download it from the link.
    if (current.status === 'completed' && current.output?.url && !deps.media.jobs.hasFile(user.root, current.id)) {
        current = await save(deps, user, current, poll);
    }
    return current;
}

/** The job reached a terminal state that is not a success: store it, and correct the usage record. */
async function finish(
    deps: ServerDeps,
    user: RequestUser,
    job: StoredJob,
    key: SecretValue,
    outcome: { status: 'failed' | 'expired'; error: string; usd: number | null },
): Promise<StoredJob> {
    const now = deps.now();
    const next: StoredJob = { ...job, status: outcome.status, error: key.redact(outcome.error), updatedAt: now };
    deps.media.jobs.put(user.root, next);
    // A failed job is refunded by NanoGPT (documented, not verified); an expired one was real work and keeps its cost.
    if (outcome.status === 'failed') {
        const refunded = outcome.usd ?? 0;
        return adjustCost(deps, user, next, refunded, outcome.usd !== null ? 'response' : 'estimate');
    }
    return markAdjusted(deps, user, next);
}

async function adjustCost(
    deps: ServerDeps,
    user: RequestUser,
    job: StoredJob,
    usd: number,
    source: 'response' | 'estimate',
): Promise<StoredJob> {
    if (!job.adjusted) {
        await deps.usage.adjust(user.root, job.usageAt, {
            adjust: true,
            requestId: job.id,
            costUsd: usd,
            costSource: source,
            at: deps.now(),
        });
    }
    const next: StoredJob = { ...job, adjusted: true, cost: { ...job.cost, usd, source } };
    deps.media.jobs.put(user.root, next);
    return next;
}

async function markAdjusted(deps: ServerDeps, user: RequestUser, job: StoredJob): Promise<StoredJob> {
    if (job.adjusted) return job;
    const next: StoredJob = { ...job, adjusted: true };
    deps.media.jobs.put(user.root, next);
    return next;
}

/* ------------------------------------------------------------------------------------------------ the file */

async function save(deps: ServerDeps, user: RequestUser, job: StoredJob, poll: PollState): Promise<StoredJob> {
    const url = job.output?.url;
    if (!url) return job;
    poll.downloadTries += 1;
    const { jobs } = deps.media;
    let handle;
    try {
        handle = await openPublic(deps.media.env, url, deps.media.timeouts.videoDownloadMs);
    } catch (error) {
        return noteDownloadFailure(deps, user, job, poll, error instanceof MediaCallError && error.kind === 'timeout');
    }
    try {
        if (handle.status === 403 || handle.status === 404 || handle.status === 410) {
            const next: StoredJob = {
                ...job,
                status: 'expired',
                error: 'The video is no longer available at NanoGPT and was not saved in time',
                updatedAt: deps.now(),
            };
            jobs.put(user.root, next);
            return next;
        }
        if (!isOk(handle.status)) return noteDownloadFailure(deps, user, job, poll, false);
        const declared = Number(handle.headers['content-length']);
        if (Number.isFinite(declared) && declared > deps.media.maxVideoBytes) throw new FileTooLarge();
        const source = (async function* () {
            for await (const chunk of handle.body) {
                handle.touch();
                yield chunk;
            }
        })();
        const bytes = await jobs.saveFile(user.root, job.id, source, deps.media.maxVideoBytes);
        const mime = contentTypeOf(handle.headers);
        const stillThere = jobs.get(user.root, job.id);
        if (!stillThere) {
            // Forgotten while the download ran: leave nothing behind.
            jobs.discardFile(user.root, job.id);
            return job;
        }
        const next: StoredJob = {
            ...stillThere,
            updatedAt: deps.now(),
            output: {
                kind: 'video',
                mime: mime?.startsWith('video/') ? mime : 'video/mp4',
                ...(stillThere.output?.url ? { url: stillThere.output.url } : {}),
                bytes,
                file: `/media/files/${job.id}`,
            },
            error: null,
        };
        jobs.put(user.root, next);
        return next;
    } catch (error) {
        if (error instanceof FileTooLarge) {
            const next: StoredJob = {
                ...job,
                error: `The video is larger than ${Math.round(deps.media.maxVideoBytes / (1024 * 1024))} MB and was not saved; the link at NanoGPT still works for about a day`,
                updatedAt: deps.now(),
            };
            poll.downloadTries = MAX_DOWNLOAD_TRIES;
            jobs.put(user.root, next);
            return next;
        }
        return noteDownloadFailure(deps, user, job, poll, error instanceof MediaCallError && error.kind === 'timeout');
    } finally {
        handle.close();
    }
}

function noteDownloadFailure(
    deps: ServerDeps,
    user: RequestUser,
    job: StoredJob,
    poll: PollState,
    timedOut: boolean,
): StoredJob {
    if (poll.downloadTries < MAX_DOWNLOAD_TRIES) return job; // the next poll tries again
    const next: StoredJob = {
        ...job,
        error: timedOut
            ? 'The video could not be saved: NanoGPT stopped sending the file'
            : 'The video could not be saved; the link at NanoGPT still works for about a day',
        updatedAt: deps.now(),
    };
    deps.media.jobs.put(user.root, next);
    return next;
}

/* ------------------------------------------------------------------------------------------------ forget */

export function forgetVideo(deps: ServerDeps, user: RequestUser, id: string): void {
    if (!isJobId(id) || !deps.media.jobs.remove(user.root, id))
        throw new HttpError(404, 'not_found', 'No such video job');
    const state = stateOf(deps);
    state.polls.delete(keyOf(user, id));
}
