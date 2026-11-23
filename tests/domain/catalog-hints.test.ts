import { describe, expect, it } from 'vitest';
import { normalizeCatalog, normalizeModelProviders } from '../../src/domain/catalog';
import { BILLING_BYPASS_CODE, HINT_CODES, HINT_RULES, routingHints } from '../../src/domain/catalog-hints';
import type { CatalogModel, ModelProviders, ProviderEndpoint } from '../../src/shared/contracts';
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
const providersOf = (id: string, raw: unknown): ModelProviders => normalizeModelProviders(id, raw)!;
const codes = (hints: { code: string }[]): string[] => hints.map((h) => h.code);

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

function host(id: string, over: Partial<ProviderEndpoint> = {}): ProviderEndpoint {
    return {
        id,
        quantization: null,
        rawQuantization: null,
        pricing: null,
        tps: null,
        ttftMs: null,
        uptime: null,
        maxOutputTokens: null,
        features: [],
        ...over,
    };
}

function providers(list: ProviderEndpoint[], over: Partial<ModelProviders> = {}): ModelProviders {
    return {
        modelId: 'x/y',
        supportsProviderSelection: true,
        autoCacheReadRate: null,
        autoTps: null,
        autoTtftMs: null,
        providers: list,
        ...over,
    };
}

const q = (id: string, quantization: ProviderEndpoint['quantization'], raw: string | null = quantization) =>
    host(id, { quantization, rawQuantization: raw });

describe('routingHints on real data', () => {
    it('warns about the fp4 hosts of GLM 5.3 and suggests a floor of fp8', () => {
        const hints = routingHints(byId('z-ai/glm-5.3'), providersOf('z-ai/glm-5.3', glmProviders));
        expect(codes(hints)).toEqual(['quant.glmFp8', 'reasoning.alwaysOn', BILLING_BYPASS_CODE]);
        const glm = hints[0]!;
        expect(glm.severity).toBe('warn');
        expect(glm.params).toMatchObject({
            model: 'z-ai/glm-5.3',
            hostsKnown: true,
            lowHosts: 14,
            unknownHosts: 15,
            okHosts: 10,
        });
        // fp4 and nvfp4 hosts; the official Z.AI (fp8) is not among them.
        expect(String(glm.params['low']).split(', ')).toEqual(
            expect.arrayContaining(['coreweave', 'relace', 'deepinfra']),
        );
        expect(String(glm.params['low'])).not.toContain('zai');
        expect(glm.suggestedRouting).toEqual({ enabled: true, minQuantization: 'fp8' });
    });

    it('says that explicit routing leaves the subscription of an included model', () => {
        const hints = routingHints(byId('z-ai/glm-5.3'), providersOf('z-ai/glm-5.3', glmProviders));
        expect(hints.at(-1)).toEqual({
            code: 'billing.bypass',
            severity: 'info',
            params: { markupPercent: 5, because: 'quant.glmFp8' },
        });
    });

    it('stays quiet about quantisation for a TEE model whose hosts report none', () => {
        const hints = routingHints(byId('TEE/glm-5.3'), providersOf('TEE/glm-5.3', teeProviders));
        expect(codes(hints)).toEqual(['reasoning.alwaysOn']);
    });

    it('flags the hosts of DeepSeek V4.1 that are not natively MXFP4', () => {
        const hints = routingHints(
            byId('deepseek/deepseek-v4.1-flash-1017'),
            providersOf('deepseek/deepseek-v4.1-flash-1017', dsProviders),
        );
        expect(codes(hints)).toEqual(['quant.deepseekNative', BILLING_BYPASS_CODE]);
        const hint = hints[0]!;
        expect(hint.severity).toBe('warn');
        // wafer and discretestack are labelled mxfp4 and are fine.
        expect(hint.params).toMatchObject({ suspiciousHosts: 5, nativeHosts: 2 });
        expect(hint.suggestedRouting).toEqual({
            enabled: true,
            ignore: ['inceptron', 'ambient', 'relace', 'nebius', 'sailresearch-standard'],
        });
        expect(hints[1]?.params).toMatchObject({ because: 'quant.deepseekNative' });
    });

    it('has nothing to say about DeepSeek before the hosts are known', () => {
        expect(routingHints(byId('deepseek/deepseek-v4.1-flash-1017'), null)).toEqual([]);
    });

    it('warns that a one-host model is an availability risk, and reports its cache rate', () => {
        const hints = routingHints(byId('fireworks/ember-1'), providersOf('fireworks/ember-1', emberProviders));
        expect(codes(hints)).toEqual(['hosts.few', 'cache.lowRate']);
        expect(hints[0]).toEqual({ code: 'hosts.few', severity: 'warn', params: { hosts: 1 } });
        expect(hints[1]?.params).toEqual({ percent: 0, threshold: 60 });
        // The catalog entry alone is enough for this one.
        expect(codes(routingHints(byId('fireworks/ember-1'), null))).toEqual(['hosts.few']);
    });

    it('explains a fixed route and gives no routing advice for it', () => {
        const hints = routingHints(byId('z-ai/glm-4.5v'), providersOf('z-ai/glm-4.5v', fixedRoute));
        expect(codes(hints)).toEqual(['routing.fixedRoute', 'cache.lowRate']);
        expect(hints.some((h) => h.suggestedRouting)).toBe(false);
        // Without the host list a GLM model that names no hosts gets no precision advice either.
        expect(routingHints(byId('z-ai/glm-4.5v'), null)).toEqual([]);
    });

    it('marks the uncensored shelf', () => {
        const hints = routingHints(byId('GLM-4.6-Derestricted-v5'), null);
        expect(codes(hints)).toEqual(['hosts.few', 'quant.glmFp8', 'shelf.uncensoredUnmeasured', BILLING_BYPASS_CODE]);
        expect(hints.find((h) => h.code === 'shelf.uncensoredUnmeasured')).toEqual({
            code: 'shelf.uncensoredUnmeasured',
            severity: 'info',
            params: { model: 'GLM-4.6-Derestricted-v5', byShelf: true },
        });
    });

    it('lists the lowest effort of an always-reasoning model', () => {
        const hints = routingHints(byId('sakana/fugu-ultra'), null);
        expect(hints).toEqual([
            { code: 'reasoning.alwaysOn', severity: 'info', params: { efforts: 'high, xhigh, max', lowest: 'high' } },
        ]);
        // A model that can switch reasoning off is not "always on".
        expect(routingHints(byId('particle-ai/particle-1'), null)).toEqual([]);
    });

    it('answers every model of the sample with known codes only', () => {
        for (const m of catalog) {
            for (const hint of routingHints(m, null)) expect(HINT_CODES).toContain(hint.code);
        }
    });
});

describe('quant.glmFp8', () => {
    it('fires for any model with glm in the id, whatever the case', () => {
        const hosts = providers([q('a', 'fp4'), q('b', 'fp8')]);
        for (const id of ['z-ai/glm-5.3', 'TEE/GLM-5.2', 'orca/orcacyber-glm-5.3', 'GLM-4.6-Derestricted-v5']) {
            expect(codes(routingHints(model({ id }), hosts))).toContain('quant.glmFp8');
        }
        expect(codes(routingHints(model({ id: 'qwen/qwen3.8' }), hosts))).not.toContain('quant.glmFp8');
    });

    it('stays quiet when every host reaches fp8, and counts int8 as below it', () => {
        const fine = providers([q('a', 'fp8'), q('b', 'bf16'), q('c', 'unknown'), host('d')]);
        expect(routingHints(model({ id: 'z-ai/glm-5' }), fine)).toEqual([]);
        const int8 = routingHints(model({ id: 'z-ai/glm-5' }), providers([q('a', 'int8'), q('b', 'fp8')]));
        expect(int8[0]?.params).toMatchObject({ lowHosts: 1, low: 'a', okHosts: 1, unknownHosts: 0 });
    });

    it('warns without a suggestion when no host would be left above the floor', () => {
        const hints = routingHints(
            model({ id: 'z-ai/glm-5', subscription: { included: true, inputTokenMultiplier: 1 } }),
            providers([q('a', 'fp4'), q('b', 'fp4'), q('c', 'unknown')]),
        );
        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatchObject({ severity: 'warn', params: { lowHosts: 2, okHosts: 0, unknownHosts: 1 } });
        expect('suggestedRouting' in hints[0]!).toBe(false);
    });

    it('gives an info-level note before the host list is loaded, when the entry names hosts', () => {
        const m = model({ id: 'z-ai/glm-5', providerIds: ['a', 'b', 'c'] });
        const hints = routingHints(m, null);
        expect(hints).toEqual([
            {
                code: 'quant.glmFp8',
                severity: 'info',
                params: { model: 'z-ai/glm-5', hostsKnown: false },
                suggestedRouting: { enabled: true, minQuantization: 'fp8' },
            },
        ]);
        expect(routingHints(model({ id: 'z-ai/glm-5' }), null)).toEqual([]);
    });
});

describe('quant.deepseekNative', () => {
    const ds = model({ id: 'deepseek/deepseek-v4-pro-0813' });

    it('treats mxfp4 as native, whatever the case, and other 4-bit labels as suspicious', () => {
        const mp = providers([
            q('native', 'fp4', 'MXFP4'),
            q('nv', 'fp4', 'nvfp4'),
            q('plain', 'fp4', 'fp4'),
            q('int', 'int4', 'int4'),
            q('nolabel', 'fp4', null),
            q('eight', 'fp8'),
            q('unk', 'unknown'),
            host('none'),
        ]);
        const hint = routingHints(ds, mp)[0]!;
        expect(hint.code).toBe('quant.deepseekNative');
        expect(hint.params).toEqual({
            model: 'deepseek/deepseek-v4-pro-0813',
            suspiciousHosts: 4,
            suspicious: 'nv, plain, int, nolabel',
            nativeHosts: 1,
        });
        expect(hint.suggestedRouting).toEqual({ enabled: true, ignore: ['nv', 'plain', 'int', 'nolabel'] });
    });

    it('stays quiet when every 4-bit host is native, for other families and without the host list', () => {
        const spread = (list: ProviderEndpoint[]) => providers([...list, host('x'), host('y'), host('z')]);
        expect(routingHints(ds, spread([q('a', 'fp4', 'mxfp4'), q('b', 'fp8')]))).toEqual([]);
        expect(routingHints(model({ id: 'deepseek/deepseek-v3.2' }), spread([q('a', 'fp4', 'nvfp4')]))).toEqual([]);
        expect(routingHints(ds, null)).toEqual([]);
    });

    it('also covers the TEE and finetuned V4 ids', () => {
        const mp = providers([q('a', 'fp4', 'nvfp4')]);
        expect(codes(routingHints(model({ id: 'TEE/deepseek-v4.1-flash' }), mp))).toContain('quant.deepseekNative');
        expect(codes(routingHints(model({ id: 'pqhaz/DeepSeek-V4.1-Flash-1017-heretic' }), mp))).toContain(
            'quant.deepseekNative',
        );
    });
});

describe('hosts.few', () => {
    const named = (n: number) => Array.from({ length: n }, (_, i) => `h${i}`);

    it('fires for one or two hosts, not for none or three', () => {
        expect(routingHints(model({ id: 'a/b', providerIds: named(1) }), null)).toHaveLength(1);
        expect(routingHints(model({ id: 'a/b', providerIds: named(2) }), null)[0]?.params).toEqual({ hosts: 2 });
        expect(routingHints(model({ id: 'a/b', providerIds: named(3) }), null)).toEqual([]);
        expect(routingHints(model({ id: 'a/b', providerIds: [] }), null)).toEqual([]);
    });

    it('prefers the loaded host list over the catalog entry', () => {
        const three = providers([host('a'), host('b'), host('c')]);
        expect(routingHints(model({ id: 'a/b', providerIds: named(1) }), three)).toEqual([]);
        const one = providers([host('a')]);
        expect(codes(routingHints(model({ id: 'a/b', providerIds: named(5) }), one))).toEqual(['hosts.few']);
        // A loaded list with no hosts is not "few hosts": the model has no selectable ones.
        expect(routingHints(model({ id: 'a/b', providerIds: named(1) }), providers([]))).toEqual([]);
    });
});

describe('routing.fixedRoute and cache.lowRate', () => {
    it('fires fixedRoute only when NanoGPT says so', () => {
        const m = model({ id: 'a/b' });
        expect(codes(routingHints(m, providers([], { supportsProviderSelection: false })))).toEqual([
            'routing.fixedRoute',
        ]);
        expect(routingHints(m, providers([], { supportsProviderSelection: true }))).toEqual([]);
        expect(routingHints(m, null)).toEqual([]);
    });

    it('fires cacheLowRate below 60% only', () => {
        const m = model({ id: 'a/b' });
        const rate = (autoCacheReadRate: number | null) => routingHints(m, providers([], { autoCacheReadRate }));
        expect(rate(0.6)).toEqual([]);
        expect(rate(0.87)).toEqual([]);
        expect(rate(null)).toEqual([]);
        expect(rate(0.59)).toEqual([
            { code: 'cache.lowRate', severity: 'info', params: { percent: 59, threshold: 60 } },
        ]);
        expect(rate(0)[0]?.params).toEqual({ percent: 0, threshold: 60 });
    });
});

describe('reasoning.alwaysOn', () => {
    it('picks the lowest effort of the ladder, whatever the listing order', () => {
        const hint = routingHints(model({ id: 'a/b', reasoningEfforts: ['max', 'medium', 'low'] }), null)[0]!;
        expect(hint.params).toEqual({ efforts: 'max, medium, low', lowest: 'low' });
        const odd = routingHints(model({ id: 'a/b', reasoningEfforts: ['turbo', 'high'] }), null)[0]!;
        expect(odd.params).toMatchObject({ lowest: 'high' });
    });

    it('stays quiet when reasoning can be switched off or there is no choice', () => {
        expect(routingHints(model({ id: 'a/b', reasoningEfforts: ['none', 'high'] }), null)).toEqual([]);
        expect(routingHints(model({ id: 'a/b', reasoningEfforts: [] }), null)).toEqual([]);
    });
});

describe('shelf.uncensoredUnmeasured', () => {
    it('fires for the shelf, in any case, and for the id markers', () => {
        const byShelf = routingHints(model({ id: 'a/plain', category: 'uncensored' }), null);
        expect(byShelf).toEqual([
            { code: 'shelf.uncensoredUnmeasured', severity: 'info', params: { model: 'a/plain', byShelf: true } },
        ]);
        for (const id of ['a/foo-Uncensored', 'a/foo-abliterated', 'a/Foo-HERETIC-v2']) {
            const hint = routingHints(model({ id, category: 'More' }), null)[0]!;
            expect(hint).toMatchObject({ code: 'shelf.uncensoredUnmeasured', params: { byShelf: false } });
        }
        expect(routingHints(model({ id: 'a/plain', category: 'More' }), null)).toEqual([]);
        expect(routingHints(model({ id: 'a/plain' }), null)).toEqual([]);
    });
});

describe('billing.bypass and ordering', () => {
    const lowHosts = providers([q('a', 'fp4'), q('b', 'fp8')]);

    it('is added once, only for a subscription-included model with a suggestion', () => {
        const included = model({ id: 'z-ai/glm-5', subscription: { included: true, inputTokenMultiplier: 1 } });
        const hints = routingHints(included, lowHosts);
        expect(codes(hints).filter((c) => c === 'billing.bypass')).toHaveLength(1);
        expect(routingHints(model({ id: 'z-ai/glm-5' }), lowHosts).some((h) => h.code === 'billing.bypass')).toBe(
            false,
        );
        // An included model with no suggestion (and no hint at all) gets no note either.
        expect(
            routingHints(model({ id: 'a/b', subscription: { included: true, inputTokenMultiplier: 1 } }), null),
        ).toEqual([]);
        const quiet = model({
            id: 'a/b',
            subscription: { included: true, inputTokenMultiplier: 1 },
            reasoningEfforts: ['high'],
        });
        expect(codes(routingHints(quiet, null))).toEqual(['reasoning.alwaysOn']);
    });

    it('lists warnings first, then infos in table order, the billing note last', () => {
        const m = model({
            id: 'z-ai/glm-5-uncensored',
            category: 'Uncensored',
            reasoningEfforts: ['low', 'high'],
            subscription: { included: true, inputTokenMultiplier: 1 },
            providerIds: ['a', 'b'],
        });
        const mp = providers([q('a', 'fp4'), q('b', 'fp8')], {
            supportsProviderSelection: true,
            autoCacheReadRate: 0.3,
        });
        const hints = routingHints(m, mp);
        expect(codes(hints)).toEqual([
            'quant.glmFp8',
            'hosts.few',
            'cache.lowRate',
            'reasoning.alwaysOn',
            'shelf.uncensoredUnmeasured',
            'billing.bypass',
        ]);
        expect(hints.map((h) => h.severity)).toEqual(['warn', 'warn', 'info', 'info', 'info', 'info']);
    });

    it('leaves the key out when a hint has no suggestion', () => {
        const hint = routingHints(model({ id: 'a/b', providerIds: ['x'] }), null)[0]!;
        expect('suggestedRouting' in hint).toBe(false);
    });

    it('lists every code of the table plus the billing note', () => {
        expect(HINT_CODES).toEqual([...HINT_RULES.map((r) => r.code), 'billing.bypass']);
        expect(new Set(HINT_CODES).size).toBe(HINT_CODES.length);
        expect(HINT_CODES).toEqual([
            'quant.glmFp8',
            'quant.deepseekNative',
            'hosts.few',
            'routing.fixedRoute',
            'cache.lowRate',
            'reasoning.alwaysOn',
            'shelf.uncensoredUnmeasured',
            'billing.bypass',
        ]);
    });
});
