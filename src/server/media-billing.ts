// Reconciling the cost of media calls (stage 0.7). The `cost` in an image answer is the LIST price and can understate what
// NanoGPT charged (live: 0.0017 in the body, 0.00255 billed). The authoritative figure is the per-request billing lookup,
// `GET <mediaBase>/api/v1/usage/requests/{requestId}` (same key, 24 h window, about 15 s after the call for media ids).
//
// After an image call the plugin schedules a lookup: the first try after ~15 s, then a few retries with growing pauses
// while NanoGPT answers 404 ("not ready yet", which never means zero) or trouble. A figure is written as an `adjust` line
// next to the usage record (usage-log.ts), so GET /spend and GET /usage/recent already see it. Best effort by design: the
// schedule lives in memory and is gone with the process, and a call nobody could reconcile keeps the body's figure.
//
// The key of the call stays in memory (as the opaque SecretValue) until the lookup is done or given up; it is never
// written anywhere. Timers are injectable so tests drive the clock by hand.
import { parseBillingLookup } from '../domain/media-wire';
import { callMedia, MediaCallError, type MediaCallEnv } from './media-call';
import type { SecretValue } from './secret-value';
import type { UsageLog } from './usage-log';
import type { Logger } from './types';

/** First try, then the pauses between the retries (ms). Five tries in all, about eight minutes. */
export const DEFAULT_RECONCILE_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];

/** A clock the tests can hold in their hand. */
export interface Timers {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}

export const realTimers: Timers = {
    set(callback, ms) {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        return handle;
    },
    clear(handle) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

export interface ReconcileJob {
    userRoot: string;
    key: SecretValue;
    /** The id the lookup is made with (the image answer's `X-Request-ID`). */
    requestId: string;
    /** `at` of the usage record: it names the day file the adjustment goes into. */
    recordAt: number;
}

export interface BillingReconciler {
    /** Looks the charge up later and corrects the usage record; returns at once. */
    schedule(job: ReconcileJob): void;
    /** Lookups still scheduled or running. */
    pending(): number;
    /** Resolves when no lookup is running right now (scheduled ones may still wait for their timer). */
    idle(): Promise<void>;
    /** Cancels every scheduled lookup (shutdown). */
    close(): void;
}

export interface ReconcilerOptions {
    env: MediaCallEnv;
    usage: UsageLog;
    log: Logger;
    now: () => number;
    delaysMs?: readonly number[];
    timers?: Timers;
    timeoutMs: number;
}

interface Entry {
    job: ReconcileJob;
    /** Index of the next delay; the try being made now used `attempt - 1`. */
    attempt: number;
    handle: unknown;
}

type Outcome = 'done' | 'retry' | 'give-up';

export function createBillingReconciler(options: ReconcilerOptions): BillingReconciler {
    const { env, usage, log, now } = options;
    const delays = options.delaysMs && options.delaysMs.length > 0 ? options.delaysMs : DEFAULT_RECONCILE_DELAYS_MS;
    const timers = options.timers ?? realTimers;
    const entries = new Set<Entry>();
    const running = new Set<Promise<void>>();
    let closed = false;

    /** One lookup: what to do next. Never throws. */
    async function lookup(job: ReconcileJob): Promise<Outcome> {
        let answer;
        try {
            answer = await callMedia(
                env,
                job.key,
                {
                    method: 'GET',
                    path: `/api/v1/usage/requests/${encodeURIComponent(job.requestId)}`,
                    timeoutMs: options.timeoutMs,
                },
                1024 * 1024,
            );
        } catch (error) {
            // NanoGPT unreachable or slow: worth another try.
            return error instanceof MediaCallError ? 'retry' : 'give-up';
        }
        if (answer.status >= 200 && answer.status < 300) {
            let json: unknown;
            try {
                json = JSON.parse(job.key.redact(answer.body.toString('utf8')));
            } catch {
                return 'retry';
            }
            const { usd } = parseBillingLookup(json);
            if (usd === null) return 'give-up'; // another currency, or no figure: nothing to correct with
            await usage.adjust(job.userRoot, job.recordAt, {
                adjust: true,
                requestId: job.requestId,
                costUsd: usd,
                costSource: 'lookup',
                at: now(),
            });
            return 'done';
        }
        // 404: not ready yet (it never means zero). 408/425/429/5xx: try again. 401/403/409 and the rest: it will not change.
        if (
            answer.status === 404 ||
            answer.status === 408 ||
            answer.status === 425 ||
            answer.status === 429 ||
            answer.status >= 500
        ) {
            return 'retry';
        }
        return 'give-up';
    }

    function arm(entry: Entry): void {
        const delay = delays[Math.min(entry.attempt, delays.length - 1)] ?? 15_000;
        entry.handle = timers.set(() => {
            const work = attempt(entry).finally(() => running.delete(work));
            running.add(work);
        }, delay);
    }

    async function attempt(entry: Entry): Promise<void> {
        entry.handle = null;
        if (closed) {
            entries.delete(entry);
            return;
        }
        entry.attempt += 1;
        let outcome: Outcome;
        try {
            outcome = await lookup(entry.job);
        } catch {
            outcome = 'give-up'; // the usage log failed: bookkeeping never throws further
        }
        if (outcome === 'retry' && entry.attempt < delays.length && !closed) {
            arm(entry);
            return;
        }
        entries.delete(entry);
        if (outcome !== 'done')
            log.info('the billing lookup of a media call gave no figure; the response figure stays');
    }

    return {
        schedule(job) {
            if (closed) return;
            const entry: Entry = { job, attempt: 0, handle: null };
            entries.add(entry);
            arm(entry);
        },
        pending: () => entries.size,
        async idle() {
            while (running.size > 0) await Promise.all([...running]);
        },
        close() {
            closed = true;
            for (const entry of entries) if (entry.handle !== null) timers.clear(entry.handle);
            entries.clear();
        },
    };
}
