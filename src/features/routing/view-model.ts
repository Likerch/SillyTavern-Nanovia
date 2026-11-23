// The Routing tab without the DOM: the draft being edited, the live billing verdict, which controls are locked, the
// reasoning capabilities and the preview of what would be sent. Pure functions of their arguments; view.ts draws them.
// All decisions come from the domain (analyzeBilling, planUpstream, planReasoning, subscriptionSafeOverrides); nothing
// about billing or routing is reimplemented here.
import { billingOutcomeLabel } from '../../core/billing-view';
import type { I18nParams } from '../../core/types';
import { analyzeBilling, subscriptionSafeOverrides } from '../../domain/billing';
import { QUANTIZATION_ORDER } from '../../domain/catalog';
import { QUANTIZATIONS } from '../../domain/connection';
import { planReasoning } from '../../domain/reasoning';
import type { ReasoningParams } from '../../domain/reasoning';
import { routingFields, routingWarnings } from '../../domain/routing';
import { planUpstream } from '../../domain/upstream';
import type {
    BillingMode,
    BillingOutcome,
    BillingReason,
    CatalogModel,
    ConnectionConfig,
    ModelProviders,
    PlanWarning,
    Quantization,
    ReasoningConfig,
    ReasoningEffort,
    ReasoningPolicy,
    RequestHints,
    RoutingConfig,
    RoutingSort,
} from '../../shared/contracts';
import type { ChipKind } from '../../ui';

export type Translate = (key: string, params?: I18nParams) => string;

export const BILLING_MODES: readonly BillingMode[] = ['auto', 'subscription', 'paygo'];
export const ROUTING_SORTS: readonly RoutingSort[] = ['default', 'price', 'throughput', 'latency', 'speed'];
export const REASONING_POLICIES: readonly ReasoningPolicy[] = ['follow', 'fixed', 'off', 'default'];
export const EFFORT_LADDER: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export { QUANTIZATIONS };
/** The precisions a floor can be set to (`unknown` is outside the scale). */
export const MIN_QUANTIZATIONS: readonly Quantization[] = QUANTIZATION_ORDER;

/* ------------------------------------------------------------------------------------------------ the draft */

/** The part of a connection this tab edits. */
export interface RoutingDraft {
    billing: BillingMode;
    routing: RoutingConfig;
    reasoning: ReasoningConfig;
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

/** A deep copy of what the tab edits, so changing the draft never touches the live connection. */
export function draftOf(config: ConnectionConfig): RoutingDraft {
    return { billing: config.billing, routing: cloneRouting(config.routing), reasoning: { ...config.reasoning } };
}

/** The connection as it would be with the draft applied: what the domain functions are asked about. */
export function configWith(config: ConnectionConfig, draft: RoutingDraft): ConnectionConfig {
    return {
        ...config,
        billing: draft.billing,
        routing: cloneRouting(draft.routing),
        reasoning: { ...draft.reasoning },
    };
}

/** What gets saved. The effort only matters to the `fixed` policy and defaults to medium there. */
export function patchOf(draft: RoutingDraft): Pick<ConnectionConfig, 'billing' | 'routing' | 'reasoning'> {
    const fixed = draft.reasoning.policy === 'fixed';
    return {
        billing: draft.billing,
        routing: cloneRouting(draft.routing),
        reasoning: {
            policy: draft.reasoning.policy,
            effort: fixed ? (draft.reasoning.effort ?? 'medium') : null,
            hideThoughts: draft.reasoning.hideThoughts,
        },
    };
}

/** Whether the draft differs from the connection it was taken from. */
export function isDirty(config: ConnectionConfig, draft: RoutingDraft): boolean {
    const saved = patchOf(draftOf(config));
    return JSON.stringify(saved) !== JSON.stringify(patchOf(draft));
}

/* ------------------------------------------------------------------------------------------------ numbers */

export type NumberInput = { ok: true; value: number | null } | { ok: false };

/** A price, latency or throughput typed into a field: empty means "no limit", otherwise a number of zero or more. */
export function parseNumberInput(text: string): NumberInput {
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '') return { ok: true, value: null };
    if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return { ok: false };
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? { ok: true, value } : { ok: false };
}

/** A stored limit back into a field. */
export function numberText(value: number | null): string {
    return value === null ? '' : String(value);
}

/* ------------------------------------------------------------------------------------------------ providers */

/** Provider ids as the domain sends them: trimmed, lower case, without duplicates. */
export function normalizeProviderIds(values: readonly string[]): string[] {
    const out: string[] = [];
    for (const value of values) {
        const id = value.trim().toLowerCase();
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

/** Adds the ids typed into a chip field (separated by commas, spaces or new lines) to a list. */
export function addProviderIds(current: readonly string[], typed: string): string[] {
    return normalizeProviderIds([...current, ...typed.split(/[\s,;]+/)]);
}

/** Host ids the catalog knows for the model that are not chosen yet, for the suggestion list. */
export function providerSuggestions(providers: ModelProviders | null, chosen: readonly string[]): string[] {
    if (!providers) return [];
    const taken = new Set(chosen.map((id) => id.toLowerCase()));
    return providers.providers.map((host) => host.id).filter((id) => !taken.has(id.toLowerCase()));
}

/* ------------------------------------------------------------------------------------------------ controls */

export type RoutingFieldName =
    | 'order'
    | 'only'
    | 'ignore'
    | 'sort'
    | 'quantizations'
    | 'minQuantization'
    | 'maxPrice'
    | 'allowFallbacks'
    | 'requireParameters'
    | 'preferredMaxLatency'
    | 'preferredMinThroughput'
    | 'cachingRoute';

/** The settings NanoGPT bills as an explicit provider choice (domain/routing.ts routingFields), in display order. */
export const BYPASS_FIELDS: readonly RoutingFieldName[] = [
    'order',
    'only',
    'ignore',
    'sort',
    'quantizations',
    'minQuantization',
    'maxPrice',
    'allowFallbacks',
    'requireParameters',
    'preferredMaxLatency',
    'preferredMinThroughput',
    'cachingRoute',
];

export interface ControlState {
    /** The setting bypasses the subscription when used. */
    bypass: boolean;
    disabled: boolean;
    /** i18n key of why it is disabled; null when it is not. */
    reason: string | null;
}

export type ControlStates = Record<RoutingFieldName | 'zdr' | 'enabled', ControlState>;

/** Which controls are locked. In subscription-safe mode every bypassing control is, with the reason; `zdr` never is. */
export function controlStates(draft: RoutingDraft): ControlStates {
    const locked = draft.billing === 'subscription';
    const states = {} as ControlStates;
    for (const name of BYPASS_FIELDS) {
        states[name] = {
            bypass: true,
            disabled: locked,
            reason: locked ? 'routing.disabled.subscriptionSafe' : null,
        };
    }
    states.zdr = { bypass: false, disabled: false, reason: null };
    states.enabled = { bypass: false, disabled: false, reason: null };
    return states;
}

/** The draft with every bypassing setting reset to neutral (what subscription-safe mode would do); `zdr` stays. */
export function makeSubscriptionSafe(
    config: ConnectionConfig,
    draft: RoutingDraft,
    model: CatalogModel | null,
): RoutingDraft {
    const { routing } = subscriptionSafeOverrides(configWith(config, draft), model);
    return { ...draft, routing };
}

/** Whether "remove the settings that leave the subscription" has anything to remove. */
export function hasBypassingSettings(draft: RoutingDraft): boolean {
    return draft.routing.enabled && routingFields(draft.routing).length > 0;
}

/** A preferred latency or throughput is set but no sort is: NanoGPT ignores it (the domain's own warning). */
export function preferenceNeedsSort(routing: RoutingConfig): boolean {
    return routingWarnings({ ...routing, enabled: true }).some(
        (warning) => warning.code === 'routing.preferenceNeedsSort',
    );
}

/* ------------------------------------------------------------------------------------------------ reasoning */

export interface ReasoningCaps {
    /** The catalog knows the model. */
    known: boolean;
    /** The model reasons at all. */
    reasons: boolean;
    /** The efforts the model lists, on the ladder, lowest first. */
    efforts: ReasoningEffort[];
    /** It always reasons: its lowest effort is not 'none'. */
    alwaysOn: boolean;
    /** Reasoning can be switched off (an effort 'none', or no effort dial at all). */
    canDisable: boolean;
}

export function reasoningCaps(model: CatalogModel | null): ReasoningCaps {
    if (!model) return { known: false, reasons: true, efforts: [], alwaysOn: false, canDisable: true };
    const listed = new Set(model.reasoningEfforts.map((effort) => effort.trim().toLowerCase()));
    const efforts = EFFORT_LADDER.filter((effort) => listed.has(effort));
    const reasons = model.capabilities.reasoning;
    const alwaysOn = reasons && efforts.length > 0 && !efforts.includes('none');
    return { known: true, reasons, efforts, alwaysOn, canDisable: !alwaysOn };
}

/** The efforts the select offers: the model's list when it has one, the whole ladder otherwise; the chosen one stays. */
export function effortChoices(caps: ReasoningCaps, current: ReasoningEffort | null): ReasoningEffort[] {
    const base = caps.known && caps.efforts.length > 0 ? [...caps.efforts] : [...EFFORT_LADDER];
    if (current && !base.includes(current)) base.push(current);
    return EFFORT_LADDER.filter((effort) => base.includes(effort));
}

/** One sentence about what the catalog says of the model's reasoning. */
export function capabilityLine(caps: ReasoningCaps, t: Translate): string {
    if (!caps.known) return t('routing.reasoning.caps.unknown');
    if (!caps.reasons) return t('routing.reasoning.caps.none');
    const efforts = caps.efforts.map((effort) => t(`billing.effort.${effort}`)).join(', ');
    const parts: string[] = [
        caps.alwaysOn ? t('routing.reasoning.caps.alwaysOn') : t('routing.reasoning.caps.canDisable'),
    ];
    parts.push(efforts ? t('routing.reasoning.caps.efforts', { efforts }) : t('routing.reasoning.caps.noDial'));
    return parts.join(' ');
}

export interface PreviewScenario {
    id: 'main' | 'mainNone' | 'mainHigh' | 'background';
    hints: RequestHints;
}

/** The requests the preview shows: the chat asking for nothing, for no reasoning, for high; a background task. */
export const PREVIEW_SCENARIOS: readonly PreviewScenario[] = [
    { id: 'main', hints: { effort: null, consumer: 'main', thoughts: false } },
    { id: 'mainNone', hints: { effort: 'none', consumer: 'main', thoughts: false } },
    { id: 'mainHigh', hints: { effort: 'high', consumer: 'main', thoughts: false } },
    { id: 'background', hints: { effort: null, consumer: 'background', thoughts: false } },
];

export interface PreviewRow {
    id: PreviewScenario['id'];
    /** What would go into the request's `reasoning` object; null = nothing is sent. */
    params: ReasoningParams | null;
    warnings: PlanWarning[];
}

/** planReasoning for the sample requests. */
export function reasoningPreview(model: CatalogModel | null, reasoning: ReasoningConfig): PreviewRow[] {
    return PREVIEW_SCENARIOS.map(({ id, hints }) => {
        const plan = planReasoning(model, reasoning, hints);
        return { id, params: plan.reasoning, warnings: plan.warnings };
    });
}

/** `effort high · text hidden`, `reasoning off`, or "nothing is sent". */
export function describeReasoning(params: ReasoningParams | null, t: Translate): string {
    if (params === null) return t('routing.preview.nothing');
    const parts: string[] = [];
    if (params.effort !== undefined) {
        parts.push(t('routing.preview.effort', { effort: t(`billing.effort.${params.effort}`) }));
    }
    if (params.enabled === false) parts.push(t('routing.preview.off'));
    if (params.enabled === true) parts.push(t('routing.preview.on'));
    if (params.exclude === true) parts.push(t('routing.preview.hidden'));
    return parts.join(' · ');
}

/* ------------------------------------------------------------------------------------------------ the verdict */

export interface Verdict {
    outcome: BillingOutcome;
    markupPercent: number;
    /** Nothing in the settings leaves the subscription. */
    subscriptionSafe: boolean;
    reasons: BillingReason[];
    warnings: PlanWarning[];
    /** RoutingConfig names the proxy removes in subscription-safe mode. */
    stripped: string[];
    /** The catalog knows the model; false means the outcome is a guess at best. */
    modelKnown: boolean;
    /** The model runs on a fixed route (routing is ignored); null when unknown. */
    providerSelection: boolean | null;
}

/**
 * What the draft does to billing and to the request: the domain's BillingImpact plus the warnings of the plan the
 * connection makes for an ordinary chat request that asks for nothing (routing warnings, and the reasoning warnings of
 * the `fixed` and `off` policies, which do not depend on the request). What the `follow` policy does with a particular
 * request is shown by the preview, not here. `providerSelection` is the catalog's `supportsProviderSelection` for the
 * model (null = unknown).
 */
export function verdictFor(
    config: ConnectionConfig,
    draft: RoutingDraft,
    model: CatalogModel | null,
    providerSelection: boolean | null,
): Verdict {
    const connection = configWith(config, draft);
    const impact = analyzeBilling(connection, model, providerSelection);
    const sample = planUpstream({
        connection,
        model,
        body: { model: connection.modelId, messages: [] },
        hints: PREVIEW_SCENARIOS[0]?.hints ?? { effort: null, consumer: 'main', thoughts: false },
        providerSelection,
    });
    return {
        outcome: impact.outcome,
        markupPercent: impact.markupPercent,
        subscriptionSafe: impact.subscriptionSafe,
        reasons: impact.reasons,
        warnings: sample.warnings,
        stripped: impact.stripped,
        modelKnown: model !== null,
        providerSelection,
    };
}

export interface BadgeSpec {
    label: string;
    kind: ChipKind;
}

export function outcomeKind(outcome: BillingOutcome): ChipKind {
    return outcome === 'subscription' ? 'ok' : outcome === 'paygo' ? 'warn' : 'muted';
}

/** The outcome badge: "Subscription", "Pay as you go · +5%" or "Not known". */
export function outcomeBadge(verdict: Verdict, t: Translate): BadgeSpec {
    const label = billingOutcomeLabel(verdict.outcome, t);
    return {
        label: verdict.markupPercent > 0 ? `${label} · +${verdict.markupPercent}%` : label,
        kind: outcomeKind(verdict.outcome),
    };
}

/** A line of the panel that says why the outcome is what it is when no reason does (nothing special in the settings). */
export function verdictSummaryKey(verdict: Verdict): string {
    if (!verdict.modelKnown) return 'routing.verdict.modelUnknown';
    if (verdict.outcome === 'subscription') return 'routing.verdict.subscription';
    if (verdict.outcome === 'paygo') return 'routing.verdict.paygo';
    return 'routing.verdict.unknown';
}

/** Whether the routing settings are ignored by the model (a fixed route): only `zdr` has an effect. */
export function routingIgnored(verdict: Verdict): boolean {
    return verdict.providerSelection === false;
}

/** The connection names for the selector: "Name · model". */
export function connectionLabel(config: Pick<ConnectionConfig, 'name' | 'modelId'>): string {
    return `${config.name} · ${config.modelId}`;
}
