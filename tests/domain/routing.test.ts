import { describe, expect, it } from 'vitest';
import { defaultRouting } from '../../src/domain/connection';
import { buildProviderObject, hasExplicitRouting, routingFields, routingWarnings } from '../../src/domain/routing';
import type { RoutingConfig } from '../../src/shared/contracts';

function routing(over: Partial<RoutingConfig> = {}): RoutingConfig {
    return { ...defaultRouting(), enabled: true, ...over };
}

/** One setting at a time: [description, patch, RoutingConfig key it reports]. */
const SINGLE_SETTINGS: Array<[string, Partial<RoutingConfig>, string]> = [
    ['order', { order: ['deepinfra'] }, 'order'],
    ['only', { only: ['together'] }, 'only'],
    ['ignore', { ignore: ['azure'] }, 'ignore'],
    ['sort price', { sort: 'price' }, 'sort'],
    ['sort speed', { sort: 'speed' }, 'sort'],
    ['quantizations', { quantizations: ['fp8'] }, 'quantizations'],
    ['min quantization', { minQuantization: 'int8' }, 'minQuantization'],
    ['max price prompt', { maxPrice: { prompt: 1, completion: null } }, 'maxPrice'],
    ['max price completion', { maxPrice: { prompt: null, completion: 3 } }, 'maxPrice'],
    ['max price zero', { maxPrice: { prompt: 0, completion: null } }, 'maxPrice'],
    ['no fallbacks', { allowFallbacks: false }, 'allowFallbacks'],
    ['require parameters', { requireParameters: true }, 'requireParameters'],
    ['preferred latency', { preferredMaxLatency: 2 }, 'preferredMaxLatency'],
    ['preferred throughput', { preferredMinThroughput: 40 }, 'preferredMinThroughput'],
    ['caching route', { cachingRoute: true }, 'cachingRoute'],
];

describe('hasExplicitRouting', () => {
    it.each(SINGLE_SETTINGS)('is true for %s', (_name, patch) => {
        expect(hasExplicitRouting(routing(patch))).toBe(true);
    });

    it.each(SINGLE_SETTINGS)('is false for %s while routing is disabled', (_name, patch) => {
        expect(hasExplicitRouting(routing({ ...patch, enabled: false }))).toBe(false);
    });

    it('is false for the defaults, enabled or not', () => {
        expect(hasExplicitRouting(routing())).toBe(false);
        expect(hasExplicitRouting(defaultRouting())).toBe(false);
    });

    it('does not count zdr', () => {
        expect(hasExplicitRouting(routing({ zdr: true }))).toBe(false);
    });

    it('does not count allowFallbacks=true or requireParameters=false', () => {
        expect(hasExplicitRouting(routing({ allowFallbacks: true, requireParameters: false }))).toBe(false);
    });

    it('does not count empty or non-finite values', () => {
        expect(hasExplicitRouting(routing({ preferredMaxLatency: Number.NaN }))).toBe(false);
        expect(hasExplicitRouting(routing({ preferredMinThroughput: Number.POSITIVE_INFINITY }))).toBe(false);
        expect(hasExplicitRouting(routing({ maxPrice: { prompt: Number.NaN, completion: null } }))).toBe(false);
    });
});

describe('routingFields', () => {
    it.each(SINGLE_SETTINGS)('names %s', (_name, patch, field) => {
        expect(routingFields(routing(patch))).toEqual([field]);
    });

    it('is empty for the defaults and for zdr alone', () => {
        expect(routingFields(defaultRouting())).toEqual([]);
        expect(routingFields(routing({ zdr: true }))).toEqual([]);
    });

    it('lists every set field in a fixed order and never zdr', () => {
        const all = routing({
            order: ['a'],
            only: ['b'],
            ignore: ['c'],
            sort: 'latency',
            quantizations: ['fp8'],
            minQuantization: 'fp8',
            maxPrice: { prompt: 1, completion: 2 },
            allowFallbacks: false,
            requireParameters: true,
            zdr: true,
            preferredMaxLatency: 1,
            preferredMinThroughput: 2,
            cachingRoute: true,
        });
        expect(routingFields(all)).toEqual([
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
    });

    it('does not depend on the enabled flag', () => {
        expect(routingFields(routing({ enabled: false, sort: 'price' }))).toEqual(['sort']);
    });
});

describe('buildProviderObject', () => {
    it('is null when routing is disabled, even with zdr', () => {
        expect(buildProviderObject(routing({ enabled: false, order: ['a'], zdr: true }), {})).toBeNull();
        expect(buildProviderObject(routing({ enabled: false, zdr: true }), { zdrOnly: true })).toBeNull();
    });

    it('is null when there is nothing to send', () => {
        expect(buildProviderObject(routing(), {})).toBeNull();
        expect(buildProviderObject(routing({ cachingRoute: true }), {})).toBeNull(); // caching is a top-level field
        expect(buildProviderObject(routing({ maxPrice: { prompt: null, completion: null } }), {})).toBeNull();
    });

    it('maps every field to NanoGPT names', () => {
        const all = routing({
            order: ['deepinfra', 'together'],
            only: ['deepinfra'],
            ignore: ['azure'],
            sort: 'throughput',
            quantizations: ['fp8', 'bf16'],
            minQuantization: 'int8',
            maxPrice: { prompt: 0.5, completion: 2 },
            allowFallbacks: false,
            requireParameters: true,
            zdr: true,
            preferredMaxLatency: 3,
            preferredMinThroughput: 50,
            cachingRoute: true,
        });
        expect(buildProviderObject(all, {})).toEqual({
            order: ['deepinfra', 'together'],
            only: ['deepinfra'],
            ignore: ['azure'],
            sort: 'throughput',
            quantizations: ['fp8', 'bf16'],
            min_quantization: 'int8',
            max_price: { prompt: 0.5, completion: 2 },
            allow_fallbacks: false,
            require_parameters: true,
            zdr: true,
            preferred_max_latency: 3,
            preferred_min_throughput: 50,
        });
    });

    it.each([
        ['order', { order: ['a'] }, { order: ['a'] }],
        ['sort', { sort: 'price' }, { sort: 'price' }],
        ['min quantization', { minQuantization: 'fp4' }, { min_quantization: 'fp4' }],
        ['allow_fallbacks false', { allowFallbacks: false }, { allow_fallbacks: false }],
        ['require_parameters', { requireParameters: true }, { require_parameters: true }],
        ['zdr', { zdr: true }, { zdr: true }],
        ['latency', { preferredMaxLatency: 0.5 }, { preferred_max_latency: 0.5 }],
        ['throughput', { preferredMinThroughput: 20 }, { preferred_min_throughput: 20 }],
    ] as Array<[string, Partial<RoutingConfig>, Record<string, unknown>]>)('sends only %s', (_n, patch, expected) => {
        expect(buildProviderObject(routing(patch), {})).toEqual(expected);
    });

    it('omits defaults: sort default, fallbacks allowed, parameters not required, no zdr', () => {
        const obj = buildProviderObject(routing({ order: ['a'], sort: 'default' }), {});
        expect(obj).toEqual({ order: ['a'] });
        expect(obj).not.toHaveProperty('sort');
        expect(obj).not.toHaveProperty('allow_fallbacks');
        expect(obj).not.toHaveProperty('require_parameters');
        expect(obj).not.toHaveProperty('zdr');
    });

    it('lower-cases, trims and de-duplicates provider ids', () => {
        const obj = buildProviderObject(
            routing({ order: [' DeepInfra ', 'deepinfra', 'Together', ''], only: ['AZURE'], ignore: ['  '] }),
            {},
        );
        expect(obj).toEqual({ order: ['deepinfra', 'together'], only: ['azure'] });
    });

    it('omits max_price when both sides are null and sends one side alone', () => {
        expect(buildProviderObject(routing({ maxPrice: { prompt: 1, completion: null } }), {})).toEqual({
            max_price: { prompt: 1 },
        });
        expect(buildProviderObject(routing({ maxPrice: { prompt: null, completion: 4 } }), {})).toEqual({
            max_price: { completion: 4 },
        });
        expect(buildProviderObject(routing({ maxPrice: { prompt: 0, completion: 0 } }), {})).toEqual({
            max_price: { prompt: 0, completion: 0 },
        });
    });

    it('never emits data_collection', () => {
        const obj = buildProviderObject(routing({ zdr: true, order: ['a'], sort: 'price' }), {});
        expect(obj).not.toHaveProperty('data_collection');
    });

    it('with zdrOnly keeps just zdr', () => {
        const busy = routing({
            zdr: true,
            order: ['a'],
            sort: 'price',
            requireParameters: true,
            preferredMaxLatency: 1,
        });
        expect(buildProviderObject(busy, { zdrOnly: true })).toEqual({ zdr: true });
        expect(buildProviderObject(routing({ order: ['a'] }), { zdrOnly: true })).toBeNull();
    });

    it('does not share arrays with the config', () => {
        const r = routing({ order: ['a'], quantizations: ['fp8'] });
        const obj = buildProviderObject(r, {}) as { order: string[]; quantizations: string[] };
        obj.order.push('b');
        obj.quantizations.push('fp16');
        expect(r.order).toEqual(['a']);
        expect(r.quantizations).toEqual(['fp8']);
    });
});

describe('routingWarnings', () => {
    it('is empty for the defaults', () => {
        expect(routingWarnings(routing())).toEqual([]);
    });

    it('warns about a latency preference without a sort', () => {
        expect(routingWarnings(routing({ preferredMaxLatency: 2 }))).toEqual([{ code: 'routing.preferenceNeedsSort' }]);
    });

    it('warns about a throughput preference without a sort', () => {
        expect(routingWarnings(routing({ preferredMinThroughput: 30 }))).toEqual([
            { code: 'routing.preferenceNeedsSort' },
        ]);
    });

    it('does not warn when a sort is set', () => {
        expect(routingWarnings(routing({ preferredMaxLatency: 2, sort: 'latency' }))).toEqual([]);
        expect(routingWarnings(routing({ preferredMinThroughput: 30, sort: 'throughput' }))).toEqual([]);
    });

    it('warns once when both preferences lack a sort', () => {
        expect(routingWarnings(routing({ preferredMaxLatency: 2, preferredMinThroughput: 30 }))).toEqual([
            { code: 'routing.preferenceNeedsSort' },
        ]);
    });

    it('warns when only and order are both set', () => {
        expect(routingWarnings(routing({ only: ['a'], order: ['b'] }))).toEqual([{ code: 'routing.onlyAndOrder' }]);
        expect(routingWarnings(routing({ only: ['a'] }))).toEqual([]);
        expect(routingWarnings(routing({ order: ['b'] }))).toEqual([]);
    });

    it('reports both problems in a fixed order', () => {
        expect(routingWarnings(routing({ only: ['a'], order: ['b'], preferredMaxLatency: 2 }))).toEqual([
            { code: 'routing.preferenceNeedsSort' },
            { code: 'routing.onlyAndOrder' },
        ]);
    });

    it('is empty while routing is disabled', () => {
        expect(routingWarnings(routing({ enabled: false, only: ['a'], order: ['b'], preferredMaxLatency: 2 }))).toEqual(
            [],
        );
    });
});
