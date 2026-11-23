import { describe, expect, it } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import {
    CATALOG_STALE_MS,
    DOCTOR_CODES,
    DOCTOR_LEVELS,
    DOCTOR_TABS,
    LOW_BALANCE_USD,
    MIN_ST_VERSION,
    QUOTA_HIGH_FRACTION,
    checksOfLevel,
    compareVersions,
    failedCheck,
    parseVersion,
    runChecks,
    summarizeChecks,
} from '../../src/domain/doctor';
import type { DoctorAccount, DoctorCheck, DoctorConnection, DoctorInput, DoctorKey } from '../../src/domain/doctor';
import type { CatalogModel, ConnectionConfig } from '../../src/shared/contracts';

const NOW = 1_800_000_000_000;

function model(patch: Partial<CatalogModel> = {}): CatalogModel {
    return {
        id: 'vendor/model',
        name: 'Model',
        description: '',
        contextLength: 128_000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: ['none', 'low', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: true, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
        ...patch,
    };
}

function connection(
    patch: Partial<DoctorConnection> = {},
    config: Partial<ConnectionConfig> = {},
    id = 'abc12345',
): DoctorConnection {
    return {
        config: createConnection({ name: 'Chat', modelId: 'vendor/model', ...config }, id, 1),
        effectiveMode: 'plugin',
        profileState: 'linked',
        orphan: false,
        pending: false,
        hasDirectKey: false,
        model: model(),
        providerSelection: null,
        advice: [],
        ...patch,
    };
}

function key(patch: Partial<DoctorKey> = {}): DoctorKey {
    return { id: 'key-1', label: 'Main', masked: 'sk-nano-…abcd', check: null, ...patch };
}

function account(patch: Partial<DoctorAccount> = {}): DoctorAccount {
    return { usdBalance: 10, subscriptionActive: true, dailyUsed: 0.1, weeklyUsed: 0.1, ...patch };
}

/** A setup with nothing to say: every check that can pass does. */
function input(patch: Partial<DoctorInput> = {}): DoctorInput {
    return {
        now: NOW,
        plugin: {
            checked: true,
            up: true,
            errorCode: null,
            version: '0.1.0',
            proxy: { up: true, port: 8787 },
            secrets: true,
        },
        stVersion: '1.19.0',
        connectionManager: true,
        connections: [connection()],
        keys: [key()],
        catalog: { loaded: true, count: 40, fetchedAt: NOW - 1000, source: 'live', error: null },
        qvink: 'absent',
        mgmtToken: null,
        account: null,
        ...patch,
    };
}

const find = (patch: Partial<DoctorInput>, code: string): DoctorCheck | undefined =>
    runChecks(input(patch)).find((item) => item.code === code);
const codes = (patch: Partial<DoctorInput>): string[] => runChecks(input(patch)).map((item) => item.code);

const DOWN: DoctorInput['plugin'] = {
    checked: true,
    up: false,
    errorCode: 'unreachable',
    version: null,
    proxy: null,
    secrets: null,
};

describe('a setup without problems', () => {
    it('only passes: every part says ok', () => {
        const checks = runChecks(input());
        expect(checks.map((item) => item.code)).toEqual([
            'plugin_ok',
            'st_version_ok',
            'keys_ok',
            'catalog_ok',
            'connection_ok',
        ]);
        expect(checks.every((item) => item.level === 'ok' && !item.fix)).toBe(true);
        expect(summarizeChecks(checks)).toEqual({ ok: 5, info: 0, warn: 0, error: 0 });
    });

    it('gives ids that differ from check to check', () => {
        const checks = runChecks(
            input({ connections: [connection({}, {}, 'aaaaaa11'), connection({}, { name: 'Second' }, 'bbbbbb22')] }),
        );
        const ids = checks.map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain('connection_ok:aaaaaa11');
        expect(ids).toContain('connection_ok:bbbbbb22');
    });
});

describe('the plugin', () => {
    it('says nothing before the plugin was asked, and nothing about its parts while it is down', () => {
        expect(codes({ plugin: { ...DOWN, checked: false, errorCode: null } })).not.toContain('plugin_down');
        expect(codes({ plugin: { ...DOWN, checked: false, errorCode: null } })).not.toContain('plugin_ok');
        expect(codes({ plugin: DOWN })).not.toContain('proxy_down');
    });

    it('plugin_down (warn): names the reason and offers to ask again', () => {
        expect(find({ plugin: DOWN }, 'plugin_down')).toEqual({
            id: 'plugin_down',
            level: 'warn',
            code: 'plugin_down',
            params: { reason: 'unreachable' },
            fix: { action: 'refresh' },
        });
        expect(find({ plugin: { ...DOWN, errorCode: 'not_installed' } }, 'plugin_down')?.params).toEqual({
            reason: 'not_installed',
        });
        expect(find({ plugin: { ...DOWN, errorCode: null } }, 'plugin_down')?.params).toEqual({
            reason: 'unreachable',
        });
    });

    it('proxy_down (error): plugin-mode connections cannot work; (warn) when nothing uses the plugin', () => {
        const proxyDown = { ...input().plugin, proxy: { up: false, port: 9000 } };
        const error = find({ plugin: proxyDown }, 'proxy_down');
        expect(error).toMatchObject({ level: 'error', params: { port: 9000 }, fix: { action: 'refresh' } });
        expect(codes({ plugin: proxyDown })).not.toContain('plugin_ok');

        const direct = [connection({ effectiveMode: 'direct', hasDirectKey: true }, { mode: 'direct' })];
        expect(find({ plugin: proxyDown, connections: direct }, 'proxy_down')?.level).toBe('warn');
        expect(find({ plugin: proxyDown, connections: [] }, 'proxy_down')?.level).toBe('warn');
    });

    it('secrets_unavailable (warn): the plugin cannot reach ST’s secret store', () => {
        const check = find({ plugin: { ...input().plugin, secrets: false } }, 'secrets_unavailable');
        expect(check).toMatchObject({ level: 'warn', code: 'secrets_unavailable' });
        expect(check?.fix).toBeUndefined();
        expect(codes({ plugin: { ...input().plugin, secrets: false } })).not.toContain('plugin_ok');
    });

    it('plugin_ok (ok): carries the port and the version', () => {
        expect(find({}, 'plugin_ok')?.params).toEqual({ port: 8787, version: '0.1.0' });
        expect(find({ plugin: { ...input().plugin, version: null, proxy: null } }, 'plugin_ok')?.params).toEqual({
            port: 0,
            version: '',
        });
    });
});

describe('SillyTavern', () => {
    it('st_version_old (warn) below the supported version, st_version_ok from it on', () => {
        expect(find({ stVersion: '1.18.9' }, 'st_version_old')).toMatchObject({
            level: 'warn',
            params: { version: '1.18.9', required: MIN_ST_VERSION },
        });
        expect(find({ stVersion: '1.12.14' }, 'st_version_old')).toBeDefined();
        for (const version of ['1.19.0', '1.19.2', '1.20.0', 'v2.0.0', '1.19', '1.19.0-beta']) {
            expect(find({ stVersion: version }, 'st_version_ok')?.level, version).toBe('ok');
            expect(find({ stVersion: version }, 'st_version_old'), version).toBeUndefined();
        }
    });

    it('skips the check when the version is not known or not a version', () => {
        for (const stVersion of [null, 'nightly', '']) {
            expect(codes({ stVersion }), String(stVersion)).not.toContain('st_version_ok');
            expect(codes({ stVersion }), String(stVersion)).not.toContain('st_version_old');
        }
    });

    it('connection_manager_missing (error), and no profile is judged without it', () => {
        const checks = runChecks(
            input({ connectionManager: false, connections: [connection({ profileState: 'unavailable' })] }),
        );
        expect(checks.find((item) => item.code === 'connection_manager_missing')).toMatchObject({ level: 'error' });
        expect(checks.map((item) => item.code)).not.toContain('profile_missing');

        const profileless = connection({ profileState: 'missing' });
        expect(codes({ connectionManager: false, connections: [profileless] })).not.toContain('profile_missing');
        expect(codes({ connectionManager: true, connections: [profileless] })).toContain('profile_missing');
    });
});

describe('the keys', () => {
    it('are left alone while they are not known', () => {
        const keyCodes = ['no_keys', 'key_rejected', 'keys_ok'];
        for (const code of keyCodes) expect(codes({ keys: null }), code).not.toContain(code);
    });

    it('no_keys (error) when a connection goes through the plugin, (info) when none does', () => {
        const error = find({ keys: [] }, 'no_keys');
        expect(error).toMatchObject({
            level: 'error',
            fix: { action: 'open-tab', target: DOCTOR_TABS.keys },
        });
        const direct = [connection({ effectiveMode: 'direct', hasDirectKey: true }, { mode: 'direct' })];
        expect(find({ keys: [], connections: direct }, 'no_keys')?.level).toBe('info');
        expect(find({ keys: [], connections: [] }, 'no_keys')?.level).toBe('info');
    });

    it('no_keys is not said while the secret store is out of reach (that is its own finding)', () => {
        const plugin = { ...input().plugin, secrets: false };
        expect(codes({ keys: [], plugin })).not.toContain('no_keys');
        expect(codes({ keys: [], plugin })).toContain('secrets_unavailable');
    });

    it('key_rejected (error) only from a check that failed, with a way to check again', () => {
        const rejected = key({ check: { ok: false, error: 'HTTP 401: invalid key' } });
        expect(find({ keys: [rejected] }, 'key_rejected')).toEqual({
            id: 'key_rejected:key-1',
            level: 'error',
            code: 'key_rejected',
            params: { label: 'Main', reason: 'HTTP 401: invalid key' },
            fix: { action: 'check-key', target: 'key-1' },
        });
        expect(codes({ keys: [rejected] })).not.toContain('keys_ok');
        // No check made, or a check that passed: nothing to say.
        expect(codes({ keys: [key()] })).not.toContain('key_rejected');
        expect(codes({ keys: [key({ check: { ok: true, error: null } })] })).not.toContain('key_rejected');
    });

    it('key_rejected names a key without a label by its mask, and a failure without a reason by an empty one', () => {
        const check = find({ keys: [key({ label: '  ', check: { ok: false, error: null } })] }, 'key_rejected');
        expect(check?.params).toEqual({ label: 'sk-nano-…abcd', reason: '' });
    });

    it('one finding per rejected key, the others still counted', () => {
        const checks = runChecks(
            input({
                keys: [
                    key({ id: 'k1', check: { ok: false, error: 'x' } }),
                    key({ id: 'k2', check: { ok: false, error: 'y' } }),
                    key({ id: 'k3', check: { ok: true, error: null } }),
                ],
            }),
        );
        expect(checks.filter((item) => item.code === 'key_rejected').map((item) => item.id)).toEqual([
            'key_rejected:k1',
            'key_rejected:k2',
        ]);
    });

    it('keys_ok (ok) counts the keys and the ones a check confirmed', () => {
        const keys = [key({ id: 'a', check: { ok: true, error: null } }), key({ id: 'b' })];
        expect(find({ keys }, 'keys_ok')?.params).toEqual({ count: 2, passed: 1 });
    });
});

describe('the catalog', () => {
    const fresh = input().catalog;

    it('catalog_empty (info) when it was not loaded yet, (warn) when loading failed or the list is empty', () => {
        const fix = { action: 'refresh', target: 'catalog' };
        expect(
            find({ catalog: { loaded: false, count: 0, fetchedAt: null, source: null, error: null } }, 'catalog_empty'),
        ).toMatchObject({ level: 'info', params: { reason: '' }, fix });
        expect(
            find(
                { catalog: { loaded: false, count: 0, fetchedAt: null, source: null, error: 'HTTP 502' } },
                'catalog_empty',
            ),
        ).toMatchObject({ level: 'warn', params: { reason: 'HTTP 502' }, fix });
        expect(find({ catalog: { ...fresh, count: 0 } }, 'catalog_empty')).toMatchObject({ level: 'warn' });
    });

    it('catalog_stale (warn) when it came from the stale copy or is older than a day', () => {
        expect(find({ catalog: { ...fresh, source: 'stale' } }, 'catalog_stale')).toMatchObject({
            level: 'warn',
            fix: { action: 'refresh', target: 'catalog' },
        });
        const old = { ...fresh, fetchedAt: NOW - CATALOG_STALE_MS - 1 };
        expect(find({ catalog: old }, 'catalog_stale')).toBeDefined();
        expect(codes({ catalog: old })).not.toContain('catalog_ok');
        const justFresh = { ...fresh, fetchedAt: NOW - CATALOG_STALE_MS };
        expect(codes({ catalog: justFresh })).not.toContain('catalog_stale');
    });

    it('catalog_ok (ok) says how many models it knows; a cached copy is fine', () => {
        expect(find({ catalog: fresh }, 'catalog_ok')?.params).toEqual({ count: 40 });
        expect(codes({ catalog: { ...fresh, source: 'cache' } })).toContain('catalog_ok');
        expect(codes({ catalog: { ...fresh, fetchedAt: null } })).toContain('catalog_ok');
    });
});

describe('a connection', () => {
    const only = (patch: Partial<DoctorInput>, code: string) => find(patch, code);

    it('model_unknown_or_paused (warn) when the loaded catalog does not list the model', () => {
        const unlisted = connection({ model: null });
        expect(only({ connections: [unlisted] }, 'model_unknown_or_paused')).toEqual({
            id: 'model_unknown_or_paused:abc12345',
            level: 'warn',
            code: 'model_unknown_or_paused',
            params: { name: 'Chat', model: 'vendor/model' },
            fix: { action: 'open-tab', target: DOCTOR_TABS.connections },
        });
    });

    it('does not judge the model while the catalog is empty or not loaded', () => {
        const unlisted = connection({ model: null });
        const empty = { loaded: false, count: 0, fetchedAt: null, source: null, error: null } as const;
        expect(codes({ connections: [unlisted], catalog: empty })).not.toContain('model_unknown_or_paused');
        expect(codes({ connections: [unlisted], catalog: { ...input().catalog, count: 0 } })).not.toContain(
            'model_unknown_or_paused',
        );
    });

    it('profile_missing (warn) for a profile that is gone or never was, with the repair', () => {
        for (const profileState of ['missing', 'none'] as const) {
            expect(only({ connections: [connection({ profileState })] }, 'profile_missing')).toEqual({
                id: 'profile_missing:abc12345',
                level: 'warn',
                code: 'profile_missing',
                params: { name: 'Chat', model: 'vendor/model', state: profileState },
                fix: { action: 'repair-profile', target: 'abc12345' },
            });
        }
    });

    it('profile_drifted (warn) with the repair', () => {
        expect(only({ connections: [connection({ profileState: 'drifted' })] }, 'profile_drifted')).toMatchObject({
            level: 'warn',
            fix: { action: 'repair-profile', target: 'abc12345' },
        });
    });

    it('profile_blocked (warn): ask the plugin again, or open the form for a direct connection', () => {
        const viaPlugin = connection({ profileState: 'blocked' });
        expect(only({ connections: [viaPlugin] }, 'profile_blocked')).toMatchObject({
            level: 'warn',
            fix: { action: 'refresh' },
        });
        const viaDirect = connection({ profileState: 'blocked', effectiveMode: 'direct', hasDirectKey: true });
        expect(only({ connections: [viaDirect] }, 'profile_blocked')?.fix).toEqual({
            action: 'open-tab',
            target: DOCTOR_TABS.connections,
        });
    });

    it('does not say "blocked" when a missing key or a dead plugin already explains it', () => {
        const noKey = connection({ profileState: 'blocked', effectiveMode: 'direct', hasDirectKey: false });
        expect(codes({ connections: [noKey] })).not.toContain('profile_blocked');
        expect(codes({ connections: [noKey] })).toContain('direct_without_key');
        const waiting = connection({ profileState: 'blocked' }, { mode: 'plugin' });
        expect(codes({ connections: [waiting], plugin: DOWN })).not.toContain('profile_blocked');
        expect(codes({ connections: [waiting], plugin: DOWN })).toContain('plugin_mode_but_down');
    });

    it('profile_orphan (warn) points at the Connections tab', () => {
        expect(only({ connections: [connection({ orphan: true })] }, 'profile_orphan')).toMatchObject({
            level: 'warn',
            fix: { action: 'open-tab', target: DOCTOR_TABS.connections },
        });
    });

    it('profile_pending: (warn) while the plugin answers and should have been sent to, (info) while it does not', () => {
        const pending = connection({ pending: true });
        expect(only({ connections: [pending] }, 'profile_pending')).toMatchObject({
            level: 'warn',
            fix: { action: 'refresh' },
        });
        expect(only({ connections: [pending], plugin: DOWN }, 'profile_pending')?.level).toBe('info');
        expect(only({ connections: [pending], plugin: { ...DOWN, checked: false } }, 'profile_pending')?.level).toBe(
            'info',
        );
    });

    it('direct_without_key (error) when a connection goes direct and no key is on file', () => {
        const noKey = connection({ effectiveMode: 'direct', hasDirectKey: false }, { mode: 'direct' });
        expect(only({ connections: [noKey] }, 'direct_without_key')).toMatchObject({
            level: 'error',
            fix: { action: 'open-tab', target: DOCTOR_TABS.connections },
        });
        const withKey = connection({ effectiveMode: 'direct', hasDirectKey: true }, { mode: 'direct' });
        expect(codes({ connections: [withKey] })).not.toContain('direct_without_key');
        // Auto mode that fell back to direct counts as direct.
        const fellBack = connection({ effectiveMode: 'direct' }, { mode: 'auto' });
        expect(codes({ connections: [fellBack], plugin: DOWN })).toContain('direct_without_key');
    });

    it('plugin_mode_but_down (error): switch to direct when a key is on file, else open the form', () => {
        const viaPlugin = { mode: 'plugin' as const };
        const withKey = connection({ hasDirectKey: true }, viaPlugin);
        expect(only({ connections: [withKey], plugin: DOWN }, 'plugin_mode_but_down')).toMatchObject({
            level: 'error',
            fix: { action: 'switch-direct', target: 'abc12345' },
        });
        const noKey = connection({ hasDirectKey: false }, viaPlugin);
        expect(only({ connections: [noKey], plugin: DOWN }, 'plugin_mode_but_down')?.fix).toEqual({
            action: 'open-tab',
            target: DOCTOR_TABS.connections,
        });
        expect(codes({ connections: [withKey] })).not.toContain('plugin_mode_but_down');
        expect(codes({ connections: [withKey], plugin: { ...DOWN, checked: false } })).not.toContain(
            'plugin_mode_but_down',
        );
        // Only a connection that insists on the plugin: auto mode simply goes direct.
        expect(codes({ connections: [connection({}, { mode: 'auto' })], plugin: DOWN })).not.toContain(
            'plugin_mode_but_down',
        );
    });

    describe('leaves_subscription', () => {
        const subscribed = account();
        const explicit = {
            routing: {
                ...createConnection({ name: 'x', modelId: 'm' }, 'abc12345', 1).routing,
                enabled: true,
                sort: 'price' as const,
            },
        };

        it('(warn) when routing settings move requests off an active subscription, with the field names', () => {
            const check = only({ connections: [connection({}, explicit)], account: subscribed }, 'leaves_subscription');
            expect(check).toMatchObject({
                level: 'warn',
                params: { name: 'Chat', reason: 'routing.explicit', fields: 'sort' },
                fix: { action: 'open-tab', target: DOCTOR_TABS.routing },
            });
        });

        it('(warn) when the model itself is outside the subscription, in "auto" and in "subscription only"', () => {
            const outside = model({ subscription: { included: false, inputTokenMultiplier: 1 } });
            for (const billing of ['auto', 'subscription'] as const) {
                const check = only(
                    { connections: [connection({ model: outside }, { billing })], account: subscribed },
                    'leaves_subscription',
                );
                expect(check?.params, billing).toMatchObject({ reason: 'model.notIncluded', fields: '' });
            }
        });

        it('says nothing without an active subscription, when the account is not known, or for pay-as-you-go', () => {
            const move = connection({}, explicit);
            expect(codes({ connections: [move], account: null })).not.toContain('leaves_subscription');
            expect(codes({ connections: [move], account: account({ subscriptionActive: false }) })).not.toContain(
                'leaves_subscription',
            );
            const forced = connection({}, { ...explicit, billing: 'paygo' });
            expect(codes({ connections: [forced], account: subscribed })).not.toContain('leaves_subscription');
        });

        it('says nothing when the request stays on the subscription, or "subscription only" strips the settings', () => {
            expect(codes({ connections: [connection()], account: subscribed })).not.toContain('leaves_subscription');
            const stripped = connection({}, { ...explicit, billing: 'subscription' });
            expect(codes({ connections: [stripped], account: subscribed })).not.toContain('leaves_subscription');
        });

        it('says nothing about routing on a model that runs on a fixed route', () => {
            const fixedRoute = connection({ providerSelection: false }, explicit);
            expect(codes({ connections: [fixedRoute], account: subscribed })).not.toContain('leaves_subscription');
        });
    });

    describe('Context Memory', () => {
        const withMemory = connection({}, { memory: { enabled: true, expirationDays: null } });

        it('memory_on (info) while it is switched on, nothing while it is off', () => {
            expect(only({ connections: [withMemory] }, 'memory_on')).toEqual({
                id: 'memory_on:abc12345',
                level: 'info',
                code: 'memory_on',
                params: { name: 'Chat', model: 'vendor/model' },
            });
            expect(codes({ connections: [connection()] })).not.toContain('memory_on');
        });

        it('memory_overlaps_qvink (warn) only while Qvink is loaded and on', () => {
            expect(only({ connections: [withMemory], qvink: 'present' }, 'memory_overlaps_qvink')).toMatchObject({
                level: 'warn',
                fix: { action: 'open-tab', target: DOCTOR_TABS.connections },
            });
            for (const qvink of ['disabled', 'absent', 'unknown'] as const) {
                expect(codes({ connections: [withMemory], qvink }), qvink).not.toContain('memory_overlaps_qvink');
            }
            expect(codes({ connections: [connection()], qvink: 'present' })).not.toContain('memory_overlaps_qvink');
        });

        it('an information note alone does not take away the "ok" of a connection; a warning does', () => {
            expect(codes({ connections: [withMemory] })).toContain('connection_ok');
            expect(codes({ connections: [withMemory], qvink: 'present' })).not.toContain('connection_ok');
        });
    });

    it('reasoning_always_on_for_background (info) from the advice, with the efforts it lists', () => {
        const advice = [
            { code: 'reasoning.alwaysOn' as const, severity: 'warn' as const, params: { efforts: 'low, high' } },
        ];
        expect(only({ connections: [connection({ advice })] }, 'reasoning_always_on_for_background')).toMatchObject({
            level: 'info',
            params: { name: 'Chat', model: 'vendor/model', efforts: 'low, high' },
        });
        const bare = [{ code: 'reasoning.alwaysOn' as const, severity: 'warn' as const }];
        expect(
            only({ connections: [connection({ advice: bare })] }, 'reasoning_always_on_for_background')?.params,
        ).toMatchObject({ efforts: '' });
        // Other findings of the advice are not this check's business.
        const other = [{ code: 'model.unknown' as const, severity: 'info' as const }];
        expect(codes({ connections: [connection({ advice: other })] })).not.toContain(
            'reasoning_always_on_for_background',
        );
    });

    it('connection_ok (ok) for a connection with nothing wrong, one per connection', () => {
        expect(only({}, 'connection_ok')).toEqual({
            id: 'connection_ok:abc12345',
            level: 'ok',
            code: 'connection_ok',
            params: { name: 'Chat', model: 'vendor/model' },
        });
        expect(codes({ connections: [connection({ orphan: true })] })).not.toContain('connection_ok');
    });
});

describe('the Management API token', () => {
    it('mgmt_token_missing (info) only when it is known to be absent', () => {
        expect(find({ mgmtToken: false }, 'mgmt_token_missing')).toEqual({
            id: 'mgmt_token_missing',
            level: 'info',
            code: 'mgmt_token_missing',
            fix: { action: 'open-tab', target: DOCTOR_TABS.mgmt },
        });
        expect(codes({ mgmtToken: null })).not.toContain('mgmt_token_missing');
        expect(codes({ mgmtToken: true })).not.toContain('mgmt_token_missing');
    });
});

describe('the account', () => {
    const paygo = [connection({}, { billing: 'paygo', name: 'Pricey' })];

    it('is left alone while it is not known', () => {
        for (const code of ['low_balance', 'subscription_quota_high']) {
            expect(codes({ account: null, connections: paygo }), code).not.toContain(code);
        }
    });

    it('low_balance (warn) below the threshold when a connection pays per token, naming it', () => {
        const check = find({ connections: paygo, account: account({ usdBalance: 0.42 }) }, 'low_balance');
        expect(check).toEqual({
            id: 'low_balance',
            level: 'warn',
            code: 'low_balance',
            params: { balance: '0.42', names: 'Pricey' },
        });
        expect(find({ connections: paygo, account: account({ usdBalance: 0 }) }, 'low_balance')).toBeDefined();
        expect(
            find({ connections: paygo, account: account({ usdBalance: LOW_BALANCE_USD }) }, 'low_balance'),
        ).toBeUndefined();
        expect(find({ connections: paygo, account: account({ usdBalance: null }) }, 'low_balance')).toBeUndefined();
    });

    it('low_balance counts a connection that ends up pay-as-you-go whatever its setting', () => {
        const outside = model({ subscription: { included: false, inputTokenMultiplier: 1 } });
        const unlisted = [connection({ model: outside }, { billing: 'auto', name: 'Outside' })];
        const check = find({ connections: unlisted, account: account({ usdBalance: 0.5 }) }, 'low_balance');
        expect(check?.params).toMatchObject({ names: 'Outside' });
    });

    it('low_balance counts every connection when there is no subscription at all', () => {
        const plain = [connection({}, { name: 'Plain' })];
        const none = account({ usdBalance: 0.5, subscriptionActive: false });
        expect(find({ connections: plain, account: none }, 'low_balance')?.params).toMatchObject({ names: 'Plain' });
        // With a subscription that covers it, a low balance does not matter.
        expect(find({ connections: plain, account: account({ usdBalance: 0.5 }) }, 'low_balance')).toBeUndefined();
    });

    it('low_balance is not said when nothing is paid per token', () => {
        expect(find({ connections: [], account: account({ usdBalance: 0.1 }) }, 'low_balance')).toBeUndefined();
    });

    it('subscription_quota_high (warn) from 90% of the daily or weekly quota, one finding per window', () => {
        const daily = find({ account: account({ dailyUsed: 0.9 }) }, 'subscription_quota_high');
        expect(daily).toEqual({
            id: 'subscription_quota_high:daily',
            level: 'warn',
            code: 'subscription_quota_high',
            params: { window: 'daily', percent: 90 },
        });
        const weekly = runChecks(input({ account: account({ weeklyUsed: 0.953 }) })).filter(
            (item) => item.code === 'subscription_quota_high',
        );
        expect(weekly.map((item) => item.params)).toEqual([{ window: 'weekly', percent: 95 }]);
        const both = runChecks(input({ account: account({ dailyUsed: 1, weeklyUsed: QUOTA_HIGH_FRACTION }) })).filter(
            (item) => item.code === 'subscription_quota_high',
        );
        expect(both.map((item) => item.id)).toEqual([
            'subscription_quota_high:daily',
            'subscription_quota_high:weekly',
        ]);
    });

    it('subscription_quota_high is not said below 90%, with unknown usage, or without a subscription', () => {
        expect(codes({ account: account({ dailyUsed: 0.89, weeklyUsed: null }) })).not.toContain(
            'subscription_quota_high',
        );
        expect(
            codes({ account: account({ subscriptionActive: false, dailyUsed: 0.99, weeklyUsed: 0.99 }) }),
        ).not.toContain('subscription_quota_high');
    });
});

describe('the whole list', () => {
    it('only uses codes that are declared (so every one has words)', () => {
        const crowded = input({
            plugin: { ...input().plugin, proxy: { up: false, port: 1 }, secrets: false },
            stVersion: '1.0.0',
            connectionManager: false,
            keys: [key({ check: { ok: false, error: 'x' } })],
            catalog: { loaded: false, count: 0, fetchedAt: null, source: null, error: null },
            qvink: 'present',
            mgmtToken: false,
            account: account({ usdBalance: 0.1, dailyUsed: 0.95 }),
            connections: [
                connection(
                    { model: null, orphan: true, pending: true, profileState: 'drifted' },
                    { memory: { enabled: true, expirationDays: 3 }, billing: 'paygo' },
                ),
            ],
        });
        const gathered = [...runChecks(crowded), ...runChecks(input()), failedCheck('boom')];
        for (const item of gathered) expect(DOCTOR_CODES, item.code).toContain(item.code);
        expect(new Set(DOCTOR_CODES).size).toBe(DOCTOR_CODES.length);
    });

    it('summarises the levels and filters by one', () => {
        const checks = runChecks(input({ mgmtToken: false, plugin: DOWN, stVersion: '1.0.0' }));
        const summary = summarizeChecks(checks);
        expect(summary.warn).toBe(2);
        expect(summary.info).toBe(1);
        expect(summary.error).toBe(0);
        expect(summary.ok + summary.info + summary.warn + summary.error).toBe(checks.length);
        expect(checksOfLevel(checks, 'warn').map((item) => item.code)).toEqual(['plugin_down', 'st_version_old']);
        expect(summarizeChecks([])).toEqual({ ok: 0, info: 0, warn: 0, error: 0 });
        expect(DOCTOR_LEVELS).toEqual(['error', 'warn', 'info', 'ok']);
    });

    it('failedCheck is an error with the message', () => {
        expect(failedCheck('boom')).toEqual({
            id: 'doctor_failed',
            level: 'error',
            code: 'doctor_failed',
            params: { message: 'boom' },
        });
    });
});

describe('versions', () => {
    it('parses what ST and the plugin report', () => {
        expect(parseVersion('1.19.2')).toEqual([1, 19, 2]);
        expect(parseVersion('v1.19')).toEqual([1, 19, 0]);
        expect(parseVersion(' 2 ')).toEqual([2, 0, 0]);
        expect(parseVersion('1.19.0-beta.3')).toEqual([1, 19, 0]);
        expect(parseVersion('nightly')).toBeNull();
        expect(parseVersion('')).toBeNull();
    });

    it('compares them, and gives null when one is not a version', () => {
        expect(compareVersions('1.19.0', '1.19.0')).toBe(0);
        expect(compareVersions('1.18.9', '1.19.0')).toBeLessThan(0);
        expect(compareVersions('1.19.1', '1.19.0')).toBeGreaterThan(0);
        expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
        expect(compareVersions('1.19.0', '1.19.10')).toBeLessThan(0);
        expect(compareVersions('x', '1.19.0')).toBeNull();
        expect(compareVersions('1.19.0', 'x')).toBeNull();
    });
});
