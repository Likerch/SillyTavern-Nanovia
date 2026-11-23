import { beforeEach, describe, expect, it, vi } from 'vitest';
import { briefOf, createAccountStore, decimalString, stateOfError } from '../../src/core/account';
import type { AccountStore } from '../../src/core/account';
import type { PluginAccount, PluginError, PluginResult } from '../../src/host';
import type { AccountSnapshot, SubscriptionUsage } from '../../src/shared/contracts-account';
import { memoryLogger } from '../helpers/fakes';

const NOW = 1_800_000_000_000;

function err(code: string, status: number | null = null): { ok: false; error: PluginError } {
    return { ok: false, error: { code, message: code, status } };
}

const SUB: SubscriptionUsage = {
    active: true,
    daily: { used: 2500, limit: 10_000, resetsAt: NOW + 3_600_000 },
    weekly: { used: 80_000, limit: 100_000, resetsAt: NOW + 86_400_000 },
    recommendedMode: 'subscription',
};

interface Rig {
    store: AccountStore;
    balance: ReturnType<typeof vi.fn<PluginAccount['balance']>>;
    subscription: ReturnType<typeof vi.fn<PluginAccount['subscription']>>;
    lookup: ReturnType<typeof vi.fn<PluginAccount['lookup']>>;
    plugin: { up: boolean; checked: boolean; error: PluginError | null };
    advance(ms: number): void;
}

function rig(): Rig {
    let t = NOW;
    const plugin = { up: true, checked: true, error: null as PluginError | null };
    const balance = vi.fn<PluginAccount['balance']>(async () => ({
        ok: true,
        data: { usdBalance: 12.5, nanoBalance: null, fetchedAt: t },
    }));
    const subscription = vi.fn<PluginAccount['subscription']>(async () => ({
        ok: true,
        data: { subscription: SUB, fetchedAt: t },
    }));
    const lookup = vi.fn<PluginAccount['lookup']>(async (requestId) => ({
        ok: true,
        data: { requestId, ready: false, costUsd: null },
    }));
    const store = createAccountStore({
        account: { balance, subscription, lookup },
        connections: { pluginUp: () => plugin.up, checked: () => plugin.checked, pluginError: () => plugin.error },
        log: memoryLogger(),
        now: () => t,
    });
    return { store, balance, subscription, lookup, plugin, advance: (ms) => void (t += ms) };
}

let r: Rig;

beforeEach(() => {
    r = rig();
});

describe('the brief', () => {
    const snapshot = (sub: SubscriptionUsage | null, usd: number | null = 4.2): AccountSnapshot => ({
        usdBalance: usd,
        nanoBalance: null,
        fetchedAt: 77,
        subscription: sub,
    });

    it('turns the quota windows into used/limit fractions', () => {
        expect(briefOf(snapshot(SUB))).toEqual({
            usdBalance: '4.20',
            subscription: { dailyUsed: 0.25, weeklyUsed: 0.8 },
            fetchedAt: 77,
        });
    });

    it('is null for a window without a limit, and for no subscription at all', () => {
        const noLimit = {
            ...SUB,
            daily: { used: 5, limit: null, resetsAt: null },
            weekly: { used: null, limit: 10, resetsAt: null },
        };
        expect(briefOf(snapshot(noLimit)).subscription).toBeNull();
        const oneWindow = { ...SUB, weekly: { used: 1, limit: 0, resetsAt: null } };
        expect(briefOf(snapshot(oneWindow)).subscription).toEqual({ dailyUsed: 0.25, weeklyUsed: null });
        expect(briefOf(snapshot(null)).subscription).toBeNull();
        expect(briefOf(snapshot({ ...SUB, active: false })).subscription).toBeNull();
    });

    it('never goes past 0..1', () => {
        const over = {
            ...SUB,
            daily: { used: 20_000, limit: 10_000, resetsAt: null },
            weekly: { used: -5, limit: 10, resetsAt: null },
        };
        expect(briefOf(snapshot(over)).subscription).toEqual({ dailyUsed: 1, weeklyUsed: 0 });
    });

    it('writes the balance as a decimal string, or null', () => {
        expect(briefOf(snapshot(null, null)).usdBalance).toBeNull();
        expect(decimalString(5)).toBe('5.00');
        expect(decimalString(0.12345678)).toBe('0.12345678');
        expect(decimalString(1.5)).toBe('1.50');
        expect(decimalString(0.0000001)).toBe('0.0000001');
        expect(decimalString(0)).toBe('0.00');
    });
});

describe('errors', () => {
    it('map to the state the tab explains', () => {
        const state = (code: string) => stateOfError({ code, message: code, status: null });
        expect(state('not_installed')).toBe('needs_plugin');
        expect(state('unreachable')).toBe('plugin_down');
        expect(state('timeout')).toBe('plugin_down');
        expect(state('forbidden')).toBe('plugin_down');
        expect(state('no_key')).toBe('no_key');
        expect(state('key_rejected')).toBe('error');
    });
});

describe('refresh()', () => {
    it('has nothing before the first answer', () => {
        expect(r.store.snapshot()).toBeNull();
        expect(r.store.detail()).toMatchObject({ state: 'idle', snapshot: null, stale: false, fetching: false });
    });

    it('reads the balance and the subscription of the active key', async () => {
        const brief = await r.store.refresh();
        expect(brief).toEqual({
            usdBalance: '12.50',
            subscription: { dailyUsed: 0.25, weeklyUsed: 0.8 },
            fetchedAt: NOW,
        });
        expect(r.store.snapshot()).toEqual(brief);
        expect(r.balance).toHaveBeenCalledWith(null);
        expect(r.subscription).toHaveBeenCalledWith(null);
        expect(r.store.detail()).toMatchObject({
            state: 'ok',
            stale: false,
            error: null,
            snapshot: { usdBalance: 12.5, subscription: SUB },
        });
    });

    it('serves the next 60 seconds from the cache; force asks again', async () => {
        await r.store.refresh();
        r.advance(59_000);
        await r.store.refresh();
        expect(r.balance).toHaveBeenCalledTimes(1);
        await r.store.refresh({ force: true });
        expect(r.balance).toHaveBeenCalledTimes(2);
        r.advance(60_001);
        await r.store.refresh();
        expect(r.balance).toHaveBeenCalledTimes(3);
        expect(r.subscription).toHaveBeenCalledTimes(3);
    });

    it('shares one pair of calls between concurrent refreshes', async () => {
        await Promise.all([r.store.refresh(), r.store.refresh(), r.store.refresh({ force: true })]);
        expect(r.balance).toHaveBeenCalledTimes(1);
        expect(r.subscription).toHaveBeenCalledTimes(1);
    });

    it('reports it is fetching', async () => {
        const during = r.store.refresh();
        expect(r.store.detail().fetching).toBe(true);
        await during;
        expect(r.store.detail().fetching).toBe(false);
    });

    it('keeps the last numbers and calls them stale when the plugin stops answering', async () => {
        await r.store.refresh();
        r.balance.mockResolvedValue(err('unreachable'));
        r.subscription.mockResolvedValue(err('unreachable'));
        const brief = await r.store.refresh({ force: true });
        expect(brief?.usdBalance).toBe('12.50');
        expect(r.store.detail()).toMatchObject({ state: 'plugin_down', stale: true, error: { code: 'unreachable' } });
        r.balance.mockImplementation(async () => ({
            ok: true,
            data: { usdBalance: 9, nanoBalance: null, fetchedAt: NOW },
        }));
        r.subscription.mockImplementation(async () => ({ ok: true, data: { subscription: null, fetchedAt: NOW } }));
        await r.store.refresh({ force: true });
        expect(r.store.detail()).toMatchObject({
            state: 'ok',
            stale: false,
            snapshot: { usdBalance: 9, subscription: null },
        });
    });

    it('does not ask a plugin that is known to be down, unless forced', async () => {
        await r.store.refresh();
        r.plugin.up = false;
        r.plugin.error = { code: 'unreachable', message: 'x', status: null };
        r.advance(120_000);
        const brief = await r.store.refresh();
        expect(r.balance).toHaveBeenCalledTimes(1);
        expect(brief?.usdBalance).toBe('12.50');
        expect(r.store.detail()).toMatchObject({ state: 'plugin_down', stale: true });
        await r.store.refresh({ force: true });
        expect(r.balance).toHaveBeenCalledTimes(2);
    });

    it('says "needs the plugin" when it is not installed, without calling anything', async () => {
        r.plugin.up = false;
        r.plugin.error = { code: 'not_installed', message: 'x', status: 404 };
        expect(await r.store.refresh()).toBeNull();
        expect(r.balance).not.toHaveBeenCalled();
        expect(r.store.detail()).toMatchObject({ state: 'needs_plugin', snapshot: null, stale: false });
    });

    it('asks when the plugin was never asked about', async () => {
        r.plugin.up = false;
        r.plugin.checked = false;
        await r.store.refresh();
        expect(r.balance).toHaveBeenCalledOnce();
    });

    it('tells a missing key from a rejected one', async () => {
        r.balance.mockResolvedValue(err('no_key', 409));
        r.subscription.mockResolvedValue(err('no_key', 409));
        await r.store.refresh();
        expect(r.store.detail()).toMatchObject({ state: 'no_key', snapshot: null, error: { code: 'no_key' } });
        r.balance.mockResolvedValue(err('key_rejected', 502));
        await r.store.refresh({ force: true });
        expect(r.store.detail()).toMatchObject({ state: 'error', error: { code: 'key_rejected' } });
    });

    it('waits 10 seconds after a failure before a non-forced retry', async () => {
        r.balance.mockResolvedValue(err('upstream_error', 502));
        await r.store.refresh();
        await r.store.refresh();
        expect(r.balance).toHaveBeenCalledTimes(1);
        r.advance(10_001);
        await r.store.refresh();
        expect(r.balance).toHaveBeenCalledTimes(2);
    });

    it('keeps the balance when only the subscription call fails', async () => {
        await r.store.refresh();
        r.subscription.mockResolvedValue(err('rate_limited', 429));
        await r.store.refresh({ force: true });
        expect(r.store.detail()).toMatchObject({
            state: 'ok',
            stale: false,
            subscriptionError: { code: 'rate_limited' },
            snapshot: { subscription: SUB },
        });
    });

    it('reads a balance even when the account has no subscription', async () => {
        r.subscription.mockResolvedValue({ ok: true, data: { subscription: null, fetchedAt: NOW } });
        expect(await r.store.refresh()).toEqual({ usdBalance: '12.50', subscription: null, fetchedAt: NOW });
    });

    it('never throws', async () => {
        r.balance.mockRejectedValue(new Error('boom'));
        await expect(r.store.refresh()).resolves.toBeNull();
        expect(r.store.detail()).toMatchObject({ state: 'error' });
    });

    it('tells listeners about every change and lets them go', async () => {
        const changed = vi.fn();
        const off = r.store.onChange(changed);
        await r.store.refresh();
        expect(changed.mock.calls.length).toBeGreaterThanOrEqual(2);
        off();
        changed.mockClear();
        await r.store.refresh({ force: true });
        expect(changed).not.toHaveBeenCalled();
    });
});

describe('the chosen key', () => {
    it('is the active one until chosen, and asked for by id afterwards', async () => {
        expect(r.store.keyId()).toBeNull();
        r.store.selectKey('key-2');
        await r.store.refresh();
        expect(r.store.keyId()).toBe('key-2');
        expect(r.balance).toHaveBeenCalledWith('key-2');
        expect(r.subscription).toHaveBeenCalledWith('key-2');
        r.store.selectKey('');
        expect(r.store.keyId()).toBeNull();
    });

    it("forgets the previous key's numbers at once and does not use the cache for the new key", async () => {
        await r.store.refresh();
        r.store.selectKey('key-2');
        expect(r.store.snapshot()).toBeNull();
        expect(r.store.detail().state).toBe('idle');
        await r.store.refresh();
        expect(r.balance).toHaveBeenCalledTimes(2);
    });

    it('drops an answer that arrives for a key that is no longer chosen', async () => {
        let release: (value: PluginResult<never>) => void = () => {};
        r.balance.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve as typeof release;
                }),
        );
        const slow = r.store.refresh();
        r.store.selectKey('key-2');
        release({ ok: true, data: { usdBalance: 999, nanoBalance: null, fetchedAt: NOW } } as never);
        await slow;
        expect(r.store.snapshot()).toBeNull();
        const brief = await r.store.refresh();
        expect(brief?.usdBalance).toBe('12.50');
    });

    it('does nothing when the same key is chosen again', async () => {
        await r.store.refresh();
        r.store.selectKey(null);
        expect(r.store.snapshot()).not.toBeNull();
    });
});

describe('lookup()', () => {
    it('asks for the exact cost with the chosen key', async () => {
        r.store.selectKey('key-3');
        const result = await r.store.lookup('req-9');
        expect(r.lookup).toHaveBeenCalledWith('req-9', 'key-3');
        expect(result).toEqual({ ok: true, data: { requestId: 'req-9', ready: false, costUsd: null } });
    });
});
