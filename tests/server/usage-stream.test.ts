// Stage 0.4 on the response path, streamed: SSE goes through chunk by chunk with no added latency, events without usage are
// byte-identical, only the event that carries usage is rewritten, and the usage record survives a client abort.
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
    boot,
    chat,
    cleanTempDirs,
    deferred,
    sleep,
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

const MESSAGES = [{ role: 'user', content: 'hi' }];
const TIMEOUT = Symbol('timeout');

/** An upstream that answers with an event stream and lets the test script what is written when. */
async function sse(script: (res: http.ServerResponse) => Promise<void> | void): Promise<TestServer> {
    const server = await startServer(async (_req, res) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-request-id': 'up-stream-1',
        });
        await script(res);
    });
    closers.push(() => server.close());
    return server;
}

async function bootOn(server: TestServer, config: Parameters<typeof boot>[0] = {}): Promise<Harness> {
    const h = await boot({
        ...config,
        config: { upstreamBase: `${server.origin}/api/v1`, upstreamFallbackBase: null, ...config.config },
    });
    closers.push(() => h.close());
    h.st.addNanoKey();
    return h;
}

async function records(h: Harness, count = 1): Promise<Record<string, any>[]> {
    return waitFor(() => {
        const found = h.usage();
        return found.length >= count && found;
    });
}

/** A read that timed out is still pending: the next call must wait for the same read, not start another. */
const pendingReads = new WeakMap<object, Promise<ReadableStreamReadResult<Uint8Array>>>();

/** The next chunk of a streamed reply, null at the end, or TIMEOUT when nothing arrives within `ms`. */
async function next(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    ms = 2000,
): Promise<Buffer | null | typeof TIMEOUT> {
    const read = pendingReads.get(reader) ?? reader.read();
    pendingReads.set(reader, read);
    const result = await Promise.race([read, sleep(ms).then((): typeof TIMEOUT => TIMEOUT)]);
    if (result === TIMEOUT) return TIMEOUT;
    pendingReads.delete(reader);
    return result.done ? null : Buffer.from(result.value);
}

async function readAll(response: Response): Promise<Buffer> {
    return Buffer.from(await response.arrayBuffer());
}

const event = (data: unknown): string => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (content: string) => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

/** The final event as NanoGPT really sends it: finish_reason, `x_nanogpt_pricing` and `usage` in one event. */
const FINAL = {
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1_800_000_000,
    model: 'z-ai/glm-5.3',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    x_nanogpt_pricing: { cost: 0.0021, inputTokens: 100, outputTokens: 20, isEstimate: false, paymentSource: 'USD' },
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0021, currency: 'USD' },
};

describe('streamed relay: no added latency', () => {
    it('forwards each event the moment it is complete, byte-identical', async () => {
        const first = event(delta('Hel'));
        const second = event(delta('lo'));
        const gates = [deferred(), deferred()];
        const server = await sse(async (res) => {
            res.write(first);
            await gates[0]!.promise;
            res.write(second);
            await gates[1]!.promise;
            res.write(event(FINAL));
            res.write('data: [DONE]\n\n');
            res.end();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES, stream: true });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();

        // the first event is here while the upstream still holds everything else back
        expect((await next(reader))!.toString('utf8')).toBe(first);
        gates[0]!.resolve();
        expect((await next(reader))!.toString('utf8')).toBe(second);
        gates[1]!.resolve();
        let rest = '';
        for (let chunk = await next(reader); chunk !== null; chunk = await next(reader)) {
            expect(chunk).not.toBe(TIMEOUT);
            rest += (chunk as Buffer).toString('utf8');
        }
        expect(rest.endsWith('data: [DONE]\n\n')).toBe(true);
    });

    it('holds a half event and lets it go the moment its end arrives', async () => {
        const gate = deferred();
        const whole = event(delta('partial'));
        const cut = whole.indexOf('"par') + 4;
        const server = await sse(async (res) => {
            res.write(whole.slice(0, cut));
            await gate.promise;
            res.write(whole.slice(cut));
            res.write('data: [DONE]\n\n');
            res.end();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES, stream: true });
        const reader = response.body!.getReader();
        expect(await next(reader, 150)).toBe(TIMEOUT); // an unfinished event is not an event yet
        gate.resolve();
        expect(await readAllFrom(reader)).toBe(whole + 'data: [DONE]\n\n');
    });

    it('relays many events in order when the upstream cuts the bytes anywhere', async () => {
        let seed = 7;
        const random = (): number => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        const events = Array.from({ length: 400 }, (_, i) => event(delta(`word ${i} — ünï ${'x'.repeat(i % 37)}`)));
        const wire = Buffer.from(events.join('') + event(FINAL) + 'data: [DONE]\n\n', 'utf8');
        const server = await sse(async (res) => {
            for (let at = 0; at < wire.length;) {
                const size = 1 + Math.floor(random() * 300);
                res.write(wire.subarray(at, at + size));
                at += size;
                if (random() < 0.05) await sleep(1);
            }
            res.end();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const body = (await readAll(await chat(h, view.id, token, { messages: MESSAGES, stream: true }))).toString(
            'utf8',
        );
        const prefix = events.join('');
        expect(body.startsWith(prefix)).toBe(true);
        const tail = body.slice(prefix.length).split('\n\n');
        expect(tail).toHaveLength(3);
        expect(JSON.parse(tail[0]!.replace(/^data: /, '')).usage.nanovia).toBeDefined();
        expect(tail[1]).toBe('data: [DONE]');
    });
});

describe('streamed relay: what is left alone', () => {
    it('forwards events without usage byte for byte: comments, CRLF, CR, split multi-byte text, the word usage in text', async () => {
        const wire = Buffer.from(
            ': keep-alive\r\n\r\n' +
                event(delta('usage: high usage, cost 5')) +
                'event: ping\r\nid: 4\r\ndata: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n' +
                'data: {"choices":[{"delta":{"content":"cr"}}]}\r\r' +
                event(delta('é — 日本語 😀 ünï')) +
                'data: {"usage": null, "choices":[{"delta":{"content":"null usage"}}]}\n\n' +
                'data: [DONE]\n\n',
            'utf8',
        );
        // cut inside a multi-byte character as well as inside lines
        const cuts = [
            3,
            14,
            40,
            wire.indexOf(Buffer.from('é')) + 1,
            wire.indexOf(Buffer.from('日')) + 2,
            wire.length - 5,
        ];
        const server = await sse(async (res) => {
            let at = 0;
            for (const cut of [...cuts, wire.length]) {
                res.write(wire.subarray(at, cut));
                at = cut;
                await sleep(2);
            }
            res.end();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const body = await readAll(await chat(h, view.id, token, { messages: MESSAGES, stream: true }));
        expect(body.equals(wire)).toBe(true);
        expect((await records(h))[0]).toMatchObject({
            billing: 'unknown',
            costUsd: null,
            promptTokens: null,
            stream: true,
        });
    });

    it('flushes an event the upstream never terminated at the end, rewritten when it carries usage', async () => {
        const server = await sse((res) => {
            res.write(event(delta('a')));
            res.end(`data: ${JSON.stringify(FINAL)}\n`); // no blank line, then the connection closes
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const text = (await readAll(await chat(h, view.id, token, { messages: MESSAGES, stream: true }))).toString(
            'utf8',
        );
        const [, last] = text.split('\n\n');
        const final = JSON.parse(last!.trim().replace(/^data: /, ''));
        expect(final.usage).toMatchObject({ cost: 0.0021, nanovia: { billing: 'paygo' } });
        expect((await records(h))[0]).toMatchObject({ promptTokens: 100, completionTokens: 20, costUsd: 0.0021 });
    });
});

describe('streamed relay: the usage event', () => {
    it('is rewritten (real USD, nanovia block), the rest of it and the other events stay as they were', async () => {
        const deltas = [event(delta('Hel')), event(delta('lo'))];
        const server = await sse((res) => {
            for (const d of deltas) res.write(d);
            res.write(event(FINAL));
            res.write('data: [DONE]\n\n');
            res.end();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const response = await chat(h, view.id, token, { messages: MESSAGES, stream: true });
        expect(response.headers.get('x-nanovia-request-id')).toBe('up-stream-1');
        const text = (await readAll(response)).toString('utf8');
        const events = text.split('\n\n');
        expect(events.slice(0, 2).map((e) => `${e}\n\n`)).toEqual(deltas);
        const { usage, ...rest } = JSON.parse(events[2]!.replace(/^data: /, ''));
        const originalRest: Record<string, unknown> = { ...FINAL };
        delete originalRest['usage'];
        expect(rest).toEqual(originalRest); // choices (finish_reason) and x_nanogpt_pricing untouched
        expect(usage).toMatchObject({
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            cost: 0.0021,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
            nanovia: { billing: 'paygo', request_id: 'up-stream-1' },
        });
        expect(usage).not.toHaveProperty('currency');
        expect(`${events[3]}\n\n`).toBe('data: [DONE]\n\n');
        expect(events).toHaveLength(5);

        const [record] = await records(h);
        expect(record).toMatchObject({
            connectionId: view.id,
            requestId: 'up-stream-1',
            billing: 'paygo',
            costUsd: 0.0021,
            promptTokens: 100,
            completionTokens: 20,
            status: 200,
            stream: true,
            error: null,
        });
    });

    it('through the mock: a subscription stream ends with usage.cost 0 and a subscription record', async () => {
        const s: MockStack = await startMockStack();
        closers.push(() => s.close());
        const { view, token } = await s.h.connect({ modelId: 'deepseek/deepseek-v4.1-flash', modelLock: true });
        const response = await chat(s.h, view.id, token, { messages: MESSAGES, stream: true });
        expect(response.headers.get('x-nanovia-billing')).toBe('subscription');
        const events = (await readAll(response))
            .toString('utf8')
            .split('\n\n')
            .filter(Boolean)
            .map((e) => e.replace(/^data: /, ''));
        expect(events.at(-1)).toBe('[DONE]');
        const frames = events.slice(0, -1).map((e) => JSON.parse(e));
        const withUsage = frames.filter((f) => f.usage);
        expect(withUsage).toHaveLength(1);
        expect(withUsage[0].usage).toMatchObject({ cost: 0, nanovia: { billing: 'subscription' } });
        expect(withUsage[0].usage.nanovia.equivalent_usd).toBeGreaterThan(0);
        expect(frames.filter((f) => !f.usage).every((f) => !('nanovia' in f))).toBe(true);
        const [record] = await records(s.h);
        expect(record).toMatchObject({ billing: 'subscription', costUsd: 0, stream: true, status: 200 });
        expect(record!.requestId).toBe(response.headers.get('x-nanovia-request-id'));
    });
});

describe('streamed relay: aborts and failures', () => {
    it('a client that leaves after the usage event still gets a record with what is known', async () => {
        const closed = deferred<boolean>();
        const server = await sse((res) => {
            res.on('close', () => closed.resolve(!res.writableFinished));
            res.write(event(delta('a')));
            res.write(event(FINAL)); // the stream stays open: no [DONE], no end
        });
        const h = await bootOn(server);
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
        let seen = '';
        while (!seen.includes('"nanovia"')) seen += Buffer.from((await reader.read()).value ?? []).toString('utf8');
        controller.abort();
        await reader.read().catch(() => undefined);
        expect(await closed.promise).toBe(true); // the upstream request was aborted too
        const [record] = await records(h);
        expect(record).toMatchObject({
            status: 499,
            error: 'client_aborted',
            stream: true,
            promptTokens: 100,
            completionTokens: 20,
            costUsd: 0.0021,
            billing: 'paygo',
        });
    });

    it('a client that leaves before any usage gets a record that guesses nothing', async () => {
        const server = await sse((res) => {
            res.write(event(delta('a'))); // never ends
        });
        const h = await bootOn(server);
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
        const [record] = await records(h);
        expect(record).toMatchObject({
            status: 499,
            error: 'client_aborted',
            billing: 'unknown',
            costUsd: null,
            equivalentUsd: null,
            promptTokens: null,
            completionTokens: null,
            requestId: 'up-stream-1',
        });
    });

    it('the abort error is for the record only: nothing of it is written to the HTTP response', async () => {
        const server = await sse((res) => {
            res.write(event(delta('a')));
            res.write(event(FINAL));
            res.end();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const body = (await readAll(await chat(h, view.id, token, { messages: MESSAGES, stream: true }))).toString(
            'utf8',
        );
        expect(body).not.toContain('client_aborted');
        expect((await records(h))[0]).toMatchObject({ error: null, status: 200 });
    });

    it('when the upstream breaks in the middle of an event the client gets the complete events and an error event', async () => {
        const server = await sse(async (res) => {
            res.write(event(delta('whole')));
            res.write('data: {"choices":[{"delta":{"content":"cut'); // half an event
            await sleep(20);
            res.destroy();
        });
        const h = await bootOn(server);
        const { view, token } = await h.connect();
        const text = (await readAll(await chat(h, view.id, token, { messages: MESSAGES, stream: true }))).toString(
            'utf8',
        );
        expect(text.startsWith(event(delta('whole')))).toBe(true);
        expect(text).not.toContain('"cut');
        expect(text).toContain('upstream_unreachable');
        expect((await records(h))[0]).toMatchObject({ status: 502, error: 'upstream_unreachable', stream: true });
    });
});

async function readAllFrom(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    let text = '';
    for (let chunk = await next(reader); chunk !== null; chunk = await next(reader)) {
        if (chunk === TIMEOUT) throw new Error('the stream stalled');
        text += chunk.toString('utf8');
    }
    return text;
}
