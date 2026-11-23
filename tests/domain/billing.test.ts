import { describe, expect, it } from 'vitest';
import { analyzeBilling, subscriptionSafeOverrides } from '../../src/domain/billing';
import { createConnection, defaultRouting } from '../../src/domain/connection';
import { PROVIDER_MARKUP_PERCENT } from '../../src/shared/constants';
import type { BillingMode, CatalogModel, ConnectionConfig, RoutingConfig } from '../../src/shared/contracts';

function makeModel(over: { id?: string; included?: boolean; multiplier?: number } = {}): CatalogModel {
    return {
        id: over.id ?? 'vendor/model',
        name: 'Model',
        description: '',
        contextLength: 128000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: ['low', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: over.included ?? true, inputTokenMultiplier: over.multiplier ?? 1 },
        providerIds: [],
        created: null,
    };
}

function makeConnection(
    billing: BillingMode,
    routing: Partial<RoutingConfig> = {},
    extra: Partial<ConnectionConfig> = {},
): ConnectionConfig {
    const base = createConnection({ name: 'Test', modelId: 'vendor/model' }, 'abc12345', 1);
    return {
        ...base,
        billing,
        routing: { ...defaultRouting(), enabled: true, ...routing },
        ...extra,
    };
}

const INCLUDED = makeModel();
const NOT_INCLUDED = makeModel({ id: 'vendor/premium', included: false });

describe('analyzeBilling: automatic mode', () => {
    it('stays in the subscription with default settings', () => {
        expect(analyzeBilling(makeConnection('auto'), INCLUDED, null)).toEqual({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            reasons: [],
            stripped: [],
        });
    });

    it('is paygo when the model is not in the subscription', () => {
        const impact = analyzeBilling(makeConnection('auto'), NOT_INCLUDED, null);
        expect(impact.outcome).toBe('paygo');
        expect(impact.markupPercent).toBe(0);
        expect(impact.subscriptionSafe).toBe(true);
        expect(impact.reasons).toEqual([{ code: 'model.notIncluded', params: { model: 'vendor/premium' } }]);
    });

    it('is unknown when the model is not in the catalog', () => {
        const impact = analyzeBilling(makeConnection('auto'), null, null);
        expect(impact).toMatchObject({ outcome: 'unknown', markupPercent: 0, subscriptionSafe: true, reasons: [] });
    });

    it.each<[string, Partial<RoutingConfig>, string]>([
        ['order', { order: ['deepinfra'] }, 'order'],
        ['sort', { sort: 'price' }, 'sort'],
        ['quantizations', { quantizations: ['fp8'] }, 'quantizations'],
        ['caching', { cachingRoute: true }, 'cachingRoute'],
        ['two fields', { only: ['a'], requireParameters: true }, 'only, requireParameters'],
    ])('explicit routing (%s) is paygo with markup', (_n, routing, fields) => {
        const impact = analyzeBilling(makeConnection('auto', routing), INCLUDED, null);
        expect(impact).toEqual({
            outcome: 'paygo',
            markupPercent: PROVIDER_MARKUP_PERCENT,
            subscriptionSafe: false,
            reasons: [{ code: 'routing.explicit', params: { fields } }],
            stripped: [],
        });
    });

    it('explicit routing is paygo even when the model is unknown', () => {
        const impact = analyzeBilling(makeConnection('auto', { order: ['a'] }), null, null);
        expect(impact.outcome).toBe('paygo');
        expect(impact.markupPercent).toBe(PROVIDER_MARKUP_PERCENT);
    });

    it('lists both reasons when the model is outside the subscription and routing is explicit', () => {
        const impact = analyzeBilling(makeConnection('auto', { order: ['a'] }), NOT_INCLUDED, true);
        expect(impact.outcome).toBe('paygo');
        expect(impact.reasons.map((r) => r.code)).toEqual(['model.notIncluded', 'routing.explicit']);
    });

    it('treats unknown provider selection (null) as supported', () => {
        expect(analyzeBilling(makeConnection('auto', { order: ['a'] }), INCLUDED, null).markupPercent).toBe(5);
        expect(analyzeBilling(makeConnection('auto', { order: ['a'] }), INCLUDED, true).markupPercent).toBe(5);
    });

    it('ignores routing for a model without provider selection: no markup, no bypass', () => {
        const impact = analyzeBilling(makeConnection('auto', { order: ['a'], sort: 'price' }), INCLUDED, false);
        expect(impact).toEqual({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            reasons: [{ code: 'routing.unsupportedByModel', params: { fields: 'order, sort' } }],
            stripped: [],
        });
        expect(analyzeBilling(makeConnection('auto', { order: ['a'] }), null, false).outcome).toBe('unknown');
        expect(analyzeBilling(makeConnection('auto', { order: ['a'] }), NOT_INCLUDED, false).outcome).toBe('paygo');
    });

    it('keeps the subscription with zdr alone', () => {
        const impact = analyzeBilling(makeConnection('auto', { zdr: true }), INCLUDED, null);
        expect(impact).toEqual({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            reasons: [{ code: 'routing.zdrOnly' }],
            stripped: [],
        });
    });

    it('has no zdr reason when the model has no provider selection', () => {
        expect(analyzeBilling(makeConnection('auto', { zdr: true }), INCLUDED, false).reasons).toEqual([]);
    });

    it('does not report zdr-only when other fields are set', () => {
        const impact = analyzeBilling(makeConnection('auto', { zdr: true, order: ['a'] }), INCLUDED, null);
        expect(impact.reasons).toEqual([{ code: 'routing.explicit', params: { fields: 'order' } }]);
    });

    it('ignores every routing field while routing is disabled', () => {
        const impact = analyzeBilling(
            makeConnection('auto', { enabled: false, order: ['a'], zdr: true, cachingRoute: true }),
            INCLUDED,
            null,
        );
        expect(impact).toMatchObject({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            reasons: [],
        });
    });
});

describe('analyzeBilling: forced pay-as-you-go', () => {
    it.each([
        ['included', INCLUDED, 'paygo'],
        ['not included', NOT_INCLUDED, 'paygo'],
        ['unknown', null, 'paygo'],
    ] as const)('is paygo for a model that is %s', (_n, model, outcome) => {
        const impact = analyzeBilling(makeConnection('paygo'), model, null);
        expect(impact).toEqual({
            outcome,
            markupPercent: 0,
            subscriptionSafe: false,
            reasons: [{ code: 'billing.forced' }],
            stripped: [],
        });
    });

    it('adds the markup for explicit routing', () => {
        const impact = analyzeBilling(makeConnection('paygo', { sort: 'speed' }), INCLUDED, null);
        expect(impact.markupPercent).toBe(5);
        expect(impact.reasons).toEqual([
            { code: 'billing.forced' },
            { code: 'routing.explicit', params: { fields: 'sort' } },
        ]);
    });

    it('does not report zdr-only or a multiplier', () => {
        const impact = analyzeBilling(makeConnection('paygo', { zdr: true }), makeModel({ multiplier: 3 }), null);
        expect(impact.reasons).toEqual([{ code: 'billing.forced' }]);
    });
});

describe('analyzeBilling: subscription mode (safe)', () => {
    it('strips bypassing fields and stays in the subscription', () => {
        const impact = analyzeBilling(
            makeConnection('subscription', { order: ['a'], sort: 'price', cachingRoute: true }),
            INCLUDED,
            null,
        );
        expect(impact).toEqual({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            reasons: [],
            stripped: ['order', 'sort', 'cachingRoute'],
        });
    });

    it('keeps zdr and says so', () => {
        const impact = analyzeBilling(makeConnection('subscription', { zdr: true, order: ['a'] }), INCLUDED, null);
        expect(impact.stripped).toEqual(['order']);
        expect(impact.reasons).toEqual([{ code: 'routing.zdrOnly' }]);
        expect(impact.outcome).toBe('subscription');
    });

    it('is paygo, with a warn-able reason, when the model cannot be covered', () => {
        const impact = analyzeBilling(makeConnection('subscription'), NOT_INCLUDED, null);
        expect(impact.outcome).toBe('paygo');
        expect(impact.subscriptionSafe).toBe(true);
        expect(impact.reasons).toEqual([
            { code: 'model.notIncluded', params: { model: 'vendor/premium' } },
            { code: 'billing.modelNotCoverable', params: { model: 'vendor/premium' } },
        ]);
    });

    it('is unknown when the model is not in the catalog', () => {
        const impact = analyzeBilling(makeConnection('subscription', { only: ['a'] }), null, null);
        expect(impact).toMatchObject({ outcome: 'unknown', markupPercent: 0, subscriptionSafe: true });
        expect(impact.stripped).toEqual(['only']);
    });

    it('still strips when the model has no provider selection and says nothing about it', () => {
        const impact = analyzeBilling(makeConnection('subscription', { order: ['a'] }), INCLUDED, false);
        expect(impact.stripped).toEqual(['order']);
        expect(impact.reasons).toEqual([]);
        expect(impact.outcome).toBe('subscription');
    });

    it('has nothing to strip while routing is disabled', () => {
        const impact = analyzeBilling(makeConnection('subscription', { enabled: false, order: ['a'] }), INCLUDED, null);
        expect(impact.stripped).toEqual([]);
    });
});

describe('analyzeBilling: extras', () => {
    it('reports web search and memory as billed separately', () => {
        const only = analyzeBilling(makeConnection('auto', {}, { webSearch: true }), INCLUDED, null);
        expect(only.reasons).toEqual([{ code: 'search.billedSeparately' }]);
        expect(only.outcome).toBe('subscription');
        const both = analyzeBilling(
            makeConnection('auto', {}, { webSearch: true, memory: { enabled: true, expirationDays: 7 } }),
            INCLUDED,
            null,
        );
        expect(both.reasons).toEqual([{ code: 'search.billedSeparately' }, { code: 'memory.billedSeparately' }]);
        const memory = analyzeBilling(
            makeConnection('subscription', {}, { memory: { enabled: true, expirationDays: null } }),
            INCLUDED,
            null,
        );
        expect(memory.reasons).toEqual([{ code: 'memory.billedSeparately' }]);
    });

    it('reports the input multiplier while the subscription applies', () => {
        const impact = analyzeBilling(makeConnection('auto'), makeModel({ multiplier: 3 }), null);
        expect(impact.reasons).toEqual([{ code: 'subscription.multiplier', params: { value: 3 } }]);
    });

    it('does not report a multiplier of 1, or one that does not apply', () => {
        expect(analyzeBilling(makeConnection('auto'), makeModel({ multiplier: 1 }), null).reasons).toEqual([]);
        const outside = makeModel({ included: false, multiplier: 3 });
        expect(analyzeBilling(makeConnection('auto'), outside, null).reasons.map((r) => r.code)).toEqual([
            'model.notIncluded',
        ]);
        const explicit = analyzeBilling(makeConnection('auto', { order: ['a'] }), makeModel({ multiplier: 3 }), null);
        expect(explicit.reasons.map((r) => r.code)).toEqual(['routing.explicit']);
    });

    it('orders reasons: billing, routing, search, memory, multiplier', () => {
        const impact = analyzeBilling(
            makeConnection('auto', { zdr: true }, { webSearch: true, memory: { enabled: true, expirationDays: 3 } }),
            makeModel({ multiplier: 2 }),
            null,
        );
        expect(impact.reasons.map((r) => r.code)).toEqual([
            'routing.zdrOnly',
            'search.billedSeparately',
            'memory.billedSeparately',
            'subscription.multiplier',
        ]);
    });
});

describe('subscriptionSafeOverrides', () => {
    const busy: Partial<RoutingConfig> = {
        order: ['a'],
        only: ['b'],
        ignore: ['c'],
        sort: 'throughput',
        quantizations: ['fp8'],
        minQuantization: 'int8',
        maxPrice: { prompt: 1, completion: 2 },
        allowFallbacks: false,
        requireParameters: true,
        zdr: true,
        preferredMaxLatency: 2,
        preferredMinThroughput: 30,
        cachingRoute: true,
    };

    it('removes every bypassing field and keeps zdr and enabled', () => {
        const connection = makeConnection('subscription', busy);
        const { routing, stripped } = subscriptionSafeOverrides(connection, INCLUDED);
        expect(stripped).toEqual([
            'order',
            'only',
            'ignore',
            'sort',
            'quantizations',
            'minQuantization',
            'maxPrice',
            'allowFallbacks',
            'requireParameters',
            'preferredMaxLatency',
            'preferredMinThroughput',
            'cachingRoute',
        ]);
        expect(routing).toEqual({ ...defaultRouting(), enabled: true, zdr: true });
    });

    it('does not touch the connection', () => {
        const connection = makeConnection('subscription', busy);
        const snapshot = JSON.parse(JSON.stringify(connection));
        const { routing } = subscriptionSafeOverrides(connection, null);
        routing.order.push('z');
        expect(connection).toEqual(snapshot);
    });

    it('returns a copy and no names when nothing bypasses', () => {
        const connection = makeConnection('subscription', { zdr: true });
        const { routing, stripped } = subscriptionSafeOverrides(connection, null);
        expect(stripped).toEqual([]);
        expect(routing).toEqual(connection.routing);
        expect(routing).not.toBe(connection.routing);
        expect(routing.maxPrice).not.toBe(connection.routing.maxPrice);
        expect(routing.order).not.toBe(connection.routing.order);
    });

    it('leaves a disabled routing alone', () => {
        const connection = makeConnection('subscription', { ...busy, enabled: false });
        const { routing, stripped } = subscriptionSafeOverrides(connection, null);
        expect(stripped).toEqual([]);
        expect(routing).toEqual(connection.routing);
    });

    it('does not depend on the billing mode', () => {
        const { stripped } = subscriptionSafeOverrides(makeConnection('auto', { order: ['a'] }), null);
        expect(stripped).toEqual(['order']);
    });
});
