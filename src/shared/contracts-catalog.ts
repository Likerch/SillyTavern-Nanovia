// Stage 3 contracts (catalog, host statistics, routing hints). Types only; the only import is the core contracts.
// The pure logic lives in src/domain/catalog.ts and src/domain/catalog-hints.ts.
import type { CatalogModel, ModelProviders, Quantization, RoutingConfig } from './contracts';

/* ------------------------------------------------------------------------------------------------ admin API */
// Served by the plugin under PLUGIN_ADMIN_BASE, JSON in and out, errors as in contracts.ts. The plugin fetches
// NanoGPT (`GET /api/v1/models?detailed=true`, `GET /api/models/<id>/providers`), runs the result through
// normalizeCatalog / normalizeModelProviders and caches it; the browser never talks to NanoGPT for the catalog.
//
//   GET /catalog                -> CatalogResponse
//   GET /catalog/:id/providers  -> ModelProvidersResponse        (`:id` is encodeURIComponent(modelId): ids contain `/`)

export interface CatalogResponse {
    models: CatalogModel[];
    /** Epoch ms of the NanoGPT fetch this answer is made of. */
    fetchedAt: number;
    /** live: fetched for this request; cache: a fresh cache hit; stale: the cache is old and the live fetch failed. */
    source: 'live' | 'cache' | 'stale';
}

export type ModelProvidersResponse = ModelProviders & { fetchedAt: number };

/* ------------------------------------------------------------------------------------------------ list: filter, sort */

/** Capability switches of the filter: `true` = the model must have it, absent/false = no requirement. */
export interface CatalogCapabilityFilter {
    vision?: boolean;
    reasoning?: boolean;
    /** `CatalogModel.capabilities.toolCalling`. */
    tools?: boolean;
    /** `CatalogModel.capabilities.structuredOutput`. */
    structured?: boolean;
}

/** Every field is optional; absent fields do not filter. The fields combine with AND. */
export interface CatalogQuery {
    /** Words separated by spaces, all must occur (case-insensitive, Cyrillic-safe) in id, name or description. */
    text?: string;
    /** Match the model's category (case-insensitive). '' stands for "no category" (`category === null`). */
    categories?: string[];
    /** Only models included in the subscription. */
    subscriptionOnly?: boolean;
    capabilities?: CatalogCapabilityFilter;
    /** Context window of at least this many tokens (a model with an unknown window does not pass). */
    minContext?: number;
    /** `pricing.prompt` of at most this many USD per 1M tokens. */
    maxPromptPrice?: number;
    openWeightsOnly?: boolean;
}

/**
 * name: A to Z, numbers in order (GLM 5.3 before GLM 10).
 * price: cheapest first (`pricing.prompt + pricing.completion`).
 * context: largest window first, unknown last.
 * newest: latest `created` first, unknown last.
 * subscription: models included in the subscription first.
 * Models that tie keep their incoming order. The reverse flag turns the order around (unknowns stay last).
 */
export type CatalogSort = 'name' | 'price' | 'context' | 'newest' | 'subscription';

/** One vendor of the list: the part of the model id before the first `/`, lower case; ids without one are 'other'. */
export interface CatalogVendorGroup {
    vendor: string;
    models: CatalogModel[];
}

export interface CatalogCategoryCount {
    /** null = the models NanoGPT puts on no shelf. */
    category: string | null;
    count: number;
}

/* ------------------------------------------------------------------------------------------------ cost */

/** One chat turn as the estimate sees it. */
export interface TurnUsage {
    promptTokens: number;
    completionTokens: number;
    /** Share of the prompt read from the provider's cache, 0..1 (clamped). Default 0. */
    cachedShare?: number;
}

/* ------------------------------------------------------------------------------------------------ hosts */

export interface HostCriteria {
    /** Hosts below this precision rank behind those that reach it; a host with an unknown precision sits between. */
    preferQuantization?: Quantization;
    /** USD per 1M tokens; a host above a non-null limit is ranked last. Same shape as `RoutingConfig.maxPrice`. */
    maxPrice?: RoutingConfig['maxPrice'];
    /** Weights of the three components; any non-negative numbers (they are normalised). All zero = equal weights. */
    weightPrice: number;
    weightSpeed: number;
    weightUptime: number;
}

export type HostComponent = 'price' | 'speed' | 'uptime';

/**
 * Component scores are 0..1 and can be checked by hand:
 *   price  = cheapest blended price of the list / this host's blended price (blended = prompt + completion, USD/1M);
 *   speed  = mean of tps / best tps of the list and best ttft / this ttft (only the parts the host reports);
 *   uptime = (uptime% - 90) / 10 clamped to 0..1, so 100% = 1, 95% = 0.5, 90% or less = 0.
 * A component the host reports nothing for scores 0 and is listed in `missing`.
 * total = (wPrice * price + wSpeed * speed + wUptime * uptime) / (wPrice + wSpeed + wUptime).
 */
export interface HostScore {
    providerId: string;
    /** 1-based position in the ranked list. */
    rank: number;
    /** Weighted mean of the components, 0..1, four decimals. */
    total: number;
    price: number;
    speed: number;
    uptime: number;
    missing: HostComponent[];
    /** The host's price is above `criteria.maxPrice` (such hosts come last). */
    overMaxPrice: boolean;
    /** The host reaches `preferQuantization`; null = no preference given, or the host's precision is unknown. */
    meetsQuantization: boolean | null;
}

/* ------------------------------------------------------------------------------------------------ routing hints */

export type HintSeverity = 'info' | 'warn';

/**
 * A machine-readable remark about a model; the UI turns `code` + `params` into text through i18n (keys
 * `catalog.hint.<code>`). `suggestedRouting` is a patch the user can apply with one click (it always carries
 * `enabled: true`).
 */
export interface RoutingHint {
    code: string;
    severity: HintSeverity;
    params: Record<string, string | number | boolean>;
    suggestedRouting?: Partial<RoutingConfig>;
}
