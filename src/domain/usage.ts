// Reading NanoGPT's `usage` (OpenAI/OpenRouter shape plus NanoGPT's own fields) into one tolerant structure, and summing
// usage records. Pure: untrusted JSON in, plain numbers out; nothing is invented and bad numbers become null.
import type { UsageRecord } from '../shared/contracts';
import type { ConnectionUsage, DayUsage, ModelUsage, UsageSummary, UsageTotals } from '../shared/contracts-account';

/** `usage` of one response (or one SSE chunk) with every alias folded in. null = the response did not say. */
export interface NormalizedUsage {
    /** Something usable was found (a token count, a cost or a pricing block). false for `usage: null` and junk. */
    present: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    /** Prompt tokens served from cache: prompt_tokens_details.cached_tokens, cache_read_input_tokens, prompt_cache_hit_tokens. */
    cachedTokens: number | null;
    /** Prompt tokens written to cache: cache_creation_input_tokens or prompt_tokens_details.cache_write_tokens. */
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    /**
     * Real money in USD. 0 means the subscription (or a free model) covered the request. null: not reported, only an
     * estimate exists, or it was charged in another currency.
     */
    costUsd: number | null;
    /** Upper-cased `usage.currency` ('USD', 'XNO' ...); null when absent. */
    currency: string | null;
    /** A cost above zero was reported in a currency other than USD (so the request was paid, but not convertible). */
    paidOtherCurrency: boolean;
    /** The real cost is missing and only NanoGPT's own estimate (`x_nanogpt_pricing`) exists; see `estimateUsd`. */
    estimated: boolean;
    /** `x_nanogpt_pricing.cost` when it was not taken as the real cost: NanoGPT's own pay-as-you-go figure. */
    estimateUsd: number | null;
    /** `x_nanogpt_pricing.requestId`. The upstream header X-Request-ID is the authoritative id; callers prefer it. */
    requestId: string | null;
}

export function emptyUsage(): NormalizedUsage {
    return {
        present: false,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        costUsd: null,
        currency: null,
        paidOtherCurrency: false,
        estimated: false,
        estimateUsd: null,
        requestId: null,
    };
}

/**
 * Normalises usage. `raw` is a response body or SSE chunk (then `usage` and the top-level `x_nanogpt_pricing` are read)
 * or a bare usage object. Anything else gives an empty result.
 *
 * Cost rules: `usage.cost` (then `total_cost`) as a number or decimal string wins; negative, NaN or garbage counts as
 * absent. A currency other than USD makes the cost unusable as dollars (null) except an exact 0, which is 0 in any
 * currency; a missing currency means USD (the OpenRouter convention). Without a usable cost, `x_nanogpt_pricing.cost`
 * is the real cost only when the block says `isEstimate: false`; otherwise it is kept as `estimateUsd`.
 */
export function normalizeUsage(raw: unknown): NormalizedUsage {
    if (!isRecord(raw)) return emptyUsage();
    const nested = raw['usage'];
    if (nested !== undefined && !isRecord(nested)) return emptyUsage();
    const usage = isRecord(nested) ? nested : raw;
    const pricingRaw = raw['x_nanogpt_pricing'] ?? usage['x_nanogpt_pricing'];
    const pricing = isRecord(pricingRaw) ? pricingRaw : null;
    const promptDetails = isRecord(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : {};
    const completionDetails = isRecord(usage['completion_tokens_details']) ? usage['completion_tokens_details'] : {};

    const promptTokens = firstCount(usage['prompt_tokens'], usage['input_tokens'], pricing?.['inputTokens']);
    const completionTokens = firstCount(usage['completion_tokens'], usage['output_tokens'], pricing?.['outputTokens']);
    const totalTokens = firstCount(usage['total_tokens']);
    const cachedTokens = preferPositive(
        promptDetails['cached_tokens'],
        usage['cache_read_input_tokens'],
        usage['prompt_cache_hit_tokens'],
        pricing?.['cacheReadInputTokens'],
    );
    const cacheWriteTokens = preferPositive(
        usage['cache_creation_input_tokens'],
        promptDetails['cache_write_tokens'],
        pricing?.['cacheCreationInputTokens'],
    );
    const reasoningTokens = firstCount(completionDetails['reasoning_tokens'], usage['reasoning_tokens']);

    const currency =
        typeof usage['currency'] === 'string' && usage['currency'].trim()
            ? usage['currency'].trim().toUpperCase()
            : null;
    const dollars = currency === null || currency === 'USD';
    const reported = firstCost(usage['cost'], usage['total_cost']);
    let costUsd: number | null = null;
    let paidOtherCurrency = false;
    if (reported !== null) {
        if (dollars || reported === 0) costUsd = reported;
        else paidOtherCurrency = true;
    }
    const pricingCost = pricing ? firstCost(pricing['cost']) : null;
    let estimateUsd: number | null = null;
    if (pricingCost !== null) {
        if (reported === null && dollars && pricing?.['isEstimate'] === false) costUsd = pricingCost;
        else estimateUsd = pricingCost;
    }
    const estimated = costUsd === null && !paidOtherCurrency && estimateUsd !== null;
    const requestId =
        typeof pricing?.['requestId'] === 'string' && pricing['requestId'].trim() ? pricing['requestId'].trim() : null;

    const present = [
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        cacheWriteTokens,
        reasoningTokens,
        reported,
        pricingCost,
    ].some((v) => v !== null);
    if (!present) return emptyUsage();
    return {
        present,
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        cacheWriteTokens,
        reasoningTokens,
        costUsd,
        currency,
        paidOtherCurrency,
        estimated,
        estimateUsd,
        requestId,
    };
}

/* ------------------------------------------------------------------------------------------------ summary */

/** Rounds a USD amount to 1e-9 so sums of floats print cleanly (`0.1 + 0.2`). */
export function roundUsd(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}

export interface SummarizeFilter {
    /** Only this connection (`null` = only requests without one). Omitted = all. */
    connectionId?: string | null;
}

/**
 * Sums records with `range.from <= at < range.to` in total, per day (`dayOf` names the day, so the zone is the
 * caller's), per connection and per model. Real cost and pay-as-you-go equivalent stay separate; unknown values count as
 * 0; every record counts as a request, a subscription one with cost 0. Pure and deterministic: days ascend, the other
 * lists go by real cost, equivalent, requests (descending) and then name.
 */
export function summarizeUsage(
    records: readonly UsageRecord[],
    range: { from: number; to: number },
    dayOf: (at: number) => string,
    filter: SummarizeFilter = {},
): UsageSummary {
    const total = emptyTotals();
    const days = new Map<string, UsageTotals>();
    const connections = new Map<string | null, UsageTotals>();
    const models = new Map<string, UsageTotals>();
    for (const record of records) {
        if (!(record.at >= range.from && record.at < range.to)) continue;
        if (filter.connectionId !== undefined && record.connectionId !== filter.connectionId) continue;
        addRecord(total, record);
        addRecord(bucket(days, dayOf(record.at)), record);
        addRecord(bucket(connections, record.connectionId), record);
        addRecord(bucket(models, record.model), record);
    }
    const byDay: DayUsage[] = [...days]
        .map(([day, totals]) => ({ day, ...finish(totals) }))
        .sort((a, b) => compareText(a.day, b.day));
    const byConnection: ConnectionUsage[] = [...connections]
        .map(([connectionId, totals]) => ({ connectionId, ...finish(totals) }))
        .sort((a, b) => byWeight(a, b) || compareText(a.connectionId ?? '', b.connectionId ?? ''));
    const byModel: ModelUsage[] = [...models]
        .map(([model, totals]) => ({ model, ...finish(totals) }))
        .sort((a, b) => byWeight(a, b) || compareText(a.model, b.model));
    return { from: range.from, to: range.to, total: finish(total), byDay, byConnection, byModel };
}

function emptyTotals(): UsageTotals {
    return { requests: 0, costUsd: 0, equivalentUsd: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
}

function bucket<K>(map: Map<K, UsageTotals>, key: K): UsageTotals {
    let totals = map.get(key);
    if (!totals) {
        totals = emptyTotals();
        map.set(key, totals);
    }
    return totals;
}

function addRecord(totals: UsageTotals, record: UsageRecord): void {
    totals.requests += 1;
    totals.costUsd += amount(record.costUsd);
    totals.equivalentUsd += amount(record.equivalentUsd);
    totals.promptTokens += amount(record.promptTokens);
    totals.completionTokens += amount(record.completionTokens);
    totals.cachedTokens += amount(record.cachedTokens);
}

function finish(totals: UsageTotals): UsageTotals {
    return { ...totals, costUsd: roundUsd(totals.costUsd), equivalentUsd: roundUsd(totals.equivalentUsd) };
}

/** A stored number counts when it is finite and not negative; anything else (null, NaN, a negative) counts as 0. */
function amount(value: number | null): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function byWeight(a: UsageTotals, b: UsageTotals): number {
    return b.costUsd - a.costUsd || b.equivalentUsd - a.equivalentUsd || b.requests - a.requests;
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------------ parsing helpers */

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A USD amount from a number or a decimal string; null for negatives, NaN, infinities and anything else. */
export function parseCost(value: unknown): number | null {
    let n: number;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && DECIMAL.test(value.trim())) n = Number(value.trim());
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    return n === 0 ? 0 : n;
}

/** A token count: a finite number that is not negative. */
export function parseCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? (value === 0 ? 0 : value) : null;
}

function firstCount(...values: unknown[]): number | null {
    for (const value of values) {
        const n = parseCount(value);
        if (n !== null) return n;
    }
    return null;
}

function firstCost(...values: unknown[]): number | null {
    for (const value of values) {
        const n = parseCost(value);
        if (n !== null) return n;
    }
    return null;
}

/** The first positive count, else the first valid count (a real 0), else null: one source saying 0 must not hide another. */
function preferPositive(...values: unknown[]): number | null {
    let zero: number | null = null;
    for (const value of values) {
        const n = parseCount(value);
        if (n === null) continue;
        if (n > 0) return n;
        zero = 0;
    }
    return zero;
}
