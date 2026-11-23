// The Account tab without the DOM: money and token formatting, quota bars, the notice about the account's state, spend
// cards and breakdown rows, and one line of the recent-requests list. Pure functions of their arguments (the clock and
// the translator come in), so they are tested directly; view.ts only draws what they return.
import type { AccountDetail } from '../../core/account';
import { stateOfError } from '../../core/account';
import type { I18nParams } from '../../core/types';
import type { SpendResult } from '../../core/usage';
import type { MediumSpendRow, PluginError, PluginResult } from '../../host';
import type { BillingOutcome, KeyInfo, UsageRecord, UsageTotals } from '../../shared/contracts';
import type { ConnectionUsage, ModelUsage, QuotaWindow, RequestCostLookup } from '../../shared/contracts-account';
import type { ChipKind } from '../../ui';

export type Translate = (key: string, params?: I18nParams) => string;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DASH = '—';

/* ---------------------------------------------------------------------------------------------- formatting */

/**
 * USD with the decimals the amount needs to show three significant digits, at least two and at most six:
 * $12.40, $0.052, $0.0123, $0.000345. A positive amount too small for six decimals reads "<$0.000001", never "$0.00".
 */
export function formatUsd(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return DASH;
    if (value === 0) return '$0.00';
    const abs = Math.abs(value);
    const decimals = abs >= 1 ? 2 : Math.min(6, Math.max(2, 2 - Math.floor(Math.log10(abs))));
    const fixed = value.toFixed(decimals).replace(/0+$/, '');
    const [whole = '0', fraction = ''] = fixed.split('.');
    if (/^-?0$/.test(whole) && fraction === '') return `${value < 0 ? '-' : ''}<$0.000001`;
    return `${whole.startsWith('-') ? '-$' + whole.slice(1) : '$' + whole}.${fraction.padEnd(2, '0')}`;
}

/** 950 -> 950, 12_345 -> 12.3k, 2_500_000 -> 2.5M. */
export function formatTokens(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return DASH;
    const abs = Math.abs(value);
    if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
    if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
    if (abs >= 10_000) return `${trim(value / 1_000)}k`;
    return String(Math.round(value));
}

function trim(value: number): string {
    return value.toFixed(1).replace(/\.0$/, '');
}

export function formatPercent(fraction: number): string {
    return `${Math.round(fraction * 100)}`;
}

export function formatLatency(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return DASH;
    return ms < 1000 ? `${Math.round(ms)} ms` : `${trim(ms / 1000)} s`;
}

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** HH:MM:SS in the browser's time zone. */
export function formatClock(at: number): string {
    const d = new Date(at);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** HH:MM:SS for today, DD.MM HH:MM:SS for another day. */
export function formatMoment(at: number, now: number): string {
    const d = new Date(at);
    const n = new Date(now);
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? formatClock(at) : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${formatClock(at)}`;
}

/** "3 d 4 h", "3 h 20 min", "12 min", "< 1 min": the two largest units. */
export function formatDuration(ms: number, t: Translate): string {
    if (!Number.isFinite(ms) || ms < 60_000) return t('account.duration.lessMinute');
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / 60_000);
    const parts: string[] = [];
    if (days > 0) parts.push(`${days} ${t('account.unit.day')}`);
    if (hours > 0) parts.push(`${hours} ${t('account.unit.hour')}`);
    if (minutes > 0 && days === 0) parts.push(`${minutes} ${t('account.unit.minute')}`);
    return parts.slice(0, 2).join(' ');
}

/* ----------------------------------------------------------------------------------------------- quota bars */

export type BarLevel = 'ok' | 'warn' | 'error' | 'muted';

export interface QuotaBarSpec {
    id: 'daily' | 'weekly';
    label: string;
    /** 0..1; null when NanoGPT reports no limit (or nothing). */
    fraction: number | null;
    level: BarLevel;
    valueText: string;
    resetText: string | null;
}

export function quotaBar(id: QuotaBarSpec['id'], window: QuotaWindow, now: number, t: Translate): QuotaBarSpec {
    const label = t(`account.quota.${id}`);
    const { used, limit, resetsAt } = window;
    const fraction = used !== null && limit !== null && limit > 0 ? Math.min(1, Math.max(0, used / limit)) : null;
    let valueText: string;
    if (used === null) valueText = t('account.quota.noData');
    else if (limit === null || !(limit > 0)) valueText = t('account.quota.noLimit', { used: formatTokens(used) });
    else {
        valueText = t('account.quota.value', {
            used: formatTokens(used),
            limit: formatTokens(limit),
            percent: formatPercent(used / limit),
        });
    }
    let level: BarLevel = 'muted';
    if (fraction !== null) level = fraction >= 1 ? 'error' : fraction >= 0.8 ? 'warn' : 'ok';
    let resetText: string | null = null;
    if (resetsAt !== null) {
        const wait = resetsAt - now;
        resetText =
            wait > 0
                ? t('account.quota.resets', { in: formatDuration(wait, t), at: formatMoment(resetsAt, now) })
                : t('account.quota.resetDue');
    }
    return { id, label, fraction, level, valueText, resetText };
}

export interface ChipSpec {
    label: string;
    kind: ChipKind;
    title?: string;
}

/** NanoGPT's advice on which billing to use right now. */
export function recommendedChip(mode: 'subscription' | 'paygo' | null, t: Translate): ChipSpec | null {
    if (mode === null) return null;
    return mode === 'subscription'
        ? { label: t('account.recommended.subscription'), kind: 'ok' }
        : { label: t('account.recommended.paygo'), kind: 'warn', title: t('account.recommended.paygo.hint') };
}

/* ----------------------------------------------------------------------------------------- account notice */

export interface NoticeSpec {
    kind: 'info' | 'warn' | 'error';
    text: string;
    /** A button next to the text: where to go to fix it. */
    action: 'keys' | null;
}

function errorText(error: PluginError, t: Translate): string {
    const known = ['key_rejected', 'rate_limited', 'upstream_error', 'upstream_unreachable', 'upstream_timeout'];
    if (known.includes(error.code)) return t(`account.error.${error.code}`);
    return t('account.error.other', { code: error.code });
}

/** What to tell the user about the account's state, null when there is nothing to say. */
export function accountNotice(detail: AccountDetail, t: Translate): NoticeSpec | null {
    switch (detail.state) {
        case 'needs_plugin':
            return { kind: 'info', text: t('account.state.needsPlugin'), action: null };
        case 'plugin_down':
            return {
                kind: 'error',
                text: detail.snapshot ? t('account.state.pluginDownStale') : t('account.state.pluginDown'),
                action: null,
            };
        case 'no_key':
            return { kind: 'warn', text: t('account.state.noKey'), action: 'keys' };
        case 'error':
            return {
                kind: 'error',
                text: detail.error ? errorText(detail.error, t) : t('account.error.other', { code: '?' }),
                action: detail.error?.code === 'key_rejected' ? 'keys' : null,
            };
        case 'ok':
            if (detail.subscriptionError && stateOfError(detail.subscriptionError) !== 'needs_plugin') {
                return { kind: 'warn', text: t('account.state.subscriptionFailed'), action: null };
            }
            return null;
        default:
            return detail.fetching ? null : { kind: 'info', text: t('account.state.idle'), action: null };
    }
}

export function balanceUpdated(detail: AccountDetail, now: number, t: Translate): string | null {
    const brief = detail.brief;
    if (!brief) return null;
    const text = t('account.updated', { time: formatMoment(brief.fetchedAt, now) });
    return detail.stale ? `${text} · ${t('account.updated.stale')}` : text;
}

/** Label of an option of the key selector. */
export function keyOptionLabel(key: KeyInfo, t: Translate): string {
    const base = key.label ? `${key.label} · ${key.masked}` : key.masked;
    return key.active ? `${base} (${t('account.key.active')})` : base;
}

/* ------------------------------------------------------------------------------------------------- spend */

export type SpendRange = 'today' | 'week' | 'month';
export const SPEND_RANGES: readonly SpendRange[] = ['today', 'week', 'month'];

/** The period of a range ending now: today since local midnight, the others the last 7 / 30 days. */
export function rangeBounds(
    range: SpendRange,
    now: number,
    startOfDay: (at: number) => number,
): { from: number; to: number } {
    const to = now + 1;
    if (range === 'today') return { from: startOfDay(now), to };
    return { from: now - (range === 'week' ? 7 : 30) * DAY_MS, to };
}

export interface SpendCardSpec {
    id: SpendRange;
    title: string;
    requests: string;
    /** Real money; what caps count. */
    real: string;
    /** The pay-as-you-go equivalent; informational. */
    equivalent: string;
    tokens: string;
    /** No numbers yet (loading or failed). */
    empty: boolean;
}

export function spendCard(range: SpendRange, totals: UsageTotals | null, t: Translate): SpendCardSpec {
    const title = t(`account.range.${range}`);
    if (!totals) return { id: range, title, requests: DASH, real: DASH, equivalent: DASH, tokens: DASH, empty: true };
    return {
        id: range,
        title,
        requests: String(totals.requests),
        real: formatUsd(totals.costUsd),
        equivalent: formatUsd(totals.equivalentUsd),
        tokens: t('account.spend.tokens', {
            prompt: formatTokens(totals.promptTokens),
            completion: formatTokens(totals.completionTokens),
        }),
        empty: false,
    };
}

export interface BreakdownRow {
    key: string;
    name: string;
    requests: string;
    real: string;
    equivalent: string;
    tokens: string;
}

function breakdownRow(key: string, name: string, totals: UsageTotals): BreakdownRow {
    return {
        key,
        name,
        requests: String(totals.requests),
        real: formatUsd(totals.costUsd),
        equivalent: formatUsd(totals.equivalentUsd),
        tokens: formatTokens(totals.promptTokens + totals.completionTokens),
    };
}

/** Rows by connection; `nameOf` turns an id into the connection's name (null = requests outside Nanovia). */
export function connectionRows(
    rows: readonly ConnectionUsage[],
    nameOf: (connectionId: string) => string | null,
    t: Translate,
): BreakdownRow[] {
    return rows.map((row) =>
        breakdownRow(
            row.connectionId ?? '',
            row.connectionId === null ? t('account.row.noConnection') : (nameOf(row.connectionId) ?? row.connectionId),
            row,
        ),
    );
}

export function modelRows(rows: readonly ModelUsage[]): BreakdownRow[] {
    return rows.map((row) => breakdownRow(row.model, row.model, row));
}

/** The kinds of request the spend is split by (stage 0.7); a medium this build does not know is shown as it came. */
const MEDIA_LABELS = ['chat', 'image', 'video', 'tts', 'stt'];

export function mediumLabelOf(medium: string, t: Translate): string {
    return MEDIA_LABELS.includes(medium) ? t(`account.medium.${medium}`) : medium;
}

/** Rows by kind of request (chat, image, video, speech, transcription); tokens do not mean anything for most of them. */
export function mediumRows(rows: readonly MediumSpendRow[], t: Translate): BreakdownRow[] {
    return rows.map((row) => breakdownRow(row.medium, mediumLabelOf(row.medium, t), row));
}

/** Where the spend numbers come from, null when nothing needs saying (the plugin's log is part of them). */
export function spendSourceNote(result: SpendResult | null, t: Translate): string | null {
    if (!result || result.plugin) return null;
    return result.error?.code === 'not_installed' ? t('account.spend.noPlugin') : t('account.spend.pluginDown');
}

/* ------------------------------------------------------------------------------------- recent requests */

const BILLING_KIND: Record<BillingOutcome, ChipKind> = { subscription: 'ok', paygo: 'info', unknown: 'muted' };

export interface RecentRowSpec {
    /** Unique within the list. */
    key: string;
    requestId: string | null;
    time: string;
    connection: string;
    model: string;
    billing: ChipSpec;
    /** Real money; "$0.00" for a request the subscription covered, a dash when unknown. */
    cost: string;
    equivalent: string;
    tokens: string;
    /** Share of the prompt that came from cache, e.g. "80 %"; null when unknown. */
    cached: string | null;
    latency: string;
    error: { label: string; title: string } | null;
    /** Stage 0.7, media records only: what kind of request it was ('Images', 'Speech' …). */
    medium?: ChipSpec;
    /** What the cost was billed on ("images: 2", "characters: 120"); media records only. */
    units?: string;
    /** Where the cost figure came from; set when the record says (media records do). */
    source?: ChipSpec;
}

export function cachedShare(record: UsageRecord): number | null {
    const { promptTokens, cachedTokens } = record;
    if (promptTokens === null || cachedTokens === null || !(promptTokens > 0)) return null;
    return Math.min(1, Math.max(0, cachedTokens / promptTokens));
}

export function recentRow(
    record: UsageRecord,
    index: number,
    now: number,
    nameOf: (connectionId: string) => string | null,
    t: Translate,
): RecentRowSpec {
    const failed = record.error !== null || record.status >= 400;
    const share = cachedShare(record);
    const connection =
        record.connectionId === null
            ? t('account.row.noConnection')
            : (nameOf(record.connectionId) ?? record.connectionId);
    const media = record.medium !== undefined && record.medium !== 'chat' ? record.medium : null;
    const row: RecentRowSpec = {
        key: record.requestId ?? `${record.at}-${index}`,
        requestId: record.requestId,
        time: formatMoment(record.at, now),
        connection,
        model: record.model,
        billing: { label: t(`account.billing.${record.billing}`), kind: BILLING_KIND[record.billing] },
        cost: formatUsd(record.costUsd),
        equivalent: formatUsd(record.equivalentUsd),
        // A media record has no tokens: the units it was billed on say what it was instead.
        tokens:
            media !== null
                ? ''
                : t('account.row.tokens', {
                      prompt: formatTokens(record.promptTokens),
                      completion: formatTokens(record.completionTokens),
                  }),
        cached: share === null ? null : t('account.row.cached', { percent: formatPercent(share) }),
        latency: formatLatency(record.latencyMs),
        error: failed
            ? {
                  label: t('account.row.error'),
                  title: record.error ?? t('account.row.errorStatus', { status: record.status }),
              }
            : null,
    };
    if (media !== null) {
        row.medium = { label: mediumLabelOf(media, t), kind: 'info' };
        if (record.units !== undefined && record.units !== null) {
            row.units = t(`account.units.${media}`, { count: formatUnits(record.units) });
        }
    }
    if (record.costSource !== undefined) {
        row.source = {
            label: t(`account.costSource.${record.costSource}`),
            kind: record.costSource === 'lookup' ? 'ok' : 'muted',
            title: t(`account.costSource.${record.costSource}.hint`),
        };
    }
    return row;
}

/** Units of a media request (seconds, characters, images) without float noise: 12 -> "12", 2.5 -> "2.5". */
export function formatUnits(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

export interface LookupView {
    kind: 'ok' | 'warn' | 'error';
    text: string;
}

/** What the "check exact cost" button answers. Never shows a figure for a request that is not ready. */
export function lookupView(result: PluginResult<RequestCostLookup>, t: Translate): LookupView {
    if (!result.ok) {
        const code = result.error.code;
        if (code === 'not_installed' || code === 'unreachable' || code === 'timeout' || code === 'forbidden') {
            return { kind: 'error', text: t('account.lookup.pluginDown') };
        }
        if (code === 'no_key') return { kind: 'warn', text: t('account.lookup.noKey') };
        return { kind: 'error', text: t('account.lookup.error', { code }) };
    }
    const { ready, costUsd } = result.data;
    if (!ready) return { kind: 'warn', text: t('account.lookup.notReady') };
    if (costUsd === null) return { kind: 'warn', text: t('account.lookup.noUsd') };
    return { kind: 'ok', text: t('account.lookup.cost', { cost: formatUsd(costUsd) }) };
}
