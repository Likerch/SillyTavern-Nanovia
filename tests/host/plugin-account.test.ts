// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createPluginAccount,
    parseBalance,
    parseLookup,
    parseSpend,
    parseSubscriptionState,
} from '../../src/host/plugin-account';
import type { SubscriptionUsage } from '../../src/shared/contracts-account';
import { createAccountFake, usageRecord } from '../helpers/account-fake';
import type { AccountFake } from '../helpers/account-fake';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

let h: Harness;
let fake: AccountFake;

beforeEach(() => {
    h = createHarness();
    fake = createAccountFake(h);
});

afterEach(() => h.restore());

const SUBSCRIPTION: SubscriptionUsage = {
    active: true,
    daily: { used: 1000, limit: 5000, resetsAt: 1_800_000_900_000 },
    weekly: { used: 20_000, limit: 100_000, resetsAt: null },
    recommendedMode: 'subscription',
};

describe('balance', () => {
    it('reads the balance of the active key, and of a chosen key by id', async () => {
        fake.balances.set('key-2', 3.25);
        fake.nanoBalance = 0.5;
        const active = await fake.account.balance();
        expect(active).toMatchObject({ ok: true, data: { usdBalance: 12.5, nanoBalance: 0.5 } });
        const chosen = await fake.account.balance('key-2');
        expect(chosen).toMatchObject({ ok: true, data: { usdBalance: 3.25 } });
        expect(fake.callsTo('GET /account/balance').map((call) => call.path)).toEqual([
            '/account/balance',
            '/account/balance?keyId=key-2',
        ]);
    });

    it('passes the plugin error code through', async () => {
        fake.balances.delete('');
        const result = await fake.account.balance(null);
        expect(result).toMatchObject({ ok: false, error: { code: 'no_key', status: 409 } });
    });

    it('is an error value, not an exception, when the plugin is away', async () => {
        h.backend.plugin.up = false;
        expect(await fake.account.balance()).toMatchObject({ ok: false, error: { code: 'unreachable' } });
        h.backend.plugin.up = true;
        h.backend.plugin.installed = false;
        expect(await fake.account.balance()).toMatchObject({ ok: false, error: { code: 'not_installed' } });
    });

    it('refuses an answer that is not a balance', () => {
        expect(parseBalance('nope', 1)).toBeNull();
        expect(parseBalance({ usdBalance: '4.50', nanoBalance: 'x' }, 7)).toEqual({
            usdBalance: 4.5,
            nanoBalance: null,
            fetchedAt: 7,
        });
    });
});

describe('subscription', () => {
    it('returns the quota windows and the recommended mode', async () => {
        fake.subscription = SUBSCRIPTION;
        const result = await fake.account.subscription();
        expect(result).toMatchObject({ ok: true, data: { subscription: SUBSCRIPTION } });
    });

    it('treats null as "no subscription"', async () => {
        const result = await fake.account.subscription('key-1');
        expect(result).toMatchObject({ ok: true, data: { subscription: null } });
        expect(fake.calls.at(-1)?.path).toBe('/account/subscription?keyId=key-1');
    });

    it('refuses a subscription that is not a quota document', () => {
        expect(parseSubscriptionState({ subscription: { active: 'yes' } }, 1)).toBeNull();
        expect(parseSubscriptionState([], 1)).toBeNull();
        expect(parseSubscriptionState({ subscription: { active: false }, fetchedAt: 5 }, 1)).toEqual({
            subscription: {
                active: false,
                daily: { used: null, limit: null, resetsAt: null },
                weekly: { used: null, limit: null, resetsAt: null },
                recommendedMode: null,
            },
            fetchedAt: 5,
        });
    });
});

describe('spend', () => {
    it('asks for a range and sums the plugin log', async () => {
        fake.records.push(
            usageRecord({ at: 1000, connectionId: 'conn000001', model: 'a', costUsd: 0.5, equivalentUsd: 0.5 }),
            usageRecord({ at: 2000, connectionId: 'conn000002', model: 'b', costUsd: 0, equivalentUsd: 2 }),
            usageRecord({ at: 9000, connectionId: 'conn000001', model: 'a', costUsd: 9, equivalentUsd: 9 }),
        );
        const result = await fake.account.spend({ from: 0, to: 5000 });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.total).toMatchObject({ requests: 2, costUsd: 0.5, equivalentUsd: 2.5 });
        expect(result.data.byConnection.map((row) => row.connectionId)).toEqual(['conn000001', 'conn000002']);
        expect(result.data.byModel.map((row) => row.model)).toEqual(['a', 'b']);
        expect(fake.calls.at(-1)?.path).toBe('/spend?from=0&to=5000');
    });

    it('filters by connection', async () => {
        fake.records.push(
            usageRecord({ at: 1000, connectionId: 'conn000001' }),
            usageRecord({ at: 1000, connectionId: 'conn000002' }),
        );
        const result = await fake.account.spend({ from: 0, to: 5000 }, 'conn000002');
        expect(result).toMatchObject({ ok: true, data: { total: { requests: 1 } } });
        expect(fake.calls.at(-1)?.path).toBe('/spend?from=0&to=5000&connectionId=conn000002');
    });

    it('drops rows it cannot read and refuses a summary without totals', () => {
        const totals = {
            requests: 1,
            costUsd: 0.1,
            equivalentUsd: 0.2,
            promptTokens: 3,
            completionTokens: 4,
            cachedTokens: 0,
        };
        const parsed = parseSpend({
            from: 1,
            to: 2,
            total: totals,
            byDay: [{ day: '2026-01-01', ...totals }, { day: 5, ...totals }, 'junk'],
            byConnection: [
                { connectionId: null, ...totals },
                { connectionId: 'abc', requests: 'x' },
            ],
            byModel: 'not a list',
        });
        expect(parsed?.byDay.map((row) => row.day)).toEqual(['2026-01-01']);
        expect(parsed?.byConnection).toEqual([{ connectionId: null, ...totals }]);
        expect(parsed?.byModel).toEqual([]);
        expect(parseSpend({ from: 1, to: 2 })).toBeNull();
        expect(parseSpend({ from: 'a', to: 2, total: totals })).toBeNull();
    });

    it('reports an invalid answer instead of half a summary', async () => {
        fake.fail.clear();
        const odd = createPluginAccount({
            client: {
                request: async () => ({ ok: true as const, data: { hello: 'world' } }),
            },
        });
        expect(await odd.spend({ from: 0, to: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    });
});

describe('lookup', () => {
    it('answers "not ready" with no figure, never with zero', async () => {
        const result = await fake.account.lookup('req-1');
        expect(result).toEqual({ ok: true, data: { requestId: 'req-1', ready: false, costUsd: null } });
        expect(fake.calls.at(-1)).toEqual({ method: 'POST', path: '/lookup/req-1' });
    });

    it('returns the exact cost when it is ready, with the key and the id encoded', async () => {
        fake.lookups.set('req/2', { requestId: 'req/2', ready: true, costUsd: 0.0123 });
        const result = await fake.account.lookup('req/2', 'key-9');
        expect(result).toMatchObject({ ok: true, data: { ready: true, costUsd: 0.0123 } });
        expect(fake.calls.at(-1)?.path).toBe('/lookup/req%2F2?keyId=key-9');
    });

    it('never lets a not-ready answer carry a number', () => {
        expect(parseLookup({ requestId: 'r', ready: false, costUsd: 0 })).toEqual({
            requestId: 'r',
            ready: false,
            costUsd: null,
        });
        expect(parseLookup({ requestId: 'r', ready: true, costUsd: '0.5' })?.costUsd).toBe(0.5);
        expect(parseLookup({ requestId: 'r', ready: true, costUsd: -1 })?.costUsd).toBeNull();
        expect(parseLookup({ ready: true })).toBeNull();
    });

    it('passes a plugin failure through', async () => {
        fake.fail.set('POST /lookup', { status: 502, code: 'key_rejected' });
        expect(await fake.account.lookup('req-1')).toMatchObject({ ok: false, error: { code: 'key_rejected' } });
    });
});
