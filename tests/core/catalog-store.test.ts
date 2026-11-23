import { afterEach, describe, expect, it } from 'vitest';
import {
    CATALOG_STORAGE_VERSION,
    createCatalogStorage,
    createMemoryCatalogStorage,
} from '../../src/host/catalog-storage';
import {
    DEEPSEEK,
    EMBER,
    GLM,
    GLM_FIXED_ROUTE,
    SAMPLE_MODELS,
    SAMPLE_MODEL_COUNT,
    createCatalogRig,
    createFakeForage,
} from '../helpers/catalog-fakes';
import { memoryLogger } from '../helpers/fakes';

const MIN = 60_000;

describe('loading from the plugin', () => {
    it('starts empty and not loaded', () => {
        const { store } = createCatalogRig();
        expect(store.models()).toEqual([]);
        expect(store.model(GLM)).toBeNull();
        expect(store.status()).toEqual({ loaded: false, fetchedAt: null, source: null, error: null, via: null });
        expect(store.hints(GLM)).toEqual([]);
    });

    it('loads through the plugin and reports where it came from', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        expect(rig.store.models()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(rig.store.status()).toEqual({
            loaded: true,
            fetchedAt: rig.clock.now(),
            source: 'live',
            error: null,
            via: 'plugin',
        });
        expect(rig.plugin.calls).toEqual(['GET /catalog']);
        expect(rig.nano.urls).toEqual([]);
        expect(rig.changes).toBe(1);
        expect(rig.events).toEqual([SAMPLE_MODEL_COUNT]);
    });

    it("passes the plugin's own source on (a copy the plugin could not refresh is stale)", async () => {
        const rig = createCatalogRig();
        rig.plugin.source = 'stale';
        rig.plugin.fetchedAt = rig.clock.now() - 3 * MIN;
        await rig.store.refresh();
        expect(rig.store.status().source).toBe('stale');
        expect(rig.store.status().fetchedAt).toBe(rig.clock.now() - 3 * MIN);
    });

    it('a forced refresh asks the plugin to fetch again', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        await rig.store.refresh(true);
        expect(rig.plugin.calls).toEqual(['GET /catalog', 'GET /catalog?refresh=1']);
    });

    it('does not fetch again inside the freshness window, and does after it', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        rig.clock.advance(9 * MIN);
        await rig.store.refresh();
        expect(rig.plugin.calls).toHaveLength(1);
        rig.clock.advance(2 * MIN);
        await rig.store.refresh();
        expect(rig.plugin.calls).toHaveLength(2);
    });

    it('never makes a copy look newer than now (a plugin with a fast clock)', async () => {
        const rig = createCatalogRig();
        rig.plugin.fetchedAt = rig.clock.now() + 5 * MIN;
        await rig.store.refresh();
        expect(rig.store.status().fetchedAt).toBe(rig.clock.now());
    });

    it('shares one fetch between callers that arrive during it (single-flight)', async () => {
        const rig = createCatalogRig();
        let open!: () => void;
        rig.plugin.gate = new Promise<void>((resolve) => void (open = resolve));
        const calls = [rig.store.refresh(), rig.store.refresh(), rig.store.refresh()];
        open();
        await Promise.all(calls);
        expect(rig.plugin.calls).toHaveLength(1);
        expect(rig.changes).toBe(1);
        // The flight is over: the next forced refresh fetches again.
        rig.plugin.gate = null;
        await rig.store.refresh(true);
        expect(rig.plugin.calls).toHaveLength(2);
    });

    it('forced callers share a forced flight; a forced call during a plain one runs after it, not swallowed by it', async () => {
        const rig = createCatalogRig();
        let open!: () => void;
        rig.plugin.gate = new Promise<void>((resolve) => void (open = resolve));
        const plain = rig.store.refresh();
        const forced = [rig.store.refresh(true), rig.store.refresh(true), rig.store.refresh()];
        open();
        await Promise.all([plain, ...forced]);
        expect(rig.plugin.calls).toEqual(['GET /catalog', 'GET /catalog?refresh=1']);
    });

    it('a forced refresh right after a no-op refresh still fetches', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        void rig.store.refresh();
        await rig.store.refresh(true);
        expect(rig.plugin.calls).toEqual(['GET /catalog', 'GET /catalog?refresh=1']);
    });

    it('keeps one snapshot object between changes so a render can compare by reference', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        const first = rig.store.models();
        expect(rig.store.models()).toBe(first);
    });
});

describe('plugin down: the direct fetch', () => {
    it('goes to NanoGPT itself when the plugin does not answer', async () => {
        const rig = createCatalogRig();
        rig.plugin.up = false;
        await rig.store.refresh();
        expect(rig.store.models()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(rig.store.status()).toMatchObject({ loaded: true, source: 'live', via: 'direct', error: null });
        expect(rig.nano.urls).toEqual(['https://nano.test/api/v1/models?detailed=true']);
        expect(rig.plugin.calls).toEqual([]);
    });

    it('goes direct when the plugin is up but cannot deliver (its own upstream is out)', async () => {
        const rig = createCatalogRig();
        rig.plugin.failCatalog = { status: 502, code: 'catalog_unavailable' };
        await rig.store.refresh();
        expect(rig.store.status()).toMatchObject({ loaded: true, via: 'direct' });
        expect(rig.plugin.calls).toEqual(['GET /catalog']);
        expect(rig.nano.catalogHits()).toBe(1);
    });

    it('treats a junk answer as a failure and keeps no models', async () => {
        const rig = createCatalogRig();
        rig.plugin.up = false;
        rig.nano.mode = 'junk';
        await rig.store.refresh();
        expect(rig.store.status()).toMatchObject({ loaded: false, source: null, error: 'invalid_response' });
        expect(rig.store.models()).toEqual([]);
    });
});

describe('failures keep the old data (stale-on-error)', () => {
    it('keeps the models, marks them stale and reports the error when both sources fail', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        await rig.store.refresh(true);
        expect(rig.store.models()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(rig.store.status()).toMatchObject({
            loaded: true,
            source: 'stale',
            error: 'unreachable',
            via: 'plugin',
        });
        expect(rig.log.lines.some((line) => line.level === 'warn')).toBe(true);
    });

    it('a later success clears the error', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        await rig.store.refresh(true);
        rig.nano.mode = 'ok';
        await rig.store.refresh(true);
        expect(rig.store.status()).toMatchObject({ source: 'live', error: null, via: 'direct' });
    });

    it('does not hammer a failing source: a refresh that is not forced waits out the backoff', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        rig.clock.advance(11 * MIN);
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        await rig.store.refresh();
        expect(rig.nano.catalogHits()).toBe(1);
        await rig.store.refresh();
        expect(rig.nano.catalogHits()).toBe(1);
        rig.clock.advance(31_000);
        await rig.store.refresh();
        expect(rig.nano.catalogHits()).toBe(2);
        // A forced refresh (the retry button) always tries.
        await rig.store.refresh(true);
        expect(rig.nano.catalogHits()).toBe(3);
    });

    it('with nothing to keep, a failure leaves the store empty and says why; the next refresh tries again', async () => {
        const rig = createCatalogRig();
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        await rig.store.refresh();
        expect(rig.store.status()).toMatchObject({ loaded: false, error: 'unreachable' });
        rig.nano.mode = 'ok';
        await rig.store.refresh();
        expect(rig.store.status()).toMatchObject({ loaded: true, error: null });
    });

    it('never throws, whatever the sources do', async () => {
        const rig = createCatalogRig();
        rig.plugin.request = async () => {
            throw new Error('boom');
        };
        rig.plugin.available = async () => {
            throw new Error('boom');
        };
        rig.nano.mode = 'down';
        await expect(rig.store.refresh()).resolves.toBeUndefined();
        await expect(rig.store.ensureProviders(GLM)).resolves.toBeNull();
    });
});

describe('suffix fallback', () => {
    it('finds a model by its exact id, even when the id itself has a suffix', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        expect(rig.store.model(`${DEEPSEEK}:thinking`)?.id).toBe(`${DEEPSEEK}:thinking`);
    });

    it('falls back from :online, :memory-7 and stacked suffixes to the base id', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        expect(rig.store.model(`${GLM}:online`)?.id).toBe(GLM);
        expect(rig.store.model(`${GLM}:memory-7`)?.id).toBe(GLM);
        expect(rig.store.model(`${GLM}:online:memory`)?.id).toBe(GLM);
        expect(rig.store.model(`${DEEPSEEK}:thinking:online`)?.id).toBe(`${DEEPSEEK}:thinking`);
        expect(rig.store.model(`  ${GLM}:online `)?.id).toBe(GLM);
    });

    it('knows nothing it was not told', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        expect(rig.store.model('nobody/nothing')).toBeNull();
        expect(rig.store.model('nobody/nothing:online')).toBeNull();
        expect(rig.store.model(':online')).toBeNull();
        expect(rig.store.model('')).toBeNull();
    });
});

describe('host lists', () => {
    const providerCalls = (calls: string[]): string[] => calls.filter((call) => call.includes('/providers'));

    it('loads the hosts through the plugin with the id in the query, and caches them', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        expect(rig.store.providers(GLM)).toBeNull();
        const hosts = await rig.store.ensureProviders(GLM);
        expect(hosts?.modelId).toBe(GLM);
        expect(hosts?.providers.length).toBeGreaterThan(10);
        expect(rig.plugin.calls.at(-1)).toBe(`GET /catalog/providers?id=${encodeURIComponent(GLM)}`);
        expect(rig.store.providers(GLM)).toBe(hosts);
        await rig.store.ensureProviders(GLM);
        expect(providerCalls(rig.plugin.calls)).toHaveLength(1);
        expect(rig.changes).toBe(2);
    });

    it('resolves a suffixed id to the catalog id for both the cache and the request', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        const hosts = await rig.store.ensureProviders(`${GLM}:online`);
        expect(hosts?.modelId).toBe(GLM);
        expect(rig.store.providers(GLM)).toBe(hosts);
        expect(rig.store.providers(`${GLM}:memory-3`)).toBe(hosts);
        expect(rig.plugin.calls.at(-1)).toBe(`GET /catalog/providers?id=${encodeURIComponent(GLM)}`);
    });

    it('refetches after five minutes', async () => {
        const rig = createCatalogRig();
        await rig.store.ensureProviders(GLM);
        rig.clock.advance(4 * MIN);
        await rig.store.ensureProviders(GLM);
        expect(providerCalls(rig.plugin.calls)).toHaveLength(1);
        rig.clock.advance(2 * MIN);
        await rig.store.ensureProviders(GLM);
        expect(providerCalls(rig.plugin.calls)).toHaveLength(2);
    });

    it('is single-flight per model and parallel across models', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        let open!: () => void;
        rig.plugin.gate = new Promise<void>((resolve) => void (open = resolve));
        const all = [
            rig.store.ensureProviders(GLM),
            rig.store.ensureProviders(GLM),
            rig.store.ensureProviders(`${GLM}:online`),
            rig.store.ensureProviders(EMBER),
        ];
        open();
        const [a, b, c, d] = await Promise.all(all);
        expect(providerCalls(rig.plugin.calls)).toHaveLength(2);
        expect(a).toBe(b);
        expect(a).toBe(c);
        expect(d?.modelId).toBe(EMBER);
    });

    it('goes direct when the plugin is down, with the encoded id in the path', async () => {
        const rig = createCatalogRig();
        rig.plugin.up = false;
        const hosts = await rig.store.ensureProviders(GLM);
        expect(hosts?.providers.length).toBeGreaterThan(10);
        expect(rig.nano.urls).toEqual([`https://nano.test/api/models/${encodeURIComponent(GLM)}/providers`]);
    });

    it('goes direct when the plugin cannot deliver this list', async () => {
        const rig = createCatalogRig();
        rig.plugin.failProviders = { status: 502, code: 'providers_unavailable' };
        const hosts = await rig.store.ensureProviders(GLM);
        expect(hosts?.modelId).toBe(GLM);
        expect(rig.nano.providerHits(GLM)).toBe(1);
    });

    it('keeps the model-level facts of a fixed-route model (no hosts, no selection)', async () => {
        const rig = createCatalogRig();
        const hosts = await rig.store.ensureProviders(GLM_FIXED_ROUTE);
        expect(hosts).toMatchObject({ supportsProviderSelection: false, providers: [] });
    });

    it('answers null for a model NanoGPT does not know and does not ask again at once', async () => {
        const rig = createCatalogRig();
        rig.plugin.up = false;
        expect(await rig.store.ensureProviders('nobody/nothing')).toBeNull();
        expect(await rig.store.ensureProviders('nobody/nothing')).toBeNull();
        expect(rig.nano.providerHits('nobody/nothing')).toBe(1);
        rig.clock.advance(31_000);
        await rig.store.ensureProviders('nobody/nothing');
        expect(rig.nano.providerHits('nobody/nothing')).toBe(2);
    });

    it('force skips the freshness window and the pause after a failure (the retry button)', async () => {
        const rig = createCatalogRig();
        await rig.store.ensureProviders(GLM);
        await rig.store.ensureProviders(GLM, { force: true });
        expect(providerCalls(rig.plugin.calls)).toHaveLength(2);
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        expect(await rig.store.ensureProviders(EMBER)).toBeNull();
        rig.nano.mode = 'ok';
        expect(await rig.store.ensureProviders(EMBER)).toBeNull();
        expect((await rig.store.ensureProviders(EMBER, { force: true }))?.modelId).toBe(EMBER);
    });

    it('serves the old list when a refetch fails, and null when there never was one', async () => {
        const rig = createCatalogRig();
        const first = await rig.store.ensureProviders(GLM);
        rig.clock.advance(6 * MIN);
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        expect(await rig.store.ensureProviders(GLM)).toBe(first);
        expect(await rig.store.ensureProviders(EMBER)).toBeNull();
        expect(rig.store.providers(EMBER)).toBeNull();
    });

    it('keeps a bounded number of lists, dropping the least recently used', async () => {
        const rig = createCatalogRig({ tuning: { providersCapacity: 2 } });
        await rig.store.ensureProviders(GLM);
        await rig.store.ensureProviders(EMBER);
        // Touch GLM so EMBER is the oldest, then add a third.
        expect(rig.store.providers(GLM)).not.toBeNull();
        await rig.store.ensureProviders(DEEPSEEK);
        expect(rig.store.providers(EMBER)).toBeNull();
        expect(rig.store.providers(GLM)).not.toBeNull();
        expect(rig.store.providers(DEEPSEEK)).not.toBeNull();
    });

    it('announces a new list on the bus and to listeners', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        const before = rig.events.length;
        await rig.store.ensureProviders(GLM);
        expect(rig.events.length).toBe(before + 1);
    });
});

describe('hints', () => {
    it('are computed from the model and the hosts known so far', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        expect(rig.store.hints(GLM).find((hint) => hint.code === 'quant.glmFp8')?.params['hostsKnown']).toBe(false);
        await rig.store.ensureProviders(GLM);
        const hint = rig.store.hints(GLM).find((entry) => entry.code === 'quant.glmFp8');
        expect(hint?.params['hostsKnown']).toBe(true);
        expect(hint?.suggestedRouting).toMatchObject({ enabled: true, minQuantization: 'fp8' });
    });

    it('follow a suffixed id and are empty for an unknown model', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        await rig.store.ensureProviders(GLM);
        expect(rig.store.hints(`${GLM}:online`)).toEqual(rig.store.hints(GLM));
        expect(rig.store.hints('nobody/nothing')).toEqual([]);
    });
});

describe('listeners', () => {
    it('are called on a change and can be removed; a failing one does not stop the others', async () => {
        const rig = createCatalogRig();
        let calls = 0;
        rig.store.onChange(() => {
            throw new Error('listener bug');
        });
        const off = rig.store.onChange(() => void calls++);
        await rig.store.refresh();
        expect(calls).toBe(1);
        expect(rig.log.lines.some((line) => line.level === 'error')).toBe(true);
        off();
        await rig.store.refresh(true);
        expect(calls).toBe(1);
        expect(rig.changes).toBe(2);
    });
});

describe('the stored snapshot (IndexedDB)', () => {
    let uninstall: (() => void) | null = null;
    afterEach(() => {
        uninstall?.();
        uninstall = null;
    });

    const storage = () => createCatalogStorage(memoryLogger());

    it('is written after a fetch and read by the next page load, which then needs no network while it is fresh', async () => {
        const forage = createFakeForage();
        uninstall = forage.install();
        const first = createCatalogRig({ storage: storage() });
        await first.store.refresh();
        await Promise.resolve();
        expect(forage.installed).toEqual([{ name: 'nanovia', storeName: 'catalog' }]);
        const stored = forage.values.get('snapshot') as { version: number; fetchedAt: number; models: unknown[] };
        expect(stored.version).toBe(CATALOG_STORAGE_VERSION);
        expect(stored.models).toHaveLength(SAMPLE_MODEL_COUNT);

        // A new page load: same clock start, so the stored copy is fresh.
        const second = createCatalogRig({ storage: storage() });
        await second.store.refresh();
        expect(second.store.models()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(second.store.status()).toMatchObject({ loaded: true, source: 'cache', via: 'storage', error: null });
        expect(second.plugin.calls).toEqual([]);
        expect(second.nano.urls).toEqual([]);
    });

    it('shows an old stored copy at once as stale and refreshes it', async () => {
        const forage = createFakeForage();
        uninstall = forage.install();
        const first = createCatalogRig({ storage: storage() });
        await first.store.refresh();
        await Promise.resolve();

        const second = createCatalogRig({ storage: storage() });
        second.clock.advance(20 * MIN);
        // The plugin never answers: only the stored copy can be on screen.
        second.plugin.gate = new Promise<void>(() => {});
        void second.store.refresh();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(second.store.models()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(second.store.status()).toMatchObject({ source: 'stale', via: 'storage' });
    });

    it('survives a stored copy that is junk and a storage that fails', async () => {
        const forage = createFakeForage();
        uninstall = forage.install();
        forage.values.set('snapshot', { version: 1, fetchedAt: 1, models: 'not a list' });
        const rig = createCatalogRig({ storage: storage() });
        await rig.store.refresh();
        expect(rig.store.status()).toMatchObject({ loaded: true, via: 'plugin' });

        forage.fail = true;
        const failing = createCatalogRig({ storage: storage() });
        await failing.store.refresh();
        expect(failing.store.models()).toHaveLength(SAMPLE_MODEL_COUNT);
    });

    it('falls back to memory when localforage is missing', async () => {
        const memory = createCatalogStorage(memoryLogger());
        await memory.save({ version: CATALOG_STORAGE_VERSION, fetchedAt: 5, models: [] });
        expect((await memory.load())?.fetchedAt).toBe(5);
    });

    it('ignores a stored copy of another format', async () => {
        const rig = createCatalogRig({
            storage: createMemoryCatalogStorage({ version: 99, fetchedAt: 1, models: SAMPLE_MODELS }),
        });
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        await rig.store.refresh();
        expect(rig.store.status().loaded).toBe(false);
    });

    it('keeps a newer stored copy over an older copy the plugin holds', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        rig.clock.advance(11 * MIN);
        rig.plugin.fetchedAt = rig.clock.now() - 30 * MIN;
        rig.plugin.source = 'stale';
        await rig.store.refresh();
        expect(rig.store.status().fetchedAt).toBe(rig.clock.now() - 11 * MIN);
    });
});
