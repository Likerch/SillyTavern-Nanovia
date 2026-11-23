import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus';
import { addTotals, createUsageStore, emptyTotals, localMidnight, mergeSummaries } from '../../src/core/usage';
import type { UsageStore } from '../../src/core/usage';
import type { PluginAccount, PluginError } from '../../src/host';
import type { UsageTotals } from '../../src/shared/contracts';
import type { MediumUsage, UsageSummary } from '../../src/shared/contracts-account';
import { usageRecord } from '../helpers/account-fake';
import { memoryLogger } from '../helpers/fakes';

/** Waits for pending microtasks and timers. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const NOW = new Date(2026, 10, 23, 15, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 10, 23).getTime();
const HOUR = 3_600_000;

function totals(requests: number, costUsd: number, equivalentUsd: number, tokens = 0): UsageTotals {
    return { requests, costUsd, equivalentUsd, promptTokens: tokens, completionTokens: 0, cachedTokens: 0 };
}

function summary(total: UsageTotals, patch: Partial<UsageSummary> = {}): UsageSummary {
    return { from: MIDNIGHT, to: NOW, total, byDay: [], byConnection: [], byModel: [], ...patch };
}

function down(code = 'unreachable'): PluginError {
    return { code, message: code, status: null };
}

interface Rig {
    store: UsageStore;
    bus: ReturnType<typeof createBus>;
    spend: ReturnType<typeof vi.fn<PluginAccount['spend']>>;
    recent: ReturnType<typeof vi.fn<NonNullable<PluginAccount['recent']>>>;
    plugin: { up: boolean; checked: boolean; error: PluginError | null };
    setNow(value: number): void;
}

function rig(options: { ringSize?: number; staleMs?: number } = {}): Rig {
    let t = NOW;
    const log = memoryLogger();
    const bus = createBus(log);
    const plugin = { up: true, checked: true, error: null as PluginError | null };
    const spend = vi.fn<PluginAccount['spend']>(async () => ({ ok: true, data: summary(totals(0, 0, 0)) }));
    const recent = vi.fn<NonNullable<PluginAccount['recent']>>(async () => ({ ok: true, data: [] }));
    const store = createUsageStore({
        bus,
        account: { spend, recent },
        connections: { pluginUp: () => plugin.up, checked: () => plugin.checked, pluginError: () => plugin.error },
        log,
        now: () => t,
        ...options,
    });
    return { store, bus, spend, recent, plugin, setNow: (value) => void (t = value) };
}

let r: Rig;

beforeEach(() => {
    r = rig();
});

afterEach(() => {
    r.store.dispose();
    vi.useRealTimers();
});

describe('the ring', () => {
    it('keeps the latest records, newest first', async () => {
        r.store.dispose();
        r = rig({ ringSize: 3 });
        for (let i = 1; i <= 5; i++)
            await r.bus.emit('usage:record', { record: usageRecord({ at: NOW + i, model: `m${i}` }) });
        expect(r.store.recent().map((record) => record.model)).toEqual(['m5', 'm4', 'm3']);
        expect(r.store.recent(2).map((record) => record.model)).toEqual(['m5', 'm4']);
        expect(r.store.recent(0)).toEqual([]);
    });

    it('holds 300 records by default', async () => {
        for (let i = 0; i < 320; i++) await r.bus.emit('usage:record', { record: usageRecord({ at: NOW - 1000 + i }) });
        expect(r.store.recent(1000)).toHaveLength(300);
    });

    it('hands out copies', async () => {
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, model: 'orig' }) });
        const [copy] = r.store.recent(1);
        if (copy) copy.model = 'changed';
        expect(r.store.recent(1)[0]?.model).toBe('orig');
    });

    it('drops a request id it has already seen, but keeps records without one', async () => {
        const seen = vi.fn();
        r.store.onRecord(seen);
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, requestId: 'a', costUsd: 1 }) });
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, requestId: 'a', costUsd: 1 }) });
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, requestId: null, costUsd: 1 }) });
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, requestId: null, costUsd: 1 }) });
        expect(seen).toHaveBeenCalledTimes(3);
        expect(r.store.recent()).toHaveLength(3);
        expect(r.store.today().costUsd).toBe(3);
    });

    it('forgets the id of a record that left the ring', async () => {
        r.store.dispose();
        r = rig({ ringSize: 1 });
        await r.bus.emit('usage:record', { record: usageRecord({ requestId: 'a' }) });
        await r.bus.emit('usage:record', { record: usageRecord({ requestId: 'b' }) });
        await r.bus.emit('usage:record', { record: usageRecord({ requestId: 'a' }) });
        expect(r.store.recent().map((record) => record.requestId)).toEqual(['a']);
    });

    it('ignores what is not a record', async () => {
        const seen = vi.fn();
        r.store.onRecord(seen);
        await r.bus.emit('usage:record', { record: null as never });
        await r.bus.emit('usage:record', { record: { model: 'x' } as never });
        expect(seen).not.toHaveBeenCalled();
        expect(r.store.recent()).toEqual([]);
    });

    it('lets a listener unsubscribe, and survives one that throws', async () => {
        const good = vi.fn();
        r.store.onRecord(() => {
            throw new Error('boom');
        });
        const off = r.store.onRecord(good);
        await r.bus.emit('usage:record', { record: usageRecord({ requestId: 'x' }) });
        off();
        await r.bus.emit('usage:record', { record: usageRecord({ requestId: 'y' }) });
        expect(good).toHaveBeenCalledOnce();
    });
});

describe('today()', () => {
    it('keeps real cost and the pay-as-you-go equivalent apart', async () => {
        await r.bus.emit('usage:record', {
            record: usageRecord({
                at: NOW - 10,
                billing: 'subscription',
                costUsd: 0,
                equivalentUsd: 0.4,
                promptTokens: 1000,
                cachedTokens: 600,
            }),
        });
        await r.bus.emit('usage:record', {
            record: usageRecord({
                at: NOW - 5,
                billing: 'paygo',
                costUsd: 0.1,
                equivalentUsd: 0.1,
                promptTokens: 10,
                completionTokens: 5,
            }),
        });
        expect(r.store.today()).toEqual({
            requests: 2,
            costUsd: 0.1,
            equivalentUsd: 0.5,
            promptTokens: 1010,
            completionTokens: 55,
            cachedTokens: 600,
        });
    });

    it('counts only today (local midnight), even past the ring', async () => {
        r.store.dispose();
        r = rig({ ringSize: 2 });
        await r.bus.emit('usage:record', { record: usageRecord({ at: MIDNIGHT - 1, costUsd: 5 }) });
        for (let i = 0; i < 4; i++)
            await r.bus.emit('usage:record', { record: usageRecord({ at: NOW + i, costUsd: 1 }) });
        expect(r.store.recent(10)).toHaveLength(2);
        expect(r.store.today()).toMatchObject({ requests: 4, costUsd: 4 });
    });

    it('starts again at midnight', async () => {
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, costUsd: 2 }) });
        expect(r.store.today().costUsd).toBe(2);
        r.setNow(MIDNIGHT + 24 * HOUR + 1000);
        expect(r.store.today()).toEqual(emptyTotals());
    });

    it('is a fresh object each time', () => {
        const first = r.store.today();
        first.requests = 99;
        expect(r.store.today().requests).toBe(0);
    });
});

describe('the plugin side', () => {
    it("loads today's summary from local midnight to now and adds what the browser saw", async () => {
        r.spend.mockResolvedValue({ ok: true, data: summary(totals(10, 1.5, 4, 5000)) });
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW - 1, costUsd: 0.25, equivalentUsd: 0.25 }) });
        await r.store.refresh();
        expect(r.spend).toHaveBeenCalledWith({ from: MIDNIGHT, to: NOW + 1 });
        expect(r.store.today()).toMatchObject({ requests: 11, costUsd: 1.75, equivalentUsd: 4.25, promptTokens: 5100 });
        expect(r.store.state()).toMatchObject({ pluginLoaded: true, stale: false, error: null, fetchedAt: NOW });
    });

    it('does not ask while the plugin is known to be down', async () => {
        r.plugin.up = false;
        r.plugin.error = down();
        await r.store.refresh();
        expect(r.spend).not.toHaveBeenCalled();
        expect(r.store.state()).toMatchObject({ pluginLoaded: false, stale: false, error: { code: 'unreachable' } });
    });

    it('asks when the plugin has never been asked about', async () => {
        r.plugin.up = false;
        r.plugin.checked = false;
        await r.store.refresh();
        expect(r.spend).toHaveBeenCalledOnce();
    });

    it('keeps the last good numbers and says they are stale when a call fails', async () => {
        r.spend.mockResolvedValueOnce({ ok: true, data: summary(totals(3, 0.3, 0.9)) });
        await r.store.refresh();
        r.spend.mockResolvedValueOnce({ ok: false, error: down('timeout') });
        await r.store.refresh();
        expect(r.store.today()).toMatchObject({ requests: 3, costUsd: 0.3 });
        expect(r.store.state()).toMatchObject({ pluginLoaded: true, stale: true, error: { code: 'timeout' } });
        r.spend.mockResolvedValueOnce({ ok: true, data: summary(totals(4, 0.4, 1)) });
        await r.store.refresh();
        expect(r.store.state()).toMatchObject({ stale: false, error: null });
        expect(r.store.today().requests).toBe(4);
    });

    it("forgets yesterday's plugin numbers after midnight", async () => {
        r.spend.mockResolvedValue({ ok: true, data: summary(totals(3, 0.3, 0.9)) });
        await r.store.refresh();
        r.setNow(MIDNIGHT + 24 * HOUR + 5);
        r.plugin.up = false;
        expect(r.store.today()).toEqual(emptyTotals());
        expect(r.store.state().pluginLoaded).toBe(false);
    });

    it('shares one call between concurrent refreshes', async () => {
        await Promise.all([r.store.refresh(), r.store.refresh(), r.store.refresh()]);
        expect(r.spend).toHaveBeenCalledOnce();
    });

    it('survives a spend call that throws', async () => {
        r.spend.mockRejectedValueOnce(new Error('boom'));
        await expect(r.store.refresh()).resolves.toBeUndefined();
    });

    it('tells listeners when its numbers changed', async () => {
        const changed = vi.fn();
        r.store.onChange(changed);
        await r.store.refresh();
        await r.bus.emit('usage:record', { record: usageRecord({ requestId: 'z' }) });
        expect(changed).toHaveBeenCalledTimes(2);
    });
});

describe('polling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('never polls while nobody watches', async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(r.spend).not.toHaveBeenCalled();
    });

    it('loads at once when watching starts, then every 30 s', async () => {
        const stop = r.store.watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(r.spend).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(r.spend).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(r.spend).toHaveBeenCalledTimes(4);
        stop();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(r.spend).toHaveBeenCalledTimes(4);
    });

    it('shares the timer between watchers and stops with the last one', async () => {
        const first = r.store.watch();
        const second = r.store.watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(r.spend).toHaveBeenCalledTimes(1);
        first();
        first();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(r.spend).toHaveBeenCalledTimes(2);
        second();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(r.spend).toHaveBeenCalledTimes(2);
    });

    it('does not poll a plugin that is down, and picks it up again when it is back', async () => {
        r.plugin.up = false;
        r.plugin.error = down();
        const stop = r.store.watch();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(r.spend).not.toHaveBeenCalled();
        r.plugin.up = true;
        r.plugin.error = null;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(r.spend).toHaveBeenCalledTimes(1);
        stop();
    });

    it('dispose stops the timer', async () => {
        r.store.watch();
        await vi.advanceTimersByTimeAsync(0);
        r.store.dispose();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(r.spend).toHaveBeenCalledTimes(1);
    });
});

describe('today() keeps the plugin part fresh by itself', () => {
    it('asks at most once a minute, and not while the plugin is down', async () => {
        r.store.today();
        r.store.today();
        await settle();
        expect(r.spend).toHaveBeenCalledTimes(1);
        r.setNow(NOW + 30_000);
        r.store.today();
        expect(r.spend).toHaveBeenCalledTimes(1);
        r.setNow(NOW + 61_000);
        r.store.today();
        expect(r.spend).toHaveBeenCalledTimes(2);
        await settle();
        expect(r.store.state().fetchedAt).toBe(NOW + 61_000);
        r.plugin.up = false;
        r.setNow(NOW + 200_000);
        r.store.today();
        expect(r.spend).toHaveBeenCalledTimes(2);
    });

    it('does not interfere with polling', async () => {
        vi.useFakeTimers();
        const stop = r.store.watch();
        await vi.advanceTimersByTimeAsync(0);
        r.setNow(NOW + 120_000);
        r.store.today();
        expect(r.spend).toHaveBeenCalledTimes(1);
        stop();
    });
});

describe('summary()', () => {
    const modelRow = (model: string, c: number, e: number) => ({ model, ...totals(1, c, e) });

    it('adds the browser own records to the plugin log, by connection and by model', async () => {
        r.spend.mockResolvedValue({
            ok: true,
            data: summary(totals(2, 1, 3), {
                byConnection: [{ connectionId: 'conn000001', ...totals(2, 1, 3) }],
                byModel: [modelRow('a', 1, 3), modelRow('b', 0, 0)],
            }),
        });
        await r.bus.emit('usage:record', {
            record: usageRecord({
                at: NOW - 100,
                connectionId: 'conn000002',
                model: 'a',
                costUsd: 0.5,
                equivalentUsd: 0.5,
            }),
        });
        const result = await r.store.summary({ from: MIDNIGHT, to: NOW + 1 });
        expect(result.plugin).toBe(true);
        expect(result.error).toBeNull();
        expect(result.summary.total).toMatchObject({ requests: 3, costUsd: 1.5, equivalentUsd: 3.5 });
        expect(result.summary.byConnection.map((row) => [row.connectionId, row.costUsd])).toEqual([
            ['conn000001', 1],
            ['conn000002', 0.5],
        ]);
        expect(result.summary.byModel.map((row) => [row.model, row.costUsd])).toEqual([
            ['a', 1.5],
            ['b', 0],
        ]);
    });

    it('passes the connection filter to the plugin and applies it to the browser records too', async () => {
        await r.bus.emit('usage:record', {
            record: usageRecord({ at: NOW - 3, connectionId: 'conn000001', costUsd: 1 }),
        });
        await r.bus.emit('usage:record', {
            record: usageRecord({ at: NOW - 2, connectionId: 'conn000002', costUsd: 2 }),
        });
        const result = await r.store.summary({ from: MIDNIGHT, to: NOW + 1 }, 'conn000002');
        expect(r.spend).toHaveBeenCalledWith({ from: MIDNIGHT, to: NOW + 1 }, 'conn000002');
        expect(result.summary.total).toMatchObject({ requests: 1, costUsd: 2 });
    });

    it('falls back to what the browser saw when the plugin fails, and says why', async () => {
        r.spend.mockResolvedValue({ ok: false, error: down('timeout') });
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW - 3, costUsd: 1 }) });
        const result = await r.store.summary({ from: MIDNIGHT, to: NOW + 1 });
        expect(result.plugin).toBe(false);
        expect(result.error?.code).toBe('timeout');
        expect(result.summary.total).toMatchObject({ requests: 1, costUsd: 1 });
    });

    it('does not ask a plugin that is known to be down', async () => {
        r.plugin.up = false;
        r.plugin.error = down('not_installed');
        const result = await r.store.summary({ from: MIDNIGHT, to: NOW + 1 });
        expect(r.spend).not.toHaveBeenCalled();
        expect(result).toMatchObject({ plugin: false, error: { code: 'not_installed' } });
    });

    it('survives a call that throws', async () => {
        r.spend.mockRejectedValue(new Error('boom'));
        const result = await r.store.summary({ from: 0, to: 1 });
        expect(result.plugin).toBe(false);
        expect(result.error).not.toBeNull();
    });
});

describe('ingest()', () => {
    it('shows the plugin records and counts them in today only while its summary is missing', async () => {
        r.spend.mockResolvedValue({ ok: true, data: summary(totals(7, 7, 7)) });
        r.store.ingest([
            usageRecord({ at: NOW - 20, requestId: 'p1', costUsd: 2 }),
            usageRecord({ at: NOW - 30, requestId: 'p2', costUsd: 1 }),
        ]);
        expect(r.store.recent().map((record) => record.requestId)).toEqual(['p1', 'p2']);
        expect(r.store.today().costUsd).toBe(3);
        await r.store.refresh();
        expect(r.store.today().costUsd).toBe(7);
    });

    it('keeps the ring in time order and drops duplicates of what the browser saw', async () => {
        await r.bus.emit('usage:record', { record: usageRecord({ at: NOW, requestId: 'b1' }) });
        r.store.ingest([usageRecord({ at: NOW - 100, requestId: 'p1' }), usageRecord({ at: NOW, requestId: 'b1' })]);
        expect(r.store.recent().map((record) => record.requestId)).toEqual(['b1', 'p1']);
    });

    it('announces only what is new', () => {
        const seen = vi.fn();
        const changed = vi.fn();
        r.store.onRecord(seen);
        r.store.onChange(changed);
        r.store.ingest([usageRecord({ requestId: 'p1' })]);
        r.store.ingest([usageRecord({ requestId: 'p1' })]);
        expect(seen).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalledOnce();
    });
});

describe('a record whose cost the plugin corrected later (stage 0.7)', () => {
    const response = (patch = {}) =>
        usageRecord({
            at: NOW - 100,
            requestId: 'img-1',
            medium: 'image',
            units: 1,
            costUsd: 0.0017,
            costSource: 'response',
            ...patch,
        });
    const lookup = () => response({ costUsd: 0.00255, equivalentUsd: 0.00255, costSource: 'lookup' });

    it('replaces the record in the list, announces nothing new and says the numbers changed', () => {
        r.store.ingest([response()]);
        const seen = vi.fn();
        const changed = vi.fn();
        r.store.onRecord(seen);
        r.store.onChange(changed);
        r.store.ingest([lookup()]);
        expect(r.store.recent()).toHaveLength(1);
        expect(r.store.recent()[0]).toMatchObject({ costUsd: 0.00255, costSource: 'lookup' });
        expect(seen).not.toHaveBeenCalled();
        expect(changed).toHaveBeenCalledOnce();
    });

    it('fixes today while the plugin summary is missing, without counting the request twice', () => {
        r.store.ingest([response({ equivalentUsd: 0.0017 })]);
        expect(r.store.today()).toMatchObject({ requests: 1, costUsd: 0.0017, equivalentUsd: 0.0017 });
        r.store.ingest([lookup()]);
        expect(r.store.today()).toMatchObject({ requests: 1, costUsd: 0.00255, equivalentUsd: 0.00255 });
    });

    it('leaves a confirmed record alone and treats any other repeat as a duplicate', () => {
        r.store.ingest([lookup()]);
        const changed = vi.fn();
        r.store.onChange(changed);
        r.store.ingest([response()]);
        r.store.ingest([lookup()]);
        expect(r.store.recent()[0]).toMatchObject({ costUsd: 0.00255, costSource: 'lookup' });
        expect(changed).not.toHaveBeenCalled();
    });

    it('never rewrites what the browser itself saw', async () => {
        await r.bus.emit('usage:record', { record: response() });
        r.store.ingest([lookup()]);
        expect(r.store.recent()[0]).toMatchObject({ costUsd: 0.0017 });
    });
});

describe('the spend by kind of request (stage 0.7)', () => {
    const medium = (name: MediumUsage['medium'], requests: number, cost: number): MediumUsage => ({
        medium: name,
        ...totals(requests, cost, cost),
    });

    it('is merged by medium, heaviest first, and absent when neither side has it', () => {
        const a = summary(totals(2, 1, 1)) as UsageSummary;
        const b = summary(totals(1, 3, 3)) as UsageSummary;
        expect(mergeSummaries(a, b)).not.toHaveProperty('byMedium');
        a.byMedium = [medium('chat', 2, 1), medium('image', 1, 0.5)];
        b.byMedium = [medium('image', 2, 0.25), medium('tts', 1, 3)];
        const merged = mergeSummaries(a, b) as UsageSummary;
        expect(merged.byMedium).toEqual([medium('tts', 1, 3), medium('chat', 2, 1), medium('image', 3, 0.75)]);
        // One side alone still shows.
        expect((mergeSummaries(a, summary(totals(0, 0, 0))) as { byMedium?: unknown[] }).byMedium).toHaveLength(2);
    });
});

describe('merging', () => {
    it('adds totals without float noise', () => {
        expect(addTotals(totals(1, 0.1, 0.2), totals(2, 0.2, 0.1))).toMatchObject({
            requests: 3,
            costUsd: 0.3,
            equivalentUsd: 0.3,
        });
    });

    it('finds local midnight', () => {
        expect(localMidnight(NOW)).toBe(MIDNIGHT);
        expect(localMidnight(MIDNIGHT)).toBe(MIDNIGHT);
    });

    it('merges two summaries by day, connection and model, heaviest first', () => {
        const a = summary(totals(2, 1, 1), {
            from: 10,
            to: 20,
            byDay: [{ day: '2026-11-22', ...totals(2, 1, 1) }],
            byConnection: [{ connectionId: null, ...totals(2, 1, 1) }],
        });
        const b = summary(totals(1, 3, 3), {
            from: 5,
            to: 15,
            byDay: [
                { day: '2026-11-21', ...totals(0, 0, 0) },
                { day: '2026-11-22', ...totals(1, 3, 3) },
            ],
            byConnection: [{ connectionId: 'abc12345', ...totals(1, 3, 3) }],
        });
        const merged = mergeSummaries(a, b);
        expect(merged).toMatchObject({ from: 5, to: 20, total: { requests: 3, costUsd: 4 } });
        expect(merged.byDay.map((row) => [row.day, row.costUsd])).toEqual([
            ['2026-11-21', 0],
            ['2026-11-22', 4],
        ]);
        expect(merged.byConnection.map((row) => row.connectionId)).toEqual(['abc12345', null]);
    });
});

describe("the plugin's recent requests", () => {
    it('shows them in the list without counting them twice in today', async () => {
        r.spend.mockResolvedValue({ ok: true, data: summary(totals(2, 0.5, 0.5)) });
        r.recent.mockResolvedValue({
            ok: true,
            data: [
                usageRecord({ at: NOW - 1, requestId: 'b', costUsd: 0.25 }),
                usageRecord({ at: NOW - 2, requestId: 'a', costUsd: 0.25 }),
            ],
        });
        await r.store.refresh();
        expect(r.store.recent().map((rec) => rec.requestId)).toEqual(['b', 'a']);
        expect(r.store.today()).toMatchObject({ requests: 2, costUsd: 0.5 });
    });

    it('asks only for what is newer than the last record it took', async () => {
        r.recent.mockResolvedValueOnce({ ok: true, data: [usageRecord({ at: NOW - 5, requestId: 'a' })] });
        await r.store.refresh();
        expect(r.recent).toHaveBeenLastCalledWith({ limit: 50, since: null });
        r.recent.mockResolvedValueOnce({ ok: true, data: [usageRecord({ at: NOW - 1, requestId: 'b' })] });
        await r.store.refresh();
        expect(r.recent).toHaveBeenLastCalledWith({ limit: 50, since: NOW - 5 });
        expect(r.store.recent().map((rec) => rec.requestId)).toEqual(['b', 'a']);
    });

    it('does not take a record twice, and keeps going when the call fails', async () => {
        r.recent.mockResolvedValueOnce({ ok: true, data: [usageRecord({ at: NOW - 5, requestId: 'a' })] });
        await r.store.refresh();
        r.recent.mockResolvedValueOnce({ ok: true, data: [usageRecord({ at: NOW - 5, requestId: 'a' })] });
        await r.store.refresh();
        expect(r.store.recent()).toHaveLength(1);
        r.recent.mockResolvedValueOnce({ ok: false, error: down('boom') });
        await r.store.refresh();
        expect(r.store.recent()).toHaveLength(1);
        expect(r.store.state().stale).toBe(false);
    });

    it('works with an account that has no recent call', async () => {
        const bare = createUsageStore({
            bus: createBus(memoryLogger()),
            account: { spend: r.spend },
            connections: { pluginUp: () => true, checked: () => true, pluginError: () => null },
            log: memoryLogger(),
            now: () => NOW,
        });
        await bare.refresh();
        expect(bare.recent()).toEqual([]);
    });
});
