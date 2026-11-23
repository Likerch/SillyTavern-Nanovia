// The create/edit form of a model preset without the DOM: the state the inputs write into, what a preset (or a
// connection) turns into, and what the state turns back into (a PresetInput the plugin accepts). Validation is the
// plugin's own (domain/mgmt.ts sanitizePresetInput); the form adds the name rule and what only the text can get wrong (an
// unreadable number), and maps the plugin's field paths onto form fields.
import {
    CACHE_TTLS,
    PRESET_MODEL_MAX_LENGTH,
    PRESET_PROMPT_MAX_LENGTH,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    RESPONSE_FORMATS,
    ROUTINGS,
    SERVICE_TIERS,
    VERBOSITIES,
    checkPresetName,
    sanitizePresetInput,
} from '../../domain/mgmt';
import type { InputIssue } from '../../domain/mgmt';
import type { ConnectionConfig, ReasoningEffort } from '../../shared/contracts';
import type {
    ModelPreset,
    PresetCreateInput,
    PresetInput,
    PresetReasoningSummary,
    PresetResponseFormat,
    PresetRouting,
    PresetServiceTier,
    PresetVerbosity,
} from '../../shared/contracts-mgmt';
import { numberText, parseNumberText } from './format';
import type { FormIssue } from './key-form-model';

export { CACHE_TTLS, REASONING_EFFORTS, REASONING_SUMMARIES, RESPONSE_FORMATS, ROUTINGS, SERVICE_TIERS, VERBOSITIES };

export type PresetNumberKey =
    | 'maxTokens'
    | 'topK'
    | 'temperature'
    | 'topP'
    | 'minP'
    | 'topA'
    | 'frequencyPenalty'
    | 'presencePenalty'
    | 'repetitionPenalty';

export interface NumberRule {
    key: PresetNumberKey;
    integer: boolean;
    min: number;
    max: number;
}

/** The numeric settings with the API's ranges (a test holds this table against the plugin's own checks). */
export const PRESET_NUMBER_RULES: readonly NumberRule[] = [
    { key: 'maxTokens', integer: true, min: 1, max: 1_000_000 },
    { key: 'topK', integer: true, min: 0, max: 1_000_000 },
    { key: 'temperature', integer: false, min: 0, max: 2 },
    { key: 'topP', integer: false, min: 0, max: 1 },
    { key: 'minP', integer: false, min: 0, max: 1 },
    { key: 'topA', integer: false, min: 0, max: 1 },
    { key: 'frequencyPenalty', integer: false, min: -2, max: 2 },
    { key: 'presencePenalty', integer: false, min: -2, max: 2 },
    { key: 'repetitionPenalty', integer: false, min: -2, max: 2 },
];

export function numberRule(key: PresetNumberKey): NumberRule {
    const rule = PRESET_NUMBER_RULES.find((item) => item.key === key);
    if (!rule) throw new Error(`no rule for ${key}`);
    return rule;
}

/** '' = not set (the request's own value, or the model's default, applies). */
export type Optional<T extends string> = '' | T;
export type Tri = '' | 'on' | 'off';

export interface PresetFormState {
    name: string;
    model: string;
    systemPrompt: string;
    numbers: Record<PresetNumberKey, string>;
    responseFormat: Optional<PresetResponseFormat>;
    structuredOutputs: Tri;
    reasoningEffort: Optional<ReasoningEffort>;
    reasoningSummary: Optional<PresetReasoningSummary>;
    verbosity: Optional<PresetVerbosity>;
    routing: Optional<PresetRouting>;
    serviceTier: Optional<PresetServiceTier>;
    thinking: Tri;
    /** Tokens, only with thinking on; '' = the model's own. */
    thinkingBudget: string;
    promptCaching: Tri;
    cacheTtl: Optional<'5m' | '1h'>;
}

function blankNumbers(): PresetFormState['numbers'] {
    return {
        maxTokens: '',
        topK: '',
        temperature: '',
        topP: '',
        minP: '',
        topA: '',
        frequencyPenalty: '',
        presencePenalty: '',
        repetitionPenalty: '',
    };
}

export function emptyPresetForm(): PresetFormState {
    return {
        name: '',
        model: '',
        systemPrompt: '',
        numbers: blankNumbers(),
        responseFormat: '',
        structuredOutputs: '',
        reasoningEffort: '',
        reasoningSummary: '',
        verbosity: '',
        routing: '',
        serviceTier: '',
        thinking: '',
        thinkingBudget: '',
        promptCaching: '',
        cacheTtl: '',
    };
}

function tri(value: boolean | null): Tri {
    return value === null ? '' : value ? 'on' : 'off';
}

/** The form of an existing preset: every setting it holds, so saving cannot drop one (a PUT replaces the whole preset). */
export function presetFormFromPreset(preset: ModelPreset): PresetFormState {
    const numbers = blankNumbers();
    for (const rule of PRESET_NUMBER_RULES) numbers[rule.key] = numberText(preset[rule.key]);
    return {
        name: preset.name,
        model: preset.model,
        systemPrompt: preset.systemPrompt ?? '',
        numbers,
        responseFormat: preset.responseFormat ?? '',
        structuredOutputs: tri(preset.structuredOutputs),
        reasoningEffort: preset.reasoningEffort ?? '',
        reasoningSummary: preset.reasoningSummary ?? '',
        verbosity: preset.verbosity ?? '',
        routing: preset.routing ?? '',
        serviceTier: preset.serviceTier ?? '',
        thinking: preset.thinking ? tri(preset.thinking.enabled) : '',
        thinkingBudget: preset.thinking?.budgetTokens != null ? String(preset.thinking.budgetTokens) : '',
        promptCaching: preset.promptCaching ? tri(preset.promptCaching.enabled) : '',
        cacheTtl: preset.promptCaching?.ttl ?? '',
    };
}

/* ------------------------------------------------------------------------------------------------ names */

/** A preset name from free text: lower case, letters, digits, `-` and `_`, starting with a letter or digit, at most 80. */
export function slugifyPresetName(text: string): string {
    const slug = text
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, 80)
        .replace(/-+$/, '');
    return slug || 'preset';
}

/** `base`, or `base-2`, `base-3` … the first that no existing preset uses (names compare lower case, within 80 characters). */
export function uniquePresetName(base: string, existing: Iterable<string>): string {
    const taken = new Set([...existing].map((name) => name.toLowerCase()));
    const start = slugifyPresetName(base);
    if (!taken.has(start)) return start;
    for (let n = 2; ; n++) {
        const suffix = `-${n}`;
        const candidate = `${start.slice(0, 80 - suffix.length).replace(/-+$/, '')}${suffix}`;
        if (!taken.has(candidate)) return candidate;
    }
}

/** A copy of a preset under a new name (`<name>-copy`, then `-copy-2` …). */
export function duplicatePresetForm(preset: ModelPreset, existing: Iterable<string>): PresetFormState {
    return { ...presetFormFromPreset(preset), name: uniquePresetName(`${preset.name}-copy`, existing) };
}

/* ------------------------------------------------------------------------------------------ from a connection */

export interface ConnectionPreset {
    form: PresetFormState;
    /** The connection sets provider lists, price caps or quantisation that a preset cannot hold. */
    droppedRouting: boolean;
}

/** `provider_routing_preference` for a connection's routing: its sort when it ranks, else the caching route, else none. */
function routingOf(connection: ConnectionConfig): Optional<PresetRouting> {
    const { routing } = connection;
    if (!routing.enabled) return '';
    if (routing.sort !== 'default') return routing.sort;
    return routing.cachingRoute ? 'caching' : '';
}

function reasoningOf(connection: ConnectionConfig): Optional<ReasoningEffort> {
    const { reasoning } = connection;
    if (reasoning.policy === 'off') return 'none';
    if (reasoning.policy === 'fixed' && reasoning.effort) return reasoning.effort;
    return '';
}

/**
 * A preset form filled from a connection: its model, its routing preference and a fixed reasoning effort, only what a
 * preset can hold (no provider lists, price caps or quantisation: `droppedRouting` says when the connection had some).
 */
export function presetFormFromConnection(connection: ConnectionConfig, existing: Iterable<string>): ConnectionPreset {
    const { routing } = connection;
    const droppedRouting =
        routing.enabled &&
        (routing.order.length > 0 ||
            routing.only.length > 0 ||
            routing.ignore.length > 0 ||
            routing.quantizations.length > 0 ||
            routing.minQuantization !== null ||
            routing.maxPrice.prompt !== null ||
            routing.maxPrice.completion !== null ||
            routing.preferredMaxLatency !== null ||
            routing.preferredMinThroughput !== null);
    return {
        form: {
            ...emptyPresetForm(),
            name: uniquePresetName(connection.name, existing),
            model: connection.modelId,
            routing: routingOf(connection),
            reasoningEffort: reasoningOf(connection),
        },
        droppedRouting,
    };
}

/* ------------------------------------------------------------------------------------------------ building */

/** Paths of the plugin's validation that are named differently on the form. */
const FIELD_NAMES: Record<string, string> = {
    'thinking.budgetTokens': 'thinkingBudget',
    'promptCaching.ttl': 'cacheTtl',
};

/** Maps a path of the plugin's validation to a form field and adds what the message needs. */
function formIssue(raw: InputIssue): FormIssue {
    const field = FIELD_NAMES[raw.field] ?? raw.field;
    const params: Record<string, string | number> = {};
    const rule = PRESET_NUMBER_RULES.find((item) => item.key === field);
    if (rule) {
        params['min'] = rule.min;
        params['max'] = rule.max;
    }
    if (field === 'model') params['max'] = PRESET_MODEL_MAX_LENGTH;
    if (field === 'systemPrompt') params['max'] = PRESET_PROMPT_MAX_LENGTH;
    if (field === 'thinkingBudget') {
        params['min'] = 1;
        params['max'] = 1_000_000;
    }
    return Object.keys(params).length > 0 ? { field, code: raw.code, params } : { field, code: raw.code };
}

function enabled(value: Tri): boolean | null {
    return value === '' ? null : value === 'on';
}

export type PresetBuildResult =
    { ok: true; name: string; input: Required<PresetInput> } | { ok: false; issues: FormIssue[] };

/**
 * What the form turns into: the name (checked against the API's pattern, lower-cased as the API keeps it) and the whole
 * input (every setting, null where the field is empty). Nothing is returned unless the plugin's checks pass.
 */
export function buildPreset(form: PresetFormState, options: { checkName: boolean }): PresetBuildResult {
    const issues: FormIssue[] = [];
    let name = form.name.trim();
    if (options.checkName) {
        const checked = checkPresetName(name);
        if (checked === null) issues.push({ field: 'name', code: 'format' });
        else name = checked;
    }

    const raw: Record<string, unknown> = { model: form.model };
    raw['systemPrompt'] = form.systemPrompt === '' ? null : form.systemPrompt;
    for (const rule of PRESET_NUMBER_RULES) {
        const value = parseNumberText(form.numbers[rule.key]);
        if (value === undefined) issues.push({ field: rule.key, code: 'number' });
        else raw[rule.key] = value;
    }
    raw['responseFormat'] = form.responseFormat || null;
    raw['structuredOutputs'] = enabled(form.structuredOutputs);
    raw['reasoningEffort'] = form.reasoningEffort || null;
    raw['reasoningSummary'] = form.reasoningSummary || null;
    raw['verbosity'] = form.verbosity || null;
    raw['routing'] = form.routing || null;
    raw['serviceTier'] = form.serviceTier || null;

    const thinking = enabled(form.thinking);
    if (thinking === null) {
        raw['thinking'] = null;
    } else {
        // The budget belongs to thinking that is on; a number left in the (hidden) field of an "off" is not sent.
        const budget = thinking ? parseNumberText(form.thinkingBudget) : null;
        if (budget === undefined) issues.push({ field: 'thinkingBudget', code: 'number' });
        raw['thinking'] = { enabled: thinking, budgetTokens: budget ?? null };
    }
    const caching = enabled(form.promptCaching);
    raw['promptCaching'] = caching === null ? null : { enabled: caching, ttl: form.cacheTtl || null };

    // A field that could not be read is left out of `raw`, so the plugin's checks still run on the rest: all are listed at once.
    const checked = sanitizePresetInput(raw);
    if (checked.ok && issues.length === 0) return { ok: true, name, input: checked.value };
    if (!checked.ok) issues.push(...checked.issues.map(formIssue));
    return { ok: false, issues };
}

/** The POST body of a new preset. */
export function presetCreateInput(name: string, input: Required<PresetInput>): PresetCreateInput {
    return { ...input, name };
}
