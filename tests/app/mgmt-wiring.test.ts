// @vitest-environment happy-dom
// Stage 0.6 wiring: the Management store reaches the tabs through the context, the tab sits between «Keys» and
// «Account», and NANOVIA_API.mgmt answers from the same store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startNanovia } from '../../src/app/app';
import type { Runtime } from '../../src/app/app';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
import { createFakeBackend } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { flush, memoryLogger } from '../helpers/fakes';
import type { Harness } from '../helpers/harness';
import { createMgmtFake } from '../helpers/mgmt-fake';
import type { MgmtFake } from '../helpers/mgmt-fake';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

const globals = globalThis as unknown as Record<string, unknown>;

let mock: StMock;
let backend: FakeBackend;
let fake: MgmtFake;
let runtime: Runtime | null;

beforeEach(() => {
    mock = installStMock();
    backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    mock.fetchImpl = backend.fetch;
    seedConnectionManager(mock);
    fake = createMgmtFake({ backend, mock, log: memoryLogger() } as unknown as Harness);
    mock.fetchImpl = fake.fetch;
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    runtime = null;
});

afterEach(async () => {
    await runtime?.stop();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

describe('Management in the running app', () => {
    it('adds the tab between Keys and Account, and the feature to the public API', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const tabs = runtime.panel.tabIds();
        expect(tabs).toContain('mgmt');
        expect(tabs.indexOf('keys')).toBeLessThan(tabs.indexOf('mgmt'));
        expect(tabs.indexOf('mgmt')).toBeLessThan(tabs.indexOf('account'));
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.features).toContain('mgmt');
        expect(typeof api.mgmt?.status).toBe('function');
    });

    it('hands the store to the tabs through the context, and the public API reads it', async () => {
        fake.storeToken('sk-nano-mgmt-TESTTOKEN', true);
        runtime = await startNanovia({ skipInitialRefresh: true });
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.mgmt?.status()).toEqual({ present: false, valid: null });
        await runtime.ctx.mgmt.refresh();
        await flush();
        expect(api.mgmt?.status()).toEqual({ present: true, valid: true });
        expect(JSON.stringify(api.mgmt?.status())).not.toContain('TESTTOKEN');
    });

    it('opening the tab draws it and reads the status from the plugin', async () => {
        fake.storeToken('sk-nano-mgmt-TESTTOKEN', true);
        fake.addKey({ name: 'Main' });
        runtime = await startNanovia({ skipInitialRefresh: true });
        runtime.panel.select('mgmt');
        for (let i = 0; i < 4; i++) await flush();
        const body = document.querySelector('#nanovia-settings .nanovia-tab-body');
        // The test ST reports a Russian UI: the tab speaks Russian.
        expect(body?.textContent).toContain('Токен управления');
        expect(body?.textContent).toContain('Main');
    });
});
