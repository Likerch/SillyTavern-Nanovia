// @vitest-environment happy-dom
// The Diagnostics tab and NANOVIA_API.doctor over the whole app (stage 0.6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startNanovia } from '../../src/app/app';
import type { Runtime } from '../../src/app/app';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
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
        if (url === '/version') return new Response(JSON.stringify({ pkgVersion: '1.19.1' }), { status: 200 });
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

describe('the Diagnostics tab in the app', () => {
    it('is a tab just before «General» and a feature of the API', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const tabs = runtime.panel.tabIds();
        expect(tabs.at(-1)).toBe('general');
        expect(tabs.at(-2)).toBe('doctor');
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.features).toContain('doctor');
        expect(typeof api.doctor).toBe('function');
    });

    it('checks the setup when opened: ST’s version is read from /version and the plugin is asked', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        runtime.panel.select('doctor');
        for (let i = 0; i < 6; i++) await flush();
        expect(mock.requests.some((request) => request.url === '/version')).toBe(true);
        const text = document.querySelector('.nanovia-tab-body')?.textContent ?? '';
        expect(text).toContain('SillyTavern 1.19.1');
        expect(text).toContain('Плагин работает');
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.doctor?.().checks.map((item) => item.code)).toContain('st_version_ok');
    });
});
