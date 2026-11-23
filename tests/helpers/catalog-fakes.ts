// Fakes for the catalog tests: a fake nano-gpt.com (the real trimmed fixtures behind `fetch`), a fake plugin that serves
// /catalog and /catalog/providers from the same fixtures in the contract shape, and a fake localforage. Switches turn
// each of them off, slow, or junk, and counters tell the tests who was asked.
import { createCatalogStore } from '../../src/core/catalog-store';
import type { CatalogStoreDeps } from '../../src/core/catalog-store';
import { normalizeCatalog, normalizeModelProviders } from '../../src/domain/catalog';
import { createDirectCatalogSource } from '../../src/host/catalog-source';
import { createCatalogStorage, createMemoryCatalogStorage } from '../../src/host/catalog-storage';
import type { CatalogStorage } from '../../src/host/catalog-storage';
import { createPluginCatalogClient } from '../../src/host/plugin-catalog';
import type { PluginClient, PluginResult } from '../../src/host/plugin-client';
import { createBus } from '../../src/core/bus';
import type { CatalogStore } from '../../src/core/catalog';
import type { CatalogResponse } from '../../src/shared/contracts-catalog';
import modelsSample from '../fixtures/catalog/models.sample.json';
import deepseekProviders from '../fixtures/catalog/providers.deepseek-v4.1-flash-1017.json';
import emberProviders from '../fixtures/catalog/providers.ember-1.json';
import fixedRoute from '../fixtures/catalog/providers.glm-4.5v.fixed-route.json';
import glmProviders from '../fixtures/catalog/providers.glm-5.3.json';
import teeProviders from '../fixtures/catalog/providers.tee-glm-5.3.json';
import { memoryLogger } from './fakes';
import type { MemoryLogger } from './fakes';

export const GLM = 'z-ai/glm-5.3';
export const GLM_FIXED_ROUTE = 'z-ai/glm-4.5v';
export const EMBER = 'fireworks/ember-1';
export const TEE_GLM = 'TEE/glm-5.3';
export const DEEPSEEK = 'deepseek/deepseek-v4.1-flash-1017';
export const SAMPLE_MODEL_COUNT = 20;

/** The sample catalog as the contract describes it. */
export const SAMPLE_MODELS = normalizeCatalog(modelsSample);

const RAW_PROVIDERS: Record<string, unknown> = {
    [GLM]: glmProviders,
    [GLM_FIXED_ROUTE]: fixedRoute,
    [EMBER]: emberProviders,
    [TEE_GLM]: teeProviders,
    [DEEPSEEK]: deepseekProviders,
};

export function sampleProviders(id: string) {
    const value = normalizeModelProviders(id, RAW_PROVIDERS[id]);
    if (!value) throw new Error(`no sample hosts for ${id}`);
    return value;
}

export interface FakeClock {
    now(): number;
    advance(ms: number): void;
}

export function fakeClock(start = 1_800_000_000_000): FakeClock {
    let at = start;
    return {
        now: () => at,
        advance: (ms) => void (at += ms),
    };
}

export type Mode = 'ok' | 'down' | 'junk' | 'slow';

/** A fake nano-gpt.com behind a `fetch` function. */
export interface FakeNano {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    mode: Mode;
    /** While set, answers wait for it (single-flight checks). */
    gate: Promise<void> | null;
    urls: string[];
    catalogHits(): number;
    providerHits(id: string): number;
}

export function createFakeNano(): FakeNano {
    const fake: FakeNano = {
        mode: 'ok',
        gate: null,
        urls: [],
        catalogHits: () => fake.urls.filter((url) => url.includes('/api/v1/models')).length,
        providerHits: (id) =>
            fake.urls.filter((url) => url.endsWith(`/api/models/${encodeURIComponent(id)}/providers`)).length,
        fetch: async (input) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            fake.urls.push(url);
            if (fake.gate) await fake.gate;
            if (fake.mode === 'down') throw new TypeError('Failed to fetch');
            if (fake.mode === 'junk') return new Response('<html>nope</html>', { status: 200 });
            if (url.includes('/api/v1/models')) return Response.json(modelsSample);
            const match = /\/api\/models\/(.+)\/providers$/.exec(url);
            const id = match ? decodeURIComponent(match[1] ?? '') : '';
            const raw = RAW_PROVIDERS[id];
            return raw ? Response.json(raw) : new Response('{}', { status: 404 });
        },
    };
    return fake;
}

/** A fake plugin: `available()` and `request()` of the plugin client, serving the catalog routes. */
export interface FakePlugin extends Pick<PluginClient, 'available' | 'request'> {
    up: boolean;
    /** Status of the next catalog / providers answers: null = serve normally. */
    failCatalog: { status: number; code: string } | null;
    failProviders: { status: number; code: string } | null;
    /** What the plugin says about its own copy. */
    source: CatalogResponse['source'];
    /** Epoch ms of the plugin's copy; null = the test clock's now. */
    fetchedAt: number | null;
    calls: string[];
    gate: Promise<void> | null;
}

export function createFakePlugin(clock: FakeClock): FakePlugin {
    const plugin: FakePlugin = {
        up: true,
        failCatalog: null,
        failProviders: null,
        source: 'live',
        fetchedAt: null,
        calls: [],
        gate: null,
        available: async () => plugin.up,
        request: async (method, path): Promise<PluginResult<unknown>> => {
            plugin.calls.push(`${method} ${path}`);
            if (plugin.gate) await plugin.gate;
            if (!plugin.up) return { ok: false, error: { code: 'unreachable', message: 'no answer', status: null } };
            const fetchedAt = plugin.fetchedAt ?? clock.now();
            if (path.startsWith('/catalog/providers')) {
                if (plugin.failProviders) {
                    const { status, code } = plugin.failProviders;
                    return { ok: false, error: { code, message: code, status } };
                }
                const id = decodeURIComponent(new URLSearchParams(path.split('?')[1]).get('id') ?? '');
                const base = SAMPLE_MODELS.find((m) => m.id === id)?.id ?? id;
                if (!RAW_PROVIDERS[base]) {
                    return { ok: false, error: { code: 'model_not_found', message: 'unknown', status: 404 } };
                }
                return { ok: true, data: { ...sampleProviders(base), fetchedAt } };
            }
            if (path.startsWith('/catalog')) {
                if (plugin.failCatalog) {
                    const { status, code } = plugin.failCatalog;
                    return { ok: false, error: { code, message: code, status } };
                }
                const body: CatalogResponse = { models: SAMPLE_MODELS, fetchedAt, source: plugin.source };
                return { ok: true, data: body };
            }
            return { ok: false, error: { code: 'not_found', message: 'no route', status: 404 } };
        },
    };
    return plugin;
}

/** localforage with `createInstance`, holding values in memory; `fail` makes every call reject. */
export interface FakeForage {
    values: Map<string, unknown>;
    fail: boolean;
    installed: { name: string; storeName?: string }[];
    install(): () => void;
}

export function createFakeForage(): FakeForage {
    const forage: FakeForage = {
        values: new Map(),
        fail: false,
        installed: [],
        install() {
            const holder = globalThis as unknown as { SillyTavern?: { libs?: Record<string, unknown> } };
            holder.SillyTavern ??= {};
            holder.SillyTavern.libs ??= {};
            const libs = holder.SillyTavern.libs;
            const previous = libs['localforage'];
            const instance = {
                getItem: async (key: string) => {
                    if (forage.fail) throw new Error('idb broke');
                    return forage.values.has(key) ? structuredClone(forage.values.get(key)) : null;
                },
                setItem: async (key: string, value: unknown) => {
                    if (forage.fail) throw new Error('idb broke');
                    forage.values.set(key, structuredClone(value));
                    return value;
                },
                removeItem: async (key: string) => void forage.values.delete(key),
                keys: async () => [...forage.values.keys()],
                clear: async () => forage.values.clear(),
            };
            libs['localforage'] = {
                createInstance: (options: { name: string; storeName?: string }) => {
                    forage.installed.push(options);
                    return instance;
                },
            };
            return () => {
                if (previous === undefined) delete libs['localforage'];
                else libs['localforage'] = previous;
            };
        },
    };
    return forage;
}

export interface CatalogRig {
    store: CatalogStore;
    nano: FakeNano;
    plugin: FakePlugin;
    clock: FakeClock;
    log: MemoryLogger;
    bus: ReturnType<typeof createBus>;
    storage: CatalogStorage;
    /** `catalog:changed` events seen on the bus. */
    events: number[];
    /** Number of times the store's own onChange listener fired. */
    changes: number;
}

/** A store over the fakes. `storage` defaults to a memory one. */
export function createCatalogRig(
    options: { storage?: CatalogStorage; tuning?: Partial<CatalogStoreDeps> } = {},
): CatalogRig {
    const clock = fakeClock();
    const nano = createFakeNano();
    const plugin = createFakePlugin(clock);
    const log = memoryLogger();
    const bus = createBus(log);
    const storage = options.storage ?? createMemoryCatalogStorage();
    const events: number[] = [];
    bus.on('catalog:changed', ({ count }) => void events.push(count));
    const store = createCatalogStore({
        plugin,
        pluginCatalog: createPluginCatalogClient(plugin, log, clock.now),
        direct: createDirectCatalogSource({ log, fetchImpl: nano.fetch, site: 'https://nano.test' }),
        storage,
        bus,
        log,
        now: clock.now,
        ...options.tuning,
    });
    const rig: CatalogRig = { store, nano, plugin, clock, log, bus, storage, events, changes: 0 };
    store.onChange(() => void rig.changes++);
    return rig;
}

export { createCatalogStorage };
