// @vitest-environment happy-dom
// Smoke test of the committed bundle (dist/index.js): what ST actually loads must start, mount and stop cleanly.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
import { createFakeBackend } from '../helpers/fake-backend';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

interface Hooks {
    onActivate(): Promise<void>;
    onDisable(): Promise<void>;
}

const globals = globalThis as unknown as Record<string, unknown>;
let mock: StMock;
let hooks: Hooks;

beforeEach(async () => {
    mock = installStMock();
    const backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    mock.fetchImpl = backend.fetch;
    seedConnectionManager(mock);
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    const path = '../../dist/index.js';
    hooks = (await import(/* @vite-ignore */ path)) as Hooks;
});

afterEach(async () => {
    await hooks.onDisable();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

describe('dist/index.js', () => {
    it('activates, mounts the drawer, publishes NANOVIA_API and disables again', async () => {
        await hooks.onActivate();
        expect(document.querySelector('#extensions_settings2 #nanovia-settings')).not.toBeNull();
        expect(document.querySelectorAll('.nanovia-tab').length).toBeGreaterThanOrEqual(2);
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.version).toBe(1);
        expect(api.features).toContain('connections');
        await hooks.onDisable();
        expect(document.getElementById('nanovia-settings')).toBeNull();
        expect(globals[NANOVIA_API_GLOBAL]).toBeUndefined();
    });
});
