// "Is this connection good for background work?" (extraction, summaries, JSON tasks): the checks behind
// `NANOVIA_API.advice.backgroundProfile`. Pure: everything it needs comes in as arguments, so each finding is
// unit-tested without a browser. Codes and their meaning are `AdviceIssue` in src/shared/contracts.ts; the consumer turns
// `code` + `params` into text with its own i18n.
import { analyzeBilling } from '../domain/billing';
import type { AdviceIssue, BackgroundAdvice, CatalogModel, ConnectionConfig } from '../shared/contracts';

export const SUGGESTED_MODEL_LIMIT = 5;

export interface AdviceInput {
    connection: ConnectionConfig;
    /** null when the catalog does not know the model (or has not loaded). */
    model: CatalogModel | null;
    /** The whole catalog snapshot (for the suggestions); empty before it loads. */
    catalog: readonly CatalogModel[];
    catalogLoaded: boolean;
    /** The plugin is known not to answer (false while it was never asked). */
    pluginDown: boolean;
    /** `ModelProviders.supportsProviderSelection` of the model; null when unknown. */
    providerSelection: boolean | null;
    /** Qvink Memory is installed (it keeps its own summaries). */
    qvinkInstalled: boolean;
}

function efforts(model: CatalogModel): string[] {
    return model.reasoningEfforts.map((effort) => effort.trim().toLowerCase()).filter(Boolean);
}

/**
 * false for a model that always reasons: it lists efforts and 'none' is not one of them, so the lowest level is the
 * quietest the connection can make it (planReasoning then hides the text but the tokens are still spent).
 */
export function canDisableReasoning(model: CatalogModel): boolean {
    const list = efforts(model);
    return list.length === 0 || list.includes('none');
}

/** The lowest effort a model lists, in the ladder's order; '' when it lists none. */
function lowestEffort(model: CatalogModel): string {
    const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const known = efforts(model)
        .map((effort) => order.indexOf(effort))
        .filter((index) => index >= 0);
    return known.length ? (order[Math.min(...known)] ?? '') : '';
}

const PRIVATE_CATEGORY = /(?:^|[^a-z])(?:private|tee)(?:[^a-z]|$)/i;
/** `:thinking` style variants exist to reason; they are not a quiet choice even when the catalog lists no efforts. */
const THINKING_VARIANT = /:thinking\b/i;

/**
 * Models good for background work: they reason only when asked (no effort dial, or 'none' among the efforts), support
 * structured output, are not on the private/TEE shelf and are not a `:thinking` variant. Cheapest first (prompt +
 * completion price per 1M tokens), then by id. Empty for an empty catalog.
 */
export function suggestBackgroundModels(models: readonly CatalogModel[], limit = SUGGESTED_MODEL_LIMIT): string[] {
    const price = (model: CatalogModel): number => model.pricing.prompt + model.pricing.completion;
    return models
        .filter(
            (model) =>
                model.capabilities.structuredOutput &&
                canDisableReasoning(model) &&
                !(model.category !== null && PRIVATE_CATEGORY.test(model.category)) &&
                !THINKING_VARIANT.test(model.id) &&
                Number.isFinite(price(model)),
        )
        .sort((a, b) => price(a) - price(b) || a.pricing.completion - b.pricing.completion || (a.id < b.id ? -1 : 1))
        .slice(0, Math.max(0, limit))
        .map((model) => model.id);
}

/** Whether Qvink Memory is loaded: it registers its generate interceptor as a global (the way Maestro detects it). */
export function qvinkInstalled(): boolean {
    return typeof (globalThis as Record<string, unknown>)['memory_intercept_messages'] === 'function';
}

/**
 * The findings for using `input.connection` as a background connection. `ok` is true when none of them is a warning
 * (information notes alone keep it true).
 */
export function backgroundAdvice(input: AdviceInput): BackgroundAdvice {
    const { connection, model } = input;
    const issues: AdviceIssue[] = [];

    if (connection.mode === 'plugin' && input.pluginDown) {
        issues.push({ code: 'route.pluginDown', severity: 'warn' });
    }

    if (model === null) {
        issues.push({
            code: 'model.unknown',
            severity: 'info',
            params: { model: connection.modelId, catalogLoaded: input.catalogLoaded },
        });
    } else if (!canDisableReasoning(model)) {
        issues.push({
            code: 'reasoning.alwaysOn',
            severity: 'warn',
            params: { model: model.id, efforts: efforts(model).join(', '), lowest: lowestEffort(model) },
        });
    }

    // A fixed effort is sent as it is to a model the catalog does not know; a model known not to reason ignores it.
    const { policy, effort } = connection.reasoning;
    const modelReasons = model === null || model.capabilities.reasoning;
    const fixedOn = policy === 'fixed' && effort !== null && effort !== 'none';
    const defaultOn =
        model !== null &&
        model.capabilities.reasoning &&
        (policy === 'default' || (policy === 'fixed' && effort === null));
    if (modelReasons && (fixedOn || defaultOn)) {
        issues.push({ code: 'reasoning.policyOn', severity: 'warn', params: { policy, effort: effort ?? '' } });
    }

    if (model !== null && connection.billing === 'auto' && model.subscription.included) {
        const impact = analyzeBilling(connection, model, input.providerSelection);
        const explicit = impact.reasons.find((reason) => reason.code === 'routing.explicit');
        if (explicit && impact.outcome === 'paygo') {
            issues.push({
                code: 'billing.bypassesSubscription',
                severity: 'warn',
                params: { model: model.id, fields: String(explicit.params?.['fields'] ?? '') },
            });
        }
    }

    if (connection.memory.enabled && input.qvinkInstalled) {
        issues.push({ code: 'memory.overlapsQvink', severity: 'info' });
    }

    return {
        ok: !issues.some((issue) => issue.severity === 'warn'),
        issues,
        suggestedModels: suggestBackgroundModels(input.catalog),
    };
}
