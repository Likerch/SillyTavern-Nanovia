import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccountDetail } from '../../src/core/account';
import { createI18n } from '../../src/core/i18n';
import type { Locale } from '../../src/core/types';
import { ACCOUNT_STRINGS } from '../../src/features/account/strings';
import {
    SPEND_RANGES,
    accountNotice,
    balanceUpdated,
    cachedShare,
    connectionRows,
    formatClock,
    formatDuration,
    formatLatency,
    formatMoment,
    formatPercent,
    formatTokens,
    formatUsd,
    keyOptionLabel,
    lookupView,
    modelRows,
    quotaBar,
    rangeBounds,
    recentRow,
    recommendedChip,
    spendCard,
    spendSourceNote,
} from '../../src/features/account/view-model';
import { usageRecord } from '../helpers/account-fake';

const i18n = createI18n(() => 'en');
i18n.register(ACCOUNT_STRINGS);
const t = i18n.t.bind(i18n);

const NOW = new Date(2026, 10, 23, 15, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 10, 23).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('strings', () => {
    it('have a Russian text for every English one, and the other way round', () => {
        const dictionary = createI18n(() => 'ru');
        dictionary.register(ACCOUNT_STRINGS);
        expect(dictionary.missingRussian()).toEqual([]);
        expect(dictionary.missingEnglish()).toEqual([]);
    });

    it('cover every key the tab asks for', () => {
        const dir = new URL('../../src/features/account/', import.meta.url);
        const keys = new Set<string>();
        for (const file of readdirSync(dir).filter((name) => /^(view|view-model|index)\.ts$/.test(name))) {
            const source = readFileSync(new URL(file, dir), 'utf8');
            for (const match of source.matchAll(/'(account\.[A-Za-z_.]+)'/g)) keys.add(match[1] as string);
        }
        // Keys built from a name: account.quota.<window>, account.range.<range>, account.billing.<outcome>, account.error.<code>.
        for (const window of ['daily', 'weekly']) keys.add(`account.quota.${window}`);
        for (const range of SPEND_RANGES) keys.add(`account.range.${range}`);
        for (const outcome of ['subscription', 'paygo', 'unknown']) keys.add(`account.billing.${outcome}`);
        for (const code of [
            'key_rejected',
            'rate_limited',
            'upstream_error',
            'upstream_unreachable',
            'upstream_timeout',
        ]) {
            keys.add(`account.error.${code}`);
        }
        const missing = [...keys].filter((key) => !i18n.has(key));
        expect(missing).toEqual([]);
        expect(keys.size).toBeGreaterThan(40);
    });
});

describe('formatting', () => {
    it('writes money with as many decimals as it needs to show something', () => {
        expect(formatUsd(null)).toBe('—');
        expect(formatUsd(Number.NaN)).toBe('—');
        expect(formatUsd(0)).toBe('$0.00');
        expect(formatUsd(12.4)).toBe('$12.40');
        expect(formatUsd(1234.5678)).toBe('$1234.57');
        expect(formatUsd(0.052)).toBe('$0.052');
        expect(formatUsd(0.0123)).toBe('$0.0123');
        expect(formatUsd(0.000345)).toBe('$0.000345');
        expect(formatUsd(0.0000004)).toBe('<$0.000001');
        expect(formatUsd(0.5)).toBe('$0.50');
        expect(formatUsd(0.1234)).toBe('$0.123');
        expect(formatUsd(-0.5)).toBe('-$0.50');
        expect(formatUsd(-12)).toBe('-$12.00');
    });

    it('shortens token counts', () => {
        expect(formatTokens(null)).toBe('—');
        expect(formatTokens(950)).toBe('950');
        expect(formatTokens(9999)).toBe('9999');
        expect(formatTokens(12_345)).toBe('12.3k');
        expect(formatTokens(2_500_000)).toBe('2.5M');
        expect(formatTokens(3_000_000)).toBe('3M');
        expect(formatTokens(4_200_000_000)).toBe('4.2B');
    });

    it('writes latency, percent and clock times', () => {
        expect(formatLatency(0)).toBe('—');
        expect(formatLatency(340)).toBe('340 ms');
        expect(formatLatency(1500)).toBe('1.5 s');
        expect(formatPercent(0.256)).toBe('26');
        expect(formatClock(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('03:04:05');
    });

    it('shows today by the clock and another day with its date', () => {
        expect(formatMoment(new Date(2026, 10, 23, 9, 5, 7).getTime(), NOW)).toBe('09:05:07');
        expect(formatMoment(new Date(2026, 10, 22, 23, 59, 1).getTime(), NOW)).toBe('22.11 23:59:01');
    });

    it('writes durations as the two largest units', () => {
        expect(formatDuration(10_000, t)).toBe('< 1 min');
        expect(formatDuration(12 * MIN, t)).toBe('12 min');
        expect(formatDuration(3 * HOUR + 20 * MIN, t)).toBe('3 h 20 min');
        expect(formatDuration(2 * 24 * HOUR + 4 * HOUR + 30 * MIN, t)).toBe('2 d 4 h');
        expect(formatDuration(24 * HOUR, t)).toBe('1 d');
        expect(formatDuration(Number.NaN, t)).toBe('< 1 min');
    });
});

describe('quota bars', () => {
    it('show used of limit, the level and when the window resets', () => {
        const bar = quotaBar('daily', { used: 2500, limit: 10_000, resetsAt: NOW + 3 * HOUR + 20 * MIN }, NOW, t);
        expect(bar).toMatchObject({
            id: 'daily',
            label: 'Daily quota (input tokens)',
            fraction: 0.25,
            level: 'ok',
            valueText: '2500 of 10k tokens (25%)',
        });
        expect(bar.resetText).toBe('resets in 3 h 20 min (at 18:20:00)');
    });

    it('turns warn near the limit and error at it', () => {
        const level = (used: number) => quotaBar('weekly', { used, limit: 100, resetsAt: null }, NOW, t).level;
        expect([level(10), level(79), level(80), level(99), level(100), level(250)]).toEqual([
            'ok',
            'ok',
            'warn',
            'warn',
            'error',
            'error',
        ]);
        expect(quotaBar('weekly', { used: 250, limit: 100, resetsAt: null }, NOW, t).fraction).toBe(1);
    });

    it('say so when there is no limit, no data, or the reset is due', () => {
        expect(quotaBar('daily', { used: 4000, limit: null, resetsAt: null }, NOW, t)).toMatchObject({
            fraction: null,
            level: 'muted',
            valueText: '4000 tokens used, no limit reported',
            resetText: null,
        });
        expect(quotaBar('daily', { used: 4, limit: 0, resetsAt: null }, NOW, t).fraction).toBeNull();
        expect(quotaBar('daily', { used: null, limit: 100, resetsAt: null }, NOW, t)).toMatchObject({
            fraction: null,
            valueText: 'no data',
        });
        expect(quotaBar('daily', { used: 1, limit: 2, resetsAt: NOW - 5 }, NOW, t).resetText).toBe('reset is due');
    });

    it('show a reset on another day with its date', () => {
        const bar = quotaBar('weekly', { used: 1, limit: 2, resetsAt: NOW + 30 * HOUR }, NOW, t);
        expect(bar.resetText).toBe('resets in 1 d 6 h (at 24.11 21:00:00)');
    });

    it("show NanoGPT's recommendation, and nothing when it says nothing", () => {
        expect(recommendedChip(null, t)).toBeNull();
        expect(recommendedChip('subscription', t)).toMatchObject({ kind: 'ok' });
        expect(recommendedChip('paygo', t)).toMatchObject({ kind: 'warn', title: expect.stringContaining('quota') });
    });
});

describe('the account notice', () => {
    function detail(patch: Partial<AccountDetail>): AccountDetail {
        return {
            state: 'ok',
            snapshot: null,
            brief: null,
            stale: false,
            error: null,
            subscriptionError: null,
            keyId: null,
            fetching: false,
            ...patch,
        };
    }
    const err = (code: string) => ({ code, message: code, status: null });

    it('has nothing to say when all is well', () => {
        expect(accountNotice(detail({}), t)).toBeNull();
    });

    it('explains a missing plugin without offering a fix', () => {
        expect(accountNotice(detail({ state: 'needs_plugin' }), t)).toMatchObject({ kind: 'info', action: null });
        expect(accountNotice(detail({ state: 'needs_plugin' }), t)?.text).toContain('plugin');
    });

    it('tells a silent plugin from a missing key, and offers the Keys tab for the key', () => {
        expect(accountNotice(detail({ state: 'plugin_down' }), t)).toMatchObject({ kind: 'error', action: null });
        const stale = detail({
            state: 'plugin_down',
            snapshot: { usdBalance: 1, nanoBalance: null, fetchedAt: NOW, subscription: null },
        });
        expect(accountNotice(stale, t)?.text).toContain('last ones');
        expect(accountNotice(detail({ state: 'no_key' }), t)).toMatchObject({ kind: 'warn', action: 'keys' });
    });

    it('words what NanoGPT said, and sends a rejected key to the Keys tab', () => {
        expect(accountNotice(detail({ state: 'error', error: err('key_rejected') }), t)).toMatchObject({
            kind: 'error',
            action: 'keys',
            text: 'NanoGPT rejected the key. Check it in the Keys tab.',
        });
        expect(accountNotice(detail({ state: 'error', error: err('rate_limited') }), t)?.action).toBeNull();
        expect(accountNotice(detail({ state: 'error', error: err('weird') }), t)?.text).toContain('(weird)');
    });

    it('warns when only the subscription could not be read', () => {
        expect(accountNotice(detail({ subscriptionError: err('rate_limited') }), t)).toMatchObject({ kind: 'warn' });
        // No subscription endpoint for a missing plugin is not worth a second message.
        expect(accountNotice(detail({ subscriptionError: err('not_installed') }), t)).toBeNull();
    });

    it('says it is reading while nothing is known, and nothing while a read is under way', () => {
        expect(accountNotice(detail({ state: 'idle' }), t)).toMatchObject({ kind: 'info' });
        expect(accountNotice(detail({ state: 'idle', fetching: true }), t)).toBeNull();
    });

    it('says when the numbers were taken, and that the last refresh failed', () => {
        expect(balanceUpdated(detail({}), NOW, t)).toBeNull();
        const brief = { usdBalance: '1.00', subscription: null, fetchedAt: NOW - HOUR };
        expect(balanceUpdated(detail({ brief }), NOW, t)).toBe('Updated 14:00:00');
        expect(balanceUpdated(detail({ brief, stale: true }), NOW, t)).toBe(
            'Updated 14:00:00 · the last refresh failed',
        );
    });

    it('labels the keys of the selector', () => {
        expect(keyOptionLabel({ id: 'a', label: 'Main', masked: 'sk-nano-…abcd', active: true }, t)).toBe(
            'Main · sk-nano-…abcd (active)',
        );
        expect(keyOptionLabel({ id: 'b', label: '', masked: 'sk-nano-…wxyz', active: false }, t)).toBe('sk-nano-…wxyz');
    });
});

describe('spend', () => {
    it('measures today from local midnight and the others back from now', () => {
        const midnight = (at: number) =>
            new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate()).getTime();
        expect(rangeBounds('today', NOW, midnight)).toEqual({ from: MIDNIGHT, to: NOW + 1 });
        expect(rangeBounds('week', NOW, midnight)).toEqual({ from: NOW - 7 * 24 * HOUR, to: NOW + 1 });
        expect(rangeBounds('month', NOW, midnight)).toEqual({ from: NOW - 30 * 24 * HOUR, to: NOW + 1 });
    });

    it('puts real cost and the equivalent side by side, apart', () => {
        const card = spendCard(
            'week',
            {
                requests: 12,
                costUsd: 0.42,
                equivalentUsd: 3.1,
                promptTokens: 120_000,
                completionTokens: 8000,
                cachedTokens: 0,
            },
            t,
        );
        expect(card).toEqual({
            id: 'week',
            title: 'Last 7 days',
            requests: '12',
            real: '$0.42',
            equivalent: '$3.10',
            tokens: '120k in · 8000 out',
            empty: false,
        });
        expect(spendCard('today', null, t)).toMatchObject({ real: '—', equivalent: '—', empty: true });
    });

    it('lists connections by name (an id the app does not know stays an id) and models as they are', () => {
        const totals = {
            requests: 2,
            costUsd: 1,
            equivalentUsd: 5,
            promptTokens: 600,
            completionTokens: 400,
            cachedTokens: 0,
        };
        const rows = connectionRows(
            [
                { connectionId: 'abc12345', ...totals },
                { connectionId: 'gone1234', ...totals },
                { connectionId: null, ...totals },
            ],
            (id) => (id === 'abc12345' ? 'Main' : null),
            t,
        );
        expect(rows.map((row) => row.name)).toEqual(['Main', 'gone1234', 'outside Nanovia']);
        expect(rows[0]).toEqual({
            key: 'abc12345',
            name: 'Main',
            requests: '2',
            real: '$1.00',
            equivalent: '$5.00',
            tokens: '1000',
        });
        expect(modelRows([{ model: 'vendor/x', ...totals }])[0]).toMatchObject({ key: 'vendor/x', name: 'vendor/x' });
    });

    it('says where the numbers come from only when the plugin is not part of them', () => {
        const summary = {
            from: 0,
            to: 1,
            total: { requests: 0, costUsd: 0, equivalentUsd: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
            byDay: [],
            byConnection: [],
            byModel: [],
        };
        expect(spendSourceNote(null, t)).toBeNull();
        expect(spendSourceNote({ summary, plugin: true, error: null }, t)).toBeNull();
        expect(
            spendSourceNote({ summary, plugin: false, error: { code: 'timeout', message: '', status: null } }, t),
        ).toContain('not answering');
        expect(
            spendSourceNote({ summary, plugin: false, error: { code: 'not_installed', message: '', status: 404 } }, t),
        ).toContain('Without the plugin');
    });
});

describe('a recent request', () => {
    const nameOf = (id: string) => (id === 'abc12345' ? 'Main' : null);

    it('shows time, connection, model, billing, both costs, tokens, cache share and latency', () => {
        const row = recentRow(
            usageRecord({
                at: NOW - HOUR,
                connectionId: 'abc12345',
                requestId: 'req-1',
                model: 'vendor/x',
                billing: 'subscription',
                costUsd: 0,
                equivalentUsd: 0.034,
                promptTokens: 2000,
                completionTokens: 300,
                cachedTokens: 1500,
                latencyMs: 2400,
            }),
            0,
            NOW,
            nameOf,
            t,
        );
        expect(row).toEqual({
            key: 'req-1',
            requestId: 'req-1',
            time: '14:00:00',
            connection: 'Main',
            model: 'vendor/x',
            billing: { label: 'subscription', kind: 'ok' },
            cost: '$0.00',
            equivalent: '$0.034',
            tokens: '2000 → 300 tokens',
            cached: '75% cached',
            latency: '2.4 s',
            error: null,
        });
    });

    it('shows a dash for an unknown cost, never a zero, and a unique key when there is no request id', () => {
        const row = recentRow(
            usageRecord({
                costUsd: null,
                equivalentUsd: null,
                billing: 'unknown',
                requestId: null,
                connectionId: null,
                cachedTokens: null,
            }),
            3,
            NOW,
            nameOf,
            t,
        );
        expect(row).toMatchObject({
            cost: '—',
            equivalent: '—',
            billing: { label: 'unknown', kind: 'muted' },
            connection: 'outside Nanovia',
            cached: null,
            requestId: null,
        });
        expect(row.key).toMatch(/-3$/);
    });

    it('flags an error by its message or by an HTTP status', () => {
        const withMessage = recentRow(usageRecord({ error: 'upstream_unreachable', status: 502 }), 0, NOW, nameOf, t);
        expect(withMessage.error).toEqual({ label: 'error', title: 'upstream_unreachable' });
        const withStatus = recentRow(usageRecord({ error: null, status: 429 }), 0, NOW, nameOf, t);
        expect(withStatus.error).toEqual({ label: 'error', title: 'HTTP 429' });
    });

    it('shows pay-as-you-go as an informational chip', () => {
        expect(recentRow(usageRecord({ billing: 'paygo' }), 0, NOW, nameOf, t).billing).toEqual({
            label: 'pay-as-you-go',
            kind: 'info',
        });
    });

    it('computes the cached share only from known numbers', () => {
        expect(cachedShare(usageRecord({ promptTokens: 200, cachedTokens: 50 }))).toBe(0.25);
        expect(cachedShare(usageRecord({ promptTokens: 0, cachedTokens: 0 }))).toBeNull();
        expect(cachedShare(usageRecord({ promptTokens: null, cachedTokens: 5 }))).toBeNull();
        expect(cachedShare(usageRecord({ promptTokens: 10, cachedTokens: 50 }))).toBe(1);
    });
});

describe('the answer to "check exact cost"', () => {
    const ok = (ready: boolean, costUsd: number | null) =>
        ({ ok: true, data: { requestId: 'r', ready, costUsd } }) as const;
    const fail = (code: string) => ({ ok: false, error: { code, message: code, status: null } }) as const;

    it('shows the figure when it is ready', () => {
        expect(lookupView(ok(true, 0.0123), t)).toEqual({ kind: 'ok', text: 'Exact cost: $0.0123' });
        expect(lookupView(ok(true, 0), t)).toEqual({ kind: 'ok', text: 'Exact cost: $0.00' });
    });

    it('never shows a figure for a request that is not ready', () => {
        expect(lookupView(ok(false, null), t)).toEqual({ kind: 'warn', text: 'Not ready yet, try again later.' });
        expect(lookupView(ok(false, 0), t).text).not.toContain('$');
    });

    it('says when NanoGPT has the charge but not in dollars', () => {
        expect(lookupView(ok(true, null), t).kind).toBe('warn');
    });

    it('explains a silent plugin, a missing key and anything else', () => {
        for (const code of ['unreachable', 'timeout', 'not_installed', 'forbidden']) {
            expect(lookupView(fail(code), t)).toEqual({ kind: 'error', text: 'The plugin is not answering.' });
        }
        expect(lookupView(fail('no_key'), t).kind).toBe('warn');
        expect(lookupView(fail('key_rejected'), t).text).toContain('(key_rejected)');
    });
});

describe('Russian', () => {
    it('reads the same data in Russian', () => {
        const ru = createI18n((): Locale => 'ru');
        ru.register(ACCOUNT_STRINGS);
        const tr = ru.t.bind(ru);
        expect(formatDuration(3 * HOUR + 20 * MIN, tr)).toBe('3 ч 20 мин');
        expect(quotaBar('daily', { used: 1, limit: 4, resetsAt: null }, NOW, tr).label).toBe(
            'Дневная квота (входные токены)',
        );
        expect(lookupView({ ok: true, data: { requestId: 'r', ready: false, costUsd: null } }, tr).text).toBe(
            'Ещё не готово, попробуйте позже.',
        );
    });
});
