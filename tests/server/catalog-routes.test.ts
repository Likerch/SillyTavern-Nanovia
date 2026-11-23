// The /catalog admin routes and the proxy seams, through the whole plugin (real express router, real http servers on
// port 0, the fake nano-gpt.com).
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCatalog, normalizeModelProviders } from '../../src/domain/catalog';
import { routingHints } from '../../src/domain/catalog-hints';
import type { CatalogModel } from '../../src/shared/contracts';
import { startNanovia, type Nanovia } from '../../src/server/app';
import { CATALOG_TTL_MS, PROVIDERS_TTL_MS, type CatalogTuning } from '../../src/server/catalog';
import { defaultConfig } from '../../src/server/config';
import type { FetchLike } from '../../src/server/types';
import modelsSample from '../fixtures/catalog/models.sample.json';
import glmProviders from '../fixtures/catalog/providers.glm-5.3.json';
import { GLM, GLM_FIXED_ROUTE, SAMPLE_MODEL_COUNT, startFakeNanoGpt, type FakeNanoGpt } from './catalog-fake';
import { FakeSt, cleanTempDirs, chat, jsonUpstream, makeTempDir, recordingLogger, type TestServer } from './helpers';

const START = 1_800_000_000_000;
const sampleModels = normalizeCatalog(modelsSample);
const sampleModel = (id: string): CatalogModel => {
    const model = sampleModels.find((m) => m.id === id);
    if (!model) throw new Error(`fixture has no ${id}`);
    return model;
};

let nano: FakeNanoGpt;
let clock = START;
let closers: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
    nano = await startFakeNanoGpt();
    clock = START;
    closers = [() => nano.close()];
});

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanTempDirs();
});

interface Rig {
    app: Nanovia;
    st: FakeSt;
    root: string;
    admin: string;
    logs: string[];
    get(route: string): Promise<{ status: number; json: any; headers: Headers }>;
}

async function rig(
    options: {
        catalog?: CatalogTuning;
        upstream?: TestServer;
        steps?: Parameters<typeof startNanovia>[1]['steps'];
    } = {},
): Promise<Rig> {
    const root = makeTempDir();
    const st = new FakeSt(root);
    const { log, lines } = recordingLogger();
    const router = express.Router();
    const app = await startNanovia(router, {
        config: {
            ...defaultConfig(),
            port: 0,
            siteBase: nano.site,
            ...(options.upstream
                ? { upstreamBase: `${options.upstream.origin}/api/v1`, upstreamFallbackBase: null }
                : {}),
        },
        st,
        fetch: globalThis.fetch as unknown as FetchLike,
        log,
        now: () => clock,
        version: '9.9.9-test',
        catalog: options.catalog,
        steps: options.steps,
    });
    const server = express().use(express.json()).use('/api/plugins/nanovia', router);
    const http_ = http.createServer(server);
    await new Promise<void>((resolve) => http_.listen(0, '127.0.0.1', resolve));
    const admin = `http://127.0.0.1:${(http_.address() as AddressInfo).port}/api/plugins/nanovia`;
    closers.push(async () => {
        await app.close();
        await new Promise<void>((resolve) => {
            http_.close(() => resolve());
            http_.closeAllConnections();
        });
    });
    return {
        app,
        st,
        root,
        admin,
        logs: lines,
        async get(route) {
            const response = await fetch(`${admin}${route}`);
            const text = await response.text();
            let json: any = {};
            try {
                json = JSON.parse(text);
            } catch {
                // not JSON
            }
            return { status: response.status, json, headers: response.headers };
        },
    };
}

const encoded = (id: string): string => encodeURIComponent(id);

describe('GET /catalog', () => {
    it('answers { models, fetchedAt, source } and the copy is reused until the TTL passes', async () => {
        const h = await rig();
        const first = await h.get('/catalog');
        expect(first.status).toBe(200);
        expect(Object.keys(first.json).sort()).toEqual(['fetchedAt', 'models', 'source']);
        expect(first.json.source).toBe('live');
        expect(first.json.fetchedAt).toBe(START);
        expect(first.json.models).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(first.json.models).toEqual(JSON.parse(JSON.stringify(sampleModels)));
        expect(first.headers.get('cache-control')).toBe('no-store');

        const second = await h.get('/catalog');
        expect(second.json.source).toBe('cache');
        expect(nano.catalogHits()).toBe(1);

        clock += CATALOG_TTL_MS;
        const third = await h.get('/catalog');
        expect(third.json.source).toBe('live');
        expect(third.json.fetchedAt).toBe(clock);
        expect(nano.catalogHits()).toBe(2);
    });

    it('?refresh=1 forces a fetch', async () => {
        const h = await rig();
        await h.get('/catalog');
        const forced = await h.get('/catalog?refresh=1');
        expect(forced.json.source).toBe('live');
        expect(nano.catalogHits()).toBe(2);
        await h.get('/catalog?refresh=0');
        expect(nano.catalogHits()).toBe(2);
    });

    it('writes the cache file under <data root>/_nanovia', async () => {
        const h = await rig();
        await h.get('/catalog');
        const stored = JSON.parse(fs.readFileSync(path.join(h.root, '_nanovia', 'catalog.json'), 'utf8'));
        expect(stored.version).toBe(1);
        expect(stored.models).toHaveLength(SAMPLE_MODEL_COUNT);
    });

    it('answers 502 catalog_unavailable only when there is neither live data nor a copy', async () => {
        nano.mode = 'down';
        const h = await rig();
        const none = await h.get('/catalog');
        expect(none.status).toBe(502);
        expect(none.json).toEqual({
            error: { code: 'catalog_unavailable', message: expect.any(String) },
        });
        expect(JSON.stringify(none.json)).not.toContain('503');

        nano.mode = 'ok';
        expect((await h.get('/catalog')).json.source).toBe('live');
        clock += CATALOG_TTL_MS + 1;
        nano.mode = 'down';
        const stale = await h.get('/catalog');
        expect(stale.status).toBe(200);
        expect(stale.json.source).toBe('stale');
        expect(stale.json.fetchedAt).toBe(START);
        expect(stale.json.models).toHaveLength(SAMPLE_MODEL_COUNT);
    });

    it('serves the stored copy after a restart while NanoGPT is down', async () => {
        const first = await rig();
        await first.get('/catalog');
        const root = first.root;

        // a second plugin instance on the same data root
        const { log } = recordingLogger();
        const router = express.Router();
        nano.mode = 'down';
        clock += CATALOG_TTL_MS * 2;
        const again = await startNanovia(router, {
            config: { ...defaultConfig(), port: 0, siteBase: nano.site },
            st: new FakeSt(root),
            fetch: globalThis.fetch as unknown as FetchLike,
            log,
            now: () => clock,
        });
        closers.push(() => again.close());
        expect(again.deps.lookupModel(GLM)?.id).toBe(GLM); // synchronously, before any request
        const served = await again.deps.catalog?.catalog();
        expect(served?.source).toBe('stale');
        expect(served?.models).toHaveLength(SAMPLE_MODEL_COUNT);
    });
});

describe('GET /catalog/:id/providers', () => {
    it('answers the normalised host list with fetchedAt, for the id encoded in the path', async () => {
        const h = await rig();
        const res = await h.get(`/catalog/${encoded(GLM)}/providers`);
        expect(res.status).toBe(200);
        expect(res.json).toEqual({
            ...JSON.parse(JSON.stringify(normalizeModelProviders(GLM, glmProviders))),
            fetchedAt: START,
        });
        expect(res.json.modelId).toBe(GLM);
        expect(res.json.providers.length).toBeGreaterThan(10);
        expect(nano.urls()).toEqual(['/api/models/z-ai%2Fglm-5.3/providers']);
    });

    it('takes the id from ?id= as well, and the two forms answer the same', async () => {
        const h = await rig();
        const viaPath = await h.get(`/catalog/${encoded(GLM)}/providers`);
        const viaQuery = await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        expect(viaQuery.status).toBe(200);
        expect(viaQuery.json).toEqual(viaPath.json);
        // a model id that really contains a colon and a slash survives both
        const odd = await h.get(`/catalog/providers?id=${encoded(`${GLM}:online/linkup-deep`)}`);
        expect(odd.status).toBe(404); // not in the catalog, so asked as given: the fake knows no such host list
        expect(nano.urls().at(-1)).toBe(`/api/models/${encoded(`${GLM}:online/linkup-deep`)}/providers`);
    });

    it('resolves :online and :memory suffixes through a loaded catalog', async () => {
        const h = await rig();
        await h.get('/catalog');
        const res = await h.get(`/catalog/providers?id=${encoded(`${GLM}:online`)}`);
        expect(res.status).toBe(200);
        expect(res.json.modelId).toBe(GLM);
        expect(nano.providerHits(GLM)).toBe(1);
    });

    it('reports a fixed route and uses the TTL and refresh', async () => {
        const h = await rig();
        const fixed = await h.get(`/catalog/${encoded(GLM_FIXED_ROUTE)}/providers`);
        expect(fixed.json.supportsProviderSelection).toBe(false);
        expect(fixed.json.providers).toEqual([]);

        await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        expect(nano.providerHits(GLM)).toBe(1);
        await h.get(`/catalog/providers?id=${encoded(GLM)}&refresh=1`);
        expect(nano.providerHits(GLM)).toBe(2);
        clock += PROVIDERS_TTL_MS;
        const renewed = await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        expect(renewed.json.fetchedAt).toBe(clock);
        expect(nano.providerHits(GLM)).toBe(3);
    });

    it('answers 404 for a model NanoGPT does not know, 400 without an id, 502 when it cannot be fetched', async () => {
        const h = await rig();
        const unknown = await h.get(`/catalog/${encoded('nobody/nothing')}/providers`);
        expect(unknown.status).toBe(404);
        expect(unknown.json.error.code).toBe('model_not_found');

        for (const route of [
            '/catalog/providers',
            '/catalog/providers?id=',
            `/catalog/providers?id=${'x'.repeat(400)}`,
        ]) {
            const res = await h.get(route);
            expect(res.status, route).toBe(400);
            expect(res.json.error.code).toBe('invalid_request');
        }

        nano.mode = 'down';
        const down = await h.get(`/catalog/${encoded(GLM)}/providers`);
        expect(down.status).toBe(502);
        expect(down.json.error.code).toBe('providers_unavailable');
    });

    it('serves the old list when the refresh fails', async () => {
        const h = await rig();
        await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        clock += PROVIDERS_TTL_MS + 1;
        nano.mode = 'down';
        const res = await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        expect(res.status).toBe(200);
        expect(res.json.fetchedAt).toBe(START);
    });
});

describe('GET /catalog/:id/hints', () => {
    it('is routingHints(model, hosts) for the model of the catalog, by path and by query', async () => {
        const h = await rig();
        const hosts = normalizeModelProviders(GLM, glmProviders);
        const expected = JSON.parse(JSON.stringify(routingHints(sampleModel(GLM), hosts)));
        expect(expected.length).toBeGreaterThan(0);

        const viaPath = await h.get(`/catalog/${encoded(GLM)}/hints`);
        expect(viaPath.status).toBe(200);
        expect(Object.keys(viaPath.json)).toEqual(['hints']);
        expect(viaPath.json.hints).toEqual(expected);
        const viaQuery = await h.get(`/catalog/hints?id=${encoded(GLM)}`);
        expect(viaQuery.json).toEqual(viaPath.json);
        expect(viaQuery.json.hints.some((x: any) => x.code === 'quant.glmFp8')).toBe(true);
    });

    it('loads the catalog on demand and resolves suffixes', async () => {
        const h = await rig();
        const res = await h.get(`/catalog/hints?id=${encoded(`${GLM}:online`)}`);
        expect(res.status).toBe(200);
        expect(nano.catalogHits()).toBe(1);
        expect(res.json.hints.length).toBeGreaterThan(0);
    });

    it('leaves out the rules that need hosts when the host list cannot be fetched', async () => {
        const h = await rig();
        await h.get('/catalog');
        nano.mode = 'down';
        const res = await h.get(`/catalog/hints?id=${encoded(GLM)}`);
        expect(res.status).toBe(200);
        expect(res.json.hints).toEqual(JSON.parse(JSON.stringify(routingHints(sampleModel(GLM), null))));
    });

    it('answers 404 for a model that is not in the catalog, 502 without any catalog, 400 without an id', async () => {
        const h = await rig();
        const unknown = await h.get(`/catalog/hints?id=${encoded('nobody/nothing')}`);
        expect(unknown.status).toBe(404);
        expect(unknown.json.error.code).toBe('model_not_found');
        expect((await h.get('/catalog/hints')).status).toBe(400);

        nano.mode = 'down';
        const cold = await rig();
        const res = await cold.get(`/catalog/hints?id=${encoded(GLM)}`);
        expect(res.status).toBe(502);
        expect(res.json.error.code).toBe('catalog_unavailable');
    });
});

describe('the seams on the plugin', () => {
    it('does not touch NanoGPT on its own unless asked to', async () => {
        const h = await rig();
        expect(h.app.deps.lookupModel(GLM)).toBeNull();
        expect(h.app.deps.providerSelection?.(GLM)).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(nano.server.requests).toHaveLength(0);
        expect(h.app.deps.catalog).toBeDefined();
    });

    it('lookupModel and providerSelection answer from what the routes (or autoFetch) have loaded', async () => {
        const h = await rig();
        await h.get('/catalog');
        await h.get(`/catalog/providers?id=${encoded(GLM)}`);
        expect(h.app.deps.lookupModel(GLM)).toEqual(sampleModel(GLM));
        expect(h.app.deps.lookupModel(`${GLM}:memory-7`)?.id).toBe(GLM);
        expect(h.app.deps.lookupModel('nobody/nothing')).toBeNull();
        expect(h.app.deps.providerSelection?.(GLM)).toBe(true);
        expect(h.app.deps.providerSelection?.(`${GLM}:online`)).toBe(true);
    });

    it('an override passed to startNanovia wins over the catalog', async () => {
        const root = makeTempDir();
        const { log } = recordingLogger();
        const app = await startNanovia(express.Router(), {
            config: { ...defaultConfig(), port: 0, siteBase: nano.site },
            st: new FakeSt(root),
            fetch: globalThis.fetch as unknown as FetchLike,
            log,
            lookupModel: () => sampleModel(GLM),
            providerSelection: () => false,
        });
        closers.push(() => app.close());
        expect(app.deps.lookupModel('anything')?.id).toBe(GLM);
        expect(app.deps.providerSelection?.('anything')).toBe(false);
    });

    it('the proxy hands the catalog model to the pipeline (autoFetch loads it at start)', async () => {
        const upstream = await jsonUpstream();
        closers.push(() => upstream.close());
        const seen: (CatalogModel | null)[] = [];
        const h = await rig({
            upstream,
            catalog: { autoFetch: true },
            steps: { request: [(ctx) => void seen.push(ctx.model)], response: [] },
        });
        await h.app.deps.catalog?.settled();
        const { view, token } = await connectThrough(h);
        h.st.addNanoKey();
        const reply = await chat({ proxy: `http://127.0.0.1:${h.app.proxy.status().port}` }, view, token, {
            model: `${GLM}:online`,
            messages: [{ role: 'user', content: 'hi' }],
        });
        expect(reply.status).toBe(200);
        await reply.text();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.id).toBe(GLM);
    });
});

/** Creates a connection through the admin API of the rig (the proxy needs one). */
async function connectThrough(h: Rig): Promise<{ view: string; token: string }> {
    const response = await fetch(`${h.admin}/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Main', modelId: GLM }),
    });
    const json = (await response.json()) as { connection: { id: string; tokenSecretId: string } };
    const token = h.st.readSecret('default-user', 'api_key_custom', json.connection.tokenSecretId);
    return { view: json.connection.id, token };
}
