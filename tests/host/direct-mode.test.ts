import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    applyPlan,
    createDirectMode,
    matchDirectConnection,
    planDifference,
    planDirectRequest,
} from '../../src/host/direct-mode';
import type { DirectConnectionRef, DirectModeDeps } from '../../src/host/direct-mode';
import { GENERATE_PATH, installFetchHook, proxyHintsHook } from '../../src/host/fetch-hook';
import type { FetchHookHandle, GenerateRequest } from '../../src/host/fetch-hook';
import { NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK } from '../../src/shared/constants';
import type { ConnectionConfig, UsageRecord } from '../../src/shared/contracts';
import { memoryLogger } from '../helpers/fakes';
import { catalogOf, makeConnection, makeModel, makeProviders } from '../helpers/plan-fixtures';

const SECRET = 'secret-direct-1';
const PROXY = 'http://127.0.0.1:8787/c/abc12345/v1';

let sent: { url: string; init?: RequestInit }[];
let realFetch: typeof fetch;
let handle: FetchHookHandle | undefined;
let records: UsageRecord[];

beforeEach(() => {
    sent = [];
    records = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init });
        return new Response('{}', { status: 200 });
    }) as typeof fetch;
});

afterEach(() => {
    handle?.uninstall();
    handle = undefined;
    globalThis.fetch = realFetch;
});

function deps(
    connection: ConnectionConfig,
    over: Partial<DirectModeDeps> & { effectiveMode?: 'plugin' | 'direct' } = {},
): DirectModeDeps {
    const { effectiveMode, ...rest } = over;
    const catalog = catalogOf([makeModel()], [makeProviders()]);
    return {
        connections: () => [{ config: connection, effectiveMode: effectiveMode ?? 'direct' }],
        directSecrets: () => ({ [connection.id]: SECRET }),
        model: (id) => catalog.model(id),
        providers: (id) => catalog.providers(id),
        emit: (record) => void records.push(record),
        log: memoryLogger(),
        ...rest,
    };
}

function install(d: DirectModeDeps, withProxyHook = true): void {
    const mode = createDirectMode(d);
    handle = installFetchHook(memoryLogger());
    if (withProxyHook) handle.register(proxyHintsHook);
    handle.register(mode.hook);
    handle.observe(mode.observer);
}

function post(body: Record<string, unknown>): Promise<Response> {
    return fetch(GENERATE_PATH, { method: 'POST', body: JSON.stringify(body), headers: {} });
}

function sentBody(): Record<string, unknown> {
    return JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>;
}

/** The entries our merge wrote into a YAML field (`key: <json>` lines). */
function entries(text: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const line of String(text ?? '').split('\n')) {
        const match = /^("[^"]*"|[\w.-]+): (.*)$/.exec(line);
        if (match) out[match[1]!.replace(/^"|"$/g, '')] = JSON.parse(match[2]!);
    }
    return out;
}

function direct(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        chat_completion_source: 'custom',
        custom_url: NANOGPT_API_BASE,
        secret_id: SECRET,
        model: 'vendor/model',
        type: 'normal',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
        ...over,
    };
}

describe('matchDirectConnection', () => {
    const connection = makeConnection({ id: 'abc12345', modelId: 'vendor/model' });
    const refs: DirectConnectionRef[] = [{ config: connection, effectiveMode: 'direct' }];

    it('finds the connection by the secret id of the request', () => {
        expect(matchDirectConnection({ body: {}, secretId: SECRET }, refs, { abc12345: SECRET })).toBe(connection);
    });

    it("treats a secret id that is not ours as somebody else's request, even when the model matches", () => {
        const body = { custom_url: NANOGPT_API_BASE, model: 'vendor/model' };
        expect(matchDirectConnection({ body, secretId: 'other' }, refs, { abc12345: SECRET })).toBeNull();
    });

    it('ignores a secret of a connection that is gone', () => {
        expect(matchDirectConnection({ body: {}, secretId: SECRET }, [], { abc12345: SECRET })).toBeNull();
    });

    it('falls back to the NanoGPT base plus a known model when exactly one connection runs direct', () => {
        const body = { custom_url: `${NANOGPT_API_BASE}/`, model: 'vendor/model' };
        expect(matchDirectConnection({ body, secretId: null }, refs, {})).toBe(connection);
        expect(
            matchDirectConnection(
                { body: { ...body, custom_url: NANOGPT_API_BASE_FALLBACK }, secretId: null },
                refs,
                {},
            ),
        ).toBe(connection);
    });

    it('does not fall back when the model differs, the URL is foreign, or two connections qualify', () => {
        const base = { custom_url: NANOGPT_API_BASE, model: 'vendor/model' };
        expect(matchDirectConnection({ body: { ...base, model: 'x/y' }, secretId: null }, refs, {})).toBeNull();
        expect(
            matchDirectConnection(
                { body: { ...base, custom_url: 'https://example.com/v1' }, secretId: null },
                refs,
                {},
            ),
        ).toBeNull();
        expect(matchDirectConnection({ body: { custom_url: NANOGPT_API_BASE }, secretId: null }, refs, {})).toBeNull();
        const twin = makeConnection({ id: 'twin1234', modelId: 'vendor/model' });
        const two: DirectConnectionRef[] = [...refs, { config: twin, effectiveMode: 'direct' }];
        expect(matchDirectConnection({ body: base, secretId: null }, two, {})).toBeNull();
    });

    it('does not count a connection that runs through the plugin', () => {
        const plugin: DirectConnectionRef[] = [{ config: connection, effectiveMode: 'plugin' }];
        expect(
            matchDirectConnection(
                { body: { custom_url: NANOGPT_API_BASE, model: 'vendor/model' }, secretId: null },
                plugin,
                {},
            ),
        ).toBeNull();
    });
});

describe('planDifference', () => {
    it('lists added and changed fields (deep compare, key order ignored) and the dropped ones', () => {
        const original = { model: 'a', top_k: 0, stream: true, provider: { b: 1, a: 2 }, messages: [{ role: 'user' }] };
        const planned = {
            model: 'a:online',
            stream: true,
            provider: { a: 2, b: 1 },
            messages: [{ role: 'user' }],
            usage: { include: true },
        };
        expect(planDifference(original, planned)).toEqual({
            set: { model: 'a:online', usage: { include: true } },
            remove: ['top_k'],
        });
    });

    it('is empty for equal bodies', () => {
        expect(planDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual({ set: {}, remove: [] });
    });
});

describe('planDirectRequest', () => {
    it('looks the model up by the id the planner sends (suffixes included) and passes the host selection flag', () => {
        const connection = makeConnection({ webSearch: true, routing: { enabled: true, order: ['alpha'] } });
        const seen: string[] = [];
        const catalog = catalogOf([makeModel()], [makeProviders({ supportsProviderSelection: false })]);
        const planned = planDirectRequest(
            {
                model: (id) => {
                    seen.push(id);
                    return catalog.model(id);
                },
                providers: (id) => catalog.providers(id),
            },
            connection,
            { body: { model: 'vendor/model', messages: [] }, consumer: 'main' },
        );
        expect(seen).toContain('vendor/model:online');
        expect(planned.model?.id).toBe('vendor/model');
        expect(planned.plan.model).toBe('vendor/model:online');
        // The model has a fixed route: the explicit routing is ignored and sends nothing.
        expect(planned.plan.body['provider']).toBeUndefined();
        expect(planned.plan.billing.reasons.map((reason) => reason.code)).toContain('routing.unsupportedByModel');
    });

    it('works with a catalog that knows nothing', () => {
        const planned = planDirectRequest(
            { model: () => null, providers: () => null },
            makeConnection({ reasoning: { policy: 'fixed', effort: 'high', hideThoughts: false } }),
            { body: { model: 'vendor/model' }, consumer: 'main' },
        );
        expect(planned.model).toBeNull();
        expect(planned.plan.body['reasoning']).toEqual({ effort: 'high' });
        expect(planned.plan.billing.outcome).toBe('unknown');
    });
});

describe('the direct-mode hook', () => {
    it('injects the difference through custom_include_body and leaves the rest of the body alone', async () => {
        const connection = makeConnection({
            routing: { enabled: true, order: ['Alpha'], sort: 'price', zdr: true },
            reasoning: { policy: 'fixed', effort: 'high', hideThoughts: true },
        });
        install(deps(connection));
        await post(direct({ reasoning_effort: 'low', include_reasoning: true }));
        const body = sentBody();
        expect(body['reasoning_effort']).toBeUndefined();
        expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
        expect(body['model']).toBe('vendor/model');
        expect(entries(body['custom_include_body'])).toEqual({
            usage: { include: true },
            stream_options: { include_usage: true },
            reasoning: { effort: 'high', exclude: true },
            provider: { order: ['alpha'], sort: 'price', zdr: true },
        });
        expect(body['custom_include_headers']).toBeUndefined();
    });

    it('sends the billing mode as a header and a field for a pay-as-you-go connection', async () => {
        install(deps(makeConnection({ billing: 'paygo' })));
        await post(direct({ stream: false }));
        const body = sentBody();
        expect(entries(body['custom_include_body'])).toEqual({ usage: { include: true }, billing_mode: 'paygo' });
        expect(entries(body['custom_include_headers'])).toEqual({ 'X-Billing-Mode': 'paygo' });
    });

    it('sends a changed model (web search suffix) and the caching flag', async () => {
        install(deps(makeConnection({ webSearch: true, routing: { enabled: true, cachingRoute: true } })));
        await post(direct({ stream: false }));
        const sentFields = entries(sentBody()['custom_include_body']);
        expect(sentFields['model']).toBe('vendor/model:online');
        expect(sentFields['caching']).toBe(true);
    });

    it('drops neutral samplers from the browser body when the connection strips them', async () => {
        install(deps(makeConnection()));
        await post(direct({ top_k: 0, top_a: 0, min_p: 0, repetition_penalty: 1, logit_bias: {}, temperature: 0.7 }));
        const body = sentBody();
        for (const key of ['top_k', 'top_a', 'min_p', 'repetition_penalty', 'logit_bias']) {
            expect(body[key]).toBeUndefined();
        }
        expect(body['temperature']).toBe(0.7);
    });

    it('strips bypassing routing in subscription-safe mode but keeps zdr', async () => {
        const connection = makeConnection({
            billing: 'subscription',
            routing: { enabled: true, order: ['alpha'], zdr: true, cachingRoute: true },
        });
        install(deps(connection));
        await post(direct({ stream: false }));
        const fields = entries(sentBody()['custom_include_body']);
        expect(fields['provider']).toEqual({ zdr: true });
        expect(fields['caching']).toBeUndefined();
    });

    it("merges with the user's own YAML and never overwrites it", async () => {
        const connection = makeConnection({ routing: { enabled: true, order: ['alpha'] } });
        install(deps(connection));
        await post(
            direct({
                stream: false,
                custom_include_body: 'temperature: 0.7\nprovider: {"order":["mine"]}\n',
                custom_include_headers: 'X-Title: My ST\n',
            }),
        );
        const text = String(sentBody()['custom_include_body']);
        expect(text.startsWith('temperature: 0.7\nprovider: {"order":["mine"]}\n')).toBe(true);
        expect(entries(text)['usage']).toEqual({ include: true });
        expect(text.match(/provider:/g)).toHaveLength(1);
        expect(sentBody()['custom_include_headers']).toBe('X-Title: My ST\n');
    });

    it('leaves an unmergeable YAML field alone', async () => {
        install(deps(makeConnection()));
        const field = '- a: 1';
        await post(direct({ custom_include_body: field }));
        expect(sentBody()['custom_include_body']).toBe(field);
    });

    it('matches by the secret first; the fallback finds the connection when no secret id comes along', async () => {
        const connection = makeConnection({ billing: 'paygo' });
        install(deps(connection, { directSecrets: () => ({}) }));
        const withoutSecret = direct({ stream: false });
        delete withoutSecret['secret_id'];
        await post(withoutSecret);
        expect(entries(sentBody()['custom_include_headers'])).toEqual({ 'X-Billing-Mode': 'paygo' });
    });

    it('does nothing for requests that are not Nanovia direct requests', async () => {
        install(deps(makeConnection({ billing: 'paygo' })));
        const cases = [
            direct({ custom_url: 'https://example.com/v1' }),
            direct({ secret_id: 'somebody-elses' }),
            direct({ chat_completion_source: 'openai' }),
            { ...direct(), custom_url: PROXY },
        ];
        for (const [index, body] of cases.entries()) {
            const before = JSON.stringify(body);
            await post(body);
            const after = JSON.parse(String(sent[index]?.init?.body)) as Record<string, unknown>;
            if (index < 3) expect(JSON.stringify(after)).toBe(before);
            else expect(Object.keys(entries(after['custom_include_body']))).toEqual([]);
        }
    });

    it('leaves proxy-mode behaviour as it was: hint headers only, no plan', async () => {
        install(deps(makeConnection({ billing: 'paygo', routing: { enabled: true, order: ['a'] } })));
        await post({ chat_completion_source: 'custom', custom_url: PROXY, type: 'normal', reasoning_effort: 'high' });
        const body = sentBody();
        expect(body['custom_include_body']).toBeUndefined();
        expect(entries(body['custom_include_headers'])).toEqual({
            'x-nanovia-consumer': 'main',
            'x-nanovia-effort': 'high',
        });
        expect(body['reasoning_effort']).toBe('high');
    });

    it('works with a connection whose model the catalog does not know', async () => {
        install(deps(makeConnection({ modelId: 'x/unknown' }), { model: () => null, providers: () => null }));
        await post(direct({ model: 'x/unknown', stream: false }));
        expect(entries(sentBody()['custom_include_body'])).toEqual({ usage: { include: true } });
    });

    it('marks the request for the usage tap', () => {
        const mode = createDirectMode(deps(makeConnection({ routing: { enabled: true, order: ['a'] } })));
        const request: GenerateRequest = {
            body: direct(),
            target: { kind: 'direct' },
            secretId: SECRET,
            consumer: 'main',
            log: memoryLogger(),
        };
        void mode.hook(request);
        expect(request.direct).toEqual({
            connectionId: 'abc12345',
            modelId: 'vendor/model',
            billingModeForced: false,
            explicitRouting: true,
        });
    });
});

describe('applyPlan', () => {
    it('does nothing when the plan equals the body', () => {
        const request: GenerateRequest = {
            body: { a: 1 },
            target: { kind: 'direct' },
            secretId: null,
            consumer: 'main',
            log: memoryLogger(),
        };
        applyPlan(request, { model: 'm', body: { a: 1 }, headers: {}, billing: {} as never, warnings: [] });
        expect(request.body).toEqual({ a: 1 });
    });
});
