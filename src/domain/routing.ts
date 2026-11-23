// Routing: which settings of a RoutingConfig steer the request to a provider (and so leave the subscription), the
// `provider` object NanoGPT receives, and the warnings about settings that do nothing. Pure.
import type { PlanWarning, RoutingConfig } from '../shared/contracts';

/**
 * Names (RoutingConfig keys) of the settings that select a provider or a route, in a fixed order. These are the
 * settings NanoGPT bills as an explicit provider selection (pay-as-you-go plus markup). `zdr` is not among them: it only
 * narrows the platform's own routing. Looks at the fields only; whether routing is enabled is the caller's question
 * (see hasExplicitRouting).
 */
export function routingFields(r: RoutingConfig): string[] {
    const fields: string[] = [];
    if (r.order.length > 0) fields.push('order');
    if (r.only.length > 0) fields.push('only');
    if (r.ignore.length > 0) fields.push('ignore');
    if (r.sort !== 'default') fields.push('sort');
    if (r.quantizations.length > 0) fields.push('quantizations');
    if (r.minQuantization !== null) fields.push('minQuantization');
    if (isSet(r.maxPrice.prompt) || isSet(r.maxPrice.completion)) fields.push('maxPrice');
    if (r.allowFallbacks === false) fields.push('allowFallbacks');
    if (r.requireParameters) fields.push('requireParameters');
    if (isSet(r.preferredMaxLatency)) fields.push('preferredMaxLatency');
    if (isSet(r.preferredMinThroughput)) fields.push('preferredMinThroughput');
    if (r.cachingRoute) fields.push('cachingRoute');
    return fields;
}

/** True when routing is enabled and at least one setting of routingFields is in use. `zdr` alone is not explicit. */
export function hasExplicitRouting(r: RoutingConfig): boolean {
    return r.enabled && routingFields(r).length > 0;
}

/**
 * Maps the config to NanoGPT's `provider` object. null when routing is disabled or there is nothing to send. Provider
 * ids are lower-cased. `data_collection` is never emitted (NanoGPT refuses `deny`). `zdrOnly` keeps just `zdr`: the
 * only field that does not bypass the subscription.
 * `cachingRoute` is not part of `provider`: it is the top-level `caching: true` and is set by planUpstream.
 */
export function buildProviderObject(r: RoutingConfig, opts: { zdrOnly?: boolean }): Record<string, unknown> | null {
    if (!r.enabled) return null;
    const out: Record<string, unknown> = {};
    if (!opts.zdrOnly) {
        const order = normalizeIds(r.order);
        const only = normalizeIds(r.only);
        const ignore = normalizeIds(r.ignore);
        if (order.length > 0) out['order'] = order;
        if (only.length > 0) out['only'] = only;
        if (ignore.length > 0) out['ignore'] = ignore;
        if (r.sort !== 'default') out['sort'] = r.sort;
        if (r.quantizations.length > 0) out['quantizations'] = [...r.quantizations];
        if (r.minQuantization !== null) out['min_quantization'] = r.minQuantization;
        const maxPrice: Record<string, number> = {};
        if (isSet(r.maxPrice.prompt)) maxPrice['prompt'] = r.maxPrice.prompt;
        if (isSet(r.maxPrice.completion)) maxPrice['completion'] = r.maxPrice.completion;
        if (Object.keys(maxPrice).length > 0) out['max_price'] = maxPrice;
        if (r.allowFallbacks === false) out['allow_fallbacks'] = false;
        if (r.requireParameters) out['require_parameters'] = true;
    }
    if (r.zdr) out['zdr'] = true;
    if (!opts.zdrOnly) {
        if (isSet(r.preferredMaxLatency)) out['preferred_max_latency'] = r.preferredMaxLatency;
        if (isSet(r.preferredMinThroughput)) out['preferred_min_throughput'] = r.preferredMinThroughput;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * Settings that look meaningful but do nothing, or conflict. Empty when routing is disabled (nothing is sent).
 * - `routing.preferenceNeedsSort`: preferred latency/throughput without a sort.
 * - `routing.onlyAndOrder`: `only` and `order` together (`only` already limits the candidates, `order` is redundant).
 */
export function routingWarnings(r: RoutingConfig): PlanWarning[] {
    if (!r.enabled) return [];
    const warnings: PlanWarning[] = [];
    if ((isSet(r.preferredMaxLatency) || isSet(r.preferredMinThroughput)) && r.sort === 'default') {
        warnings.push({ code: 'routing.preferenceNeedsSort' });
    }
    if (r.only.length > 0 && r.order.length > 0) warnings.push({ code: 'routing.onlyAndOrder' });
    return warnings;
}

function normalizeIds(list: string[]): string[] {
    const out: string[] = [];
    for (const item of list) {
        const id = item.trim().toLowerCase();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

function isSet(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
