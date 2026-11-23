// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_KEY } from '../../src/core/settings';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import { createFakeBackend } from '../helpers/fake-backend';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

type Entry = typeof import('../../src/index');

const globals = globalThis as unknown as Record<string, unknown>;

let mock: StMock;
let entry: Entry;

beforeEach(async () => {
    mock = installStMock();
    const backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    backend.plugin.up = false;
    mock.fetchImpl = backend.fetch;
    seedConnectionManager(mock);
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    // A fresh module instance per test: the entry keeps its runtime in module state.
    const { vi } = await import('vitest');
    vi.resetModules();
    entry = await import('../../src/index');
});

afterEach(async () => {
    await entry.onDisable();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

describe('lifecycle hooks', () => {
    it('exports every hook named in manifest.json', async () => {
        const manifest = (await import('../../manifest.json')).default as { hooks: Record<string, string> };
        for (const name of Object.values(manifest.hooks))
            expect(typeof (entry as Record<string, unknown>)[name]).toBe('function');
    });

    it('activate starts once, however often it is called', async () => {
        await Promise.all([entry.onActivate(), entry.onActivate()]);
        await entry.onActivate();
        expect(document.querySelectorAll('#nanovia-settings')).toHaveLength(1);
        expect(globals[NANOVIA_API_GLOBAL]).toBeDefined();
    });

    it('disable removes the drawer and the API, and activate works again', async () => {
        await entry.onActivate();
        await entry.onDisable();
        expect(document.getElementById('nanovia-settings')).toBeNull();
        expect(globals[NANOVIA_API_GLOBAL]).toBeUndefined();
        await entry.onDisable();
        await entry.onActivate();
        expect(document.getElementById('nanovia-settings')).not.toBeNull();
    });

    it('delete behaves like disable; enable, install and update have nothing to do', async () => {
        await entry.onActivate();
        await entry.onDelete();
        expect(document.getElementById('nanovia-settings')).toBeNull();
        await expect(entry.onEnable()).resolves.toBeUndefined();
        await expect(entry.onInstall()).resolves.toBeUndefined();
        await expect(entry.onUpdate()).resolves.toBeUndefined();
    });

    it('clean drops the settings while running', async () => {
        await entry.onActivate();
        expect(mock.extensionSettings[SETTINGS_KEY]).toBeDefined();
        await entry.onClean();
        // Reset puts fresh defaults back after stopping; nothing of the old state is left.
        expect(JSON.stringify(mock.extensionSettings[SETTINGS_KEY])).toContain('"mirror":[]');
        expect(document.getElementById('nanovia-settings')).toBeNull();
    });

    it('clean removes the settings when nothing is running', async () => {
        mock.extensionSettings[SETTINGS_KEY] = { schemaVersion: 1 };
        await entry.onClean();
        expect(mock.extensionSettings[SETTINGS_KEY]).toBeUndefined();
        expect(mock.saveSettingsCalls).toBeGreaterThan(0);
    });
});
