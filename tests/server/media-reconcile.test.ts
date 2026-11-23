/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest';
import { createBillingReconciler, realTimers } from '../../src/server/media-billing';
import { SecretValue } from '../../src/server/secret-value';
import { cleanTempDirs } from './helpers';
import { manualTimers, startMediaStack, usageLines, type MediaStack } from './media-helpers';

const stacks: MediaStack[] = [];
async function stack(options: Parameters<typeof startMediaStack>[0] = {}): Promise<MediaStack> {
    const s = await startMediaStack(options);
    stacks.push(s);
    return s;
}
afterEach(async () => {
    for (const s of stacks.splice(0)) await s.close();
    cleanTempDirs();
});

const image = (s: MediaStack, extra: Record<string, unknown> = {}) =>
    s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'a lighthouse', size: '512x512', ...extra });
const mockState = (s: MediaStack, patch: Record<string, unknown>) =>
    fetch(`${s.origin}/__mock/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
    });
const lookups = (s: MediaStack): any[] => s.seen('/api/v1/usage/requests/');
/** Fires the oldest waiting timer and waits for the lookup it started. */
async function fire(s: MediaStack): Promise<void> {
    expect(s.clock.fire()).toBe(true);
    await s.h.app.deps.media.reconciler.idle();
}

describe('image cost reconciliation', () => {
    it('schedules a lookup about 15 s after the call and corrects the usage record with an adjust line', async () => {
        const s = await stack();
        const res = await image(s);
        // The body's figure is the list price; billing is 1.5x for this model (as seen live).
        expect(res.json['cost']).toMatchObject({ usd: 0.0017, source: 'response' });
        expect(s.clock.waiting()).toEqual([15_000]);
        expect(s.h.app.deps.media.reconciler.pending()).toBe(1);
        expect(lookups(s)).toHaveLength(0);

        await fire(s);
        expect(s.h.app.deps.media.reconciler.pending()).toBe(0);
        expect(lookups(s)).toHaveLength(1);
        expect(decodeURIComponent(lookups(s)[0].path)).toBe(`/api/v1/usage/requests/${res.json['requestId']}`);
        expect(lookups(s)[0].headers.authorization).toMatch(/^Bearer sk-nano-…/);

        // The adjust line sits next to the record, in the same file.
        const lines = usageLines(s.h.root);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ medium: 'image', costUsd: 0.0017, costSource: 'response' });
        expect(lines[1]).toEqual({
            adjust: true,
            requestId: res.json['requestId'],
            costUsd: 0.00255,
            costSource: 'lookup',
            at: expect.any(Number),
        });
    });

    it('lets GET /spend and GET /usage/recent see the corrected figure, and breaks spend down by medium', async () => {
        const s = await stack();
        await s.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'Hello there, friend.' });
        await image(s);
        const before = await s.h.api('GET', '/spend');
        expect(before.json['total']['costUsd']).toBeCloseTo(0.000034 + 0.0017, 9);
        await fire(s);
        const spend = await s.h.api('GET', '/spend');
        expect(spend.json['total']).toMatchObject({ requests: 2 });
        expect(spend.json['total']['costUsd']).toBeCloseTo(0.000034 + 0.00255, 9);
        expect(spend.json['byMedium']).toEqual([
            expect.objectContaining({ medium: 'image', requests: 1, costUsd: 0.00255, equivalentUsd: 0.00255 }),
            expect.objectContaining({ medium: 'tts', requests: 1, costUsd: 0.000034 }),
        ]);
        const recent = await s.h.api('GET', '/usage/recent');
        const imageRecord = recent.json['records'].find((r: any) => r.medium === 'image');
        expect(imageRecord).toMatchObject({ costUsd: 0.00255, costSource: 'lookup', equivalentUsd: 0.00255, units: 1 });
        expect(recent.json['records'].find((r: any) => r.medium === 'tts')).toMatchObject({ costSource: 'estimate' });
    });

    it('retries with growing pauses while NanoGPT says "not ready yet", then corrects', async () => {
        const s = await stack();
        await mockState(s, { billingMisses: 2 });
        const res = await image(s);
        await fire(s);
        expect(s.clock.waiting()).toEqual([30_000]);
        expect(usageLines(s.h.root)).toHaveLength(1);
        await fire(s);
        expect(s.clock.waiting()).toEqual([60_000]);
        await fire(s);
        expect(s.clock.waiting()).toEqual([]);
        expect(s.clock.asked()).toEqual([15_000, 30_000, 60_000]);
        expect(lookups(s).map((e) => e.status)).toEqual([404, 404, 200]);
        expect(usageLines(s.h.root)[1]).toMatchObject({
            adjust: true,
            requestId: res.json['requestId'],
            costUsd: 0.00255,
        });
    });

    it('gives up after the last pause and leaves the response figure', async () => {
        const s = await stack();
        await mockState(s, { billingMisses: 99 });
        await image(s);
        for (let i = 0; i < 5; i += 1) await fire(s);
        expect(s.clock.fire()).toBe(false);
        expect(s.clock.asked()).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
        expect(s.h.app.deps.media.reconciler.pending()).toBe(0);
        expect(usageLines(s.h.root)).toHaveLength(1);
        expect(s.h.logs.some((line) => line.includes('gave no figure'))).toBe(true);
        expect((await s.h.api('GET', '/spend')).json['total']['costUsd']).toBe(0.0017);
    });

    it('retries after trouble reaching NanoGPT, gives up on a refused key or another currency', async () => {
        const real = globalThis.fetch as any;
        let plan: 'down-then-ok' | 'unauthorized' | 'xno' | 'ok' = 'ok';
        let lookupCalls = 0;
        const s = await stack({
            fetch: ((url: string, init: any) => {
                if (!url.includes('/api/v1/usage/requests/')) return real(url, init);
                lookupCalls += 1;
                if (plan === 'down-then-ok' && lookupCalls === 1) return Promise.reject(new Error('socket hang up'));
                if (plan === 'unauthorized') return Promise.resolve(new Response('{}', { status: 401 }));
                if (plan === 'xno')
                    return Promise.resolve(new Response(JSON.stringify({ cost: '0.5', currency: 'XNO' })));
                return real(url, init);
            }) as any,
        });
        plan = 'down-then-ok';
        await image(s);
        await fire(s);
        expect(s.clock.waiting()).toEqual([30_000]);
        await fire(s);
        expect(usageLines(s.h.root).filter((l) => l['adjust'])).toHaveLength(1);

        plan = 'unauthorized';
        await image(s);
        await fire(s);
        expect(s.clock.waiting()).toEqual([]);
        plan = 'xno';
        await image(s);
        await fire(s);
        expect(s.clock.waiting()).toEqual([]);
        expect(usageLines(s.h.root).filter((l) => l['adjust'])).toHaveLength(1);
    });

    it('does not reconcile what has no request id, and forgets everything when the plugin stops', async () => {
        const s = await stack();
        await s.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x' });
        expect(s.clock.waiting()).toEqual([]);
        await image(s);
        expect(s.clock.waiting()).toEqual([15_000]);
        await s.h.app.close();
        expect(s.clock.waiting()).toEqual([]);
        expect(s.h.app.deps.media.reconciler.pending()).toBe(0);
        // A schedule after the stop is ignored.
        s.h.app.deps.media.reconciler.schedule({
            userRoot: s.h.root,
            key: new SecretValue('sk-nano-x'),
            requestId: 'r',
            recordAt: 1,
        });
        expect(s.h.app.deps.media.reconciler.pending()).toBe(0);
    });

    it('never leaks the key: only the Authorization header carries it', async () => {
        const s = await stack();
        await image(s);
        await fire(s);
        expect(JSON.stringify(usageLines(s.h.root))).not.toContain('KEYTAIL');
        expect(s.h.logs.join('\n')).not.toContain('KEYTAIL');
    });
});

describe('the reconciler on its own', () => {
    function make(responses: (() => Promise<Response> | Response)[], delaysMs?: number[]) {
        const clock = manualTimers();
        const adjusted: any[] = [];
        let calls = 0;
        const reconciler = createBillingReconciler({
            env: {
                mediaBase: 'http://nano.test',
                version: 't',
                fetch: (async () => {
                    const next = responses[Math.min(calls, responses.length - 1)];
                    calls += 1;
                    if (!next) throw new Error('no response');
                    const res = await next();
                    return res;
                }) as any,
            },
            usage: {
                append: async () => {},
                adjust: async (_root, at, adjustment) => void adjusted.push({ at, adjustment }),
                read: async () => [],
            },
            log: { info: () => {}, warn: () => {}, error: () => {} },
            now: () => 4242,
            timers: clock.timers,
            timeoutMs: 1000,
            ...(delaysMs ? { delaysMs } : {}),
        });
        return { clock, adjusted, reconciler, calls: () => calls };
    }
    const ok = (cost: string) => () => new Response(JSON.stringify({ cost, currency: 'USD' }), { status: 200 });
    const job = { userRoot: '/u', key: new SecretValue('sk-nano-k'), requestId: 'media-image:a/b', recordAt: 99 };

    it('uses the injected delays, encodes the id and writes the adjustment against the record time', async () => {
        const t = make([ok('0.5')], [1, 2]);
        t.reconciler.schedule(job);
        expect(t.clock.waiting()).toEqual([1]);
        t.clock.fire();
        await t.reconciler.idle();
        expect(t.adjusted).toEqual([
            {
                at: 99,
                adjustment: {
                    adjust: true,
                    requestId: 'media-image:a/b',
                    costUsd: 0.5,
                    costSource: 'lookup',
                    at: 4242,
                },
            },
        ]);
    });

    it('retries 408, 425, 429 and 5xx, and stops on anything else', async () => {
        const status = (code: number) => () => new Response('{}', { status: code });
        for (const code of [408, 425, 429, 500, 503]) {
            const t = make([status(code), ok('1')]);
            t.reconciler.schedule(job);
            t.clock.fire();
            await t.reconciler.idle();
            expect(t.clock.waiting().length, String(code)).toBe(1);
        }
        for (const code of [400, 401, 403, 409]) {
            const t = make([status(code)]);
            t.reconciler.schedule(job);
            t.clock.fire();
            await t.reconciler.idle();
            expect(t.clock.waiting(), String(code)).toEqual([]);
            expect(t.reconciler.pending()).toBe(0);
        }
        const junk = make([() => new Response('not json', { status: 200 }), ok('1')]);
        junk.reconciler.schedule(job);
        junk.clock.fire();
        await junk.reconciler.idle();
        expect(junk.clock.waiting().length).toBe(1);
    });

    it('keeps going when the usage log fails and falls back to the default delays', async () => {
        const clock = manualTimers();
        const reconciler = createBillingReconciler({
            env: {
                mediaBase: 'http://nano.test',
                version: 't',
                fetch: (async () => new Response(JSON.stringify({ cost: '1' }))) as any,
            },
            usage: {
                append: async () => {},
                adjust: async () => {
                    throw new Error('disk full');
                },
                read: async () => [],
            },
            log: { info: () => {}, warn: () => {}, error: () => {} },
            now: () => 1,
            timers: clock.timers,
            timeoutMs: 1000,
            delaysMs: [],
        });
        reconciler.schedule(job);
        expect(clock.waiting()).toEqual([15_000]);
        clock.fire();
        await reconciler.idle();
        expect(reconciler.pending()).toBe(0);
    });

    it('has real timers that do not hold the process open', () => {
        const handle = realTimers.set(() => {}, 60_000) as { hasRef?: () => boolean };
        expect(handle.hasRef?.()).toBe(false);
        realTimers.clear(handle);
    });
});
