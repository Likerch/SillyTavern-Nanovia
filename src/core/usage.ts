// What the browser knows about spent money (stage 0.4). Two sources that never overlap:
//   - the plugin's usage log, read as summaries over `GET /spend` (every request that went through the proxy);
//   - the records the browser itself sees on the bus (`usage:record`: direct mode, where no plugin is in the way).
// A ring of the latest records feeds the "recent requests" list and `NANOVIA_API.usage.recent`; two running sums keep
// "today" right even after the ring has forgotten the early records. The plugin's part is loaded once at start, every
// 30 s while someone watches (the Account tab), and lazily (at most once a minute) when `today()` is read; it is never
// asked while the plugin is known to be down, and a failed call keeps the last good numbers and says they are stale.
// Real money (`costUsd`) and the pay-as-you-go equivalent are always kept apart; the equivalent never counts toward caps.
import { roundUsd, summarizeUsage } from '../domain/usage';
import type { PluginAccount, PluginError } from '../host';
import type { UsageRecord, UsageTotals } from '../shared/contracts';
import type { ConnectionUsage, DayUsage, ModelUsage, UsageSummary } from '../shared/contracts-account';
import type { ConnectionsService } from './connections';
import type { Bus, Logger, Unsubscribe } from './types';

export const USAGE_RING_SIZE = 300;
export const USAGE_POLL_MS = 30_000;
/** The plugin's part of "today" is read again by `today()` when it is older than this. */
export const USAGE_STALE_MS = 60_000;

export interface SpendResult {
    summary: UsageSummary;
    /** The plugin's log is part of the numbers. false: only what this browser has seen since the page was opened. */
    plugin: boolean;
    /** Why the plugin's part is missing; null when it is included. */
    error: PluginError | null;
}

export interface UsageState {
    /** The plugin's numbers for today are loaded. */
    pluginLoaded: boolean;
    /** When they were loaded (ms); null before the first answer. */
    fetchedAt: number | null;
    /** The last attempt failed; the numbers are from the last good answer (or only the browser's own). */
    stale: boolean;
    error: PluginError | null;
}

export interface UsageStore {
    /** Today's totals (since local midnight): the plugin's log plus what this browser saw. Synchronous. */
    today(): UsageTotals;
    /** The latest records, newest first. */
    recent(limit?: number): UsageRecord[];
    /** Called for every new record (a duplicate request id is not new). */
    onRecord(listener: (record: UsageRecord) => void): Unsubscribe;
    /** Called after the store's numbers changed: a record, an answer of the plugin, a failed call. */
    onChange(listener: () => void): Unsubscribe;
    state(): UsageState;
    /** Loads today's summary from the plugin. Never throws; does nothing while the plugin is known to be down. */
    refresh(): Promise<void>;
    /** The usage over `range` (`from <= at < to`), optionally for one connection; never throws. */
    summary(range: { from: number; to: number }, connectionId?: string | null): Promise<SpendResult>;
    /** Starts the 30 s polling (counted: several watchers share one timer) and returns the stop function. */
    watch(): Unsubscribe;
    /** Records the plugin reported itself. They are shown, and counted in "today" only while its summary is missing. */
    ingest(records: readonly UsageRecord[]): void;
    /** Stops the timer and drops the bus subscription. */
    dispose(): void;
}

export interface UsageStoreDeps {
    bus: Bus;
    account: Pick<PluginAccount, 'spend'> & Partial<Pick<PluginAccount, 'recent'>>;
    connections: Pick<ConnectionsService, 'pluginUp' | 'checked' | 'pluginError'>;
    log: Logger;
    now?: () => number;
    ringSize?: number;
    pollMs?: number;
    staleMs?: number;
    /** Local midnight of the day `at` falls in. */
    startOfDay?: (at: number) => number;
}

type Origin = 'browser' | 'plugin';

interface Entry {
    record: UsageRecord;
    origin: Origin;
}

interface DayBook {
    start: number;
    /** Records the browser saw: the plugin's log never has them. */
    browser: UsageTotals;
    /** Records the plugin reported through `ingest`: counted only while no summary of the plugin is loaded. */
    pluginRecords: UsageTotals;
}

export function emptyTotals(): UsageTotals {
    return { requests: 0, costUsd: 0, equivalentUsd: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
}

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
    return {
        requests: a.requests + b.requests,
        costUsd: roundUsd(a.costUsd + b.costUsd),
        equivalentUsd: roundUsd(a.equivalentUsd + b.equivalentUsd),
        promptTokens: a.promptTokens + b.promptTokens,
        completionTokens: a.completionTokens + b.completionTokens,
        cachedTokens: a.cachedTokens + b.cachedTokens,
    };
}

/** Local midnight of the day `at` falls in. */
export function localMidnight(at: number): number {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The UTC day name the plugin uses in `byDay` (`YYYY-MM-DD`). */
export function utcDay(at: number): string {
    return new Date(Number.isFinite(at) ? at : 0).toISOString().slice(0, 10);
}

function weight(a: UsageTotals, b: UsageTotals): number {
    return b.costUsd - a.costUsd || b.equivalentUsd - a.equivalentUsd || b.requests - a.requests;
}

function text(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function mergeRows<R extends UsageTotals>(a: readonly R[], b: readonly R[], keyOf: (row: R) => string): R[] {
    const merged = new Map<string, R>();
    for (const row of [...a, ...b]) {
        const key = keyOf(row);
        const existing = merged.get(key);
        merged.set(key, existing ? { ...existing, ...addTotals(existing, row) } : { ...row });
    }
    return [...merged.values()];
}

/** Two summaries of disjoint sets of records as one (the plugin's log and the browser's own records). */
export function mergeSummaries(a: UsageSummary, b: UsageSummary): UsageSummary {
    const byDay = mergeRows<DayUsage>(a.byDay, b.byDay, (row) => row.day).sort((x, y) => text(x.day, y.day));
    const byConnection = mergeRows<ConnectionUsage>(
        a.byConnection,
        b.byConnection,
        (row) => row.connectionId ?? '',
    ).sort((x, y) => weight(x, y) || text(x.connectionId ?? '', y.connectionId ?? ''));
    const byModel = mergeRows<ModelUsage>(a.byModel, b.byModel, (row) => row.model).sort(
        (x, y) => weight(x, y) || text(x.model, y.model),
    );
    return {
        from: Math.min(a.from, b.from),
        to: Math.max(a.to, b.to),
        total: addTotals(a.total, b.total),
        byDay,
        byConnection,
        byModel,
    };
}

function recordTotals(record: UsageRecord): UsageTotals {
    return summarizeUsage([record], { from: -Infinity, to: Infinity }, () => '').total;
}

function looksLikeRecord(value: unknown): value is UsageRecord {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record['at'] === 'number' && Number.isFinite(record['at']) && typeof record['model'] === 'string';
}

export function createUsageStore(deps: UsageStoreDeps): UsageStore {
    const { bus, account, connections, log } = deps;
    const now = deps.now ?? Date.now;
    const ringSize = deps.ringSize ?? USAGE_RING_SIZE;
    const pollMs = deps.pollMs ?? USAGE_POLL_MS;
    const staleMs = deps.staleMs ?? USAGE_STALE_MS;
    const startOfDay = deps.startOfDay ?? localMidnight;

    /** Oldest first (by `at`); recent() reads it from the end. */
    const ring: Entry[] = [];
    const ids = new Set<string>();
    const recordListeners = new Set<(record: UsageRecord) => void>();
    const changeListeners = new Set<() => void>();

    let book: DayBook = freshBook(startOfDay(now()));
    let pluginToday: { start: number; total: UsageTotals } | null = null;
    let fetchedAt: number | null = null;
    let stale = false;
    let error: PluginError | null = null;
    let attemptedAt: number | null = null;
    /** `at` of the newest plugin record taken into the recent list; the next ask is for what is newer. */
    let recentSince: number | null = null;
    let inflight: Promise<void> | null = null;
    let watchers = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    function freshBook(start: number): DayBook {
        return { start, browser: emptyTotals(), pluginRecords: emptyTotals() };
    }

    function today0(): number {
        const midnight = startOfDay(now());
        if (book.start !== midnight) book = freshBook(midnight);
        return midnight;
    }

    function pluginKnownDown(): boolean {
        return connections.checked() && !connections.pluginUp();
    }

    function downError(): PluginError {
        return (
            connections.pluginError() ?? { code: 'unreachable', message: 'the plugin is not answering', status: null }
        );
    }

    function changed(): void {
        for (const listener of [...changeListeners]) {
            try {
                listener();
            } catch (err) {
                log.error('usage listener failed', err);
            }
        }
    }

    function accept(record: UsageRecord, origin: Origin): boolean {
        if (!looksLikeRecord(record)) return false;
        if (record.requestId !== null && record.requestId !== undefined && ids.has(record.requestId)) return false;
        // Sorted insert: a record normally lands at the end; one reported later by the plugin may be older.
        let index = ring.length;
        while (index > 0 && (ring[index - 1] as Entry).record.at > record.at) index--;
        ring.splice(index, 0, { record, origin });
        if (record.requestId) ids.add(record.requestId);
        while (ring.length > ringSize) {
            const gone = ring.shift();
            if (gone?.record.requestId) ids.delete(gone.record.requestId);
        }
        const midnight = today0();
        if (startOfDay(record.at) === midnight) {
            const key = origin === 'browser' ? 'browser' : 'pluginRecords';
            book[key] = addTotals(book[key], recordTotals(record));
        }
        return true;
    }

    function announce(record: UsageRecord): void {
        for (const listener of [...recordListeners]) {
            try {
                listener(record);
            } catch (err) {
                log.error('usage record listener failed', err);
            }
        }
    }

    const offBus = bus.on('usage:record', (event) => {
        // The bus carries what the browser saw: the plugin never emits on it.
        if (accept(event.record, 'browser')) {
            announce(event.record);
            changed();
        }
    });

    /* ------------------------------------------------------------------------------------------- the plugin */

    async function doRefresh(): Promise<void> {
        attemptedAt = now();
        if (pluginKnownDown()) {
            error = downError();
            stale = pluginToday !== null;
            changed();
            return;
        }
        const start = startOfDay(attemptedAt);
        const result = await account.spend({ from: start, to: attemptedAt + 1 });
        if (result.ok) {
            pluginToday = { start, total: result.data.total };
            fetchedAt = now();
            stale = false;
            error = null;
            await loadRecent();
        } else {
            error = result.error;
            stale = true;
            log.debug(`usage refresh failed: ${result.error.code}`);
        }
        changed();
    }

    /** The plugin's latest individual requests, for the recent list; only those newer than the last one taken. */
    async function loadRecent(): Promise<void> {
        if (!account.recent) return;
        const result = await account.recent({ limit: 50, since: recentSince });
        if (!result.ok) {
            log.debug(`recent usage not loaded: ${result.error.code}`);
            return;
        }
        // Newest first from the plugin; the store sorts by time itself.
        const fresh = result.data.filter((record) => record.at > (recentSince ?? -1));
        if (fresh.length === 0) return;
        recentSince = Math.max(recentSince ?? 0, ...fresh.map((record) => record.at));
        store.ingest(fresh);
    }

    function refresh(): Promise<void> {
        if (inflight) return inflight;
        inflight = doRefresh()
            .catch((err: unknown) => {
                log.error('usage refresh failed', err);
            })
            .finally(() => {
                inflight = null;
            });
        return inflight;
    }

    /** Stale-while-revalidate for `today()`: at most one call a minute, none while polling or while the plugin is down. */
    function revalidate(): void {
        if (inflight || timer !== null || pluginKnownDown()) return;
        if (attemptedAt !== null && now() - attemptedAt < staleMs) return;
        void refresh();
    }

    function localSummary(range: { from: number; to: number }, connectionId: string | null, withPlugin: boolean) {
        const records = ring.filter((entry) => withPlugin || entry.origin === 'browser').map((entry) => entry.record);
        return summarizeUsage(records, range, utcDay, connectionId === null ? {} : { connectionId });
    }

    /* -------------------------------------------------------------------------------------------------- API */

    const store: UsageStore = {
        today() {
            const midnight = today0();
            revalidate();
            const loaded = pluginToday !== null && pluginToday.start === midnight;
            const plugin = loaded ? (pluginToday as { total: UsageTotals }).total : book.pluginRecords;
            return addTotals(plugin, book.browser);
        },

        recent(limit = 50) {
            const n = Math.max(0, Math.min(Math.floor(limit), ring.length));
            const out: UsageRecord[] = [];
            for (let i = ring.length - 1; i >= 0 && out.length < n; i--) out.push({ ...(ring[i] as Entry).record });
            return out;
        },

        onRecord(listener) {
            recordListeners.add(listener);
            return () => void recordListeners.delete(listener);
        },

        onChange(listener) {
            changeListeners.add(listener);
            return () => void changeListeners.delete(listener);
        },

        state() {
            const midnight = today0();
            return {
                pluginLoaded: pluginToday !== null && pluginToday.start === midnight,
                fetchedAt,
                stale,
                error,
            };
        },

        refresh,

        async summary(range, connectionId = null) {
            if (pluginKnownDown()) {
                return { summary: localSummary(range, connectionId, true), plugin: false, error: downError() };
            }
            try {
                const result = await account.spend(range, connectionId);
                if (result.ok) {
                    return {
                        summary: mergeSummaries(result.data, localSummary(range, connectionId, false)),
                        plugin: true,
                        error: null,
                    };
                }
                return { summary: localSummary(range, connectionId, true), plugin: false, error: result.error };
            } catch (err) {
                log.error('usage summary failed', err);
                return {
                    summary: localSummary(range, connectionId, true),
                    plugin: false,
                    error: { code: 'unreachable', message: 'the summary could not be read', status: null },
                };
            }
        },

        watch() {
            watchers++;
            if (watchers === 1) {
                void refresh();
                timer = setInterval(() => {
                    if (!pluginKnownDown()) void refresh();
                }, pollMs);
            }
            let released = false;
            return () => {
                if (released) return;
                released = true;
                watchers--;
                if (watchers === 0 && timer !== null) {
                    clearInterval(timer);
                    timer = null;
                }
            };
        },

        ingest(records) {
            let added = false;
            for (const record of records) {
                if (accept(record, 'plugin')) {
                    announce(record);
                    added = true;
                }
            }
            if (added) changed();
        },

        dispose() {
            offBus();
            if (timer !== null) clearInterval(timer);
            timer = null;
            watchers = 0;
            recordListeners.clear();
            changeListeners.clear();
        },
    };
    return store;
}
