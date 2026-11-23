import { describe, expect, it } from 'vitest';
import { analyzeBilling } from '../../src/domain/billing';
import { createConnection, defaultRouting } from '../../src/domain/connection';
import { planUpstream } from '../../src/domain/upstream';
import type {
    BillingMode,
    CatalogModel,
    ConnectionConfig,
    ReasoningConfig,
    RequestHints,
    RoutingConfig,
    UpstreamInput,
} from '../../src/shared/contracts';

function makeModel(over: { reasoning?: boolean; efforts?: string[]; included?: boolean } = {}): CatalogModel {
    return {
        id: 'vendor/model',
        name: 'Model',
        description: '',
        contextLength: 128000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: over.reasoning ?? true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: over.efforts ?? ['low', 'medium', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: over.included ?? true, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
    };
}

interface Setup {
    billing?: BillingMode;
    routing?: Partial<RoutingConfig>;
    reasoning?: Partial<ReasoningConfig>;
    connection?: Partial<ConnectionConfig>;
    model?: CatalogModel | null;
    body?: Record<string, unknown>;
    hints?: Partial<RequestHints>;
    providerSelection?: boolean | null;
}

function makeInput(s: Setup = {}): UpstreamInput {
    const base = createConnection({ name: 'Test', modelId: 'vendor/model' }, 'abc12345', 1);
    const connection: ConnectionConfig = {
        ...base,
        billing: s.billing ?? 'auto',
        // Routing is enabled in every test, with nothing set unless the test says so.
        routing: { ...defaultRouting(), enabled: true, ...s.routing },
        reasoning: { policy: 'default', effort: null, hideThoughts: false, ...s.reasoning },
        ...s.connection,
    };
    return {
        connection,
        model: s.model === undefined ? makeModel() : s.model,
        body: s.body ?? { model: 'vendor/model', messages: [{ role: 'user', content: 'hi' }] },
        hints: { effort: null, consumer: 'main', thoughts: false, ...s.hints },
        providerSelection: s.providerSelection ?? null,
    };
}

const plan = (s: Setup = {}) => planUpstream(makeInput(s));

describe('planUpstream: model and suffixes', () => {
    it('uses the body model when the connection is not locked', () => {
        const result = plan({ body: { model: 'other/model-x' }, connection: { modelLock: false } });
        expect(result.model).toBe('other/model-x');
        expect(result.body['model']).toBe('other/model-x');
    });

    it('uses the connection model when locked, whatever the body says', () => {
        const result = plan({ body: { model: 'other/model-x' }, connection: { modelLock: true } });
        expect(result.model).toBe('vendor/model');
        expect(result.body['model']).toBe('vendor/model');
    });

    it.each([undefined, null, '', '   ', 42, {}])('falls back to the connection model for body.model %j', (value) => {
        const body: Record<string, unknown> = { messages: [] };
        if (value !== undefined) body['model'] = value;
        expect(plan({ body }).model).toBe('vendor/model');
    });

    it('trims the body model', () => {
        expect(plan({ body: { model: '  a/b  ' } }).model).toBe('a/b');
    });

    it.each<[string, Partial<ConnectionConfig>, string, string]>([
        ['web search', { webSearch: true }, 'vendor/model', 'vendor/model:online'],
        ['memory', { memory: { enabled: true, expirationDays: null } }, 'vendor/model', 'vendor/model:memory'],
        ['memory 7 days', { memory: { enabled: true, expirationDays: 7 } }, 'vendor/model', 'vendor/model:memory-7'],
        ['memory 0 days', { memory: { enabled: true, expirationDays: 0 } }, 'vendor/model', 'vendor/model:memory'],
        [
            'memory 7.9 days',
            { memory: { enabled: true, expirationDays: 7.9 } },
            'vendor/model',
            'vendor/model:memory-7',
        ],
        [
            'both, online first',
            { webSearch: true, memory: { enabled: true, expirationDays: 30 } },
            'vendor/model',
            'vendor/model:online:memory-30',
        ],
        [
            'after :thinking',
            { webSearch: true, memory: { enabled: true, expirationDays: null } },
            'vendor/model:thinking',
            'vendor/model:thinking:online:memory',
        ],
        ['online already present', { webSearch: true }, 'vendor/model:online', 'vendor/model:online'],
        ['online with engine already present', { webSearch: true }, 'a/b:online/linkup-deep', 'a/b:online/linkup-deep'],
        ['memory already present', { memory: { enabled: true, expirationDays: 7 } }, 'a/b:memory-3', 'a/b:memory-3'],
        ['plain memory already present', { memory: { enabled: true, expirationDays: 7 } }, 'a/b:memory', 'a/b:memory'],
        [
            'online present, memory added',
            { webSearch: true, memory: { enabled: true, expirationDays: null } },
            'a/b:online',
            'a/b:online:memory',
        ],
        ['a name that only looks like online', { webSearch: true }, 'online/model', 'online/model:online'],
        ['a suffix that only looks like online', { webSearch: true }, 'a/b:onlinex', 'a/b:onlinex:online'],
        ['no suffixes without the settings', {}, 'a/b:thinking', 'a/b:thinking'],
    ])('%s', (_name, connection, bodyModel, expected) => {
        const result = plan({ connection, body: { model: bodyModel } });
        expect(result.model).toBe(expected);
        expect(result.body['model']).toBe(expected);
    });

    it('adds suffixes to the locked connection model', () => {
        const result = plan({
            connection: { modelLock: true, modelId: 'a/b:thinking', webSearch: true },
            body: { model: 'ignored' },
        });
        expect(result.model).toBe('a/b:thinking:online');
    });
});

describe('planUpstream: body handling', () => {
    it('never mutates its input', () => {
        const input = makeInput({
            billing: 'paygo',
            routing: { order: ['a'], cachingRoute: true, zdr: true },
            reasoning: { policy: 'fixed', effort: 'high' },
            connection: { webSearch: true },
            body: {
                model: 'vendor/model',
                stream: true,
                top_k: 0,
                logit_bias: {},
                reasoning_effort: 'low',
                reasoning: { max_tokens: 10 },
                usage: { x: 1 },
                stream_options: { a: 1 },
                messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            },
        });
        const snapshot = JSON.stringify(input);
        const frozen = deepFreeze(structuredClone(input));
        expect(() => planUpstream(frozen)).not.toThrow();
        planUpstream(input);
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('returns a deep copy: changing the plan body does not change the input', () => {
        const input = makeInput({ body: { messages: [{ role: 'user', content: 'hi' }], tools: [{ a: { b: 1 } }] } });
        const result = planUpstream(input);
        expect(result.body['messages']).toEqual(input.body['messages']);
        expect(result.body['messages']).not.toBe(input.body['messages']);
        (result.body['messages'] as Array<{ content: string }>)[0]!.content = 'changed';
        (result.body['tools'] as Array<{ a: { b: number } }>)[0]!.a.b = 2;
        expect(input.body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
        expect(input.body['tools']).toEqual([{ a: { b: 1 } }]);
    });

    it('forwards every other field untouched', () => {
        const body = {
            model: 'vendor/model',
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 0.7,
            top_p: 0.9,
            max_tokens: 500,
            stop: ['x'],
            tools: [{ type: 'function' }],
            custom_thing: { a: [1, 2, 3] },
        };
        const result = plan({ body });
        expect(result.body).toMatchObject(body);
    });

    it('is deterministic', () => {
        const s: Setup = {
            billing: 'subscription',
            routing: { order: ['a'], zdr: true },
            reasoning: { policy: 'follow' },
            hints: { effort: 'max' },
            body: { stream: true, top_k: 0 },
        };
        expect(plan(s)).toEqual(plan(s));
    });
});

describe('planUpstream: neutral samplers', () => {
    it.each<[string, unknown]>([
        ['top_k', 0],
        ['top_a', 0],
        ['min_p', 0],
        ['repetition_penalty', 1],
        ['logit_bias', {}],
    ])('removes %s=%j', (key, value) => {
        const result = plan({ body: { model: 'm', [key]: value } });
        expect(result.body).not.toHaveProperty(key);
    });

    it.each<[string, unknown]>([
        ['top_k', 40],
        ['top_a', 0.2],
        ['min_p', 0.05],
        ['repetition_penalty', 1.1],
        ['repetition_penalty', 0],
        ['logit_bias', { '15': -100 }],
        ['logit_bias', null],
        ['top_k', null],
    ])('keeps %s=%j', (key, value) => {
        const result = plan({ body: { model: 'm', [key]: value } });
        expect(result.body[key]).toEqual(value);
    });

    it('keeps everything when stripNeutralSamplers is off', () => {
        const body = { model: 'm', top_k: 0, top_a: 0, min_p: 0, repetition_penalty: 1, logit_bias: {} };
        const result = plan({ body, connection: { stripNeutralSamplers: false } });
        expect(result.body).toMatchObject(body);
    });
});

describe('planUpstream: usage flags', () => {
    it('always asks for usage', () => {
        const result = plan({ body: { model: 'm' } });
        expect(result.body['usage']).toEqual({ include: true });
        expect(result.body).not.toHaveProperty('stream_options');
    });

    it('keeps what the request already put in usage', () => {
        expect(plan({ body: { usage: { include: false, other: 1 } } }).body['usage']).toEqual({
            include: true,
            other: 1,
        });
        expect(plan({ body: { usage: 'junk' } }).body['usage']).toEqual({ include: true });
    });

    it('adds include_usage to a streaming request and keeps its own stream_options', () => {
        expect(plan({ body: { stream: true } }).body['stream_options']).toEqual({ include_usage: true });
        expect(plan({ body: { stream: true, stream_options: { foo: 1, include_usage: false } } }).body).toMatchObject({
            stream_options: { foo: 1, include_usage: true },
        });
        expect(plan({ body: { stream: true, stream_options: 'junk' } }).body['stream_options']).toEqual({
            include_usage: true,
        });
    });

    it.each([false, undefined, 'true', 1, null])('adds no stream_options when stream is %j', (stream) => {
        const body: Record<string, unknown> = { model: 'm' };
        if (stream !== undefined) body['stream'] = stream;
        expect(plan({ body }).body).not.toHaveProperty('stream_options');
    });
});

describe('planUpstream: reasoning', () => {
    it('writes the planned reasoning and removes reasoning_effort', () => {
        const result = plan({
            reasoning: { policy: 'fixed', effort: 'high' },
            body: { model: 'm', reasoning_effort: 'low' },
        });
        expect(result.body['reasoning']).toEqual({ effort: 'high' });
        expect(result.body).not.toHaveProperty('reasoning_effort');
    });

    it('follows the hint of the request', () => {
        const result = plan({
            reasoning: { policy: 'follow' },
            hints: { effort: 'min' },
            model: makeModel({ efforts: ['none', 'low'] }),
        });
        expect(result.body['reasoning']).toEqual({ effort: 'none' });
    });

    it('merges into the reasoning object the request carried, the plan winning', () => {
        const result = plan({
            reasoning: { policy: 'fixed', effort: 'low', hideThoughts: true },
            body: { model: 'm', reasoning: { effort: 'high', max_tokens: 2000 } },
        });
        expect(result.body['reasoning']).toEqual({ effort: 'low', max_tokens: 2000, exclude: true });
    });

    it('replaces a reasoning value that is not an object', () => {
        const result = plan({ reasoning: { policy: 'fixed', effort: 'low' }, body: { model: 'm', reasoning: 'junk' } });
        expect(result.body['reasoning']).toEqual({ effort: 'low' });
    });

    it('turns reasoning off with exclude for a model that always reasons', () => {
        const result = plan({
            reasoning: { policy: 'off' },
            model: makeModel({ efforts: ['low', 'high', 'max'] }),
            body: { model: 'm', reasoning_effort: 'high' },
        });
        expect(result.body['reasoning']).toEqual({ effort: 'low', exclude: true });
        expect(result.body).not.toHaveProperty('reasoning_effort');
        expect(result.warnings).toEqual([
            { code: 'reasoning.cannotDisable', params: { model: 'vendor/model', efforts: 'low, high, max' } },
        ]);
    });

    it.each<[string, Setup]>([
        ['the default policy', { reasoning: { policy: 'default' } }],
        [
            'a model that does not reason',
            { reasoning: { policy: 'fixed', effort: 'high' }, model: makeModel({ reasoning: false }) },
        ],
        ['follow without a hint', { reasoning: { policy: 'follow' } }],
        ['fixed without an effort', { reasoning: { policy: 'fixed', effort: null } }],
    ])('leaves the request’s own reasoning fields alone for %s', (_name, setup) => {
        const body = { model: 'm', reasoning: { max_tokens: 100 }, reasoning_effort: 'medium' };
        const result = plan({ ...setup, body });
        expect(result.body['reasoning']).toEqual({ max_tokens: 100 });
        expect(result.body['reasoning_effort']).toBe('medium');
        expect(result.warnings).toEqual([]);
    });

    it('does not invent a reasoning field', () => {
        expect(plan({ reasoning: { policy: 'default' } }).body).not.toHaveProperty('reasoning');
    });

    it('sends the effort of an unknown model and warns', () => {
        const result = plan({ reasoning: { policy: 'fixed', effort: 'high' }, model: null });
        expect(result.body['reasoning']).toEqual({ effort: 'high' });
        expect(result.warnings).toEqual([{ code: 'reasoning.modelUnknown' }]);
    });
});

describe('planUpstream: provider object', () => {
    it('sends the provider object and sets nothing else for plain routing fields', () => {
        const result = plan({ routing: { order: ['DeepInfra'], sort: 'price', quantizations: ['fp8'] } });
        expect(result.body['provider']).toEqual({ order: ['deepinfra'], sort: 'price', quantizations: ['fp8'] });
        expect(result.body).not.toHaveProperty('caching');
    });

    it('sends nothing for default routing', () => {
        expect(plan().body).not.toHaveProperty('provider');
    });

    it('sends nothing while routing is disabled, caching and zdr included', () => {
        const result = plan({ routing: { enabled: false, order: ['a'], zdr: true, cachingRoute: true } });
        expect(result.body).not.toHaveProperty('provider');
        expect(result.body).not.toHaveProperty('caching');
    });

    it('sends zdr alone', () => {
        expect(plan({ routing: { zdr: true } }).body['provider']).toEqual({ zdr: true });
    });

    it('sets top-level caching for the caching route', () => {
        const result = plan({ routing: { cachingRoute: true } });
        expect(result.body['caching']).toBe(true);
        expect(result.body).not.toHaveProperty('provider');
    });

    it('merges with a provider object of the request, the plan winning', () => {
        const result = plan({
            routing: { sort: 'latency' },
            body: { model: 'm', provider: { sort: 'price', data_collection: 'allow' } },
        });
        expect(result.body['provider']).toEqual({ sort: 'latency', data_collection: 'allow' });
    });

    it('leaves a provider object of the request alone when the plan has none', () => {
        const result = plan({ body: { model: 'm', provider: { order: ['x'] } } });
        expect(result.body['provider']).toEqual({ order: ['x'] });
    });

    it('still sends routing to a model without provider selection (NanoGPT ignores it)', () => {
        const result = plan({ routing: { order: ['a'] }, providerSelection: false });
        expect(result.body['provider']).toEqual({ order: ['a'] });
        expect(result.billing.markupPercent).toBe(0);
        expect(result.billing.reasons.map((r) => r.code)).toEqual(['routing.unsupportedByModel']);
    });
});

describe('planUpstream: subscription (safe) mode', () => {
    it('strips bypassing fields and the caching route', () => {
        const result = plan({
            billing: 'subscription',
            routing: { order: ['a'], sort: 'speed', cachingRoute: true, requireParameters: true },
        });
        expect(result.body).not.toHaveProperty('provider');
        expect(result.body).not.toHaveProperty('caching');
        expect(result.billing.stripped).toEqual(['order', 'sort', 'requireParameters', 'cachingRoute']);
        expect(result.billing.outcome).toBe('subscription');
        expect(result.billing.markupPercent).toBe(0);
    });

    it('keeps zdr', () => {
        const result = plan({ billing: 'subscription', routing: { order: ['a'], zdr: true, cachingRoute: true } });
        expect(result.body['provider']).toEqual({ zdr: true });
        expect(result.body).not.toHaveProperty('caching');
    });

    it('also strips what the request itself carried, except zdr', () => {
        const noZdr = plan({
            billing: 'subscription',
            body: { model: 'm', provider: { order: ['x'], sort: 'price' }, caching: true },
        });
        expect(noZdr.body).not.toHaveProperty('provider');
        expect(noZdr.body).not.toHaveProperty('caching');
        const withZdr = plan({
            billing: 'subscription',
            routing: { zdr: true },
            body: { model: 'm', provider: { order: ['x'], zdr: true } },
        });
        expect(withZdr.body['provider']).toEqual({ zdr: true });
        const onlyRequestZdr = plan({
            billing: 'subscription',
            body: { model: 'm', provider: { order: ['x'], zdr: false } },
        });
        expect(onlyRequestZdr.body['provider']).toEqual({ zdr: false });
    });

    it('does not warn about settings it removed', () => {
        const result = plan({
            billing: 'subscription',
            routing: { only: ['a'], order: ['b'], preferredMaxLatency: 2 },
        });
        expect(result.warnings).toEqual([]);
    });

    it('lets other billing modes keep the request’s own provider and caching', () => {
        const result = plan({ billing: 'auto', body: { model: 'm', provider: { order: ['x'] }, caching: true } });
        expect(result.body['provider']).toEqual({ order: ['x'] });
        expect(result.body['caching']).toBe(true);
    });
});

describe('planUpstream: pay-as-you-go header', () => {
    it('sets the header and the body field in paygo mode', () => {
        const result = plan({ billing: 'paygo' });
        expect(result.headers).toEqual({ 'X-Billing-Mode': 'paygo' });
        expect(result.body['billing_mode']).toBe('paygo');
    });

    it.each<BillingMode>(['auto', 'subscription'])('sends neither in %s mode', (billing) => {
        const result = plan({ billing, routing: { order: ['a'] } });
        expect(result.headers).toEqual({});
        expect(result.body).not.toHaveProperty('billing_mode');
    });

    it('sends neither when only the outcome is paygo', () => {
        const result = plan({ billing: 'auto', model: makeModel({ included: false }) });
        expect(result.billing.outcome).toBe('paygo');
        expect(result.headers).toEqual({});
        expect(result.body).not.toHaveProperty('billing_mode');
    });

    it('keeps explicit routing in paygo mode', () => {
        const result = plan({ billing: 'paygo', routing: { order: ['a'] } });
        expect(result.body['provider']).toEqual({ order: ['a'] });
        expect(result.billing.markupPercent).toBe(5);
    });
});

describe('planUpstream: billing and warnings', () => {
    it('reports the billing impact of the connection', () => {
        const s: Setup = { routing: { order: ['a'] }, model: makeModel(), providerSelection: true };
        const input = makeInput(s);
        expect(planUpstream(input).billing).toEqual(analyzeBilling(input.connection, input.model, true));
    });

    it('passes providerSelection and an unknown model to the analysis', () => {
        expect(plan({ model: null }).billing.outcome).toBe('unknown');
        expect(plan({ routing: { order: ['a'] }, providerSelection: false }).billing.outcome).toBe('subscription');
    });

    it('lists reasoning warnings before routing warnings', () => {
        const result = plan({
            reasoning: { policy: 'fixed', effort: 'max' },
            model: makeModel({ efforts: ['low', 'high'] }),
            routing: { only: ['a'], order: ['b'], preferredMinThroughput: 20 },
        });
        expect(result.warnings.map((w) => w.code)).toEqual([
            'reasoning.effortAdjusted',
            'routing.preferenceNeedsSort',
            'routing.onlyAndOrder',
        ]);
    });

    it('has no warnings for a clean connection', () => {
        expect(plan().warnings).toEqual([]);
    });
});

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) deepFreeze(item);
        Object.freeze(value);
    }
    return value;
}
