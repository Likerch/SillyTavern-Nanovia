// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MGMT_RETRY_MS, MGMT_TTL_MS, createMgmtStore } from '../../src/core/mgmt';
import type { MgmtStore } from '../../src/core/mgmt';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { createMgmtFake } from '../helpers/mgmt-fake';
import type { MgmtFake } from '../helpers/mgmt-fake';

const TOKEN = 'sk-nano-mgmt-TESTTOKEN';

let h: Harness;
let fake: MgmtFake;
let store: MgmtStore;
let clock: number;

beforeEach(() => {
    h = createHarness();
    fake = createMgmtFake(h);
    clock = 1_900_000_000_000;
    store = createMgmtStore({ mgmt: fake.mgmt, connections: h.connections, log: h.log, now: () => clock });
});

afterEach(() => h.restore());

async function settle(): Promise<void> {
    await flush();
    await flush();
}

describe('states', () => {
    it('is idle until something was asked', () => {
        expect(store.detail()).toMatchObject({ state: 'idle', status: null, error: null });
        expect(store.detail().keys).toMatchObject({ items: null, loading: false, error: null });
        expect(store.brief()).toEqual({ present: false, valid: null });
    });

    it('no token: reads the status and asks NanoGPT for nothing', async () => {
        const detail = await store.refresh();
        expect(detail.state).toBe('no_token');
        expect(fake.calls.map((call) => call.path)).toEqual(['/mgmt/status']);
        expect(store.brief()).toEqual({ present: false, valid: null });
    });

    it('ready: reads the status, then both lists', async () => {
        fake.storeToken(TOKEN, true);
        fake.addKey({ name: 'Main' });
        fake.addPreset({ name: 'rp' });
        const detail = await store.refresh();
        expect(detail.state).toBe('ready');
        expect(detail.keys.items?.map((key) => key.name)).toEqual(['Main']);
        expect(detail.presets.items?.map((preset) => preset.name)).toEqual(['rp']);
        expect(detail.keys.fetchedAt).not.toBeNull();
        expect(store.brief()).toEqual({ present: true, valid: true });
    });

    it('a token that was never verified is ready, and the first success turns it to valid', async () => {
        fake.storeToken(TOKEN, null);
        const detail = await store.refresh();
        await settle();
        expect(detail.state).toBe('ready');
        expect(store.detail().status?.valid).toBe(true);
        expect(store.brief()).toEqual({ present: true, valid: true });
    });

    it('token_invalid: no list is asked for', async () => {
        fake.storeToken(TOKEN, false);
        const detail = await store.refresh();
        expect(detail.state).toBe('token_invalid');
        expect(fake.calls.map((call) => call.path)).toEqual(['/mgmt/status']);
        expect(detail.keys.items).toBeNull();
    });

    it('needs_plugin when the plugin is not installed, plugin_outdated when it answers but lacks the routes', async () => {
        h.backend.plugin.installed = false;
        await h.connections.refresh();
        expect((await store.refresh({ force: true })).state).toBe('needs_plugin');
        expect(store.detail().error?.kind).toBe('not_installed');

        // The plugin answers /status (so the connections service knows it is up) but not the Management routes.
        h.backend.plugin.installed = true;
        fake.hasRoutes = false;
        await h.connections.refresh();
        expect(h.connections.pluginUp()).toBe(true);
        expect((await store.refresh({ force: true })).state).toBe('plugin_outdated');

        fake.hasRoutes = true;
        fake.storeToken();
        expect((await store.refresh({ force: true })).state).toBe('ready');
    });

    it('plugin_down when nothing answers, and recovers on the next refresh', async () => {
        h.backend.plugin.up = false;
        expect((await store.refresh({ force: true })).state).toBe('plugin_down');
        h.backend.plugin.up = true;
        fake.storeToken();
        expect((await store.refresh({ force: true })).state).toBe('ready');
        expect(store.detail().error).toBeNull();
    });

    it('error for trouble that is neither the plugin nor the token', async () => {
        fake.fail.set('GET /mgmt/status', { status: 500, code: 'internal', message: 'disk full' });
        const detail = await store.refresh();
        expect(detail.state).toBe('error');
        expect(detail.error).toMatchObject({ kind: 'other', message: 'disk full' });
    });
});

describe('the lists', () => {
    it('a missing scope fails one list and not the other', async () => {
        fake.storeToken();
        fake.scopes = new Set(['model_presets:write']);
        fake.addPreset({ name: 'rp' });
        const detail = await store.refresh();
        expect(detail.state).toBe('ready');
        expect(detail.keys.error).toMatchObject({ kind: 'scope_missing', scope: 'api_keys:read' });
        expect(detail.keys.items).toBeNull();
        expect(detail.presets.error).toBeNull();
        expect(detail.presets.items).toHaveLength(1);
    });

    it('a failed reload keeps the last good list and says it is stale', async () => {
        fake.storeToken();
        fake.addKey({ name: 'Main' });
        await store.refresh();
        fake.upstream = 'down';
        await store.refreshKeys();
        const keys = store.detail().keys;
        expect(keys.items?.map((key) => key.name)).toEqual(['Main']);
        expect(keys.error?.kind).toBe('upstream');
    });

    it('a rate limit is an error of the list', async () => {
        fake.storeToken();
        fake.upstream = 'rate_limited';
        await store.refresh();
        expect(store.detail().keys.error?.kind).toBe('rate_limited');
        expect(store.detail().state).toBe('ready');
    });

    it('a 401 in the middle of a session turns the state to token_invalid', async () => {
        fake.storeToken();
        await store.refresh();
        fake.upstream = 'rejects';
        await store.refreshKeys();
        await settle();
        expect(store.detail().state).toBe('token_invalid');
        expect(store.brief()).toEqual({ present: true, valid: false });
    });

    it('drops the answer of a load that a newer load replaced', async () => {
        fake.storeToken();
        fake.addKey({ name: 'First' });
        const slow = store.refreshKeys();
        fake.keys[0]!.name = 'Second';
        const fast = store.refreshKeys();
        await Promise.all([slow, fast]);
        expect(store.detail().keys.items?.map((key) => key.name)).toEqual(['Second']);
        expect(store.detail().keys.loading).toBe(false);
    });
});

describe('caching', () => {
    it('serves a second refresh from the cache, a forced one asks again, and the cache expires', async () => {
        fake.storeToken();
        await store.refresh();
        await settle();
        const calls = fake.calls.length;
        await store.refresh();
        expect(fake.calls.length).toBe(calls);
        await store.refresh({ force: true });
        expect(fake.calls.length).toBeGreaterThan(calls);

        const before = fake.calls.length;
        clock += MGMT_TTL_MS + 1;
        await store.refresh();
        expect(fake.calls.length).toBeGreaterThan(before);
    });

    it('waits before asking again after a failed attempt, unless forced', async () => {
        h.backend.plugin.up = false;
        await store.refresh();
        const calls = fake.calls.length;
        h.backend.plugin.up = true;
        fake.storeToken();
        await store.refresh();
        expect(fake.calls.length).toBe(calls);
        clock += MGMT_RETRY_MS + 1;
        expect((await store.refresh()).state).toBe('ready');
    });

    it('shares one refresh among simultaneous callers', async () => {
        fake.storeToken();
        await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
        await settle();
        expect(fake.callsTo('GET /mgmt/keys')).toHaveLength(1);
    });
});

describe('the token', () => {
    it('saves a token, keeps only the status, and reads the lists in the background', async () => {
        fake.addKey({ name: 'Main' });
        await store.refresh();
        expect(store.detail().state).toBe('no_token');

        const result = await store.saveToken(TOKEN);
        expect(result).toMatchObject({ ok: true, data: { present: true, valid: true } });
        await settle();
        const detail = store.detail();
        expect(detail.state).toBe('ready');
        expect(detail.keys.items?.map((key) => key.name)).toEqual(['Main']);
        expect(JSON.stringify(detail)).not.toContain('TESTTOKEN');
        expect(JSON.stringify(store.brief())).not.toContain('TESTTOKEN');
    });

    it('does not keep a refused token and leaves the state alone', async () => {
        fake.storeToken('sk-nano-mgmt-OLDONE000', true);
        await store.refresh();
        fake.upstream = 'rejects';
        const result = await store.saveToken(TOKEN);
        expect(result).toMatchObject({ ok: false, error: { kind: 'token_invalid' } });
        expect(fake.token).toBe('sk-nano-mgmt-OLDONE000');
        // NanoGPT refusing the new token says nothing about the stored one.
        fake.upstream = 'ok';
        await settle();
        expect(store.detail().state).toBe('ready');
    });

    it('stores an unconfirmed token only when forced', async () => {
        fake.upstream = 'down';
        expect((await store.saveToken(TOKEN)).ok).toBe(false);
        expect(fake.token).toBeNull();
        const forced = await store.saveToken(TOKEN, { force: true });
        expect(forced).toMatchObject({ ok: true, data: { present: true, valid: null } });
        expect(store.brief()).toEqual({ present: true, valid: null });
    });

    it('a new token replaces the lists of the old one', async () => {
        fake.storeToken(TOKEN, true);
        fake.addKey({ name: 'Main' });
        await store.refresh();
        expect(store.detail().keys.items).toHaveLength(1);
        fake.keys.length = 0;
        await store.saveToken('sk-nano-mgmt-SECONDTOKEN');
        await settle();
        expect(store.detail().keys.items).toEqual([]);
    });

    it('deleting the token clears the lists', async () => {
        fake.storeToken();
        fake.addKey();
        await store.refresh();
        expect(await store.deleteToken()).toEqual({ ok: true, data: true });
        const detail = store.detail();
        expect(detail.state).toBe('no_token');
        expect(detail.keys.items).toBeNull();
        expect(detail.presets.items).toBeNull();
        expect(fake.token).toBeNull();
    });

    it('verify asks NanoGPT and shows the verdict', async () => {
        fake.storeToken(TOKEN, true);
        await store.refresh();
        fake.upstream = 'rejects';
        await store.refreshStatus({ verify: true });
        expect(store.detail().state).toBe('token_invalid');
        expect(fake.calls.some((call) => call.path === '/mgmt/status?verify=1')).toBe(true);
    });
});

describe('keys: write, then reload', () => {
    beforeEach(async () => {
        fake.storeToken();
        await store.refresh();
        await settle();
    });

    it('create reloads the list and returns the secret id', async () => {
        const result = await store.createKey({ name: 'New', limits: { usd: { daily: 2 } } });
        expect(result).toMatchObject({ ok: true, data: { key: { name: 'New' }, secretId: fake.createdSecretIds[0] } });
        expect(store.detail().keys.items?.map((key) => key.name)).toEqual(['New']);
    });

    it('update and revoke reload the list', async () => {
        const key = fake.addKey({ name: 'Old' });
        await store.refreshKeys();
        await store.updateKey(key.id, { name: 'Renamed' });
        expect(store.detail().keys.items?.[0]?.name).toBe('Renamed');
        await store.revokeKey(key.id);
        expect(store.detail().keys.items).toEqual([]);
    });

    it('a refused write is returned, the list is not reloaded, and the form can try again', async () => {
        const key = fake.addKey();
        await store.refreshKeys();
        const before = fake.callsTo('GET /mgmt/keys').length;
        const result = await store.updateKey(key.id, { limits: { usd: { daily: -5 } } });
        expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
        expect(fake.callsTo('GET /mgmt/keys').length).toBe(before);
    });

    it('a key made but not stored is listed so it can be revoked', async () => {
        fake.fail.set('POST /mgmt/keys', { status: 500, code: 'secrets_failed' });
        fake.addKey({ name: 'Orphan' });
        const result = await store.createKey({ name: 'Orphan' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'secrets_failed' } });
        expect(store.detail().keys.items?.map((key) => key.name)).toEqual(['Orphan']);
    });

    it('revoking a key that is already gone still refreshes the list', async () => {
        const key = fake.addKey({ name: 'Gone' });
        await store.refreshKeys();
        fake.keys.length = 0;
        const result = await store.revokeKey(key.id);
        expect(result).toMatchObject({ ok: false, error: { kind: 'not_found' } });
        expect(store.detail().keys.items).toEqual([]);
    });

    it('a rejected token found by a write turns the state to token_invalid', async () => {
        const key = fake.addKey();
        await store.refreshKeys();
        fake.upstream = 'rejects';
        await store.updateKey(key.id, { name: 'x' });
        await settle();
        expect(store.detail().state).toBe('token_invalid');
    });
});

describe('presets: write, then reload', () => {
    beforeEach(async () => {
        fake.storeToken();
        await store.refresh();
        await settle();
    });

    it('create, replace and delete reload the list', async () => {
        await store.createPreset({ name: 'rp', model: 'm/a' });
        expect(store.detail().presets.items?.map((preset) => preset.name)).toEqual(['rp']);
        await store.replacePreset('rp', { model: 'm/b', temperature: 0.5 });
        expect(store.detail().presets.items?.[0]).toMatchObject({ model: 'm/b', temperature: 0.5 });
        await store.deletePreset('rp');
        expect(store.detail().presets.items).toEqual([]);
    });

    it('a taken name is refused and the list is untouched', async () => {
        fake.addPreset({ name: 'rp' });
        await store.refreshPresets();
        const result = await store.createPreset({ name: 'rp', model: 'm/a' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'preset_exists' } });
        expect(store.detail().presets.items).toHaveLength(1);
    });

    it('a write that finds the plugin gone turns the state to plugin_down', async () => {
        h.backend.plugin.up = false;
        const result = await store.createPreset({ name: 'rp', model: 'm/a' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'plugin_down' } });
        expect(store.detail().state).toBe('plugin_down');
    });
});

describe('subscriptions and warm()', () => {
    it('onChange fires for loads and can be removed', async () => {
        let count = 0;
        const off = store.onChange(() => void count++);
        fake.storeToken();
        await store.refresh();
        expect(count).toBeGreaterThan(0);
        off();
        const seen = count;
        await store.refresh({ force: true });
        expect(count).toBe(seen);
    });

    it('a listener that throws does not break the others', async () => {
        let reached = false;
        store.onChange(() => {
            throw new Error('boom');
        });
        store.onChange(() => void (reached = true));
        await store.refresh();
        expect(reached).toBe(true);
        expect(h.log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('warm() reads the status once when nothing is known, and not again soon', async () => {
        fake.storeToken();
        store.warm();
        store.warm();
        await settle();
        expect(fake.callsTo('GET /mgmt/status')).toHaveLength(1);
        expect(store.brief()).toEqual({ present: true, valid: true });
        store.warm();
        await settle();
        expect(fake.callsTo('GET /mgmt/status')).toHaveLength(1);
    });

    it('warm() does not stop the first refresh of the tab', async () => {
        h.backend.plugin.up = false;
        store.warm();
        await settle();
        h.backend.plugin.up = true;
        fake.storeToken();
        expect((await store.refresh()).state).toBe('ready');
    });
});
