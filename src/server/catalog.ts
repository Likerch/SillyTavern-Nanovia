// The catalog service (stage 3, docs/ARCHITECTURE.md §3): NanoGPT's public model list and per-model host lists, fetched
// without any key, normalised by domain/catalog.ts and kept in memory.
//
//   GET <siteBase>/api/v1/models?detailed=true          the whole catalog (~700 KB), TTL 10 min, persisted
//   GET <siteBase>/api/models/<encoded id>/providers    the hosts of one model, TTL 5 min, LRU of 200 in memory
//
// The catalog is written to `<data root>/_nanovia/catalog.json` ({ version, fetchedAt, models }) after every successful
// fetch and read back at start, so the proxy knows the models before the first fetch completes and after a restart while
// NanoGPT is down. Two kinds of callers:
//   - requests (the /catalog routes) may wait for a fetch: `catalog()` and `providers()` return fresh data when they can,
//     the stored copy when the fetch fails, and nothing only when there is neither;
//   - the proxy must never wait: `lookupModel()` and `providerSelection()` are synchronous and read memory only. With
//     `autoFetch` on, a missing or old entry starts a background fetch (single-flight, at most one try per minute while
//     NanoGPT keeps failing); with it off (tests) nothing is ever fetched unless a route asks.
// Fetch errors are logged as a short code (never a body, never a key: these endpoints take none) and never thrown.
import fs from 'node:fs';
import path from 'node:path';
import type { CatalogModel, ModelProviders } from '../shared/contracts';
import type { CatalogResponse, ModelProvidersResponse } from '../shared/contracts-catalog';
import { normalizeCatalog, normalizeModelProviders } from '../domain/catalog';
import { GLOBAL_DIR_NAME, writeFileAtomic } from './store';
import { errorCode } from './upstream';
import type { FetchLike, Logger } from './types';

export const CATALOG_FILE = 'catalog.json';
export const CATALOG_FILE_VERSION = 1;
/** The catalog is fresh for this long after a fetch. */
export const CATALOG_TTL_MS = 10 * 60_000;
/** A host list is fresh for this long after a fetch. */
export const PROVIDERS_TTL_MS = 5 * 60_000;
export const FETCH_TIMEOUT_MS = 15_000;
/** Host lists kept in memory (least recently used go first). */
export const PROVIDERS_CAPACITY = 200;
/** After a failed fetch no background fetch and no route that already has a copy to serve tries again for this long. */
export const FAILURE_BACKOFF_MS = 60_000;

/** The knobs the app passes through (tests shrink them). */
export interface CatalogTuning {
    /** Fetch on our own: at start, and when `lookupModel`/`providerSelection` find the data missing or old. */
    autoFetch?: boolean;
    ttlMs?: number;
    providersTtlMs?: number;
    timeoutMs?: number;
    providersCapacity?: number;
    failureBackoffMs?: number;
}

export interface CatalogOptions extends CatalogTuning {
    /** NanoGPT site without a trailing slash (`ServerConfig.siteBase`). */
    siteBase: string;
    /** The ST data root: the cache file lives under `<root>/_nanovia`. */
    dataRoot: () => string;
    fetch: FetchLike;
    version: string;
    now: () => number;
    log: Logger;
}

export type ProvidersFailure = 'not_found' | 'unavailable';

export type ProvidersResult = { ok: true; value: ModelProvidersResponse } | { ok: false; reason: ProvidersFailure };

export interface CatalogService {
    /** Reads the cache file; with `autoFetch`, starts the first fetch when there is no fresh copy. Never throws. */
    start(): void;
    /**
     * The catalog for a request. A fresh copy answers as `cache`; otherwise a fetch is awaited (an already running one is
     * joined) and answers as `live`; when it fails the old copy answers as `stale`. A copy is also served as `stale` at
     * once while a fetch is running (start-up) or just failed. Null = no copy at all and NanoGPT cannot be reached.
     */
    catalog(options?: { refresh?: boolean }): Promise<CatalogResponse | null>;
    /** Synchronous, from memory: the exact id, else the id with trailing `:suffix` parts removed one by one. */
    lookupModel(modelId: string): CatalogModel | null;
    /** The host list of a model (the id may carry suffixes: it is resolved through the catalog when that is loaded). */
    providers(modelId: string, options?: { refresh?: boolean }): Promise<ProvidersResult>;
    /** Synchronous, from the host-list cache only (an old entry still answers). null = unknown. */
    providerSelection(modelId: string): boolean | null;
    /** Resolves when no fetch is running (tests, graceful shutdown). */
    settled(): Promise<void>;
    /** Aborts running fetches and stops new ones. */
    close(): void;
}

interface Snapshot {
    models: CatalogModel[];
    fetchedAt: number;
    byId: Map<string, CatalogModel>;
}

interface ProvidersEntry {
    value: ModelProviders | null;
    fetchedAt: number;
    /** When the last fetch of this entry failed (cleared by a success). */
    failedAt: number | null;
    failure: ProvidersFailure | null;
}

/** A fetch that did not give usable data; `reason` is a short code for the log. */
class FetchFailure extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'FetchFailure';
    }
}

export function createCatalogService(options: CatalogOptions): CatalogService {
    const { fetch, log, now } = options;
    const siteBase = options.siteBase.replace(/\/+$/, '');
    const autoFetch = options.autoFetch ?? false;
    const ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
    const providersTtlMs = options.providersTtlMs ?? PROVIDERS_TTL_MS;
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    const capacity = Math.max(1, options.providersCapacity ?? PROVIDERS_CAPACITY);
    const backoffMs = options.failureBackoffMs ?? FAILURE_BACKOFF_MS;

    let snapshot: Snapshot | null = null;
    let inflight: Promise<boolean> | null = null;
    let failedAt: number | null = null;
    let closed = false;
    /** The first successful fetch of this run has been logged. */
    let announced = false;
    const providerEntries = new Map<string, ProvidersEntry>();
    const providerFlights = new Map<string, Promise<boolean>>();
    const controllers = new Set<AbortController>();

    /* -------------------------------------------------------------------------------------------- transport */

    /** One public GET. 2xx bodies are parsed as JSON; any other status comes back with `json: null`. */
    async function getJson(url: string): Promise<{ status: number; json: unknown }> {
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
            const body = response.status >= 200 && response.status < 300 ? await response.text() : '';
            return { status: response.status, body };
        })();
        work.catch(() => {}); // a failure that arrives after the timeout was already reported
        try {
            const { status, body } = await Promise.race([work, timeout]);
            if (status < 200 || status >= 300) return { status, json: null };
            try {
                return { status, json: JSON.parse(body) as unknown };
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

    /* -------------------------------------------------------------------------------------------- the catalog */

    function makeSnapshot(models: CatalogModel[], fetchedAt: number): Snapshot {
        return { models, fetchedAt, byId: new Map(models.map((m) => [m.id, m])) };
    }

    function cacheFile(): string {
        return path.join(options.dataRoot(), GLOBAL_DIR_NAME, CATALOG_FILE);
    }

    function persist(value: Snapshot): void {
        try {
            const file = cacheFile();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            writeFileAtomic(
                file,
                JSON.stringify({ version: CATALOG_FILE_VERSION, fetchedAt: value.fetchedAt, models: value.models }),
            );
        } catch (error) {
            log.warn(`catalog cache could not be written (${errorCode(error) ?? 'io error'})`);
        }
    }

    function loadCacheFile(): Snapshot | null {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') log.warn('catalog cache is unreadable and is ignored');
            return null;
        }
        if (!isRecord(raw) || raw['version'] !== CATALOG_FILE_VERSION || !Array.isArray(raw['models'])) return null;
        const at = raw['fetchedAt'];
        if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
        const seen = new Set<string>();
        const models: CatalogModel[] = [];
        for (const item of raw['models'] as unknown[]) {
            if (!isStoredModel(item) || seen.has(item.id)) continue;
            seen.add(item.id);
            models.push(item);
        }
        // A clock that went backwards must not make an old copy look newer than now.
        return models.length > 0 ? makeSnapshot(models, Math.min(at, now())) : null;
    }

    async function fetchCatalog(): Promise<boolean> {
        try {
            const { status, json } = await getJson(`${siteBase}/api/v1/models?detailed=true`);
            if (status < 200 || status >= 300) throw new FetchFailure(`http ${status}`);
            const models = normalizeCatalog(json);
            // An empty answer is junk: it must not replace a good copy.
            if (models.length === 0) throw new FetchFailure('no models in the answer');
            const next = makeSnapshot(models, now());
            if (closed) return false;
            const quiet = announced && failedAt === null;
            snapshot = next;
            failedAt = null;
            announced = true;
            persist(next);
            if (!quiet) log.info(`catalog loaded: ${models.length} models`);
            return true;
        } catch (error) {
            if (closed) return false;
            const reason = error instanceof FetchFailure ? error.reason : (errorCode(error) ?? 'error');
            if (failedAt === null)
                log.warn(`catalog fetch failed (${reason})${snapshot ? '; the stored copy is used' : ''}`);
            failedAt = now();
            return false;
        }
    }

    /** Single-flight: every caller during a fetch gets the same promise. Resolves true when new data arrived; never rejects. */
    function refresh(): Promise<boolean> {
        if (inflight) return inflight;
        const running: Promise<boolean> = fetchCatalog().finally(() => {
            if (inflight === running) inflight = null;
        });
        inflight = running;
        return running;
    }

    const isExpired = (value: Snapshot): boolean => now() - value.fetchedAt >= ttlMs;
    const backingOff = (at: number | null): boolean => at !== null && now() - at < backoffMs;

    /** A fetch nobody waits for; honours `autoFetch`, a running fetch and the failure backoff. */
    function kickCatalog(): void {
        if (!autoFetch || closed || inflight || backingOff(failedAt)) return;
        void refresh();
    }

    function start(): void {
        if (closed) return;
        snapshot ??= loadCacheFile();
        if (!snapshot || isExpired(snapshot)) kickCatalog();
    }

    function respond(value: Snapshot, source: CatalogResponse['source']): CatalogResponse {
        return { models: value.models, fetchedAt: value.fetchedAt, source };
    }

    async function catalog(opts: { refresh?: boolean } = {}): Promise<CatalogResponse | null> {
        const held = snapshot;
        if (held && !opts.refresh) {
            if (!isExpired(held)) return respond(held, 'cache');
            // Old copy, but a fetch is already running (start-up) or NanoGPT just failed: do not make the caller wait.
            if (inflight || backingOff(failedAt)) return respond(held, 'stale');
        }
        const fetched = await refresh();
        const current = snapshot;
        if (!current) return null;
        return respond(current, fetched ? 'live' : 'stale');
    }

    /** The exact id, else the id with trailing `:suffix` parts peeled off (`:online`, `:memory-7`, `:thinking:max`). */
    function lookupModel(modelId: string): CatalogModel | null {
        const held = snapshot;
        if (!held) {
            kickCatalog();
            return null;
        }
        if (isExpired(held)) kickCatalog();
        let id = typeof modelId === 'string' ? modelId.trim() : '';
        for (;;) {
            const model = held.byId.get(id);
            if (model) return model;
            const cut = id.lastIndexOf(':');
            if (cut <= 0) return null;
            id = id.slice(0, cut);
        }
    }

    /* -------------------------------------------------------------------------------------------- host lists */

    /** The key of a model's host list: its catalog id when the catalog knows the model, else the id as given. */
    function providersKey(modelId: string): string {
        return lookupModel(modelId)?.id ?? (typeof modelId === 'string' ? modelId.trim() : '');
    }

    /** Reads an entry and marks it as recently used. */
    function touch(key: string): ProvidersEntry | undefined {
        const entry = providerEntries.get(key);
        if (entry) {
            providerEntries.delete(key);
            providerEntries.set(key, entry);
        }
        return entry;
    }

    function putEntry(key: string, entry: ProvidersEntry): void {
        providerEntries.delete(key);
        providerEntries.set(key, entry);
        while (providerEntries.size > capacity) {
            const oldest = providerEntries.keys().next();
            if (oldest.done) break;
            providerEntries.delete(oldest.value);
        }
    }

    function noteProvidersFailure(key: string, failure: ProvidersFailure): void {
        const previous = providerEntries.get(key);
        putEntry(key, {
            value: previous?.value ?? null,
            fetchedAt: previous?.fetchedAt ?? 0,
            failedAt: now(),
            failure,
        });
    }

    async function fetchProviders(key: string): Promise<boolean> {
        try {
            const { status, json } = await getJson(`${siteBase}/api/models/${encodeURIComponent(key)}/providers`);
            if (status === 404) {
                noteProvidersFailure(key, 'not_found');
                return false;
            }
            if (status < 200 || status >= 300) throw new FetchFailure(`http ${status}`);
            const value = normalizeModelProviders(key, json);
            if (!value) throw new FetchFailure('unrecognised answer');
            if (closed) return false;
            putEntry(key, { value, fetchedAt: now(), failedAt: null, failure: null });
            return true;
        } catch (error) {
            if (closed) return false;
            const reason = error instanceof FetchFailure ? error.reason : (errorCode(error) ?? 'error');
            if (!providerEntries.get(key)?.failedAt) log.warn(`providers fetch failed (${reason})`);
            noteProvidersFailure(key, 'unavailable');
            return false;
        }
    }

    function refreshProviders(key: string): Promise<boolean> {
        const running = providerFlights.get(key);
        if (running) return running;
        const flight: Promise<boolean> = fetchProviders(key).finally(() => {
            if (providerFlights.get(key) === flight) providerFlights.delete(key);
        });
        providerFlights.set(key, flight);
        return flight;
    }

    function kickProviders(key: string, entry: ProvidersEntry | undefined): void {
        if (!autoFetch || closed || !key || providerFlights.has(key) || backingOff(entry?.failedAt ?? null)) return;
        void refreshProviders(key);
    }

    function answer(value: ModelProviders, fetchedAt: number): ProvidersResult {
        return { ok: true, value: { ...value, fetchedAt } };
    }

    async function providers(modelId: string, opts: { refresh?: boolean } = {}): Promise<ProvidersResult> {
        const key = providersKey(modelId);
        if (!key) return { ok: false, reason: 'not_found' };
        const held = touch(key);
        if (held?.value && !opts.refresh && now() - held.fetchedAt < providersTtlMs) {
            return answer(held.value, held.fetchedAt);
        }
        await refreshProviders(key);
        const current = touch(key);
        if (current?.value) return answer(current.value, current.fetchedAt);
        return { ok: false, reason: current?.failure ?? 'unavailable' };
    }

    function providerSelection(modelId: string): boolean | null {
        const key = providersKey(modelId);
        if (!key) return null;
        const entry = touch(key);
        if (entry?.value) {
            if (now() - entry.fetchedAt >= providersTtlMs) kickProviders(key, entry);
            return entry.value.supportsProviderSelection;
        }
        kickProviders(key, entry);
        return null;
    }

    /* -------------------------------------------------------------------------------------------- lifecycle */

    async function settled(): Promise<void> {
        while (inflight || providerFlights.size > 0) {
            await Promise.all([inflight, ...providerFlights.values()]);
        }
    }

    function close(): void {
        closed = true;
        for (const controller of controllers) controller.abort();
        controllers.clear();
    }

    return { start, catalog, lookupModel, providers, providerSelection, settled, close };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields the rest of the plugin reads from a stored model; the file is ours but may be edited or truncated. */
function isStoredModel(value: unknown): value is CatalogModel {
    if (!isRecord(value)) return false;
    return (
        typeof value['id'] === 'string' &&
        value['id'] !== '' &&
        typeof value['name'] === 'string' &&
        isRecord(value['capabilities']) &&
        isRecord(value['pricing']) &&
        typeof value['pricing']['prompt'] === 'number' &&
        typeof value['pricing']['completion'] === 'number' &&
        isRecord(value['subscription']) &&
        Array.isArray(value['providerIds']) &&
        Array.isArray(value['reasoningEfforts'])
    );
}
