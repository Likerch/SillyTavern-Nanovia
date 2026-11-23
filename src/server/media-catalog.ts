// The catalog of the four media (stage 0.7, docs/ARCHITECTURE.md §9): NanoGPT's public model lists, fetched without a key
// from the media host, normalised by domain/media.ts and kept in memory per medium.
//
//   image  GET <mediaBase>/api/v1/images/models
//   video  GET <mediaBase>/api/v1/video-models?detailed=true
//   tts    GET <mediaBase>/api/v1/audio-models?type=tts&detailed=true
//   stt    GET <mediaBase>/api/v1/audio-models?type=stt&detailed=true
//
// Same shape as the chat catalog (catalog.ts): a fresh copy answers as `cache`, a fetch is awaited for requests and answers
// as `live`, a failed fetch falls back to the old copy as `stale`; the proxy and the routes' validation read memory only
// (`lookup`) and never wait. A copy is written to `<data root>/_nanovia/media-<medium>.json` after every fetch and read back
// at start, so the models are known at once and while NanoGPT is down. The lists are served with `s-maxage=3600`, so a copy
// is fresh for one hour. Errors are logged as a short code (never a body: these endpoints take no key).
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMediaList } from '../domain/media';
import { isRecord } from '../domain/usage';
import { MEDIA_MEDIA, type MediaCatalogResponse, type MediaModel, type Medium } from '../shared/contracts-media';
import { GLOBAL_DIR_NAME, writeFileAtomic } from './store';
import type { FetchLike, Logger } from './types';
import { errorCode } from './upstream';

export const MEDIA_CATALOG_VERSION = 1;
/** A copy is fresh for this long after a fetch. */
export const MEDIA_CATALOG_TTL_MS = 60 * 60_000;
export const MEDIA_FETCH_TIMEOUT_MS = 20_000;
/** After a failed fetch nothing tries again (and nothing that has a copy to serve waits) for this long. */
export const MEDIA_FAILURE_BACKOFF_MS = 60_000;

export const mediaCacheFile = (medium: Medium): string => `media-${medium}.json`;

/** The list URL of a medium below the media host. */
export function mediaListUrl(base: string, medium: Medium): string {
    const root = base.replace(/\/+$/, '');
    switch (medium) {
        case 'image':
            return `${root}/api/v1/images/models`;
        case 'video':
            return `${root}/api/v1/video-models?detailed=true`;
        case 'tts':
            return `${root}/api/v1/audio-models?type=tts&detailed=true`;
        case 'stt':
            return `${root}/api/v1/audio-models?type=stt&detailed=true`;
    }
}

/** The knobs the app passes through (tests shrink them). */
export interface MediaCatalogTuning {
    /** Fetch on our own: at start, and when `lookup` finds the data missing or old. Off by default (tests); index.ts turns it on. */
    autoFetch?: boolean;
    ttlMs?: number;
    timeoutMs?: number;
    failureBackoffMs?: number;
}

export interface MediaCatalogOptions extends MediaCatalogTuning {
    /** The media host without a trailing slash (`ServerConfig.mediaBase`). */
    mediaBase: string;
    /** The ST data root: the cache files live under `<root>/_nanovia`. */
    dataRoot: () => string;
    fetch: FetchLike;
    version: string;
    now: () => number;
    log: Logger;
}

export interface MediaCatalogService {
    /** Reads the cache files; with `autoFetch`, starts a fetch for every medium without a fresh copy. Never throws. */
    start(): void;
    /**
     * The models of a medium for a request: a fresh copy as `cache`, else a fetch is awaited (an already running one is
     * joined) and answers `live`; when it fails the old copy answers `stale`. A copy is also served `stale` at once while
     * a fetch is running or just failed. Null = no copy at all and NanoGPT cannot be reached.
     */
    catalog(medium: Medium, options?: { refresh?: boolean }): Promise<MediaCatalogResponse | null>;
    /** Synchronous, from memory: one model by its exact id; null while the list is not loaded or the id is unknown. */
    lookup(medium: Medium, id: string): MediaModel | null;
    /** Synchronous: the models in memory ([] before the first load). */
    models(medium: Medium): MediaModel[];
    /** Resolves when no fetch is running (tests, graceful shutdown). */
    settled(): Promise<void>;
    /** Aborts running fetches and stops new ones. */
    close(): void;
}

interface Snapshot {
    models: MediaModel[];
    fetchedAt: number;
    byId: Map<string, MediaModel>;
}

class FetchFailure extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'FetchFailure';
    }
}

/** The fields the plugin reads from a stored model; the file is ours but may be edited or truncated. */
function isStoredModel(value: unknown, medium: Medium): value is MediaModel {
    if (!isRecord(value)) return false;
    return (
        typeof value['id'] === 'string' &&
        value['id'] !== '' &&
        value['medium'] === medium &&
        typeof value['name'] === 'string' &&
        isRecord(value['price']) &&
        isRecord(value['price']['byKey']) &&
        isRecord(value['capabilities']) &&
        Array.isArray(value['params']) &&
        Array.isArray(value['tags']) &&
        Array.isArray(value['voices']) &&
        Array.isArray(value['formats'])
    );
}

export function createMediaCatalog(options: MediaCatalogOptions): MediaCatalogService {
    const { fetch, log, now } = options;
    const base = options.mediaBase.replace(/\/+$/, '');
    const autoFetch = options.autoFetch ?? false;
    const ttlMs = options.ttlMs ?? MEDIA_CATALOG_TTL_MS;
    const timeoutMs = options.timeoutMs ?? MEDIA_FETCH_TIMEOUT_MS;
    const backoffMs = options.failureBackoffMs ?? MEDIA_FAILURE_BACKOFF_MS;

    const snapshots = new Map<Medium, Snapshot>();
    const flights = new Map<Medium, Promise<boolean>>();
    const failedAt = new Map<Medium, number>();
    const announced = new Set<Medium>();
    const controllers = new Set<AbortController>();
    let closed = false;

    const makeSnapshot = (models: MediaModel[], fetchedAt: number): Snapshot => ({
        models,
        fetchedAt,
        byId: new Map(models.map((m) => [m.id, m])),
    });
    const isExpired = (value: Snapshot): boolean => now() - value.fetchedAt >= ttlMs;
    const backingOff = (medium: Medium): boolean => {
        const at = failedAt.get(medium);
        return at !== undefined && now() - at < backoffMs;
    };

    /** One public GET of a list; the answer is parsed as JSON, any other status is a failure. */
    async function getJson(url: string): Promise<unknown> {
        if (closed) throw new FetchFailure('closed');
        const controller = new AbortController();
        controllers.add(controller);
        let timer: ReturnType<typeof setTimeout> | undefined;
        // A fetch that ignores its signal must not hang the request: the timeout wins the race on its own.
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new FetchFailure('timeout'));
                controller.abort();
            }, timeoutMs);
            timer.unref?.();
        });
        const work = (async () => {
            const response = await fetch(url, {
                method: 'GET',
                headers: { accept: 'application/json', 'user-agent': `Nanovia/${options.version}` },
                signal: controller.signal,
            });
            const ok = response.status >= 200 && response.status < 300;
            return { status: response.status, body: ok ? await response.text() : '' };
        })();
        work.catch(() => {}); // a failure that arrives after the timeout was already reported
        try {
            const { status, body } = await Promise.race([work, timeout]);
            if (status < 200 || status >= 300) throw new FetchFailure(`http ${status}`);
            try {
                return JSON.parse(body) as unknown;
            } catch {
                throw new FetchFailure('invalid JSON');
            }
        } catch (error) {
            if (error instanceof FetchFailure) throw error;
            throw new FetchFailure(closed ? 'closed' : (errorCode(error) ?? 'unreachable'));
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            controllers.delete(controller);
        }
    }

    function cachePath(medium: Medium): string {
        return path.join(options.dataRoot(), GLOBAL_DIR_NAME, mediaCacheFile(medium));
    }

    function persist(medium: Medium, value: Snapshot): void {
        try {
            const file = cachePath(medium);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            writeFileAtomic(
                file,
                JSON.stringify({ version: MEDIA_CATALOG_VERSION, fetchedAt: value.fetchedAt, models: value.models }),
            );
        } catch (error) {
            log.warn(`media catalog cache (${medium}) could not be written (${errorCode(error) ?? 'io error'})`);
        }
    }

    function loadCache(medium: Medium): Snapshot | null {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(cachePath(medium), 'utf8'));
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') log.warn(`media catalog cache (${medium}) is unreadable and is ignored`);
            return null;
        }
        if (!isRecord(raw) || raw['version'] !== MEDIA_CATALOG_VERSION || !Array.isArray(raw['models'])) return null;
        const at = raw['fetchedAt'];
        if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
        const seen = new Set<string>();
        const models: MediaModel[] = [];
        for (const item of raw['models'] as unknown[]) {
            if (!isStoredModel(item, medium) || seen.has(item.id)) continue;
            seen.add(item.id);
            models.push(item);
        }
        // A clock that went backwards must not make an old copy look newer than now.
        return models.length > 0 ? makeSnapshot(models, Math.min(at, now())) : null;
    }

    async function fetchMedium(medium: Medium): Promise<boolean> {
        try {
            const json = await getJson(mediaListUrl(base, medium));
            const models = normalizeMediaList(medium, json);
            // An empty answer is junk: it must not replace a good copy.
            if (models.length === 0) throw new FetchFailure('no models in the answer');
            if (closed) return false;
            const quiet = announced.has(medium) && !failedAt.has(medium);
            const next = makeSnapshot(models, now());
            snapshots.set(medium, next);
            failedAt.delete(medium);
            announced.add(medium);
            persist(medium, next);
            if (!quiet) log.info(`media catalog loaded: ${models.length} ${medium} models`);
            return true;
        } catch (error) {
            if (closed) return false;
            const reason = error instanceof FetchFailure ? error.reason : (errorCode(error) ?? 'error');
            if (!failedAt.has(medium)) {
                log.warn(
                    `media catalog fetch failed for ${medium} (${reason})${snapshots.has(medium) ? '; the stored copy is used' : ''}`,
                );
            }
            failedAt.set(medium, now());
            return false;
        }
    }

    /** Single-flight per medium: every caller during a fetch gets the same promise. Resolves true when new data arrived; never rejects. */
    function refresh(medium: Medium): Promise<boolean> {
        const running = flights.get(medium);
        if (running) return running;
        const flight: Promise<boolean> = fetchMedium(medium).finally(() => {
            if (flights.get(medium) === flight) flights.delete(medium);
        });
        flights.set(medium, flight);
        return flight;
    }

    /** A fetch nobody waits for; honours `autoFetch`, a running fetch and the failure backoff. */
    function kick(medium: Medium): void {
        if (!autoFetch || closed || flights.has(medium) || backingOff(medium)) return;
        void refresh(medium);
    }

    function respond(value: Snapshot, medium: Medium, source: MediaCatalogResponse['source']): MediaCatalogResponse {
        return { medium, models: value.models, fetchedAt: value.fetchedAt, source };
    }

    return {
        start() {
            if (closed) return;
            for (const medium of MEDIA_MEDIA) {
                if (!snapshots.has(medium)) {
                    const loaded = loadCache(medium);
                    if (loaded) snapshots.set(medium, loaded);
                }
                const held = snapshots.get(medium);
                if (!held || isExpired(held)) kick(medium);
            }
        },

        async catalog(medium, opts = {}) {
            const held = snapshots.get(medium);
            if (held && !opts.refresh) {
                if (!isExpired(held)) return respond(held, medium, 'cache');
                // Old copy, but a fetch is already running (start-up) or NanoGPT just failed: do not make the caller wait.
                if (flights.has(medium) || backingOff(medium)) return respond(held, medium, 'stale');
            }
            const fetched = await refresh(medium);
            const current = snapshots.get(medium);
            if (!current) return null;
            return respond(current, medium, fetched ? 'live' : 'stale');
        },

        lookup(medium, id) {
            const held = snapshots.get(medium);
            if (!held) {
                kick(medium);
                return null;
            }
            if (isExpired(held)) kick(medium);
            return held.byId.get(typeof id === 'string' ? id.trim() : '') ?? null;
        },

        models(medium) {
            return snapshots.get(medium)?.models ?? [];
        },

        async settled() {
            while (flights.size > 0) await Promise.all([...flights.values()]);
        },

        close() {
            closed = true;
            for (const controller of controllers) controller.abort();
            controllers.clear();
        },
    };
}
