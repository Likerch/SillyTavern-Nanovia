import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { CatalogStore } from '../../src/core/catalog';
import { KEY_CHECK_TTL_MS, VERSION_RETRY_MS, VERSION_TTL_MS, createDoctorService } from '../../src/core/doctor';
import type { DoctorDeps, DoctorService } from '../../src/core/doctor';
import { QVINK_INTERCEPTOR } from '../../src/host';
import type { CatalogModel } from '../../src/shared/contracts';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const holder = globalThis as unknown as Record<string, unknown>;

function model(id: string, patch: Partial<CatalogModel> = {}): CatalogModel {
    return {
        id,
        name: id,
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

function fakeCatalog(models: CatalogModel[], patch: Partial<CatalogStore> = {}): CatalogStore {
    return {
        ...createEmptyCatalogStore(),
        models: () => models,
        model: (id) => models.find((item) => item.id === id) ?? null,
        status: () => ({ loaded: true, fetchedAt: clock, source: 'live', error: null }),
        ...patch,
    };
}

let h: Harness;
let tc: TestContext;
let clock: number;
let catalog: CatalogStore;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    clock = 1_800_000_000_000;
    catalog = createEmptyCatalogStore();
});

afterEach(() => {
    delete holder[QVINK_INTERCEPTOR];
    h.restore();
});

function service(overrides: Partial<DoctorDeps> = {}): DoctorService {
    return createDoctorService({
        connections: h.connections,
        plugin: h.plugin,
        profiles: h.profiles,
        account: tc.account,
        catalog: () => catalog,
        panel: () => null,
        host: tc.ctx.host,
        log: h.log,
        now: () => clock,
        stVersion: async () => '1.19.0',
        qvink: () => 'absent',
        ...overrides,
    });
}

function addKey(id = 'key-1', label = 'Main'): string {
    h.backend.plugin.keys.push({ id, label, active: h.backend.plugin.keys.length === 0, masked: 'sk-nano-…abcd' });
    return id;
}

async function addConnection(patch: Record<string, unknown> = {}): Promise<string> {
    const saved = await h.connections.save({
        patch: { name: 'Chat', modelId: 'vendor/model', mode: 'plugin', ...patch },
    });
    if (!saved.ok) throw new Error(`save failed: ${saved.error.code}`);
    return saved.data.id;
}

const codesOf = (doctor: DoctorService): string[] => (doctor.report()?.checks ?? []).map((item) => item.code);
const pluginPaths = (): string[] => h.backend.pluginCalls().map((call) => `${call.method} ${call.path}`);

describe('run', () => {
    it('gathers the plugin, the keys (with a balance check each), the version and the catalog, then evaluates', async () => {
        addKey();
        await addConnection();
        const doctor = service();
        expect(doctor.report()).toBeNull();

        const report = await doctor.run();
        expect(doctor.report()).toBe(report);
        expect(report.checks.map((item) => item.code)).toEqual([
            'plugin_ok',
            'st_version_ok',
            'keys_ok',
            'catalog_empty',
            'connection_ok',
        ]);
        expect(report.summary).toEqual({ ok: 4, info: 1, warn: 0, error: 0 });
        expect(report.checks.find((item) => item.code === 'keys_ok')?.params).toEqual({ count: 1, passed: 1 });
        expect(
            pluginPaths().some((call) => call.endsWith('POST /keys/key-1/check') || call.includes('/keys/key-1/check')),
        ).toBe(true);
    });

    it('asks a plugin that was never asked before it looks', async () => {
        expect(h.connections.checked()).toBe(false);
        await service().run();
        expect(h.connections.checked()).toBe(true);
    });

    it('does not ask for keys of a plugin that is down, and says so instead of "no keys"', async () => {
        h.backend.plugin.up = false;
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).toContain('plugin_down');
        expect(codesOf(doctor)).not.toContain('no_keys');
        expect(pluginPaths().filter((call) => call.includes('/keys'))).toEqual([]);
    });

    it('reports "no keys" when the plugin answers with none', async () => {
        await addConnection();
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).toContain('no_keys');
    });

    it('turns a key that failed its check into a finding with a way to check again', async () => {
        addKey();
        h.backend.plugin.keyChecks.set('key-1', {
            ok: false,
            usdBalance: null,
            nanoBalance: null,
            error: 'HTTP 401: invalid key',
        });
        const doctor = service();
        const report = await doctor.run();
        expect(report.checks.find((item) => item.code === 'key_rejected')).toMatchObject({
            level: 'error',
            params: { label: 'Main', reason: 'HTTP 401: invalid key' },
            fix: { action: 'check-key', target: 'key-1' },
        });
        expect(report.summary.error).toBe(1);
    });

    it('checks each key once per five minutes; a refresh asks again', async () => {
        addKey();
        const doctor = service();
        const checks = (): number => pluginPaths().filter((call) => call.includes('/keys/key-1/check')).length;
        await doctor.run();
        await doctor.run();
        expect(checks()).toBe(1);
        clock += KEY_CHECK_TTL_MS + 1;
        await doctor.run();
        expect(checks()).toBe(2);
        await doctor.run({ refresh: true });
        expect(checks()).toBe(3);
    });

    it('forgets the check of a key that is gone', async () => {
        addKey();
        h.backend.plugin.keyChecks.set('key-1', { ok: false, usdBalance: null, nanoBalance: null, error: 'x' });
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).toContain('key_rejected');
        h.backend.plugin.keys.length = 0;
        addKey('key-1', 'Again');
        h.backend.plugin.keyChecks.delete('key-1');
        await doctor.run({ refresh: true });
        expect(codesOf(doctor)).not.toContain('key_rejected');
        h.backend.plugin.keys.length = 0;
        await doctor.run();
        expect(codesOf(doctor)).toContain('no_keys');
    });

    it('asks the plugin again on a refresh and reads what changed', async () => {
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).not.toContain('plugin_down');
        h.backend.plugin.up = false;
        await doctor.run();
        expect(codesOf(doctor)).not.toContain('plugin_down');
        await doctor.run({ refresh: true });
        expect(codesOf(doctor)).toContain('plugin_down');
    });

    it('reads ST’s version once per ten minutes, a failed read again after a minute, and always on a refresh', async () => {
        const read = vi.fn<() => Promise<string | null>>(async () => '1.19.0');
        const doctor = service({ stVersion: read });
        await doctor.run();
        await doctor.run();
        expect(read).toHaveBeenCalledTimes(1);
        clock += VERSION_TTL_MS + 1;
        await doctor.run();
        expect(read).toHaveBeenCalledTimes(2);
        await doctor.run({ refresh: true });
        expect(read).toHaveBeenCalledTimes(3);

        const failing = vi.fn<() => Promise<string | null>>(async () => null);
        const other = service({ stVersion: failing });
        await other.run();
        expect(codesOf(other)).not.toContain('st_version_ok');
        clock += VERSION_RETRY_MS - 1;
        await other.run();
        expect(failing).toHaveBeenCalledTimes(1);
        clock += 2;
        await other.run();
        expect(failing).toHaveBeenCalledTimes(2);
    });

    it('flags an old SillyTavern', async () => {
        const doctor = service({ stVersion: async () => '1.18.3' });
        await doctor.run();
        expect(doctor.report()?.checks.find((item) => item.code === 'st_version_old')?.params).toEqual({
            version: '1.18.3',
            required: '1.19.0',
        });
    });

    it('shares one run between callers and tells the listeners when it starts and ends', async () => {
        const doctor = service();
        const running: boolean[] = [];
        const off = doctor.onChange(() => void running.push(doctor.running()));
        const first = doctor.run();
        const second = doctor.run({ refresh: true });
        expect(second).toBe(first);
        expect(doctor.running()).toBe(true);
        await first;
        expect(doctor.running()).toBe(false);
        expect(running).toEqual([true, false]);
        off();
        await doctor.run();
        expect(running).toEqual([true, false]);
    });

    it('keeps going when a listener throws', async () => {
        const doctor = service();
        doctor.onChange(() => {
            throw new Error('listener');
        });
        await expect(doctor.run()).resolves.toBeDefined();
        expect(h.log.lines.some((line) => line.level === 'error')).toBe(true);
    });
});

describe('never throws', () => {
    it('a step that fails is "not known": the report is still made', async () => {
        const doctor = service({
            account: {
                detail: tc.account.detail,
                refresh: async () => {
                    throw new Error('account is down');
                },
            },
            stVersion: async () => {
                throw new Error('no version');
            },
        });
        catalog = fakeCatalog([], {
            refresh: async () => {
                throw new Error('catalog is down');
            },
        });
        const report = await doctor.run();
        expect(report.checks.map((item) => item.code)).toContain('plugin_ok');
        expect(report.checks.map((item) => item.code)).not.toContain('st_version_ok');
        expect(h.log.lines.filter((line) => line.level === 'warn')).toHaveLength(3);
    });

    it('a failure of the evaluation becomes a check', async () => {
        const doctor = service({
            qvink: () => {
                throw new Error('qvink exploded');
            },
        });
        const report = await doctor.run();
        expect(report.checks).toEqual([
            { id: 'doctor_failed', level: 'error', code: 'doctor_failed', params: { message: 'qvink exploded' } },
        ]);
        expect(report.summary.error).toBe(1);
        expect(doctor.evaluate().checks[0]?.code).toBe('doctor_failed');
        expect(doctor.brief()).toEqual({
            errors: 1,
            warnings: 0,
            checks: [{ id: 'doctor_failed', level: 'error', code: 'doctor_failed' }],
        });
    });

    it('survives an exception that is not an Error', async () => {
        const doctor = service({
            qvink: () => {
                throw 'plain text';
            },
        });
        expect((await doctor.run()).checks[0]?.params).toEqual({ message: 'plain text' });
    });

    it('a run that fails outside the steps still ends with a report', async () => {
        const doctor = service({
            connections: {
                ...h.connections,
                checked: () => {
                    throw new Error('connections are broken');
                },
            },
        });
        const report = await doctor.run();
        expect(report.checks[0]?.code).toBe('doctor_failed');
        expect(doctor.running()).toBe(false);
    });
});

describe('what it reads', () => {
    it('Qvink through ST by default: loaded and on, it overlaps Context Memory', async () => {
        await addConnection({ memory: { enabled: true, expirationDays: null } });
        holder[QVINK_INTERCEPTOR] = () => {};
        const doctor = createDoctorService({
            connections: h.connections,
            plugin: h.plugin,
            profiles: h.profiles,
            account: tc.account,
            catalog: () => catalog,
            panel: () => null,
            host: tc.ctx.host,
            log: h.log,
            stVersion: async () => '1.19.0',
        });
        await doctor.run();
        expect(codesOf(doctor)).toContain('memory_on');
        expect(codesOf(doctor)).toContain('memory_overlaps_qvink');
        delete holder[QVINK_INTERCEPTOR];
        expect(doctor.evaluate().checks.map((item) => item.code)).not.toContain('memory_overlaps_qvink');
    });

    it('the Management token: not known by default, absent when the owner says so', async () => {
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).not.toContain('mgmt_token_missing');
        let known: boolean | null = false;
        const informed = service({ mgmtToken: () => known });
        await informed.run();
        expect(codesOf(informed)).toContain('mgmt_token_missing');
        known = true;
        expect(informed.evaluate().checks.map((item) => item.code)).not.toContain('mgmt_token_missing');
    });

    it('the catalog: an unlisted model, and a model that always reasons through the background advice', async () => {
        await addConnection({ name: 'Ghost', modelId: 'vendor/ghost' });
        await addConnection({ name: 'Thinker', modelId: 'vendor/thinker' });
        catalog = fakeCatalog([model('vendor/model'), model('vendor/thinker', { reasoningEfforts: ['low', 'high'] })]);
        const doctor = service();
        const report = await doctor.run();
        const byCode = (code: string) => report.checks.filter((item) => item.code === code);
        expect(byCode('model_unknown_or_paused').map((item) => item.params?.['name'])).toEqual(['Ghost']);
        expect(byCode('reasoning_always_on_for_background')).toMatchObject([
            { level: 'info', params: { name: 'Thinker', efforts: 'low, high' } },
        ]);
        expect(byCode('catalog_ok')[0]?.params).toEqual({ count: 2 });
    });

    it('the catalog store is read at every look, so a store wired in later is picked up', async () => {
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).toContain('catalog_empty');
        catalog = fakeCatalog([model('vendor/model')]);
        expect(doctor.evaluate().checks.map((item) => item.code)).toContain('catalog_ok');
    });

    it('a stale catalog, and a catalog that failed to load', async () => {
        const doctor = service();
        catalog = fakeCatalog([model('vendor/model')], {
            status: () => ({ loaded: true, fetchedAt: clock, source: 'stale', error: null }),
        });
        expect(doctor.evaluate().checks.map((item) => item.code)).toContain('catalog_stale');
        catalog = fakeCatalog([], {
            status: () => ({ loaded: false, fetchedAt: null, source: null, error: 'HTTP 502' }),
        });
        expect(doctor.evaluate().checks.find((item) => item.code === 'catalog_empty')).toMatchObject({
            level: 'warn',
            params: { reason: 'HTTP 502' },
        });
    });

    it('the billing verdict of a connection against the subscription the account reports', async () => {
        await addConnection({
            name: 'Picky',
            billing: 'auto',
            routing: { enabled: true, sort: 'price' },
        });
        catalog = fakeCatalog([model('vendor/model')]);
        tc.fake.subscription = {
            active: true,
            daily: { used: 10, limit: 100, resetsAt: null },
            weekly: { used: 20, limit: 100, resetsAt: null },
            recommendedMode: 'subscription',
        };
        const doctor = service();
        await doctor.run();
        expect(doctor.report()?.checks.find((item) => item.code === 'leaves_subscription')).toMatchObject({
            level: 'warn',
            params: { name: 'Picky', reason: 'routing.explicit', fields: 'sort' },
        });
        expect(codesOf(doctor)).not.toContain('subscription_quota_high');
    });

    it('the balance and the quota of the account', async () => {
        await addConnection({ name: 'Pricey', billing: 'paygo' });
        tc.fake.balances.set('', 0.5);
        tc.fake.subscription = {
            active: true,
            daily: { used: 95, limit: 100, resetsAt: null },
            weekly: { used: 10, limit: 100, resetsAt: null },
            recommendedMode: 'subscription',
        };
        const doctor = service();
        const report = await doctor.run();
        expect(report.checks.find((item) => item.code === 'low_balance')?.params).toEqual({
            balance: '0.50',
            names: 'Pricey',
        });
        expect(report.checks.find((item) => item.code === 'subscription_quota_high')?.params).toEqual({
            window: 'daily',
            percent: 95,
        });
    });

    it('skips the account when it is not known (the plugin is down)', async () => {
        h.backend.plugin.up = false;
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor).filter((code) => code === 'low_balance' || code === 'subscription_quota_high')).toEqual(
            [],
        );
    });

    it('a profile that Connection Manager lost', async () => {
        await addConnection();
        h.manager.profiles.length = 0;
        await h.connections.refresh();
        const doctor = service();
        await doctor.run();
        expect(doctor.report()?.checks.find((item) => item.code === 'profile_missing')).toMatchObject({
            level: 'warn',
            fix: { action: 'repair-profile' },
        });
    });

    it('Connection Manager that is not there', async () => {
        h.restore();
        h = createHarness({ connectionManager: false });
        tc = createContext(h);
        const doctor = service();
        await doctor.run();
        expect(doctor.report()?.checks.find((item) => item.code === 'connection_manager_missing')).toMatchObject({
            level: 'error',
        });
    });
});

describe('the brief for other extensions', () => {
    it('counts errors and warnings and lists id, level and code without params or fixes', async () => {
        await addConnection({ name: 'Chat' });
        const doctor = service({ stVersion: async () => '1.18.0' });
        await doctor.run();
        const brief = doctor.brief();
        expect(brief.errors).toBe(1);
        expect(brief.warnings).toBe(1);
        expect(brief.checks).toContainEqual({ id: 'no_keys', level: 'error', code: 'no_keys' });
        expect(brief.checks).toContainEqual({ id: 'st_version_old', level: 'warn', code: 'st_version_old' });
        for (const item of brief.checks) expect(Object.keys(item).sort()).toEqual(['code', 'id', 'level']);
    });

    it('is a look at the present, not at the last run: no network, nothing asked', async () => {
        const doctor = service();
        const before = h.backend.calls.length;
        const brief = doctor.brief();
        expect(h.backend.calls.length).toBe(before);
        // Before anything was loaded, the parts that need loading are simply absent.
        expect(brief.checks.map((item) => item.code)).not.toContain('st_version_ok');
        expect(brief.checks.map((item) => item.code)).not.toContain('keys_ok');
        await doctor.run();
        expect(doctor.brief().checks.map((item) => item.code)).toContain('st_version_ok');
    });
});

describe('applyFix', () => {
    it('refresh asks the plugin again', async () => {
        const doctor = service();
        await h.connections.refresh();
        const before = pluginPaths().filter((call) => call.endsWith('GET /status') || call.includes('/status')).length;
        h.backend.plugin.up = false;
        expect(await doctor.applyFix({ action: 'refresh' })).toEqual({ ok: true });
        expect(h.connections.pluginUp()).toBe(false);
        expect(pluginPaths().filter((call) => call.includes('/status')).length).toBeGreaterThan(before);
        expect(codesOf(doctor)).toContain('plugin_down');
    });

    it('refresh with target "catalog" reloads the catalog by force', async () => {
        const refresh = vi.fn(async () => {});
        catalog = fakeCatalog([], { refresh });
        const doctor = service();
        expect(await doctor.applyFix({ action: 'refresh', target: 'catalog' })).toEqual({ ok: true });
        expect(refresh).toHaveBeenCalledWith(true);
    });

    it('repair-profile gives a connection its profile back', async () => {
        const id = await addConnection();
        h.manager.profiles.length = 0;
        const doctor = service();
        await doctor.run();
        expect(codesOf(doctor)).toContain('profile_missing');
        expect(await doctor.applyFix({ action: 'repair-profile', target: id })).toEqual({ ok: true });
        expect(h.manager.profiles).toHaveLength(1);
        expect(codesOf(doctor)).not.toContain('profile_missing');
        expect(codesOf(doctor)).toContain('connection_ok');
    });

    it('repair-profile and switch-direct say what went wrong in the service’s own code', async () => {
        const doctor = service();
        expect(await doctor.applyFix({ action: 'repair-profile', target: 'nosuchid' })).toEqual({
            ok: false,
            code: 'not_found',
        });
        const id = await addConnection();
        // No key on file: the connection cannot go direct.
        expect(await doctor.applyFix({ action: 'switch-direct', target: id })).toEqual({
            ok: false,
            code: 'direct_key_required',
        });
        for (const action of ['repair-profile', 'switch-direct', 'check-key'] as const) {
            expect(await doctor.applyFix({ action }), action).toEqual({ ok: false, code: 'missing_target' });
        }
    });

    it('carries the parameters of a refusal along', async () => {
        const doctor = service();
        const id = await addConnection();
        h.backend.plugin.failNext.set(`PUT /connections/${id}`, {
            status: 500,
            code: 'internal',
            message: 'disk full',
        });
        h.settings.update((s) => {
            s.directSecrets[id] = 'secret-direct';
        });
        const result = await doctor.applyFix({ action: 'switch-direct', target: id });
        expect(result).toEqual({ ok: false, code: 'plugin_error', params: { message: 'disk full', status: 500 } });
    });

    it('switch-direct moves a connection that has a key on file to direct mode', async () => {
        const id = await addConnection();
        h.settings.update((s) => {
            s.directSecrets[id] = 'secret-direct';
        });
        const doctor = service();
        expect(await doctor.applyFix({ action: 'switch-direct', target: id })).toEqual({ ok: true });
        expect(h.connections.get(id)?.config.mode).toBe('direct');
    });

    it('check-key keeps the answer for the next look', async () => {
        addKey();
        const doctor = service();
        await h.connections.refresh();
        await doctor.run();
        h.backend.plugin.keyChecks.set('key-1', { ok: false, usdBalance: null, nanoBalance: null, error: 'revoked' });
        expect(await doctor.applyFix({ action: 'check-key', target: 'key-1' })).toEqual({ ok: true });
        expect(codesOf(doctor)).toContain('key_rejected');
        h.backend.plugin.keyChecks.delete('key-1');
        expect(await doctor.applyFix({ action: 'check-key', target: 'key-1' })).toEqual({ ok: true });
        expect(codesOf(doctor)).not.toContain('key_rejected');
        expect(codesOf(doctor)).toContain('keys_ok');
    });

    it('check-key reports a plugin that cannot do it, and keeps nothing', async () => {
        addKey();
        const doctor = service();
        await doctor.run();
        h.backend.plugin.failNext.set('POST /keys/key-1/check', { status: 404, code: 'not_found', message: 'no key' });
        expect(await doctor.applyFix({ action: 'check-key', target: 'key-1' })).toEqual({
            ok: false,
            code: 'plugin_error',
            params: { message: 'no key', status: 0 },
        });
    });

    it('open-tab opens the panel at the tab; without a panel it says so', async () => {
        const open = vi.fn();
        const doctor = service({ panel: () => ({ open }) });
        expect(await doctor.applyFix({ action: 'open-tab', target: 'keys' })).toEqual({ ok: true });
        expect(open).toHaveBeenCalledWith('keys');
        expect(await doctor.applyFix({ action: 'open-tab' })).toEqual({ ok: true });
        expect(open).toHaveBeenLastCalledWith(undefined);
        expect(await service().applyFix({ action: 'open-tab', target: 'keys' })).toEqual({
            ok: false,
            code: 'no_panel',
        });
        expect(await service({ panel: () => ({}) }).applyFix({ action: 'open-tab' })).toEqual({
            ok: false,
            code: 'no_panel',
        });
    });

    it('never throws', async () => {
        const doctor = service({
            connections: {
                ...h.connections,
                repairProfile: async () => {
                    throw new Error('profile exploded');
                },
                switchToDirect: async () => {
                    throw 'not an error';
                },
            },
        });
        expect(await doctor.applyFix({ action: 'repair-profile', target: 'x' })).toEqual({
            ok: false,
            code: 'unexpected',
            params: { message: 'profile exploded' },
        });
        expect(await doctor.applyFix({ action: 'switch-direct', target: 'x' })).toEqual({
            ok: false,
            code: 'unexpected',
            params: { message: '' },
        });
    });

    it('tells the listeners after a fix, but leaves a run in progress to say it itself', async () => {
        const doctor = service();
        const seen = vi.fn();
        doctor.onChange(seen);
        await doctor.applyFix({ action: 'refresh', target: 'catalog' });
        expect(seen).toHaveBeenCalledTimes(1);
        const run = doctor.run();
        seen.mockClear();
        await doctor.applyFix({ action: 'refresh', target: 'catalog' });
        expect(seen).not.toHaveBeenCalled();
        await run;
    });
});

describe('the service over the whole app stack', () => {
    it('reports to a view while the checks run', async () => {
        const doctor = service();
        const states: string[] = [];
        doctor.onChange(() => states.push(doctor.running() ? 'running' : 'idle'));
        const run = doctor.run();
        await flush();
        await run;
        expect(states).toEqual(['running', 'idle']);
    });
});
