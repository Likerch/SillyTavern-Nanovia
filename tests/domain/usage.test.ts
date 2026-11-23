import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../src/shared/contracts';
import { emptyUsage, normalizeUsage, parseCost, parseCount, roundUsd, summarizeUsage } from '../../src/domain/usage';

describe('normalizeUsage: tokens', () => {
    it('reads an OpenAI-shaped usage object', () => {
        const u = normalizeUsage({
            prompt_tokens: 1000,
            completion_tokens: 200,
            total_tokens: 1200,
            prompt_tokens_details: { cached_tokens: 400 },
            completion_tokens_details: { reasoning_tokens: 50 },
            cost: 0.0123,
            currency: 'USD',
        });
        expect(u).toMatchObject({
            present: true,
            promptTokens: 1000,
            completionTokens: 200,
            totalTokens: 1200,
            cachedTokens: 400,
            reasoningTokens: 50,
            costUsd: 0.0123,
            currency: 'USD',
            paidOtherCurrency: false,
            estimated: false,
        });
    });

    it('reads a response body and ignores everything but usage and the pricing block', () => {
        const u = normalizeUsage({
            id: 'x',
            choices: [{ message: { content: 'hi' } }],
            usage: { prompt_tokens: 5, completion_tokens: 6 },
        });
        expect(u.promptTokens).toBe(5);
        expect(u.completionTokens).toBe(6);
    });

    it.each([
        ['cached_tokens', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 7 } }, 7],
        ['cache_read_input_tokens', { prompt_tokens: 10, cache_read_input_tokens: 8 }, 8],
        ['prompt_cache_hit_tokens', { prompt_tokens: 10, prompt_cache_hit_tokens: 9 }, 9],
        [
            'a positive source beats a zero one',
            { prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 5 },
            5,
        ],
        ['a real zero is kept', { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }, 0],
        ['nothing reported', { prompt_tokens: 10 }, null],
    ])('cached tokens: %s', (_name, usage, expected) => {
        expect(normalizeUsage(usage).cachedTokens).toBe(expected);
    });

    it.each([
        ['cache_creation_input_tokens', { prompt_tokens: 1, cache_creation_input_tokens: 30 }, 30],
        [
            'prompt_tokens_details.cache_write_tokens',
            { prompt_tokens: 1, prompt_tokens_details: { cache_write_tokens: 12 } },
            12,
        ],
        ['nothing reported', { prompt_tokens: 1 }, null],
    ])('cache write tokens: %s', (_name, usage, expected) => {
        expect(normalizeUsage(usage).cacheWriteTokens).toBe(expected);
    });

    it('reads reasoning tokens from either place', () => {
        expect(normalizeUsage({ completion_tokens_details: { reasoning_tokens: 9 } }).reasoningTokens).toBe(9);
        expect(normalizeUsage({ reasoning_tokens: 4 }).reasoningTokens).toBe(4);
        expect(normalizeUsage({ completion_tokens: 3 }).reasoningTokens).toBeNull();
    });

    it('falls back to Claude-style names and to the pricing block for token counts', () => {
        const claude = normalizeUsage({ input_tokens: 11, output_tokens: 22 });
        expect([claude.promptTokens, claude.completionTokens]).toEqual([11, 22]);
        const priced = normalizeUsage({
            usage: { cost: 0 },
            x_nanogpt_pricing: {
                inputTokens: 100,
                outputTokens: 20,
                cacheReadInputTokens: 60,
                cacheCreationInputTokens: 10,
            },
        });
        expect(priced).toMatchObject({
            promptTokens: 100,
            completionTokens: 20,
            cachedTokens: 60,
            cacheWriteTokens: 10,
        });
    });

    it('clamps negative, NaN and infinite numbers to null', () => {
        const u = normalizeUsage({
            prompt_tokens: -5,
            completion_tokens: Number.NaN,
            total_tokens: Number.POSITIVE_INFINITY,
            prompt_tokens_details: { cached_tokens: '12' },
            cost: -1,
        });
        expect(u.present).toBe(false);
        expect(u).toEqual(emptyUsage());
        // A single bad field leaves the good ones alone.
        const mixed = normalizeUsage({ prompt_tokens: -5, completion_tokens: 7 });
        expect(mixed.promptTokens).toBeNull();
        expect(mixed.completionTokens).toBe(7);
    });

    it('turns negative zero into zero', () => {
        expect(Object.is(normalizeUsage({ prompt_tokens: -0 }).promptTokens, 0)).toBe(true);
        expect(Object.is(parseCost(-0), 0)).toBe(true);
    });
});

describe('normalizeUsage: missing usage', () => {
    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'usage'],
        ['an array', [1, 2]],
        ['usage: null', { usage: null }],
        ['usage: a number', { usage: 3 }],
        ['usage: {}', { usage: {} }],
        ['a chunk without usage', { id: 'c', choices: [{ delta: { content: 'a' } }] }],
    ])('%s gives an empty result', (_name, raw) => {
        expect(normalizeUsage(raw)).toEqual(emptyUsage());
    });

    it('reports a pricing block alone as present', () => {
        const u = normalizeUsage({ usage: {}, x_nanogpt_pricing: { cost: 0.5 } });
        expect(u.present).toBe(true);
        expect(u.estimateUsd).toBe(0.5);
    });
});

describe('normalizeUsage: cost', () => {
    it.each([
        ['a number', 0.25, 0.25],
        ['a decimal string', '0.0042', 0.0042],
        ['a padded string', ' 1.5 ', 1.5],
        ['an exponent string', '1e-7', 1e-7],
        ['a leading-dot string', '.5', 0.5],
        ['zero', 0, 0],
        ['zero as a string', '0', 0],
        ['negative', -0.1, null],
        ['a negative string', '-2', null],
        ['NaN', Number.NaN, null],
        ['infinity', Number.POSITIVE_INFINITY, null],
        ['an empty string', '', null],
        ['words', 'free', null],
        ['a hex string', '0x10', null],
        ['null', null, null],
        ['an object', {}, null],
    ])('cost as %s', (_name, cost, expected) => {
        expect(normalizeUsage({ prompt_tokens: 1, cost }).costUsd).toBe(expected);
    });

    it('reads total_cost when cost is missing, cost first', () => {
        expect(normalizeUsage({ prompt_tokens: 1, total_cost: 0.3 }).costUsd).toBe(0.3);
        expect(normalizeUsage({ prompt_tokens: 1, cost: 0.1, total_cost: 0.3 }).costUsd).toBe(0.1);
        expect(normalizeUsage({ prompt_tokens: 1, cost: -1, total_cost: 0.3 }).costUsd).toBe(0.3);
    });

    it('treats a missing currency as USD and normalises the case', () => {
        expect(normalizeUsage({ cost: 0.2 })).toMatchObject({ costUsd: 0.2, currency: null });
        expect(normalizeUsage({ cost: 0.2, currency: ' usd ' })).toMatchObject({ costUsd: 0.2, currency: 'USD' });
    });

    it('never reads a foreign currency as dollars', () => {
        const paid = normalizeUsage({ prompt_tokens: 1, cost: '0.0003', currency: 'XNO' });
        expect(paid).toMatchObject({ costUsd: null, currency: 'XNO', paidOtherCurrency: true, estimated: false });
    });

    it('keeps an exact zero in any currency: nothing was charged', () => {
        const free = normalizeUsage({ prompt_tokens: 1, cost: 0, currency: 'XNO' });
        expect(free).toMatchObject({ costUsd: 0, paidOtherCurrency: false });
    });

    it('treats an empty currency string as absent', () => {
        expect(normalizeUsage({ cost: 1, currency: '  ' })).toMatchObject({ costUsd: 1, currency: null });
    });
});

describe('normalizeUsage: x_nanogpt_pricing', () => {
    const pricing = (extra: Record<string, unknown>) => ({
        cost: 0.05,
        inputTokens: 10,
        outputTokens: 5,
        paymentSource: 'balance',
        requestId: ' req_1 ',
        ...extra,
    });

    it('keeps an estimate apart from the real cost', () => {
        const u = normalizeUsage({
            usage: { prompt_tokens: 10, completion_tokens: 5 },
            x_nanogpt_pricing: pricing({ isEstimate: true }),
        });
        expect(u).toMatchObject({ costUsd: null, estimated: true, estimateUsd: 0.05, requestId: 'req_1' });
    });

    it('does not trust a block that does not say isEstimate: false', () => {
        const u = normalizeUsage({ usage: { prompt_tokens: 10 }, x_nanogpt_pricing: pricing({}) });
        expect(u).toMatchObject({ costUsd: null, estimated: true, estimateUsd: 0.05 });
    });

    it('takes the pricing cost as real only when it is not an estimate', () => {
        const u = normalizeUsage({
            usage: { prompt_tokens: 10 },
            x_nanogpt_pricing: pricing({ isEstimate: false, cost: '0.07' }),
        });
        expect(u).toMatchObject({ costUsd: 0.07, estimated: false, estimateUsd: null });
    });

    it('lets usage.cost win and keeps the pricing figure as the estimate', () => {
        const u = normalizeUsage({
            usage: { prompt_tokens: 10, cost: 0 },
            x_nanogpt_pricing: pricing({ isEstimate: false, cost: 0.2 }),
        });
        expect(u).toMatchObject({ costUsd: 0, estimated: false, estimateUsd: 0.2 });
    });

    it('does not read the pricing cost as dollars next to a foreign currency', () => {
        const u = normalizeUsage({
            usage: { prompt_tokens: 10, currency: 'XNO' },
            x_nanogpt_pricing: pricing({ isEstimate: false }),
        });
        expect(u).toMatchObject({ costUsd: null, estimated: true, estimateUsd: 0.05 });
    });

    it('finds the block inside usage as well, and ignores junk', () => {
        const inner = normalizeUsage({ usage: { prompt_tokens: 1, x_nanogpt_pricing: pricing({ isEstimate: true }) } });
        expect(inner.estimateUsd).toBe(0.05);
        const junk = normalizeUsage({ usage: { prompt_tokens: 1 }, x_nanogpt_pricing: 'free' });
        expect(junk).toMatchObject({ estimateUsd: null, requestId: null });
        const emptyId = normalizeUsage({
            usage: { prompt_tokens: 1 },
            x_nanogpt_pricing: { requestId: ' ', cost: 'x' },
        });
        expect(emptyId.requestId).toBeNull();
    });
});

describe('parse helpers', () => {
    it('parseCount accepts only finite non-negative numbers', () => {
        expect(parseCount(3)).toBe(3);
        expect(parseCount('3')).toBeNull();
        expect(parseCount(-1)).toBeNull();
        expect(parseCount(Number.NaN)).toBeNull();
    });

    it('roundUsd removes float noise', () => {
        expect(roundUsd(0.1 + 0.2)).toBe(0.3);
        expect(roundUsd(1.23456789012)).toBe(1.23456789);
    });
});

function rec(over: Partial<UsageRecord> = {}): UsageRecord {
    return {
        at: 1000,
        connectionId: 'c1',
        requestId: null,
        model: 'm1',
        billing: 'paygo',
        costUsd: 0.1,
        equivalentUsd: 0.1,
        promptTokens: 100,
        completionTokens: 10,
        cachedTokens: 20,
        reasoningTokens: null,
        latencyMs: 5,
        status: 200,
        stream: false,
        consumer: 'main',
        error: null,
        ...over,
    };
}

const dayOf = (at: number) => (at < 5000 ? '2026-11-01' : '2026-11-02');

describe('summarizeUsage', () => {
    it('summarises an empty list as zeros', () => {
        const s = summarizeUsage([], { from: 0, to: 10 }, dayOf);
        expect(s).toEqual({
            from: 0,
            to: 10,
            total: { requests: 0, costUsd: 0, equivalentUsd: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
            byDay: [],
            byConnection: [],
            byModel: [],
        });
    });

    it('sums totals, days, connections and models; real cost and equivalent stay separate', () => {
        const records = [
            rec({ at: 1000, costUsd: 0.1, equivalentUsd: 0.1 }),
            rec({ at: 2000, costUsd: 0, equivalentUsd: 0.4, billing: 'subscription', connectionId: 'c2', model: 'm2' }),
            rec({ at: 6000, costUsd: 0.2, equivalentUsd: 0.2, connectionId: 'c2', model: 'm1' }),
        ];
        const s = summarizeUsage(records, { from: 0, to: 10_000 }, dayOf);
        expect(s.total).toEqual({
            requests: 3,
            costUsd: 0.3,
            equivalentUsd: 0.7,
            promptTokens: 300,
            completionTokens: 30,
            cachedTokens: 60,
        });
        expect(s.byDay.map((d) => [d.day, d.requests, d.costUsd, d.equivalentUsd])).toEqual([
            ['2026-11-01', 2, 0.1, 0.5],
            ['2026-11-02', 1, 0.2, 0.2],
        ]);
        // c2 spent 0.2 (+0 subscription), c1 0.1.
        expect(s.byConnection.map((c) => [c.connectionId, c.requests, c.costUsd])).toEqual([
            ['c2', 2, 0.2],
            ['c1', 1, 0.1],
        ]);
        expect(s.byModel.map((m) => [m.model, m.requests, m.costUsd, m.equivalentUsd])).toEqual([
            ['m1', 2, 0.3, 0.3],
            ['m2', 1, 0, 0.4],
        ]);
    });

    it('counts a subscription request with cost 0 and treats unknown and bad numbers as 0', () => {
        const records = [
            rec({ billing: 'subscription', costUsd: 0, equivalentUsd: 0.5 }),
            rec({ costUsd: null, equivalentUsd: null, promptTokens: null, completionTokens: null, cachedTokens: null }),
            rec({ costUsd: Number.NaN, equivalentUsd: -3, promptTokens: -1 }),
        ];
        const s = summarizeUsage(records, { from: 0, to: 10_000 }, dayOf);
        expect(s.total.requests).toBe(3);
        expect(s.total.costUsd).toBe(0);
        expect(s.total.equivalentUsd).toBe(0.5);
        expect(s.total.promptTokens).toBe(100);
    });

    it('takes records from `from` inclusive to `to` exclusive and survives NaN bounds', () => {
        const records = [rec({ at: 10 }), rec({ at: 20 }), rec({ at: 30 })];
        expect(summarizeUsage(records, { from: 10, to: 30 }, dayOf).total.requests).toBe(2);
        expect(summarizeUsage(records, { from: Number.NaN, to: 30 }, dayOf).total.requests).toBe(0);
    });

    it('filters by connection, including the null connection', () => {
        const records = [rec({ connectionId: 'c1' }), rec({ connectionId: null }), rec({ connectionId: 'c2' })];
        const range = { from: 0, to: 10_000 };
        expect(summarizeUsage(records, range, dayOf, { connectionId: 'c1' }).total.requests).toBe(1);
        expect(summarizeUsage(records, range, dayOf, { connectionId: null }).byConnection).toEqual([
            expect.objectContaining({ connectionId: null, requests: 1 }),
        ]);
        expect(summarizeUsage(records, range, dayOf, {}).total.requests).toBe(3);
    });

    it('orders by cost, then equivalent, then requests, then name (the null connection sorts as an empty name)', () => {
        const records = [
            rec({ model: 'b', costUsd: 0, equivalentUsd: 1, connectionId: 'z' }),
            rec({ model: 'a', costUsd: 0, equivalentUsd: 1, connectionId: null }),
            rec({ model: 'c', costUsd: 0, equivalentUsd: 2, connectionId: 'y' }),
            rec({ model: 'd', costUsd: 0, equivalentUsd: 0.5, connectionId: 'x' }),
            rec({ model: 'd', costUsd: 0, equivalentUsd: 0.5, connectionId: 'x' }),
        ];
        const s = summarizeUsage(records, { from: 0, to: 10_000 }, dayOf);
        expect(s.byModel.map((m) => m.model)).toEqual(['c', 'd', 'a', 'b']);
        expect(s.byConnection.map((c) => c.connectionId)).toEqual(['y', 'x', null, 'z']);
    });

    it('does not mutate its input and rounds sums', () => {
        const records = [rec({ costUsd: 0.1 }), rec({ costUsd: 0.2 })];
        const copy = structuredClone(records);
        const s = summarizeUsage(records, { from: 0, to: 10_000 }, dayOf);
        expect(records).toEqual(copy);
        expect(s.total.costUsd).toBe(0.3);
    });
});
