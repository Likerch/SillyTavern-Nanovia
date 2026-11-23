// The stage 0.4 routes of the plugin's admin API for browser-side tests: balance, subscription, spend and cost lookup.
// It wraps a harness's FakeBackend (everything else is delegated to it, and `backend.plugin.up/installed` apply here
// too) and hands out a plugin client and the typed PluginAccount over the wrapped fetch.
import { createPluginAccount } from '../../src/host/plugin-account';
import type { PluginAccount } from '../../src/host/plugin-account';
import { createPluginClient } from '../../src/host/plugin-client';
import type { PluginClient } from '../../src/host/plugin-client';
import { summarizeUsage } from '../../src/domain/usage';
import type { UsageRecord } from '../../src/shared/contracts';
import type { RequestCostLookup, SubscriptionUsage } from '../../src/shared/contracts-account';
import type { Harness } from './harness';

const PREFIX = '/api/plugins/nanovia';

export interface AccountCall {
    method: string;
    /** Path and query, without the plugin prefix. */
    path: string;
}

export interface AccountFake {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    client: PluginClient;
    account: PluginAccount;
    /** The plugin's usage log (what GET /spend sums). */
    records: UsageRecord[];
    /** Balance in USD per key id ('' = the active key); a missing entry answers 409 no_key. */
    balances: Map<string, number | null>;
    nanoBalance: number | null;
    /** The subscription the account has; null = none. */
    subscription: SubscriptionUsage | null;
    /** Answers of POST /lookup/:id; a missing id is "not ready". */
    lookups: Map<string, RequestCostLookup>;
    /** Fixed failures by route ('GET /spend', 'POST /lookup'): they answer until removed. */
    fail: Map<string, { status: number; code: string; message?: string }>;
    calls: AccountCall[];
    callsTo(route: string): AccountCall[];
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function createAccountFake(h: Harness): AccountFake {
    const fake: AccountFake = {
        fetch: async () => new Response('unset', { status: 500 }),
        client: undefined as unknown as PluginClient,
        account: undefined as unknown as PluginAccount,
        records: [],
        balances: new Map([['', 12.5]]),
        nanoBalance: null,
        subscription: null,
        lookups: new Map(),
        fail: new Map(),
        calls: [],
        callsTo: (route) =>
            fake.calls.filter((call) => `${call.method} ${call.path.split('?')[0]}`.startsWith(route)),
    };
    let clock = 1_800_000_000_000;

    function route(method: string, full: string): Response | null {
        const [path = '', query = ''] = full.split('?');
        const params = new URLSearchParams(query);
        const failure = fake.fail.get(`${method} ${path.startsWith('/lookup') ? '/lookup' : path}`);
        if (failure) {
            return json({ error: { code: failure.code, message: failure.message ?? failure.code } }, failure.status);
        }
        if (method === 'GET' && path === '/account/balance') {
            const keyId = params.get('keyId') ?? '';
            if (!fake.balances.has(keyId)) return json({ error: { code: 'no_key', message: 'no key' } }, 409);
            return json({ usdBalance: fake.balances.get(keyId), nanoBalance: fake.nanoBalance, fetchedAt: ++clock });
        }
        if (method === 'GET' && path === '/account/subscription') {
            return json({ subscription: fake.subscription, fetchedAt: ++clock });
        }
        if (method === 'GET' && path === '/spend') {
            const from = Number(params.get('from') ?? 0);
            const to = Number(params.get('to') ?? Date.now() + 1);
            const connectionId = params.get('connectionId');
            const day = (at: number): string => new Date(at).toISOString().slice(0, 10);
            return json(summarizeUsage(fake.records, { from, to }, day, connectionId ? { connectionId } : {}));
        }
        const lookup = /^\/lookup\/([^/]+)$/.exec(path);
        if (method === 'POST' && lookup) {
            const requestId = decodeURIComponent(lookup[1] ?? '');
            return json(fake.lookups.get(requestId) ?? { requestId, ready: false, costUsd: null });
        }
        return null;
    }

    fake.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(PREFIX)) return h.backend.fetch(input, init);
        const method = (init?.method ?? 'GET').toUpperCase();
        const full = url.slice(PREFIX.length);
        const answer = route(method, full);
        if (!answer) return h.backend.fetch(input, init);
        fake.calls.push({ method, path: full });
        if (!h.backend.plugin.up) throw new TypeError('Failed to fetch');
        if (!h.backend.plugin.installed) return new Response('<html>Cannot GET</html>', { status: 404 });
        return answer;
    };
    fake.client = createPluginClient({
        ctx: () => h.mock.context,
        log: h.log,
        fetchImpl: fake.fetch,
        ttlMs: 0,
        timeoutMs: 200,
    });
    fake.account = createPluginAccount({ client: fake.client });
    return fake;
}

/** A usage record with everything filled; override what the test cares about. */
export function usageRecord(patch: Partial<UsageRecord> = {}): UsageRecord {
    return {
        at: 1_800_000_000_000,
        connectionId: null,
        requestId: null,
        model: 'm',
        billing: 'paygo',
        costUsd: 0.01,
        equivalentUsd: 0.01,
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 0,
        reasoningTokens: 0,
        latencyMs: 1000,
        status: 200,
        stream: true,
        consumer: 'main',
        error: null,
        ...patch,
    };
}
