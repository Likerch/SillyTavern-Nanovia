// Typed calls of the stage 0.6 admin routes (src/shared/contracts-mgmt.ts, "admin API"): the Management token (write-only),
// the inference keys it manages and the model presets. Built on the plugin client's raw `request`, so the same rules hold:
// nothing throws, a dead plugin is an ordinary error value, and an answer that is not what the contract says becomes
// `invalid_response` instead of a half-filled object. On top of that the `mgmt_*` error codes (and the other codes of the
// route table) are mapped to a small closed set of kinds the UI can switch on.
//
// The token goes out in the body of `saveToken` and nowhere else; no method returns it, and an error message that
// happens to contain it (the plugin never does that) is scrubbed here as well.
import {
    CACHE_TTLS,
    KEY_LIMIT_KINDS,
    KEY_LIMIT_PERIODS,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    RESPONSE_FORMATS,
    ROUTINGS,
    SERVICE_TIERS,
    VERBOSITIES,
    ZDR_POLICIES,
} from '../domain/mgmt';
import { isRecord } from '../domain/usage';
import type {
    KeyCreateInput,
    KeyLimits,
    KeyLimitsPatch,
    ManagedKey,
    ManagedKeyCreated,
    ManagedKeyList,
    MgmtErrorCode,
    MgmtScope,
    MgmtStatus,
    ModelPreset,
    PresetCaching,
    PresetCreateInput,
    PresetInput,
    PresetThinking,
} from '../shared/contracts-mgmt';
import type { PluginClient, PluginError } from './plugin-client';

/** Why a Management call failed, as a closed set the UI switches on. `code` and `message` keep the plugin's own words. */
export type MgmtErrorKind =
    /** The plugin does not answer (stopped, network down, timeout). */
    | 'plugin_down'
    /** ST answered 404 to the route: the plugin is not installed, not loaded, or too old to know Management. */
    | 'not_installed'
    /** ST's session or CSRF check refused the call (401/403 from ST itself). */
    | 'forbidden'
    /** No Management token is stored (409 mgmt_token_missing). */
    | 'token_missing'
    /** NanoGPT rejected the stored token: revoked, expired, wrong (502 mgmt_token_invalid). */
    | 'token_invalid'
    /** The token lacks the scope this call needs (409 mgmt_scope_missing); `scope` names it. */
    | 'scope_missing'
    /** `saveToken`: not a `sk-nano-mgmt-` token (400 mgmt_token_malformed). */
    | 'token_malformed'
    | 'rate_limited'
    /** The plugin refused the input (400 invalid_request); the message lists `field: problem`. */
    | 'invalid_request'
    | 'not_found'
    /** POST /mgmt/presets with a name that is taken (409 preset_exists). */
    | 'preset_exists'
    /** Any other 409: NanoGPT's own conflict (`preset_limit_reached`, `preset_name_conflict` …); see `code`. */
    | 'conflict'
    | 'too_large'
    /** POST /mgmt/keys while ST's secret store is down: no key was made. */
    | 'secrets_unavailable'
    /** POST /mgmt/keys made the key but ST could not store its secret: revoke it from the list. */
    | 'secrets_failed'
    /** NanoGPT could not be reached, timed out or answered something unusable (502/504). */
    | 'upstream'
    /** The plugin's answer was not what the contract says. */
    | 'invalid_response'
    | 'other';

export interface MgmtError {
    kind: MgmtErrorKind;
    /** The plugin's error code (`mgmt_scope_missing`, `preset_limit_reached` …) or the client's (`unreachable`, `http_500`). */
    code: string;
    /** The plugin's English message; for logs and details, the UI words its own text per kind. */
    message: string;
    /** HTTP status, null when there was no answer. */
    status: number | null;
    /** `scope_missing` only: the scope the call needed. */
    scope?: MgmtScope;
}

export type MgmtResult<T> = { ok: true; data: T } | { ok: false; error: MgmtError };

/** True for the errors that mean "the plugin itself is not there", as opposed to NanoGPT or the input being the problem. */
export function isMgmtPluginDown(error: MgmtError): boolean {
    return error.kind === 'plugin_down' || error.kind === 'not_installed' || error.kind === 'forbidden';
}

export interface PluginMgmt {
    /** GET /mgmt/status. `verify` asks NanoGPT once (a read call) and stores the verdict; without it NanoGPT is not called. */
    status(options?: { verify?: boolean }): Promise<MgmtResult<MgmtStatus>>;
    /**
     * PUT /mgmt/token. The plugin checks the shape, proves the token with NanoGPT and stores it only when NanoGPT knows it.
     * `force` stores it even when NanoGPT could not be asked (never for a token NanoGPT rejected). The token is sent once
     * and not kept; nothing here returns it.
     */
    saveToken(token: string, options?: { force?: boolean }): Promise<MgmtResult<MgmtStatus>>;
    /** DELETE /mgmt/token (also when none was stored). */
    deleteToken(): Promise<MgmtResult<true>>;
    listKeys(): Promise<MgmtResult<ManagedKeyList>>;
    /** The new key's secret goes straight into ST's secret store; the answer carries only its id. */
    createKey(input: KeyCreateInput): Promise<MgmtResult<ManagedKeyCreated>>;
    updateKey(id: string, patch: KeyLimitsPatch): Promise<MgmtResult<ManagedKey>>;
    /** Revokes the key for good. */
    revokeKey(id: string): Promise<MgmtResult<true>>;
    listPresets(): Promise<MgmtResult<{ presets: ModelPreset[]; fetchedAt: number }>>;
    /** 409 `preset_exists` when the name is taken. */
    createPreset(input: PresetCreateInput): Promise<MgmtResult<ModelPreset>>;
    /** Creates or fully replaces the preset. */
    replacePreset(name: string, input: PresetInput): Promise<MgmtResult<ModelPreset>>;
    /** Also succeeds when the preset was already gone. */
    deletePreset(name: string): Promise<MgmtResult<true>>;
}

export interface PluginMgmtDeps {
    client: Pick<PluginClient, 'request'>;
    now?: () => number;
}

/** NanoGPT answers within 15 s on the plugin's side; the browser waits a little longer than that. */
const CALL_TIMEOUT_MS = 20_000;
/** A key create is retried once by the plugin when the answer is lost. */
const CREATE_TIMEOUT_MS = 40_000;

const SCOPES: readonly MgmtScope[] = [
    'usage:read',
    'api_keys:read',
    'api_keys:write',
    'model_presets:read',
    'model_presets:write',
];
const ERROR_CODES: readonly MgmtErrorCode[] = [
    'mgmt_token_invalid',
    'upstream_unreachable',
    'upstream_timeout',
    'upstream_error',
    'rate_limited',
];

/* ------------------------------------------------------------------------------------------------ reading */

function numberOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    return typeof value === 'string' ? (allowed.find((item) => item === value) ?? null) : null;
}

function flag(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function text(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function invalid(what: string): MgmtResult<never> {
    return {
        ok: false,
        error: { kind: 'invalid_response', code: 'invalid_response', message: `unexpected ${what}`, status: null },
    };
}

/** `GET /mgmt/status` as the contract has it. null when it is not a status. */
export function parseMgmtStatus(raw: unknown): MgmtStatus | null {
    if (!isRecord(raw) || typeof raw['present'] !== 'boolean') return null;
    // A token that is not there has no verdict: whatever else the answer says is dropped.
    if (!raw['present']) return { present: false, valid: null, checkedAt: null, error: null };
    return {
        present: true,
        valid: flag(raw['valid']),
        checkedAt: numberOf(raw['checkedAt']),
        error: pick(raw['error'], ERROR_CODES),
    };
}

function parseLimits(raw: unknown): KeyLimits {
    const source = isRecord(raw) ? raw : {};
    const limits: KeyLimits = {
        requests: { daily: null, weekly: null, monthly: null },
        usd: { daily: null, weekly: null, monthly: null },
        inputTokens: { daily: null, weekly: null, monthly: null },
        subscriptionInputTokens: { daily: null, weekly: null, monthly: null },
    };
    for (const kind of KEY_LIMIT_KINDS) {
        const periods = source[kind];
        if (!isRecord(periods)) continue;
        for (const period of KEY_LIMIT_PERIODS) {
            const value = numberOf(periods[period]);
            limits[kind][period] = value !== null && value >= 0 ? value : null;
        }
    }
    return limits;
}

/** One key of the contract (`ManagedKey`). null when it has no usable id. */
export function parseManagedKey(raw: unknown): ManagedKey | null {
    if (!isRecord(raw)) return null;
    const rawId = raw['id'];
    const id = typeof rawId === 'string' ? rawId.trim() : typeof rawId === 'number' ? String(rawId) : '';
    if (!id) return null;
    return {
        id,
        name: text(raw['name']) ?? '',
        status: raw['status'] === 'expired' ? 'expired' : 'active',
        createdAt: numberOf(raw['createdAt']),
        expiresAt: numberOf(raw['expiresAt']),
        limits: parseLimits(raw['limits']),
        zdrPolicy: pick(raw['zdrPolicy'], ZDR_POLICIES),
    };
}

function parseKeys(raw: unknown): ManagedKey[] | null {
    if (!Array.isArray(raw)) return null;
    const seen = new Set<string>();
    const keys: ManagedKey[] = [];
    for (const item of raw) {
        const key = parseManagedKey(item);
        if (!key || seen.has(key.id)) continue;
        seen.add(key.id);
        keys.push(key);
    }
    return keys;
}

function parseThinking(raw: unknown): PresetThinking | null {
    if (!isRecord(raw) || typeof raw['enabled'] !== 'boolean') return null;
    const budget = numberOf(raw['budgetTokens']);
    return {
        enabled: raw['enabled'],
        budgetTokens: budget !== null && Number.isInteger(budget) && budget > 0 ? budget : null,
    };
}

function parseCaching(raw: unknown): PresetCaching | null {
    if (!isRecord(raw) || typeof raw['enabled'] !== 'boolean') return null;
    return { enabled: raw['enabled'], ttl: pick(raw['ttl'], CACHE_TTLS) };
}

/** One preset of the contract (`ModelPreset`). null when it has no usable name. */
export function parseModelPreset(raw: unknown): ModelPreset | null {
    if (!isRecord(raw)) return null;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    if (!name) return null;
    return {
        name,
        model: text(raw['model']) ?? '',
        systemPrompt: text(raw['systemPrompt']),
        maxTokens: numberOf(raw['maxTokens']),
        topK: numberOf(raw['topK']),
        temperature: numberOf(raw['temperature']),
        topP: numberOf(raw['topP']),
        minP: numberOf(raw['minP']),
        topA: numberOf(raw['topA']),
        frequencyPenalty: numberOf(raw['frequencyPenalty']),
        presencePenalty: numberOf(raw['presencePenalty']),
        repetitionPenalty: numberOf(raw['repetitionPenalty']),
        responseFormat: pick(raw['responseFormat'], RESPONSE_FORMATS),
        structuredOutputs: flag(raw['structuredOutputs']),
        reasoningEffort: pick(raw['reasoningEffort'], REASONING_EFFORTS),
        reasoningSummary: pick(raw['reasoningSummary'], REASONING_SUMMARIES),
        verbosity: pick(raw['verbosity'], VERBOSITIES),
        routing: pick(raw['routing'], ROUTINGS),
        serviceTier: pick(raw['serviceTier'], SERVICE_TIERS),
        thinking: parseThinking(raw['thinking']),
        promptCaching: parseCaching(raw['promptCaching']),
        createdAt: numberOf(raw['createdAt']),
        updatedAt: numberOf(raw['updatedAt']),
    };
}

function parsePresets(raw: unknown): ModelPreset[] | null {
    if (!Array.isArray(raw)) return null;
    const seen = new Set<string>();
    const presets: ModelPreset[] = [];
    for (const item of raw) {
        const preset = parseModelPreset(item);
        if (!preset || seen.has(preset.name)) continue;
        seen.add(preset.name);
        presets.push(preset);
    }
    return presets;
}

/* ------------------------------------------------------------------------------------------------ errors */

/** The scope an error message names (`The Management token lacks the api_keys:write scope`), or null. */
function scopeIn(message: string): MgmtScope | null {
    return SCOPES.find((scope) => message.includes(scope)) ?? null;
}

/** Maps what the plugin client reports to a kind the UI switches on. `needed` is the scope the call required. */
export function mgmtErrorOf(error: PluginError, needed?: MgmtScope, secret?: string): MgmtError {
    // The plugin never echoes a token; this only guards against a proxy or a future change doing it. A very short value is
    // not scrubbed (it would eat ordinary words), and the shape check refuses those anyway.
    const message = secret && secret.length >= 8 ? error.message.split(secret).join('…') : error.message;
    const base = { code: error.code, message, status: error.status };
    switch (error.code) {
        case 'unreachable':
        case 'timeout':
            return { ...base, kind: 'plugin_down' };
        case 'not_installed':
            return { ...base, kind: 'not_installed' };
        case 'forbidden':
            return { ...base, kind: 'forbidden' };
        case 'invalid_response':
            return { ...base, kind: 'invalid_response' };
        case 'mgmt_token_missing':
            return { ...base, kind: 'token_missing' };
        case 'mgmt_token_invalid':
            return { ...base, kind: 'token_invalid' };
        case 'mgmt_scope_missing': {
            const scope = scopeIn(message) ?? needed;
            return scope ? { ...base, kind: 'scope_missing', scope } : { ...base, kind: 'scope_missing' };
        }
        case 'mgmt_token_malformed':
            return { ...base, kind: 'token_malformed' };
        case 'invalid_request':
            return { ...base, kind: 'invalid_request' };
        case 'not_found':
            return { ...base, kind: 'not_found' };
        case 'preset_exists':
            return { ...base, kind: 'preset_exists' };
        case 'payload_too_large':
            return { ...base, kind: 'too_large' };
        case 'rate_limited':
            return { ...base, kind: 'rate_limited' };
        case 'secrets_unavailable':
            return { ...base, kind: 'secrets_unavailable' };
        case 'secrets_failed':
            return { ...base, kind: 'secrets_failed' };
        case 'upstream_unreachable':
        case 'upstream_timeout':
        case 'upstream_error':
        case 'bad_response':
            return { ...base, kind: 'upstream' };
        default:
            return { ...base, kind: error.status === 409 ? 'conflict' : 'other' };
    }
}

/* ------------------------------------------------------------------------------------------------ client */

export function createPluginMgmt(deps: PluginMgmtDeps): PluginMgmt {
    const { client } = deps;
    const now = deps.now ?? Date.now;

    /** One call: the plugin client's result with its error mapped and its data read by `read` (null = not what we expect). */
    async function call<T>(
        method: string,
        path: string,
        options: { body?: unknown; timeoutMs?: number; needed?: MgmtScope; secret?: string },
        read: (data: unknown) => T | null,
        what: string,
    ): Promise<MgmtResult<T>> {
        const result = await client.request(method, path, {
            ...(options.body !== undefined ? { body: options.body } : {}),
            timeoutMs: options.timeoutMs ?? CALL_TIMEOUT_MS,
        });
        if (!result.ok) return { ok: false, error: mgmtErrorOf(result.error, options.needed, options.secret) };
        const value = read(result.data);
        return value === null ? invalid(what) : { ok: true, data: value };
    }

    const acknowledged = (data: unknown): true | null => (isRecord(data) && data['ok'] === true ? true : null);

    const keyOf = (data: unknown): ManagedKey | null => (isRecord(data) ? parseManagedKey(data['key']) : null);

    const presetOf = (data: unknown): ModelPreset | null => (isRecord(data) ? parseModelPreset(data['preset']) : null);

    return {
        status(options) {
            const path = `/mgmt/status${options?.verify ? '?verify=1' : ''}`;
            return call('GET', path, {}, parseMgmtStatus, 'status');
        },

        saveToken(token, options) {
            const path = `/mgmt/token${options?.force ? '?force=1' : ''}`;
            return call('PUT', path, { body: { token }, secret: token }, parseMgmtStatus, 'status');
        },

        deleteToken() {
            return call('DELETE', '/mgmt/token', {}, acknowledged, 'acknowledgement');
        },

        listKeys() {
            return call(
                'GET',
                '/mgmt/keys',
                { needed: 'api_keys:read' },
                (data) => {
                    const keys = isRecord(data) ? parseKeys(data['keys']) : null;
                    return keys
                        ? { keys, fetchedAt: (isRecord(data) ? numberOf(data['fetchedAt']) : null) ?? now() }
                        : null;
                },
                'key list',
            );
        },

        createKey(input) {
            return call(
                'POST',
                '/mgmt/keys',
                { body: input, timeoutMs: CREATE_TIMEOUT_MS, needed: 'api_keys:write' },
                (data) => {
                    if (!isRecord(data)) return null;
                    const key = parseManagedKey(data['key']);
                    const secretId = text(data['secretId']);
                    return key && secretId ? { key, secretId } : null;
                },
                'created key',
            );
        },

        updateKey(id, patch) {
            return call(
                'PATCH',
                `/mgmt/keys/${encodeURIComponent(id)}`,
                { body: patch, needed: 'api_keys:write' },
                keyOf,
                'key',
            );
        },

        revokeKey(id) {
            return call(
                'DELETE',
                `/mgmt/keys/${encodeURIComponent(id)}`,
                { needed: 'api_keys:write' },
                acknowledged,
                'acknowledgement',
            );
        },

        listPresets() {
            return call(
                'GET',
                '/mgmt/presets',
                { needed: 'model_presets:read' },
                (data) => {
                    const presets = isRecord(data) ? parsePresets(data['presets']) : null;
                    return presets
                        ? { presets, fetchedAt: (isRecord(data) ? numberOf(data['fetchedAt']) : null) ?? now() }
                        : null;
                },
                'preset list',
            );
        },

        createPreset(input) {
            return call('POST', '/mgmt/presets', { body: input, needed: 'model_presets:write' }, presetOf, 'preset');
        },

        replacePreset(name, input) {
            return call(
                'PUT',
                `/mgmt/presets/${encodeURIComponent(name)}`,
                { body: input, needed: 'model_presets:write' },
                presetOf,
                'preset',
            );
        },

        deletePreset(name) {
            return call(
                'DELETE',
                `/mgmt/presets/${encodeURIComponent(name)}`,
                { needed: 'model_presets:write' },
                acknowledged,
                'acknowledgement',
            );
        },
    };
}
