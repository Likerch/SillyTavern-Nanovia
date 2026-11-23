import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../src/shared/contracts';
import {
    resolveUsage,
    shimResponse,
    shimResponseBody,
    shimSseEventData,
    shimSsePayload,
    type ShimContext,
} from '../../src/domain/shim';

const MODEL: CatalogModel = {
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
};

const CTX: ShimContext = { model: MODEL, billingModeForced: false, explicitRouting: false, requestId: 'hdr-1' };

function body(usage: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Привет 👋' }, finish_reason: 'stop' }],
        usage,
        ...extra,
    };
}

/** What Maestro's readUsage (SillyTavern-Maestro/src/core/cost.ts) makes of a response; the few lines are copied here. */
function maestroReadUsage(
    raw: unknown,
): { prompt: number; completion: number; usd?: number; cached?: number } | undefined {
    const isRecord = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && !Array.isArray(v);
    const firstNumber = (...values: unknown[]): number | undefined => {
        for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
        return undefined;
    };
    if (!isRecord(raw)) return undefined;
    const nested = isRecord(raw['message']) ? raw['message'] : undefined;
    const usage = isRecord(raw['usage'])
        ? raw['usage']
        : isRecord(raw['usageMetadata'])
          ? raw['usageMetadata']
          : nested && isRecord(nested['usage'])
            ? nested['usage']
            : undefined;
    if (!usage) return undefined;
    const prompt = firstNumber(usage['prompt_tokens'], usage['input_tokens'], usage['promptTokenCount']) ?? 0;
    const completion =
        firstNumber(usage['completion_tokens'], usage['output_tokens'], usage['candidatesTokenCount']) ?? 0;
    const usd = firstNumber(usage['cost'], usage['total_cost']);
    const details = isRecord(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : {};
    const cached = firstNumber(
        details['cached_tokens'],
        usage['cache_read_input_tokens'],
        usage['cachedContentTokenCount'],
        usage['prompt_cache_hit_tokens'],
    );
    const info: { prompt: number; completion: number; usd?: number; cached?: number } = { prompt, completion };
    if (cached !== undefined && cached > 0) info.cached = cached;
    if (usd !== undefined) info.usd = usd;
    return info;
}

describe('shimResponseBody', () => {
    it('rewrites a subscription response: cost 0, details filled, nanovia block added', () => {
        const input = body({
            prompt_tokens: 2000,
            completion_tokens: 100,
            total_tokens: 2100,
            prompt_tokens_details: { cached_tokens: 1500 },
            cost: '0',
            currency: 'USD',
        });
        const out = shimResponseBody(input, CTX);
        const usage = out['usage'] as Record<string, unknown>;
        expect(usage).toMatchObject({
            prompt_tokens: 2000,
            completion_tokens: 100,
            total_tokens: 2100,
            cost: 0,
            prompt_tokens_details: { cached_tokens: 1500 },
            completion_tokens_details: { reasoning_tokens: 0 },
            nanovia: { billing: 'subscription', request_id: 'hdr-1' },
        });
        expect((usage['nanovia'] as { equivalent_usd: number }).equivalent_usd).toBeCloseTo(
            (500 * 0.4 + 1500 * 0.04 + 200) / 1e6,
            9,
        );
        expect(usage).not.toHaveProperty('currency');
    });

    it('rewrites a paygo response with the real cost and reasoning tokens', () => {
        const out = shimResponseBody(
            body({
                prompt_tokens: 1000,
                completion_tokens: 300,
                completion_tokens_details: { reasoning_tokens: 120, audio_tokens: 0 },
                cost: 0.0031,
            }),
            CTX,
        );
        const usage = out['usage'] as Record<string, any>;
        expect(usage['cost']).toBe(0.0031);
        expect(usage['total_tokens']).toBe(1300);
        expect(usage['completion_tokens_details']).toEqual({ reasoning_tokens: 120, audio_tokens: 0 });
        expect(usage['nanovia'].billing).toBe('paygo');
    });

    it('never touches choices or other fields and leaves the input alone', () => {
        const input = body(
            { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
            { system_fingerprint: 'fp', x_nanogpt_pricing: { cost: 1 } },
        );
        const before = structuredClone(input);
        const out = shimResponseBody(input, CTX);
        expect(input).toEqual(before);
        expect(out).not.toBe(input);
        expect(out['choices']).toBe(input['choices']);
        expect({ ...out, usage: null }).toEqual({ ...input, usage: null });
    });

    it('drops total_cost and a foreign currency and leaves cost out when the real cost is unknown', () => {
        const out = shimResponseBody(
            body({ prompt_tokens: 10, completion_tokens: 1, cost: '0.0003', total_cost: 0.0003, currency: 'XNO' }),
            CTX,
        );
        const usage = out['usage'] as Record<string, any>;
        expect(usage).not.toHaveProperty('cost');
        expect(usage).not.toHaveProperty('total_cost');
        expect(usage).not.toHaveProperty('currency');
        expect(usage['nanovia'].billing).toBe('paygo');
        expect(maestroReadUsage(out)?.usd).toBeUndefined();
    });

    it('does not turn an estimate into the real cost', () => {
        const out = shimResponseBody(
            body(
                { prompt_tokens: 100, completion_tokens: 10 },
                { x_nanogpt_pricing: { cost: 0.9, isEstimate: true, requestId: 'body-id' } },
            ),
            { ...CTX, model: null, requestId: null },
        );
        const usage = out['usage'] as Record<string, any>;
        expect(usage).not.toHaveProperty('cost');
        expect(usage['nanovia']).toEqual({ billing: 'unknown', equivalent_usd: 0.9, request_id: 'body-id' });
    });

    it('prefers the header request id and reports null equivalent for an unknown model', () => {
        const out = shimResponseBody(
            body({ prompt_tokens: 5, completion_tokens: 5, cost: 0 }, { x_nanogpt_pricing: { requestId: 'body-id' } }),
            { ...CTX, model: null },
        );
        expect((out['usage'] as any).nanovia).toEqual({
            billing: 'unknown',
            equivalent_usd: null,
            request_id: 'hdr-1',
        });
    });

    it('fills a missing total, cache write and reasoning count, and keeps other details', () => {
        const out = shimResponseBody(
            body({
                input_tokens: 40,
                output_tokens: 2,
                cache_creation_input_tokens: 10,
                prompt_tokens_details: { audio_tokens: 3 },
                cost: 0,
            }),
            CTX,
        );
        const usage = out['usage'] as Record<string, any>;
        expect(usage).toMatchObject({ prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 });
        expect(usage['prompt_tokens_details']).toEqual({ audio_tokens: 3, cached_tokens: 0, cache_write_tokens: 10 });
    });

    it('forces paygo when the connection says so, even at cost 0', () => {
        const out = shimResponseBody(body({ prompt_tokens: 5, completion_tokens: 5, cost: 0 }), {
            ...CTX,
            billingModeForced: true,
        });
        expect((out['usage'] as any).nanovia.billing).toBe('paygo');
        expect((out['usage'] as any).cost).toBe(0);
    });

    it.each([
        ['no usage', body(undefined)],
        ['usage: null', body(null)],
        ['an empty usage', body({})],
        ['a usage of junk', body({ prompt_tokens: -1, cost: 'abc' })],
        ['a usage that is not an object', body('lots')],
    ])('returns a plain copy for %s', (_name, input) => {
        const result = shimResponse(input, CTX);
        expect(result.resolved).toBeNull();
        expect(result.body).toEqual(input);
        expect(result.body).not.toBe(input);
        expect(result.body).not.toHaveProperty('nanovia');
    });
});

describe('golden: Maestro reads a shimmed body', () => {
    it('sees real USD, 0 for a subscription, and the cache hit', () => {
        const subscription = shimResponseBody(
            body({
                prompt_tokens: 2000,
                completion_tokens: 100,
                prompt_tokens_details: { cached_tokens: 1500 },
                cost: 0,
            }),
            CTX,
        );
        expect(maestroReadUsage(subscription)).toEqual({ prompt: 2000, completion: 100, cached: 1500, usd: 0 });

        const paygo = shimResponseBody(
            body({ prompt_tokens: 100, completion_tokens: 10, cost: '0.00123', currency: 'USD' }),
            CTX,
        );
        expect(maestroReadUsage(paygo)).toEqual({ prompt: 100, completion: 10, usd: 0.00123 });
    });

    it('reads DeepSeek and Claude cache fields through the shim as cached tokens', () => {
        const deepseek = shimResponseBody(
            body({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 64, cost: 0.1 }),
            CTX,
        );
        expect(maestroReadUsage(deepseek)?.cached).toBe(64);
        const claude = shimResponseBody(
            body({ prompt_tokens: 100, completion_tokens: 1, cache_read_input_tokens: 32, cost: 0.1 }),
            CTX,
        );
        expect(maestroReadUsage(claude)?.cached).toBe(32);
    });

    it('sees no price for an unknown cost, so Maestro falls back to its own table', () => {
        const unknown = shimResponseBody(body({ prompt_tokens: 7, completion_tokens: 3 }), CTX);
        expect(maestroReadUsage(unknown)).toEqual({ prompt: 7, completion: 3 });
    });
});

describe('resolveUsage', () => {
    it('is null without a usable usage record', () => {
        expect(resolveUsage(null, CTX)).toBeNull();
        expect(resolveUsage({ choices: [] }, CTX)).toBeNull();
        expect(resolveUsage({ usage: 4 }, CTX)).toBeNull();
        expect(resolveUsage({ usage: {} }, CTX)).toBeNull();
    });

    it('carries the facts the proxy needs for its record', () => {
        const r = resolveUsage(body({ prompt_tokens: 1, completion_tokens: 1, cost: 0 }), CTX);
        expect(r).toMatchObject({ billing: 'subscription', costUsd: 0, requestId: 'hdr-1' });
        expect(r?.usage.promptTokens).toBe(1);
    });
});

describe('shimSseEventData', () => {
    const usageChunk = {
        id: 'c1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0 },
    };

    it('returns [DONE] and non-usage payloads byte-identical', () => {
        const chunk = JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'Hi' } }] });
        const nullUsage = '{"id":"c1",  "choices":[],"usage":null}';
        for (const data of [
            '[DONE]',
            chunk,
            nullUsage,
            'not json usage',
            '',
            '{"usage":{}}',
            '"usage"',
            '[1,"usage"]',
        ]) {
            expect(shimSseEventData(data, CTX)).toBe(data);
        }
    });

    it('rewrites the final chunk that shares usage with finish_reason, keeping choices', () => {
        const out = JSON.parse(shimSseEventData(JSON.stringify(usageChunk), CTX));
        expect(out.choices).toEqual(usageChunk.choices);
        expect(out.usage).toMatchObject({
            prompt_tokens: 50,
            completion_tokens: 5,
            total_tokens: 55,
            cost: 0,
            nanovia: { billing: 'subscription', request_id: 'hdr-1' },
        });
    });

    it('reports what it resolved', () => {
        const hit = shimSsePayload(JSON.stringify(usageChunk), CTX);
        expect(hit.resolved?.billing).toBe('subscription');
        const miss = shimSsePayload('[DONE]', CTX);
        expect(miss).toEqual({ data: '[DONE]', resolved: null });
    });
});
