import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../src/shared/contracts';
import {
    buildUsageRecord,
    classifyBilling,
    equivalentCostUsd,
    resolveCost,
    type BuildUsageRecordArgs,
    type ClassifyBillingArgs,
} from '../../src/domain/cost';
import { emptyUsage, normalizeUsage, type NormalizedUsage } from '../../src/domain/usage';

function model(over: Partial<CatalogModel> = {}): CatalogModel {
    return {
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        description: '',
        contextLength: 128_000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: [],
        openWeights: true,
        pricing: { prompt: 0.4, completion: 2, cacheRead: 0.04 },
        category: null,
        subscription: { included: true, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
        ...over,
    };
}

function usage(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
    return { ...emptyUsage(), present: true, ...over };
}

describe('equivalentCostUsd', () => {
    it.each([
        // [name, usage, pricing override, expected]
        ['no cache', { promptTokens: 1_000_000, completionTokens: 500_000 }, undefined, 0.4 + 1],
        [
            'cached tokens at the cache price',
            { promptTokens: 1_000_000, cachedTokens: 600_000, completionTokens: 0 },
            undefined,
            0.4 * 0.4 + 0.6 * 0.04,
        ],
        [
            'no cache price: cached tokens cost the prompt price',
            { promptTokens: 1_000_000, cachedTokens: 600_000, completionTokens: 0 },
            { prompt: 0.4, completion: 2, cacheRead: null },
            0.4,
        ],
        [
            'cached above prompt is capped',
            { promptTokens: 100, cachedTokens: 5000, completionTokens: 0 },
            undefined,
            100 * 0.04e-6,
        ],
        ['completion only', { promptTokens: null, completionTokens: 1_000_000 }, undefined, 2],
        ['prompt only', { promptTokens: 1_000_000, completionTokens: null }, undefined, 0.4],
        [
            'a free model',
            { promptTokens: 5000, completionTokens: 5000 },
            { prompt: 0, completion: 0, cacheRead: null },
            0,
        ],
    ])('prices %s', (_name, u, pricing, expected) => {
        const m = model(pricing ? { pricing } : {});
        expect(equivalentCostUsd(m, usage(u))).toBeCloseTo(expected, 9);
    });

    it('is null for an unknown model without an estimate', () => {
        expect(equivalentCostUsd(null, usage({ promptTokens: 1000, completionTokens: 10 }))).toBeNull();
    });

    it('falls back to the NanoGPT estimate when the model is unknown or the tokens are', () => {
        expect(equivalentCostUsd(null, usage({ promptTokens: 1000, estimateUsd: 0.07 }))).toBe(0.07);
        expect(equivalentCostUsd(model(), usage({ estimateUsd: 0.07 }))).toBe(0.07);
    });

    it('prefers the catalog price over the estimate when it can compute one', () => {
        expect(
            equivalentCostUsd(model(), usage({ promptTokens: 1_000_000, completionTokens: 0, estimateUsd: 9 })),
        ).toBeCloseTo(0.4, 9);
    });

    it('does not trust a broken catalog price', () => {
        const bad = model({ pricing: { prompt: Number.NaN, completion: 2, cacheRead: null } });
        expect(equivalentCostUsd(bad, usage({ promptTokens: 1000, completionTokens: 1 }))).toBeNull();
        const negative = model({ pricing: { prompt: 1, completion: -2, cacheRead: null } });
        expect(equivalentCostUsd(negative, usage({ promptTokens: 1000, completionTokens: 1 }))).toBeNull();
        const badCache = model({ pricing: { prompt: 1, completion: 1, cacheRead: Number.NaN } });
        expect(
            equivalentCostUsd(
                badCache,
                usage({ promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 }),
            ),
        ).toBeCloseTo(1, 9);
    });

    it('rounds to nanodollars', () => {
        const odd = model({ pricing: { prompt: 0.123456789, completion: 0, cacheRead: null } });
        expect(equivalentCostUsd(odd, usage({ promptTokens: 1, completionTokens: 0 }))).toBe(0.000000123);
    });
});

describe('classifyBilling', () => {
    const base: ClassifyBillingArgs = {
        model: model(),
        costUsd: null,
        billingModeForced: false,
        explicitRouting: false,
        estimated: false,
    };
    it.each<[string, Partial<ClassifyBillingArgs>, string]>([
        ['cost exactly 0 on a subscription model', { costUsd: 0 }, 'subscription'],
        ['cost above zero', { costUsd: 0.0001 }, 'paygo'],
        [
            'cost above zero on a model outside the subscription',
            { costUsd: 0.5, model: model({ subscription: { included: false, inputTokenMultiplier: 1 } }) },
            'paygo',
        ],
        ['cost above zero with an unknown model', { costUsd: 0.5, model: null }, 'paygo'],
        ['cost 0 but pay-as-you-go forced', { costUsd: 0, billingModeForced: true }, 'paygo'],
        ['cost 0 with explicit routing', { costUsd: 0, explicitRouting: true }, 'paygo'],
        ['no cost, forced', { billingModeForced: true }, 'paygo'],
        ['no cost, explicit routing', { explicitRouting: true }, 'paygo'],
        ['no cost at all', {}, 'unknown'],
        [
            'cost 0 on a model that is not in the subscription',
            { costUsd: 0, model: model({ subscription: { included: false, inputTokenMultiplier: 1 } }) },
            'unknown',
        ],
        ['cost 0 with an unknown model', { costUsd: 0, model: null }, 'unknown'],
        ['a zero from an estimate proves nothing', { costUsd: 0, estimated: true }, 'unknown'],
        ['a positive estimate proves nothing either', { costUsd: 3, estimated: true }, 'unknown'],
        [
            'an estimate does not hide an explicit routing',
            { costUsd: 3, estimated: true, explicitRouting: true },
            'paygo',
        ],
        ['paid in XNO', { paidOtherCurrency: true }, 'paygo'],
        ['paid in XNO, estimate only', { paidOtherCurrency: true, estimated: true }, 'unknown'],
    ])('%s', (_name, patch, expected) => {
        expect(classifyBilling({ ...base, ...patch })).toBe(expected);
    });
});

describe('resolveCost', () => {
    const ctx = { model: model(), billingModeForced: false, explicitRouting: false };

    it('treats a missing usage as unknown, or as paygo when forced', () => {
        expect(resolveCost(null, ctx)).toEqual({ billing: 'unknown', costUsd: null, equivalentUsd: null });
        expect(resolveCost(emptyUsage(), { ...ctx, billingModeForced: true })).toEqual({
            billing: 'paygo',
            costUsd: null,
            equivalentUsd: null,
        });
    });

    it('resolves a subscription request: real cost 0, equivalent from the catalog', () => {
        const u = normalizeUsage({ prompt_tokens: 1_000_000, completion_tokens: 0, cost: '0' });
        const r = resolveCost(u, ctx);
        expect(r.billing).toBe('subscription');
        expect(r.costUsd).toBe(0);
        expect(r.equivalentUsd).toBeCloseTo(0.4, 9);
    });

    it('resolves a paygo request and keeps real and equivalent apart', () => {
        const u = normalizeUsage({ prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0.42 });
        const r = resolveCost(u, ctx);
        expect(r).toMatchObject({ billing: 'paygo', costUsd: 0.42 });
        expect(r.equivalentUsd).toBeCloseTo(0.4, 9);
    });

    it('uses the real cost as the equivalent of a paygo request on an unknown model', () => {
        const u = normalizeUsage({ prompt_tokens: 10, cost: 0.2 });
        expect(resolveCost(u, { ...ctx, model: null })).toEqual({ billing: 'paygo', costUsd: 0.2, equivalentUsd: 0.2 });
    });

    it('keeps a NanoGPT estimate as the equivalent and the real cost unknown', () => {
        const u = normalizeUsage({
            usage: { prompt_tokens: 10 },
            x_nanogpt_pricing: { cost: 0.9, isEstimate: true },
        });
        expect(resolveCost(u, { ...ctx, model: null })).toEqual({
            billing: 'unknown',
            costUsd: null,
            equivalentUsd: 0.9,
        });
    });

    it('marks an XNO payment as paygo without a USD cost', () => {
        const u = normalizeUsage({ prompt_tokens: 1_000_000, completion_tokens: 0, cost: '0.001', currency: 'XNO' });
        const r = resolveCost(u, ctx);
        expect(r).toMatchObject({ billing: 'paygo', costUsd: null });
        expect(r.equivalentUsd).toBeCloseTo(0.4, 9);
    });
});

describe('buildUsageRecord', () => {
    const args = (over: Partial<BuildUsageRecordArgs> = {}): BuildUsageRecordArgs => ({
        at: 1_700_000_000_000,
        connectionId: 'abc123',
        modelId: 'deepseek/deepseek-v4.1-flash',
        model: model(),
        billingModeForced: false,
        explicitRouting: false,
        usage: normalizeUsage({
            usage: {
                prompt_tokens: 2000,
                completion_tokens: 100,
                prompt_tokens_details: { cached_tokens: 1500 },
                completion_tokens_details: { reasoning_tokens: 40 },
                cost: 0,
            },
            x_nanogpt_pricing: { requestId: 'body-id' },
        }),
        requestId: 'header-id',
        latencyMs: 812,
        status: 200,
        stream: true,
        consumer: 'main',
        error: null,
        ...over,
    });

    it('fills a subscription record', () => {
        const r = buildUsageRecord(args());
        expect(r).toMatchObject({
            at: 1_700_000_000_000,
            connectionId: 'abc123',
            requestId: 'header-id',
            model: 'deepseek/deepseek-v4.1-flash',
            billing: 'subscription',
            costUsd: 0,
            promptTokens: 2000,
            completionTokens: 100,
            cachedTokens: 1500,
            reasoningTokens: 40,
            latencyMs: 812,
            status: 200,
            stream: true,
            consumer: 'main',
            error: null,
        });
        // 500 uncached at 0.4, 1500 cached at 0.04, 100 completion at 2 (per 1M).
        expect(r.equivalentUsd).toBeCloseTo((500 * 0.4 + 1500 * 0.04 + 100 * 2) / 1e6, 9);
    });

    it('takes the request id from the body when there is no header', () => {
        expect(buildUsageRecord(args({ requestId: null })).requestId).toBe('body-id');
        expect(buildUsageRecord(args({ requestId: null, usage: null })).requestId).toBeNull();
    });

    it('records a paygo request with its real cost', () => {
        const usageWithCost = normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, cost: '0.0031' });
        const r = buildUsageRecord(args({ usage: usageWithCost }));
        expect(r).toMatchObject({ billing: 'paygo', costUsd: 0.0031, cachedTokens: null, reasoningTokens: null });
    });

    it('records a successful response without usage as unknown with null counts', () => {
        const r = buildUsageRecord(args({ usage: null }));
        expect(r).toMatchObject({
            billing: 'unknown',
            costUsd: null,
            equivalentUsd: null,
            promptTokens: null,
            completionTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
        });
        expect(buildUsageRecord(args({ usage: null, billingModeForced: true })).billing).toBe('paygo');
    });

    it('records a failed request without usage as unknown even when pay-as-you-go was forced', () => {
        const r = buildUsageRecord(
            args({ usage: null, status: 502, error: 'upstream_unreachable', billingModeForced: true }),
        );
        expect(r).toMatchObject({ billing: 'unknown', costUsd: null, status: 502, error: 'upstream_unreachable' });
        const byStatus = buildUsageRecord(args({ usage: emptyUsage(), status: 429, billingModeForced: true }));
        expect(byStatus.billing).toBe('unknown');
    });

    it('keeps the billing of a stream that failed after it reported usage', () => {
        const r = buildUsageRecord(args({ error: 'aborted' }));
        expect(r.billing).toBe('subscription');
    });
});
