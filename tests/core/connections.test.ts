import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configOf, effectiveMode, randomConnectionId } from '../../src/core/connections';
import { createConnection } from '../../src/domain/connection';
import { NANOGPT_API_BASE, PROFILE_NAME_PREFIX, SECRET_KEY_CUSTOM } from '../../src/shared/constants';
import { seedConnection } from '../helpers/fake-backend';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const KEY = 'sk-nano-direct-key-0123456789';

let h: Harness;

beforeEach(() => {
    h = createHarness();
});

afterEach(() => h.restore());

function customRows() {
    return h.backend.secrets.get(SECRET_KEY_CUSTOM) ?? [];
}

function proxyUrl(id: string): string {
    return `http://127.0.0.1:8787/c/${id}/v1`;
}

async function createPluginConnection(
    name = 'Main',
    model = 'deepseek/deepseek-v4',
    mode: 'plugin' | 'auto' = 'plugin',
) {
    const result = await h.connections.save({ patch: { name, modelId: model, mode } });
    if (!result.ok) throw new Error(`save failed: ${result.error.code}`);
    return result.data.id;
}

describe('pure helpers', () => {
    it('auto means the plugin when it answers, otherwise direct', () => {
        expect(effectiveMode('auto', true)).toBe('plugin');
        expect(effectiveMode('auto', false)).toBe('direct');
        expect(effectiveMode('plugin', false)).toBe('plugin');
        expect(effectiveMode('direct', true)).toBe('direct');
    });

    it('makes valid connection ids', () => {
        for (let i = 0; i < 20; i++) expect(randomConnectionId()).toMatch(/^[a-z0-9]{10}$/);
        expect(new Set(Array.from({ length: 50 }, () => randomConnectionId())).size).toBe(50);
    });

    it('configOf drops the wire-only fields', () => {
        const config = createConnection({ name: 'A', modelId: 'm' }, 'abc12345', 1);
        const view = { ...config, proxyUrl: 'p', directUrl: 'd', tokenSecretId: 't' };
        expect(configOf(view)).toEqual(config);
    });
});

describe('refresh', () => {
    it('knows whether the plugin has been asked yet', async () => {
        expect(h.connections.checked()).toBe(false);
        expect(h.connections.pluginUp()).toBe(false);
        h.backend.plugin.up = false;
        await h.connections.refresh();
        expect(h.connections.checked()).toBe(true);
    });

    it('lists what the plugin has and mirrors it', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'deepseek/deepseek-v4' }, 'seed000001');
        await h.connections.refresh();
        expect(h.connections.pluginUp()).toBe(true);
        expect(h.connections.pluginStatus()?.proxy.port).toBe(8787);
        expect(h.connections.pluginError()).toBeNull();
        const [entry] = h.connections.list();
        expect(entry).toMatchObject({
            effectiveMode: 'plugin',
            profileState: 'none',
            hasDirectKey: false,
            pending: false,
            orphan: false,
        });
        expect(entry?.view?.proxyUrl).toBe(proxyUrl('seed000001'));
        expect(h.settings.get().mirror.map((c) => c.id)).toEqual(['seed000001']);
        // Refreshing never creates a profile by itself.
        expect(h.manager.profiles).toHaveLength(0);
    });

    it('falls back to the mirror when the plugin is down, and says why', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'm' }, 'seed000001');
        await h.connections.refresh();
        h.backend.plugin.up = false;
        await h.connections.refresh();
        expect(h.connections.pluginUp()).toBe(false);
        expect(h.connections.pluginStatus()).toBeNull();
        expect(h.connections.pluginError()?.code).toBe('unreachable');
        const [entry] = h.connections.list();
        expect(entry?.config.id).toBe('seed000001');
        // `auto` shows what it would do now: direct.
        expect(entry?.effectiveMode).toBe('direct');
        expect(entry?.orphan).toBe(false);
    });

    it('reports a missing plugin and a failing list', async () => {
        h.backend.plugin.installed = false;
        await h.connections.refresh();
        expect(h.connections.pluginError()?.code).toBe('not_installed');
        h.backend.plugin.installed = true;
        h.backend.plugin.failNext.set('GET /connections', { status: 500, code: 'internal' });
        await h.connections.refresh();
        expect(h.connections.pluginUp()).toBe(false);
        expect(h.connections.pluginError()?.code).toBe('internal');
        await h.connections.refresh();
        expect(h.connections.pluginUp()).toBe(true);
    });

    it('shares one refresh between callers and tells listeners and the bus', async () => {
        const seen = vi.fn();
        const status = vi.fn();
        h.bus.on('connections:changed', seen);
        h.bus.on('plugin:status', status);
        const a = h.connections.refresh();
        const b = h.connections.refresh();
        expect(a).toBe(b);
        await a;
        expect(h.changes).toBe(1);
        expect(seen).toHaveBeenCalledWith({ count: 0 });
        expect(status).toHaveBeenCalledWith(expect.objectContaining({ up: true }));
    });

    it('keeps a connection only the browser has (direct) and flags a plugin-mode one the plugin lost', async () => {
        h.settings.update((s) => {
            s.mirror.push(createConnection({ name: 'Lost', modelId: 'm', mode: 'plugin' }, 'orphan0001', 1));
            s.mirror.push(createConnection({ name: 'Mine', modelId: 'm', mode: 'direct' }, 'direct0001', 1));
        });
        await h.connections.refresh();
        const byId = Object.fromEntries(h.connections.list().map((e) => [e.config.id, e]));
        expect(byId['orphan0001']?.orphan).toBe(true);
        expect(byId['direct0001']?.orphan).toBe(false);
        expect(h.settings.get().mirror).toHaveLength(2);
    });

    it('lets the plugin win over the mirror', async () => {
        seedConnection(h.backend, { name: 'Server name', modelId: 'server/model' }, 'seed000001');
        h.settings.update((s) => {
            s.mirror.push(createConnection({ name: 'Old name', modelId: 'old/model' }, 'seed000001', 1));
        });
        await h.connections.refresh();
        expect(h.connections.get('seed000001')?.config).toMatchObject({ name: 'Server name', modelId: 'server/model' });
        expect(h.settings.get().mirror[0]?.name).toBe('Server name');
    });
});

describe('saving with the plugin up', () => {
    it('creates the connection on the plugin and a Connection Manager profile that points at the proxy', async () => {
        const id = await createPluginConnection();
        expect(h.backend.plugin.connections.has(id)).toBe(true);
        expect(h.manager.profiles).toHaveLength(1);
        const profile = h.manager.profiles[0]!;
        expect(profile).toMatchObject({
            mode: 'cc',
            api: 'custom',
            name: `${PROFILE_NAME_PREFIX}Main`,
            model: 'deepseek/deepseek-v4',
            'api-url': proxyUrl(id),
            'secret-id': h.backend.plugin.tokens.get(id),
        });
        expect(h.settings.get().profiles[id]).toBe(profile.id);
        expect(h.settings.get().mirror.map((c) => c.id)).toEqual([id]);
        const entry = h.connections.get(id);
        expect(entry).toMatchObject({ effectiveMode: 'plugin', profileState: 'linked', profileId: profile.id });
        expect(h.connections.summaries()).toEqual([
            {
                id,
                name: 'Main',
                modelId: 'deepseek/deepseek-v4',
                mode: 'plugin',
                effectiveMode: 'plugin',
                billing: 'auto',
                profileId: profile.id,
            },
        ]);
    });

    it('treats auto as plugin while the plugin answers', async () => {
        const id = await createPluginConnection('Auto', 'm', 'auto');
        expect(h.connections.get(id)?.effectiveMode).toBe('plugin');
        expect(h.manager.profiles[0]?.['api-url']).toBe(proxyUrl(id));
    });

    it('edits through the plugin and keeps the profile in step', async () => {
        const id = await createPluginConnection();
        const result = await h.connections.save({
            id,
            patch: { name: 'Renamed', modelId: 'z-ai/glm-5.3', billing: 'subscription' },
        });
        expect(result.ok).toBe(true);
        expect(h.backend.plugin.connections.get(id)).toMatchObject({ name: 'Renamed', billing: 'subscription' });
        expect(h.manager.profiles).toHaveLength(1);
        expect(h.manager.profiles[0]).toMatchObject({ name: `${PROFILE_NAME_PREFIX}Renamed`, model: 'z-ai/glm-5.3' });
    });

    it("sends only what the form controls, leaving the rest of the plugin's config alone", async () => {
        const id = await createPluginConnection();
        h.backend.plugin.connections.get(id)!.routing.sort = 'price';
        await h.connections.refresh();
        await h.connections.save({ id, patch: { note: 'x' } });
        expect(h.backend.plugin.connections.get(id)?.routing.sort).toBe('price');
    });

    it('refuses an empty name or model', async () => {
        expect(await h.connections.save({ patch: { name: '  ', modelId: 'm' } })).toEqual({
            ok: false,
            error: { code: 'invalid', params: { field: 'name' } },
        });
        expect(await h.connections.save({ patch: { name: 'A', modelId: '' } })).toEqual({
            ok: false,
            error: { code: 'invalid', params: { field: 'modelId' } },
        });
        const id = await createPluginConnection();
        expect(await h.connections.save({ id, patch: { name: '' } })).toMatchObject({ ok: false });
        expect(await h.connections.save({ id: 'nope', patch: {} })).toEqual({
            ok: false,
            error: { code: 'not_found' },
        });
    });

    it("returns the plugin's refusal and changes nothing", async () => {
        h.backend.plugin.failNext.set('POST /connections', { status: 400, code: 'bad_request', message: 'nope' });
        const result = await h.connections.save({ patch: { name: 'A', modelId: 'm', mode: 'plugin' } });
        expect(result).toEqual({
            ok: false,
            error: { code: 'plugin_error', params: { message: 'nope', status: 400 } },
        });
        expect(h.connections.list()).toHaveLength(0);
        expect(h.manager.profiles).toHaveLength(0);
    });

    it('warns, but still saves, when Connection Manager is disabled', async () => {
        h.restore();
        h = createHarness({ connectionManager: false });
        const result = await h.connections.save({ patch: { name: 'A', modelId: 'm', mode: 'plugin' } });
        expect(result).toMatchObject({ ok: true, warnings: [{ code: 'profile_unavailable' }] });
        expect(h.connections.list()[0]?.profileState).toBe('unavailable');
        expect(h.connections.summaries()[0]?.profileId).toBeNull();
    });
});

describe('direct mode', () => {
    it("needs the key once, writes it to ST's secrets and keeps only its id", async () => {
        h.backend.secrets.set(SECRET_KEY_CUSTOM, [{ id: 'mine', value: 'my-own-key', label: 'Mine', active: true }]);
        const refused = await h.connections.save({ patch: { name: 'Direct', modelId: 'm', mode: 'direct' } });
        expect(refused).toEqual({ ok: false, error: { code: 'direct_key_required' } });

        const result = await h.connections.save({
            patch: { name: 'Direct', modelId: 'm', mode: 'direct' },
            directKey: KEY,
        });
        if (!result.ok) throw new Error(result.error.code);
        const id = result.data.id;

        // The plugin never sees a direct connection.
        expect(
            h.backend.pluginCalls().some((call) => call.method === 'POST' && call.path.endsWith('/connections')),
        ).toBe(false);
        expect(h.backend.plugin.connections.size).toBe(0);

        const written = customRows().find((row) => row.value === KEY)!;
        expect(written.label).toBe('Nanovia: Direct (direct)');
        // The user's own Custom key is still the active one.
        expect(
            customRows()
                .filter((row) => row.active)
                .map((row) => row.id),
        ).toEqual(['mine']);
        expect(h.settings.get().directSecrets[id]).toBe(written.id);
        expect(h.manager.profiles[0]).toMatchObject({
            'api-url': NANOGPT_API_BASE,
            'secret-id': written.id,
            model: 'm',
        });
        expect(h.connections.get(id)).toMatchObject({
            effectiveMode: 'direct',
            hasDirectKey: true,
            profileState: 'linked',
        });
        // The key is nowhere in the settings ST will save.
        expect(JSON.stringify(h.mock.extensionSettings)).not.toContain(KEY);
        expect(JSON.stringify(h.log.lines)).not.toContain(KEY);
    });

    it('reports a key ST does not accept and saves nothing', async () => {
        h.backend.csrf = 'other';
        const result = await h.connections.save({
            patch: { name: 'Direct', modelId: 'm', mode: 'direct' },
            directKey: KEY,
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'key_write_failed' } });
        expect(JSON.stringify(result)).not.toContain(KEY);
        expect(h.connections.list()).toHaveLength(0);
    });

    it('replaces the key on file and removes the old secret', async () => {
        const created = await h.connections.save({
            patch: { name: 'D', modelId: 'm', mode: 'direct' },
            directKey: KEY,
        });
        if (!created.ok) throw new Error('save failed');
        const id = created.data.id;
        const first = h.settings.get().directSecrets[id]!;
        await h.connections.save({ id, patch: { note: 'again' }, directKey: 'sk-nano-second-key-9999' });
        const second = h.settings.get().directSecrets[id]!;
        expect(second).not.toBe(first);
        expect(customRows().map((row) => row.id)).toEqual([second]);
        expect(h.manager.profiles[0]?.['secret-id']).toBe(second);
    });

    it('keeps a typed key out of the rollback when the plugin refuses the change', async () => {
        const id = await createPluginConnection('Main', 'm', 'auto');
        const before = customRows().length;
        h.backend.plugin.failNext.set(`PUT /connections/${id}`, { status: 400, code: 'bad_request', message: 'nope' });
        const result = await h.connections.save({ id, patch: { mode: 'direct' }, directKey: KEY });
        expect(result).toMatchObject({ ok: false, error: { code: 'plugin_error' } });
        // The key written for the attempt is removed again.
        expect(customRows()).toHaveLength(before);
        expect(customRows().some((row) => row.value === KEY)).toBe(false);
        expect(h.settings.get().directSecrets[id]).toBeUndefined();
        expect(h.connections.get(id)?.config.mode).toBe('auto');
    });
});

describe('the plugin is down', () => {
    it('refuses plugin mode and explains', async () => {
        h.backend.plugin.up = false;
        const result = await h.connections.save({ patch: { name: 'A', modelId: 'm', mode: 'plugin' } });
        expect(result).toEqual({ ok: false, error: { code: 'plugin_down' } });
        expect(h.connections.list()).toHaveLength(0);
    });

    it('saves an auto connection locally with a key, then sends it when the plugin is back and repoints the profile', async () => {
        h.backend.plugin.up = false;
        const refused = await h.connections.save({ patch: { name: 'A', modelId: 'm', mode: 'auto' } });
        expect(refused).toEqual({ ok: false, error: { code: 'direct_key_required' } });
        const result = await h.connections.save({ patch: { name: 'A', modelId: 'm', mode: 'auto' }, directKey: KEY });
        if (!result.ok) throw new Error(result.error.code);
        expect(result.warnings).toEqual([{ code: 'saved_locally' }]);
        const id = result.data.id;
        expect(id).toBe('loc00001');
        expect(h.settings.get().pending).toEqual([id]);
        expect(h.connections.get(id)).toMatchObject({ effectiveMode: 'direct', pending: true });
        expect(h.manager.profiles[0]?.['api-url']).toBe(NANOGPT_API_BASE);

        h.backend.plugin.up = true;
        await h.connections.refresh();
        expect(h.backend.plugin.connections.has(id)).toBe(true);
        expect(h.settings.get().pending).toEqual([]);
        expect(h.connections.get(id)?.pending).toBe(false);
        // `auto` follows the plugin again: the profile now carries the proxy URL and the proxy token.
        expect(h.manager.profiles).toHaveLength(1);
        expect(h.manager.profiles[0]).toMatchObject({
            'api-url': proxyUrl(id),
            'secret-id': h.backend.plugin.tokens.get(id),
        });
    });

    it('keeps an edit made while the plugin was down and sends it later', async () => {
        const id = await createPluginConnection('Main', 'm', 'auto');
        h.backend.plugin.up = false;
        const result = await h.connections.save({ id, patch: { note: 'edited offline' } });
        // The connection keeps the profile it has; nothing about it is worth a warning.
        expect(result).toMatchObject({ ok: true, warnings: [{ code: 'saved_locally' }] });
        expect(h.settings.get().pending).toEqual([id]);
        expect(h.connections.get(id)?.config.note).toBe('edited offline');

        h.backend.plugin.up = true;
        await h.connections.refresh();
        expect(h.backend.plugin.connections.get(id)?.note).toBe('edited offline');
        expect(h.settings.get().pending).toEqual([]);
    });

    it('warns that no profile could be written for a connection that has none', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'm' }, 'seed000001');
        await h.connections.refresh();
        h.backend.plugin.up = false;
        const result = await h.connections.save({ id: 'seed000001', patch: { note: 'x' } });
        expect(result).toMatchObject({
            ok: true,
            warnings: [{ code: 'saved_locally' }, { code: 'profile_needs_key' }],
        });
    });

    it('keeps an offline edit pending when the plugin refuses it, instead of losing it', async () => {
        const id = await createPluginConnection('Main', 'm', 'auto');
        h.backend.plugin.up = false;
        await h.connections.save({ id, patch: { note: 'edited offline' } });
        h.backend.plugin.up = true;
        h.backend.plugin.failNext.set(`PUT /connections/${id}`, { status: 500, code: 'internal' });
        await h.connections.refresh();
        expect(h.settings.get().pending).toEqual([id]);
        expect(h.connections.get(id)?.config.note).toBe('edited offline');
        expect(h.settings.get().mirror[0]?.note).toBe('edited offline');
        await h.connections.refresh();
        expect(h.settings.get().pending).toEqual([]);
        expect(h.backend.plugin.connections.get(id)?.note).toBe('edited offline');
    });

    it('switches a connection to direct mode on request: asks for the key, writes a direct profile, tells the plugin later', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'm' }, 'seed000001');
        await h.connections.refresh();
        h.backend.plugin.up = false;

        expect(await h.connections.switchToDirect('seed000001')).toEqual({
            ok: false,
            error: { code: 'direct_key_required' },
        });
        const switched = await h.connections.switchToDirect('seed000001', KEY);
        expect(switched.ok).toBe(true);
        const entry = h.connections.get('seed000001');
        expect(entry).toMatchObject({ effectiveMode: 'direct', hasDirectKey: true, pending: true });
        expect(entry?.config.mode).toBe('direct');
        expect(h.manager.profiles[0]).toMatchObject({
            'api-url': NANOGPT_API_BASE,
            'secret-id': h.settings.get().directSecrets['seed000001'],
        });

        // Back up: the choice is sent, not overwritten by the plugin's old `auto`, and the profile stays direct.
        h.backend.plugin.up = true;
        await h.connections.refresh();
        expect(h.backend.plugin.connections.get('seed000001')?.mode).toBe('direct');
        expect(h.connections.get('seed000001')?.config.mode).toBe('direct');
        expect(h.manager.profiles[0]?.['api-url']).toBe(NANOGPT_API_BASE);

        // With the key on file a second switch needs no key.
        h.backend.plugin.up = false;
        const again = await h.connections.switchToDirect('seed000001');
        expect(again.ok).toBe(true);
    });

    it('does not repoint profiles on its own when the plugin dies', async () => {
        const id = await createPluginConnection('Main', 'm', 'auto');
        const before = structuredClone(h.manager.profiles);
        h.backend.plugin.up = false;
        await h.connections.refresh();
        expect(h.manager.profiles).toEqual(before);
        expect(h.manager.profiles[0]?.['api-url']).toBe(proxyUrl(id));
    });

    it('does not warn about the profile when an edit cannot rewrite the one it has', async () => {
        const id = await createPluginConnection('Main', 'm', 'auto');
        h.backend.plugin.up = false;
        const result = await h.connections.save({ id, patch: { note: 'x' } });
        expect(result).toMatchObject({ ok: true, warnings: [{ code: 'saved_locally' }] });
    });

    it('lets name and model follow an offline edit but never repoints an auto profile on its own', async () => {
        const id = await createPluginConnection('Main', 'm', 'auto');
        // A key on file would let an auto connection fall back to direct mode; it must not do so silently.
        await h.connections.save({ id, patch: {}, directKey: KEY });
        expect(h.manager.profiles[0]?.['api-url']).toBe(proxyUrl(id));
        h.backend.plugin.up = false;
        const result = await h.connections.save({ id, patch: { name: 'Renamed', modelId: 'new/model' } });
        expect(result.ok).toBe(true);
        expect(h.manager.profiles[0]).toMatchObject({
            name: `${PROFILE_NAME_PREFIX}Renamed`,
            model: 'new/model',
            'api-url': proxyUrl(id),
            'secret-id': h.backend.plugin.tokens.get(id),
        });
    });

    it('ignores a key typed for a connection that goes through the plugin', async () => {
        const result = await h.connections.save({
            patch: { name: 'Main', modelId: 'm', mode: 'plugin' },
            directKey: KEY,
        });
        expect(result.ok).toBe(true);
        expect(customRows().some((row) => row.value === KEY)).toBe(false);
        if (result.ok) expect(h.settings.get().directSecrets[result.data.id]).toBeUndefined();
    });
});

describe('profiles', () => {
    it('repairs a profile that drifted, never recreates a deleted one, and recreates it on request', async () => {
        const id = await createPluginConnection();
        h.manager.profiles[0]!.model = 'hacked';
        h.manager.profiles[0]!.name = 'Renamed by hand';
        expect(h.connections.get(id)?.profileState).toBe('drifted');
        await h.connections.refresh();
        expect(h.manager.profiles[0]).toMatchObject({
            model: 'deepseek/deepseek-v4',
            name: `${PROFILE_NAME_PREFIX}Main`,
        });
        expect(h.connections.get(id)?.profileState).toBe('linked');

        h.manager.profiles.length = 0;
        await h.connections.refresh();
        expect(h.manager.profiles).toHaveLength(0);
        expect(h.connections.get(id)?.profileState).toBe('missing');
        expect(h.connections.get(id)?.profileId).toBeNull();

        const repaired = await h.connections.repairProfile(id);
        expect(repaired.ok).toBe(true);
        expect(h.manager.profiles).toHaveLength(1);
        expect(h.connections.get(id)?.profileState).toBe('linked');
        expect(h.settings.get().profiles[id]).toBe(h.manager.profiles[0]?.id);
    });

    it('creates the profile of a connection that has none', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'm' }, 'seed000001');
        await h.connections.refresh();
        expect(h.connections.get('seed000001')?.profileState).toBe('none');
        expect((await h.connections.repairProfile('seed000001')).ok).toBe(true);
        expect(h.manager.profiles[0]?.['api-url']).toBe(proxyUrl('seed000001'));
        expect(await h.connections.repairProfile('missing')).toEqual({ ok: false, error: { code: 'not_found' } });
    });

    it('refuses to write a profile without a token or a key', async () => {
        seedConnection(h.backend, { name: 'No token', modelId: 'm' }, 'notoken001');
        h.backend.plugin.tokens.delete('notoken001');
        await h.connections.refresh();
        expect(h.connections.get('notoken001')?.profileState).toBe('blocked');
        expect(await h.connections.repairProfile('notoken001')).toEqual({
            ok: false,
            error: { code: 'profile_needs_token' },
        });
        expect(h.manager.profiles).toHaveLength(0);
    });
});

describe('rotating, sending, removing', () => {
    it('rotates the token and moves the profile to the new one', async () => {
        const id = await createPluginConnection();
        const old = h.backend.plugin.tokens.get(id);
        const result = await h.connections.rotateToken(id);
        expect(result.ok).toBe(true);
        const fresh = h.backend.plugin.tokens.get(id);
        expect(fresh).not.toBe(old);
        expect(h.manager.profiles[0]?.['secret-id']).toBe(fresh);
        expect(h.connections.get(id)?.view?.tokenSecretId).toBe(fresh);
    });

    it('cannot rotate what the plugin does not have, or while it is down', async () => {
        const direct = await h.connections.save({ patch: { name: 'D', modelId: 'm', mode: 'direct' }, directKey: KEY });
        if (!direct.ok) throw new Error('save failed');
        expect(await h.connections.rotateToken(direct.data.id)).toEqual({
            ok: false,
            error: { code: 'not_on_plugin' },
        });
        expect(await h.connections.rotateToken('nope')).toEqual({ ok: false, error: { code: 'not_found' } });
        const id = await createPluginConnection();
        h.backend.plugin.up = false;
        expect(await h.connections.rotateToken(id)).toEqual({ ok: false, error: { code: 'plugin_down' } });
    });

    it('sends a connection the plugin lost back to it', async () => {
        h.settings.update((s) => {
            s.mirror.push(createConnection({ name: 'Lost', modelId: 'm', mode: 'plugin' }, 'orphan0001', 1));
        });
        await h.connections.refresh();
        expect(h.connections.get('orphan0001')?.orphan).toBe(true);
        expect((await h.connections.sendToPlugin('orphan0001')).ok).toBe(true);
        expect(h.backend.plugin.connections.has('orphan0001')).toBe(true);
        expect(h.connections.get('orphan0001')).toMatchObject({ orphan: false, profileState: 'linked' });
    });

    it('follows the id the plugin gives when it ignores ours', async () => {
        h.backend.plugin.ignoreIds = true;
        h.settings.update((s) => {
            s.mirror.push(createConnection({ name: 'Lost', modelId: 'm', mode: 'plugin' }, 'orphan0001', 1));
        });
        await h.connections.refresh();
        expect((await h.connections.sendToPlugin('orphan0001')).ok).toBe(true);
        const list = h.connections.list();
        expect(list).toHaveLength(1);
        const newId = list[0]!.config.id;
        expect(newId).not.toBe('orphan0001');
        expect(h.backend.plugin.connections.has(newId)).toBe(true);
        expect(h.settings.get().mirror.map((c) => c.id)).toEqual([newId]);
        expect(h.settings.get().profiles[newId]).toBeTruthy();
        expect(h.settings.get().profiles['orphan0001']).toBeUndefined();
    });

    it('removes a plugin connection together with its profile', async () => {
        const id = await createPluginConnection();
        h.manager.selectedProfile = h.manager.profiles[0]!.id;
        const result = await h.connections.remove(id);
        expect(result).toMatchObject({ ok: true });
        expect(h.backend.plugin.connections.has(id)).toBe(false);
        expect(h.manager.profiles).toHaveLength(0);
        expect(h.manager.selectedProfile).toBeNull();
        expect(h.settings.get().mirror).toHaveLength(0);
        expect(h.settings.get().profiles[id]).toBeUndefined();
        expect(h.connections.list()).toHaveLength(0);
    });

    it('removes a direct connection with its profile and its stored key', async () => {
        const created = await h.connections.save({
            patch: { name: 'D', modelId: 'm', mode: 'direct' },
            directKey: KEY,
        });
        if (!created.ok) throw new Error('save failed');
        const id = created.data.id;
        expect(customRows().some((row) => row.value === KEY)).toBe(true);
        h.backend.plugin.up = false;
        expect((await h.connections.remove(id)).ok).toBe(true);
        expect(customRows().some((row) => row.value === KEY)).toBe(false);
        expect(h.manager.profiles).toHaveLength(0);
        expect(h.settings.get().directSecrets[id]).toBeUndefined();
    });

    it('will not remove a plugin connection while the plugin is down (it would come back)', async () => {
        const id = await createPluginConnection();
        h.backend.plugin.up = false;
        expect(await h.connections.remove(id)).toEqual({ ok: false, error: { code: 'plugin_down' } });
        expect(h.connections.get(id)).not.toBeNull();
        expect(h.manager.profiles).toHaveLength(1);
        expect(await h.connections.remove('nope')).toEqual({ ok: false, error: { code: 'not_found' } });
    });

    it('treats "the plugin does not have it" as already deleted', async () => {
        const id = await createPluginConnection();
        h.backend.plugin.connections.delete(id);
        expect((await h.connections.remove(id)).ok).toBe(true);
        expect(h.connections.list()).toHaveLength(0);
    });
});

describe('operations do not interleave', () => {
    it('runs saves one after another', async () => {
        const [a, b] = await Promise.all([
            h.connections.save({ patch: { name: 'First', modelId: 'm', mode: 'plugin' } }),
            h.connections.save({ patch: { name: 'Second', modelId: 'm', mode: 'plugin' } }),
        ]);
        expect(a.ok && b.ok).toBe(true);
        expect(h.manager.profiles.map((p) => p.name).sort()).toEqual([
            `${PROFILE_NAME_PREFIX}First`,
            `${PROFILE_NAME_PREFIX}Second`,
        ]);
        expect(h.connections.list().map((e) => e.config.name)).toEqual(['First', 'Second']);
    });
});
