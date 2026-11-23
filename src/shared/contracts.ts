// Core contracts shared by the browser extension, the pure domain and the server plugin (docs/ARCHITECTURE.md).
// Types only, no imports. Each later stage keeps its own additions in a separate file (contracts-catalog.ts,
// contracts-account.ts, contracts-mgmt.ts) so parallel branches never edit the same lines of this one.

/* ------------------------------------------------------------------------------------------------ connections */

/** How a connection reaches NanoGPT. auto = the plugin when it answers, otherwise direct. */
export type ConnectionMode = 'auto' | 'plugin' | 'direct';

/**
 * auto: any setting is allowed and the panel warns when it leaves the subscription.
 * subscription: "safe for the subscription": settings that would bypass it are blocked in the panel and stripped by the proxy.
 * paygo: always pay-as-you-go (X-Billing-Mode: paygo).
 */
export type BillingMode = 'auto' | 'subscription' | 'paygo';

export type Quantization = 'int4' | 'fp4' | 'fp6' | 'int8' | 'fp8' | 'fp16' | 'bf16' | 'fp32' | 'unknown';
export type RoutingSort = 'default' | 'price' | 'throughput' | 'latency' | 'speed';

/** NanoGPT's `provider` object, OpenRouter style. `enabled: false` sends nothing and keeps the platform's own routing. */
export interface RoutingConfig {
    enabled: boolean;
    /** Provider ids tried in this order (`provider.order`). */
    order: string[];
    /** Only these providers (`provider.only`). */
    only: string[];
    /** Never these providers (`provider.ignore`). */
    ignore: string[];
    sort: RoutingSort;
    /** Hard allowlist of weight precisions (`provider.quantizations`). */
    quantizations: Quantization[];
    /** Precision floor (`provider.min_quantization`). */
    minQuantization: Quantization | null;
    /** USD per 1M tokens (`provider.max_price`); null = no cap. */
    maxPrice: { prompt: number | null; completion: number | null };
    /** `provider.allow_fallbacks`. */
    allowFallbacks: boolean;
    /** `provider.require_parameters`. */
    requireParameters: boolean;
    /** `provider.zdr`: zero data retention endpoints only. (`data_collection: "deny"` is refused by NanoGPT, never sent.) */
    zdr: boolean;
    /** Seconds (`provider.preferred_max_latency`); only works together with a sort. */
    preferredMaxLatency: number | null;
    /** Tokens per second (`provider.preferred_min_throughput`); only works together with a sort. */
    preferredMinThroughput: number | null;
    /** Top-level `caching: true`: providers with prompt caching only, later requests stay on the same one. */
    cachingRoute: boolean;
}

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * follow: translate the effort the request carried (X-Nanovia-Effort or reasoning_effort) to what the model supports.
 * fixed: always `effort`.
 * off: no reasoning when the model allows it; the lowest effort (text hidden) when it always reasons.
 * default: send nothing, the model's own default.
 */
export type ReasoningPolicy = 'follow' | 'fixed' | 'off' | 'default';

export interface ReasoningConfig {
    policy: ReasoningPolicy;
    /** Used by `fixed`. */
    effort: ReasoningEffort | null;
    /** Ask NanoGPT to leave the reasoning text out of the reply (`reasoning.exclude`). */
    hideThoughts: boolean;
}

/** A named bundle that appears in SillyTavern as an ordinary Connection Manager profile. */
export interface ConnectionConfig {
    /** Short stable id, [a-z0-9]{6,16}. Part of the proxy URL. */
    id: string;
    name: string;
    /** NanoGPT model id, including `:thinking` style variants. The profile is created with it. */
    modelId: string;
    /** true: the proxy always uses modelId; false: it follows the model of the request when that is a known id. */
    modelLock: boolean;
    mode: ConnectionMode;
    /** Id of the ST secret under `api_key_nanogpt`; null = the active one. */
    keyId: string | null;
    billing: BillingMode;
    routing: RoutingConfig;
    reasoning: ReasoningConfig;
    /** Appends `:online` to the model (web search, billed separately). */
    webSearch: boolean;
    /** Context Memory (`:memory` / `:memory-N`), billed separately. */
    memory: { enabled: boolean; expirationDays: number | null };
    /** Drop ST's neutral sampler values (top_k 0, top_a 0, min_p 0, repetition_penalty 1) that some NanoGPT routes reject. */
    stripNeutralSamplers: boolean;
    note: string;
    createdAt: number;
    updatedAt: number;
}

/** What the browser hook tells the proxy about one request. */
export interface RequestHints {
    /** Reasoning effort in ST's vocabulary (min/low/medium/high/max/none/auto) or null. */
    effort: string | null;
    consumer: 'main' | 'background' | 'unknown';
    /** The browser wants the reasoning text back. */
    thoughts: boolean;
}

/* ------------------------------------------------------------------------------------------------ catalog (NanoGPT) */

/** One model of `GET /api/v1/models?detailed=true`, normalised. Prices are USD per 1M tokens. */
export interface CatalogModel {
    id: string;
    name: string;
    description: string;
    contextLength: number | null;
    maxOutputTokens: number | null;
    capabilities: { vision: boolean; reasoning: boolean; toolCalling: boolean; structuredOutput: boolean };
    /** As NanoGPT lists them: a subset of none/minimal/low/medium/high/xhigh/max. Empty = no choice. */
    reasoningEfforts: string[];
    openWeights: boolean;
    pricing: { prompt: number; completion: number; cacheRead: number | null };
    /** NanoGPT's own shelf: 'Uncensored', 'Roleplay/storytelling models', 'Private/TEE', 'More' … */
    category: string | null;
    subscription: { included: boolean; inputTokenMultiplier: number };
    providerIds: string[];
    created: number | null;
}

/** One host of a model (`GET /api/models/:id/providers`), normalised. */
export interface ProviderEndpoint {
    id: string;
    /** Normalised: mxfp4/nvfp4 -> fp4, native/-/absent -> unknown, null when the host reports nothing. */
    quantization: Quantization | null;
    /** The label exactly as the host reports it (`mxfp4`, `nvfp4`, `native`, `fp8` …). */
    rawQuantization: string | null;
    /** USD per 1M tokens, markup included, as NanoGPT bills an explicit selection. */
    pricing: { prompt: number; completion: number; cacheRead: number | null } | null;
    tps: number | null;
    ttftMs: number | null;
    uptime: number | null;
    maxOutputTokens: number | null;
    features: string[];
}

export interface ModelProviders {
    modelId: string;
    /** false: the model runs on a fixed route; soft routing controls do nothing. */
    supportsProviderSelection: boolean;
    /** Share of input tokens read from cache under automatic routing (0..1). */
    autoCacheReadRate: number | null;
    autoTps: number | null;
    autoTtftMs: number | null;
    providers: ProviderEndpoint[];
}

/* ------------------------------------------------------------------------------------------------ billing and planning */

export type BillingOutcome = 'subscription' | 'paygo' | 'unknown';

/** A machine-readable reason; the UI turns `code` + `params` into text through i18n (keys `billing.reason.<code>`). */
export interface BillingReason {
    code: string;
    params?: Record<string, string | number | boolean>;
}

/** What a configuration does to the billing of a request. */
export interface BillingImpact {
    outcome: BillingOutcome;
    /** 0 or PROVIDER_MARKUP_PERCENT. */
    markupPercent: number;
    /** true when nothing in the configuration bypasses the subscription. */
    subscriptionSafe: boolean;
    reasons: BillingReason[];
    /** Names of the settings the proxy removes in subscription mode. */
    stripped: string[];
}

export interface PlanWarning {
    code: string;
    params?: Record<string, string | number | boolean>;
}

export interface UpstreamInput {
    connection: ConnectionConfig;
    /** null when the catalog does not know the model. */
    model: CatalogModel | null;
    /** The OpenAI-style request body as it came in. */
    body: Record<string, unknown>;
    hints: RequestHints;
    /** `ModelProviders.supportsProviderSelection` of the model; null when unknown (treated as true). */
    providerSelection: boolean | null;
}

/** Everything needed to call NanoGPT: pure data, built by domain/upstream.ts and used by the proxy and the browser hook. */
export interface UpstreamPlan {
    /** Model id including suffixes (`:online`, `:memory-7`). */
    model: string;
    /** The full body to send. */
    body: Record<string, unknown>;
    /** Extra headers (X-Billing-Mode, X-Provider …). */
    headers: Record<string, string>;
    billing: BillingImpact;
    warnings: PlanWarning[];
}

/* ------------------------------------------------------------------------------------------------ usage */

/** One request seen by the proxy (or the browser hook). Written to `usage-YYYY-MM-DD.jsonl`. */
export interface UsageRecord {
    at: number;
    connectionId: string | null;
    requestId: string | null;
    model: string;
    billing: BillingOutcome;
    /** Real money; 0 when the subscription covered the request; null when unknown. */
    costUsd: number | null;
    /** What the request would cost at pay-as-you-go prices; never counted toward caps. */
    equivalentUsd: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
    latencyMs: number;
    status: number;
    stream: boolean;
    consumer: RequestHints['consumer'];
    error: string | null;
}

/* ------------------------------------------------------------------------------------------------ admin API */
// Served by the plugin under PLUGIN_ADMIN_BASE (behind ST's session and CSRF check). JSON in and out. Errors:
// HTTP status + `{ error: { code: string; message: string } }`. The browser talks to it only through host/plugin-client.

export interface ApiStatus {
    version: string;
    plugin: true;
    proxy: { up: boolean; host: string; port: number };
    /** ST's secret store was reachable. */
    secrets: boolean;
    /** The ST user handle the request belongs to. */
    user: string;
}

export interface ConnectionView extends ConnectionConfig {
    /** `http://127.0.0.1:<port>/c/<id>/v1`: the `api-url` of the profile in plugin mode. */
    proxyUrl: string;
    /** The NanoGPT base: the `api-url` of the profile in direct mode. */
    directUrl: string;
    /** Id of the ST secret (under `api_key_custom`) that holds this connection's proxy token; null in direct mode. */
    tokenSecretId: string | null;
}

export interface KeyInfo {
    /** ST secret id under `api_key_nanogpt`. */
    id: string;
    label: string;
    active: boolean;
    /** `sk-nano-…abcd`, never the value. */
    masked: string;
}

export interface KeyCheck {
    ok: boolean;
    usdBalance: string | null;
    nanoBalance: string | null;
    error: string | null;
}

/*
 * Route table (all under PLUGIN_ADMIN_BASE):
 *   GET    /status                       -> ApiStatus
 *   GET    /connections                  -> { connections: ConnectionView[] }
 *   POST   /connections                  body Partial<ConnectionConfig> & { name; modelId }  -> { connection: ConnectionView }
 *   PUT    /connections/:id              body Partial<ConnectionConfig>                      -> { connection: ConnectionView }
 *   DELETE /connections/:id              -> { ok: true }      (also deletes the token secret)
 *   POST   /connections/:id/rotate-token -> { connection: ConnectionView }
 *   GET    /keys                         -> { keys: KeyInfo[] }
 *   POST   /keys                         body { label: string; value: string }               -> { key: KeyInfo }
 *   DELETE /keys/:id                     -> { ok: true }
 *   POST   /keys/:id/check               -> KeyCheck
 * Later stages add routes in their own contract files.
 */

/* ------------------------------------------------------------------------------------------------ public API */

export interface ConnectionSummary {
    id: string;
    name: string;
    modelId: string;
    mode: ConnectionMode;
    effectiveMode: 'plugin' | 'direct';
    billing: BillingMode;
    /** Id of the Connection Manager profile that belongs to this connection, when it exists. */
    profileId: string | null;
}

export interface ProfileDescription {
    connectionId: string;
    name: string;
    modelId: string;
    reasoning: ReasoningConfig;
    billing: BillingMode;
    capabilities: {
        reasoning: boolean;
        reasoningEfforts: string[];
        /** false for models that always reason (GLM 5.3, Kimi, Gemini 4 …). */
        canDisableReasoning: boolean;
        structuredOutput: boolean;
        toolCalling: boolean;
        vision: boolean;
    } | null;
}

/** Totals of the usage log over a period; real money and the pay-as-you-go equivalent are kept apart. */
export interface UsageTotals {
    requests: number;
    /** Real money: 0 for requests the subscription covered. This is what caps and meters count. */
    costUsd: number;
    /** What the same requests would cost at pay-as-you-go prices. Informational, never counted toward caps. */
    equivalentUsd: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
}

/** A short account snapshot for cards and meters. */
export interface AccountBrief {
    usdBalance: string | null;
    /** Share of the subscription quota used, 0..1, per window; null when there is no subscription or no data. */
    subscription: { dailyUsed: number | null; weeklyUsed: number | null } | null;
    fetchedAt: number;
}

/** What `NANOVIA_API.mgmt.status()` tells about the Management token: nothing else (no value, no keys, no presets). */
export interface MgmtBrief {
    /** A token is stored on the server for this user. */
    present: boolean;
    /** NanoGPT recognised it at the last contact; false = rejected (revoked, expired, mistyped); null = not known. */
    valid: boolean | null;
}

/** One finding of a check; `code` + `params` are turned into text by the consumer's own i18n. */
export interface AdviceIssue {
    code:
        | 'reasoning.alwaysOn'
        | 'reasoning.policyOn'
        | 'billing.bypassesSubscription'
        | 'memory.overlapsQvink'
        | 'route.pluginDown'
        | 'model.unknown';
    severity: 'info' | 'warn';
    params?: Record<string, string | number | boolean>;
}

/** Advice for using a profile as a background profile (extraction, summaries, JSON tasks). */
export interface BackgroundAdvice {
    /** true when no issue is a warning (information notes alone keep it true). */
    ok: boolean;
    issues: AdviceIssue[];
    /** Catalog ids that reason optionally and support structured output: good for background work. */
    suggestedModels: string[];
}

/**
 * `globalThis.NANOVIA_API`. `version` stays 1; members are only ever added; consumers feature-detect through
 * `features` (strings: 'connections', 'describeProfile', 'describeUrl', 'usage', 'account', 'advice', 'panel', plus the
 * ids of the panel tabs that run) or the member itself.
 * Installed after the extension is ready; `NANOVIA_API_READY_EVENT` is dispatched on `window` once it is.
 */
export interface NanoviaApi {
    version: 1;
    nanoviaVersion: string;
    features: string[];
    connections(): ConnectionSummary[];
    /** null when the profile is not a Nanovia connection. */
    describeProfile(profileId: string): ProfileDescription | null;
    /**
     * Same as describeProfile for a Chat Completion `custom_url` (what ST's live connection carries when no profile id is
     * known): the proxy URL of a Nanovia connection resolves to its description, anything else to null.
     */
    describeUrl?(apiUrl: string): ProfileDescription | null;
    /**
     * feature 'usage': what the proxy or the browser hook has seen; sync reads from an in-memory window.
     * `today()` is the plugin's log since local midnight plus what the browser saw (it may start a background reload of
     * the plugin's part, at most once a minute); `recent` lists the browser's latest requests, newest first (default 50).
     */
    usage?: {
        today(): UsageTotals;
        recent(limit?: number): UsageRecord[];
        onRecord(listener: (record: UsageRecord) => void): () => void;
    };
    /** feature 'account': the last known balance and subscription state, refreshed by the panel. */
    account?: {
        snapshot(): AccountBrief | null;
        refresh(): Promise<AccountBrief | null>;
    };
    /**
     * feature 'mgmt': whether a Management token is stored and whether NanoGPT last accepted it. Sync, from what the
     * panel last read (`present: false, valid: null` until the first answer; a read starts in the background).
     */
    mgmt?: {
        status(): MgmtBrief;
    };
    /** feature 'advice': null when the profile is not a Nanovia connection. */
    advice?: {
        backgroundProfile(profileId: string): BackgroundAdvice | null;
    };
    /** feature 'panel': opens the Nanovia panel (optionally at a tab id such as 'connections', 'catalog', 'account'). */
    openPanel?(tab?: string): void;
}
