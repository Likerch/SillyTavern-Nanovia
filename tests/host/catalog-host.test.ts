import { describe, expect, it } from 'vitest';
import { createDirectCatalogSource } from '../../src/host/catalog-source';
import {
    readCatalogModel,
    readCatalogModels,
    readModelProviders,
    createPluginCatalogClient,
} from '../../src/host/plugin-catalog';
import { createPluginClient } from '../../src/host/plugin-client';
import { PLUGIN_ADMIN_BASE } from '../../src/shared/constants';
import { GLM, SAMPLE_MODELS, SAMPLE_MODEL_COUNT, createFakeNano, sampleProviders } from '../helpers/catalog-fakes';
import { memoryLogger } from '../helpers/fakes';

const log = memoryLogger();

describe('reading the contract shape', () => {
    it('round-trips every model of the sample catalog', () => {
        expect(readCatalogModels(JSON.parse(JSON.stringify(SAMPLE_MODELS)))).toEqual(SAMPLE_MODELS);
    });

    it('skips junk, repeated ids and models without an id', () => {
        const model = SAMPLE_MODELS[0];
        const list = readCatalogModels([model, null, 7, 'x', {}, { id: '  ' }, { ...model, name: 'again' }, [model]]);
        expect(list).toHaveLength(1);
        expect(list[0]?.name).toBe(model?.name);
        expect(readCatalogModels('nope')).toEqual([]);
    });

    it('fills in what an older plugin left out', () => {
        const model = readCatalogModel({ id: 'a/b' });
        expect(model).toEqual({
            id: 'a/b',
            name: 'a/b',
            description: '',
            contextLength: null,
            maxOutputTokens: null,
            capabilities: { vision: false, reasoning: false, toolCalling: false, structuredOutput: false },
            reasoningEfforts: [],
            openWeights: false,
            pricing: { prompt: 0, completion: 0, cacheRead: null },
            category: null,
            subscription: { included: false, inputTokenMultiplier: 1 },
            providerIds: [],
            created: null,
        });
    });

    it('rejects a host list that is not one and drops hosts without an id', () => {
        expect(readModelProviders(null, 1)).toBeNull();
        expect(readModelProviders({ modelId: 'x' }, 1)).toBeNull();
        expect(readModelProviders({ providers: [] }, 1)).toBeNull();
        const value = readModelProviders({ modelId: 'x', providers: [{ id: 'a' }, { id: '' }, 4, { id: 'a' }] }, 77);
        expect(value?.providers).toHaveLength(1);
        expect(value?.fetchedAt).toBe(77);
        expect(value?.supportsProviderSelection).toBe(true);
        expect(readModelProviders({ modelId: 'x', providers: [], supportsProviderSelection: false }, 1)).toMatchObject({
            supportsProviderSelection: false,
            providers: [],
        });
    });

    it('round-trips a normalised host list', () => {
        const hosts = { ...sampleProviders(GLM), fetchedAt: 123 };
        expect(readModelProviders(JSON.parse(JSON.stringify(hosts)), 1)).toEqual(hosts);
    });
});

describe('the plugin catalog client', () => {
    function setup(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
        const urls: string[] = [];
        const plugin = createPluginClient({
            ctx: () =>
                ({
                    getRequestHeaders: (options?: { omitContentType?: boolean }) =>
                        options?.omitContentType
                            ? { 'X-CSRF-Token': 't' }
                            : { 'X-CSRF-Token': 't', 'Content-Type': 'application/json' },
                }) as unknown as STContext,
            log,
            fetchImpl: async (input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                urls.push(url);
                return handler(url, init);
            },
        });
        return { urls, client: createPluginCatalogClient(plugin, log, () => 42) };
    }

    it('asks /catalog (with ?refresh=1 when forced) and returns the normalised models', async () => {
        const { client, urls } = setup(() =>
            Response.json({ models: SAMPLE_MODELS, fetchedAt: 1000, source: 'cache' }),
        );
        const result = await client.catalog();
        expect(result.ok && result.data.models).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(result.ok && result.data.source).toBe('cache');
        expect(result.ok && result.data.fetchedAt).toBe(1000);
        await client.catalog({ refresh: true });
        expect(urls).toEqual([`${PLUGIN_ADMIN_BASE}/catalog`, `${PLUGIN_ADMIN_BASE}/catalog?refresh=1`]);
    });

    it('asks the host list by query so no proxy has to decode %2F', async () => {
        const { client, urls } = setup(() => Response.json({ ...sampleProviders(GLM), fetchedAt: 9 }));
        const result = await client.providers('TEE/glm-5.3:online');
        expect(result.ok && result.data.modelId).toBe(GLM);
        await client.providers(GLM, { refresh: true });
        expect(urls).toEqual([
            `${PLUGIN_ADMIN_BASE}/catalog/providers?id=${encodeURIComponent('TEE/glm-5.3:online')}`,
            `${PLUGIN_ADMIN_BASE}/catalog/providers?id=${encodeURIComponent(GLM)}&refresh=1`,
        ]);
    });

    it('reports the plugin errors as values', async () => {
        const gone = setup(() => new Response('<html>Cannot GET</html>', { status: 404 }));
        const missing = await gone.client.catalog();
        expect(!missing.ok && missing.error.code).toBe('not_installed');

        const refused = setup(() =>
            Response.json({ error: { code: 'catalog_unavailable', message: 'no' } }, { status: 502 }),
        );
        const failed = await refused.client.catalog();
        expect(!failed.ok && failed.error).toMatchObject({ code: 'catalog_unavailable', status: 502 });

        const unknown = setup(() =>
            Response.json({ error: { code: 'model_not_found', message: 'no' } }, { status: 404 }),
        );
        const notFound = await unknown.client.providers('x/y');
        expect(!notFound.ok && notFound.error.code).toBe('model_not_found');
    });

    it('calls an answer that is not the contract invalid, never throws', async () => {
        const junk = setup(() => Response.json({ hello: 'world' }));
        const catalog = await junk.client.catalog();
        expect(!catalog.ok && catalog.error.code).toBe('invalid_response');
        const providers = await junk.client.providers(GLM);
        expect(!providers.ok && providers.error.code).toBe('invalid_response');
        const empty = setup(() => Response.json({ models: [{ nope: true }], fetchedAt: 1, source: 'live' }));
        const none = await empty.client.catalog();
        expect(!none.ok && none.error.code).toBe('invalid_response');
        const dead = setup(() => {
            throw new TypeError('Failed to fetch');
        });
        const down = await dead.client.catalog();
        expect(!down.ok && down.error.code).toBe('unreachable');
    });

    it('falls back to its own clock and source when the answer leaves them out', async () => {
        const { client } = setup(() => Response.json({ models: SAMPLE_MODELS }));
        const result = await client.catalog();
        expect(result.ok && result.data).toMatchObject({ fetchedAt: 42, source: 'cache' });
    });
});

describe('the direct source', () => {
    function source(nano = createFakeNano(), extra: { catalogTimeoutMs?: number; providersTimeoutMs?: number } = {}) {
        return {
            nano,
            direct: createDirectCatalogSource({ log, fetchImpl: nano.fetch, site: 'https://nano.test/', ...extra }),
        };
    }

    it('reads the catalog and the hosts from the public routes', async () => {
        const { nano, direct } = source();
        const catalog = await direct.catalog();
        expect(catalog.ok && catalog.data).toHaveLength(SAMPLE_MODEL_COUNT);
        const hosts = await direct.providers(GLM);
        expect(hosts.ok && hosts.data.modelId).toBe(GLM);
        expect(nano.urls).toEqual([
            'https://nano.test/api/v1/models?detailed=true',
            `https://nano.test/api/models/${encodeURIComponent(GLM)}/providers`,
        ]);
    });

    it('is a plain cross-origin read: no custom headers, no cookies', async () => {
        const seen: RequestInit[] = [];
        const nano = createFakeNano();
        const inner = nano.fetch;
        nano.fetch = async (input, init) => {
            seen.push(init ?? {});
            return inner(input, init);
        };
        const { direct } = source(nano);
        await direct.catalog();
        await direct.providers(GLM);
        expect(seen).toHaveLength(2);
        for (const init of seen) {
            expect(init.method).toBe('GET');
            expect(init.credentials).toBe('omit');
            expect(init.headers).toEqual({ accept: 'application/json' });
        }
    });

    it('answers 404 for an unknown model with not_found, other statuses with http_<n>', async () => {
        const { direct } = source();
        const unknown = await direct.providers('nobody/nothing');
        expect(unknown).toMatchObject({ ok: false, code: 'not_found', status: 404 });

        const nano = createFakeNano();
        nano.fetch = async () => new Response('', { status: 503 });
        const down = await source(nano).direct.catalog();
        expect(down).toMatchObject({ ok: false, code: 'http_503', status: 503 });
    });

    it('turns a network failure, junk, an empty catalog and a hang into short codes', async () => {
        const dead = createFakeNano();
        dead.mode = 'down';
        expect(await source(dead).direct.catalog()).toMatchObject({ ok: false, code: 'unreachable' });

        const junk = createFakeNano();
        junk.mode = 'junk';
        expect(await source(junk).direct.catalog()).toMatchObject({ ok: false, code: 'invalid_response' });
        expect(await source(junk).direct.providers(GLM)).toMatchObject({ ok: false, code: 'invalid_response' });

        const empty = createFakeNano();
        empty.fetch = async () => Response.json({ data: [] });
        expect(await source(empty).direct.catalog()).toMatchObject({ ok: false, code: 'invalid_response' });

        const odd = createFakeNano();
        odd.fetch = async () => Response.json({ hello: 1 });
        expect(await source(odd).direct.providers(GLM)).toMatchObject({ ok: false, code: 'invalid_response' });

        const hang = createFakeNano();
        hang.fetch = () => new Promise<Response>(() => {});
        const slow = await source(hang, { catalogTimeoutMs: 20, providersTimeoutMs: 20 });
        expect(await slow.direct.catalog()).toMatchObject({ ok: false, code: 'timeout' });
        expect(await slow.direct.providers(GLM)).toMatchObject({ ok: false, code: 'timeout' });
    });
});
