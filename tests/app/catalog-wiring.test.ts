// @vitest-environment happy-dom
// The real catalog store and the Catalog tab as the app wires them: lazy, plugin first, direct when the plugin has no
// catalog route, and the panel opens the tab.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startNanovia } from '../../src/app/app';
import type { Runtime } from '../../src/app/app';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import modelsSample from '../fixtures/catalog/models.sample.json';
import { SAMPLE_MODEL_COUNT } from '../helpers/catalog-fakes';
import { createFakeBackend } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { flush } from '../helpers/fakes';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

const globals = globalThis as unknown as Record<string, unknown>;

let mock: StMock;
let backend: FakeBackend;
let runtime: Runtime | null;

beforeEach(() => {
    mock = installStMock();
    backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    mock.fetchImpl = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://nano-gpt.com/api/v1/models')) return Response.json(modelsSample);
        return backend.fetch(input, init);
    };
    seedConnectionManager(mock);
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    runtime = null;
});

afterEach(async () => {
    await runtime?.stop();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

const catalogRequests = (): string[] =>
    mock.requests
        .map((request) => request.url)
        .filter((url) => url.includes('/catalog') || url.includes('nano-gpt.com'));

describe('the catalog in the app', () => {
    it('adds the Catalog tab between Connections and General and the real store to the context', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const tabs = runtime.panel.tabIds();
        expect(tabs.indexOf('connections')).toBeLessThan(tabs.indexOf('catalog'));
        expect(tabs.indexOf('catalog')).toBeLessThan(tabs.indexOf('general'));
        expect(runtime.ctx.catalog.status()).toHaveProperty('via');
        expect((globals[NANOVIA_API_GLOBAL] as { features: string[] }).features).toContain('catalog');
    });

    it('fetches nothing at start; opening the tab loads the catalog (directly when the plugin has no catalog route)', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        await flush();
        expect(catalogRequests()).toEqual([]);
        expect(runtime.ctx.catalog.models()).toEqual([]);

        const changes: number[] = [];
        runtime.ctx.bus.on('catalog:changed', ({ count }) => void changes.push(count));
        runtime.panel.select('catalog');
        await flush();
        await flush();
        await flush();
        expect(runtime.ctx.catalog.models()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(runtime.ctx.catalog.status()).toMatchObject({ loaded: true, via: 'direct', source: 'live' });
        expect(changes).toContain(SAMPLE_MODEL_COUNT);
        expect(document.querySelectorAll('.nanovia-model-row')).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(catalogRequests()).toContain('https://nano-gpt.com/api/v1/models?detailed=true');
    });

    it('stops cleanly', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        await runtime.stop();
        expect(runtime.panel.tabIds()).toEqual([]);
        runtime = null;
    });
});
