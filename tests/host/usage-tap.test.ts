import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectMode } from '../../src/host/direct-mode';
import type { DirectModeDeps } from '../../src/host/direct-mode';
import { GENERATE_PATH, installFetchHook } from '../../src/host/fetch-hook';
import type { DirectRequestInfo, FetchHookHandle } from '../../src/host/fetch-hook';
import { errorOf, tapUsage } from '../../src/host/usage-tap';
import type { UsageTapArgs } from '../../src/host/usage-tap';
import { NANOGPT_API_BASE } from '../../src/shared/constants';
import type { UsageRecord } from '../../src/shared/contracts';
import { flush, memoryLogger } from '../helpers/fakes';
import { catalogOf, makeConnection, makeModel } from '../helpers/plan-fixtures';

const INFO: DirectRequestInfo = {
    connectionId: 'abc12345',
    modelId: 'vendor/model',
    billingModeForced: false,
    explicitRouting: false,
};

const USAGE = {
    prompt_tokens: 120,
    completion_tokens: 40,
    total_tokens: 160,
    cost: 0,
    prompt_tokens_details: { cached_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 7 },
};

const encoder = new TextEncoder();

function sse(...events: unknown[]): string {
    return events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

/** A streamed Response whose chunks arrive one by one (each on its own macrotask). */
function streamed(chunks: (string | Error)[], init: ResponseInit = {}): Response {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            await flush();
            const next = chunks[index++];
            if (next === undefined) controller.close();
            else if (next instanceof Error) controller.error(next);
            else controller.enqueue(encoder.encode(next));
        },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
    });
}

interface Tap {
    records: UsageRecord[];
    run(response: Response, over?: Partial<UsageTapArgs>): Promise<void>;
    log: ReturnType<typeof memoryLogger>;
}

function tap(): Tap {
    const records: UsageRecord[] = [];
    const log = memoryLogger();
    let clock = 1_000;
    return {
        records,
        log,
        run: (response, over = {}) =>
            tapUsage({
                response,
                info: INFO,
                consumer: 'main',
                stream: false,
                startedAt: 1_000,
                now: () => (clock += 250),
                model: makeModel(),
                emit: (record) => void records.push(record),
                log,
                ...over,
            }),
    };
}

describe('tapUsage: a non-streamed answer', () => {
    it('reads usage from the JSON body and builds a record', async () => {
        const t = tap();
        const response = json(
            { id: 'x', choices: [], usage: USAGE },
            { headers: { 'content-type': 'application/json', 'x-request-id': 'req-9' } },
        );
        await t.run(response);
        expect(t.records).toEqual([
            {
                at: 1_000,
                connectionId: 'abc12345',
                requestId: 'req-9',
                model: 'vendor/model',
                billing: 'subscription',
                costUsd: 0,
                equivalentUsd: 0.0002,
                promptTokens: 120,
                completionTokens: 40,
                cachedTokens: 20,
                reasoningTokens: 7,
                latencyMs: 250,
                status: 200,
                stream: false,
                consumer: 'main',
                error: null,
            },
        ]);
    });

    it('does not consume the response ST receives', async () => {
        const t = tap();
        const response = json({ id: 'x', usage: USAGE });
        await t.run(response);
        expect(await response.json()).toEqual({ id: 'x', usage: USAGE });
    });

    it('takes the request id from NanoGPT pricing when the header is gone (ST drops upstream headers)', async () => {
        const t = tap();
        await t.run(
            json({
                usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 },
                x_nanogpt_pricing: { requestId: 'req-body', cost: 0.5, isEstimate: false },
            }),
        );
        expect(t.records[0]).toMatchObject({ requestId: 'req-body', billing: 'paygo', costUsd: 0.5 });
    });

    it('records an answer without usage as unknown, with no tokens', async () => {
        const t = tap();
        await t.run(json({ id: 'x', choices: [] }));
        expect(t.records[0]).toMatchObject({
            billing: 'unknown',
            costUsd: null,
            promptTokens: null,
            error: null,
            status: 200,
        });
    });

    it('records the billing context of the plan: forced pay-as-you-go and explicit routing', async () => {
        const t = tap();
        await t.run(json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
            info: { ...INFO, billingModeForced: true },
        });
        expect(t.records[0]?.billing).toBe('paygo');
    });

    it('records an error answer with its status and message', async () => {
        const t = tap();
        await t.run(json({ error: { message: 'rate limited', code: 429 } }, { status: 429 }));
        expect(t.records[0]).toMatchObject({
            status: 429,
            error: 'rate limited',
            billing: 'unknown',
            costUsd: null,
            promptTokens: null,
        });
    });

    it('keeps a short error for a body that is not JSON', async () => {
        const t = tap();
        await t.run(new Response('<html>Bad gateway</html>', { status: 502 }));
        expect(t.records[0]).toMatchObject({ status: 502, error: '<html>Bad gateway</html>' });
    });

    it('uses the stream flag of the answer when the request asked for a stream but got JSON', async () => {
        const t = tap();
        await t.run(json({ usage: USAGE }), { stream: true });
        expect(t.records[0]?.stream).toBe(false);
    });
});

describe('tapUsage: a streamed answer', () => {
    const content = { choices: [{ delta: { content: 'Hello' } }], usage: null };
    const last = { choices: [], usage: USAGE };

    it('finds the usage event, also when it is split across chunks', async () => {
        const t = tap();
        const text = sse(content, content, last, '[DONE]');
        const cut = text.indexOf('"completion_tokens"') + 8;
        await t.run(streamed([text.slice(0, 20), text.slice(20, cut), text.slice(cut)]), { stream: true });
        expect(t.records).toHaveLength(1);
        expect(t.records[0]).toMatchObject({
            stream: true,
            promptTokens: 120,
            completionTokens: 40,
            cachedTokens: 20,
            reasoningTokens: 7,
            billing: 'subscription',
            costUsd: 0,
            status: 200,
            error: null,
        });
    });

    it('finds a multi-byte character split in the middle', async () => {
        const t = tap();
        const bytes = encoder.encode(sse({ choices: [{ delta: { content: 'Привет, мир' } }] }, last));
        const at = bytes.indexOf(0xd0) + 1;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, at));
                controller.enqueue(bytes.slice(at));
                controller.close();
            },
        });
        await t.run(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { stream: true });
        expect(t.records[0]).toMatchObject({ promptTokens: 120 });
    });

    it('leaves the response ST reads byte for byte as it was', async () => {
        const t = tap();
        const text = sse(content, last, '[DONE]');
        const response = streamed([text.slice(0, 30), text.slice(30)]);
        const done = t.run(response, { stream: true });
        // ST reads the original while the tap reads its clone.
        expect(await response.text()).toBe(text);
        await done;
        expect(t.records[0]?.promptTokens).toBe(120);
    });

    it('records no usage for a stream that never sent any', async () => {
        const t = tap();
        await t.run(streamed([sse(content), sse('[DONE]')]), { stream: true });
        expect(t.records[0]).toMatchObject({ billing: 'unknown', promptTokens: null, error: null, stream: true });
    });

    it('keeps the last usage event and ignores `usage: null` ones', async () => {
        const t = tap();
        const first = { usage: { prompt_tokens: 5, completion_tokens: 1 } };
        await t.run(streamed([sse(content, first, last)]), { stream: true });
        expect(t.records[0]?.promptTokens).toBe(120);
    });

    it('reads the pricing block that rides on the usage event', async () => {
        const t = tap();
        const event = {
            usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.25 },
            x_nanogpt_pricing: { requestId: 'req-sse' },
        };
        await t.run(streamed([sse(event)]), { stream: true });
        expect(t.records[0]).toMatchObject({ requestId: 'req-sse', costUsd: 0.25, billing: 'paygo' });
    });

    it('records a broken stream with what it saw and an error code', async () => {
        const t = tap();
        const text = sse(content, last);
        await t.run(streamed([text, new Error('connection reset')]), { stream: true });
        expect(t.records[0]).toMatchObject({ promptTokens: 120, error: 'stream_error' });
    });

    it('calls an abort an abort', async () => {
        const t = tap();
        const abort = new DOMException('aborted', 'AbortError');
        await t.run(streamed([sse(content), abort as unknown as Error]), { stream: true });
        expect(t.records[0]).toMatchObject({ promptTokens: null, error: 'client_aborted' });
    });

    it('treats a stream without a content type as a stream when the request asked for one', async () => {
        const t = tap();
        await t.run(new Response(sse(last)), { stream: true });
        expect(t.records[0]).toMatchObject({ stream: true, promptTokens: 120 });
    });
});

describe('tapUsage: failures', () => {
    it('swallows every failure and logs it at debug level', async () => {
        const t = tap();
        const used = json({ usage: USAGE });
        await used.text();
        await expect(t.run(used)).resolves.toBeUndefined();
        expect(t.records).toEqual([]);
        expect(t.log.lines.some((line) => line.level === 'debug')).toBe(true);
        expect(t.log.lines.every((line) => line.level === 'debug')).toBe(true);
    });

    it('survives an emit that throws', async () => {
        const t = tap();
        await expect(
            t.run(json({ usage: USAGE }), {
                emit: () => {
                    throw new Error('listener bug');
                },
            }),
        ).resolves.toBeUndefined();
        expect(t.log.lines.some((line) => line.level === 'debug')).toBe(true);
    });
});

describe('errorOf', () => {
    it('reads OpenAI-style errors', () => {
        expect(errorOf({ error: { message: 'bad' } })).toBe('bad');
        expect(errorOf({ error: { code: 'x_code' } })).toBe('x_code');
        expect(errorOf({ error: 'plain' })).toBe('plain');
        expect(errorOf({ error: {} })).toBe('error');
        expect(errorOf({ error: null })).toBeNull();
        expect(errorOf('nope')).toBeNull();
        expect(errorOf({ error: { message: 'x'.repeat(500) } })?.length).toBeLessThan(400);
    });
});

describe('the tap in the fetch wrapper', () => {
    let handle: FetchHookHandle | undefined;
    let realFetch: typeof fetch;
    let records: UsageRecord[];
    let answer: () => Response;

    beforeEach(() => {
        records = [];
        realFetch = globalThis.fetch;
        globalThis.fetch = (async () => answer()) as typeof fetch;
    });

    afterEach(() => {
        handle?.uninstall();
        handle = undefined;
        globalThis.fetch = realFetch;
    });

    function setup(): void {
        const connection = makeConnection({ routing: { enabled: true, order: ['alpha'] } });
        const catalog = catalogOf([makeModel()]);
        const deps: DirectModeDeps = {
            connections: () => [{ config: connection, effectiveMode: 'direct' }],
            directSecrets: () => ({ [connection.id]: 's1' }),
            model: (id) => catalog.model(id),
            providers: (id) => catalog.providers(id),
            emit: (record) => void records.push(record),
            log: memoryLogger(),
        };
        const mode = createDirectMode(deps);
        handle = installFetchHook(memoryLogger());
        handle.register(mode.hook);
        handle.observe(mode.observer);
    }

    function generate(body: Record<string, unknown>): Promise<Response> {
        return fetch(GENERATE_PATH, { method: 'POST', body: JSON.stringify(body) });
    }

    const request = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        chat_completion_source: 'custom',
        custom_url: NANOGPT_API_BASE,
        secret_id: 's1',
        model: 'vendor/model',
        type: 'normal',
        ...over,
    });

    it('emits a record for a direct request, with the billing context of the plan', async () => {
        setup();
        answer = () => json({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 } });
        const response = await generate(request());
        // The original is untouched and still readable by whoever called fetch.
        expect(await response.json()).toEqual({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 } });
        await vi.waitFor(() => expect(records).toHaveLength(1));
        expect(records[0]).toMatchObject({
            connectionId: 'abc12345',
            model: 'vendor/model',
            billing: 'paygo',
            costUsd: 0.01,
            promptTokens: 10,
            consumer: 'main',
            stream: false,
            status: 200,
        });
        expect(records[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns the response before the stream has finished (the tap never holds it back)', async () => {
        setup();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => void (release = resolve));
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: 'a' } }] })));
                await gate;
                controller.enqueue(encoder.encode(sse({ choices: [], usage: USAGE })));
                controller.close();
            },
        });
        answer = () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
        const response = await generate(request({ stream: true, type: 'quiet' }));
        expect(records).toEqual([]);
        release();
        const text = await response.text();
        expect(text).toContain('"usage"');
        await vi.waitFor(() => expect(records).toHaveLength(1));
        expect(records[0]).toMatchObject({ stream: true, consumer: 'background', promptTokens: 120 });
    });

    it('stays silent for requests that are not direct Nanovia requests', async () => {
        setup();
        answer = () => json({ usage: USAGE });
        await generate(request({ custom_url: 'https://example.com/v1' }));
        await generate(request({ secret_id: 'other' }));
        await generate({ chat_completion_source: 'openai' });
        await fetch('/api/other', { method: 'POST', body: '{}' });
        await flush();
        await flush();
        expect(records).toEqual([]);
    });

    it('does not notify observers that were removed, and survives one that throws', async () => {
        setup();
        const seen = vi.fn();
        const off = handle!.observe(seen);
        handle!.observe(() => {
            throw new Error('observer bug');
        });
        off();
        answer = () => json({ usage: USAGE });
        const response = await generate(request());
        expect(response.status).toBe(200);
        expect(seen).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(records).toHaveLength(1));
    });
});
