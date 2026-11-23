// The catalog service against a fake nano-gpt.com (real http server on port 0, the real trimmed fixtures).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer } from '../../tools/mock-nanogpt/server.mjs';
import { normalizeCatalog, normalizeModelProviders } from '../../src/domain/catalog';
import {
    CATALOG_FILE,
    CATALOG_FILE_VERSION,
    CATALOG_TTL_MS,
    FAILURE_BACKOFF_MS,
    PROVIDERS_TTL_MS,
    createCatalogService,
    type CatalogService,
    type CatalogTuning,
} from '../../src/server/catalog';
import type { FetchLike } from '../../src/server/types';
import modelsSample from '../fixtures/catalog/models.sample.json';
import glmProviders from '../fixtures/catalog/providers.glm-5.3.json';
import {
    DEEPSEEK,
    EMBER,
    GLM,
    GLM_FIXED_ROUTE,
    SAMPLE_MODEL_COUNT,
    TEE_GLM,
    startFakeNanoGpt,
    type FakeNanoGpt,
} from './catalog-fake';
import { cleanTempDirs, deferred, makeTempDir, recordingLogger, sleep } from './helpers';

const START = 1_800_000_000_000;
const realFetch = globalThis.fetch as unknown as FetchLike;

let nano: FakeNanoGpt;
let clock = START;
let root = '';
let logs: string[] = [];
const services: CatalogService[] = [];

beforeEach(async () => {
    nano = await startFakeNanoGpt();
    clock = START;
    root = makeTempDir();
    logs = [];
});

afterEach(async () => {
    for (const service of services.splice(0)) service.close();
    nano.gate = null;
    await nano.close();
    cleanTempDirs();
});

function make(tuning: CatalogTuning = {}, dataRoot = root): CatalogService {
    const { log, lines } = recordingLogger();
    logs = lines;
    const service = createCatalogService({
        siteBase: nano.site,
        dataRoot: () => dataRoot,
        fetch: realFetch,
        version: '1.2.3',
        now: () => clock,
        log,
        ...tuning,
    });
    services.push(service);
    return service;
}

const cacheFile = (dataRoot = root): string => path.join(dataRoot, '_nanovia', CATALOG_FILE);
const readCacheFile = (): Record<string, unknown> => JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
const sampleModels = normalizeCatalog(modelsSample);

describe('catalog fetch', () => {
    it('fetches the public endpoint without a key, normalises it and answers live', async () => {
        const service = make();
        const result = await service.catalog();
        expect(result).not.toBeNull();
        expect(result?.source).toBe('live');
        expect(result?.fetchedAt).toBe(START);
        expect(result?.models).toEqual(sampleModels);
        expect(result?.models).toHaveLength(SAMPLE_MODEL_COUNT);

        expect(nano.urls()).toEqual(['/api/v1/models?detailed=true']);
        const headers = nano.lastHeaders();
        expect(headers['user-agent']).toBe('Nanovia/1.2.3');
        expect(headers['authorization']).toBeUndefined();
        expect(headers['x-api-key']).toBeUndefined();
        expect(logs.some((l) => l.includes(`catalog loaded: ${SAMPLE_MODEL_COUNT} models`))).toBe(true);
    });

    it('serves a fresh copy from memory and refetches once the TTL has passed', async () => {
        const service = make();
        expect((await service.catalog())?.source).toBe('live');
        clock += CATALOG_TTL_MS - 1;
        const cached = await service.catalog();
        expect(cached?.source).toBe('cache');
        expect(cached?.fetchedAt).toBe(START);
        expect(nano.catalogHits()).toBe(1);

        clock += 1;
        const renewed = await service.catalog();
        expect(renewed?.source).toBe('live');
        expect(renewed?.fetchedAt).toBe(START + CATALOG_TTL_MS);
        expect(nano.catalogHits()).toBe(2);
    });

    it('refresh forces a fetch even when the copy is fresh', async () => {
        const service = make();
        await service.catalog();
        const forced = await service.catalog({ refresh: true });
        expect(forced?.source).toBe('live');
        expect(nano.catalogHits()).toBe(2);
    });

    it('makes one request for any number of simultaneous callers (single-flight)', async () => {
        const open = deferred();
        nano.gate = open.promise;
        const service = make();
        const calls = Array.from({ length: 6 }, () => service.catalog());
        await sleep(60);
        expect(nano.catalogHits()).toBe(1); // one request reached the fake (and waits at its gate)...
        open.resolve();
        const results = await Promise.all(calls);
        expect(nano.catalogHits()).toBe(1); // ...and all six callers shared it
        expect(results.every((r) => r?.source === 'live' && r.models.length === SAMPLE_MODEL_COUNT)).toBe(true);
    });

    it('answers null when NanoGPT cannot be reached and nothing is stored', async () => {
        nano.mode = 'down';
        const service = make();
        expect(await service.catalog()).toBeNull();
        expect(logs.filter((l) => l.startsWith('warn catalog fetch failed (http 503)'))).toHaveLength(1);
        // a later request tries again: with no copy there is nothing else to serve
        nano.mode = 'ok';
        expect((await service.catalog())?.source).toBe('live');
    });

    it.each([
        ['an answer without models', 'junk' as const],
        ['a body that is not JSON', 'html' as const],
    ])('does not accept %s', async (_name, mode) => {
        nano.mode = mode;
        const service = make();
        expect(await service.catalog()).toBeNull();
        expect(fs.existsSync(cacheFile())).toBe(false);
    });

    it('gives up after the timeout and logs only a short reason', async () => {
        nano.mode = 'hang';
        const service = make({ timeoutMs: 80 });
        const started = Date.now();
        expect(await service.catalog()).toBeNull();
        expect(Date.now() - started).toBeLessThan(3000);
        expect(logs.some((l) => l.includes('catalog fetch failed (timeout)'))).toBe(true);
    });

    it('reports an unreachable host by its error code', async () => {
        const dead = await startFakeNanoGpt();
        const site = dead.site;
        await dead.close();
        const { log, lines } = recordingLogger();
        const service = createCatalogService({
            siteBase: site,
            dataRoot: () => root,
            fetch: realFetch,
            version: '1',
            now: () => clock,
            log,
        });
        services.push(service);
        expect(await service.catalog()).toBeNull();
        expect(lines.some((l) => /catalog fetch failed \((ECONNREFUSED|unreachable)\)/.test(l))).toBe(true);
    });

    it('survives a fetch that throws synchronously and one that ignores the abort signal', async () => {
        const broken = createCatalogService({
            siteBase: nano.site,
            dataRoot: () => root,
            fetch: () => {
                throw new Error('boom: sk-secret-should-not-be-logged');
            },
            version: '1',
            now: () => clock,
            log: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
        });
        services.push(broken);
        expect(await broken.catalog()).toBeNull();
        expect(logs.join('\n')).not.toContain('sk-secret');

        const stubborn = createCatalogService({
            siteBase: nano.site,
            dataRoot: () => root,
            fetch: () => new Promise(() => {}), // never settles, whatever the signal says
            version: '1',
            now: () => clock,
            log: { info: () => {}, warn: () => {}, error: () => {} },
            timeoutMs: 50,
        });
        services.push(stubborn);
        expect(await stubborn.catalog()).toBeNull();
    });
});

describe('the cache file', () => {
    it('is written after a fetch as { version, fetchedAt, models }', async () => {
        const service = make();
        await service.catalog();
        const stored = readCacheFile();
        expect(stored['version']).toBe(CATALOG_FILE_VERSION);
        expect(stored['fetchedAt']).toBe(START);
        expect(stored['models']).toEqual(JSON.parse(JSON.stringify(sampleModels)));
        expect(fs.readdirSync(path.dirname(cacheFile())).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('is read at start: the proxy knows the models before any fetch, and a fresh file needs no fetch at all', async () => {
        await make().catalog();
        nano.server.requests.length = 0;

        clock += 5 * 60_000; // five minutes later: a restart
        expect(make().lookupModel(GLM)).toBeNull(); // nothing is read before start()
        const restarted = make({ autoFetch: true });
        restarted.start();
        expect(restarted.lookupModel(GLM)?.name).toBe('GLM 5.3'); // synchronously, from the file
        const served = await restarted.catalog();
        expect(served?.source).toBe('cache');
        expect(served?.fetchedAt).toBe(START);
        await restarted.settled();
        expect(nano.catalogHits()).toBe(0);
    });

    it('serves an old file as stale while the first fetch of the run is still going, then renews it', async () => {
        await make().catalog();
        nano.server.requests.length = 0;

        clock += CATALOG_TTL_MS + 1000;
        const open = deferred();
        nano.gate = open.promise;
        const restarted = make({ autoFetch: true });
        restarted.start();
        // the fetch is running (held at the gate): nobody has to wait for it
        const early = await restarted.catalog();
        expect(early?.source).toBe('stale');
        expect(early?.fetchedAt).toBe(START);
        expect(early?.models).toHaveLength(SAMPLE_MODEL_COUNT);

        open.resolve();
        await restarted.settled();
        const renewed = await restarted.catalog();
        expect(renewed?.source).toBe('cache');
        expect(renewed?.fetchedAt).toBe(clock);
        expect(nano.catalogHits()).toBe(1);
    });

    it('is served as stale when the live fetch fails after a restart', async () => {
        await make().catalog();
        clock += CATALOG_TTL_MS * 3;
        nano.mode = 'down';
        const restarted = make();
        restarted.start();
        const result = await restarted.catalog();
        expect(result?.source).toBe('stale');
        expect(result?.fetchedAt).toBe(START);
        expect(result?.models).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(logs.some((l) => l.includes('the stored copy is used'))).toBe(true);
    });

    it('is ignored when it is corrupt, of another version or empty, and is not an error', () => {
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        const cases: string[] = [
            '{ not json',
            JSON.stringify({ version: 99, fetchedAt: START, models: sampleModels }),
            JSON.stringify({ version: CATALOG_FILE_VERSION, fetchedAt: 'yesterday', models: sampleModels }),
            JSON.stringify({ version: CATALOG_FILE_VERSION, fetchedAt: START, models: [{ id: 'x' }, 5, null] }),
            JSON.stringify([]),
        ];
        for (const text of cases) {
            fs.writeFileSync(cacheFile(), text);
            const service = make();
            service.start();
            expect(service.lookupModel(GLM)).toBeNull();
        }
    });

    it('drops bad entries and repeated ids but keeps the good ones, and never lives in the future', async () => {
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        const good = sampleModels[0];
        fs.writeFileSync(
            cacheFile(),
            JSON.stringify({
                version: CATALOG_FILE_VERSION,
                fetchedAt: START + 10 * CATALOG_TTL_MS,
                models: [good, { id: 'broken' }, good, null],
            }),
        );
        const service = make();
        service.start();
        const result = await service.catalog();
        expect(result?.models.map((m) => m.id)).toEqual([good?.id]);
        expect(result?.fetchedAt).toBe(START); // clamped to now
    });

    it('does not break the fetch when the data root cannot be written', async () => {
        const blocker = path.join(makeTempDir(), 'file');
        fs.writeFileSync(blocker, 'x');
        const service = make({}, blocker); // a data root that is a file: mkdir under it fails
        const result = await service.catalog();
        expect(result?.source).toBe('live');
        expect(logs.some((l) => l.startsWith('warn catalog cache could not be written'))).toBe(true);
    });
});

describe('stale on error', () => {
    it('keeps serving the old copy as stale, tries again only after the backoff, and recovers', async () => {
        const service = make();
        await service.catalog();
        const before = readCacheFile();

        clock += CATALOG_TTL_MS + 1;
        nano.mode = 'down';
        const failed = await service.catalog();
        expect(failed?.source).toBe('stale');
        expect(failed?.fetchedAt).toBe(START);
        expect(failed?.models).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(nano.catalogHits()).toBe(2);
        expect(readCacheFile()).toEqual(before); // the failure did not touch the file

        // the next requests do not wait for a fetch that failed a moment ago
        clock += FAILURE_BACKOFF_MS - 1;
        expect((await service.catalog())?.source).toBe('stale');
        expect(nano.catalogHits()).toBe(2);
        // ...unless the caller insists
        expect((await service.catalog({ refresh: true }))?.source).toBe('stale');
        expect(nano.catalogHits()).toBe(3);

        clock += FAILURE_BACKOFF_MS;
        nano.mode = 'ok';
        const recovered = await service.catalog();
        expect(recovered?.source).toBe('live');
        expect(recovered?.fetchedAt).toBe(clock);
        expect(nano.catalogHits()).toBe(4);
        // one warning for the whole outage, not one per attempt
        expect(logs.filter((l) => l.startsWith('warn catalog fetch failed'))).toHaveLength(1);
    });

    it('keeps a good copy when NanoGPT answers with junk', async () => {
        const service = make();
        await service.catalog();
        clock += CATALOG_TTL_MS + 1;
        nano.mode = 'junk';
        const result = await service.catalog();
        expect(result?.source).toBe('stale');
        expect(result?.models).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(readCacheFile()['fetchedAt']).toBe(START);
    });
});

describe('lookupModel', () => {
    it('is synchronous, finds the exact id and answers null for an unknown one', async () => {
        const service = make();
        await service.catalog();
        const model = service.lookupModel(GLM);
        expect(model).toEqual(sampleModels.find((m) => m.id === GLM));
        expect(service.lookupModel('nobody/nothing')).toBeNull();
        expect(service.lookupModel('')).toBeNull();
        expect(service.lookupModel('  ' + GLM + '  ')?.id).toBe(GLM);
        // the same object every time: the proxy asks per request and must not pay for a copy
        expect(service.lookupModel(GLM)).toBe(model);
    });

    it('prefers the exact id, including ids that carry a colon themselves', async () => {
        const service = make();
        await service.catalog();
        const thinking = `${DEEPSEEK}:thinking`;
        expect(service.lookupModel(thinking)?.id).toBe(thinking);
        expect(service.lookupModel(DEEPSEEK)?.id).toBe(DEEPSEEK);
    });

    it('falls back to the id without :online, :memory and :thinking-style suffixes', async () => {
        const service = make();
        await service.catalog();
        for (const suffixed of [
            `${GLM}:online`,
            `${GLM}:online/linkup-deep`,
            `${GLM}:memory`,
            `${GLM}:memory-7`,
            `${GLM}:thinking`,
            `${GLM}:thinking:max`,
            `${GLM}:thinking:online:memory-30`,
        ]) {
            expect(service.lookupModel(suffixed)?.id, suffixed).toBe(GLM);
        }
        // a suffix on a model that has its own :thinking entry peels only down to that entry
        expect(service.lookupModel(`${DEEPSEEK}:thinking:online`)?.id).toBe(`${DEEPSEEK}:thinking`);
        expect(service.lookupModel('nobody/nothing:online')).toBeNull();
        expect(service.lookupModel(':online')).toBeNull();
    });

    it('answers null at once while the catalog is not loaded, and never fetches by itself unless asked to', async () => {
        const quiet = make();
        expect(quiet.lookupModel(GLM)).toBeNull();
        await sleep(40);
        expect(nano.catalogHits()).toBe(0);

        const eager = make({ autoFetch: true });
        expect(eager.lookupModel(GLM)).toBeNull(); // still null for this call...
        await eager.settled();
        expect(nano.catalogHits()).toBe(1); // ...but a background fetch was started
        expect(eager.lookupModel(GLM)?.id).toBe(GLM);
    });

    it('refreshes an expired catalog in the background and keeps answering from the old one', async () => {
        const service = make({ autoFetch: true });
        service.start();
        await service.settled();
        expect(nano.catalogHits()).toBe(1);

        clock += CATALOG_TTL_MS + 1;
        const open = deferred();
        nano.gate = open.promise;
        expect(service.lookupModel(GLM)?.id).toBe(GLM); // old copy, no waiting
        service.lookupModel(GLM); // many requests, one fetch
        service.lookupModel(EMBER);
        open.resolve();
        await service.settled();
        expect(nano.catalogHits()).toBe(2);
        expect((await service.catalog())?.fetchedAt).toBe(clock);
    });

    it('does not hammer NanoGPT while it is down', async () => {
        nano.mode = 'down';
        const service = make({ autoFetch: true });
        service.start();
        await service.settled();
        for (let i = 0; i < 5; i++) service.lookupModel(GLM);
        await service.settled();
        expect(nano.catalogHits()).toBe(1);
        clock += FAILURE_BACKOFF_MS;
        service.lookupModel(GLM);
        await service.settled();
        expect(nano.catalogHits()).toBe(2);
    });
});

describe('providers', () => {
    it('fetches the host list of a model by its encoded id and normalises it', async () => {
        const service = make();
        await service.catalog();
        const result = await service.providers(GLM);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(nano.urls().at(-1)).toBe('/api/models/z-ai%2Fglm-5.3/providers');
        expect(result.value.fetchedAt).toBe(START);
        const expected = normalizeModelProviders(GLM, glmProviders);
        expect(result.value).toEqual({ ...expected, fetchedAt: START });
        expect(result.value.supportsProviderSelection).toBe(true);
        expect(result.value.providers.length).toBeGreaterThan(10);
        expect(nano.lastHeaders()['user-agent']).toBe('Nanovia/1.2.3');
    });

    it('works before the catalog is loaded, with the id as given', async () => {
        const service = make();
        const result = await service.providers(EMBER);
        expect(result.ok).toBe(true);
        expect(nano.catalogHits()).toBe(0);
        if (result.ok) expect(result.value.modelId).toBe(EMBER);
    });

    it('resolves suffixes through the catalog and shares one entry', async () => {
        const service = make();
        await service.catalog();
        const plain = await service.providers(GLM);
        const online = await service.providers(`${GLM}:online`);
        expect(online).toEqual(plain);
        expect(nano.providerHits(GLM)).toBe(1);
        expect(nano.urls().filter((u) => u.includes('/providers'))).toEqual(['/api/models/z-ai%2Fglm-5.3/providers']);
    });

    it('is fresh for five minutes, then fetched again', async () => {
        const service = make();
        await service.providers(GLM);
        clock += PROVIDERS_TTL_MS - 1;
        const cached = await service.providers(GLM);
        expect(cached.ok && cached.value.fetchedAt).toBe(START);
        expect(nano.providerHits(GLM)).toBe(1);

        clock += 1;
        const renewed = await service.providers(GLM);
        expect(renewed.ok && renewed.value.fetchedAt).toBe(clock);
        expect(nano.providerHits(GLM)).toBe(2);

        await service.providers(GLM, { refresh: true });
        expect(nano.providerHits(GLM)).toBe(3);
    });

    it('makes one request for simultaneous callers', async () => {
        const open = deferred();
        nano.gate = open.promise;
        const service = make();
        const calls = Array.from({ length: 5 }, () => service.providers(GLM));
        await sleep(60);
        open.resolve();
        const results = await Promise.all(calls);
        expect(nano.providerHits(GLM)).toBe(1);
        expect(results.every((r) => r.ok)).toBe(true);
    });

    it('serves the old list when the refresh fails, with its own fetchedAt', async () => {
        const service = make();
        await service.providers(GLM);
        clock += PROVIDERS_TTL_MS + 1;
        nano.mode = 'down';
        const result = await service.providers(GLM);
        expect(result.ok && result.value.fetchedAt).toBe(START);
        expect(result.ok && result.value.providers.length).toBeGreaterThan(10);
    });

    it('tells an unknown model from an outage', async () => {
        const service = make();
        expect(await service.providers('nobody/nothing')).toEqual({ ok: false, reason: 'not_found' });
        expect(await service.providers('')).toEqual({ ok: false, reason: 'not_found' });
        nano.mode = 'down';
        expect(await service.providers(GLM)).toEqual({ ok: false, reason: 'unavailable' });
        nano.mode = 'junk';
        expect(await service.providers(EMBER)).toEqual({ ok: false, reason: 'unavailable' });
    });

    it('keeps at most `providersCapacity` lists and drops the least recently used', async () => {
        const service = make({ providersCapacity: 2 });
        await service.providers(GLM);
        await service.providers(EMBER);
        await service.providers(GLM); // touched: EMBER is now the oldest
        await service.providers(TEE_GLM); // evicts EMBER
        expect(nano.providerHits(GLM)).toBe(1);

        await service.providers(GLM);
        expect(nano.providerHits(GLM)).toBe(1); // still held
        await service.providers(EMBER);
        expect(nano.providerHits(EMBER)).toBe(2); // fetched again
    });
});

describe('providerSelection', () => {
    it('is null while unknown, never waits, and is answered once the background fetch has landed', async () => {
        const service = make({ autoFetch: true });
        await service.catalog();
        expect(service.providerSelection(GLM)).toBeNull();
        expect(service.providerSelection(GLM)).toBeNull(); // still one request, however often it is asked
        await service.settled();
        expect(nano.providerHits(GLM)).toBe(1);
        expect(service.providerSelection(GLM)).toBe(true);
        expect(service.providerSelection(`${GLM}:online`)).toBe(true); // through the catalog's id resolution
        expect(nano.providerHits(GLM)).toBe(1);
    });

    it('is false for a model on a fixed route', async () => {
        const service = make({ autoFetch: true });
        expect(service.providerSelection(GLM_FIXED_ROUTE)).toBeNull();
        await service.settled();
        expect(service.providerSelection(GLM_FIXED_ROUTE)).toBe(false);
    });

    it('stays null for a model NanoGPT does not know, and asks again only after the backoff', async () => {
        const service = make({ autoFetch: true });
        expect(service.providerSelection('nobody/nothing')).toBeNull();
        await service.settled();
        expect(service.providerSelection('nobody/nothing')).toBeNull();
        await service.settled();
        expect(nano.providerHits('nobody/nothing')).toBe(1);

        clock += FAILURE_BACKOFF_MS;
        expect(service.providerSelection('nobody/nothing')).toBeNull();
        await service.settled();
        expect(nano.providerHits('nobody/nothing')).toBe(2);
    });

    it('answers from an expired entry at once and renews it in the background', async () => {
        const service = make({ autoFetch: true });
        await service.providers(GLM);
        clock += PROVIDERS_TTL_MS + 1;
        expect(service.providerSelection(GLM)).toBe(true);
        await service.settled();
        expect(nano.providerHits(GLM)).toBe(2);
    });

    it('does not fetch by itself when autoFetch is off', async () => {
        const service = make();
        expect(service.providerSelection(GLM)).toBeNull();
        expect(service.providerSelection('')).toBeNull();
        await sleep(40);
        expect(nano.server.requests).toHaveLength(0);
        await service.providers(GLM); // a route asked: now it is known
        expect(service.providerSelection(GLM)).toBe(true);
    });
});

describe('close', () => {
    it('aborts a running fetch, answers null and writes nothing afterwards', async () => {
        nano.mode = 'hang';
        const service = make({ timeoutMs: 60_000 });
        const pending = service.catalog();
        await sleep(40);
        service.close();
        expect(await pending).toBeNull();
        expect(fs.existsSync(cacheFile())).toBe(false);
        expect(logs.filter((l) => l.startsWith('warn'))).toEqual([]);
        expect(await service.catalog()).toBeNull(); // closed: no new fetches
    });
});

describe('against the mock NanoGPT of tools/', () => {
    it('loads the whole snapshot catalog and the host lists, including a fixed route and the mock-only models', async () => {
        const mock = createMockServer();
        const port = await mock.listen(0);
        try {
            const { log } = recordingLogger();
            const service = createCatalogService({
                siteBase: `http://127.0.0.1:${port}`,
                dataRoot: () => root,
                fetch: realFetch,
                version: '1',
                now: () => clock,
                log,
            });
            services.push(service);
            const result = await service.catalog();
            expect(result?.source).toBe('live');
            expect(result?.models).toHaveLength(mock.catalog.models.length);
            expect(result?.models.some((m) => m.id.startsWith('mock/'))).toBe(true);
            expect(service.lookupModel('mock/paid-premium:online')?.id).toBe('mock/paid-premium');

            const hosts = await service.providers('z-ai/glm-5.3');
            expect(hosts.ok && hosts.value.providers.length).toBeGreaterThan(5);
            const fixed = await service.providers('mock/no-selection');
            expect(fixed.ok && fixed.value.supportsProviderSelection).toBe(false);
            expect(service.providerSelection('mock/no-selection')).toBe(false);
            expect(await service.providers('mock/does-not-exist')).toEqual({ ok: false, reason: 'not_found' });
        } finally {
            await mock.close();
        }
    });
});
