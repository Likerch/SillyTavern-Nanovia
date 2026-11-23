import { describe, expect, it } from 'vitest';
import {
    estimateTurnCost,
    filterCatalog,
    groupByVendor,
    listCategories,
    mapQuantization,
    meetsMinQuantization,
    normalizeCatalog,
    normalizeCatalogModel,
    normalizeModelProviders,
    quantizationRank,
    sortCatalog,
    vendorOf,
} from '../../src/domain/catalog';
import type { CatalogModel } from '../../src/shared/contracts';
import modelsSample from '../fixtures/catalog/models.sample.json';
import dsProviders from '../fixtures/catalog/providers.deepseek-v4.1-flash-1017.json';
import emberProviders from '../fixtures/catalog/providers.ember-1.json';
import fixedRoute from '../fixtures/catalog/providers.glm-4.5v.fixed-route.json';
import glmProviders from '../fixtures/catalog/providers.glm-5.3.json';
import teeProviders from '../fixtures/catalog/providers.tee-glm-5.3.json';

const catalog = normalizeCatalog(modelsSample);
const byId = (id: string): CatalogModel => {
    const model = catalog.find((m) => m.id === id);
    if (!model) throw new Error(`fixture has no ${id}`);
    return model;
};
const ids = (models: CatalogModel[]): string[] => models.map((m) => m.id);

/** A complete model for synthetic cases; override what the case is about. */
function model(over: Partial<CatalogModel> & { id: string }): CatalogModel {
    return {
        name: over.id,
        description: '',
        contextLength: 100_000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: false, toolCalling: false, structuredOutput: false },
        reasoningEfforts: [],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: false, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
        ...over,
    };
}

describe('normalizeCatalogModel', () => {
    it('reads a real entry (GLM 5.3)', () => {
        const glm = byId('z-ai/glm-5.3');
        expect(glm).toMatchObject({
            id: 'z-ai/glm-5.3',
            name: 'GLM 5.3',
            contextLength: 1_048_576,
            maxOutputTokens: 131_072,
            capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: true },
            reasoningEfforts: ['low', 'high', 'max'],
            openWeights: true,
            pricing: { prompt: 0.6, completion: 1.1, cacheRead: 0.2 },
            category: 'More',
            subscription: { included: true, inputTokenMultiplier: 1 },
            created: 1_786_665_600,
        });
        expect(glm.description).toContain('GLM-5.3');
        expect(glm.providerIds).toHaveLength(39);
        expect(glm.providerIds[0]).toBe('nube');
    });

    it('converts the cache-read price from per 1k to per 1M and cleans float noise', () => {
        expect(byId('particle-ai/particle-1').pricing).toEqual({ prompt: 0.25, completion: 1, cacheRead: 0.03 });
        expect(byId('deepseek/deepseek-v4.1-flash-1017').pricing.cacheRead).toBe(0.0042);
        // The raw value is 0.000014999999999999999 per 1k.
        expect(byId('ibm-granite/granite-4.2-8b').pricing.cacheRead).toBe(0.015);
        // The raw prompt price carries noise of its own: 0.060500000000000005.
        expect(byId('z-ai/glm-4.7-flash').pricing).toMatchObject({ prompt: 0.0605, completion: 0.4 });
    });

    it('gives a model without a price 0 and no cache price', () => {
        // "varies by modality": the entry has no prompt/completion at all.
        expect(byId('qwen/qwen3.5-omni-flash').pricing).toEqual({ prompt: 0, completion: 0, cacheRead: null });
        expect(byId('auto-model').pricing).toEqual({ prompt: 0, completion: 0, cacheRead: null });
    });

    it('keeps unknown windows as null and a missing category as null', () => {
        const fast = byId('fastgpt');
        expect(fast.contextLength).toBeNull();
        expect(fast.maxOutputTokens).toBe(32_768);
        expect(byId('fireworks/ember-1').maxOutputTokens).toBeNull();
        expect(byId('deepseek/deepseek-v4.1-flash-1017').category).toBeNull();
        expect(normalizeCatalogModel({ id: 'a/b', category: '  ' })?.category).toBeNull();
    });

    it('lists reasoning efforts as NanoGPT gives them', () => {
        expect(byId('particle-ai/particle-1').reasoningEfforts).toEqual([
            'none',
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
        ]);
        expect(byId('deepseek/deepseek-v4.1-flash-1017').reasoningEfforts).toEqual(['none', 'low', 'high', 'max']);
        expect(byId('z-ai/glm-4.5v').reasoningEfforts).toEqual([]);
    });

    it('reads capabilities and subscription flags', () => {
        expect(byId('z-ai/glm-4.5v').capabilities).toEqual({
            vision: true,
            reasoning: true,
            toolCalling: false,
            structuredOutput: false,
        });
        expect(byId('particle-ai/particle-1').openWeights).toBe(false);
        expect(byId('fireworks/ember-1').openWeights).toBe(false); // the field is absent
        expect(byId('auto-model').subscription.included).toBe(true);
    });

    it('takes created in seconds, converts milliseconds, rejects nonsense', () => {
        expect(normalizeCatalogModel({ id: 'a/b', created: 1_786_665_600 })?.created).toBe(1_786_665_600);
        expect(normalizeCatalogModel({ id: 'a/b', created: 1_786_665_600_123 })?.created).toBe(1_786_665_600);
        expect(normalizeCatalogModel({ id: 'a/b' })?.created).toBeNull();
        expect(normalizeCatalogModel({ id: 'a/b', created: 0 })?.created).toBeNull();
        expect(normalizeCatalogModel({ id: 'a/b', created: '1786665600' })?.created).toBeNull();
    });

    it('rejects what cannot be a model', () => {
        for (const junk of [null, undefined, 5, 'x', [], {}, { id: '' }, { id: '   ' }, { id: 5 }]) {
            expect(normalizeCatalogModel(junk)).toBeNull();
        }
    });

    it('survives a bare entry and ill-typed fields', () => {
        expect(normalizeCatalogModel({ id: ' vendor/bare ' })).toEqual({
            id: 'vendor/bare',
            name: 'vendor/bare',
            description: '',
            contextLength: null,
            maxOutputTokens: null,
            capabilities: { vision: false, reasoning: false, toolCalling: false, structuredOutput: false },
            reasoningEfforts: [],
            openWeights: false,
            pricing: { prompt: 0, completion: 0, cacheRead: null },
            category: null,
            subscription: { included: false, inputTokenMultiplier: 1 },
            providerIds: [],
            created: null,
        });
        const odd = normalizeCatalogModel({
            id: 'x/y',
            name: 7,
            description: null,
            context_length: -5,
            max_output_tokens: Number.NaN,
            capabilities: { vision: 'yes', reasoning: 1, tool_calling: true },
            reasoning_efforts: ['low', 5, '', null, 'high'],
            pricing: { prompt: -1, completion: 'free', cacheReadInputPer1kTokens: -3 },
            subscription: { included: 'true', inputTokenMultiplier: 0 },
            providers: 'deepinfra',
        });
        expect(odd).toMatchObject({
            name: 'x/y',
            description: '',
            contextLength: null,
            maxOutputTokens: null,
            capabilities: { vision: false, reasoning: false, toolCalling: true, structuredOutput: false },
            reasoningEfforts: ['low', 'high'],
            pricing: { prompt: 0, completion: 0, cacheRead: null },
            subscription: { included: false, inputTokenMultiplier: 1 },
            providerIds: [],
        });
    });

    it('reads the subscription multiplier', () => {
        const m = normalizeCatalogModel({ id: 'a/b', subscription: { included: true, inputTokenMultiplier: 2.5 } });
        expect(m?.subscription).toEqual({ included: true, inputTokenMultiplier: 2.5 });
    });
});

describe('normalizeCatalog', () => {
    it('normalises the whole sample in order', () => {
        expect(catalog).toHaveLength(modelsSample.data.length);
        expect(ids(catalog)).toEqual(modelsSample.data.map((m) => m.id));
    });

    it('accepts a bare array, skips junk, keeps the first of a repeated id', () => {
        const list = normalizeCatalog([
            { id: 'a/one', name: 'First' },
            null,
            'junk',
            { name: 'no id' },
            { id: 'a/two' },
            { id: 'a/one', name: 'Second' },
        ]);
        expect(list.map((m) => [m.id, m.name])).toEqual([
            ['a/one', 'First'],
            ['a/two', 'a/two'],
        ]);
    });

    it('answers an empty list for anything that is not a list', () => {
        for (const junk of [null, undefined, 5, 'x', {}, { data: 'x' }, { error: { message: 'boom' } }]) {
            expect(normalizeCatalog(junk)).toEqual([]);
        }
    });
});

describe('mapQuantization', () => {
    it.each([
        ['fp4', 'fp4'],
        ['mxfp4', 'fp4'],
        ['nvfp4', 'fp4'],
        ['NVFP4', 'fp4'],
        ['int4', 'int4'],
        ['fp6', 'fp6'],
        ['int8', 'int8'],
        ['fp8', 'fp8'],
        ['FP8', 'fp8'],
        ['fp8_e4m3', 'fp8'],
        ['fp16', 'fp16'],
        ['bf16', 'bf16'],
        ['bfloat16', 'bf16'],
        ['fp32', 'fp32'],
        ['native', 'unknown'],
        ['unknown', 'unknown'],
        ['-', 'unknown'],
        ['w4a16-gptq', 'unknown'],
    ])('maps %s to %s and keeps the label', (label, expected) => {
        expect(mapQuantization(label)).toEqual({ quantization: expected, rawQuantization: label });
    });

    it('reports nothing for an absent label', () => {
        for (const nothing of [undefined, null, '', '   ', 4]) {
            expect(mapQuantization(nothing)).toEqual({ quantization: null, rawQuantization: null });
        }
    });
});

describe('normalizeModelProviders', () => {
    const ds = normalizeModelProviders('deepseek/deepseek-v4.1-flash-1017', dsProviders)!;
    const glm = normalizeModelProviders('z-ai/glm-5.3', glmProviders)!;
    const host = (id: string) => ds.providers.find((p) => p.id === id)!;

    it('reads the model level', () => {
        expect(ds).toMatchObject({
            modelId: 'deepseek/deepseek-v4.1-flash-1017',
            supportsProviderSelection: true,
            autoCacheReadRate: 0.87,
            autoTps: 163.2,
            autoTtftMs: 3892,
        });
    });

    it('drops hosts marked unavailable, which agrees with the catalog entry', () => {
        expect(dsProviders.providers).toHaveLength(45);
        expect(ds.providers).toHaveLength(42);
        expect(ds.providers.map((p) => p.id).sort()).toEqual(
            [...byId('deepseek/deepseek-v4.1-flash-1017').providerIds].sort(),
        );
        expect(glm.providers.map((p) => p.id).sort()).toEqual([...byId('z-ai/glm-5.3').providerIds].sort());
        expect(ds.providers.some((p) => p.id === 'phala')).toBe(false);
    });

    it('converts host prices from per 1k to per 1M', () => {
        expect(host('wafer')).toEqual({
            id: 'wafer',
            quantization: 'fp4',
            rawQuantization: 'mxfp4',
            pricing: { prompt: 0.0693, completion: 0.525, cacheRead: 0.006825 },
            tps: 251.4,
            ttftMs: 2238,
            uptime: 99.87,
            maxOutputTokens: 393_216,
            features: ['toolCalling', 'structuredOutput', 'imageInput', 'promptCaching'],
        });
        expect(glm.providers.find((p) => p.id === 'zai')?.pricing).toEqual({
            prompt: 1.47,
            completion: 4.62,
            cacheRead: 0.273,
        });
        // A host without a cache price has none.
        expect(glm.providers.find((p) => p.id === 'uomi')?.pricing).toEqual({
            prompt: 1.2954375,
            completion: 4.44759525,
            cacheRead: null,
        });
    });

    it('normalises precision labels and keeps the raw one', () => {
        expect(host('deepinfra')).toMatchObject({ quantization: 'fp8', rawQuantization: 'fp8' });
        expect(host('river')).toMatchObject({ quantization: 'unknown', rawQuantization: 'unknown' });
        expect(host('neuralwatt')).toMatchObject({ quantization: null, rawQuantization: null });
        expect(glm.providers.find((p) => p.id === 'coreweave')).toMatchObject({
            quantization: 'fp4',
            rawQuantization: 'nvfp4',
        });
        expect(glm.providers.find((p) => p.id === 'uomi')).toMatchObject({ quantization: 'bf16' });
    });

    it('leaves what a host does not report as null', () => {
        const nube = glm.providers.find((p) => p.id === 'nube')!;
        expect(nube).toMatchObject({ tps: null, ttftMs: null, uptime: null, quantization: null });
        // `uptime` is present but has no percentage.
        expect(host('relace').uptime).toBeNull();
        // A reported zero throughput is no measurement.
        expect(
            normalizeModelProviders('a/b', { providers: [{ provider: 'x', tps: 0, ttftMs: 0 }] })?.providers[0],
        ).toMatchObject({
            tps: null,
            ttftMs: null,
            pricing: null,
        });
    });

    it('reads a TEE model and a single-host model', () => {
        const tee = normalizeModelProviders('TEE/glm-5.3', teeProviders)!;
        expect(tee.providers.map((p) => p.id)).toEqual(['redpill', 'aptos', 'tinfoil']);
        expect(tee.providers.every((p) => p.quantization === null)).toBe(true);
        expect(tee.autoCacheReadRate).toBe(0.943);
        const ember = normalizeModelProviders('fireworks/ember-1', emberProviders)!;
        expect(ember.providers).toHaveLength(1);
        expect(ember.autoCacheReadRate).toBe(0);
    });

    it('treats a model without provider selection as a valid answer with no hosts', () => {
        const fixed = normalizeModelProviders('z-ai/glm-4.5v', fixedRoute)!;
        expect(fixed).toMatchObject({ modelId: 'z-ai/glm-4.5v', supportsProviderSelection: false, providers: [] });
        expect(fixed.autoCacheReadRate).toBe(0.0004);
        expect(normalizeModelProviders('x/y', { canonicalId: 'x/y', supportsProviderSelection: false })).toMatchObject({
            supportsProviderSelection: false,
            providers: [],
            autoCacheReadRate: null,
            autoTps: null,
        });
    });

    it('defaults selection to true and falls back to the canonical id', () => {
        const mp = normalizeModelProviders('', { canonicalId: 'a/b', providers: [{ provider: 'p' }] })!;
        expect(mp).toMatchObject({ modelId: 'a/b', supportsProviderSelection: true });
        expect(mp.providers[0]).toMatchObject({ id: 'p', pricing: null, features: [], uptime: null });
    });

    it('rejects what is not a host list', () => {
        for (const junk of [null, undefined, 3, 'x', [], {}, { error: { message: 'nope' } }]) {
            expect(normalizeModelProviders('a/b', junk)).toBeNull();
        }
        expect(normalizeModelProviders('', { providers: [] })).toBeNull();
    });

    it('is picky about the hosts it keeps', () => {
        const mp = normalizeModelProviders('a/b', {
            autoCacheReadRate: 7,
            providers: [
                null,
                { provider: '' },
                { provider: 'dup', uptime: 150, features: ['custom'] },
                { provider: 'dup' },
                { provider: 'half', pricing: { inputPer1kTokens: 0.001 } },
                { provider: 'bare', uptime: 98, maxOutputTokens: -1, features: 'x' },
            ],
        })!;
        expect(mp.autoCacheReadRate).toBeNull();
        expect(mp.providers.map((p) => p.id)).toEqual(['dup', 'half', 'bare']);
        expect(mp.providers[0]).toMatchObject({ uptime: null, features: ['custom'] });
        expect(mp.providers[1]?.pricing).toBeNull();
        expect(mp.providers[2]).toMatchObject({ uptime: 98, maxOutputTokens: null, features: [] });
    });
});

describe('precision scale', () => {
    it('ranks int4 < fp4 < fp6 < int8 < fp8 < fp16 < bf16 < fp32', () => {
        const order = ['int4', 'fp4', 'fp6', 'int8', 'fp8', 'fp16', 'bf16', 'fp32'] as const;
        const ranks = order.map((q) => quantizationRank(q));
        expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('ranks an unknown precision as null', () => {
        expect(quantizationRank('unknown')).toBeNull();
        expect(quantizationRank(null)).toBeNull();
        expect(quantizationRank(undefined)).toBeNull();
        expect(quantizationRank('fp3' as never)).toBeNull();
    });

    it('checks a floor with three answers', () => {
        expect(meetsMinQuantization('fp8', 'fp8')).toBe(true);
        expect(meetsMinQuantization('bf16', 'fp8')).toBe(true);
        expect(meetsMinQuantization('fp4', 'fp8')).toBe(false);
        expect(meetsMinQuantization('int8', 'fp8')).toBe(false);
        // Cannot be checked.
        expect(meetsMinQuantization('unknown', 'fp8')).toBeNull();
        expect(meetsMinQuantization(null, 'fp8')).toBeNull();
        // No floor: everything passes, even an unknown host.
        expect(meetsMinQuantization('int4', null)).toBe(true);
        expect(meetsMinQuantization(null, null)).toBe(true);
        expect(meetsMinQuantization('fp4', 'unknown')).toBe(true);
        expect(meetsMinQuantization('fp4', undefined)).toBe(true);
    });
});

describe('filterCatalog', () => {
    it('returns a copy of everything for an empty query', () => {
        const all = filterCatalog(catalog, {});
        expect(all).toEqual(catalog);
        expect(all).not.toBe(catalog);
        expect(filterCatalog(catalog, { text: '  ', categories: [], capabilities: {} })).toHaveLength(catalog.length);
    });

    it('searches id, name and description without regard to case', () => {
        expect(ids(filterCatalog(catalog, { text: 'GLM-5.3' }))).toEqual([
            'z-ai/glm-5.3',
            'z-ai/glm-5.3-uncensored',
            'TEE/glm-5.3',
            'z-ai/glm-5.3-flash-apex-abliterated',
        ]);
        expect(ids(filterCatalog(catalog, { text: 'ember' }))).toEqual(['fireworks/ember-1']);
        // The description only: Particle-1 is post-trained on DeepSeek V4.1 Flash.
        expect(ids(filterCatalog(catalog, { text: 'post-trained' }))).toEqual(['particle-ai/particle-1']);
    });

    it('wants every word, in any order', () => {
        expect(ids(filterCatalog(catalog, { text: 'tee 5.3' }))).toEqual(['TEE/glm-5.3']);
        expect(ids(filterCatalog(catalog, { text: '5.3 glm tee' }))).toEqual(['TEE/glm-5.3']);
        expect(filterCatalog(catalog, { text: 'glm nonsenseword' })).toEqual([]);
    });

    it('is Cyrillic-safe', () => {
        const list = [
            model({ id: 'ru/elka', name: 'Ёлка Привет', description: 'Модель для ролевых игр' }),
            model({ id: 'ru/other', name: 'Other', description: 'English only' }),
        ];
        expect(ids(filterCatalog(list, { text: 'ПРИВЕТ' }))).toEqual(['ru/elka']);
        expect(ids(filterCatalog(list, { text: 'елка' }))).toEqual(['ru/elka']);
        expect(ids(filterCatalog(list, { text: 'ёлка ролевых' }))).toEqual(['ru/elka']);
        expect(ids(filterCatalog(list, { text: 'ROLEVYH' }))).toEqual([]);
    });

    it('filters by shelf, with an empty name for no shelf', () => {
        expect(ids(filterCatalog(catalog, { categories: ['uncensored'] }))).toEqual([
            'z-ai/glm-5.3-uncensored',
            'pqhaz/DeepSeek-V4.1-Flash-1017-heretic',
            'GLM-4.6-Derestricted-v5',
            'z-ai/glm-5.3-flash-apex-abliterated',
        ]);
        expect(ids(filterCatalog(catalog, { categories: ['Private/TEE'] }))).toEqual(['TEE/glm-5.3', 'TEE/glm-5.2']);
        expect(ids(filterCatalog(catalog, { categories: [''] }))).toEqual([
            'deepseek/deepseek-v4.1-flash-1017',
            'deepseek/deepseek-v4.1-flash-1017:thinking',
            'deepseek/deepseek-v4-pro-0813',
            'auto-model',
        ]);
        expect(filterCatalog(catalog, { categories: ['Private/TEE', 'Uncensored'] })).toHaveLength(6);
    });

    it('filters by subscription, capabilities, window, price and open weights', () => {
        expect(filterCatalog(catalog, { subscriptionOnly: true }).every((m) => m.subscription.included)).toBe(true);
        expect(ids(filterCatalog(catalog, { capabilities: { vision: true } }))).toEqual([
            'z-ai/glm-4.5v',
            'deepseek/deepseek-v4.1-flash-1017',
            'deepseek/deepseek-v4.1-flash-1017:thinking',
            'pqhaz/DeepSeek-V4.1-Flash-1017-heretic',
            'fireworks/ember-1',
            'qwen/qwen3.5-omni-flash',
            'particle-ai/particle-1',
            'sakana/fugu-ultra',
            'z-ai/glm-5.3-flash-apex-abliterated',
        ]);
        const strict = filterCatalog(catalog, {
            capabilities: { vision: true, reasoning: true, tools: true, structured: true },
        });
        expect(ids(strict)).toEqual([
            'deepseek/deepseek-v4.1-flash-1017',
            'deepseek/deepseek-v4.1-flash-1017:thinking',
            'fireworks/ember-1',
            'sakana/fugu-ultra',
        ]);
        expect(filterCatalog(catalog, { capabilities: { tools: false, structured: false } })).toHaveLength(
            catalog.length,
        );
        // A model with an unknown window fails a window requirement.
        const big = filterCatalog(catalog, { minContext: 1_000_000 });
        expect(big.some((m) => m.id === 'fastgpt')).toBe(false);
        expect(big.every((m) => (m.contextLength ?? 0) >= 1_000_000)).toBe(true);
        expect(ids(filterCatalog(catalog, { maxPromptPrice: 0.1 }))).toEqual([
            'z-ai/glm-4.7-flash',
            'deepseek/deepseek-v4.1-flash-1017',
            'deepseek/deepseek-v4.1-flash-1017:thinking',
            'qwen/qwen3.5-omni-flash',
            'auto-model',
            'ibm-granite/granite-4.2-8b',
            'prism-ml/ternary-bonsai-2-9b',
        ]);
        const open = filterCatalog(catalog, { openWeightsOnly: true });
        expect(open.every((m) => m.openWeights)).toBe(true);
        expect(open.some((m) => m.id === 'particle-ai/particle-1')).toBe(false);
    });

    it('combines fields with AND and ignores numbers that are not numbers', () => {
        const q = { text: 'glm', subscriptionOnly: true, capabilities: { structured: true } };
        expect(ids(filterCatalog(catalog, q))).toEqual(['z-ai/glm-5.3', 'z-ai/glm-4.7-flash']);
        expect(filterCatalog(catalog, { minContext: Number.NaN, maxPromptPrice: Number.NaN })).toHaveLength(
            catalog.length,
        );
    });
});

describe('listCategories', () => {
    it('counts the shelves, the biggest first, null for no shelf', () => {
        expect(listCategories(catalog)).toEqual([
            { category: 'More', count: 10 },
            { category: 'Uncensored', count: 4 },
            { category: null, count: 4 },
            { category: 'Private/TEE', count: 2 },
        ]);
        expect(listCategories([])).toEqual([]);
    });
});

describe('sortCatalog', () => {
    it('sorts by name with numbers in order and leaves the input alone', () => {
        const list = [
            model({ id: 'a/1', name: 'GLM 10' }),
            model({ id: 'a/2', name: 'GLM 5.3' }),
            model({ id: 'a/3', name: 'glm 2' }),
        ];
        const sorted = sortCatalog(list, 'name');
        expect(sorted.map((m) => m.name)).toEqual(['glm 2', 'GLM 5.3', 'GLM 10']);
        expect(list.map((m) => m.name)).toEqual(['GLM 10', 'GLM 5.3', 'glm 2']);
        expect(sortCatalog(list, 'name', true).map((m) => m.name)).toEqual(['GLM 10', 'GLM 5.3', 'glm 2']);
    });

    it('sorts by price, cheapest first, and ties keep their incoming order', () => {
        const sorted = sortCatalog(catalog, 'price');
        // Two models without a price come first, in the order of the list.
        expect(ids(sorted).slice(0, 2)).toEqual(['qwen/qwen3.5-omni-flash', 'auto-model']);
        const totals = sorted.map((m) => m.pricing.prompt + m.pricing.completion);
        expect([...totals].sort((a, b) => a - b)).toEqual(totals);
        expect(sorted.at(-1)?.id).toBe('sakana/fugu-ultra');
        expect(sortCatalog(catalog, 'price', true)[0]?.id).toBe('sakana/fugu-ultra');
    });

    it('sorts by context, largest first, unknown last in both directions', () => {
        const list = [
            model({ id: 'a/small', contextLength: 8_000 }),
            model({ id: 'a/none', contextLength: null }),
            model({ id: 'a/big', contextLength: 1_000_000 }),
            model({ id: 'a/mid', contextLength: 128_000 }),
        ];
        expect(ids(sortCatalog(list, 'context'))).toEqual(['a/big', 'a/mid', 'a/small', 'a/none']);
        expect(ids(sortCatalog(list, 'context', true))).toEqual(['a/small', 'a/mid', 'a/big', 'a/none']);
        const real = sortCatalog(catalog, 'context');
        expect(real[0]?.id).toBe('z-ai/glm-5.3'); // ties at 1,048,576 keep the order of the list
        expect(real.at(-1)?.id).toBe('fastgpt');
    });

    it('sorts by newest, unknown last in both directions', () => {
        const list = [
            model({ id: 'a/old', created: 100 }),
            model({ id: 'a/none', created: null }),
            model({ id: 'a/new', created: 300 }),
            model({ id: 'a/mid', created: 200 }),
        ];
        expect(ids(sortCatalog(list, 'newest'))).toEqual(['a/new', 'a/mid', 'a/old', 'a/none']);
        expect(ids(sortCatalog(list, 'newest', true))).toEqual(['a/old', 'a/mid', 'a/new', 'a/none']);
        expect(sortCatalog(catalog, 'newest')[0]?.id).toBe('pqhaz/DeepSeek-V4.1-Flash-1017-heretic');
        expect(sortCatalog([model({ id: 'a/x' }), model({ id: 'a/y' })], 'newest').map((m) => m.id)).toEqual([
            'a/x',
            'a/y',
        ]);
    });

    it('puts subscription models first and keeps the order inside each group', () => {
        const list = [
            model({ id: 'a/paid1' }),
            model({ id: 'a/sub1', subscription: { included: true, inputTokenMultiplier: 1 } }),
            model({ id: 'a/paid2' }),
            model({ id: 'a/sub2', subscription: { included: true, inputTokenMultiplier: 1 } }),
        ];
        expect(ids(sortCatalog(list, 'subscription'))).toEqual(['a/sub1', 'a/sub2', 'a/paid1', 'a/paid2']);
        expect(ids(sortCatalog(list, 'subscription', true))).toEqual(['a/paid1', 'a/paid2', 'a/sub1', 'a/sub2']);
    });
});

describe('vendors', () => {
    it('takes the vendor from the id', () => {
        expect(vendorOf('z-ai/glm-5.3')).toBe('z-ai');
        expect(vendorOf('TEE/glm-5.3')).toBe('tee');
        expect(vendorOf('Qwen/qwen3:thinking')).toBe('qwen');
        expect(vendorOf('GLM-4.6-Derestricted-v5')).toBe('other');
        expect(vendorOf('/odd')).toBe('other');
        expect(vendorOf(' /odd')).toBe('other');
        expect(vendorOf('')).toBe('other');
    });

    it('groups in the order the vendors first appear', () => {
        const groups = groupByVendor(catalog);
        expect(groups.map((g) => g.vendor)).toEqual([
            'z-ai',
            'tee',
            'deepseek',
            'pqhaz',
            'fireworks',
            'qwen',
            'other',
            'particle-ai',
            'ibm-granite',
            'sakana',
            'prism-ml',
        ]);
        expect(ids(groups[0]!.models)).toEqual([
            'z-ai/glm-5.3',
            'z-ai/glm-5.3-uncensored',
            'z-ai/glm-4.7-flash',
            'z-ai/glm-4.5v',
            'z-ai/glm-5.3-flash-apex-abliterated',
        ]);
        expect(ids(groups[6]!.models)).toEqual(['auto-model', 'fastgpt', 'GLM-4.6-Derestricted-v5']);
        expect(groupByVendor([])).toEqual([]);
    });
});

describe('estimateTurnCost', () => {
    const glm = byId('z-ai/glm-5.3'); // 0.6 in, 1.1 out, 0.2 cached, USD per 1M

    it('prices a plain turn', () => {
        // 30,000 * 0.6 / 1M + 800 * 1.1 / 1M = 0.018 + 0.00088
        expect(estimateTurnCost(glm, { promptTokens: 30_000, completionTokens: 800 })).toBeCloseTo(0.01888, 9);
    });

    it('bills the cached share at the cache-read price', () => {
        // 6,000 * 0.6 + 24,000 * 0.2 + 800 * 1.1, per 1M = 0.0036 + 0.0048 + 0.00088
        expect(estimateTurnCost(glm, { promptTokens: 30_000, completionTokens: 800, cachedShare: 0.8 })).toBeCloseTo(
            0.00928,
            9,
        );
    });

    it('bills cached tokens as plain input when the model has no cache price', () => {
        const noCache = model({ id: 'a/b', pricing: { prompt: 2, completion: 4, cacheRead: null } });
        expect(estimateTurnCost(noCache, { promptTokens: 1_000_000, completionTokens: 0, cachedShare: 0.5 })).toBe(2);
    });

    it('clamps the share and ignores bad token counts', () => {
        const base = { promptTokens: 1_000_000, completionTokens: 0 };
        expect(estimateTurnCost(glm, { ...base, cachedShare: 5 })).toBe(0.2);
        expect(estimateTurnCost(glm, { ...base, cachedShare: -1 })).toBe(0.6);
        expect(estimateTurnCost(glm, { ...base, cachedShare: Number.NaN })).toBe(0.6);
        expect(estimateTurnCost(glm, { promptTokens: -5, completionTokens: Number.NaN })).toBe(0);
        expect(estimateTurnCost(glm, { promptTokens: 0, completionTokens: 1_000_000 })).toBe(1.1);
    });

    it('costs nothing for a free model', () => {
        expect(estimateTurnCost(byId('auto-model'), { promptTokens: 50_000, completionTokens: 1_000 })).toBe(0);
    });
});
