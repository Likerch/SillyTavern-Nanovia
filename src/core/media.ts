// Media (image, video, speech, transcription) as the browser knows it (stage 0.7). Everything goes through the plugin: it
// owns the key, writes the usage log and keeps the video jobs, so without the plugin the honest state is "needs the plugin".
//
// What this store holds, and what it does not:
//   - the four catalogs, in memory only (the plugin keeps its own copy on disk; a 10 minute window here avoids asking it
//     on every redraw);
//   - the last result per medium, for the studios to show. Images and audio are large and are never persisted: a page
//     reload forgets them;
//   - the video jobs, polled every 5 s while any job is unfinished and someone watches (the studio), so a closed tab costs
//     nothing. A plugin that stops answering does not stop the polling and does not fail the jobs.
// The plugin already writes the usage record of every call, so nothing is counted here; after a call the usage store is only
// told to read again. An image's cost starts as a list-price figure and is corrected a little later by the plugin's billing
// lookup: this store re-reads the plugin's recent records for it a few times and updates the last result when it changed.
import type { MediaError, MediaResult, PluginMedia } from '../host';
import { isMediaPluginDown } from '../host';
import type { PluginAccount } from '../host';
import type {
    ImageRequest,
    ImageResult,
    MediaModel,
    Medium,
    SttRequest,
    SttResult,
    TtsRequest,
    TtsResult,
    VideoJob,
    VideoRequest,
} from '../shared/contracts-media';
import { MEDIA_MEDIA } from '../shared/contracts-media';
import type { ConnectionsService } from './connections';
import { selectModels } from './media-select';
import type { ModelQuery } from './media-select';
import type { Logger, Unsubscribe } from './types';
import type { UsageStore } from './usage';

/** A catalog is reused for this long before the plugin is asked again. */
export const MEDIA_CATALOG_TTL_MS = 10 * 60_000;
/** After a failed load a non-forced `ensure()` waits this long before asking again. */
export const MEDIA_RETRY_MS = 10_000;
export const VIDEO_POLL_MS = 5_000;
/** When the plugin's billing lookup is re-read for an image's real cost (ms after the call). */
export const COST_RECONCILE_DELAYS_MS: readonly number[] = [20_000, 45_000, 90_000];

export type MediaState =
    /** Nothing asked yet. */
    | 'idle'
    /** The plugin is not installed (or not loaded): media is reached by it only. */
    | 'needs_plugin'
    /** The plugin answers but does not know the media routes: an older plugin version. */
    | 'plugin_outdated'
    /** The plugin is installed but does not answer (or ST refused the session). */
    | 'plugin_down'
    /** The plugin has no NanoGPT key to call with. */
    | 'no_key'
    | 'ready';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface MediaCatalogView {
    medium: Medium;
    status: CatalogStatus;
    /** The last good list; empty before the first answer. */
    models: MediaModel[];
    fetchedAt: number | null;
    /** Where the plugin got the list: NanoGPT just now, its cache, or an expired copy while NanoGPT was down. */
    source: 'live' | 'cache' | 'stale' | null;
    /** Why the last load failed (the models, if any, are older than they should be). */
    error: MediaError | null;
}

/** The last result of each calling medium; video has its jobs instead. */
export interface MediaLast {
    image: ImageResult | null;
    tts: TtsResult | null;
    stt: SttResult | null;
}

export interface VideoJobsView {
    jobs: VideoJob[];
    /** The list was read at least once. */
    loaded: boolean;
    /** The last read or poll failed (the jobs are the last known). */
    error: MediaError | null;
}

export interface CallOptions {
    /** false: the result is not kept as the studio's last one (calls from the public API and from ST's TTS provider). */
    remember?: boolean;
}

export interface MediaStore {
    /** The models of a medium as loaded now (no network); `[]` before the first load. */
    models(medium: Medium): MediaModel[];
    model(medium: Medium, id: string): MediaModel | null;
    /** The models a studio or the catalog offers: filtered, searched and sorted (core/media-select.ts). */
    select(medium: Medium, query?: ModelQuery): MediaModel[];
    catalogView(medium: Medium): MediaCatalogView;
    /** What the plugin last told, overall: ready, no key, outdated, down, not installed. */
    state(): MediaState;
    /** The error behind a state other than `ready` and `idle`; null otherwise. */
    problem(): MediaError | null;
    /** Loads (or reuses) a catalog. Served from memory while fresh unless `refresh`. Never throws. */
    ensure(medium: Medium, options?: { refresh?: boolean }): Promise<MediaResult<MediaModel[]>>;
    generateImage(request: ImageRequest, options?: CallOptions): Promise<MediaResult<ImageResult>>;
    speak(request: TtsRequest, options?: CallOptions): Promise<MediaResult<TtsResult>>;
    transcribe(request: SttRequest, options?: CallOptions): Promise<MediaResult<SttResult>>;
    startVideo(request: VideoRequest): Promise<MediaResult<VideoJob>>;
    /** Asks NanoGPT (through the plugin) about one job and keeps the answer in the list. */
    videoStatus(id: string): Promise<MediaResult<VideoJob>>;
    /** Forgets a job and its saved file at the plugin (NanoGPT has no cancel: a running job still finishes and bills). */
    deleteVideo(id: string): Promise<MediaResult<true>>;
    videos(): VideoJobsView;
    /** Reads the plugin's job list. Never throws. */
    refreshVideos(): Promise<void>;
    /**
     * Starts polling the unfinished video jobs (counted: several watchers share one timer) and returns the stop function.
     * The timer only runs while a job is unfinished.
     */
    watchVideos(): Unsubscribe;
    last(): MediaLast;
    /** Forgets the kept result of a medium (the studio's "clear" button). */
    clearLast(medium: 'image' | 'tts' | 'stt'): void;
    onChange(listener: () => void): Unsubscribe;
    /** Stops every timer. */
    dispose(): void;
}

export interface MediaStoreDeps {
    media: PluginMedia;
    /** Told to read again after a call (the plugin wrote the record), and given the corrected record of an image. */
    usage: Pick<UsageStore, 'refresh' | 'ingest'>;
    /** The recent records of the plugin's log: where an image's corrected cost shows up. */
    account: Pick<PluginAccount, 'recent'>;
    /** Tells "not installed" from "installed but too old" (the plugin answers, the media routes do not). */
    connections: Pick<ConnectionsService, 'pluginUp' | 'checked'>;
    log: Logger;
    now?: () => number;
    ttlMs?: number;
    retryMs?: number;
    pollMs?: number;
    reconcileDelaysMs?: readonly number[];
}

interface Slot {
    status: CatalogStatus;
    models: MediaModel[];
    fetchedAt: number | null;
    /** When this browser got the list (the plugin's own clock may differ): what the freshness window counts from. */
    loadedAt: number | null;
    source: MediaCatalogView['source'];
    error: MediaError | null;
    failedAt: number | null;
    inflight: Promise<MediaResult<MediaModel[]>> | null;
    /** Bumped by every load; an answer of an older load is dropped. */
    generation: number;
}

function emptySlot(): Slot {
    return {
        status: 'idle',
        models: [],
        fetchedAt: null,
        loadedAt: null,
        source: null,
        error: null,
        failedAt: null,
        inflight: null,
        generation: 0,
    };
}

/** A job NanoGPT is still working on (queued or running): the ones that are polled. */
export function isActiveJob(job: VideoJob): boolean {
    return job.status === 'queued' || job.status === 'running';
}

function thrown(error: unknown): MediaError {
    return {
        kind: 'other',
        code: 'unreachable',
        message: error instanceof Error ? error.message : 'the call failed',
        status: null,
    };
}

export function createMediaStore(deps: MediaStoreDeps): MediaStore {
    const { media, usage, account, connections, log } = deps;
    const now = deps.now ?? Date.now;
    const ttl = deps.ttlMs ?? MEDIA_CATALOG_TTL_MS;
    const retry = deps.retryMs ?? MEDIA_RETRY_MS;
    const pollMs = deps.pollMs ?? VIDEO_POLL_MS;
    const reconcileDelays = deps.reconcileDelaysMs ?? COST_RECONCILE_DELAYS_MS;

    const slots = new Map<Medium, Slot>(MEDIA_MEDIA.map((medium) => [medium, emptySlot()]));
    const slot = (medium: Medium): Slot => slots.get(medium) ?? emptySlot();
    const kept: MediaLast = { image: null, tts: null, stt: null };
    let jobs: VideoJob[] = [];
    let jobsLoaded = false;
    let jobsError: MediaError | null = null;
    let problem: MediaError | null = null;
    let touched = false;
    let watchers = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let polling = false;
    let disposed = false;
    const reconcileTimers = new Set<ReturnType<typeof setTimeout>>();
    const listeners = new Set<() => void>();

    function changed(): void {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                log.error('media listener failed', error);
            }
        }
    }

    /* -------------------------------------------------------------------------------------------- state */

    /** A call got through: the plugin is there and has a key. */
    function noteSuccess(): void {
        touched = true;
        problem = null;
    }

    /** A failed call may say something about the plugin or the key that the whole tab should know. */
    function noteFailure(error: MediaError): void {
        touched = true;
        if (isMediaPluginDown(error) || error.kind === 'no_key') problem = error;
    }

    function state(): MediaState {
        if (problem) {
            if (problem.kind === 'not_installed') {
                return connections.checked() && connections.pluginUp() ? 'plugin_outdated' : 'needs_plugin';
            }
            if (problem.kind === 'plugin_down' || problem.kind === 'forbidden') return 'plugin_down';
            if (problem.kind === 'no_key') return 'no_key';
        }
        return touched ? 'ready' : 'idle';
    }

    /* ----------------------------------------------------------------------------------------- catalogs */

    function viewOf(medium: Medium): MediaCatalogView {
        const s = slot(medium);
        return {
            medium,
            status: s.status,
            models: [...s.models],
            fetchedAt: s.fetchedAt,
            source: s.source,
            error: s.error,
        };
    }

    function ensure(medium: Medium, options?: { refresh?: boolean }): Promise<MediaResult<MediaModel[]>> {
        const s = slot(medium);
        const force = options?.refresh === true;
        if (s.inflight && !force) return s.inflight;
        if (!force) {
            if (s.status === 'ready' && s.loadedAt !== null && now() - s.loadedAt < ttl) {
                return Promise.resolve({ ok: true, data: [...s.models] });
            }
            if (s.status === 'failed' && s.error && s.failedAt !== null && now() - s.failedAt < retry) {
                return Promise.resolve({ ok: false, error: s.error });
            }
        }
        const mine = ++s.generation;
        s.status = 'loading';
        changed();
        const run: Promise<MediaResult<MediaModel[]>> = (async (): Promise<MediaResult<MediaModel[]>> => {
            let result: MediaResult<{ models: MediaModel[]; fetchedAt: number; source: 'live' | 'cache' | 'stale' }>;
            try {
                result = await media.catalog(medium, force ? { refresh: true } : undefined);
            } catch (error) {
                // The client never throws; a fake or a future change might.
                log.error(`media catalog ${medium} failed`, error);
                result = { ok: false, error: thrown(error) };
            }
            if (mine !== s.generation) {
                // A newer load owns the slot: hand out what it has (or its failure).
                return s.error && s.status === 'failed'
                    ? { ok: false, error: s.error }
                    : { ok: true, data: [...s.models] };
            }
            if (result.ok) {
                s.models = result.data.models;
                s.fetchedAt = result.data.fetchedAt;
                s.loadedAt = now();
                s.source = result.data.source;
                s.error = null;
                s.failedAt = null;
                s.status = 'ready';
                noteSuccess();
                return { ok: true, data: [...s.models] };
            }
            s.error = result.error;
            s.failedAt = now();
            s.status = 'failed';
            log.debug(`media catalog ${medium} failed: ${result.error.kind}`);
            noteFailure(result.error);
            return { ok: false, error: result.error };
        })().finally(() => {
            if (s.inflight === run) s.inflight = null;
            changed();
        });
        s.inflight = run;
        return run;
    }

    /* ------------------------------------------------------------------------------------------- calls */

    /** After a call: the plugin wrote a usage record (also for most failures), so the usage store reads again. */
    function afterCall(result: MediaResult<unknown>): void {
        if (result.ok) noteSuccess();
        else noteFailure(result.error);
        if (!result.ok && (isMediaPluginDown(result.error) || result.error.kind === 'no_key')) return;
        void usage.refresh();
    }

    function clearReconcile(): void {
        for (const timer of reconcileTimers) clearTimeout(timer);
        reconcileTimers.clear();
    }

    async function reconcileOnce(requestId: string): Promise<void> {
        const current = kept.image;
        if (disposed || !current || current.requestId !== requestId || current.cost.source === 'lookup') return;
        // No `since`: a corrected record keeps its original time.
        const result = await account.recent({ limit: 50 });
        if (!result.ok) return;
        const record = result.data.find((item) => item.requestId === requestId);
        if (!record || record.costSource !== 'lookup' || record.costUsd === null) return;
        const latest = kept.image;
        if (disposed || !latest || latest.requestId !== requestId) return;
        kept.image = { ...latest, cost: { ...latest.cost, usd: record.costUsd, source: 'lookup' } };
        usage.ingest([record]);
        changed();
    }

    function scheduleReconcile(requestId: string): void {
        clearReconcile();
        for (const delay of reconcileDelays) {
            const timer = setTimeout(() => {
                reconcileTimers.delete(timer);
                void reconcileOnce(requestId).catch((error: unknown) => log.debug('cost reconcile failed', error));
            }, delay);
            reconcileTimers.add(timer);
        }
    }

    async function generateImage(request: ImageRequest, options?: CallOptions): Promise<MediaResult<ImageResult>> {
        let result: MediaResult<ImageResult>;
        try {
            result = await media.image(request);
        } catch (error) {
            log.error('image call failed', error);
            result = { ok: false, error: thrown(error) };
        }
        if (result.ok && options?.remember !== false) {
            const data = result.data.model ? result.data : { ...result.data, model: request.model };
            kept.image = data;
            // The body's figure of an image is a list price; the billing lookup corrects it a little later.
            if (data.requestId && data.cost.source !== 'lookup') scheduleReconcile(data.requestId);
            else clearReconcile();
        }
        afterCall(result);
        changed();
        return result;
    }

    async function speak(request: TtsRequest, options?: CallOptions): Promise<MediaResult<TtsResult>> {
        let result: MediaResult<TtsResult>;
        try {
            result = await media.tts(request);
        } catch (error) {
            log.error('speech call failed', error);
            result = { ok: false, error: thrown(error) };
        }
        if (result.ok && options?.remember !== false) {
            kept.tts = result.data.model ? result.data : { ...result.data, model: request.model };
        }
        afterCall(result);
        changed();
        return result;
    }

    async function transcribe(request: SttRequest, options?: CallOptions): Promise<MediaResult<SttResult>> {
        let result: MediaResult<SttResult>;
        try {
            result = await media.stt(request);
        } catch (error) {
            log.error('transcription call failed', error);
            result = { ok: false, error: thrown(error) };
        }
        if (result.ok && options?.remember !== false) {
            kept.stt = result.data.model ? result.data : { ...result.data, model: request.model };
        }
        afterCall(result);
        changed();
        return result;
    }

    /* ---------------------------------------------------------------------------------------- video jobs */

    function upsertJob(job: VideoJob): void {
        const index = jobs.findIndex((item) => item.id === job.id);
        if (index >= 0) jobs = jobs.map((item, i) => (i === index ? job : item));
        else jobs = [job, ...jobs];
    }

    function reconcileTimer(): void {
        const needed = !disposed && watchers > 0 && jobs.some(isActiveJob);
        if (needed && pollTimer === null) {
            pollTimer = setInterval(() => void pollOnce(), pollMs);
        } else if (!needed && pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function pollOnce(): Promise<void> {
        if (polling || disposed) return;
        const active = jobs.filter(isActiveJob).slice(0, 8);
        if (active.length === 0) {
            reconcileTimer();
            return;
        }
        polling = true;
        try {
            const answers = await Promise.all(active.map(async (job) => ({ job, result: await safeStatus(job.id) })));
            let failure: MediaError | null = null;
            for (const { job, result } of answers) {
                if (result.ok) {
                    upsertJob(result.data);
                    noteSuccess();
                } else if (result.error.kind === 'not_found') {
                    // The plugin forgot the job (deleted in another tab): it is gone for us too.
                    jobs = jobs.filter((item) => item.id !== job.id);
                } else {
                    failure = result.error;
                    noteFailure(result.error);
                }
            }
            jobsError = failure;
            // A job that just finished was billed: the usage list should show it.
            if (answers.some(({ job, result }) => result.ok && isActiveJob(job) && !isActiveJob(result.data))) {
                void usage.refresh();
            }
        } finally {
            polling = false;
        }
        reconcileTimer();
        changed();
    }

    async function safeStatus(id: string): Promise<MediaResult<VideoJob>> {
        try {
            return await media.videoStatus(id);
        } catch (error) {
            log.error('video status failed', error);
            return { ok: false, error: thrown(error) };
        }
    }

    async function refreshVideos(): Promise<void> {
        let result: MediaResult<VideoJob[]>;
        try {
            result = await media.listVideo();
        } catch (error) {
            log.error('video list failed', error);
            result = { ok: false, error: thrown(error) };
        }
        if (result.ok) {
            jobs = result.data;
            jobsLoaded = true;
            jobsError = null;
            noteSuccess();
        } else {
            jobsError = result.error;
            noteFailure(result.error);
            log.debug(`video list failed: ${result.error.kind}`);
        }
        reconcileTimer();
        changed();
    }

    async function startVideo(request: VideoRequest): Promise<MediaResult<VideoJob>> {
        let result: MediaResult<VideoJob>;
        try {
            result = await media.startVideo(request);
        } catch (error) {
            log.error('video submit failed', error);
            result = { ok: false, error: thrown(error) };
        }
        if (result.ok) {
            upsertJob(result.data.model ? result.data : { ...result.data, model: request.model });
            jobsLoaded = true;
        }
        afterCall(result);
        reconcileTimer();
        changed();
        return result;
    }

    const store: MediaStore = {
        models: (medium) => [...slot(medium).models],

        model: (medium, id) => slot(medium).models.find((model) => model.id === id) ?? null,

        select: (medium, query) => selectModels(slot(medium).models, query),

        catalogView: viewOf,
        state,
        problem: () => (state() === 'ready' || state() === 'idle' ? null : problem),
        ensure,
        generateImage,
        speak,
        transcribe,
        startVideo,

        async videoStatus(id) {
            const result = await safeStatus(id);
            if (result.ok) {
                const before = jobs.find((job) => job.id === id);
                upsertJob(result.data);
                noteSuccess();
                if (before && isActiveJob(before) && !isActiveJob(result.data)) void usage.refresh();
            } else if (result.error.kind === 'not_found') {
                jobs = jobs.filter((job) => job.id !== id);
            } else noteFailure(result.error);
            reconcileTimer();
            changed();
            return result;
        },

        async deleteVideo(id) {
            let result: MediaResult<true>;
            try {
                result = await media.deleteVideo(id);
            } catch (error) {
                log.error('video delete failed', error);
                result = { ok: false, error: thrown(error) };
            }
            // A job that is already gone is the state the user wanted.
            if (result.ok || result.error.kind === 'not_found') {
                jobs = jobs.filter((job) => job.id !== id);
                if (result.ok) noteSuccess();
            } else noteFailure(result.error);
            reconcileTimer();
            changed();
            return result;
        },

        videos: () => ({ jobs: [...jobs], loaded: jobsLoaded, error: jobsError }),
        refreshVideos,

        watchVideos() {
            watchers++;
            if (watchers === 1) void refreshVideos();
            reconcileTimer();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                watchers--;
                reconcileTimer();
            };
        },

        last: () => ({ ...kept }),

        clearLast(medium) {
            kept[medium] = null;
            if (medium === 'image') clearReconcile();
            changed();
        },

        onChange(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },

        dispose() {
            disposed = true;
            if (pollTimer !== null) clearInterval(pollTimer);
            pollTimer = null;
            clearReconcile();
            listeners.clear();
            watchers = 0;
        },
    };
    return store;
}
