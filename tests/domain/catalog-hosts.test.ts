import { describe, expect, it } from 'vitest';
import { normalizeModelProviders, scoreHosts } from '../../src/domain/catalog';
import type { ProviderEndpoint } from '../../src/shared/contracts';
import type { HostCriteria } from '../../src/shared/contracts-catalog';
import dsProviders from '../fixtures/catalog/providers.deepseek-v4.1-flash-1017.json';
import glmProviders from '../fixtures/catalog/providers.glm-5.3.json';

function host(over: Partial<ProviderEndpoint> & { id: string }): ProviderEndpoint {
    return {
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

const equal: HostCriteria = { weightPrice: 1, weightSpeed: 1, weightUptime: 1 };

// A: cheap and steady, B: dear and fast, C: reports nothing.
const A = host({
    id: 'a',
    quantization: 'fp8',
    pricing: { prompt: 1, completion: 2, cacheRead: null },
    tps: 100,
    ttftMs: 1000,
    uptime: 100,
});
const B = host({
    id: 'b',
    quantization: 'fp4',
    pricing: { prompt: 2, completion: 4, cacheRead: null },
    tps: 200,
    ttftMs: 500,
    uptime: 95,
});
const C = host({ id: 'c' });

describe('scoreHosts', () => {
    it('scores the components by the documented formulas', () => {
        const [first, second, third] = scoreHosts([A, B, C], equal);
        // A: price 3/3 = 1, speed mean(100/200, 500/1000) = 0.5, uptime (100-90)/10 = 1.
        expect(first).toEqual({
            providerId: 'a',
            rank: 1,
            total: 0.8333,
            price: 1,
            speed: 0.5,
            uptime: 1,
            missing: [],
            overMaxPrice: false,
            meetsQuantization: null,
        });
        // B: price 3/6 = 0.5, speed mean(1, 1) = 1, uptime (95-90)/10 = 0.5.
        expect(second).toMatchObject({ providerId: 'b', rank: 2, total: 0.6667, price: 0.5, speed: 1, uptime: 0.5 });
        // C reports nothing: every component is 0 and listed as missing.
        expect(third).toMatchObject({ providerId: 'c', rank: 3, total: 0, price: 0, speed: 0, uptime: 0 });
        expect(third?.missing).toEqual(['price', 'speed', 'uptime']);
    });

    it('lets the weights decide', () => {
        expect(
            scoreHosts([A, B, C], { weightPrice: 0, weightSpeed: 1, weightUptime: 0 }).map((s) => s.providerId),
        ).toEqual(['b', 'a', 'c']);
        const priceOnly = scoreHosts([B, A], { weightPrice: 5, weightSpeed: 0, weightUptime: 0 });
        expect(priceOnly.map((s) => [s.providerId, s.total])).toEqual([
            ['a', 1],
            ['b', 0.5],
        ]);
        // Weights are relative: 2:1:1 is (2*1 + 0.5 + 1) / 4 for A.
        expect(scoreHosts([A, B], { weightPrice: 2, weightSpeed: 1, weightUptime: 1 })[0]?.total).toBe(0.875);
    });

    it('uses equal weights when none is given and ignores bad weights', () => {
        const zero = scoreHosts([A, B], { weightPrice: 0, weightSpeed: 0, weightUptime: 0 });
        expect(zero.map((s) => s.total)).toEqual([0.8333, 0.6667]);
        const junk = scoreHosts([A, B], { weightPrice: Number.NaN, weightSpeed: -3, weightUptime: 1 });
        expect(junk.map((s) => [s.providerId, s.total])).toEqual([
            ['a', 1],
            ['b', 0.5],
        ]);
    });

    it('counts a partly measured speed by what is reported', () => {
        const onlyTps = host({ id: 'x', pricing: A.pricing, tps: 50 });
        const onlyTtft = host({ id: 'y', pricing: A.pricing, ttftMs: 2000 });
        const scores = scoreHosts([A, onlyTps, onlyTtft], { weightPrice: 0, weightSpeed: 1, weightUptime: 0 });
        const speedOf = (id: string) => scores.find((s) => s.providerId === id)?.speed;
        // Best tps is 100 and best ttft is 1000 (only A reports both).
        expect(speedOf('a')).toBe(1);
        expect(speedOf('x')).toBe(0.5);
        expect(speedOf('y')).toBe(0.5);
        expect(scores.find((s) => s.providerId === 'x')?.missing).toEqual(['uptime']);
    });

    it('maps uptime linearly between 90% and 100%', () => {
        const hosts = [100, 95, 90, 43, 99.5].map((uptime) => host({ id: `u${uptime}`, uptime }));
        const scores = scoreHosts(hosts, { weightPrice: 0, weightSpeed: 0, weightUptime: 1 });
        const get = (id: string) => scores.find((s) => s.providerId === id)?.uptime;
        expect([get('u100'), get('u95'), get('u90'), get('u43'), get('u99.5')]).toEqual([1, 0.5, 0, 0, 0.95]);
        expect(scores.map((s) => s.providerId)).toEqual(['u100', 'u99.5', 'u95', 'u90', 'u43']);
    });

    it('treats a free host as the best price and a dearer one against a free cheapest as 0', () => {
        const free = host({ id: 'free', pricing: { prompt: 0, completion: 0, cacheRead: null } });
        const scores = scoreHosts([A, free], { weightPrice: 1, weightSpeed: 0, weightUptime: 0 });
        expect(scores.map((s) => [s.providerId, s.price])).toEqual([
            ['free', 1],
            ['a', 0],
        ]);
    });

    it('puts hosts below the preferred precision behind, an unknown one in between', () => {
        const scores = scoreHosts([B, C, A], { ...equal, preferQuantization: 'fp8' });
        expect(scores.map((s) => [s.providerId, s.meetsQuantization])).toEqual([
            ['a', true],
            ['c', null],
            ['b', false],
        ]);
        // Without a preference (or with 'unknown') precision does not matter.
        for (const criteria of [equal, { ...equal, preferQuantization: 'unknown' as const }]) {
            expect(scoreHosts([B, C, A], criteria).map((s) => s.meetsQuantization)).toEqual([null, null, null]);
            expect(scoreHosts([B, A], criteria).map((s) => s.providerId)).toEqual(['a', 'b']);
        }
    });

    it('puts hosts over the price cap last, whatever their score', () => {
        const scores = scoreHosts([B, A, C], { ...equal, maxPrice: { prompt: 1.5, completion: null } });
        expect(scores.map((s) => [s.providerId, s.overMaxPrice])).toEqual([
            ['a', false],
            ['c', false], // no price to check against the cap
            ['b', true],
        ]);
        const both = scoreHosts([A, B], { ...equal, maxPrice: { prompt: 5, completion: 3 } });
        expect(both.map((s) => [s.providerId, s.overMaxPrice])).toEqual([
            ['a', false],
            ['b', true],
        ]);
        expect(
            scoreHosts([A, B], { ...equal, maxPrice: { prompt: null, completion: null } }).some((s) => s.overMaxPrice),
        ).toBe(false);
    });

    it('ranks the cap behind the precision preference', () => {
        const dear = host({ ...A, id: 'dear', pricing: { prompt: 9, completion: 9, cacheRead: null } });
        const low = host({ ...B, id: 'low' });
        const scores = scoreHosts([dear, low, C], {
            ...equal,
            preferQuantization: 'fp8',
            maxPrice: { prompt: 5, completion: 5 },
        });
        expect(scores.map((s) => s.providerId)).toEqual(['c', 'low', 'dear']);
    });

    it('keeps the incoming order for equal scores and copes with an empty list', () => {
        const same = scoreHosts([host({ id: 'p' }), host({ id: 'q' }), host({ id: 'r' })], equal);
        expect(same.map((s) => [s.providerId, s.rank])).toEqual([
            ['p', 1],
            ['q', 2],
            ['r', 3],
        ]);
        expect(scoreHosts([], equal)).toEqual([]);
    });

    it('ranks the hosts of a real model', () => {
        const ds = normalizeModelProviders('deepseek/deepseek-v4.1-flash-1017', dsProviders)!;
        const cheapest = Math.min(
            ...ds.providers.map((p) => (p.pricing ? p.pricing.prompt + p.pricing.completion : Infinity)),
        );
        const byPrice = scoreHosts(ds.providers, { weightPrice: 1, weightSpeed: 0, weightUptime: 0 });
        expect(byPrice).toHaveLength(ds.providers.length);
        expect(byPrice.map((s) => s.rank)).toEqual(ds.providers.map((_, i) => i + 1));
        const top = ds.providers.find((p) => p.id === byPrice[0]?.providerId);
        expect((top?.pricing?.prompt ?? 0) + (top?.pricing?.completion ?? 0)).toBe(cheapest);
        expect(byPrice[0]?.total).toBe(1);
        expect(byPrice.map((s) => s.total)).toEqual([...byPrice.map((s) => s.total)].sort((a, b) => b - a));

        const fast = scoreHosts(ds.providers, { weightPrice: 0, weightSpeed: 1, weightUptime: 0 });
        // Munito has the best latency (465 ms) and 458.7 tps against the best 593.6 (Entrim, which answers in 4963 ms):
        // mean(458.7 / 593.6, 465 / 465) = 0.8864.
        expect(fast[0]).toMatchObject({ providerId: 'munito', speed: 0.8864 });
        expect(fast[0]?.missing).not.toContain('speed');
        // Hosts with no measurement sit at the bottom, and they are flagged.
        expect(fast.at(-1)?.missing).toContain('speed');
    });

    it('applies a precision preference to a real GLM host list', () => {
        const glm = normalizeModelProviders('z-ai/glm-5.3', glmProviders)!;
        const scores = scoreHosts(glm.providers, { ...equal, preferQuantization: 'fp8' });
        const lead = scores.filter((s) => s.meetsQuantization === true).map((s) => s.providerId);
        // The hosts that reach fp8: the official Z.AI and the bf16 ones.
        expect(lead).toContain('zai');
        expect(lead).toContain('uomi');
        expect(lead).not.toContain('coreweave'); // nvfp4
        // Every host that reaches the precision is ranked before every host that does not.
        const firstBelow = scores.findIndex((s) => s.meetsQuantization !== true);
        expect(scores.slice(firstBelow).some((s) => s.meetsQuantization === true)).toBe(false);
        expect(
            scores
                .slice(0, firstBelow)
                .map((s) => s.providerId)
                .sort(),
        ).toEqual([...lead].sort());
    });
});
