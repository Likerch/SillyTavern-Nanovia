// NanoGPT's Management API in pure functions (contracts-mgmt.ts): the shape check of a Management token, the tolerant
// reading of the API's payloads (snake_case, flat limits, ISO dates) into the contract types, and the strict checking of
// what a client wants to write (key limits, presets) before anything is sent. Untrusted JSON in, plain data out.
// Source of the field names, ranges and rules: https://nano-gpt.com/management-openapi.json (2026-09-09-beta) and
// https://docs.nano-gpt.com/api-reference/management-api and .../miscellaneous/model-presets.
import { MGMT_TOKEN_PREFIX } from '../shared/constants';
import type { ReasoningEffort } from '../shared/contracts';
import type {
    KeyCreateInput,
    KeyLimitKind,
    KeyLimitPeriod,
    KeyLimits,
    KeyLimitsPatch,
    KeyZdrPolicy,
    ManagedKey,
    ModelPreset,
    PeriodLimits,
    PresetCaching,
    PresetInput,
    PresetReasoningSummary,
    PresetResponseFormat,
    PresetRouting,
    PresetServiceTier,
    PresetSettings,
    PresetThinking,
    PresetVerbosity,
} from '../shared/contracts-mgmt';
import { isRecord } from './usage';

/* ------------------------------------------------------------------------------------------------ token */

/** Characters after the prefix. The real length is not documented; this only turns away obvious fragments. */
export const MGMT_TOKEN_MIN_BODY = 8;
export const MGMT_TOKEN_MAX_LENGTH = 512;

export type MgmtTokenIssue =
    'not_string' | 'empty' | 'inference_key' | 'prefix' | 'too_short' | 'too_long' | 'characters';

export type TokenCheck = { ok: true; token: string } | { ok: false; issue: MgmtTokenIssue };

/**
 * The shape of a Management token: `sk-nano-mgmt-` plus at least MGMT_TOKEN_MIN_BODY printable characters, no spaces, at
 * most MGMT_TOKEN_MAX_LENGTH in all. Surrounding whitespace (a pasted newline) is dropped. A normal inference key
 * (`sk-nano-<uuid>`) is told apart, because pasting it into the wrong box is the likely mistake.
 */
export function checkMgmtToken(raw: unknown): TokenCheck {
    if (typeof raw !== 'string') return { ok: false, issue: 'not_string' };
    const token = raw.trim();
    if (!token) return { ok: false, issue: 'empty' };
    if (token.length > MGMT_TOKEN_MAX_LENGTH) return { ok: false, issue: 'too_long' };
    if (!token.startsWith(MGMT_TOKEN_PREFIX)) {
        return { ok: false, issue: token.startsWith('sk-nano-') ? 'inference_key' : 'prefix' };
    }
    if (!/^[!-~]+$/.test(token)) return { ok: false, issue: 'characters' };
    if (token.length - MGMT_TOKEN_PREFIX.length < MGMT_TOKEN_MIN_BODY) return { ok: false, issue: 'too_short' };
    return { ok: true, token };
}

/** English text for an issue; never contains the value. */
export function describeTokenIssue(issue: MgmtTokenIssue): string {
    switch (issue) {
        case 'not_string':
            return '"token" must be a string';
        case 'empty':
            return '"token" is empty';
        case 'inference_key':
            return `This is an inference API key. A Management token starts with ${MGMT_TOKEN_PREFIX}`;
        case 'prefix':
            return `A Management token starts with ${MGMT_TOKEN_PREFIX}`;
        case 'too_short':
            return 'The token is too short';
        case 'too_long':
            return 'The token is too long';
        case 'characters':
            return 'The token must not contain spaces or special characters';
    }
}

/* ------------------------------------------------------------------------------------------------ tables */

export const KEY_LIMIT_KINDS: readonly KeyLimitKind[] = ['requests', 'usd', 'inputTokens', 'subscriptionInputTokens'];
export const KEY_LIMIT_PERIODS: readonly KeyLimitPeriod[] = ['daily', 'weekly', 'monthly'];

/** Wire field names of the twelve limits. */
export const KEY_LIMIT_FIELDS: Record<KeyLimitKind, Record<KeyLimitPeriod, string>> = {
    requests: { daily: 'daily_rpd_limit', weekly: 'weekly_request_limit', monthly: 'monthly_request_limit' },
    usd: { daily: 'daily_usd_limit', weekly: 'weekly_usd_limit', monthly: 'monthly_usd_limit' },
    inputTokens: {
        daily: 'daily_input_token_limit',
        weekly: 'weekly_input_token_limit',
        monthly: 'monthly_input_token_limit',
    },
    subscriptionInputTokens: {
        daily: 'daily_subscription_input_token_limit',
        weekly: 'weekly_subscription_input_token_limit',
        monthly: 'monthly_subscription_input_token_limit',
    },
};

const INT_MAX = 2_147_483_647;

/** What a limit may be: `integer` and the largest value per period (the smallest is 0). USD steps are 0.0001. */
export const KEY_LIMIT_RANGES: Record<KeyLimitKind, { integer: boolean; max: Record<KeyLimitPeriod, number> }> = {
    requests: { integer: true, max: { daily: 10_000_000, weekly: INT_MAX, monthly: INT_MAX } },
    usd: { integer: false, max: { daily: 100_000, weekly: 100_000, monthly: 100_000 } },
    inputTokens: { integer: true, max: { daily: INT_MAX, weekly: INT_MAX, monthly: INT_MAX } },
    subscriptionInputTokens: { integer: true, max: { daily: INT_MAX, weekly: INT_MAX, monthly: INT_MAX } },
};

export const KEY_NAME_MAX_LENGTH = 120;
const USD_STEP = 10_000;

export const ZDR_POLICIES: readonly KeyZdrPolicy[] = ['zdr', 'off', 'unset'];
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];
export const RESPONSE_FORMATS: readonly PresetResponseFormat[] = ['text', 'json_object'];
export const REASONING_SUMMARIES: readonly PresetReasoningSummary[] = ['auto', 'concise', 'detailed'];
export const VERBOSITIES: readonly PresetVerbosity[] = ['low', 'medium', 'high'];
export const ROUTINGS: readonly PresetRouting[] = ['auto', 'speed', 'throughput', 'latency', 'price', 'caching'];
export const SERVICE_TIERS: readonly PresetServiceTier[] = ['auto', 'default', 'flex', 'priority', 'ultrafast'];
export const CACHE_TTLS: readonly ('5m' | '1h')[] = ['5m', '1h'];

export const PRESET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export const PRESET_MODEL_MAX_LENGTH = 256;
export const PRESET_PROMPT_MAX_LENGTH = 12_000;
export const PRESET_BODY_LIMIT_BYTES = 16 * 1024;
export const PRESET_LIMIT = 100;

/* ------------------------------------------------------------------------------------------------ reading */

const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;
/** A Unix timestamp below this is in seconds, at or above it in milliseconds. */
const SECONDS_LIMIT = 1e11;

function numeric(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && DECIMAL.test(value.trim())) return Number(value.trim());
    return null;
}

function epochMs(value: unknown): number | null {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        return value < SECONDS_LIMIT ? Math.round(value * 1000) : value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    if (typeof value !== 'string') return null;
    const wanted = value.trim().toLowerCase();
    return allowed.find((item) => item === wanted) ?? null;
}

function text(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function flag(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

/** The array of a list payload: `{ data: [...] }` (the API's shape), a bare array, or null for anything else. */
function listOf(raw: unknown): unknown[] | null {
    if (Array.isArray(raw)) return raw;
    if (isRecord(raw) && Array.isArray(raw['data'])) return raw['data'];
    return null;
}

function emptyLimits(): KeyLimits {
    const empty = (): PeriodLimits => ({ daily: null, weekly: null, monthly: null });
    return { requests: empty(), usd: empty(), inputTokens: empty(), subscriptionInputTokens: empty() };
}

/** One element of `GET /api-keys`, or the answer of POST/PATCH: tolerant of missing and extra fields. null: no usable id. */
export function normalizeManagedKey(raw: unknown): ManagedKey | null {
    if (!isRecord(raw)) return null;
    const rawId = raw['id'];
    const id =
        typeof rawId === 'number' && Number.isFinite(rawId)
            ? String(rawId)
            : typeof rawId === 'string'
              ? rawId.trim()
              : '';
    if (!id) return null;
    const limits = emptyLimits();
    for (const kind of KEY_LIMIT_KINDS) {
        for (const period of KEY_LIMIT_PERIODS) {
            const value = numeric(raw[KEY_LIMIT_FIELDS[kind][period]]);
            limits[kind][period] = value !== null && value >= 0 ? value : null;
        }
    }
    return {
        id,
        name: typeof raw['name'] === 'string' ? raw['name'] : '',
        status: raw['status'] === 'expired' ? 'expired' : 'active',
        createdAt: epochMs(raw['created_at']),
        expiresAt: epochMs(raw['expires_at']),
        limits,
        zdrPolicy: pick(raw['zdr_policy'], ZDR_POLICIES),
    };
}

/** `GET /api-keys`: every usable key, in the API's order, once per id. null when the payload is not a list at all. */
export function normalizeManagedKeys(raw: unknown): ManagedKey[] | null {
    const items = listOf(raw);
    if (!items) return null;
    const seen = new Set<string>();
    const keys: ManagedKey[] = [];
    for (const item of items) {
        const key = normalizeManagedKey(item);
        if (!key || seen.has(key.id)) continue;
        seen.add(key.id);
        keys.push(key);
    }
    return keys;
}

function readThinking(raw: unknown): PresetThinking | null {
    if (typeof raw === 'boolean') return { enabled: raw, budgetTokens: null };
    if (!isRecord(raw)) return null;
    const budget = numeric(raw['budget_tokens']);
    return {
        enabled: raw['type'] === 'enabled',
        budgetTokens: budget !== null && Number.isInteger(budget) && budget > 0 ? budget : null,
    };
}

function readCaching(raw: unknown): PresetCaching | null {
    if (typeof raw === 'boolean') return { enabled: raw, ttl: null };
    if (!isRecord(raw) || typeof raw['enabled'] !== 'boolean') return null;
    return { enabled: raw['enabled'], ttl: pick(raw['ttl'], CACHE_TTLS) };
}

/** One element of `GET /model-presets` or the answer of PUT. null: no usable name. */
export function normalizeModelPreset(raw: unknown): ModelPreset | null {
    if (!isRecord(raw)) return null;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim().toLowerCase() : '';
    if (!name) return null;
    return {
        name,
        model: typeof raw['model'] === 'string' ? raw['model'] : '',
        systemPrompt: text(raw['system_prompt']),
        maxTokens: numeric(raw['max_tokens']),
        topK: numeric(raw['top_k']),
        temperature: numeric(raw['temperature']),
        topP: numeric(raw['top_p']),
        minP: numeric(raw['min_p']),
        topA: numeric(raw['top_a']),
        frequencyPenalty: numeric(raw['frequency_penalty']),
        presencePenalty: numeric(raw['presence_penalty']),
        repetitionPenalty: numeric(raw['repetition_penalty']),
        responseFormat: pick(raw['response_format_type'], RESPONSE_FORMATS),
        structuredOutputs: flag(raw['structured_outputs']),
        reasoningEffort: pick(raw['reasoning_effort'], REASONING_EFFORTS),
        reasoningSummary: pick(raw['reasoning_summary'], REASONING_SUMMARIES),
        verbosity: pick(raw['verbosity'], VERBOSITIES),
        routing: pick(raw['provider_routing_preference'], ROUTINGS),
        serviceTier: pick(raw['service_tier'], SERVICE_TIERS),
        thinking: readThinking(raw['thinking']),
        promptCaching: readCaching(raw['prompt_caching']),
        createdAt: epochMs(raw['created_at']),
        updatedAt: epochMs(raw['updated_at']),
    };
}

/** `GET /model-presets`: every usable preset, once per name. null when the payload is not a list at all. */
export function normalizeModelPresets(raw: unknown): ModelPreset[] | null {
    const items = listOf(raw);
    if (!items) return null;
    const seen = new Set<string>();
    const presets: ModelPreset[] = [];
    for (const item of items) {
        const preset = normalizeModelPreset(item);
        if (!preset || seen.has(preset.name)) continue;
        seen.add(preset.name);
        presets.push(preset);
    }
    return presets;
}

/* ------------------------------------------------------------------------------------------------ checking */

export type IssueCode =
    | 'required'
    | 'type'
    | 'length'
    | 'enum'
    | 'range'
    | 'integer'
    | 'step'
    | 'unknown_field'
    | 'empty'
    | 'conflict'
    | 'too_large';

/** One problem of a client's input. `field` is a path in the contract (`limits.usd.daily`), `message` English text. */
export interface InputIssue {
    field: string;
    code: IssueCode;
    message: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; issues: InputIssue[] };

/** `field: message; field: message`, at most five, for an error message. */
export function describeIssues(issues: InputIssue[]): string {
    const shown = issues.slice(0, 5).map((issue) => `${issue.field}: ${issue.message}`);
    if (issues.length > shown.length) shown.push(`and ${issues.length - shown.length} more`);
    return shown.join('; ');
}

function checked<T>(value: T, issues: InputIssue[]): Checked<T> {
    return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

/** The keys of `raw` outside `allowed` and `ignored`: one `unknown_field` issue each. */
function rejectUnknown(
    raw: Record<string, unknown>,
    allowed: readonly string[],
    ignored: readonly string[],
    issues: InputIssue[],
): void {
    for (const key of Object.keys(raw)) {
        if (allowed.includes(key) || ignored.includes(key)) continue;
        issues.push({ field: key, code: 'unknown_field', message: 'is not a field of this request' });
    }
}

function checkName(value: unknown, field: string, issues: InputIssue[]): string | null {
    if (typeof value !== 'string') {
        issues.push({ field, code: 'type', message: 'must be a string' });
        return null;
    }
    const name = value.trim();
    if (!name || name.length > KEY_NAME_MAX_LENGTH) {
        issues.push({ field, code: 'length', message: `must be 1 to ${KEY_NAME_MAX_LENGTH} characters, not blank` });
        return null;
    }
    return name;
}

function checkExpiry(value: unknown, issues: InputIssue[]): number | null | undefined {
    if (value === null) return null;
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value <= 0 ||
        !Number.isFinite(new Date(value).getTime())
    ) {
        issues.push({ field: 'expiresAt', code: 'type', message: 'must be null or a time in ms since epoch' });
        return undefined;
    }
    return Math.round(value);
}

function checkPolicy(value: unknown, allowed: readonly KeyZdrPolicy[], issues: InputIssue[]): KeyZdrPolicy | undefined {
    const policy = pick(value, allowed);
    if (policy === null) {
        issues.push({ field: 'zdrPolicy', code: 'enum', message: `must be one of: ${allowed.join(', ')}` });
        return undefined;
    }
    return policy;
}

type LimitsInput = { [K in KeyLimitKind]?: Partial<PeriodLimits> };

function checkLimits(raw: unknown, issues: InputIssue[]): LimitsInput | undefined {
    if (!isRecord(raw)) {
        issues.push({ field: 'limits', code: 'type', message: 'must be an object' });
        return undefined;
    }
    const out: LimitsInput = {};
    for (const key of Object.keys(raw)) {
        const kind = KEY_LIMIT_KINDS.find((k) => k === key);
        if (!kind) {
            issues.push({ field: `limits.${key}`, code: 'unknown_field', message: 'is not a limit kind' });
            continue;
        }
        const periods = raw[kind];
        if (!isRecord(periods)) {
            issues.push({ field: `limits.${kind}`, code: 'type', message: 'must be an object' });
            continue;
        }
        const range = KEY_LIMIT_RANGES[kind];
        const kept: Partial<PeriodLimits> = {};
        for (const name of Object.keys(periods)) {
            const period = KEY_LIMIT_PERIODS.find((p) => p === name);
            const field = `limits.${kind}.${name}`;
            if (!period) {
                issues.push({ field, code: 'unknown_field', message: 'is not a period' });
                continue;
            }
            const value = periods[period];
            if (value === null) {
                kept[period] = null;
                continue;
            }
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                issues.push({ field, code: 'type', message: 'must be null (unlimited) or a number' });
                continue;
            }
            if (range.integer && !Number.isInteger(value)) {
                issues.push({ field, code: 'integer', message: 'must be a whole number' });
                continue;
            }
            const cleaned = range.integer ? value : Math.round(value * USD_STEP) / USD_STEP;
            if (!range.integer && Math.abs(value * USD_STEP - Math.round(value * USD_STEP)) > 1e-6) {
                issues.push({ field, code: 'step', message: 'must be a multiple of 0.0001' });
                continue;
            }
            if (cleaned < 0 || cleaned > range.max[period]) {
                issues.push({ field, code: 'range', message: `must be between 0 and ${range.max[period]}` });
                continue;
            }
            kept[period] = cleaned;
        }
        if (Object.keys(kept).length > 0) out[kind] = kept;
    }
    return out;
}

/** Fields of a ManagedKey a client may send back untouched (an edit form posts the whole key): ignored, not rejected. */
const KEY_READ_ONLY = ['id', 'status', 'createdAt'];

/**
 * Checks a PATCH of a key (KeyLimitsPatch): the name trimmed, USD amounts cleaned of float noise, limits within the
 * API's ranges and steps, the zdr policy one of zdr/off/unset. Unknown fields are refused (a typo must not silently do
 * nothing); the read-only fields of a ManagedKey are ignored. An input that changes nothing is refused: the API needs at
 * least one field.
 */
export function sanitizeKeyLimitsPatch(raw: unknown): Checked<KeyLimitsPatch> {
    if (!isRecord(raw)) return checked({}, [{ field: 'body', code: 'type', message: 'must be a JSON object' }]);
    const issues: InputIssue[] = [];
    rejectUnknown(raw, ['name', 'expiresAt', 'zdrPolicy', 'limits'], KEY_READ_ONLY, issues);
    const patch: KeyLimitsPatch = {};
    if (raw['name'] !== undefined) {
        const name = checkName(raw['name'], 'name', issues);
        if (name !== null) patch.name = name;
    }
    if (raw['expiresAt'] !== undefined) {
        const expiresAt = checkExpiry(raw['expiresAt'], issues);
        if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    }
    if (raw['zdrPolicy'] !== undefined) {
        const policy = checkPolicy(raw['zdrPolicy'], ZDR_POLICIES, issues);
        if (policy) patch.zdrPolicy = policy;
    }
    if (raw['limits'] !== undefined) {
        const limits = checkLimits(raw['limits'], issues);
        if (limits && Object.keys(limits).length > 0) patch.limits = limits;
    }
    if (issues.length === 0 && Object.keys(patch).length === 0) {
        issues.push({ field: 'body', code: 'empty', message: 'must change at least one field' });
    }
    return checked(patch, issues);
}

/** Checks a new key (KeyCreateInput). Same rules as the patch; the name is required and `unset` is not a choice. */
export function sanitizeKeyCreateInput(raw: unknown): Checked<KeyCreateInput> {
    if (!isRecord(raw)) {
        return checked({ name: '' }, [{ field: 'body', code: 'type', message: 'must be a JSON object' }]);
    }
    const issues: InputIssue[] = [];
    rejectUnknown(raw, ['name', 'expiresAt', 'zdrPolicy', 'limits'], [], issues);
    const input: KeyCreateInput = { name: '' };
    if (raw['name'] === undefined) issues.push({ field: 'name', code: 'required', message: 'is required' });
    else input.name = checkName(raw['name'], 'name', issues) ?? '';
    if (raw['expiresAt'] !== undefined) {
        const expiresAt = checkExpiry(raw['expiresAt'], issues);
        if (expiresAt !== undefined) input.expiresAt = expiresAt;
    }
    if (raw['zdrPolicy'] !== undefined) {
        const policy = checkPolicy(raw['zdrPolicy'], ['zdr', 'off'], issues);
        if (policy === 'zdr' || policy === 'off') input.zdrPolicy = policy;
    }
    if (raw['limits'] !== undefined) {
        const limits = checkLimits(raw['limits'], issues);
        if (limits && Object.keys(limits).length > 0) input.limits = limits;
    }
    return checked(input, issues);
}

function limitsToWire(limits: LimitsInput | undefined, wire: Record<string, unknown>): void {
    if (!limits) return;
    for (const kind of KEY_LIMIT_KINDS) {
        const periods = limits[kind];
        if (!periods) continue;
        for (const period of KEY_LIMIT_PERIODS) {
            const value = periods[period];
            if (value !== undefined) wire[KEY_LIMIT_FIELDS[kind][period]] = value;
        }
    }
}

/** The PATCH body of the API for a checked patch (only the fields the patch carries; null clears). */
export function keyPatchToWire(patch: KeyLimitsPatch): Record<string, unknown> {
    const wire: Record<string, unknown> = {};
    if (patch.name !== undefined) wire['name'] = patch.name;
    if (patch.expiresAt !== undefined)
        wire['expires_at'] = patch.expiresAt === null ? null : new Date(patch.expiresAt).toISOString();
    if (patch.zdrPolicy !== undefined) wire['zdr_policy'] = patch.zdrPolicy;
    limitsToWire(patch.limits, wire);
    return wire;
}

/** The POST body of the API for a checked new key. */
export function keyCreateToWire(input: KeyCreateInput): Record<string, unknown> {
    const wire: Record<string, unknown> = { name: input.name };
    if (input.expiresAt !== undefined)
        wire['expires_at'] = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
    if (input.zdrPolicy !== undefined) wire['zdr_policy'] = input.zdrPolicy;
    limitsToWire(input.limits, wire);
    return wire;
}

/** A NanoGPT key id: a positive integer as a string. null for anything else. */
export function checkKeyId(raw: unknown): string | null {
    return typeof raw === 'string' && /^[1-9][0-9]{0,17}$/.test(raw) ? raw : null;
}

/** A preset name as the API takes it (`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$`), lower-cased as the API returns it. */
export function checkPresetName(raw: unknown): string | null {
    return typeof raw === 'string' && PRESET_NAME_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

/* ------------------------------------------------------------------------------------------------ presets */

/** Every setting key: the type forces this list to stay complete. */
const SETTING_KEYS: Record<keyof PresetSettings, true> = {
    systemPrompt: true,
    maxTokens: true,
    topK: true,
    temperature: true,
    topP: true,
    minP: true,
    topA: true,
    frequencyPenalty: true,
    presencePenalty: true,
    repetitionPenalty: true,
    responseFormat: true,
    structuredOutputs: true,
    reasoningEffort: true,
    reasoningSummary: true,
    verbosity: true,
    routing: true,
    serviceTier: true,
    thinking: true,
    promptCaching: true,
};

/** What a form may send back untouched from a ModelPreset: ignored, not rejected. */
const PRESET_READ_ONLY = ['name', 'createdAt', 'updatedAt'];

interface NumberRule {
    integer: boolean;
    min: number;
    max: number;
}

function checkNumber(
    raw: Record<string, unknown>,
    field: string,
    rule: NumberRule,
    issues: InputIssue[],
): number | null {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ field, code: 'type', message: 'must be a number or null' });
        return null;
    }
    if (rule.integer && !Number.isInteger(value)) {
        issues.push({ field, code: 'integer', message: 'must be a whole number' });
        return null;
    }
    if (value < rule.min || value > rule.max) {
        issues.push({ field, code: 'range', message: `must be between ${rule.min} and ${rule.max}` });
        return null;
    }
    return value;
}

function checkEnum<T extends string>(
    raw: Record<string, unknown>,
    field: string,
    allowed: readonly T[],
    issues: InputIssue[],
): T | null {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    const found = typeof value === 'string' ? (allowed.find((item) => item === value) ?? null) : null;
    if (found === null) issues.push({ field, code: 'enum', message: `must be one of: ${allowed.join(', ')}` });
    return found;
}

function checkFlag(raw: Record<string, unknown>, field: string, issues: InputIssue[]): boolean | null {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'boolean') {
        issues.push({ field, code: 'type', message: 'must be true, false or null' });
        return null;
    }
    return value;
}

function checkThinking(raw: Record<string, unknown>, issues: InputIssue[]): PresetThinking | null {
    const value = raw['thinking'];
    if (value === undefined || value === null) return null;
    if (!isRecord(value) || typeof value['enabled'] !== 'boolean') {
        issues.push({ field: 'thinking', code: 'type', message: 'must be null or { enabled: boolean, budgetTokens }' });
        return null;
    }
    const rawBudget = value['budgetTokens'];
    let budget: number | null = null;
    if (rawBudget !== undefined && rawBudget !== null) {
        if (typeof rawBudget !== 'number' || !Number.isInteger(rawBudget) || rawBudget < 1 || rawBudget > 1_000_000) {
            issues.push({
                field: 'thinking.budgetTokens',
                code: 'range',
                message: 'must be a whole number from 1 to 1000000',
            });
            return null;
        }
        budget = rawBudget;
    }
    if (budget !== null && !value['enabled']) {
        issues.push({ field: 'thinking.budgetTokens', code: 'conflict', message: 'needs thinking to be enabled' });
        return null;
    }
    return { enabled: value['enabled'], budgetTokens: budget };
}

function checkCaching(raw: Record<string, unknown>, issues: InputIssue[]): PresetCaching | null {
    const value = raw['promptCaching'];
    if (value === undefined || value === null) return null;
    if (!isRecord(value) || typeof value['enabled'] !== 'boolean') {
        issues.push({ field: 'promptCaching', code: 'type', message: 'must be null or { enabled: boolean, ttl }' });
        return null;
    }
    const ttl = value['ttl'];
    if (ttl === undefined || ttl === null) return { enabled: value['enabled'], ttl: null };
    const found = typeof ttl === 'string' ? (CACHE_TTLS.find((item) => item === ttl) ?? null) : null;
    if (found === null) {
        issues.push({ field: 'promptCaching.ttl', code: 'enum', message: `must be one of: ${CACHE_TTLS.join(', ')}` });
        return null;
    }
    return { enabled: value['enabled'], ttl: found };
}

const SAMPLER = { integer: false, min: 0, max: 1 } as const;
const PENALTY = { integer: false, min: -2, max: 2 } as const;

/**
 * Checks what a client sends for a preset and fills every setting that was left out with null (a PUT replaces the whole
 * preset, so "left out" and null mean the same). Ranges, enums and lengths are the API's own; two rules cross fields:
 * `structuredOutputs: true` needs `responseFormat: 'json_object'`, and the flex / priority service tiers cannot go with
 * ranked routing (speed, throughput, latency, price). Unknown fields are refused; the read-only fields of a ModelPreset
 * are ignored. The serialised body must fit the API's 16 KiB.
 */
export function sanitizePresetInput(raw: unknown): Checked<Required<PresetInput>> {
    const empty = sanitizedEmpty();
    if (!isRecord(raw)) return checked(empty, [{ field: 'body', code: 'type', message: 'must be a JSON object' }]);
    const issues: InputIssue[] = [];
    rejectUnknown(raw, ['model', ...Object.keys(SETTING_KEYS)], PRESET_READ_ONLY, issues);

    let model = '';
    const rawModel = raw['model'];
    if (rawModel === undefined || rawModel === null)
        issues.push({ field: 'model', code: 'required', message: 'is required' });
    else if (typeof rawModel !== 'string') issues.push({ field: 'model', code: 'type', message: 'must be a string' });
    else {
        model = rawModel.trim();
        if (!model || model.length > PRESET_MODEL_MAX_LENGTH) {
            issues.push({
                field: 'model',
                code: 'length',
                message: `must be 1 to ${PRESET_MODEL_MAX_LENGTH} characters`,
            });
            model = '';
        }
    }

    let systemPrompt: string | null = null;
    const rawPrompt = raw['systemPrompt'];
    if (rawPrompt !== undefined && rawPrompt !== null) {
        if (typeof rawPrompt !== 'string')
            issues.push({ field: 'systemPrompt', code: 'type', message: 'must be a string or null' });
        else if (rawPrompt.length > PRESET_PROMPT_MAX_LENGTH) {
            issues.push({
                field: 'systemPrompt',
                code: 'length',
                message: `must be at most ${PRESET_PROMPT_MAX_LENGTH} characters`,
            });
        } else systemPrompt = rawPrompt;
    }

    const input: Required<PresetInput> = {
        model,
        systemPrompt,
        maxTokens: checkNumber(raw, 'maxTokens', { integer: true, min: 1, max: 1_000_000 }, issues),
        topK: checkNumber(raw, 'topK', { integer: true, min: 0, max: 1_000_000 }, issues),
        temperature: checkNumber(raw, 'temperature', { integer: false, min: 0, max: 2 }, issues),
        topP: checkNumber(raw, 'topP', SAMPLER, issues),
        minP: checkNumber(raw, 'minP', SAMPLER, issues),
        topA: checkNumber(raw, 'topA', SAMPLER, issues),
        frequencyPenalty: checkNumber(raw, 'frequencyPenalty', PENALTY, issues),
        presencePenalty: checkNumber(raw, 'presencePenalty', PENALTY, issues),
        repetitionPenalty: checkNumber(raw, 'repetitionPenalty', PENALTY, issues),
        responseFormat: checkEnum(raw, 'responseFormat', RESPONSE_FORMATS, issues),
        structuredOutputs: checkFlag(raw, 'structuredOutputs', issues),
        reasoningEffort: checkEnum(raw, 'reasoningEffort', REASONING_EFFORTS, issues),
        reasoningSummary: checkEnum(raw, 'reasoningSummary', REASONING_SUMMARIES, issues),
        verbosity: checkEnum(raw, 'verbosity', VERBOSITIES, issues),
        routing: checkEnum(raw, 'routing', ROUTINGS, issues),
        serviceTier: checkEnum(raw, 'serviceTier', SERVICE_TIERS, issues),
        thinking: checkThinking(raw, issues),
        promptCaching: checkCaching(raw, issues),
    };

    if (input.structuredOutputs === true && input.responseFormat !== 'json_object') {
        issues.push({ field: 'structuredOutputs', code: 'conflict', message: 'needs responseFormat "json_object"' });
    }
    const rankedRouting =
        input.routing === 'speed' ||
        input.routing === 'throughput' ||
        input.routing === 'latency' ||
        input.routing === 'price';
    if ((input.serviceTier === 'flex' || input.serviceTier === 'priority') && rankedRouting) {
        issues.push({
            field: 'serviceTier',
            code: 'conflict',
            message: 'flex and priority cannot go with speed, throughput, latency or price routing',
        });
    }
    if (
        issues.length === 0 &&
        new TextEncoder().encode(JSON.stringify(presetToWire(input))).length > PRESET_BODY_LIMIT_BYTES
    ) {
        issues.push({ field: 'body', code: 'too_large', message: `must be at most ${PRESET_BODY_LIMIT_BYTES} bytes` });
    }
    return checked(input, issues);
}

function sanitizedEmpty(): Required<PresetInput> {
    return {
        model: '',
        systemPrompt: null,
        maxTokens: null,
        topK: null,
        temperature: null,
        topP: null,
        minP: null,
        topA: null,
        frequencyPenalty: null,
        presencePenalty: null,
        repetitionPenalty: null,
        responseFormat: null,
        structuredOutputs: null,
        reasoningEffort: null,
        reasoningSummary: null,
        verbosity: null,
        routing: null,
        serviceTier: null,
        thinking: null,
        promptCaching: null,
    };
}

/** The PUT body of the API for a checked preset: settings that are null are left out (the API reads them as null). */
export function presetToWire(preset: Required<PresetInput>): Record<string, unknown> {
    const thinking = preset.thinking;
    const caching = preset.promptCaching;
    const wire: Record<string, unknown> = {
        model: preset.model,
        system_prompt: preset.systemPrompt,
        max_tokens: preset.maxTokens,
        top_k: preset.topK,
        temperature: preset.temperature,
        top_p: preset.topP,
        min_p: preset.minP,
        top_a: preset.topA,
        frequency_penalty: preset.frequencyPenalty,
        presence_penalty: preset.presencePenalty,
        repetition_penalty: preset.repetitionPenalty,
        response_format_type: preset.responseFormat,
        structured_outputs: preset.structuredOutputs,
        reasoning_effort: preset.reasoningEffort,
        reasoning_summary: preset.reasoningSummary,
        verbosity: preset.verbosity,
        provider_routing_preference: preset.routing,
        service_tier: preset.serviceTier,
        thinking: !thinking
            ? null
            : thinking.enabled && thinking.budgetTokens !== null
              ? { type: 'enabled', budget_tokens: thinking.budgetTokens }
              : thinking.enabled,
        prompt_caching: !caching
            ? null
            : caching.ttl === null
              ? caching.enabled
              : { enabled: caching.enabled, ttl: caching.ttl },
    };
    for (const key of Object.keys(wire)) if (wire[key] === null) delete wire[key];
    return wire;
}
