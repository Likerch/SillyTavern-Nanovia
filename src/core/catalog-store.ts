// The real CatalogStore (stage 0.3): NanoGPT's model catalog and host lists as the browser knows them.
//
// Sources, in this order:
//   1. the plugin (`GET /catalog`, `GET /catalog/providers?id=…`) when `plugin.available()` says it answers: it keeps the
//      one shared copy and a copy on disk, so the browser does not fetch 700 KB itself;
//   2. otherwise (plugin down, or it could not deliver) NanoGPT directly: `host/catalog-source.ts`.
// The snapshot is also kept in IndexedDB (`host/catalog-storage.ts`) so the next page load has models at once. Freshness
// windows: the snapshot 10 minutes, a host list 5 minutes (200 lists, least recently used go first).
//
// Rules: every fetch is single-flight (callers during a fetch share it); `refresh` and `ensureProviders` never throw;
// when a fetch fails the old data stays and is reported as `stale` with the error code; `model(id)` falls back from
// `:thinking`/`:online`/`:memory-7` style suffixes to the base id exactly like the server's `lookupModel`; hints are
// computed here from the pure domain (they need only the model and the cached host list).
import { routingHints } from '../domain/catalog-hints';
import { createDirectCatalogSource } from '../host/catalog-source';
import type { DirectCatalogSource } from '../host/catalog-source';
import { CATALOG_STORAGE_VERSION, createCatalogStorage } from '../host/catalog-storage';
import type { CatalogStorage } from '../host/catalog-storage';
import { createPluginCatalogClient, readCatalogModels } from '../host/plugin-catalog';
import type { PluginCatalogClient } from '../host/plugin-catalog';
import type { PluginClient } from '../host/plugin-client';
import type { CatalogModel, ModelProviders } from '../shared/contracts';
import type { ModelProvidersResponse } from '../shared/contracts-catalog';
import type { CatalogStatus, CatalogStore } from './catalog';
import type { Bus, Logger, Unsubscribe } from './types';

/** The snapshot is fresh for this long after its fetch. */
export const CATALOG_FRESH_MS = 10 * 60_000;
/** A host list is fresh for this long after its fetch. */
export const PROVIDERS_FRESH_MS = 5 * 60_000;
/** Host lists kept in memory. */
export const PROVIDERS_CAPACITY = 200;
/** After a failed fetch a refresh that is not forced (and a host list that is gone) waits this long before trying again. */
export const FAILURE_BACKOFF_MS = 30_000;

export interface CatalogStoreDeps {
    /** Only `available()` is used: does the plugin answer? */
    plugin: Pick<PluginClient, 'available'>;
    pluginCatalog: PluginCatalogClient;
    direct: DirectCatalogSource;
    storage: CatalogStorage;
    bus: Bus;
    log: Logger;
    now?: () => number;
    freshMs?: number;
    providersFreshMs?: number;
    providersCapacity?: number;
    failureBackoffMs?: number;
}

interface Snapshot {
    models: CatalogModel[];
    byId: Map<string, CatalogModel>;
    fetchedAt: number;
}

interface ProvidersEntry {
    /** null: the model's host list is not available (a negative entry that stops us asking again at once). */
    value: ModelProvidersResponse | null;
    fetchedAt: number;
    failedAt: number | null;
}

type Via = NonNullable<CatalogStatus['via']>;

export function createCatalogStore(deps: CatalogStoreDeps): CatalogStore {
    const { plugin, pluginCatalog, direct, storage, bus, log } = deps;
    const now = deps.now ?? Date.now;
    const freshMs = deps.freshMs ?? CATALOG_FRESH_MS;
    const providersFreshMs = deps.providersFreshMs ?? PROVIDERS_FRESH_MS;
    const capacity = Math.max(1, deps.providersCapacity ?? PROVIDERS_CAPACITY);
    const backoffMs = deps.failureBackoffMs ?? FAILURE_BACKOFF_MS;

    let snapshot: Snapshot | null = null;
    let source: CatalogStatus['source'] = null;
    let via: Via | null = null;
    let error: string | null = null;
    let failedAt: number | null = null;
    let triedStorage = false;
    let inflight: Promise<void> | null = null;
    let inflightForced = false;
    const entries = new Map<string, ProvidersEntry>();
    const flights = new Map<string, Promise<ModelProvidersResponse | null>>();
    const listeners = new Set<() => void>();

    /* ------------------------------------------------------------------------------------------- notification */

    function changed(): void {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (failure) {
                log.error('a catalog listener failed', failure);
            }
        }
        void bus.emit('catalog:changed', { count: snapshot?.models.length ?? 0 });
    }

    /* ----------------------------------------------------------------------------------------------- lookups */

    /** The exact id, else the id with trailing `:suffix` parts peeled off one by one (`:thinking:max` -> `:thinking` -> base). */
    function lookup(id: string): CatalogModel | null {
        const held = snapshot;
        if (!held || typeof id !== 'string') return null;
        let key = id.trim();
        for (;;) {
            const model = held.byId.get(key);
            if (model) return model;
            const cut = key.lastIndexOf(':');
            if (cut <= 0) return null;
            key = key.slice(0, cut);
        }
    }

    /** The key of a model's host list: its catalog id when the catalog knows the model, else the id as given. */
    function providersKey(id: string): string {
        return lookup(id)?.id ?? (typeof id === 'string' ? id.trim() : '');
    }

    function touch(key: string): ProvidersEntry | undefined {
        const entry = entries.get(key);
        if (entry) {
            entries.delete(key);
            entries.set(key, entry);
        }
        return entry;
    }

    function putEntry(key: string, entry: ProvidersEntry): void {
        entries.delete(key);
        entries.set(key, entry);
        while (entries.size > capacity) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
        }
    }

    /* -------------------------------------------------------------------------------------------- the snapshot */

    function makeSnapshot(models: CatalogModel[], fetchedAt: number): Snapshot {
        // A clock that is ahead (the plugin's, or a stored copy from a wrong clock) must not make data look newer than now.
        return { models, byId: new Map(models.map((m) => [m.id, m])), fetchedAt: Math.min(fetchedAt, now()) };
    }

    const isFresh = (value: Snapshot): boolean => now() - value.fetchedAt < freshMs;

    /** Reads the copy stored in the browser, once. It only fills an empty store. */
    async function restore(): Promise<void> {
        triedStorage = true;
        let stored: Awaited<ReturnType<CatalogStorage['load']>> = null;
        try {
            stored = await storage.load();
        } catch (failure) {
            log.debug('the stored catalog could not be read', failure);
        }
        if (!stored || snapshot || stored.version !== CATALOG_STORAGE_VERSION) return;
        const models = readCatalogModels(stored.models);
        if (models.length === 0) return;
        snapshot = makeSnapshot(models, stored.fetchedAt);
        source = isFresh(snapshot) ? 'cache' : 'stale';
        via = 'storage';
        error = null;
        changed();
    }

    function persist(value: Snapshot): void {
        void storage
            .save({ version: CATALOG_STORAGE_VERSION, fetchedAt: value.fetchedAt, models: value.models })
            .catch((failure: unknown) => log.debug('the catalog could not be stored', failure));
    }

    async function pluginIsUp(): Promise<boolean> {
        try {
            return await plugin.available();
        } catch {
            return false;
        }
    }

    interface Fetched {
        models: CatalogModel[];
        fetchedAt: number;
        source: 'live' | 'cache' | 'stale';
        via: 'plugin' | 'direct';
    }

    /** The plugin first, then NanoGPT itself. null with the last error code when neither delivered. */
    async function fetchSnapshot(force: boolean): Promise<{ ok: true; value: Fetched } | { ok: false; code: string }> {
        if (await pluginIsUp()) {
            const result = await pluginCatalog.catalog({ refresh: force });
            if (result.ok) {
                const { models, fetchedAt, source: kind } = result.data;
                return { ok: true, value: { models, fetchedAt, source: kind, via: 'plugin' } };
            }
            log.debug(`the plugin could not deliver the catalog (${result.error.code}); asking NanoGPT directly`);
        }
        const result = await direct.catalog();
        if (result.ok) {
            return { ok: true, value: { models: result.data, fetchedAt: now(), source: 'live', via: 'direct' } };
        }
        return { ok: false, code: result.code };
    }

    async function load(force: boolean): Promise<void> {
        if (!triedStorage && !snapshot) await restore();
        if (snapshot && !force) {
            if (isFresh(snapshot)) return;
            if (failedAt !== null && now() - failedAt < backoffMs) return;
        }
        const result = await fetchSnapshot(force);
        if (result.ok) {
            const { value } = result;
            // Whichever copy is newer wins (the plugin may hold an older one than the browser stored).
            if (!snapshot || Math.min(value.fetchedAt, now()) >= snapshot.fetchedAt) {
                snapshot = makeSnapshot(value.models, value.fetchedAt);
                source = value.source;
                via = value.via;
                persist(snapshot);
            }
            error = null;
            failedAt = null;
            changed();
            return;
        }
        failedAt = now();
        error = result.code;
        log.warn(`the catalog could not be loaded (${result.code})${snapshot ? '; the old copy is kept' : ''}`);
        if (snapshot) source = 'stale';
        changed();
    }

    function refresh(force = false): Promise<void> {
        if (inflight) {
            if (!force || inflightForced) return inflight;
            // A forced refresh must not be swallowed by a flight that may do nothing (a fresh copy needs no fetch): it
            // runs once that flight is over. Callers that arrive meanwhile join it in turn.
            return inflight.then(() => refresh(true));
        }
        inflightForced = force;
        const running: Promise<void> = load(force)
            .catch((failure: unknown) => {
                // load() reports its own failures; this is for a bug, which must not reach the UI as a rejection.
                log.error('the catalog load failed unexpectedly', failure);
            })
            .finally(() => {
                if (inflight === running) inflight = null;
            });
        inflight = running;
        return running;
    }

    /* -------------------------------------------------------------------------------------------- host lists */

    async function fetchProviders(
        key: string,
        held: ProvidersEntry | undefined,
    ): Promise<ModelProvidersResponse | null> {
        let value: ModelProvidersResponse | null = null;
        if (await pluginIsUp()) {
            const result = await pluginCatalog.providers(key);
            if (result.ok) value = result.data;
            else log.debug(`the plugin could not deliver the hosts (${result.error.code}); asking NanoGPT directly`);
        }
        if (!value) {
            const result = await direct.providers(key);
            if (result.ok) value = { ...result.data, fetchedAt: now() };
        }
        if (value) {
            putEntry(key, { value, fetchedAt: Math.min(value.fetchedAt, now()), failedAt: null });
            changed();
            return value;
        }
        log.debug('the host list could not be loaded');
        // The old list (if any) is better than none; either way do not ask again at once.
        putEntry(key, { value: held?.value ?? null, fetchedAt: held?.fetchedAt ?? 0, failedAt: now() });
        return held?.value ?? null;
    }

    async function ensureProviders(id: string, options?: { force?: boolean }): Promise<ModelProviders | null> {
        try {
            const key = providersKey(id);
            if (!key) return null;
            const held = touch(key);
            if (!options?.force) {
                if (held?.value && now() - held.fetchedAt < providersFreshMs) return held.value;
                if (held?.failedAt != null && now() - held.failedAt < backoffMs) return held.value;
            }
            const running = flights.get(key);
            if (running) return await running;
            const flight: Promise<ModelProvidersResponse | null> = fetchProviders(key, held).finally(() => {
                if (flights.get(key) === flight) flights.delete(key);
            });
            flights.set(key, flight);
            return await flight;
        } catch (failure) {
            log.error('loading a host list failed unexpectedly', failure);
            return null;
        }
    }

    /* ----------------------------------------------------------------------------------------------- the store */

    return {
        models: () => snapshot?.models ?? [],
        model: lookup,
        providers: (id) => touch(providersKey(id))?.value ?? null,
        ensureProviders,
        hints(id) {
            const model = lookup(id);
            return model ? routingHints(model, touch(model.id)?.value ?? null) : [];
        },
        status: () => ({ loaded: snapshot !== null, fetchedAt: snapshot?.fetchedAt ?? null, source, error, via }),
        refresh,
        onChange(listener): Unsubscribe {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export interface BrowserCatalogDeps {
    plugin: PluginClient;
    bus: Bus;
    log: Logger;
}

/** The store as the app wires it: the plugin client, a direct source, and IndexedDB storage. */
export function createBrowserCatalogStore(deps: BrowserCatalogDeps): CatalogStore {
    return createCatalogStore({
        plugin: deps.plugin,
        pluginCatalog: createPluginCatalogClient(deps.plugin, deps.log),
        direct: createDirectCatalogSource({ log: deps.log }),
        storage: createCatalogStorage(deps.log),
        bus: deps.bus,
        log: deps.log,
    });
}
