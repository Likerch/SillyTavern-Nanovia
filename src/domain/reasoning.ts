// Reasoning policy: turns a connection's ReasoningConfig, the model's catalog entry and the hints of one request into
// NanoGPT's `reasoning` object (`{ effort, enabled, exclude }`). Pure: no clock, no randomness, no I/O.
import type { CatalogModel, PlanWarning, ReasoningConfig, ReasoningEffort, RequestHints } from '../shared/contracts';

/** The effort ladder, lowest first. The distance between two levels is the distance of their indices. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The `reasoning` object NanoGPT accepts (OpenRouter style). Only the fields that are set are sent. */
export interface ReasoningParams {
    effort?: string;
    enabled?: boolean;
    exclude?: boolean;
}

export interface ReasoningPlan {
    /** null = send nothing and leave the request's own reasoning fields alone. */
    reasoning: ReasoningParams | null;
    warnings: PlanWarning[];
}

/** ST's effort vocabulary (and a few spellings seen in the wild) mapped to the ladder. */
const HINT_VOCABULARY: ReadonlyMap<string, ReasoningEffort | 'auto'> = new Map<string, ReasoningEffort | 'auto'>([
    ['min', 'none'],
    ['off', 'none'],
    ['none', 'none'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['x-high', 'xhigh'],
    ['extra-high', 'xhigh'],
    ['max', 'max'],
    ['auto', 'auto'],
]);

/**
 * Normalises the effort a request carried (X-Nanovia-Effort or ST's `reasoning_effort`).
 * 'min'/'off'/'none' mean "no reasoning" and give 'none'; 'auto' stays 'auto' (the caller expressed no preference);
 * an empty or unknown value gives null.
 */
export function normalizeEffortHint(hint: string | null | undefined): ReasoningEffort | 'auto' | null {
    if (typeof hint !== 'string') return null;
    return HINT_VOCABULARY.get(hint.trim().toLowerCase()) ?? null;
}

/**
 * The supported level closest to `wanted` on the ladder none < minimal < low < medium < high < xhigh < max.
 * A tie goes to the lower level. Entries of `supported` that are not on the ladder are ignored; null when nothing
 * usable is left. `supported` may lack 'none'.
 */
export function nearestEffort(wanted: ReasoningEffort, supported: string[]): string | null {
    const target = EFFORT_ORDER.indexOf(wanted);
    if (target < 0) return null;
    let best = -1;
    for (const level of supported) {
        const index = ladderIndex(level);
        if (index < 0) continue;
        if (best < 0) {
            best = index;
            continue;
        }
        const distance = Math.abs(index - target);
        const bestDistance = Math.abs(best - target);
        if (distance < bestDistance || (distance === bestDistance && index < best)) best = index;
    }
    return best < 0 ? null : (EFFORT_ORDER[best] ?? null);
}

/**
 * Decides what to put into the request's `reasoning` object.
 *
 * - policy 'default', or a model that is known not to reason: nothing (null, no warning).
 * - 'off': the model lists 'none' -> `{ effort: 'none' }`; it only lists other efforts (it always reasons) -> its lowest
 *   effort with the text excluded and the warning `reasoning.cannotDisable`; it has no efforts -> `{ enabled: false }`.
 * - 'fixed': `config.effort` mapped to a supported level (warning `reasoning.effortAdjusted` when it had to change);
 *   without an effort it behaves like 'default'.
 * - 'follow': the request's hint, normalised and mapped the same way; no (or 'auto') hint -> nothing.
 * - A model that reasons but lists no efforts has no dial: 'none' becomes `{ enabled: false }`, anything else
 *   `{ enabled: true }`.
 * - An unknown model (null) gets the normalised effort as it is, with the warning `reasoning.modelUnknown`.
 * - `hideThoughts` adds `exclude: true` to every non-null result (so it has no effect while nothing is sent).
 */
export function planReasoning(model: CatalogModel | null, config: ReasoningConfig, hints: RequestHints): ReasoningPlan {
    const nothing: ReasoningPlan = { reasoning: null, warnings: [] };
    if (config.policy === 'default') return nothing;
    if (model !== null && !model.capabilities.reasoning) return nothing;

    const warnings: PlanWarning[] = [];
    let params: ReasoningParams | null;
    if (config.policy === 'off') {
        params = planOff(model, warnings);
    } else if (config.policy === 'fixed') {
        params = config.effort === null ? null : planWanted(model, config.effort, warnings);
    } else {
        const hint = normalizeEffortHint(hints.effort);
        params = hint === null || hint === 'auto' ? null : planWanted(model, hint, warnings);
    }
    if (params === null) return nothing;
    if (config.hideThoughts) params.exclude = true;
    return { reasoning: params, warnings };
}

function planOff(model: CatalogModel | null, warnings: PlanWarning[]): ReasoningParams {
    if (model === null) {
        warnings.push({ code: 'reasoning.modelUnknown' });
        return { effort: 'none' };
    }
    const lowest = lowestEffort(model.reasoningEfforts);
    if (lowest === null) return { enabled: false };
    if (lowest === 'none') return { effort: 'none' };
    warnings.push({
        code: 'reasoning.cannotDisable',
        params: { model: model.id, efforts: model.reasoningEfforts.join(', ') },
    });
    return { effort: lowest, exclude: true };
}

function planWanted(model: CatalogModel | null, wanted: ReasoningEffort, warnings: PlanWarning[]): ReasoningParams {
    if (model === null) {
        warnings.push({ code: 'reasoning.modelUnknown' });
        return { effort: wanted };
    }
    const applied = nearestEffort(wanted, model.reasoningEfforts);
    if (applied === null) return { enabled: wanted !== 'none' };
    if (applied !== wanted) warnings.push({ code: 'reasoning.effortAdjusted', params: { requested: wanted, applied } });
    return { effort: applied };
}

function lowestEffort(supported: string[]): string | null {
    let best = -1;
    for (const level of supported) {
        const index = ladderIndex(level);
        if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    return best < 0 ? null : (EFFORT_ORDER[best] ?? null);
}

function ladderIndex(level: string): number {
    return EFFORT_ORDER.indexOf(level.trim().toLowerCase() as ReasoningEffort);
}
