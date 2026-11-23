// Stage 0.4 admin routes: balance, subscription quota, request cost lookup and the spend summary, against NanoGPT's real
// payloads (served by small fake servers) and against the mock.
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mapBalance, mapSubscriptionUsage } from '../../src/server/routes/account';
import { parseUsageRecord, utcDay } from '../../src/server/usage-log';
import {
    NANO_KEY,
    boot,
    chat,
    cleanTempDirs,
    closedPort,
    startServer,
    waitFor,
    type Harness,
    type TestServer,
} from './helpers';
import { startMockStack, type MockStack } from './mock-stack';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanTempDirs();
});

const NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

/** A plugin whose site and API both point at one fake server. */
async function plugin(server: TestServer, extra: Parameters<typeof boot>[0] = {}): Promise<Harness> {
    const h = await boot({
        now: () => NOW,
        ...extra,
        config: {
            siteBase: server.origin,
            upstreamBase: `${server.origin}/api/v1`,
            upstreamFallbackBase: null,
            ...extra.config,
        },
    });
    closers.push(() => h.close());
    h.st.addNanoKey();
    return h;
}

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
    const server = await startServer(handler);
    closers.push(() => server.close());
    return server;
}

function json(res: Parameters<Parameters<typeof startServer>[0]>[1], status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function mockStack(extra: Parameters<typeof startMockStack>[0] = {}): Promise<MockStack> {
    const s = await startMockStack({ now: () => NOW, ...extra });
    closers.push(() => s.close());
    return s;
}

/* ------------------------------------------------------------------------------------------------ balance */

/** NanoGPT's real check-balance answer. */
const REAL_BALANCE = {
    usd_balance: '5.00000000',
    usd_pending_usage: 0,
    usd_spendable_balance: 5,
    nano_balance: '0.00000000',
    nanoDepositAddress: 'nano_1example',
};

describe('GET /account/balance', () => {
    it('maps the real check-balance payload (decimal strings become numbers) and calls it with x-api-key', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_BALANCE));
        const h = await plugin(site);
        const { status, json: body } = await h.api('GET', '/account/balance');
        expect(status).toBe(200);
        expect(body).toEqual({ usdBalance: 5, nanoBalance: 0, fetchedAt: NOW });
        expect(site.requests).toHaveLength(1);
        expect(site.requests[0]).toMatchObject({ method: 'POST', url: '/api/check-balance' });
        expect(site.requests[0]!.headers['x-api-key']).toBe(NANO_KEY);
    });

    it('uses the key of ?keyId, the active key otherwise, and rejects an unknown id', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_BALANCE));
        const h = await plugin(site);
        const other = h.st.addNanoKey('default-user', 'sk-nano-second-key-value-0000', 'second');
        h.st.writeSecret('default-user', 'api_key_nanogpt', 'sk-nano-third-key-value-1111', 'third'); // the active one
        await h.api('GET', `/account/balance?keyId=${other}`);
        await h.api('GET', '/account/balance');
        expect(site.requests.map((r) => r.headers['x-api-key'])).toEqual([
            'sk-nano-second-key-value-0000',
            'sk-nano-third-key-value-1111',
        ]);
        const unknown = await h.api('GET', '/account/balance?keyId=nope');
        expect(unknown.status).toBe(404);
        expect(unknown.json['error']).toMatchObject({ code: 'not_found' });
        expect(site.requests).toHaveLength(2);
    });

    it('keeps the keys of other users apart', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_BALANCE));
        const h = await plugin(site);
        h.st.addNanoKey('alice', 'sk-nano-alice-key-value-0000', 'alice');
        await h.api('GET', '/account/balance', undefined, 'alice');
        expect(site.requests[0]!.headers['x-api-key']).toBe('sk-nano-alice-key-value-0000');
        const bob = await h.api('GET', '/account/balance', undefined, 'bob');
        expect(bob.status).toBe(409);
        expect(bob.json['error']).toMatchObject({ code: 'no_key' });
    });

    it('reports missing fields as null and tolerates numbers', () => {
        expect(mapBalance({}, 1)).toEqual({ usdBalance: null, nanoBalance: null, fetchedAt: 1 });
        expect(mapBalance({ usd_balance: 12.5, nano_balance: 'garbage' }, 2)).toEqual({
            usdBalance: 12.5,
            nanoBalance: null,
            fetchedAt: 2,
        });
        expect(mapBalance({ usdBalance: '0.25', nanoBalance: '3' }, 3)).toMatchObject({
            usdBalance: 0.25,
            nanoBalance: 3,
        });
        expect(mapBalance({ usd_balance: '1e999' }, 4).usdBalance).toBeNull();
    });

    it('turns every failure into the admin error shape and never echoes the key', async () => {
        const cases: Array<[number, string, string]> = [
            [401, 'key_rejected', 'rejected the key'],
            [403, 'key_rejected', 'rejected the key'],
            [429, 'rate_limited', 'rate limiting'],
            [500, 'upstream_error', 'HTTP 500'],
        ];
        for (const [status, code, text] of cases) {
            const site = await serve((_req, res) => json(res, status, { error: `bad ${NANO_KEY}` }));
            const h = await plugin(site);
            const { status: got, json: body, text: raw } = await h.api('GET', '/account/balance');
            expect(got).toBe(status === 429 ? 429 : 502);
            expect(body['error']).toMatchObject({ code });
            expect(body['error'].message).toContain(text);
            expect(raw).not.toContain(NANO_KEY);
        }
    });

    it('502 bad_response for a body that is not JSON, upstream_unreachable when nothing listens', async () => {
        const site = await serve((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(`<html>${NANO_KEY}</html>`);
        });
        const h = await plugin(site);
        const html = await h.api('GET', '/account/balance');
        expect(html.status).toBe(502);
        expect(html.json['error']).toMatchObject({ code: 'bad_response' });
        expect(html.text).not.toContain(NANO_KEY);

        const dead = await closedPort();
        const other = await boot({ config: { siteBase: `http://127.0.0.1:${dead}`, upstreamFallbackBase: null } });
        closers.push(() => other.close());
        other.st.addNanoKey();
        const down = await other.api('GET', '/account/balance');
        expect(down.status).toBe(502);
        expect(down.json['error']).toMatchObject({ code: 'upstream_unreachable' });
    });

    it('works in degraded mode with the key of the config file, and says so without one', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_BALANCE));
        const h = await plugin(site, { config: { nanogptKey: 'sk-nano-from-config-file-0000' } });
        h.st.available = false;
        expect((await h.api('GET', '/account/balance')).json).toMatchObject({ usdBalance: 5 });
        expect(site.requests[0]!.headers['x-api-key']).toBe('sk-nano-from-config-file-0000');
        expect((await h.api('GET', '/account/balance?keyId=abc')).status).toBe(503);

        const bare = await plugin(site);
        bare.st.available = false;
        expect((await bare.api('GET', '/account/balance')).status).toBe(503);
    });

    it('reads the balance of the mock', async () => {
        const s = await mockStack();
        expect((await s.h.api('GET', '/account/balance')).json).toEqual({
            usdBalance: 25,
            nanoBalance: 4.8,
            fetchedAt: NOW,
        });
    });
});

/* ------------------------------------------------------------------------------------------------ subscription */

/** What an account without a subscription answers (observed live). */
const REAL_INACTIVE = {
    active: false,
    limits: { weeklyInputTokens: 60_000_000, dailyInputTokens: null, dailyImages: null },
    dailyInputTokens: null,
    weeklyInputTokens: { used: 0, remaining: 60_000_000, percentUsed: 0, resetAt: 1_795_996_800_000 },
    state: 'inactive',
    routing: {
        scope: 'text',
        recommendedMode: 'paygo',
        reason: 'subscription_inactive',
        billingMode: 'both',
        subscriptionRequestsPermitted: true,
        subscriptionQuotaAvailable: false,
        paidSpendPolicyAllowsBalance: true,
        paidOverageEnabled: false,
    },
};

describe('GET /account/subscription', () => {
    it('maps the real payload of an inactive account', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_INACTIVE));
        const h = await plugin(site);
        const { status, json: body } = await h.api('GET', '/account/subscription');
        expect(status).toBe(200);
        expect(body).toEqual({
            subscription: {
                active: false,
                daily: { used: null, limit: null, resetsAt: null },
                weekly: { used: 0, limit: 60_000_000, resetsAt: 1_795_996_800_000 },
                recommendedMode: 'paygo',
            },
            fetchedAt: NOW,
        });
        expect(site.requests[0]).toMatchObject({ method: 'GET', url: '/api/subscription/v1/usage' });
        expect(site.requests[0]!.headers['authorization']).toBe(`Bearer ${NANO_KEY}`);
        expect(site.requests[0]!.headers['x-api-key']).toBeUndefined();
    });

    it('maps an active account with a daily window like the weekly one', async () => {
        const active = {
            active: true,
            state: 'active',
            limits: { dailyInputTokens: 2_000_000, weeklyInputTokens: 10_000_000 },
            dailyInputTokens: { used: 500_000, remaining: 1_500_000, percentUsed: 0.25, resetAt: 1_795_910_400_000 },
            weeklyInputTokens: { used: 4_000_000, remaining: 6_000_000, percentUsed: 0.4, resetAt: 1_796_083_200_000 },
            routing: { recommendedMode: 'subscription', subscriptionQuotaAvailable: true },
        };
        const site = await serve((_req, res) => json(res, 200, active));
        const h = await plugin(site);
        expect((await h.api('GET', '/account/subscription')).json['subscription']).toEqual({
            active: true,
            daily: { used: 500_000, limit: 2_000_000, resetsAt: 1_795_910_400_000 },
            weekly: { used: 4_000_000, limit: 10_000_000, resetsAt: 1_796_083_200_000 },
            recommendedMode: 'subscription',
        });
    });

    it('maps the live mock: quota available, then used up', async () => {
        const s = await mockStack();
        const first = (await s.h.api('GET', '/account/subscription')).json['subscription'];
        expect(first).toMatchObject({
            active: true,
            daily: { used: 0, limit: 1_000_000 },
            weekly: { used: 0, limit: 6_000_000 },
            recommendedMode: 'subscription',
        });
        expect(first.daily.resetsAt).toBeGreaterThan(Date.now() - 1000);
        await fetch(`${s.origin}/__mock/state`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscription: { dailyUsed: 1_000_000 } }),
        });
        const used = (await s.h.api('GET', '/account/subscription')).json['subscription'];
        expect(used).toMatchObject({ daily: { used: 1_000_000, limit: 1_000_000 }, recommendedMode: 'paygo' });
    });

    it('null subscription when the endpoint is not there for this key, an error when the key is refused', async () => {
        for (const status of [404, 403]) {
            const site = await serve((_req, res) => json(res, status, { error: 'nope' }));
            const h = await plugin(site);
            expect((await h.api('GET', '/account/subscription')).json).toEqual({ subscription: null, fetchedAt: NOW });
        }
        const refused = await serve((_req, res) => json(res, 401, { error: `bad ${NANO_KEY}` }));
        const h = await plugin(refused);
        const answer = await h.api('GET', '/account/subscription');
        expect(answer.status).toBe(502);
        expect(answer.json['error']).toMatchObject({ code: 'key_rejected' });
        expect(answer.text).not.toContain(NANO_KEY);
        const broken = await serve((_req, res) => json(res, 500, '{}'));
        expect((await (await plugin(broken)).api('GET', '/account/subscription')).json['error']).toMatchObject({
            code: 'upstream_error',
        });
    });

    it('null subscription for a payload that is not a quota document', async () => {
        for (const body of ['{}', '[]', '"x"', 'not json', '{"limits":{}}']) {
            const site = await serve((_req, res) => json(res, 200, body));
            const h = await plugin(site);
            expect((await h.api('GET', '/account/subscription')).json).toEqual({ subscription: null, fetchedAt: NOW });
        }
    });

    it('mapSubscriptionUsage is tolerant about shapes', () => {
        // ISO strings and second timestamps, a limit derived from used + remaining, 'unavailable' advice
        expect(
            mapSubscriptionUsage({
                active: true,
                dailyInputTokens: { used: 10, remaining: 90, resetAt: '2026-03-16T00:00:00Z' },
                weeklyInputTokens: { used: 1, remaining: 9, resetAt: 1_773_619_200 },
                routing: { recommendedMode: 'unavailable' },
            }),
        ).toEqual({
            active: true,
            daily: { used: 10, limit: 100, resetsAt: Date.UTC(2026, 2, 16) },
            weekly: { used: 1, limit: 10, resetsAt: 1_773_619_200_000 },
            recommendedMode: null,
        });
        // `state` stands in for a missing `active`; junk numbers are null
        expect(
            mapSubscriptionUsage({ state: 'active', weeklyInputTokens: { used: 'many', remaining: -1, resetAt: 0 } }),
        ).toEqual({
            active: true,
            daily: { used: null, limit: null, resetsAt: null },
            weekly: { used: null, limit: null, resetsAt: null },
            recommendedMode: null,
        });
        expect(mapSubscriptionUsage({ state: 'inactive' })).toMatchObject({ active: false });
        expect(mapSubscriptionUsage(null)).toBeNull();
        expect(mapSubscriptionUsage({ unrelated: true })).toBeNull();
    });
});

/* ------------------------------------------------------------------------------------------------ lookup */

describe('POST /lookup/:requestId', () => {
    const REAL_LOOKUP = {
        object: 'request_billing',
        request_id: 'req_abc123',
        cost: '0.0000023',
        currency: 'USD',
        cost_scope: 'primary_charge',
        usage: { input_tokens: 10, output_tokens: 4 },
    };

    it('reads the cost of a request from NanoGPT (decimal string to number), with the key as a bearer token', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_LOOKUP));
        const h = await plugin(site);
        const { status, json: body } = await h.api('POST', '/lookup/req_abc123');
        expect(status).toBe(200);
        expect(body).toEqual({ requestId: 'req_abc123', ready: true, costUsd: 0.0000023 });
        expect(site.requests[0]).toMatchObject({ method: 'GET', url: '/api/v1/usage/requests/req_abc123' });
        expect(site.requests[0]!.headers['authorization']).toBe(`Bearer ${NANO_KEY}`);
    });

    it('404 is "not ready yet", never a zero', async () => {
        const site = await serve((_req, res) => json(res, 404, { error: { code: 'request_not_found' } }));
        const h = await plugin(site);
        const { status, json: body } = await h.api('POST', '/lookup/req_later');
        expect(status).toBe(200);
        expect(body).toEqual({ requestId: 'req_later', ready: false, costUsd: null });
    });

    it('a real zero is a zero; a paid amount in another currency is not dollars', async () => {
        const answers = [
            { ...REAL_LOOKUP, cost: '0.00000000' },
            { ...REAL_LOOKUP, cost: '0.0003', currency: 'XNO' },
            { ...REAL_LOOKUP, cost: '0', currency: 'XNO' },
            { ...REAL_LOOKUP, cost: 'free' },
        ];
        const costs: Array<number | null> = [];
        for (const answer of answers) {
            const site = await serve((_req, res) => json(res, 200, answer));
            const body = (await (await plugin(site)).api('POST', '/lookup/req_abc123')).json;
            expect(body['ready']).toBe(true);
            costs.push(body['costUsd']);
        }
        expect(costs).toEqual([0, null, 0, null]);
    });

    it('refuses ids that are not request ids, and encodes the id it sends', async () => {
        const site = await serve((_req, res) => json(res, 200, REAL_LOOKUP));
        const h = await plugin(site);
        for (const bad of ['a b', 'a%2Fb', 'x'.repeat(201), '..%2F..%2Fkeys']) {
            const answer = await h.api('POST', `/lookup/${bad}`);
            expect(answer.status).toBe(400);
            expect(answer.json['error']).toMatchObject({ code: 'invalid_request' });
        }
        expect(site.requests).toHaveLength(0);
        await h.api('POST', '/lookup/req_1:2.3-4');
        expect(site.requests[0]!.url).toBe('/api/v1/usage/requests/req_1%3A2.3-4');
    });

    it('finds the charge of a request the proxy made, only with the key that made it', async () => {
        const s = await mockStack();
        const { view, token } = await s.h.connect({ modelId: 'anthropic/claude-sonnet-5.5', modelLock: true });
        const response = await chat(s.h, view.id, token, { messages: [{ role: 'user', content: 'hello there' }] });
        const body: any = await response.json();
        const requestId = response.headers.get('x-nanovia-request-id')!;
        const found = await s.h.api('POST', `/lookup/${requestId}`);
        expect(found.json).toMatchObject({ requestId, ready: true });
        expect(found.json['costUsd']).toBeCloseTo(body.usage.cost, 7);
        expect(found.json['costUsd']).toBeGreaterThan(0);

        const other = s.h.st.addNanoKey('default-user', 'sk-nano-another-key-value-9999', 'another');
        const foreign = await s.h.api('POST', `/lookup/${requestId}?keyId=${other}`);
        expect(foreign.json).toEqual({ requestId, ready: false, costUsd: null });
        expect((await s.h.api('POST', '/lookup/req_does_not_exist')).json).toMatchObject({ ready: false });
    });
});

/* ------------------------------------------------------------------------------------------------ spend */

function record(at: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        at,
        connectionId: 'conn0001',
        requestId: `req_${at}`,
        model: 'z-ai/glm-5.3',
        billing: 'paygo',
        costUsd: 0.01,
        equivalentUsd: 0.01,
        promptTokens: 100,
        completionTokens: 10,
        cachedTokens: 0,
        reasoningTokens: 0,
        latencyMs: 500,
        status: 200,
        stream: false,
        consumer: 'main',
        error: null,
        ...extra,
    };
}

/** Writes `usage-<day>.jsonl` of a user as lines (objects are serialised, strings kept as they are). */
function writeUsage(
    h: Harness,
    day: string,
    lines: Array<Record<string, unknown> | string>,
    user = 'default-user',
): void {
    const dir = path.join(h.st.userRoot(user), 'nanovia');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, `usage-${day}.jsonl`),
        lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n',
    );
}

const DAY = 86_400_000;

describe('GET /spend', () => {
    it('sums the usage log over the range: total, per UTC day, per connection, per model', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        const d1 = Date.UTC(2026, 2, 10, 10);
        const d2 = Date.UTC(2026, 2, 11, 23, 59, 59);
        const d3 = Date.UTC(2026, 2, 12, 0, 0, 0);
        writeUsage(h, '2026-03-10', [
            record(d1),
            record(d1 + 1000, { costUsd: 0, billing: 'subscription', equivalentUsd: 0.5 }),
        ]);
        writeUsage(h, '2026-03-11', [
            record(d2, { connectionId: 'conn0002', model: 'deepseek/x', costUsd: 0.2, equivalentUsd: 0.2 }),
        ]);
        writeUsage(h, '2026-03-12', [record(d3)]);
        const { status, json: body } = await h.api('GET', `/spend?from=${d1}&to=${d3 + 1}`);
        expect(status).toBe(200);
        expect(body['from']).toBe(d1);
        expect(body['to']).toBe(d3 + 1);
        expect(body['total']).toMatchObject({
            requests: 4,
            costUsd: 0.22,
            equivalentUsd: 0.72,
            promptTokens: 400,
            completionTokens: 40,
        });
        expect(body['byDay'].map((d: any) => [d.day, d.requests])).toEqual([
            ['2026-03-10', 2],
            ['2026-03-11', 1],
            ['2026-03-12', 1],
        ]);
        expect(body['byConnection'].map((c: any) => [c.connectionId, c.costUsd])).toEqual([
            ['conn0002', 0.2],
            ['conn0001', 0.02],
        ]);
        expect(body['byModel'].map((m: any) => m.model)).toEqual(['deepseek/x', 'z-ai/glm-5.3']);
    });

    it('takes records with from <= at < to, and only reads the days it needs', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        const noon = Date.UTC(2026, 2, 10, 12);
        writeUsage(h, '2026-03-10', [record(noon - 1), record(noon), record(noon + 1)]);
        writeUsage(h, '2026-03-09', ['this day is not even read']);
        expect((await h.api('GET', `/spend?from=${noon}&to=${noon + 1}`)).json['total']).toMatchObject({ requests: 1 });
        expect((await h.api('GET', `/spend?from=${noon}&to=${noon}`)).status).toBe(400);
        expect((await h.api('GET', `/spend?from=${noon + 5}&to=${noon}`)).status).toBe(400);
    });

    it('filters by connection and keeps users apart', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        const at = Date.UTC(2026, 2, 10, 10);
        writeUsage(h, '2026-03-10', [
            record(at),
            record(at + 1, { connectionId: 'conn0002' }),
            record(at + 2, { connectionId: null }),
        ]);
        writeUsage(h, '2026-03-10', [record(at + 3)], 'alice');
        const range = `from=${at - 1}&to=${at + 100}`;
        expect((await h.api('GET', `/spend?${range}`)).json['total'].requests).toBe(3);
        const one = (await h.api('GET', `/spend?${range}&connectionId=conn0002`)).json;
        expect(one['total'].requests).toBe(1);
        expect(one['byConnection']).toHaveLength(1);
        expect((await h.api('GET', `/spend?${range}`, undefined, 'alice')).json['total'].requests).toBe(1);
        expect((await h.api('GET', `/spend?${range}`, undefined, 'bob')).json['total'].requests).toBe(0);
        expect((await h.api('GET', `/spend?${range}&connectionId=${'x'.repeat(65)}`)).status).toBe(400);
    });

    it('survives corrupt lines, foreign shapes and a half-written last line', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        const at = Date.UTC(2026, 2, 10, 10);
        writeUsage(h, '2026-03-10', [
            '{ not json',
            '[1,2,3]',
            '"string"',
            'null',
            JSON.stringify({ model: 'no at' }),
            JSON.stringify({ at: 'soon' }),
            '',
            '   ',
            record(at),
            JSON.stringify({ at: at + 1, costUsd: 'free', promptTokens: -5, model: 7 }),
            JSON.stringify(record(at + 2)).slice(0, 40),
        ]);
        const body = (await h.api('GET', `/spend?from=${at - 1}&to=${at + 100}`)).json;
        expect(body['total']).toMatchObject({ requests: 2, costUsd: 0.01, promptTokens: 100 });
        expect(body['byModel'].map((m: any) => m.model).sort()).toEqual(['unknown', 'z-ai/glm-5.3']);
    });

    it('answers an empty summary when nothing was ever logged, and defaults to the last 30 days', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        const empty = (await h.api('GET', '/spend')).json;
        expect(empty).toMatchObject({
            from: NOW + 1 - 30 * DAY,
            to: NOW + 1,
            total: { requests: 0, costUsd: 0, equivalentUsd: 0 },
            byDay: [],
            byConnection: [],
            byModel: [],
        });
        writeUsage(h, '2026-03-14', [record(NOW - DAY)]);
        writeUsage(h, '2026-02-01', [record(NOW - 42 * DAY)]);
        writeUsage(h, '2026-03-15', [record(NOW)]);
        expect((await h.api('GET', '/spend')).json['total'].requests).toBe(2); // the record of "now" is in, 42 days ago is out
        expect((await h.api('GET', `/spend?to=${NOW - 2 * DAY}`)).json['total'].requests).toBe(0);
    });

    it('rejects values that are not milliseconds', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        for (const query of ['from=yesterday', 'to=abc', 'from=1&to=NaN', 'from=Infinity']) {
            const answer = await h.api('GET', `/spend?${query}`);
            expect(answer.status).toBe(400);
            expect(answer.json['error']).toMatchObject({ code: 'invalid_request' });
        }
    });

    it('shows the requests the proxy just logged: a subscription request counts as a request with cost 0', async () => {
        const s = await mockStack({ now: undefined });
        const { view, token } = await s.h.connect({ modelId: 'deepseek/deepseek-v4.1-flash', modelLock: true });
        await (await chat(s.h, view.id, token, { messages: [{ role: 'user', content: 'hello there' }] })).text();
        await waitFor(() => s.h.usage().length > 0);
        const summary = (await s.h.api('GET', `/spend?connectionId=${view.id}`)).json;
        expect(summary['total']).toMatchObject({ requests: 1, costUsd: 0 });
        expect(summary['total'].equivalentUsd).toBeGreaterThan(0);
        expect(summary['total'].promptTokens).toBeGreaterThan(0);
        expect(summary['byModel']).toEqual([
            expect.objectContaining({ model: 'deepseek/deepseek-v4.1-flash', requests: 1 }),
        ]);
    });
});

describe('GET /usage/recent', () => {
    it('returns the newest records first, within the limit, and honours `since`', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        writeUsage(h, '2026-03-14', [record(NOW - DAY), record(NOW - DAY + 1000)]);
        writeUsage(h, '2026-03-15', [record(NOW - 3000), record(NOW - 2000), record(NOW - 1000)]);
        const all = (await h.api('GET', '/usage/recent')).json['records'] as Array<{ at: number }>;
        expect(all.map((r) => r.at)).toEqual([NOW - 1000, NOW - 2000, NOW - 3000, NOW - DAY + 1000, NOW - DAY]);
        const two = (await h.api('GET', '/usage/recent?limit=2')).json['records'] as Array<{ at: number }>;
        expect(two.map((r) => r.at)).toEqual([NOW - 1000, NOW - 2000]);
        const fresh = (await h.api('GET', `/usage/recent?since=${NOW - 2000}`)).json['records'] as Array<{
            at: number;
        }>;
        expect(fresh.map((r) => r.at)).toEqual([NOW - 1000]);
        const none = (await h.api('GET', `/usage/recent?since=${NOW}`)).json['records'] as unknown[];
        expect(none).toHaveLength(0);
    });

    it('leaves out what is older than a week, filters by connection and keeps users apart', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        writeUsage(h, '2026-03-01', [record(NOW - 14 * DAY)]);
        writeUsage(h, '2026-03-15', [record(NOW - 2000), record(NOW - 1000, { connectionId: 'conn0002' })]);
        writeUsage(h, '2026-03-15', [record(NOW - 500)], 'alice');
        expect((await h.api('GET', '/usage/recent')).json['records']).toHaveLength(2);
        expect((await h.api('GET', '/usage/recent?connectionId=conn0002')).json['records']).toHaveLength(1);
        expect((await h.api('GET', '/usage/recent', undefined, 'alice')).json['records']).toHaveLength(1);
        expect((await h.api('GET', '/usage/recent', undefined, 'bob')).json['records']).toHaveLength(0);
    });

    it('refuses nonsense parameters', async () => {
        const site = await serve((_req, res) => json(res, 200, {}));
        const h = await plugin(site);
        const long = 'x'.repeat(65);
        for (const query of ['limit=0', 'limit=301', 'limit=2.5', 'limit=abc', 'since=abc', `connectionId=${long}`]) {
            expect((await h.api('GET', `/usage/recent?${query}`)).status, query).toBe(400);
        }
    });
});

describe('usage log reading helpers', () => {
    it('parseUsageRecord coerces what a hand-edited line may get wrong', () => {
        expect(parseUsageRecord('{"at": 5}')).toEqual({
            at: 5,
            connectionId: null,
            requestId: null,
            model: 'unknown',
            billing: 'unknown',
            costUsd: null,
            equivalentUsd: null,
            promptTokens: null,
            completionTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
            latencyMs: 0,
            status: 0,
            stream: false,
            consumer: 'unknown',
            error: null,
        });
        expect(
            parseUsageRecord('{"at":5,"billing":"weird","consumer":"x","costUsd":"1","stream":"yes"}'),
        ).toMatchObject({
            billing: 'unknown',
            consumer: 'unknown',
            costUsd: null,
            stream: false,
        });
        for (const bad of ['', '{', '[]', '7', '{"at":null}', '{"at":"5"}', '{"at":1e999}']) {
            expect(parseUsageRecord(bad)).toBeNull();
        }
    });

    it('utcDay names the UTC day and never throws', () => {
        expect(utcDay(Date.UTC(2026, 2, 15, 23, 59, 59, 999))).toBe('2026-03-15');
        expect(utcDay(Date.UTC(2026, 2, 16))).toBe('2026-03-16');
        expect(utcDay(Number.NaN)).toBe('1970-01-01');
        expect(utcDay(9e30)).toBe('9999-12-31');
        expect(utcDay(-9e30)).toBe('1970-01-01');
    });
});
