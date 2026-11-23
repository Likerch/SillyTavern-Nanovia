// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHostEvents } from '../../src/host/events';
import { createProfilesHost, profileDrift, profileName } from '../../src/host/profiles';
import type { ProfileSpec, ProfilesHost } from '../../src/host/profiles';
import { PROFILE_NAME_PREFIX } from '../../src/shared/constants';
import { memoryLogger } from '../helpers/fakes';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;
let profiles: ProfilesHost;

const PROXY = 'http://127.0.0.1:8787/c/abc12345/v1';

function spec(overrides: Partial<ProfileSpec> = {}): ProfileSpec {
    return {
        name: profileName('Main'),
        model: 'deepseek/deepseek-v4',
        apiUrl: PROXY,
        secretId: 'token-secret-1',
        ...overrides,
    };
}

beforeEach(() => {
    mock = installStMock();
    const log = memoryLogger();
    profiles = createProfilesHost({
        ctx: () => mock.context,
        events: createHostEvents(() => mock.context, log),
        log,
    });
});

afterEach(() => {
    mock.restore();
    document.body.innerHTML = '';
});

describe('creating', () => {
    it('writes the profile Connection Manager needs and saves settings', async () => {
        const manager = seedConnectionManager(mock);
        const result = await profiles.upsert(null, spec());
        expect(result).toMatchObject({ ok: true, created: true, changed: true });
        expect(manager.profiles).toHaveLength(1);
        expect(manager.profiles[0]).toEqual({
            id: result.ok ? result.profileId : '',
            mode: 'cc',
            name: `${PROFILE_NAME_PREFIX}Main`,
            api: 'custom',
            model: 'deepseek/deepseek-v4',
            'api-url': PROXY,
            'secret-id': 'token-secret-1',
            exclude: [],
        });
        expect(mock.saveSettingsCalls).toBe(1);
    });

    it("creates Connection Manager's settings when it has not initialised yet", async () => {
        const result = await profiles.upsert(null, spec());
        expect(result.ok).toBe(true);
        const manager = mock.extensionSettings['connectionManager'] as {
            profiles: unknown[];
            selectedProfile: unknown;
        };
        expect(manager.profiles).toHaveLength(1);
        expect(manager.selectedProfile).toBeNull();
    });

    it('refuses a profile without a secret, a URL or a model: it would send another key to this URL', async () => {
        seedConnectionManager(mock);
        expect(await profiles.upsert(null, spec({ secretId: '' }))).toEqual({ ok: false, reason: 'invalid' });
        expect(await profiles.upsert(null, spec({ apiUrl: '' }))).toEqual({ ok: false, reason: 'invalid' });
        expect(await profiles.upsert(null, spec({ model: '  ' }))).toEqual({ ok: false, reason: 'invalid' });
        expect(profiles.list()).toHaveLength(0);
    });

    it('says so when Connection Manager is disabled, and leaves settings alone', async () => {
        mock.extensionSettings['disabledExtensions'] = ['connection-manager'];
        expect(profiles.available()).toBe(false);
        expect(await profiles.upsert(null, spec())).toEqual({ ok: false, reason: 'unavailable' });
        expect(mock.extensionSettings['connectionManager']).toBeUndefined();
        expect(mock.saveSettingsCalls).toBe(0);
    });

    it('makes the name unique among the other profiles', async () => {
        seedConnectionManager(mock, [{ id: 'other', name: `${PROFILE_NAME_PREFIX}Main` }]);
        const first = await profiles.upsert(null, spec());
        const second = await profiles.upsert(null, spec({ apiUrl: 'http://127.0.0.1:8787/c/zzz99999/v1' }));
        const names = profiles.list().map((p) => p.name);
        expect(names).toEqual([
            `${PROFILE_NAME_PREFIX}Main`,
            `${PROFILE_NAME_PREFIX}Main (2)`,
            `${PROFILE_NAME_PREFIX}Main (3)`,
        ]);
        expect(first.ok && second.ok).toBe(true);
    });
});

describe('updating', () => {
    it("updates only what Nanovia manages and keeps the user's own fields", async () => {
        const manager = seedConnectionManager(mock);
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        manager.profiles[0]!.preset = 'My preset';
        manager.profiles[0]!['prompt-post-processing'] = 'strict';
        mock.saveSettingsCalls = 0;

        const result = await profiles.upsert(
            created.profileId,
            spec({ model: 'z-ai/glm-5.3', secretId: 'token-secret-2' }),
        );
        expect(result).toMatchObject({ ok: true, created: false, changed: true, profileId: created.profileId });
        expect(manager.profiles).toHaveLength(1);
        expect(manager.profiles[0]).toMatchObject({
            model: 'z-ai/glm-5.3',
            'secret-id': 'token-secret-2',
            preset: 'My preset',
            'prompt-post-processing': 'strict',
        });
        expect(mock.saveSettingsCalls).toBe(1);
    });

    it('writes nothing when the profile already matches', async () => {
        seedConnectionManager(mock);
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        mock.saveSettingsCalls = 0;
        const result = await profiles.upsert(created.profileId, spec());
        expect(result).toMatchObject({ ok: true, created: false, changed: false });
        expect(mock.saveSettingsCalls).toBe(0);
    });

    it('creates a fresh profile when the remembered one is gone', async () => {
        seedConnectionManager(mock);
        const result = await profiles.upsert('vanished', spec());
        expect(result).toMatchObject({ ok: true, created: true });
        expect(result.ok && result.profileId).not.toBe('vanished');
    });

    it('repoints a profile between proxy and direct URLs', async () => {
        seedConnectionManager(mock);
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        await profiles.upsert(
            created.profileId,
            spec({ apiUrl: 'https://api.nano-gpt.com/api/v1', secretId: 'direct-secret' }),
        );
        expect(profiles.get(created.profileId)).toMatchObject({
            'api-url': 'https://api.nano-gpt.com/api/v1',
            'secret-id': 'direct-secret',
        });
    });
});

describe('removing', () => {
    it('removes the profile, clears the selection and saves', async () => {
        const manager = seedConnectionManager(mock);
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        manager.selectedProfile = created.profileId;
        mock.saveSettingsCalls = 0;
        expect(await profiles.remove(created.profileId)).toBe(true);
        expect(manager.profiles).toHaveLength(0);
        expect(manager.selectedProfile).toBeNull();
        expect(mock.saveSettingsCalls).toBe(1);
        expect(await profiles.remove(created.profileId)).toBe(false);
    });

    it('keeps other profiles and does nothing without Connection Manager', async () => {
        seedConnectionManager(mock, [{ id: 'user-own', name: 'My own' }]);
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        await profiles.remove(created.profileId);
        expect(profiles.list().map((p) => p.id)).toEqual(['user-own']);
        mock.extensionSettings['disabledExtensions'] = ['connection-manager'];
        expect(await profiles.remove('user-own')).toBe(false);
    });
});

describe('recognising our profiles', () => {
    it('by a proxy api-url, or a NanoGPT url with our name prefix', () => {
        expect(profiles.isOurs({ id: '1', 'api-url': PROXY })).toBe(true);
        expect(
            profiles.isOurs({
                id: '2',
                name: `${PROFILE_NAME_PREFIX}Direct`,
                'api-url': 'https://api.nano-gpt.com/api/v1',
            }),
        ).toBe(true);
        expect(profiles.isOurs({ id: '3', name: 'My NanoGPT', 'api-url': 'https://api.nano-gpt.com/api/v1' })).toBe(
            false,
        );
        expect(profiles.isOurs({ id: '4', name: `${PROFILE_NAME_PREFIX}x`, 'api-url': 'https://example.com/v1' })).toBe(
            false,
        );
        expect(profiles.isOurs({ id: '5' })).toBe(false);
        expect(profiles.isOurs({ id: '6', 'api-url': 'http://127.0.0.1:8000/not/ours' })).toBe(false);
    });

    it('reads the connection id out of a proxy profile', () => {
        expect(profiles.connectionIdOf({ id: '1', 'api-url': PROXY })).toBe('abc12345');
        expect(profiles.connectionIdOf({ id: '2', 'api-url': 'https://api.nano-gpt.com/api/v1' })).toBeNull();
    });
});

describe('drift', () => {
    it('names the managed fields that differ', async () => {
        const manager = seedConnectionManager(mock);
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        expect(profiles.drift(created.profileId, spec())).toEqual([]);
        expect(profiles.drift(created.profileId, spec({ model: 'other', secretId: 'x' }))).toEqual([
            'model',
            'secret-id',
        ]);
        manager.profiles[0]!.name = 'Renamed by hand';
        expect(profiles.drift(created.profileId, spec())).toEqual(['name']);
        expect(profiles.drift('missing', spec())).toBeNull();
    });

    it('accepts the counter that uniqueness appends', () => {
        const profile = {
            id: '1',
            mode: 'cc',
            api: 'custom',
            model: 'm',
            'api-url': 'u',
            'secret-id': 's',
            name: 'Nanovia · A (2)',
        };
        expect(profileDrift(profile, { name: 'Nanovia · A', model: 'm', apiUrl: 'u', secretId: 's' })).toEqual([]);
        expect(
            profileDrift(
                { ...profile, name: 'Nanovia · AB' },
                { name: 'Nanovia · A', model: 'm', apiUrl: 'u', secretId: 's' },
            ),
        ).toEqual(['name']);
    });
});

describe('what ST and its other extensions see', () => {
    it('emits the Connection Manager events with the same payloads CM uses', async () => {
        seedConnectionManager(mock);
        const seen: { event: string; args: unknown[] }[] = [];
        for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
            mock.eventSource.on(mock.context.eventTypes[key]!, (...args) => void seen.push({ event: key, args }));
        }
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        await profiles.upsert(created.profileId, spec({ model: 'new-model' }));
        await profiles.remove(created.profileId);
        expect(seen.map((s) => s.event)).toEqual([
            'CONNECTION_PROFILE_CREATED',
            'CONNECTION_PROFILE_UPDATED',
            'CONNECTION_PROFILE_DELETED',
        ]);
        const [, updated] = seen;
        expect((updated?.args[0] as { model: string }).model).toBe('deepseek/deepseek-v4');
        expect((updated?.args[1] as { model: string }).model).toBe('new-model');
    });

    it("rebuilds Connection Manager's own dropdown in place", async () => {
        const manager = seedConnectionManager(mock);
        document.body.innerHTML = '<select id="connection_profiles"><option value="">&lt;None&gt;</option></select>';
        const select = document.getElementById('connection_profiles') as HTMLSelectElement;
        const created = await profiles.upsert(null, spec());
        if (!created.ok) throw new Error('create failed');
        expect([...select.options].map((o) => o.textContent)).toEqual(['<None>', `${PROFILE_NAME_PREFIX}Main`]);
        manager.selectedProfile = created.profileId;
        await profiles.upsert(created.profileId, spec({ name: profileName('Renamed') }));
        expect([...select.options].map((o) => o.textContent)).toEqual(['<None>', `${PROFILE_NAME_PREFIX}Renamed`]);
        expect(select.value).toBe(created.profileId);
        await profiles.remove(created.profileId);
        expect(select.options).toHaveLength(1);
        expect(select.value).toBe('');
    });

    it("leaves a dropdown alone that does not look like Connection Manager's", async () => {
        seedConnectionManager(mock);
        document.body.innerHTML = '<select id="connection_profiles"><option value="a">A</option></select>';
        await profiles.upsert(null, spec());
        expect(document.getElementById('connection_profiles')?.querySelectorAll('option')).toHaveLength(1);
    });
});
