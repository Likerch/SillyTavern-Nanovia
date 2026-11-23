// The OpenRouter-style response shim: rewrites `usage` of a NanoGPT response (a JSON body or one SSE chunk) so that every
// consumer that reads OpenRouter usage (Maestro's cost meter, Officina) sees real USD in `usage.cost`, 0 for a
// subscription request, plus a `nanovia` block with the billing outcome. Only `usage` changes; `choices` and every other
// field pass through untouched. Pure.
import type { CostContext, CostResolution } from './cost';
import { resolveCost } from './cost';
import type { NormalizedUsage } from './usage';
import { isRecord, normalizeUsage } from './usage';

/** What the proxy knows about the request, besides the usage inside the response. */
export interface ShimContext extends CostContext {
    /** The upstream X-Request-ID header; wins over the id inside the body. */
    requestId: string | null;
}

/** The facts behind a rewritten usage: the proxy writes its usage record and response headers from these. */
export interface ResolvedUsage extends CostResolution {
    usage: NormalizedUsage;
    requestId: string | null;
}

export interface ShimResult {
    /** A copy of the input (a shallow one: `choices` is the same object); the input is never modified. */
    body: Record<string, unknown>;
    /** null: nothing was rewritten because the body carries no usable `usage`. */
    resolved: ResolvedUsage | null;
}

export interface ShimPayloadResult {
    /** The payload to send: the very same string when nothing was rewritten. */
    data: string;
    resolved: ResolvedUsage | null;
}

/** Works out billing, cost and request id of a body or chunk; null when it carries no usable usage. */
export function resolveUsage(json: unknown, ctx: ShimContext): ResolvedUsage | null {
    if (!isRecord(json) || !isRecord(json['usage'])) return null;
    const usage = normalizeUsage(json);
    if (!usage.present) return null;
    return { ...resolveCost(usage, ctx), usage, requestId: ctx.requestId ?? usage.requestId };
}

/**
 * Rewrites the `usage` of a response body. prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens
 * (and cache_write_tokens when known) and completion_tokens_details.reasoning_tokens are always numbers (0 when the upstream
 * did not report them, as OpenRouter does); `cost` is real USD, 0 for a subscription request, and is left out when the real
 * cost is unknown (never a guess); `currency` and `total_cost` are dropped so no foreign-currency figure can be mistaken for
 * dollars. `usage.nanovia` = { billing, equivalent_usd, request_id }. A body without a usable `usage` is returned as a copy
 * with nothing invented.
 */
export function shimResponse(json: Record<string, unknown>, ctx: ShimContext): ShimResult {
    const resolved = resolveUsage(json, ctx);
    const original = json['usage'];
    if (!resolved || !isRecord(original)) return { body: { ...json }, resolved: null };
    const { usage } = resolved;
    const out: Record<string, unknown> = { ...original };
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    out['prompt_tokens'] = prompt;
    out['completion_tokens'] = completion;
    out['total_tokens'] = usage.totalTokens ?? prompt + completion;
    const promptDetails: Record<string, unknown> = {
        ...(isRecord(original['prompt_tokens_details']) ? original['prompt_tokens_details'] : {}),
        cached_tokens: usage.cachedTokens ?? 0,
    };
    if (usage.cacheWriteTokens !== null) promptDetails['cache_write_tokens'] = usage.cacheWriteTokens;
    out['prompt_tokens_details'] = promptDetails;
    out['completion_tokens_details'] = {
        ...(isRecord(original['completion_tokens_details']) ? original['completion_tokens_details'] : {}),
        reasoning_tokens: usage.reasoningTokens ?? 0,
    };
    delete out['total_cost'];
    delete out['currency'];
    if (resolved.costUsd !== null) out['cost'] = resolved.costUsd;
    else delete out['cost'];
    out['nanovia'] = {
        billing: resolved.billing,
        equivalent_usd: resolved.equivalentUsd,
        request_id: resolved.requestId,
    };
    return { body: { ...json, usage: out }, resolved };
}

/** `shimResponse(...).body`. */
export function shimResponseBody(json: Record<string, unknown>, ctx: ShimContext): Record<string, unknown> {
    return shimResponse(json, ctx).body;
}

/**
 * Rewrites the payload of one SSE `data:` field the same way. `[DONE]`, anything that is not a JSON object and every
 * chunk without a usable `usage` (including the `"usage": null` of ordinary chunks) come back as the same string.
 */
export function shimSsePayload(data: string, ctx: ShimContext): ShimPayloadResult {
    const unchanged: ShimPayloadResult = { data, resolved: null };
    if (!data.includes('usage')) return unchanged;
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        return unchanged;
    }
    if (!isRecord(parsed)) return unchanged;
    const { body, resolved } = shimResponse(parsed, ctx);
    return resolved ? { data: JSON.stringify(body), resolved } : unchanged;
}

/** `shimSsePayload(...).data`. */
export function shimSseEventData(data: string, ctx: ShimContext): string {
    return shimSsePayload(data, ctx).data;
}
