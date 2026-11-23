// Billing impact of a connection: does a request stay inside the NanoGPT subscription, and what makes it leave.
// Pure: no clock, no randomness, no I/O.
//
// Rules (from NanoGPT's docs: "explicit provider selection, routing suffix and Claude cache control are pay-as-you-go
// plus ~5% markup and bypass the subscription"). Reason codes become i18n keys `billing.reason.<code>`.
//
// | situation                                                    | outcome        | markup | reason                       |
// | ------------------------------------------------------------ | -------------- | ------ | ---------------------------- |
// | connection.billing === 'paygo'                               | paygo          | -      | billing.forced               |
// | model known and not included in the subscription             | paygo          | -      | model.notIncluded            |
// |   ... and billing === 'subscription' (cannot be satisfied)   | paygo          | -      | + billing.modelNotCoverable  |
// | explicit routing (routing.ts: hasExplicitRouting)            | paygo          | 5%     | routing.explicit {fields}    |
// | explicit routing, model has no provider selection            | as without it  | -      | routing.unsupportedByModel   |
// | routing with only `zdr`                                      | unchanged      | -      | routing.zdrOnly              |
// | webSearch (`:online`)                                        | unchanged      | -      | search.billedSeparately      |
// | memory (`:memory`)                                           | unchanged      | -      | memory.billedSeparately      |
// | outcome subscription and inputTokenMultiplier > 1            | subscription   | -      | subscription.multiplier      |
// | billing === 'subscription' ("safe"): bypassing fields are    | subscription   | -      | (names in `stripped`)        |
// |   stripped by the proxy, `zdr` is kept                       |   if the model |        |                              |
// |                                                              |   is included  |        |                              |
// | model unknown (null) and nothing forces pay-as-you-go        | unknown        | -      |                              |
//
// Which routing settings bypass the subscription is NanoGPT's rule, not ours: the whole of routing.ts routingFields()
// counts (order, only, ignore, sort, quantizations, minQuantization, maxPrice, allowFallbacks=false, requireParameters,
// preferred latency/throughput, cachingRoute); `zdr` does not. `cachingRoute` is Claude-style cache control: verify live.
// Open details, all marked `// verify live`: whether `sort`/`ignore` alone really trigger the markup, whether the markup
// also applies to a model that is outside the subscription anyway, and whether `zdr` ever changes the price.
import type {
    BillingImpact,
    BillingOutcome,
    BillingReason,
    CatalogModel,
    ConnectionConfig,
    RoutingConfig,
} from '../shared/contracts';
import { PROVIDER_MARKUP_PERCENT } from '../shared/constants';
import { hasExplicitRouting, routingFields } from './routing';

/**
 * The routing a 'subscription' ("safe") connection really uses: every bypassing setting is reset to its neutral value,
 * `zdr` stays. `stripped` names what was removed (RoutingConfig keys). Nothing is stripped while routing is disabled
 * (it sends nothing). Does not look at `connection.billing`: callers apply it in safe mode, and a panel can call it to
 * offer "make this subscription-safe". `_model` is reserved for model-specific rules.
 */
export function subscriptionSafeOverrides(
    connection: ConnectionConfig,
    _model: CatalogModel | null,
): { routing: RoutingConfig; stripped: string[] } {
    const r = connection.routing;
    const stripped = r.enabled ? routingFields(r) : [];
    if (stripped.length === 0) return { routing: cloneRouting(r), stripped };
    return {
        routing: {
            ...r,
            order: [],
            only: [],
            ignore: [],
            sort: 'default',
            quantizations: [],
            minQuantization: null,
            maxPrice: { prompt: null, completion: null },
            allowFallbacks: true,
            requireParameters: false,
            preferredMaxLatency: null,
            preferredMinThroughput: null,
            cachingRoute: false,
        },
        stripped,
    };
}

/**
 * What this connection does to the billing of a request to `model` (null = not in the catalog).
 * `providerSelection` is ModelProviders.supportsProviderSelection: false means NanoGPT ignores routing for the model,
 * null means unknown (treated as true). `subscriptionSafe` speaks about settings only (nothing bypasses the
 * subscription and billing is not forced to pay-as-you-go); whether the model itself is covered is `outcome`.
 */
export function analyzeBilling(
    connection: ConnectionConfig,
    model: CatalogModel | null,
    providerSelection: boolean | null,
): BillingImpact {
    const forced = connection.billing === 'paygo';
    const safe = connection.billing === 'subscription';
    const { routing, stripped } = safe
        ? subscriptionSafeOverrides(connection, model)
        : { routing: connection.routing, stripped: [] as string[] };

    const explicit = hasExplicitRouting(routing);
    const selectionIgnored = providerSelection === false;
    const bypass = explicit && !selectionIgnored;
    const reasons: BillingReason[] = [];

    if (forced) {
        reasons.push({ code: 'billing.forced' });
    } else if (model !== null && !model.subscription.included) {
        reasons.push({ code: 'model.notIncluded', params: { model: model.id } });
        if (safe) reasons.push({ code: 'billing.modelNotCoverable', params: { model: model.id } });
    }

    if (explicit) {
        const fields = routingFields(routing).join(', ');
        reasons.push({ code: selectionIgnored ? 'routing.unsupportedByModel' : 'routing.explicit', params: { fields } });
    } else if (routing.enabled && routing.zdr && !selectionIgnored && !forced) {
        reasons.push({ code: 'routing.zdrOnly' });
    }
    if (connection.webSearch) reasons.push({ code: 'search.billedSeparately' });
    if (connection.memory.enabled) reasons.push({ code: 'memory.billedSeparately' });

    let outcome: BillingOutcome;
    if (forced || bypass) outcome = 'paygo';
    else if (model === null) outcome = 'unknown';
    else outcome = model.subscription.included ? 'subscription' : 'paygo';

    if (model !== null && outcome === 'subscription' && model.subscription.inputTokenMultiplier > 1) {
        reasons.push({ code: 'subscription.multiplier', params: { value: model.subscription.inputTokenMultiplier } });
    }

    return {
        outcome,
        markupPercent: bypass ? PROVIDER_MARKUP_PERCENT : 0, // verify live
        subscriptionSafe: !forced && !bypass,
        reasons,
        stripped,
    };
}

function cloneRouting(r: RoutingConfig): RoutingConfig {
    return {
        ...r,
        order: [...r.order],
        only: [...r.only],
        ignore: [...r.ignore],
        quantizations: [...r.quantizations],
        maxPrice: { ...r.maxPrice },
    };
}
