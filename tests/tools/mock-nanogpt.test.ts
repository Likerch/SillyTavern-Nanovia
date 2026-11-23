/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer } from '../../tools/mock-nanogpt/server.mjs';

const KEY = 'sk-nano-test0123456789wxyz';
const MGMT = 'sk-nano-mgmt-test0123456789';
const FLASH = 'deepseek/deepseek-v4.1-flash-1017';

let mock: ReturnType<typeof createMockServer>;
let base: string;

beforeAll(async () => {
    mock = createMockServer();
    base = `http://127.0.0.1:${await mock.listen(0)}`;
});
afterAll(() => mock.close());
beforeEach(async () => {
    await fetch(`${base}/__mock/reset`, { method: 'POST' });
});

const auth = (key = KEY) => ({ Authorization: `Bearer ${key}` });
const json = (res: Response): Promise<any> => res.json();
const get = (route: string, headers: Record<string, string> = {}) => fetch(base + route, { headers });
const send = (method: string, route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + route, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
const chat = (body: Record<string, unknown>, headers: Record<string, string> = auth()) =>
    send(
        'POST',
        '/api/v1/chat/completions',
        { messages: [{ role: 'user', content: 'Hello there' }], model: FLASH, ...body },
        headers,
    );

/** Reads a whole SSE response: the parsed frames and whether `[DONE]` closed it. */
async function sse(res: Response): Promise<{ frames: any[]; done: boolean }> {
    const text = await res.text();
    const payloads = text
        .split('\n\n')
        .map((block) => block.replace(/^data: /, '').trim())
        .filter(Boolean);
    return {
        frames: payloads.filter((p) => p !== '[DONE]').map((p) => JSON.parse(p)),
        done: payloads.at(-1) === '[DONE]',
    };
}

describe('fixtures', () => {
    it('keeps about sixty real models and the mock ones, with the families that matter for roleplay', () => {
        const ids = mock.catalog.models.map((m: any) => m.id) as string[];
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.filter((id) => !id.startsWith('mock/')).length).toBeGreaterThanOrEqual(55);
        expect(ids.filter((id) => id.startsWith('mock/')).length).toBeGreaterThanOrEqual(6);
        for (const family of [
            /^deepseek\/deepseek-v4\.1-flash/,
            /^z-ai\/glm-5\.3/,
            /^xiaomi\/mimo-v2\.6/,
            /^moonshotai\/kimi-k3/,
            /^google\/gemini-4/,
            /^anthropic\/claude-(sonnet|opus)-5/,
            /^x-ai\/grok-4/,
            /^qwen\/qwen3\.8/,
            /^tencent\/hy4/,
            /^minimax\/minimax-m3/,
            /^aion-labs\/aion-3\.5/,
            /^venice-uncensored$/,
            /^pqhaz\//,
        ]) {
            expect(
                ids.some((id) => family.test(id)),
                String(family),
            ).toBe(true);
        }
    });

    it('holds no key-like secret', () => {
        const dir = path.resolve(__dirname, '../../tools/fixtures');
        const files = [
            path.join(dir, 'catalog.json'),
            ...fs.readdirSync(path.join(dir, 'providers')).map((f) => path.join(dir, 'providers', f)),
        ];
        for (const file of files)
            expect(fs.readFileSync(file, 'utf8'), file).not.toMatch(/sk-[A-Za-z0-9_-]{12,}|Bearer /);
    });
});

describe('catalog routes', () => {
    it('lists ids only, and the detailed shape on request, without a key', async () => {
        const plain = await json(await get('/api/v1/models'));
        expect(plain.object).toBe('list');
        expect(plain.data[0]).toEqual({
            id: expect.any(String),
            object: 'model',
            created: expect.any(Number),
            owned_by: expect.any(String),
        });
        const detailed = await json(await get('/api/v1/models?detailed=true'));
        expect(detailed.data).toHaveLength(plain.data.length);
        const model = detailed.data.find((m: any) => m.id === FLASH);
        expect(model).toMatchObject({
            name: expect.any(String),
            context_length: expect.any(Number),
            capabilities: { reasoning: true, structured_output: true },
            reasoning_efforts: expect.arrayContaining(['none', 'low']),
            pricing: {
                prompt: expect.any(Number),
                completion: expect.any(Number),
                cacheReadInputPer1kTokens: expect.any(Number),
                unit: 'per_million_tokens',
            },
            subscription: { included: true, inputTokenMultiplier: 1 },
        });
        expect(model.providers.length).toBeGreaterThan(3);
    });

    it('serves provider snapshots, synthetic providers, "no selection" and 404', async () => {
        const snapshot = await json(await get(`/api/models/${encodeURIComponent('z-ai/glm-5.3')}/providers`));
        expect(snapshot.supportsProviderSelection).toBe(true);
        expect(snapshot.providers.length).toBeGreaterThan(5);
        expect(snapshot.providers[0]).toMatchObject({
            provider: expect.any(String),
            pricing: { inputPer1kTokens: expect.any(Number), outputPer1kTokens: expect.any(Number) },
        });
        expect(snapshot.providers.some((p: any) => p.quantization && p.tps && p.ttftMs && p.uptime)).toBe(true);
        expect(snapshot).toMatchObject({
            autoTps: expect.any(Number),
            autoTtftMs: expect.any(Number),
            autoCacheReadRate: expect.any(Number),
        });

        const synthetic = await json(await get(`/api/models/${encodeURIComponent('z-ai/glm-5.1')}/providers`));
        expect(synthetic.supportsProviderSelection).toBe(true);
        expect(synthetic.providers.length).toBeGreaterThan(0);

        for (const id of ['venice-uncensored', 'mock/no-selection']) {
            const fixed = await json(await get(`/api/models/${encodeURIComponent(id)}/providers`));
            expect(fixed.supportsProviderSelection, id).toBe(false);
            expect(fixed.providers).toBeUndefined();
        }
        const mine = await json(await get(`/api/models/${encodeURIComponent('mock/uncensored-rp')}/providers`));
        expect(mine.providers.map((p: any) => p.quantization)).toEqual(['fp8', 'int4', 'bf16']);

        const missing = await get(`/api/models/${encodeURIComponent('nope/none')}/providers`);
        expect(missing.status).toBe(404);
    });
});

describe('authentication', () => {
    it('refuses a missing, malformed or management key', async () => {
        const none = await chat({}, {});
        expect(none.status).toBe(401);
        expect((await json(none)).error.type).toBe('missing_api_key');
        const malformed = await chat({}, auth('sk-nope'));
        expect(malformed.status).toBe(401);
        expect((await json(malformed)).error.code).toBe('malformed_api_key');
        const mgmt = await chat({}, auth(MGMT));
        expect((await json(mgmt)).error.code).toBe('invalid_api_key');
    });

    it('accepts x-api-key', async () => {
        expect((await chat({}, { 'x-api-key': KEY })).status).toBe(200);
        expect((await send('POST', '/api/check-balance', undefined, { 'x-api-key': KEY })).status).toBe(200);
    });
});

describe('chat completions', () => {
    it('answers without usage unless asked, and with usage and NanoGPT pricing when asked', async () => {
        const plain = await json(await chat({}));
        expect(plain.choices[0].message).toMatchObject({
            role: 'assistant',
            content: expect.stringContaining('Hello there'),
        });
        expect(plain.usage).toBeUndefined();
        for (const ask of [
            { usage: { include: true } },
            { stream_options: { include_usage: true } },
            { include_usage: true },
        ]) {
            const body = await json(await chat(ask));
            expect(body.usage).toMatchObject({
                prompt_tokens: expect.any(Number),
                completion_tokens: expect.any(Number),
                total_tokens: body.usage.prompt_tokens + body.usage.completion_tokens,
                prompt_tokens_details: { cached_tokens: 0 },
                currency: 'USD',
            });
            expect(body.x_nanogpt_pricing).toMatchObject({
                cost: 0,
                paymentSource: 'subscription',
                isEstimate: false,
                requestId: expect.stringMatching(/^req_/),
            });
        }
    });

    it('returns X-Request-ID, matching the billing lookup, for the same key only', async () => {
        const res = await chat({ usage: { include: true } });
        const id = res.headers.get('x-request-id')!;
        const body = await json(res);
        expect(body.x_nanogpt_pricing.requestId).toBe(id);
        const found = await json(await get(`/api/v1/usage/requests/${id}`, auth()));
        expect(found).toMatchObject({
            object: 'request_billing',
            request_id: id,
            cost: '0.00000000',
            currency: 'USD',
            cost_scope: 'primary_charge',
        });
        expect(found.usage.input_tokens).toBe(body.usage.prompt_tokens);
        const unknown = await get('/api/v1/usage/requests/req_unknown', auth());
        expect(unknown.status).toBe(404);
        expect(unknown.headers.get('retry-after')).toBe('30');
        expect((await get(`/api/v1/usage/requests/${id}`, auth('sk-nano-someone-else-0000'))).status).toBe(404);
    });

    it('bills the subscription at 0 and everything that leaves it at a price', async () => {
        const covered = await json(await chat({ usage: { include: true } }));
        expect(covered.usage.cost).toBe(0);

        const paygo = await json(await chat({ usage: { include: true } }, { ...auth(), 'X-Billing-Mode': 'paygo' }));
        expect(paygo.usage.cost).toBeGreaterThan(0);
        expect(paygo.x_nanogpt_pricing.paymentSource).toBe('USD');

        const withProvider = await json(
            await chat({ usage: { include: true }, provider: { order: ['river'], allow_fallbacks: false } }),
        );
        expect(withProvider.usage.cost).toBeGreaterThan(0);
        const byHeader = await json(await chat({ usage: { include: true } }, { ...auth(), 'X-Provider': 'river' }));
        expect(byHeader.usage.cost).toBeGreaterThan(0);

        const notIncluded = await json(await chat({ model: 'anthropic/claude-sonnet-5.5', usage: { include: true } }));
        expect(notIncluded.x_nanogpt_pricing.paymentSource).toBe('USD');
        expect(notIncluded.usage.cost).toBeGreaterThan(0);

        const balance = await json(await send('POST', '/api/check-balance', undefined, auth()));
        expect(Number(balance.usd_balance)).toBeLessThan(25);
        expect(typeof balance.usd_balance).toBe('string');
        expect(typeof balance.nano_balance).toBe('string');
    });

    it('prices cached tokens separately', async () => {
        const body = await json(
            await chat(
                { model: 'mock/paid-premium', usage: { include: true } },
                { ...auth(), 'x-mock-cached-tokens': '4' },
            ),
        );
        expect(body.usage.prompt_tokens_details.cached_tokens).toBe(4);
        expect(body.x_nanogpt_pricing.cacheCost).toBeGreaterThan(0);
    });

    it('applies suffix models by echoing them back', async () => {
        for (const [model, suffixes] of [
            [`${FLASH}:online`, 'online'],
            [`${FLASH}:memory-7`, 'memory-7'],
            [`${FLASH}:online:memory`, 'online,memory'],
        ] as const) {
            const res = await chat({ model });
            expect(res.status).toBe(200);
            expect(res.headers.get('x-mock-applied-suffixes')).toBe(suffixes);
            expect((await json(res)).model).toBe(model);
        }
        // `:thinking` is part of a catalog id here, not a suffix to peel off.
        const thinking = await chat({ model: `${FLASH}:thinking` });
        expect(thinking.headers.get('x-mock-applied-suffixes')).toBeNull();
        expect((await chat({ model: 'nope/none' })).status).toBe(404);
        expect((await json(await chat({ model: 'nope/none' }))).error.code).toBe('model_not_found');
    });

    it('validates the body', async () => {
        const bad = await fetch(`${base}/api/v1/chat/completions`, { method: 'POST', headers: auth(), body: '{oops' });
        expect(bad.status).toBe(400);
        expect((await json(bad)).error.code).toBe('invalid_json');
        expect((await chat({ model: undefined })).status).toBe(400);
        expect((await chat({ messages: [] })).status).toBe(400);
        expect((await chat({ provider: { data_collection: 'deny' } })).status).toBe(400);
        expect((await chat({ model: 'mock/paused' })).status).toBe(503);
    });

    it('stops at max_tokens', async () => {
        const body = await json(await chat({ max_tokens: 3 }));
        expect(body.choices[0].finish_reason).toBe('length');
        expect(body.choices[0].message.content.length).toBe(12);
    });
});

describe('reasoning', () => {
    const reasoner = 'mock/subscription-reasoner';

    it('returns reasoning text for reasoning models and hides it on request', async () => {
        expect((await json(await chat({ model: reasoner }))).choices[0].message.reasoning).toContain('default effort');
        const high = await json(
            await chat({ model: reasoner, reasoning: { effort: 'high' }, usage: { include: true } }),
        );
        expect(high.choices[0].message.reasoning).toContain('high effort');
        expect(high.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        const hidden = await json(
            await chat({ model: reasoner, reasoning: { exclude: true }, usage: { include: true } }),
        );
        expect(hidden.choices[0].message.reasoning).toBeUndefined();
        expect(hidden.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        expect(
            (await json(await chat({ model: 'mock/subscription-basic' }))).choices[0].message.reasoning,
        ).toBeUndefined();
    });

    it('switches reasoning off only where the model allows it', async () => {
        const off = await json(
            await chat({ model: reasoner, reasoning: { effort: 'none' }, usage: { include: true } }),
        );
        expect(off.choices[0].message.reasoning).toBeUndefined();
        expect(off.usage.completion_tokens_details.reasoning_tokens).toBe(0);
        const always = await json(await chat({ model: 'mock/reasoning-always', reasoning: { effort: 'none' } }));
        expect(always.choices[0].message.reasoning).toBeDefined();
        const named = await json(await chat({ model: `${FLASH}:thinking`, reasoning_effort: 'none' }));
        expect(named.choices[0].message.reasoning).toBeDefined();
    });
});

describe('streaming', () => {
    it('streams role, reasoning and content deltas, a usage chunk and [DONE]', async () => {
        const res = await chat({
            model: 'mock/subscription-reasoner',
            stream: true,
            stream_options: { include_usage: true },
        });
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(res.headers.get('x-request-id')).toMatch(/^req_/);
        const { frames, done } = await sse(res);
        expect(done).toBe(true);
        expect(frames[0].choices[0].delta.role).toBe('assistant');
        expect(frames.some((f) => f.choices[0]?.delta.reasoning)).toBe(true);
        const content = frames.map((f) => f.choices[0]?.delta.content ?? '').join('');
        expect(content).toBe('Mock reply from mock/subscription-reasoner: Hello there');
        expect(frames.find((f) => f.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop');
        const last = frames.at(-1);
        expect(last.choices).toEqual([]);
        expect(last.usage.total_tokens).toBe(last.usage.prompt_tokens + last.usage.completion_tokens);
        expect(last.x_nanogpt_pricing.requestId).toBe(res.headers.get('x-request-id'));
    });

    it('sends no usage chunk unless asked, and no reasoning for a plain model', async () => {
        const { frames, done } = await sse(await chat({ model: 'mock/subscription-basic', stream: true }));
        expect(done).toBe(true);
        expect(frames.some((f) => f.usage)).toBe(false);
        expect(frames.some((f) => f.choices[0]?.delta.reasoning)).toBe(false);
    });

    it('marks a request the client dropped mid-stream as aborted', async () => {
        const controller = new AbortController();
        const res = await fetch(`${base}/api/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth(), 'x-mock-chunk-delay-ms': '150' },
            body: JSON.stringify({
                model: FLASH,
                stream: true,
                messages: [{ role: 'user', content: 'a b c d e f g h i j k l' }],
            }),
            signal: controller.signal,
        });
        const reader = res.body!.getReader();
        await reader.read();
        controller.abort();
        let entry: any;
        for (let i = 0; i < 40 && !entry?.aborted; i++) {
            await new Promise((r) => setTimeout(r, 50));
            entry = (await json(await get('/__mock/requests?path=chat'))).requests.at(-1);
        }
        expect(entry.aborted).toBe(true);
    });
});

describe('magic behaviours', () => {
    it('rejects response_format on mock/structured-unsupported only', async () => {
        const refused = await chat({ model: 'mock/structured-unsupported', response_format: { type: 'json_object' } });
        expect(refused.status).toBe(400);
        expect((await json(refused)).error.code).toBe('model_response_format_unsupported');
        expect((await chat({ model: 'mock/structured-unsupported' })).status).toBe(200);
        expect(
            (await chat({ model: 'mock/subscription-basic', response_format: { type: 'json_object' } })).status,
        ).toBe(200);
    });

    it('forces the errors named by x-mock-error', async () => {
        for (const status of [401, 402, 429, 500, 502]) {
            const res = await chat({}, { ...auth(), 'x-mock-error': String(status) });
            expect(res.status).toBe(status);
            expect((await json(res)).error.code).toEqual(expect.any(String));
        }
        expect((await chat({}, { ...auth(), 'x-mock-error': '429' })).headers.get('retry-after')).toBe('1');
        const empty = await chat({}, { ...auth(), 'x-mock-error': '502-empty' });
        expect(empty.status).toBe(502);
        expect(await empty.text()).toBe('');
    });

    it('delays a reply by x-mock-delay-ms and takes a reply text from x-mock-reply', async () => {
        const started = Date.now();
        const res = await chat(
            {},
            { ...auth(), 'x-mock-delay-ms': '120', 'x-mock-reply': encodeURIComponent('Привет, мир') },
        );
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
        expect((await json(res)).choices[0].message.content).toBe('Привет, мир');
    });

    it('answers 402 on pay-as-you-go when the balance is gone, still serving the subscription', async () => {
        await send('POST', '/__mock/state', { balanceUsd: 0 });
        expect((await chat({ model: 'anthropic/claude-sonnet-5.5' })).status).toBe(402);
        expect((await chat({})).status).toBe(200);
    });
});

describe('account routes', () => {
    it('reads the subscription quotas and gives billing advice that follows the quota', async () => {
        const first = await json(await get('/api/subscription/v1/usage', auth()));
        expect(first).toMatchObject({
            active: true,
            state: 'active',
            limits: { dailyInputTokens: expect.any(Number), weeklyInputTokens: expect.any(Number) },
            dailyInputTokens: { used: 0, remaining: expect.any(Number), percentUsed: 0, resetAt: expect.any(Number) },
            routing: { recommendedMode: 'subscription', subscriptionQuotaAvailable: true },
        });
        await chat({});
        expect((await json(await get('/api/v1/subscription/usage', auth()))).weeklyInputTokens.used).toBeGreaterThan(0);

        await send('POST', '/__mock/state', { subscription: { weeklyUsed: 6_000_000 } });
        const exhausted = await json(await get('/api/subscription/v1/usage', auth()));
        expect(exhausted.routing).toMatchObject({ recommendedMode: 'paygo', subscriptionQuotaAvailable: false });
        // With the quota used up, even an included model is paid for.
        expect((await json(await chat({ usage: { include: true } }))).x_nanogpt_pricing.paymentSource).toBe('USD');
    });

    it('aggregates usage per day and model for the key', async () => {
        await chat({});
        await chat({ model: 'mock/paid-premium' });
        const usage = await json(await get('/api/v1/usage', auth()));
        expect(usage).toMatchObject({ object: 'usage', scope: 'current_key', totals: { requests: 2 } });
        expect(usage.byModel.map((m: any) => m.model).sort()).toEqual([FLASH, 'mock/paid-premium'].sort());
        expect(usage.byDay).toHaveLength(1);
        expect(usage.byDayModel).toHaveLength(2);
        expect((await get('/api/v1/usage?from=2026-01-01', auth())).status).toBe(400);
        expect((await json(await get('/api/v1/usage', auth('sk-nano-someone-else-0000')))).totals.requests).toBe(0);
    });

    it('stubs image generation with one tiny PNG', async () => {
        for (const route of ['/api/v1/images/generations', '/api/v1/images']) {
            const body = await json(await send('POST', route, { prompt: 'a lighthouse' }, auth()));
            const png = Buffer.from(body.data[0].b64_json, 'base64');
            expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
            expect((await send('POST', route, {}, {})).status).toBe(401);
        }
    });
});

describe('CORS', () => {
    it('allows any origin, echoes requested headers and exposes X-Request-ID on ordinary routes', async () => {
        const res = await get('/api/v1/models');
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-expose-headers')).toContain('X-Request-ID');
        expect(res.headers.get('x-request-id')).toMatch(/^req_/);
        const preflight = await fetch(`${base}/api/v1/chat/completions`, {
            method: 'OPTIONS',
            headers: {
                origin: 'http://localhost:8000',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'authorization, x-billing-mode',
            },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization, x-billing-mode');
        // Errors carry them too.
        expect((await chat({}, {})).headers.get('access-control-allow-origin')).toBe('*');
    });

    it('sends no CORS header at all on the Management API, preflight and errors included', async () => {
        const replies = [
            await get('/api/management/v1/api-keys', { Authorization: `Bearer ${MGMT}` }),
            await get('/api/management/v1/api-keys'),
            await fetch(`${base}/api/management/v1/api-keys`, {
                method: 'OPTIONS',
                headers: { origin: 'http://localhost:8000', 'access-control-request-method': 'GET' },
            }),
            await get('/api/management/v1/nothing', { Authorization: `Bearer ${MGMT}` }),
        ];
        for (const res of replies) {
            const names = [...res.headers.keys()].filter((name) => name.startsWith('access-control-'));
            expect(names, `${res.status}`).toEqual([]);
        }
    });
});

describe('Management API', () => {
    const mgmt = { Authorization: `Bearer ${MGMT}` };

    it('needs a management token with the right scope', async () => {
        const none = await get('/api/management/v1/api-keys');
        expect(none.status).toBe(401);
        expect((await json(none)).error).toMatchObject({
            code: 'invalid_management_token',
            request_id: expect.stringMatching(/^req_/),
        });
        expect((await get('/api/management/v1/api-keys', { Authorization: `Bearer ${KEY}` })).status).toBe(401);
        expect(
            (await get('/api/management/v1/api-keys', { Authorization: 'Bearer sk-nano-mgmt-revoked-1234' })).status,
        ).toBe(401);
        const usageOnly = { Authorization: 'Bearer sk-nano-mgmt-usage-1234' };
        const forbidden = await get('/api/management/v1/api-keys', usageOnly);
        expect(forbidden.status).toBe(403);
        expect((await json(forbidden)).error.code).toBe('insufficient_scope');
        const usage = await json(await get('/api/management/v1/subscription/usage', usageOnly));
        expect(usage.active).toBe(true);
        expect(usage.routing).toBeUndefined();
        expect(
            (await get('/api/management/v1/model-presets', { Authorization: 'Bearer sk-nano-mgmt-keysread-1234' }))
                .status,
        ).toBe(403);
    });

    it('manages API keys: idempotent create, read, update, delete', async () => {
        const noKey = await send('POST', '/api/management/v1/api-keys', { name: 'ST' }, mgmt);
        expect(noKey.status).toBe(400);
        expect((await json(noKey)).error.code).toBe('idempotency_key_required');

        const body = { name: 'Nanovia main', daily_usd_limit: 1.5, weekly_request_limit: 500 };
        const created = await send('POST', '/api/management/v1/api-keys', body, { ...mgmt, 'Idempotency-Key': 'one' });
        expect(created.status).toBe(201);
        const key = await json(created);
        expect(key).toMatchObject({
            id: '1',
            object: 'api_key',
            name: 'Nanovia main',
            status: 'active',
            daily_usd_limit: 1.5,
            daily_rpd_limit: null,
            key: expect.stringMatching(/^sk-nano-/),
        });

        const replay = await json(
            await send('POST', '/api/management/v1/api-keys', body, { ...mgmt, 'Idempotency-Key': 'one' }),
        );
        expect(replay.key).toBe(key.key);
        expect(
            (
                await send(
                    'POST',
                    '/api/management/v1/api-keys',
                    { name: 'other' },
                    { ...mgmt, 'Idempotency-Key': 'one' },
                )
            ).status,
        ).toBe(409);

        const bad = await send(
            'POST',
            '/api/management/v1/api-keys',
            { name: 'x', daily_usd_limit: -1, nonsense: true },
            { ...mgmt, 'Idempotency-Key': 'two' },
        );
        expect(bad.status).toBe(400);
        expect((await json(bad)).error.details).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ field: 'daily_usd_limit' }),
                expect.objectContaining({ field: 'nonsense' }),
            ]),
        );

        const listed = await json(await get('/api/management/v1/api-keys', mgmt));
        expect(listed.data).toHaveLength(1);
        expect(listed.data[0].key).toBeUndefined();
        expect((await json(await get('/api/management/v1/api-keys/1', mgmt))).name).toBe('Nanovia main');

        const patched = await json(
            await send('PATCH', '/api/management/v1/api-keys/1', { monthly_usd_limit: 20, name: ' Renamed ' }, mgmt),
        );
        expect(patched).toMatchObject({ name: 'Renamed', monthly_usd_limit: 20, daily_usd_limit: 1.5 });
        expect((await send('PATCH', '/api/management/v1/api-keys/1', {}, mgmt)).status).toBe(400);
        expect((await send('PATCH', '/api/management/v1/api-keys/9', { name: 'x' }, mgmt)).status).toBe(404);

        expect((await fetch(`${base}/api/management/v1/api-keys/1`, { method: 'DELETE', headers: mgmt })).status).toBe(
            204,
        );
        expect((await get('/api/management/v1/api-keys/1', mgmt)).status).toBe(404);
    });

    it('manages model presets', async () => {
        const put = await send(
            'PUT',
            '/api/management/v1/model-presets/rp-fast',
            { model: 'deepseek/deepseek-v4.1-flash', temperature: 0.8 },
            mgmt,
        );
        expect(put.status).toBe(200);
        const preset = await json(put);
        expect(preset).toMatchObject({
            name: 'rp-fast',
            model: 'deepseek/deepseek-v4.1-flash',
            temperature: 0.8,
            top_p: null,
            created_at: expect.any(String),
        });
        const again = await json(
            await send('PUT', '/api/management/v1/model-presets/rp-fast', { model: 'z-ai/glm-5.3' }, mgmt),
        );
        expect(again).toMatchObject({ model: 'z-ai/glm-5.3', temperature: null, created_at: preset.created_at });
        expect((await json(await get('/api/management/v1/model-presets', mgmt))).data).toHaveLength(1);
        expect((await json(await get('/api/management/v1/model-presets/rp-fast', mgmt))).model).toBe('z-ai/glm-5.3');
        expect((await send('PUT', '/api/management/v1/model-presets/bad', { temperature: 1 }, mgmt)).status).toBe(400);
        expect((await send('PUT', '/api/management/v1/model-presets/bad%20name', { model: 'x' }, mgmt)).status).toBe(
            400,
        );
        expect(
            (await fetch(`${base}/api/management/v1/model-presets/rp-fast`, { method: 'DELETE', headers: mgmt }))
                .status,
        ).toBe(204);
        expect((await get('/api/management/v1/model-presets/rp-fast', mgmt)).status).toBe(404);
    });
});

describe('request log', () => {
    it('records requests with lower-case headers, masked keys and parsed bodies', async () => {
        await chat({ messages: [{ role: 'user', content: 'logged text' }] }, { ...auth(), 'X-Custom-Thing': 'yes' });
        await send('POST', '/api/check-balance', undefined, { 'x-api-key': KEY });
        await get('/api/management/v1/api-keys', { Authorization: `Bearer ${MGMT}` });
        const { requests } = await json(await get('/__mock/requests'));
        expect(requests).toHaveLength(3);
        expect(requests[0]).toMatchObject({
            n: 1,
            method: 'POST',
            path: '/api/v1/chat/completions',
            status: 200,
            body: { model: FLASH, messages: [{ role: 'user', content: 'logged text' }] },
        });
        expect(requests[0].headers['x-custom-thing']).toBe('yes');
        expect(requests[0].headers.authorization).toBe('Bearer sk-nano-…wxyz');
        expect(requests[1].headers['x-api-key']).toBe('sk-nano-…wxyz');
        expect(requests[2].headers.authorization).toBe('Bearer sk-nano-mgmt-…6789');
        const everything = JSON.stringify(requests);
        expect(everything).not.toContain(KEY);
        expect(everything).not.toContain(MGMT);
    });

    it('masks keys inside bodies, filters, limits and resets', async () => {
        await send(
            'POST',
            '/api/v1/chat/completions',
            { model: FLASH, messages: [{ role: 'user', content: `my key is ${KEY}` }] },
            auth(),
        );
        await get('/api/v1/models');
        expect(JSON.stringify((await json(await get('/__mock/requests'))).requests)).not.toContain(KEY);
        expect((await json(await get('/__mock/requests?path=models'))).requests).toHaveLength(1);
        expect((await json(await get('/__mock/requests?limit=1'))).requests[0].path).toBe('/api/v1/models');
        // The mock's own routes are not logged.
        expect((await json(await get('/__mock/requests'))).requests).toHaveLength(2);
        await send('POST', '/__mock/reset', undefined);
        expect((await json(await get('/__mock/requests'))).requests).toEqual([]);
    });

    it('resets balance and counters too', async () => {
        await chat({ model: 'anthropic/claude-sonnet-5.5' });
        await send('POST', '/__mock/reset', undefined);
        expect((await json(await send('POST', '/api/check-balance', undefined, auth()))).usd_balance).toBe(
            '25.00000000',
        );
    });
});
