// Money of one request: the pay-as-you-go equivalent, the billing outcome (subscription, paygo or unknown) and the
// usage record. Real cost comes from NanoGPT (`usage.cost`); the equivalent is computed from the catalog price and is
// never counted toward caps. Pure.
import type { BillingOutcome, CatalogModel, RequestHints, UsageRecord } from '../shared/contracts';
import type { NormalizedUsage } from './usage';
import { roundUsd } from './usage';

/**
 * What the request would cost at pay-as-you-go prices (USD): uncached prompt tokens at the prompt price, cached ones at
 * the cache-read price (the prompt price when the model has none), completion tokens at the completion price. Cache
 * writes are part of the prompt tokens and have no separate catalog price. With the model unknown the answer is NanoGPT's
 * own estimate (`x_nanogpt_pricing.cost`) when there is one, otherwise null; null too when no token count is known.
 */
export function equivalentCostUsd(model: CatalogModel | null, u: NormalizedUsage): number | null {
    if (model) {
        const priced = priceTokens(model, u);
        if (priced !== null) return priced;
    }
    return u.estimateUsd;
}

function priceTokens(model: CatalogModel, u: NormalizedUsage): number | null {
    if (u.promptTokens === null && u.completionTokens === null) return null;
    const { prompt, completion, cacheRead } = model.pricing;
    if (!isPrice(prompt) || !isPrice(completion)) return null;
    const promptTokens = u.promptTokens ?? 0;
    const cached = Math.min(u.cachedTokens ?? 0, promptTokens);
    const cachePrice = cacheRead !== null && isPrice(cacheRead) ? cacheRead : prompt;
    const usd =
        ((promptTokens - cached) * prompt + cached * cachePrice + (u.completionTokens ?? 0) * completion) / 1_000_000;
    return roundUsd(usd);
}

function isPrice(value: number): boolean {
    return Number.isFinite(value) && value >= 0;
}

export interface ClassifyBillingArgs {
    model: CatalogModel | null;
    /** Real money of the request in USD; null when unknown. */
    costUsd: number | null;
    /** The connection forces pay-as-you-go (`X-Billing-Mode: paygo`). */
    billingModeForced: boolean;
    /** The request names providers explicitly, which NanoGPT bills pay-as-you-go with a markup. */
    explicitRouting: boolean;
    /** `costUsd` came from an estimate: it proves nothing and is ignored. */
    estimated: boolean;
    /** A cost above zero was reported in another currency (XNO): the request was paid, only not convertible. */
    paidOtherCurrency?: boolean;
}

/**
 * Where the money for a request came from.
 * paygo: a cost above zero, a payment in another currency, or pay-as-you-go forced or implied by explicit routing.
 * subscription: the cost is exactly 0, the model is in the subscription and nothing forced pay-as-you-go.
 * unknown: everything else (no cost reported, an estimate only, a free or unknown model).
 */
export function classifyBilling(args: ClassifyBillingArgs): BillingOutcome {
    const cost = args.estimated ? null : args.costUsd;
    if (args.billingModeForced || args.explicitRouting) return 'paygo';
    if (cost !== null && cost > 0) return 'paygo';
    if (!args.estimated && args.paidOtherCurrency === true) return 'paygo';
    if (cost === 0 && args.model?.subscription.included === true) return 'subscription';
    return 'unknown';
}

/** What is known about the request besides its usage. */
export interface CostContext {
    model: CatalogModel | null;
    billingModeForced: boolean;
    explicitRouting: boolean;
}

export interface CostResolution {
    billing: BillingOutcome;
    /** Real money; exactly 0 for a subscription request; null when not reported. */
    costUsd: number | null;
    equivalentUsd: number | null;
}

/**
 * Billing, real cost and equivalent of one request from its usage (null = the response had none). The equivalent falls
 * back to the real cost for a pay-as-you-go request whose model has no catalog price.
 */
export function resolveCost(usage: NormalizedUsage | null, ctx: CostContext): CostResolution {
    if (!usage || !usage.present) {
        const billing = classifyBilling({
            model: ctx.model,
            costUsd: null,
            billingModeForced: ctx.billingModeForced,
            explicitRouting: ctx.explicitRouting,
            estimated: false,
        });
        return { billing, costUsd: null, equivalentUsd: null };
    }
    const billing = classifyBilling({
        model: ctx.model,
        costUsd: usage.costUsd,
        billingModeForced: ctx.billingModeForced,
        explicitRouting: ctx.explicitRouting,
        estimated: usage.estimated,
        paidOtherCurrency: usage.paidOtherCurrency,
    });
    const costUsd = billing === 'subscription' ? 0 : usage.costUsd;
    let equivalentUsd = equivalentCostUsd(ctx.model, usage);
    if (equivalentUsd === null && billing === 'paygo') equivalentUsd = costUsd;
    return { billing, costUsd, equivalentUsd };
}

export interface BuildUsageRecordArgs extends CostContext {
    at: number;
    connectionId: string | null;
    /** The model id of the request (the record keeps it even when the catalog does not know it). */
    modelId: string;
    /** null: the response carried no usage (an error, an abort, usage not requested). */
    usage: NormalizedUsage | null;
    /** The upstream X-Request-ID header; wins over the id inside the body. */
    requestId: string | null;
    latencyMs: number;
    status: number;
    stream: boolean;
    consumer: RequestHints['consumer'];
    error: string | null;
}

/**
 * The record written to `usage-YYYY-MM-DD.jsonl`. A failed request without usage is `unknown` with no cost (nothing
 * proves it was billed); token counts are null when the response did not report them.
 */
export function buildUsageRecord(args: BuildUsageRecordArgs): UsageRecord {
    const failed = args.error !== null || args.status >= 400;
    const hasUsage = args.usage !== null && args.usage.present;
    const resolved = resolveCost(args.usage, args);
    const usage = hasUsage ? args.usage : null;
    return {
        at: args.at,
        connectionId: args.connectionId,
        requestId: args.requestId ?? usage?.requestId ?? null,
        model: args.modelId,
        billing: failed && !hasUsage ? 'unknown' : resolved.billing,
        costUsd: resolved.costUsd,
        equivalentUsd: resolved.equivalentUsd,
        promptTokens: usage?.promptTokens ?? null,
        completionTokens: usage?.completionTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        latencyMs: args.latencyMs,
        status: args.status,
        stream: args.stream,
        consumer: args.consumer,
        error: args.error,
    };
}
