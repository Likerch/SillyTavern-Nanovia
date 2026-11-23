/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PipelineSteps } from '../../src/server/proxy';
import {
    NANO_KEY,
    boot,
    chat,
    cleanTempDirs,
    closedPort,
    deferred,
    jsonUpstream,
    sleep,
    startServer,
    waitFor,
    type Harness,
    type TestServer,
} from './helpers';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanTempDirs();
});

async function upstreamFor(server: Promise<TestServer>): Promise<TestServer> {
    const s = await server;
    closers.push(() => s.close());
    return s;
}

async function bootWith(upstream: TestServer, config: Parameters<typeof boot>[0] = {}): Promise<Harness> {
    const h = await boot({
        ...config,
        config: { upstreamBase: `${upstream.origin}/api/v1`, upstreamFallbackBase: null, ...config.config },
    });
    closers.push(() => h.close());
    h.st.addNanoKey();
    return h;
}

const MESSAGES = [{ role: 'user', content: 'hi' }];

describe('proxy: health, models and auth', () => {
    it('answers /health without auth and rejects other methods', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const ok = await fetch(`${h.proxy}/health`);
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ ok: true, version: '9.9.9-test' });
        expect((await fetch(`${h.proxy}/health`, { method: 'POST' })).status).toBe(405);
    });

    it('lists the connection model on GET /models', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const { view, token } = await h.connect({ modelId: 'zai-org/glm-5' });
        const response = await fetch(`${h.proxy}/c/${view.id}/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const json: any = await response.json();
        expect(json.object).toBe('list');
        expect(json.data).toEqual([expect.objectContaining({ id: 'zai-org/glm-5', object: 'model' })]);
    });

    it('answers 401 in the OpenAI error shape without, with a wrong, or with a foreign token', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const a = await h.connect({ name: 'A' });
        const b = await h.connect({ name: 'B' });

        const none = await fetch(`${h.proxy}/c/${a.view.id}/v1/models`);
        expect(none.status).toBe(401);
        const body: any = await none.json();
        expect(body.error).toEqual({
            message: expect.any(String),
            type: 'authentication_error',
            code: 'missing_token',
        });

        const wrong = await chat(h, a.view.id, 'not-a-token', { messages: MESSAGES });
        expect(wrong.status).toBe(401);
        expect(((await wrong.json()) as any).error.code).toBe('invalid_token');

        const foreign = await chat(h, a.view.id, b.token, { messages: MESSAGES });
        expect(foreign.status).toBe(401);
        expect(((await foreign.json()) as any).error.code).toBe('invalid_token');
    });

    it('accepts the token as x-api-key', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const { view, token } = await h.connect();
        const response = await fetch(`${h.proxy}/c/${view.id}/v1/models`, { headers: { 'x-api-key': token } });
        expect(response.status).toBe(200);
    });

    it('404s unknown paths and 405s wrong methods', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const { view, token } = await h.connect();
        expect((await fetch(`${h.proxy}/nope`)).status).toBe(404);
        expect((await fetch(`${h.proxy}/c/${view.id}/v1/embeddings`, { method: 'POST' })).status).toBe(404);
        const wrongMethod = await fetch(`${h.proxy}/c/${view.id}/v1/chat/completions`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(wrongMethod.status).toBe(405);
    });

    it('rejects a token of a revoked connection (switched to direct)', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const { view, token } = await h.connect();
        await h.api('PUT', `/connections/${view.id}`, { mode: 'direct' });
        expect((await chat(h, view.id, token, { messages: MESSAGES })).status).toBe(401);
    });
});

describe('proxy: chat completions, non-streamed', () => {
    it('forwards the body, authenticates upstream with the NanoGPT key and adds response headers', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const body = { model: 'glm-5', messages: MESSAGES, temperature: 0.7, custom_field: { a: [1, 2] } };
        const response = await chat(h, view.id, token, body, {
            headers: { 'x-nanovia-effort': 'high', 'x-nanovia-consumer': 'main' },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('x-nanovia-connection')).toBe(view.id);
        expect(response.headers.get('x-nanovia-billing')).toBe('unknown');
        expect(response.headers.get('x-nanovia-request-id')).toBe('up-123');
        const json: any = await response.json();
        expect(json.choices[0].message.content).toBe('ok');
        expect(json.echo).toEqual(body);

        expect(upstream.requests).toHaveLength(1);
        const seen = upstream.requests[0]!;
        expect(seen.method).toBe('POST');
        expect(seen.url).toBe('/api/v1/chat/completions');
        expect(seen.headers['authorization']).toBe(`Bearer ${NANO_KEY}`);
        expect(seen.headers['content-type']).toBe('application/json');
        expect(seen.headers['x-nanovia-effort']).toBeUndefined();
        expect(seen.headers['x-api-key']).toBeUndefined();
    });

    it('writes a usage record', async () => {
        let clock = 1_000_000;
        const h = await bootWith(await upstreamFor(jsonUpstream()), {
            now: () => (clock += 25),
        });
        const { view, token } = await h.connect();
        await chat(h, view.id, token, { messages: MESSAGES }, { headers: { 'x-nanovia-consumer': 'background' } });
        const records = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(records[0]).toMatchObject({
            connectionId: view.id,
            requestId: 'up-123',
            model: 'glm-5',
            billing: 'unknown',
            costUsd: null,
            status: 200,
            stream: false,
            consumer: 'background',
            error: null,
        });
        expect(records[0]!.latencyMs).toBeGreaterThan(0);
    });

    it('strips neutral samplers by default and only those', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        await chat(h, view.id, token, {
            messages: MESSAGES,
            top_k: 0,
            top_a: 0,
            min_p: 0,
            repetition_penalty: 1,
            logit_bias: {},
            top_p: 0.9,
            frequency_penalty: 0,
        });
        const sent = JSON.parse(upstream.requests[0]!.body);
        expect(sent).toEqual({ model: 'glm-5', messages: MESSAGES, top_p: 0.9, frequency_penalty: 0 });
    });

    it('keeps the neutral samplers when the connection turns stripping off', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream);
        const { view, token } = await h.connect({ stripNeutralSamplers: false });
        await chat(h, view.id, token, { messages: MESSAGES, top_k: 0, logit_bias: {} });
        const sent = JSON.parse(upstream.requests[0]!.body);
        expect(sent).toMatchObject({ top_k: 0, logit_bias: {} });
    });

    it('modelLock on: always the connection model; off: the request model, else the connection model', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream);
        const locked = await h.connect({ name: 'Locked', modelId: 'locked/model', modelLock: true });
        const free = await h.connect({ name: 'Free', modelId: 'free/model', modelLock: false });

        await chat(h, locked.view.id, locked.token, { model: 'other/one', messages: MESSAGES });
        await chat(h, free.view.id, free.token, { model: 'other/one', messages: MESSAGES });
        await chat(h, free.view.id, free.token, { messages: MESSAGES });
        const models = upstream.requests.map((r) => JSON.parse(r.body).model);
        expect(models).toEqual(['locked/model', 'other/one', 'free/model']);
    });

    it('uses the key chosen by keyId, and the active key otherwise', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream);
        const other = h.st.addNanoKey('default-user', 'sk-nano-second-key-value-0000', 'second');
        h.st.writeSecret('default-user', 'api_key_nanogpt', 'sk-nano-third-key-value-1111', 'third'); // active now
        const pinned = await h.connect({ name: 'Pinned', keyId: other });
        const auto = await h.connect({ name: 'Auto' });
        await chat(h, pinned.view.id, pinned.token, { messages: MESSAGES });
        await chat(h, auto.view.id, auto.token, { messages: MESSAGES });
        expect(upstream.requests.map((r) => r.headers['authorization'])).toEqual([
            'Bearer sk-nano-second-key-value-0000',
            'Bearer sk-nano-third-key-value-1111',
        ]);
    });

    it('409 no_key without any key, or when the chosen key is gone', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await boot({ config: { upstreamBase: `${upstream.origin}/api/v1`, upstreamFallbackBase: null } });
        closers.push(() => h.close());
        const { view, token } = await h.connect();
        const none = await chat(h, view.id, token, { messages: MESSAGES });
        expect(none.status).toBe(409);
        expect(((await none.json()) as any).error).toMatchObject({ code: 'no_key', type: 'invalid_request_error' });

        h.st.addNanoKey();
        const gone = await h.connect({ name: 'Gone', keyId: 'deleted-key-id' });
        const response = await chat(h, gone.view.id, gone.token, { messages: MESSAGES });
        expect(response.status).toBe(409);
        expect(upstream.requests).toHaveLength(0);
        const records = await waitFor(() => {
            const r = h.usage();
            return r.length >= 2 && r;
        });
        expect(records.map((r) => r.error)).toEqual(['no_key', 'no_key']);
    });

    it('400 for invalid JSON and non-object bodies, 413 for an oversized declared length', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        const { view, token } = await h.connect();
        const post = (body: string) =>
            fetch(`${h.proxy}/c/${view.id}/v1/chat/completions`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body,
            });
        const bad = await post('{ nope');
        expect(bad.status).toBe(400);
        const badBody: any = await bad.json();
        expect(badBody.error.code).toBe('invalid_json');
        expect(JSON.stringify(badBody)).not.toContain('nope');
        expect((await post('')).status).toBe(400);
        expect((await post('[1,2]')).status).toBe(400);

        const raw = await new Promise<string>((resolve, reject) => {
            const socket = net.connect(h.app.proxy.status().port, '127.0.0.1');
            let data = '';
            socket.on('data', (c) => (data += c.toString()));
            socket.on('close', () => resolve(data));
            socket.on('error', reject);
            socket.write(
                `POST /c/${view.id}/v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\n` +
                    `Content-Type: application/json\r\nContent-Length: ${40 * 1024 * 1024}\r\n\r\n`,
            );
        });
        expect(raw.startsWith('HTTP/1.1 413')).toBe(true);
        expect(raw).toContain('payload_too_large');
    });
});

describe('proxy: upstream errors', () => {
    it('passes a non-2xx status and an OpenAI-shaped error body through, with retry-after', async () => {
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
                res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit', code: 'rate_limited' } }));
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('7');
        expect(((await response.json()) as any).error).toEqual({
            message: 'slow down',
            type: 'rate_limit',
            code: 'rate_limited',
        });
        const [record] = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(record).toMatchObject({ status: 429, error: 'rate_limited' });
    });

    it('wraps a non-JSON error page in the OpenAI shape and never echoes the key', async () => {
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.writeHead(502, { 'content-type': 'text/html' });
                res.end(`<html><body><h1>Bad gateway</h1> for ${NANO_KEY}</body></html>`);
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(502);
        const text = await response.text();
        const json = JSON.parse(text);
        expect(json.error.type).toBe('upstream_error');
        expect(json.error.message).toContain('Bad gateway');
        expect(text).not.toContain(NANO_KEY);
        expect(text).not.toContain('<h1>');
    });

    it('502 upstream_unreachable when nothing listens', async () => {
        const dead = await closedPort();
        const h = await boot({
            config: { upstreamBase: `http://127.0.0.1:${dead}/api/v1`, upstreamFallbackBase: null },
        });
        closers.push(() => h.close());
        h.st.addNanoKey();
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(502);
        expect(((await response.json()) as any).error.code).toBe('upstream_unreachable');
        const [record] = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(record).toMatchObject({ status: 502, error: 'upstream_unreachable' });
    });

    it('504 upstream_timeout when the upstream never answers', async () => {
        const upstream = await upstreamFor(startServer(() => new Promise(() => {})));
        const h = await bootWith(upstream, { config: { timeoutMs: 150 } });
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(504);
        expect(((await response.json()) as any).error.code).toBe('upstream_timeout');
    });

    it('retries once on the fallback base after a connect-level failure', async () => {
        const dead = await closedPort();
        const fallback = await upstreamFor(jsonUpstream({ from: 'fallback' }));
        const h = await boot({
            config: {
                upstreamBase: `http://127.0.0.1:${dead}/api/v1`,
                upstreamFallbackBase: `${fallback.origin}/api/v1`,
            },
        });
        closers.push(() => h.close());
        h.st.addNanoKey();
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(200);
        expect(((await response.json()) as any).from).toBe('fallback');
        expect(fallback.requests).toHaveLength(1);
        expect(fallback.requests[0]!.headers['authorization']).toBe(`Bearer ${NANO_KEY}`);
    });

    it('does not use the fallback for an HTTP error answer, and 502s when both bases are dead', async () => {
        const failing = await upstreamFor(
            startServer((_req, res) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('{"error":{"message":"boom","code":"boom"}}');
            }),
        );
        const fallback = await upstreamFor(jsonUpstream());
        const h = await boot({
            config: { upstreamBase: `${failing.origin}/api/v1`, upstreamFallbackBase: `${fallback.origin}/api/v1` },
        });
        closers.push(() => h.close());
        h.st.addNanoKey();
        const { view, token } = await h.connect();
        expect((await chat(h, view.id, token, { messages: MESSAGES })).status).toBe(500);
        expect(failing.requests).toHaveLength(1);
        expect(fallback.requests).toHaveLength(0);

        const [d1, d2] = [await closedPort(), await closedPort()];
        const dead = await boot({
            config: {
                upstreamBase: `http://127.0.0.1:${d1}/api/v1`,
                upstreamFallbackBase: `http://127.0.0.1:${d2}/api/v1`,
            },
        });
        closers.push(() => dead.close());
        dead.st.addNanoKey();
        const other = await dead.connect();
        expect((await chat(dead, other.view.id, other.token, { messages: MESSAGES })).status).toBe(502);
    });
});

describe('proxy: streaming', () => {
    it('relays SSE chunk by chunk without buffering', async () => {
        const release = deferred();
        const upstream = await upstreamFor(
            startServer(async (_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
                await release.promise;
                res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES, stream: true });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('cache-control')).toBe('no-cache');
        expect(response.headers.get('x-nanovia-connection')).toBe(view.id);

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read(); // arrives while the upstream is still holding the rest back
        expect(decoder.decode(first.value)).toContain('"Hel"');
        release.resolve();
        let rest = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            rest += decoder.decode(value);
        }
        expect(rest).toContain('"lo"');
        expect(rest).toContain('[DONE]');

        const [record] = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(record).toMatchObject({ status: 200, stream: true, error: null });
        expect(JSON.parse(upstream.requests[0]!.body).stream).toBe(true);
        expect(upstream.requests[0]!.headers['accept']).toBe('text/event-stream');
    });

    it('aborts the upstream request when the client disconnects', async () => {
        const upstreamClosed = deferred<boolean>();
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.on('close', () => upstreamClosed.resolve(!res.writableFinished));
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
                // never ends by itself
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const controller = new AbortController();
        const response = await chat(
            h,
            view.id,
            token,
            { messages: MESSAGES, stream: true },
            { signal: controller.signal },
        );
        const reader = response.body!.getReader();
        await reader.read();
        controller.abort();
        await reader.read().catch(() => undefined);
        expect(await upstreamClosed.promise).toBe(true);
        const [record] = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(record).toMatchObject({ status: 499, error: 'client_closed', stream: true });
    });

    it('aborts the upstream request when the client leaves before the answer of a non-streamed call', async () => {
        const upstreamClosed = deferred<boolean>();
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.on('close', () => upstreamClosed.resolve(!res.writableFinished));
                // never answers
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const controller = new AbortController();
        const pending = chat(h, view.id, token, { messages: MESSAGES }, { signal: controller.signal }).catch(
            () => null,
        );
        await waitFor(() => upstream.requests.length > 0);
        controller.abort();
        await pending;
        expect(await upstreamClosed.promise).toBe(true);
    });

    it('ends a stream with an error event when the upstream goes silent', async () => {
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
            }),
        );
        const h = await bootWith(upstream, { config: { timeoutMs: 200 } });
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES, stream: true });
        const text = await response.text();
        expect(text).toContain('"a"');
        expect(text).toContain('upstream_timeout');
        const [record] = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(record).toMatchObject({ status: 504, error: 'upstream_timeout' });
    });

    it('passes a JSON error through even when streaming was requested', async () => {
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end('{"error":{"message":"bad model","code":"bad_model"}}');
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES, stream: true });
        expect(response.status).toBe(400);
        expect(((await response.json()) as any).error.code).toBe('bad_model');
    });
});

describe('proxy: pipeline wiring and safety', () => {
    it('runs request steps in order and response steps afterwards; a failing response step does not fail the request', async () => {
        const order: string[] = [];
        const steps: PipelineSteps = {
            request: [
                (ctx) => {
                    order.push('req1');
                    ctx.plan.body['injected'] = true;
                    ctx.plan.headers['x-billing-mode'] = 'paygo';
                },
                async () => {
                    await sleep(5);
                    order.push('req2');
                },
            ],
            response: [
                (ctx) => {
                    order.push(`res:${ctx.upstream?.status}`);
                    ctx.usage.billing = 'paygo';
                    ctx.responseHeaders['x-nanovia-extra'] = 'yes';
                },
                () => {
                    throw new Error('boom');
                },
            ],
        };
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream, { steps });
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(200);
        expect(response.headers.get('x-nanovia-extra')).toBe('yes');
        expect(order).toEqual(['req1', 'req2', 'res:200']);
        expect(JSON.parse(upstream.requests[0]!.body).injected).toBe(true);
        expect(upstream.requests[0]!.headers['x-billing-mode']).toBe('paygo');
        const [record] = await waitFor(() => {
            const r = h.usage();
            return r.length > 0 && r;
        });
        expect(record!.billing).toBe('paygo');
    });

    it('lets a plan never override the authorization header', async () => {
        const upstream = await upstreamFor(jsonUpstream());
        const h = await bootWith(upstream, {
            steps: {
                request: [
                    (ctx) => {
                        ctx.plan.headers['Authorization'] = 'Bearer attacker';
                    },
                ],
                response: [],
            },
        });
        const { view, token } = await h.connect();
        await chat(h, view.id, token, { messages: MESSAGES });
        expect(upstream.requests[0]!.headers['authorization']).toBe(`Bearer ${NANO_KEY}`);
    });

    it('answers 500 when a request step throws, without leaking its message', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()), {
            steps: {
                request: [
                    () => {
                        throw new Error(`exploded with ${NANO_KEY}`);
                    },
                ],
                response: [],
            },
        });
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES });
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(text).not.toContain(NANO_KEY);
        expect(h.logs.join('\n')).not.toContain(NANO_KEY);
    });

    it('never logs keys, tokens or request bodies', async () => {
        const upstream = await upstreamFor(
            startServer((_req, res) => {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(`{"error":{"message":"fail ${NANO_KEY}","code":"x"}}`);
            }),
        );
        const h = await bootWith(upstream);
        const { view, token } = await h.connect();
        await chat(h, view.id, token, { messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }] });
        await chat(h, view.id, 'wrong-token-value', { messages: MESSAGES });
        const logs = h.logs.join('\n');
        for (const secret of [NANO_KEY, token, 'wrong-token-value', 'TOP-SECRET-PROMPT']) {
            expect(logs).not.toContain(secret);
        }
    });

    it('stays up with the admin routes working when the port is taken', async () => {
        const blocker = await startServer(() => {});
        closers.push(() => blocker.close());
        const h = await boot({ config: { port: blocker.port } });
        closers.push(() => h.close());
        expect(h.app.status.up).toBe(false);
        expect(h.logs.some((l) => l.startsWith('error') && l.includes('already in use'))).toBe(true);
        const status = await h.api('GET', '/status');
        expect(status.status).toBe(200);
        expect(status.json['proxy']).toMatchObject({ up: false, host: '127.0.0.1', port: blocker.port });
        const created = await h.api('POST', '/connections', { name: 'Still works', modelId: 'm' });
        expect(created.status).toBe(200);
    });

    it('binds 127.0.0.1 only', async () => {
        const h = await bootWith(await upstreamFor(jsonUpstream()));
        expect(h.app.proxy.status()).toMatchObject({ up: true, host: '127.0.0.1' });
        expect(h.app.proxy.status().port).toBeGreaterThan(0);
    });
});
