import { describe, expect, it } from 'vitest';
import type { ConnectionEntry } from '../../src/core/connections';
import { createI18n } from '../../src/core/i18n';
import { createConnection } from '../../src/domain/connection';
import { CONNECTIONS_STRINGS } from '../../src/features/connections/strings';
import {
    BILLING_MODES,
    CONNECTION_MODES,
    REASONING_EFFORTS,
    REASONING_POLICIES,
    actionsFor,
    bannerFor,
    chipsFor,
    emptyForm,
    formFromConfig,
    issueText,
    keyLabel,
    needsDirectKey,
    patchFromForm,
    showsDirectKey,
    validateForm,
} from '../../src/features/connections/view-model';
import type { FormState } from '../../src/features/connections/view-model';
import type { ApiStatus } from '../../src/shared/contracts';
import { UI_STRINGS } from '../../src/ui/strings';

const i18n = createI18n(() => 'en');
i18n.register(UI_STRINGS);
i18n.register(CONNECTIONS_STRINGS);
const t = i18n.t.bind(i18n);

function entry(
    overrides: Partial<ConnectionEntry> = {},
    config: Parameters<typeof createConnection>[0] = { name: 'Main', modelId: 'm' },
): ConnectionEntry {
    return {
        config: createConnection(config, 'abc12345', 1),
        view: null,
        effectiveMode: 'plugin',
        profileId: null,
        profileState: 'linked',
        hasDirectKey: false,
        pending: false,
        orphan: false,
        ...overrides,
    };
}

function form(overrides: Partial<FormState> = {}): FormState {
    return { ...emptyForm(), name: 'Main', modelId: 'deepseek/deepseek-v4', ...overrides };
}

describe('strings', () => {
    it('every English key has a Russian one and the other way round', () => {
        expect(Object.keys(CONNECTIONS_STRINGS.en).filter((k) => !(k in CONNECTIONS_STRINGS.ru))).toEqual([]);
        expect(Object.keys(CONNECTIONS_STRINGS.ru).filter((k) => !(k in CONNECTIONS_STRINGS.en))).toEqual([]);
        expect(Object.keys(UI_STRINGS.en).filter((k) => !(k in UI_STRINGS.ru))).toEqual([]);
        expect(Object.keys(UI_STRINGS.ru).filter((k) => !(k in UI_STRINGS.en))).toEqual([]);
    });

    it('has every key the view builds from a value', () => {
        const keys = [
            ...CONNECTION_MODES.flatMap((m) => [`connections.mode.${m}`, `connections.mode.${m}.hint`]),
            ...BILLING_MODES.flatMap((m) => [
                `connections.billing.${m}`,
                `connections.billing.${m}.hint`,
                `connections.chip.billing.${m}`,
            ]),
            ...REASONING_POLICIES.flatMap((p) => [`connections.reasoning.${p}`, `connections.reasoning.${p}.hint`]),
            ...REASONING_EFFORTS.map((e) => `connections.effort.${e}`),
            ...['plugin', 'direct'].map((m) => `connections.chip.mode.${m}`),
            ...['linked', 'drifted', 'missing', 'none', 'blocked', 'unavailable'].map(
                (s) => `connections.chip.profile.${s}`,
            ),
            'connections.status.checking',
            ...['not_installed', 'unreachable', 'timeout', 'forbidden', 'other'].map(
                (c) => `connections.status.reason.${c}`,
            ),
            ...[
                'plugin_down',
                'plugin_error',
                'direct_key_required',
                'key_write_failed',
                'not_found',
                'invalid',
                'not_on_plugin',
                'saved_locally',
                'profile_unavailable',
                'profile_needs_token',
                'profile_needs_key',
                'profile_failed',
                'key_not_removed',
            ].map((c) => `connections.issue.${c}`),
            ...['name', 'modelId'].map((f) => `connections.field.${f}`),
        ];
        const missing = keys.filter((key) => !(key in CONNECTIONS_STRINGS.en) || !(key in CONNECTIONS_STRINGS.ru));
        expect(missing).toEqual([]);
    });

    it('keeps the same placeholders in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        for (const [key, en] of Object.entries(CONNECTIONS_STRINGS.en)) {
            expect(placeholders(CONNECTIONS_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(en));
        }
    });
});

describe('form state and the patch it makes', () => {
    it('starts empty with sensible defaults', () => {
        expect(emptyForm()).toMatchObject({
            id: null,
            mode: 'auto',
            billing: 'auto',
            reasoningPolicy: 'follow',
            keyId: '',
            directKey: '',
        });
    });

    it('is filled from a config and never carries a key', () => {
        const config = createConnection(
            {
                name: 'Main',
                modelId: 'm',
                mode: 'plugin',
                keyId: 'key-1',
                billing: 'subscription',
                webSearch: true,
                note: 'n',
                reasoning: { policy: 'fixed', effort: 'high', hideThoughts: true },
            },
            'abc12345',
            1,
        );
        expect(formFromConfig(config)).toEqual({
            id: 'abc12345',
            name: 'Main',
            modelId: 'm',
            mode: 'plugin',
            keyId: 'key-1',
            billing: 'subscription',
            reasoningPolicy: 'fixed',
            reasoningEffort: 'high',
            hideThoughts: true,
            webSearch: true,
            note: 'n',
            directKey: '',
        });
    });

    it('makes a patch of just the fields the form controls', () => {
        const patch = patchFromForm(
            form({
                name: '  Main  ',
                modelId: ' m ',
                mode: 'plugin',
                keyId: 'key-1',
                billing: 'paygo',
                webSearch: true,
                note: 'n',
            }),
        );
        expect(patch).toEqual({
            name: 'Main',
            modelId: 'm',
            mode: 'plugin',
            keyId: 'key-1',
            billing: 'paygo',
            webSearch: true,
            note: 'n',
            reasoning: { policy: 'follow', effort: null, hideThoughts: false },
        });
        expect(Object.keys(patch)).not.toContain('routing');
        expect(Object.keys(patch)).not.toContain('memory');
    });

    it('chooses the active key with an empty id, and leaves keyId alone in direct mode', () => {
        expect(patchFromForm(form({ mode: 'auto', keyId: '' })).keyId).toBeNull();
        expect('keyId' in patchFromForm(form({ mode: 'direct', keyId: 'key-1' }))).toBe(false);
    });

    it('only sends an effort for the fixed policy', () => {
        expect(patchFromForm(form({ reasoningPolicy: 'fixed', reasoningEffort: 'xhigh' })).reasoning?.effort).toBe(
            'xhigh',
        );
        expect(patchFromForm(form({ reasoningPolicy: 'fixed', reasoningEffort: '' })).reasoning?.effort).toBe('medium');
        expect(patchFromForm(form({ reasoningPolicy: 'off', reasoningEffort: 'high' })).reasoning?.effort).toBeNull();
    });

    it('never puts the typed key into the patch', () => {
        const patch = patchFromForm(form({ mode: 'direct', directKey: 'sk-nano-secret' }));
        expect(JSON.stringify(patch)).not.toContain('sk-nano-secret');
    });
});

describe('when the form asks for the NanoGPT key', () => {
    const up = { pluginUp: true, hasDirectKey: false };
    const down = { pluginUp: false, hasDirectKey: false };

    it('always for direct mode without a key on file', () => {
        expect(needsDirectKey(form({ mode: 'direct' }), up)).toBe(true);
        expect(needsDirectKey(form({ mode: 'direct' }), { pluginUp: true, hasDirectKey: true })).toBe(false);
    });

    it('for a new auto connection while the plugin is down, not for an existing one or while it is up', () => {
        expect(needsDirectKey(form({ mode: 'auto' }), down)).toBe(true);
        expect(needsDirectKey(form({ mode: 'auto' }), up)).toBe(false);
        expect(needsDirectKey(form({ mode: 'auto', id: 'abc12345' }), down)).toBe(false);
        expect(needsDirectKey(form({ mode: 'plugin' }), down)).toBe(false);
    });

    it('shows the field for direct mode even to replace a key on file', () => {
        expect(showsDirectKey(form({ mode: 'direct' }), { pluginUp: true, hasDirectKey: true })).toBe(true);
        expect(showsDirectKey(form({ mode: 'plugin' }), up)).toBe(false);
    });

    it('validates name, model and the key', () => {
        expect(validateForm(form(), up)).toEqual([]);
        expect(validateForm(form({ name: ' ', modelId: '' }), up)).toEqual([
            { field: 'name', code: 'required' },
            { field: 'modelId', code: 'required' },
        ]);
        expect(validateForm(form({ mode: 'direct' }), up)).toEqual([{ field: 'directKey', code: 'required' }]);
        expect(validateForm(form({ mode: 'direct', directKey: 'k' }), up)).toEqual([]);
    });
});

describe('chips', () => {
    it('shows mode, billing and profile state', () => {
        const chips = chipsFor(
            entry({}, { name: 'A', modelId: 'm', mode: 'plugin', billing: 'subscription' }),
            true,
            t,
        );
        expect(chips.map((c) => c.label)).toEqual(['Plugin', 'Subscription only', 'Profile linked']);
        expect(chips[1]?.kind).toBe('ok');
        expect(chips[2]?.kind).toBe('ok');
    });

    it('spells out what auto does right now', () => {
        const auto = { name: 'A', modelId: 'm', mode: 'auto' as const };
        expect(chipsFor(entry({ effectiveMode: 'plugin' }, auto), true, t)[0]?.label).toBe('Auto → plugin');
        expect(chipsFor(entry({ effectiveMode: 'direct', hasDirectKey: true }, auto), false, t)[0]?.label).toBe(
            'Auto → direct',
        );
    });

    it('warns about a direct connection without a key, a pending edit and an orphan', () => {
        const chips = chipsFor(
            entry(
                { effectiveMode: 'direct', profileState: 'blocked', pending: true, orphan: true },
                { name: 'A', modelId: 'm', mode: 'direct' },
            ),
            true,
            t,
        );
        const labels = chips.map((c) => c.label);
        expect(labels).toContain('No direct key');
        expect(labels).toContain('Profile blocked');
        expect(labels).toContain('Waiting for the plugin');
        expect(labels).toContain('Not on the plugin');
        expect(chips.find((c) => c.label === 'No direct key')?.kind).toBe('error');
        // An orphan flag only means something while the plugin answers.
        expect(chipsFor(entry({ orphan: true }), false, t).map((c) => c.label)).not.toContain('Not on the plugin');
    });

    it('speaks Russian when asked to', () => {
        const ru = createI18n(() => 'ru');
        ru.register(CONNECTIONS_STRINGS);
        const chips = chipsFor(entry({}, { name: 'A', modelId: 'm', mode: 'plugin' }), true, ru.t.bind(ru));
        expect(chips[0]?.label).toBe('Плагин');
    });
});

describe('actions', () => {
    const ids = (e: ConnectionEntry, up: boolean) => actionsFor(e, up, t).map((a) => a.id);

    it('edit and delete are always there', () => {
        expect(ids(entry({}, { name: 'A', modelId: 'm', mode: 'direct' }), true)).toEqual(['edit', 'delete']);
    });

    it('offers a new token only for a connection the plugin has, while it answers', () => {
        const withView = entry({
            view: {
                ...createConnection({ name: 'A', modelId: 'm' }, 'abc12345', 1),
                proxyUrl: 'p',
                directUrl: 'd',
                tokenSecretId: 't',
            },
        });
        expect(ids(withView, true)).toContain('rotate');
        expect(ids(withView, false)).not.toContain('rotate');
        expect(ids(entry(), true)).not.toContain('rotate');
    });

    it('offers the switch to direct mode only while the plugin is down', () => {
        expect(ids(entry(), false)).toContain('switchDirect');
        expect(ids(entry(), true)).not.toContain('switchDirect');
        expect(ids(entry({}, { name: 'A', modelId: 'm', mode: 'direct' }), false)).not.toContain('switchDirect');
    });

    it('offers to send an orphan to the plugin, and to create or repair a profile', () => {
        expect(ids(entry({ orphan: true }), true)).toContain('sendToPlugin');
        expect(ids(entry({ profileState: 'none' }), true)).toContain('repairProfile');
        expect(ids(entry({ profileState: 'missing' }), true)).toContain('repairProfile');
        expect(
            actionsFor(entry({ profileState: 'drifted' }), true, t).find((a) => a.id === 'repairProfile')?.label,
        ).toBe('Repair profile');
        expect(ids(entry({ profileState: 'linked' }), true)).not.toContain('repairProfile');
        expect(ids(entry({ profileState: 'blocked' }), true)).not.toContain('repairProfile');
    });

    it('marks delete as dangerous', () => {
        expect(actionsFor(entry(), true, t).at(-1)).toMatchObject({ id: 'delete', kind: 'danger' });
    });
});

describe('the plugin banner', () => {
    const status: ApiStatus = {
        version: '0.1.0',
        plugin: true,
        proxy: { up: true, host: '127.0.0.1', port: 8787 },
        secrets: true,
        user: 'u',
    };

    it('says the plugin is running, with port and version', () => {
        expect(bannerFor(status, null, true, t)).toEqual({
            state: 'up',
            up: true,
            title: 'Plugin is running',
            detail: 'port 8787 · version 0.1.0',
            advice: null,
        });
    });

    it('does not claim the plugin is down before anyone has asked it', () => {
        expect(bannerFor(null, null, false, t, false)).toEqual({
            state: 'checking',
            up: false,
            title: 'Checking the plugin…',
            detail: '',
            advice: null,
        });
        // Once asked, a missing answer is a real answer.
        expect(bannerFor(null, null, false, t, true).state).toBe('down');
        // And a plugin that answered is never "checking".
        expect(bannerFor(status, null, true, t, false).state).toBe('up');
    });

    it('warns when the plugin answers but its proxy does not listen', () => {
        const banner = bannerFor({ ...status, proxy: { ...status.proxy, up: false } }, null, true, t);
        expect(banner.up).toBe(true);
        expect(banner.advice).toContain('8787');
    });

    it('explains why the plugin is down and shows the install hint', () => {
        for (const code of ['not_installed', 'unreachable', 'timeout', 'forbidden']) {
            const banner = bannerFor(null, { code, message: 'm', status: null }, false, t);
            expect(banner.up).toBe(false);
            expect(banner.title).toBe('Plugin is not answering');
            expect(banner.detail).toBe(t(`connections.status.reason.${code}`));
            expect(banner.advice).toContain('plugins/nanovia');
        }
        expect(bannerFor(null, { code: 'http_502', message: 'm', status: 502 }, false, t).detail).toContain('http_502');
        expect(bannerFor(null, null, false, t).detail).toBe(t('connections.status.reason.unreachable'));
    });
});

describe('messages', () => {
    it('fills the params of an issue', () => {
        expect(issueText({ code: 'plugin_error', params: { message: 'nope', status: 400 } }, t)).toBe(
            'The plugin refused the request: nope',
        );
        expect(issueText({ code: 'plugin_down' }, t)).toContain('not answering');
    });

    it("names the missing field in the user's language", () => {
        expect(issueText({ code: 'invalid', params: { field: 'modelId' } }, t)).toBe('The model id is required.');
        const ru = createI18n(() => 'ru');
        ru.register(CONNECTIONS_STRINGS);
        expect(issueText({ code: 'invalid', params: { field: 'name' } }, ru.t.bind(ru))).toBe(
            'Поле «название» обязательно.',
        );
    });

    it('shows the key of an unknown code instead of nothing', () => {
        expect(issueText({ code: 'brand_new' }, t)).toBe('connections.issue.brand_new');
    });

    it('labels keys with their mask, never a value', () => {
        expect(keyLabel({ label: 'Main', masked: 'sk-nano-…abcd', active: false }, t)).toBe('Main · sk-nano-…abcd');
        expect(keyLabel({ label: '', masked: 'sk-nano-…abcd', active: true }, t)).toBe(
            'sk-nano-…abcd (The active key)',
        );
    });
});
