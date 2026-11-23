// Stage 0.4 on the response path, non-streamed: the OpenRouter-style shim (real USD in usage.cost, 0 for the subscription,
// a nanovia block), what passes through untouched, the response headers and the one usage record of a request.
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NANO_KEY, boot, chat, cleanTempDirs, startServer, waitFor, type Harness, type TestServer } from './helpers';
import { startMockStack, type MockStack, type MockStackOptions } from './mock-stack';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanTempDirs();
});

async function stack(options: MockStackOptions = {}): Promise<MockStack> {
    const s = await startMockStack(options);
    closers.push(() => s.close());
    return s;
}

async function upstream(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
    const server = await startServer(handler);
    closers.push(() => server.close());
    return server;
}

async function bootOn(server: TestServer, options: Parameters<typeof boot>[0] = {}): Promise<Harness> {
    const h = await boot({
        ...options,
        config: { upstreamBase: `${server.origin}/api/v1`, upstreamFallbackBase: null, ...options.config },
    });
    closers.push(() => h.close());
    h.st.addNanoKey();
    return h;
}

/** The records written so far (waits for at least `count`). */
async function records(h: Harness, count = 1): Promise<Record<string, any>[]> {
    return waitFor(() => {
        const found = h.usage();
        return found.length >= count && found;
    });
}

const FLASH = 'deepseek/deepseek-v4.1-flash'; // in the subscription
const PREMIUM = 'anthropic/claude-sonnet-5.5'; // not in the subscription
const MESSAGES = [{ role: 'user', content: 'Say hello to the harbour' }];

describe('shim of a non-streamed reply', () => {
    it('a subscription model: usage.cost is 0, the nanovia block says subscription, only usage changed', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(200);
        const requestId = response.headers.get('x-nanovia-request-id');
        expect(requestId).toMatch(/^req_/);
        expect(response.headers.get('x-nanovia-billing')).toBe('subscription');

        const json: any = await response.json();
        const model = s.models.get(FLASH)!;
        const { prompt_tokens: prompt, completion_tokens: completion } = json.usage;
        expect(json.usage).toMatchObject({
            cost: 0,
            total_tokens: prompt + completion,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: expect.any(Number) },
            nanovia: { billing: 'subscription', request_id: requestId },
        });
        expect(json.usage).not.toHaveProperty('currency');
        const equivalent = (prompt * model.pricing.prompt + completion * model.pricing.completion) / 1e6;
        expect(json.usage.nanovia.equivalent_usd).toBeGreaterThan(0);
        expect(json.usage.nanovia.equivalent_usd).toBeCloseTo(equivalent, 8);
        // everything but usage is the upstream's, NanoGPT's own pricing block included
        expect(json.x_nanogpt_pricing).toMatchObject({ paymentSource: 'subscription', requestId });
        expect(json.choices[0].message.content).toContain('Mock reply');

        const [record] = await records(s.h);
        expect(record).toMatchObject({
            connectionId: view.id,
            requestId,
            model: FLASH,
            billing: 'subscription',
            costUsd: 0,
            promptTokens: prompt,
            completionTokens: completion,
            cachedTokens: 0,
            status: 200,
            stream: false,
            consumer: 'unknown',
            error: null,
        });
        expect(record!.equivalentUsd).toBeCloseTo(equivalent, 8);
    });

    it('a model outside the subscription: the real cost, billed pay-as-you-go', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({ modelId: PREMIUM, modelLock: true });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        const json: any = await response.json();
        expect(response.headers.get('x-nanovia-billing')).toBe('paygo');
        expect(json.usage.cost).toBeGreaterThan(0);
        expect(json.usage.cost).toBe(json.x_nanogpt_pricing.cost);
        expect(json.usage.nanovia).toMatchObject({ billing: 'paygo', equivalent_usd: expect.any(Number) });
        const [record] = await records(s.h);
        expect(record).toMatchObject({ billing: 'paygo', costUsd: json.usage.cost });
        expect(record!.equivalentUsd).toBeCloseTo(json.usage.cost, 8);
    });

    it('a paygo connection sends the billing mode and is billed pay-as-you-go even for a subscription model', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true, billing: 'paygo' });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        const json: any = await response.json();
        const [call] = s.seen('/api/v1/chat/completions');
        expect(call.headers['x-billing-mode']).toBe('paygo');
        expect(call.body.billing_mode).toBe('paygo');
        expect(response.headers.get('x-nanovia-billing')).toBe('paygo');
        expect(json.usage.cost).toBeGreaterThan(0);
        expect(json.usage.nanovia.billing).toBe('paygo');
        expect((await records(s.h))[0]).toMatchObject({ billing: 'paygo' });
    });

    it('explicit routing leaves the subscription: provider object upstream, pay-as-you-go in the record', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({
            modelId: FLASH,
            modelLock: true,
            routing: { enabled: true, order: ['Deepinfra'] },
        });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        const json: any = await response.json();
        const [call] = s.seen('/api/v1/chat/completions');
        expect(call.body.provider).toEqual({ order: ['deepinfra'] });
        expect(response.headers.get('x-nanovia-billing')).toBe('paygo');
        expect(json.usage.cost).toBeGreaterThan(0);
        expect(json.usage.nanovia.billing).toBe('paygo');
    });

    it('safe mode strips that routing, so the subscription still covers the request', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({
            modelId: FLASH,
            modelLock: true,
            billing: 'subscription',
            routing: { enabled: true, order: ['deepinfra'], sort: 'price' },
        });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        const json: any = await response.json();
        const [call] = s.seen('/api/v1/chat/completions');
        expect(call.body).not.toHaveProperty('provider');
        expect(response.headers.get('x-nanovia-billing')).toBe('subscription');
        expect(json.usage.cost).toBe(0);
        expect(json.usage.nanovia.billing).toBe('subscription');
        expect((await records(s.h))[0]).toMatchObject({ billing: 'subscription', costUsd: 0 });
    });

    it('without a catalog the cost still comes through, the billing stays unknown instead of guessing', async () => {
        const s = await stack({ catalog: false });
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        const json: any = await response.json();
        expect(response.headers.get('x-nanovia-billing')).toBe('unknown');
        expect(json.usage.cost).toBe(0);
        expect(json.usage.nanovia.billing).toBe('unknown');
        expect((await records(s.h))[0]).toMatchObject({ billing: 'unknown', costUsd: 0 });
    });

    it('a catalog that throws is the same as no catalog', async () => {
        const s = await stack({
            lookupModel: () => {
                throw new Error('catalog exploded');
            },
        });
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true });
        expect((await chat(s.h, view.id, token, { messages: MESSAGES })).status).toBe(200);
    });

    it('asks the catalog seam about provider selection and sends only zdr to a model without it', async () => {
        const asked: string[] = [];
        const s = await stack({
            providerSelection: (id) => {
                asked.push(id);
                return id === 'mock/no-selection' ? false : true;
            },
        });
        const { view, token } = await s.h.connect({
            modelId: 'mock/no-selection',
            modelLock: true,
            routing: { enabled: true, order: ['somewhere'], zdr: true },
        });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(200);
        expect(asked).toContain('mock/no-selection');
        expect(s.seen('/api/v1/chat/completions')[0].body.provider).toEqual({ zdr: true });
    });

    it('looks up the model the plan will use: a locked connection ignores the model of the request', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true });
        const response = await chat(s.h, view.id, token, { model: PREMIUM, messages: MESSAGES });
        const json: any = await response.json();
        expect(s.seen('/api/v1/chat/completions')[0].body.model).toBe(FLASH);
        expect(json.usage.nanovia.billing).toBe('subscription'); // judged by FLASH, not by PREMIUM
    });
});

describe('what the shim leaves alone', () => {
    const fixed = (body: string, status = 200, type = 'application/json') =>
        upstream((_req, res) => {
            res.writeHead(status, { 'content-type': type, 'x-request-id': 'up-1' });
            res.end(body);
        });

    it('passes a body that is not JSON through byte for byte', async () => {
        const server = await fixed('plain text, not JSON: usage cost 5', 200, 'text/plain');
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(await response.text()).toBe('plain text, not JSON: usage cost 5');
        expect(response.headers.get('content-type')).toContain('text/plain');
    });

    it('passes JSON without usage through byte for byte, odd spacing included', async () => {
        const body = '{ "id" : "x",\n  "choices" : [ { "message": { "content": "hi" } } ] }';
        const h = await bootOn(await fixed(body));
        const { view, token } = await h.connect();
        expect(await (await chat(h, view.id, token, { messages: MESSAGES })).text()).toBe(body);
        const [record] = await records(h);
        expect(record).toMatchObject({ billing: 'unknown', costUsd: null, promptTokens: null, status: 200 });
    });

    it('passes an error body through, even one with a usage block', async () => {
        const body = JSON.stringify({ error: { message: 'nope', code: 'bad' }, usage: { prompt_tokens: 9, cost: 1 } });
        const h = await bootOn(await fixed(body, 200));
        const { view, token } = await h.connect();
        expect(await (await chat(h, view.id, token, { messages: MESSAGES })).text()).toBe(body);
    });

    it('changes nothing but usage: choices, ids and NanoGPT fields come back as they were', async () => {
        const original = {
            id: 'chatcmpl-77',
            object: 'chat.completion',
            created: 1_800_000_000,
            model: 'z-ai/glm-5.3',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content: 'ünïcode — ok', reasoning: 'thinking…' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: '0.0042', currency: 'USD' },
            x_nanogpt_pricing: {
                cost: 0.0042,
                inputTokens: 120,
                outputTokens: 30,
                isEstimate: false,
                requestId: 'req_zz',
            },
            system_fingerprint: 'fp_1',
        };
        const h = await bootOn(await fixed(JSON.stringify(original)));
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        const json: any = await response.json();
        const { usage, ...rest } = json;
        const originalRest: Record<string, unknown> = { ...original };
        delete originalRest['usage'];
        expect(rest).toEqual(originalRest);
        expect(usage).toMatchObject({
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            cost: 0.0042,
            nanovia: { billing: 'paygo', request_id: 'up-1' }, // the header id wins over the id inside the body
        });
        expect(usage).not.toHaveProperty('currency');
        expect(response.headers.get('x-nanovia-request-id')).toBe('up-1');
        expect((await records(h))[0]).toMatchObject({ requestId: 'up-1', costUsd: 0.0042, billing: 'paygo' });
    });

    it('does not turn a foreign-currency cost into dollars', async () => {
        const original = {
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0003, currency: 'XNO' },
        };
        const h = await bootOn(await fixed(JSON.stringify(original)));
        const { view, token } = await h.connect();
        const json: any = await (await chat(h, view.id, token, { messages: MESSAGES })).json();
        expect(json.usage).not.toHaveProperty('cost');
        expect(json.usage).not.toHaveProperty('currency');
        expect(json.usage.nanovia.billing).toBe('paygo');
        expect((await records(h))[0]).toMatchObject({ billing: 'paygo', costUsd: null });
    });
});

describe('response headers', () => {
    it('carries the connection, the billing outcome, the upstream request id and the warning codes', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({
            modelId: FLASH,
            modelLock: true,
            routing: { enabled: true, preferredMaxLatency: 3 },
        });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        expect(response.headers.get('x-nanovia-connection')).toBe(view.id);
        expect(response.headers.get('x-nanovia-billing')).toBe('paygo');
        expect(response.headers.get('x-nanovia-request-id')).toMatch(/^req_/);
        expect(response.headers.get('x-nanovia-warnings')).toBe('routing.preferenceNeedsSort');
    });

    it('lists several warnings comma separated and omits the header when there are none', async () => {
        const s = await stack();
        const noisy = await s.h.connect({
            name: 'Noisy',
            modelId: FLASH,
            modelLock: true,
            routing: { enabled: true, only: ['a'], order: ['b'], preferredMinThroughput: 20 },
        });
        const warned = await chat(s.h, noisy.view.id, noisy.token, { messages: MESSAGES });
        expect(warned.headers.get('x-nanovia-warnings')).toBe('routing.preferenceNeedsSort,routing.onlyAndOrder');

        const quiet = await s.h.connect({ name: 'Quiet', modelId: FLASH, modelLock: true });
        const clean = await chat(s.h, quiet.view.id, quiet.token, { messages: MESSAGES });
        expect(clean.headers.has('x-nanovia-warnings')).toBe(false);
    });
});

describe('the usage record', () => {
    it('is written once per request with the consumer, the real request id, status and latency', async () => {
        let clock = 1_700_000_000_000;
        const s = await stack({ now: () => (clock += 20) });
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true });
        const response = await chat(
            s.h,
            view.id,
            token,
            { messages: MESSAGES },
            { headers: { 'x-nanovia-consumer': 'background' } },
        );
        await response.text();
        await records(s.h);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const all = s.h.usage();
        expect(all).toHaveLength(1);
        expect(all[0]).toMatchObject({
            connectionId: view.id,
            requestId: response.headers.get('x-nanovia-request-id'),
            model: FLASH,
            consumer: 'background',
            status: 200,
            stream: false,
        });
        expect(Number.isInteger(all[0]!.latencyMs)).toBe(true);
        expect(all[0]!.latencyMs).toBeGreaterThan(0);
        expect(all[0]!.at).toBeGreaterThan(1_700_000_000_000);
    });

    it('records the model with its suffixes, as it went upstream', async () => {
        const s = await stack();
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true, webSearch: true });
        await (await chat(s.h, view.id, token, { messages: MESSAGES })).text();
        expect((await records(s.h))[0]).toMatchObject({ model: `${FLASH}:online` });
    });

    it('keeps an upstream error as a code, with no secret in it, and no cost', async () => {
        const server = await upstream((_req, res) => {
            res.writeHead(429, { 'content-type': 'application/json', 'x-request-id': 'up-9' });
            res.end(JSON.stringify({ error: { message: `slow down ${NANO_KEY}`, code: 'rate_limited' } }));
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(429);
        const [record] = await records(h);
        expect(record).toMatchObject({
            status: 429,
            error: 'rate_limited',
            billing: 'unknown',
            costUsd: null,
            requestId: 'up-9',
        });
        const file = fs
            .readdirSync(path.join(h.st.userRoot('default-user'), 'nanovia'))
            .find((f) => f.startsWith('usage-'));
        const text = fs.readFileSync(path.join(h.st.userRoot('default-user'), 'nanovia', file!), 'utf8');
        expect(text).not.toContain(NANO_KEY);
    });

    it('never fails the request when the log cannot be written', async () => {
        const fixedAt = Date.UTC(2023, 10, 14, 12);
        const s = await stack({ now: () => fixedAt });
        const { view, token } = await s.h.connect({ modelId: FLASH, modelLock: true });
        // a directory where today's file should be: appending to it fails
        fs.mkdirSync(path.join(s.h.st.userRoot('default-user'), 'nanovia', 'usage-2023-11-14.jsonl'), {
            recursive: true,
        });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(200);
        expect(((await response.json()) as any).usage.nanovia.billing).toBe('subscription');
        await waitFor(() => s.h.logs.some((line) => line.startsWith('warn usage record not written')));
        expect(s.h.logs.join('\n')).not.toContain(NANO_KEY);
    });
});
