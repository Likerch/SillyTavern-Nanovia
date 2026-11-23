import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    GENERATE_PATH,
    addIncludeBody,
    addIncludeHeaders,
    hintsOf,
    inspectGenerateBody,
    installFetchHook,
    proxyHintsHook,
} from '../../src/host/fetch-hook';
import type { FetchHookHandle, GenerateRequest, ResponseInfo } from '../../src/host/fetch-hook';
import { memoryLogger } from '../helpers/fakes';

const PROXY = 'http://127.0.0.1:8787/c/abc12345/v1';

let sent: { url: string; init?: RequestInit }[];
let realFetch: typeof fetch;
let handle: FetchHookHandle;

beforeEach(() => {
    sent = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
        return new Response('{}', { status: 200 });
    }) as typeof fetch;
});

afterEach(() => {
    handle?.uninstall();
    globalThis.fetch = realFetch;
});

describe('the wrapper keeps the browser contract of fetch', () => {
    it('calls the original fetch with the window as `this` (a browser throws "Illegal invocation" otherwise)', async () => {
        const seen: unknown[] = [];
        const scope = {
            fetch: function (this: unknown): Promise<Response> {
                seen.push(this);
                return Promise.resolve(new Response('{}'));
            },
        } as unknown as typeof globalThis;
        const own = installFetchHook(memoryLogger(), scope);
        await (scope.fetch as unknown as (input: string) => Promise<Response>)('/api/anything');
        expect(seen).toEqual([scope]);
        own.uninstall();
    });
});

function post(body: unknown, url: string = GENERATE_PATH): Promise<Response> {
    return fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

function sentBody(index = 0): Record<string, unknown> {
    return JSON.parse(String(sent[index]?.init?.body)) as Record<string, unknown>;
}

describe('inspectGenerateBody', () => {
    it('finds proxy and direct targets of the Custom source only', () => {
        expect(inspectGenerateBody({ chat_completion_source: 'custom', custom_url: PROXY }).target).toEqual({
            kind: 'proxy',
            connectionId: 'abc12345',
            port: 8787,
        });
        expect(
            inspectGenerateBody({ chat_completion_source: 'custom', custom_url: 'https://api.nano-gpt.com/api/v1' })
                .target,
        ).toEqual({ kind: 'direct' });
        expect(
            inspectGenerateBody({ chat_completion_source: 'custom', custom_url: 'https://nano-gpt.com/api/v1/' })
                .target,
        ).toEqual({ kind: 'direct' });
        expect(
            inspectGenerateBody({ chat_completion_source: 'custom', custom_url: 'https://example.com/v1' }).target,
        ).toBeNull();
        expect(inspectGenerateBody({ chat_completion_source: 'openai', custom_url: PROXY }).target).toBeNull();
        expect(inspectGenerateBody({}).target).toBeNull();
    });

    it('tells the chat generation from background requests', () => {
        expect(inspectGenerateBody({ type: 'normal' }).consumer).toBe('main');
        expect(inspectGenerateBody({ type: 'impersonate' }).consumer).toBe('main');
        expect(inspectGenerateBody({ type: 'quiet' }).consumer).toBe('background');
        expect(inspectGenerateBody({}).consumer).toBe('background');
    });

    it('reads the secret id', () => {
        expect(inspectGenerateBody({ secret_id: 's-1' }).secretId).toBe('s-1');
        expect(inspectGenerateBody({ secret_id: '' }).secretId).toBeNull();
        expect(inspectGenerateBody({ secret_id: 5 }).secretId).toBeNull();
    });
});

describe('hintsOf', () => {
    it('takes effort and show-thoughts from the body', () => {
        expect(hintsOf({ body: { reasoning_effort: 'high', include_reasoning: true }, consumer: 'main' })).toEqual({
            effort: 'high',
            consumer: 'main',
            thoughts: true,
        });
        expect(hintsOf({ body: { include_reasoning: 'yes' }, consumer: 'background' })).toEqual({
            effort: null,
            consumer: 'background',
            thoughts: false,
        });
    });
});

describe('the wrapper', () => {
    it('is idempotent: installing twice shares one wrapper and its hooks', async () => {
        handle = installFetchHook(memoryLogger());
        const wrapper = globalThis.fetch;
        const again = installFetchHook(memoryLogger());
        expect(globalThis.fetch).toBe(wrapper);
        const seen = vi.fn();
        again.register(seen);
        expect(handle.hookCount()).toBe(1);
        await post({ chat_completion_source: 'custom', custom_url: PROXY });
        expect(seen).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(1);
    });

    it('wraps again around a fetch that something else replaced', async () => {
        handle = installFetchHook(memoryLogger());
        const first = globalThis.fetch;
        const other = (async (input: RequestInfo | URL, init?: RequestInit) => first(input, init)) as typeof fetch;
        globalThis.fetch = other;
        const second = installFetchHook(memoryLogger());
        expect(globalThis.fetch).not.toBe(other);
        const seen = vi.fn();
        second.register(seen);
        await post({ chat_completion_source: 'custom', custom_url: PROXY });
        expect(seen).toHaveBeenCalledOnce();
        second.uninstall();
    });

    it('runs hooks in order on a generate POST and sends the changed body', async () => {
        handle = installFetchHook(memoryLogger());
        const order: string[] = [];
        handle.register((request) => {
            order.push('a');
            request.body['first'] = true;
        });
        handle.register(async (request) => {
            order.push('b');
            request.body['second'] = request.body['first'];
        });
        await post({ chat_completion_source: 'custom', custom_url: PROXY, messages: [] });
        expect(order).toEqual(['a', 'b']);
        expect(sentBody()).toMatchObject({ first: true, second: true, messages: [] });
    });

    it('hands the target, secret and consumer to hooks', async () => {
        handle = installFetchHook(memoryLogger());
        let seen: GenerateRequest | null = null;
        handle.register((request) => void (seen = request));
        await post({ chat_completion_source: 'custom', custom_url: PROXY, secret_id: 's1', type: 'normal' });
        expect(seen).toMatchObject({
            target: { kind: 'proxy', connectionId: 'abc12345' },
            secretId: 's1',
            consumer: 'main',
        });
    });

    it('leaves the request exactly as it was when no hook changed the body', async () => {
        handle = installFetchHook(memoryLogger());
        handle.register(() => {});
        const init = { method: 'POST', body: '{ "chat_completion_source":"openai" }' };
        await fetch(GENERATE_PATH, init);
        expect(sent[0]?.init).toBe(init);
    });

    it('does not touch other URLs, other methods, non-string or non-JSON bodies', async () => {
        handle = installFetchHook(memoryLogger());
        const seen = vi.fn();
        handle.register(seen);
        await post({ a: 1 }, '/api/other');
        await fetch(GENERATE_PATH);
        await fetch(GENERATE_PATH, { method: 'POST', body: 'not json' });
        await fetch(GENERATE_PATH, { method: 'POST', body: '[1,2]' });
        await fetch(GENERATE_PATH, { method: 'POST', body: new Uint8Array([1]) });
        await fetch(GENERATE_PATH, { method: 'GET', body: undefined });
        expect(seen).not.toHaveBeenCalled();
        expect(sent).toHaveLength(6);
    });

    it('recognises the generate URL given as a URL object, an absolute URL or a Request', async () => {
        handle = installFetchHook(memoryLogger());
        const seen = vi.fn();
        handle.register(seen);
        await fetch(new URL(GENERATE_PATH, 'http://localhost:8000'), { method: 'POST', body: '{}' });
        await fetch(`http://localhost:8000${GENERATE_PATH}`, { method: 'POST', body: '{}' });
        const request = new Request(`http://localhost:8000${GENERATE_PATH}`, { method: 'POST', body: '{}' });
        await fetch(request, { body: '{}' });
        expect(seen).toHaveBeenCalledTimes(3);
    });

    it('survives a failing hook and still sends the request', async () => {
        const log = memoryLogger();
        handle = installFetchHook(log);
        const after = vi.fn();
        handle.register(() => {
            throw new Error('boom');
        });
        handle.register((request) => {
            after();
            request.body['ok'] = 1;
        });
        const response = await post({});
        expect(response.status).toBe(200);
        expect(after).toHaveBeenCalledOnce();
        expect(sentBody()).toEqual({ ok: 1 });
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
    });

    it('stops calling a hook that was unregistered, even in the middle of a request', async () => {
        handle = installFetchHook(memoryLogger());
        const second = vi.fn();
        let off: () => void = () => {};
        handle.register(() => off());
        off = handle.register(second);
        await post({});
        expect(second).not.toHaveBeenCalled();
        expect(handle.hookCount()).toBe(1);
    });

    it('uninstall restores fetch and forgets the hooks', async () => {
        const original = globalThis.fetch;
        handle = installFetchHook(memoryLogger());
        expect(globalThis.fetch).not.toBe(original);
        const seen = vi.fn();
        handle.register(seen);
        handle.uninstall();
        expect(globalThis.fetch).toBe(original);
        expect(handle.hookCount()).toBe(0);
        await post({});
        expect(seen).not.toHaveBeenCalled();
    });

    it('a wrapper that cannot be removed (something wraps it) turns into a pass-through', async () => {
        handle = installFetchHook(memoryLogger());
        const mine = globalThis.fetch;
        const outer = (async (input: RequestInfo | URL, init?: RequestInit) => mine(input, init)) as typeof fetch;
        globalThis.fetch = outer;
        const seen = vi.fn();
        handle.register(seen);
        handle.uninstall();
        expect(globalThis.fetch).toBe(outer);
        await post({});
        expect(seen).not.toHaveBeenCalled();
        expect(sent).toHaveLength(1);
    });
});

describe('response observers', () => {
    it('are told about the response of a hooked generate request, in order, with the request the hooks left', async () => {
        handle = installFetchHook(memoryLogger());
        handle.register((request) => void (request.body['hooked'] = true));
        const order: string[] = [];
        let seen: ResponseInfo | null = null;
        handle.observe((info) => {
            order.push('a');
            seen = info;
        });
        handle.observe(async () => void order.push('b'));
        const response = await post({ chat_completion_source: 'custom' });
        expect(order).toEqual(['a', 'b']);
        const info = seen as unknown as ResponseInfo;
        expect(info.response).toBe(response);
        expect(info.request.body['hooked']).toBe(true);
        expect(info.startedAt).toBeLessThanOrEqual(Date.now());
    });

    it('are not called for other requests or when no hook is registered', async () => {
        handle = installFetchHook(memoryLogger());
        const seen = vi.fn();
        handle.observe(seen);
        await post({ a: 1 });
        expect(seen).not.toHaveBeenCalled();
        handle.register(() => {});
        await post({ a: 1 }, '/api/other');
        await fetch(GENERATE_PATH);
        expect(seen).not.toHaveBeenCalled();
    });

    it('never break a request: a throwing or rejecting observer is only logged at debug level', async () => {
        const log = memoryLogger();
        handle = installFetchHook(log);
        handle.register(() => {});
        handle.observe(() => {
            throw new Error('sync bug');
        });
        handle.observe(async () => {
            throw new Error('async bug');
        });
        const response = await post({});
        expect(response.status).toBe(200);
        await Promise.resolve();
        await Promise.resolve();
        expect(log.lines.filter((line) => line.level === 'debug')).toHaveLength(2);
        expect(log.lines.some((line) => line.level === 'warn' || line.level === 'error')).toBe(false);
    });

    it('can be removed, and uninstall forgets them', async () => {
        handle = installFetchHook(memoryLogger());
        handle.register(() => {});
        const removed = vi.fn();
        const kept = vi.fn();
        handle.observe(removed)();
        handle.observe(kept);
        await post({});
        expect(removed).not.toHaveBeenCalled();
        expect(kept).toHaveBeenCalledOnce();
        handle.uninstall();
        await post({});
        expect(kept).toHaveBeenCalledOnce();
    });
});

describe('the built-in proxy hook', () => {
    async function through(body: Record<string, unknown>) {
        handle = installFetchHook(memoryLogger());
        handle.register(proxyHintsHook);
        await post(body);
        return sentBody();
    }

    it('adds the hint headers through custom_include_headers for a proxy request', async () => {
        const body = await through({
            chat_completion_source: 'custom',
            custom_url: PROXY,
            type: 'normal',
            reasoning_effort: 'high',
            include_reasoning: true,
            custom_include_headers: '',
        });
        expect(body['custom_include_headers']).toBe(
            'x-nanovia-consumer: "main"\nx-nanovia-effort: "high"\nx-nanovia-thoughts: "1"\n',
        );
    });

    it('works when the field is missing, and for a background request without effort', async () => {
        const body = await through({ chat_completion_source: 'custom', custom_url: PROXY });
        expect(body['custom_include_headers']).toBe('x-nanovia-consumer: "background"\n');
    });

    it("merges with the user's own headers and keeps theirs", async () => {
        const body = await through({
            chat_completion_source: 'custom',
            custom_url: PROXY,
            type: 'normal',
            reasoning_effort: 'low',
            custom_include_headers: 'X-Title: My ST\nX-Nanovia-Effort: max\n',
        });
        expect(body['custom_include_headers']).toBe(
            'X-Title: My ST\nX-Nanovia-Effort: max\nx-nanovia-consumer: "main"\n',
        );
    });

    it('merges into a JSON-like field', async () => {
        const body = await through({
            chat_completion_source: 'custom',
            custom_url: PROXY,
            custom_include_headers: '{"X-Title": "My ST"}',
        });
        expect(JSON.parse(String(body['custom_include_headers']))).toEqual({
            'X-Title': 'My ST',
            'x-nanovia-consumer': 'background',
        });
    });

    it('skips an unparsable field and sends the request unchanged, logging why', async () => {
        const log = memoryLogger();
        handle = installFetchHook(log);
        handle.register(proxyHintsHook);
        const field = '{X-Title: ST}';
        await post({ chat_completion_source: 'custom', custom_url: PROXY, custom_include_headers: field });
        expect(sentBody()['custom_include_headers']).toBe(field);
        expect(log.lines.some((line) => line.level === 'debug' && String(line.args[0]).includes('left alone'))).toBe(
            true,
        );
    });

    it('does nothing for requests that do not go to a Nanovia proxy', async () => {
        const body = await through({ chat_completion_source: 'custom', custom_url: 'https://example.com/v1' });
        expect(body['custom_include_headers']).toBeUndefined();
        const direct = await through({
            chat_completion_source: 'custom',
            custom_url: 'https://api.nano-gpt.com/api/v1',
        });
        expect(direct['custom_include_headers']).toBeUndefined();
    });
});

describe('helpers for hooks', () => {
    function request(body: Record<string, unknown>): GenerateRequest {
        return { body, target: { kind: 'direct' }, secretId: null, consumer: 'main', log: memoryLogger() };
    }

    it("addIncludeBody adds JSON fields, keeps the user's, and skips what it cannot merge", () => {
        const r = request({ custom_include_body: 'temperature: 0.7\n' });
        addIncludeBody(r, { provider: { order: ['a'] }, temperature: 1 });
        expect(r.body['custom_include_body']).toBe('temperature: 0.7\nprovider: {"order":["a"]}\n');
        const bad = request({ custom_include_body: '- a: 1' });
        addIncludeBody(bad, { provider: 1 });
        expect(bad.body['custom_include_body']).toBe('- a: 1');
    });

    it('addIncludeHeaders compares header names without case', () => {
        const r = request({ custom_include_headers: 'X-Billing-Mode: paygo\n' });
        addIncludeHeaders(r, { 'x-billing-mode': 'subscription', 'x-provider': 'deepinfra' });
        expect(r.body['custom_include_headers']).toBe('X-Billing-Mode: paygo\nx-provider: "deepinfra"\n');
    });
});
