// Stage 0.6 contracts: NanoGPT's Management API (API keys with limits, model presets). Types only; the only import is the
// core contracts. The pure logic lives in src/domain/mgmt.ts; the plugin routes in src/server/routes/mgmt.ts.
//
// The Management API (https://docs.nano-gpt.com/api-reference/management-api, contract
// https://nano-gpt.com/management-openapi.json, version 2026-09-09-beta) is a separate surface from the inference API:
//   base   https://nano-gpt.com/api/management/v1        no CORS: only the plugin can call it
//   auth   Authorization: Bearer sk-nano-mgmt-<...>      a Management token, made by hand under Settings > Security
// A Management token has scopes (usage:read, api_keys:read|write, model_presets:read|write); `write` includes `read`.
// What it can do that matters here: list, create, change the limits of and revoke inference keys, and keep model presets
// (a named bundle of model + system prompt + sampling that an inference request can call as `presets/<name>`).
// What it cannot do: it never returns a key's secret or any part of it after creation, and it reports no usage per key.
// That is why ManagedKey has no masked tail and no "spent so far".
//
// The wire format is snake_case with twelve flat limit fields and ISO dates; the contract below is camelCase, the limits
// grouped by kind and period, dates in ms since epoch (like the other contract files). domain/mgmt.ts converts both ways.

import type { ReasoningEffort } from './contracts';

/* ------------------------------------------------------------------------------------------------ token and status */

export type MgmtScope =
    'usage:read' | 'api_keys:read' | 'api_keys:write' | 'model_presets:read' | 'model_presets:write';

/** Why the last check of the token failed (a code, never a message and never a secret). */
export type MgmtErrorCode =
    'mgmt_token_invalid' | 'upstream_unreachable' | 'upstream_timeout' | 'upstream_error' | 'rate_limited';

/**
 * What the plugin knows about the user's Management token. The token itself is write-only: no route returns it, not
 * even masked. `valid` is the outcome of the last contact with NanoGPT: true = NanoGPT recognised the token (it may still
 * lack the scope of a particular call: those calls answer `mgmt_scope_missing`), false = rejected (revoked, expired after
 * its 90 days, mistyped), null = never checked or the check could not reach NanoGPT.
 */
export interface MgmtStatus {
    present: boolean;
    valid: boolean | null;
    /** ms since epoch of that contact; null when there was none. */
    checkedAt: number | null;
    error: MgmtErrorCode | null;
}

/* ------------------------------------------------------------------------------------------------ keys */

/** What a limit counts. requests: calls; usd: real balance spend; inputTokens: input token units (a 2x model counts twice). */
export type KeyLimitKind = 'requests' | 'usd' | 'inputTokens' | 'subscriptionInputTokens';

/** UTC calendar windows, not rolling: day from 00:00, week from Monday 00:00, month from the 1st 00:00. */
export type KeyLimitPeriod = 'daily' | 'weekly' | 'monthly';

/** One limit per period; null = unlimited, 0 = a real limit that blocks the key. */
export type PeriodLimits = Record<KeyLimitPeriod, number | null>;

/**
 * The twelve per-key limits. Wire names: requests = daily_rpd_limit / weekly_request_limit / monthly_request_limit;
 * usd = *_usd_limit (dollars, steps of 0.0001, up to 100000); inputTokens = *_input_token_limit;
 * subscriptionInputTokens = *_subscription_input_token_limit (the part of the subscription allowance the key may use).
 * Requests and token limits are integers; daily requests up to 10,000,000, the others up to 2,147,483,647.
 * A request the subscription covers skips the USD limits (no balance is spent); the other three still count.
 */
export type KeyLimits = Record<KeyLimitKind, PeriodLimits>;

/**
 * zdr: zero-data-retention routes only; off: anonymized routing (any route); unset: a legacy key from before the policy
 * existed (a new key cannot be created with it).
 */
export type KeyZdrPolicy = 'zdr' | 'off' | 'unset';

/** One inference key as the Management API lists it. The secret is never part of it. */
export interface ManagedKey {
    /** NanoGPT's numeric id as a string ("12"). Not the id of an ST secret. */
    id: string;
    name: string;
    /** An expired key stays listed (and readable); a revoked one disappears. */
    status: 'active' | 'expired';
    createdAt: number | null;
    /** null = never. */
    expiresAt: number | null;
    limits: KeyLimits;
    zdrPolicy: KeyZdrPolicy | null;
}

/**
 * A change to a key (PATCH: a field left out stays as it is, `null` clears a limit or the expiry). `limits` is merged per
 * kind and per period, so `{ usd: { monthly: 20 } }` leaves everything else alone. At least one field is required.
 */
export interface KeyLimitsPatch {
    /** 1 to 120 characters, not blank. */
    name?: string;
    expiresAt?: number | null;
    zdrPolicy?: KeyZdrPolicy;
    limits?: { [K in KeyLimitKind]?: Partial<PeriodLimits> };
}

/** A new key (POST). Limits left out are unlimited. */
export interface KeyCreateInput {
    name: string;
    expiresAt?: number | null;
    zdrPolicy?: 'zdr' | 'off';
    limits?: { [K in KeyLimitKind]?: Partial<PeriodLimits> };
}

export interface ManagedKeyList {
    keys: ManagedKey[];
    fetchedAt: number;
}

/** What creating a key returns. The new key's secret went straight into ST's secret store; it is not part of the answer. */
export interface ManagedKeyCreated {
    key: ManagedKey;
    /** Id of the ST secret (under `api_key_nanogpt`) that holds the new key: what `ConnectionConfig.keyId` takes. */
    secretId: string;
}

/* ------------------------------------------------------------------------------------------------ model presets */

export type PresetResponseFormat = 'text' | 'json_object';
export type PresetReasoningSummary = 'auto' | 'concise' | 'detailed';
export type PresetVerbosity = 'low' | 'medium' | 'high';
/** `provider_routing_preference`. flex / priority service tiers cannot be combined with speed, throughput, latency or price. */
export type PresetRouting = 'auto' | 'speed' | 'throughput' | 'latency' | 'price' | 'caching';
export type PresetServiceTier = 'auto' | 'default' | 'flex' | 'priority' | 'ultrafast';

/** `thinking`: a boolean or `{ type: 'enabled', budget_tokens }` on the wire. */
export interface PresetThinking {
    enabled: boolean;
    /** 1 to 1,000,000; null = the model's own. */
    budgetTokens: number | null;
}

/** `prompt_caching`: a boolean or `{ enabled, ttl }` on the wire. */
export interface PresetCaching {
    enabled: boolean;
    ttl: '5m' | '1h' | null;
}

/**
 * Everything a preset saves besides its name and model. null = not set: the request's own value, or the model's default,
 * applies (a preset only holds defaults; what a request sends wins). A provider object, BYOK credentials and fallback
 * model lists cannot be saved in a preset.
 */
export interface PresetSettings {
    /** Up to 12,000 characters. */
    systemPrompt: string | null;
    /** 1 to 1,000,000. */
    maxTokens: number | null;
    /** 0 to 1,000,000. */
    topK: number | null;
    /** 0 to 2. */
    temperature: number | null;
    /** 0 to 1. */
    topP: number | null;
    /** 0 to 1. */
    minP: number | null;
    /** 0 to 1. */
    topA: number | null;
    /** -2 to 2. */
    frequencyPenalty: number | null;
    /** -2 to 2. */
    presencePenalty: number | null;
    /** -2 to 2. */
    repetitionPenalty: number | null;
    responseFormat: PresetResponseFormat | null;
    /** true needs `responseFormat: 'json_object'`. */
    structuredOutputs: boolean | null;
    reasoningEffort: ReasoningEffort | null;
    reasoningSummary: PresetReasoningSummary | null;
    verbosity: PresetVerbosity | null;
    routing: PresetRouting | null;
    serviceTier: PresetServiceTier | null;
    thinking: PresetThinking | null;
    promptCaching: PresetCaching | null;
}

/** A preset the Management API holds (dashboard presets are not part of the API's list). */
export interface ModelPreset extends PresetSettings {
    /** `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`, case-insensitive; NanoGPT returns it lower-case. An inference request says `presets/<name>`. */
    name: string;
    /** A model id (1 to 256 characters), not another preset. */
    model: string;
    createdAt: number | null;
    updatedAt: number | null;
}

/** What a client sends for a preset. A PUT replaces the whole preset: a setting left out becomes null. */
export type PresetInput = Partial<PresetSettings> & { model: string };

/** The body of `POST /mgmt/presets`. */
export type PresetCreateInput = PresetInput & { name: string };

/* ------------------------------------------------------------------------------------------------ admin API */
// Served by the plugin under PLUGIN_ADMIN_BASE (behind ST's session and CSRF check), JSON in and out, errors as in
// contracts.ts. The Management token lives only in the plugin (`<user root>/nanovia/mgmt.json`, mode 0600 where the OS
// has one); no route returns it and no log line or error message contains it.
//
//   GET    /mgmt/status[?verify=1]  -> MgmtStatus       no NanoGPT call unless `verify=1` (then one read call, result stored)
//   PUT    /mgmt/token              body { token: string }                      -> MgmtStatus
//                                    Checks the shape (`sk-nano-mgmt-` prefix), then proves the token with one read call
//                                    (GET /api-keys); stores it only when NanoGPT recognised it, unless `?force=1`.
//   DELETE /mgmt/token              -> { ok: true }     (also when none was stored)
//   GET    /mgmt/keys               -> ManagedKeyList                           needs api_keys:read
//   POST   /mgmt/keys               body KeyCreateInput                         -> ManagedKeyCreated   needs api_keys:write
//   PATCH  /mgmt/keys/:id           body KeyLimitsPatch                         -> { key: ManagedKey } needs api_keys:write
//   DELETE /mgmt/keys/:id           -> { ok: true }     revokes the key for good (it stops working at once) needs api_keys:write
//   GET    /mgmt/presets            -> { presets: ModelPreset[]; fetchedAt: number }  needs model_presets:read
//   POST   /mgmt/presets            body PresetCreateInput                      -> { preset: ModelPreset }   (409 when the name is taken)
//   PUT    /mgmt/presets/:name      body PresetInput                            -> { preset: ModelPreset }   (create or full replace)
//   DELETE /mgmt/presets/:name      -> { ok: true }     (also when it was already gone)
//
// Errors (contracts.ts shape `{ error: { code, message } }`). Nothing here answers 401 or 403: ST's own front end treats
// those as "log in again".
//   409 mgmt_token_missing   no token is stored for this user (every route but status, PUT and DELETE of the token)
//   502 mgmt_token_invalid   NanoGPT answered 401: the token is revoked, expired or wrong (the stored status turns to valid:false)
//   409 mgmt_scope_missing   NanoGPT answered 403 insufficient_scope: the token lacks the scope the route needs (message says which)
//   400 mgmt_token_malformed PUT /mgmt/token: not a `sk-nano-mgmt-` token (message says what is wrong, never echoes it)
//   400 invalid_request      the body or the id failed validation (message lists `field: problem`); NanoGPT was not called
//   404 not_found            unknown key id / preset name
//   409 preset_exists        POST /mgmt/presets with a name that is taken
//   409 <code>               NanoGPT's own conflict code (`preset_limit_reached`, `preset_name_conflict`, `idempotency_key_reused`)
//   413 payload_too_large    a preset body above 16 KiB
//   429 rate_limited         NanoGPT is rate limiting the token
//   503 secrets_unavailable  POST /mgmt/keys while ST's secret store is down (the key is not created)
//   500 secrets_failed       POST /mgmt/keys created the key but ST refused to store it (revoke it from the list)
//   502 upstream_unreachable | 504 upstream_timeout | 502 upstream_error | 502 bad_response   transport and NanoGPT trouble
