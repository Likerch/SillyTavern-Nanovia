// The media services of the plugin (stage 0.7, docs/ARCHITECTURE.md §9) in one bundle that app.ts builds and hands to the
// routes and the proxy through `deps.media`: the catalog of the four media, the video job store, the billing reconciler
// and the timing knobs (tests shrink them).
import type { ServerConfig } from './config';
import { createBillingReconciler, type BillingReconciler, type Timers } from './media-billing';
import { createMediaCatalog, type MediaCatalogService, type MediaCatalogTuning } from './media-catalog';
import { DEFAULT_MEDIA_TIMEOUTS, type MediaCallEnv, type MediaTimeouts } from './media-call';
import { createMediaJobStore, type MediaJobStore } from './media-jobs';
import type { FetchLike, Logger } from './types';
import type { UsageLog } from './usage-log';

/** The longest video file the plugin saves. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** One job is asked about at most this often, however many times the browser polls. */
export const POLL_INTERVAL_MS = 3_000;

/** The knobs `startNanovia` passes through (tests shrink them; production uses the defaults). */
export interface MediaTuning {
    /** `autoFetch` lets the catalog fetch the lists at start and when it finds one old; index.ts turns it on. */
    catalog?: MediaCatalogTuning;
    timeouts?: Partial<MediaTimeouts>;
    reconcileDelaysMs?: readonly number[];
    timers?: Timers;
    pollIntervalMs?: number;
    maxVideoBytes?: number;
    maxJobs?: number;
}

export interface MediaDeps {
    catalog: MediaCatalogService;
    jobs: MediaJobStore;
    reconciler: BillingReconciler;
    timeouts: MediaTimeouts;
    pollIntervalMs: number;
    maxVideoBytes: number;
    /** What a call to the media host needs (fetch, base, version). */
    env: MediaCallEnv;
    close(): void;
}

export interface MediaOptions {
    config: ServerConfig;
    dataRoot: () => string;
    fetch: FetchLike;
    version: string;
    now: () => number;
    log: Logger;
    usage: UsageLog;
    tuning?: MediaTuning;
}

export function createMediaDeps(options: MediaOptions): MediaDeps {
    const { config, fetch, version, now, log } = options;
    const tuning = options.tuning ?? {};
    const timeouts: MediaTimeouts = { ...DEFAULT_MEDIA_TIMEOUTS, ...tuning.timeouts };
    const env: MediaCallEnv = { fetch, mediaBase: config.mediaBase, version };
    const catalog = createMediaCatalog({
        ...tuning.catalog,
        mediaBase: config.mediaBase,
        dataRoot: options.dataRoot,
        fetch,
        version,
        now,
        log,
    });
    const reconciler = createBillingReconciler({
        env,
        usage: options.usage,
        log,
        now,
        timeoutMs: timeouts.lookupMs,
        ...(tuning.reconcileDelaysMs ? { delaysMs: tuning.reconcileDelaysMs } : {}),
        ...(tuning.timers ? { timers: tuning.timers } : {}),
    });
    return {
        catalog,
        jobs: createMediaJobStore({ log, ...(tuning.maxJobs !== undefined ? { maxJobs: tuning.maxJobs } : {}) }),
        reconciler,
        timeouts,
        pollIntervalMs: tuning.pollIntervalMs ?? POLL_INTERVAL_MS,
        maxVideoBytes: tuning.maxVideoBytes ?? MAX_VIDEO_BYTES,
        env,
        close() {
            catalog.close();
            reconciler.close();
        },
    };
}
