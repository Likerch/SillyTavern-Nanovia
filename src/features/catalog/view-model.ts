// The Catalog tab without the DOM: filter state and the list it produces, the detail of one model, the cost estimate,
// the ranking of hosts, the text of routing hints and the connection a model turns into. Pure functions of their
// arguments (formatting takes a translate function and, where it matters, a clock value), so they are tested directly;
// view.ts only draws what they return.
import type { CatalogStatus } from '../../core/catalog';
import type { I18nParams } from '../../core/types';
import {
    OTHER_VENDOR,
    estimateTurnCost,
    filterCatalog,
    groupByVendor,
    listCategories,
    scoreHosts,
    sortCatalog,
} from '../../domain/catalog';
import { defaultRouting } from '../../domain/connection';
import type {
    CatalogModel,
    ConnectionConfig,
    ModelProviders,
    ProviderEndpoint,
    Quantization,
    RoutingConfig,
} from '../../shared/contracts';
import type { CatalogQuery, CatalogSort, HostCriteria, HostScore, RoutingHint } from '../../shared/contracts-catalog';

import { formatContext, formatPrice, formatPricePair, trimZeros } from '../../ui/format';

export { formatContext, formatPrice, formatPricePair };

export type Translate = (key: string, params?: I18nParams) => string;

/* ------------------------------------------------------------------------------------------------ formatting */

/** A cost in USD for a turn: "$0.0123", "$1.50", "<$0.0001", "$0". */
export function formatUsd(usd: number): string {
    if (!Number.isFinite(usd) || usd <= 0) return '$0';
    if (usd < 0.0001) return '<$0.0001';
    const fixed = usd >= 1 ? usd.toFixed(2) : usd >= 0.01 ? usd.toFixed(3) : usd.toFixed(4);
    // At least two decimals for amounts that are not tiny: "$0.50", not "$0.5".
    const trimmed = trimZeros(fixed);
    const decimals = trimmed.includes('.') ? (trimmed.split('.')[1]?.length ?? 0) : 0;
    return `$${decimals >= 2 ? trimmed : Number(trimmed).toFixed(2)}`;
}

export function formatPercent(share: number): string {
    return `${Math.round(share * 100)}%`;
}

export function formatCount(value: number | null, unit: string): string {
    return value === null ? '—' : `${trimZeros(value.toFixed(1))}${unit}`;
}

/** "5 min ago" and friends; `now` is passed in so the function stays pure. */
export function formatAge(at: number, now: number, t: Translate): string {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) return t('catalog.age.now');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('catalog.age.minutes', { n: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t('catalog.age.hours', { n: hours });
    return t('catalog.age.days', { n: Math.round(hours / 24) });
}

/** A number typed into a field ("1,5", " 20000 "); null when empty, not a number or negative. */
export function parseNumber(text: string): number | null {
    const cleaned = text.trim().replace(/\s+/g, '').replace(',', '.');
    if (!cleaned) return null;
    const value = Number(cleaned);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/* ------------------------------------------------------------------------------------------------ names */

const KNOWN_CATEGORIES: Record<string, string> = {
    uncensored: 'uncensored',
    'roleplay/storytelling models': 'roleplay',
    'private/tee': 'tee',
    more: 'more',
};

/** The shelf of a model in the user's language; an unknown shelf shows as NanoGPT names it, no shelf as "Other". */
export function categoryLabel(category: string | null, t: Translate): string {
    if (category === null || category === '') return t('catalog.category.none');
    const known = KNOWN_CATEGORIES[category.toLowerCase()];
    return known ? t(`catalog.category.${known}`) : category;
}

export function vendorLabel(vendor: string, t: Translate): string {
    return vendor === OTHER_VENDOR ? t('catalog.vendor.other') : vendor;
}

export interface CapabilitySpec {
    key: 'vision' | 'reasoning' | 'tools' | 'structured';
    /** Font Awesome icon name. */
    icon: string;
    /** Where the flag lives in a CatalogModel. */
    has(model: CatalogModel): boolean;
}

export const CAPABILITIES: readonly CapabilitySpec[] = [
    { key: 'vision', icon: 'eye', has: (m) => m.capabilities.vision },
    { key: 'reasoning', icon: 'brain', has: (m) => m.capabilities.reasoning },
    { key: 'tools', icon: 'screwdriver-wrench', has: (m) => m.capabilities.toolCalling },
    { key: 'structured', icon: 'code', has: (m) => m.capabilities.structuredOutput },
];

/* ------------------------------------------------------------------------------------------------ filter state */

export const SORTS: readonly CatalogSort[] = ['name', 'price', 'context', 'newest', 'subscription'];
/** Minimum context choices of the filter (tokens); 0 = no requirement. */
export const CONTEXT_CHOICES: readonly number[] = [0, 8192, 32768, 131072, 200000, 1048576];
/** Rows drawn at once; "show more" adds this many. */
export const PAGE_SIZE = 50;

export interface FilterState {
    text: string;
    /** Selected shelves; '' stands for "no shelf" (as in CatalogQuery). Empty = all. */
    categories: string[];
    subscriptionOnly: boolean;
    vision: boolean;
    reasoning: boolean;
    tools: boolean;
    structured: boolean;
    /** 0 = any. */
    minContext: number;
    /** USD per 1M tokens; null = no limit. */
    maxPromptPrice: number | null;
    openWeightsOnly: boolean;
    sort: CatalogSort;
    reverse: boolean;
    groupByVendor: boolean;
}

export function defaultFilters(): FilterState {
    return {
        text: '',
        categories: [],
        subscriptionOnly: false,
        vision: false,
        reasoning: false,
        tools: false,
        structured: false,
        minContext: 0,
        maxPromptPrice: null,
        openWeightsOnly: false,
        sort: 'name',
        reverse: false,
        groupByVendor: false,
    };
}

export function queryOf(state: FilterState): CatalogQuery {
    const query: CatalogQuery = {};
    if (state.text.trim()) query.text = state.text;
    if (state.categories.length > 0) query.categories = state.categories;
    if (state.subscriptionOnly) query.subscriptionOnly = true;
    const capabilities = {
        ...(state.vision ? { vision: true } : {}),
        ...(state.reasoning ? { reasoning: true } : {}),
        ...(state.tools ? { tools: true } : {}),
        ...(state.structured ? { structured: true } : {}),
    };
    if (Object.keys(capabilities).length > 0) query.capabilities = capabilities;
    if (state.minContext > 0) query.minContext = state.minContext;
    if (state.maxPromptPrice !== null) query.maxPromptPrice = state.maxPromptPrice;
    if (state.openWeightsOnly) query.openWeightsOnly = true;
    return query;
}

/** Whether any filter (not the sort or the grouping) is set: the "reset" button and the empty-result message use it. */
export function hasActiveFilters(state: FilterState): boolean {
    return Object.keys(queryOf(state)).length > 0;
}

/** The state with the filters cleared and the sort and grouping kept. */
export function clearedFilters(state: FilterState): FilterState {
    const fresh = defaultFilters();
    return { ...fresh, sort: state.sort, reverse: state.reverse, groupByVendor: state.groupByVendor };
}

/** Toggles a shelf in the selection (key '' = no shelf). */
export function toggleCategory(state: FilterState, key: string): FilterState {
    const has = state.categories.includes(key);
    return { ...state, categories: has ? state.categories.filter((item) => item !== key) : [...state.categories, key] };
}

/* ------------------------------------------------------------------------------------------------ the list */

export interface SubscriptionBadge {
    label: string;
    title: string;
}

export function subscriptionBadge(model: CatalogModel, t: Translate): SubscriptionBadge | null {
    if (!model.subscription.included) return null;
    const multiplier = model.subscription.inputTokenMultiplier;
    if (multiplier === 1) return { label: t('catalog.sub.included'), title: t('catalog.sub.includedHint') };
    const label = t('catalog.sub.includedMultiplier', { multiplier: trimZeros(String(multiplier)) });
    return { label, title: t('catalog.sub.multiplierHint', { multiplier: trimZeros(String(multiplier)) }) };
}

export interface ListRow {
    id: string;
    name: string;
    /** "0.6 / 1.1": USD per 1M tokens, prompt / completion. */
    price: string;
    context: string;
    capabilities: CapabilitySpec['key'][];
    openWeights: boolean;
    subscription: SubscriptionBadge | null;
}

export function rowOf(model: CatalogModel, t: Translate): ListRow {
    return {
        id: model.id,
        name: model.name,
        price: formatPricePair(model.pricing.prompt, model.pricing.completion),
        context: formatContext(model.contextLength),
        capabilities: CAPABILITIES.filter((cap) => cap.has(model)).map((cap) => cap.key),
        openWeights: model.openWeights,
        subscription: subscriptionBadge(model, t),
    };
}

export interface ListSection {
    /** The vendor heading; null when the list is not grouped. */
    vendor: string | null;
    vendorLabel: string | null;
    /** Models of this vendor that pass the filter (not only the ones drawn). */
    count: number;
    rows: ListRow[];
}

export interface CategoryChip {
    /** The key in `FilterState.categories`: the shelf name, '' for no shelf. */
    key: string;
    label: string;
    /** Models on this shelf in the whole catalog. */
    count: number;
    active: boolean;
}

export interface ListView {
    /** Models in the catalog. */
    total: number;
    /** Models that pass the filter. */
    matched: number;
    /** Rows drawn. */
    shown: number;
    /** Matched models not drawn yet ("show more"). */
    remaining: number;
    sections: ListSection[];
    chips: CategoryChip[];
}

export function categoryChips(models: readonly CatalogModel[], state: FilterState, t: Translate): CategoryChip[] {
    return listCategories(models).map(({ category, count }) => {
        const key = category ?? '';
        return { key, label: categoryLabel(category, t), count, active: state.categories.includes(key) };
    });
}

/** The filtered, sorted (and optionally grouped) list, cut to the first `limit` models. */
export function buildList(models: readonly CatalogModel[], state: FilterState, limit: number, t: Translate): ListView {
    const matched = sortCatalog(filterCatalog(models, queryOf(state)), state.sort, state.reverse);
    const cut = Math.max(0, Math.min(limit, matched.length));
    const drawn = matched.slice(0, cut);
    let sections: ListSection[];
    if (state.groupByVendor) {
        const sizes = new Map(groupByVendor(matched).map((group) => [group.vendor, group.models.length]));
        sections = groupByVendor(drawn).map((group) => ({
            vendor: group.vendor,
            vendorLabel: vendorLabel(group.vendor, t),
            count: sizes.get(group.vendor) ?? group.models.length,
            rows: group.models.map((model) => rowOf(model, t)),
        }));
    } else {
        sections = drawn.length
            ? [{ vendor: null, vendorLabel: null, count: matched.length, rows: drawn.map((model) => rowOf(model, t)) }]
            : [];
    }
    return {
        total: models.length,
        matched: matched.length,
        shown: cut,
        remaining: matched.length - cut,
        sections,
        chips: categoryChips(models, state, t),
    };
}

/* ------------------------------------------------------------------------------------------------ status line */

export interface StatusView {
    kind: 'ok' | 'warn' | 'error' | 'muted';
    /** The main line ("612 models · from the plugin · updated 3 min ago"). */
    text: string;
    /** A second line: the cached-data notice or the error. */
    notice: string | null;
}

const KNOWN_ERRORS = ['unreachable', 'timeout', 'invalid_response', 'not_found'];

export function errorText(code: string, t: Translate): string {
    if (KNOWN_ERRORS.includes(code)) return t(`catalog.error.${code}`);
    const http = /^http_(\d+)$/.exec(code);
    if (http) return t('catalog.error.http', { status: http[1] ?? '' });
    return t('catalog.error.other', { code });
}

export function statusView(status: CatalogStatus, count: number, now: number, t: Translate): StatusView {
    if (!status.loaded) {
        if (status.error) {
            return { kind: 'error', text: t('catalog.status.failed'), notice: errorText(status.error, t) };
        }
        return { kind: 'muted', text: t('catalog.status.loading'), notice: null };
    }
    const via = status.via ? t(`catalog.via.${status.via}`) : null;
    const age =
        status.fetchedAt !== null ? t('catalog.status.updated', { age: formatAge(status.fetchedAt, now, t) }) : null;
    const text = [t('catalog.status.count', { count }), via, age]
        .filter((part): part is string => part !== null)
        .join(' · ');
    if (status.source === 'stale') {
        const notice = status.error
            ? t('catalog.status.staleError', { error: errorText(status.error, t) })
            : t('catalog.status.stale');
        return { kind: 'warn', text, notice };
    }
    return { kind: 'ok', text, notice: null };
}

/* ------------------------------------------------------------------------------------------------ one model */

export interface DetailView {
    id: string;
    name: string;
    description: string;
    category: string;
    context: string;
    maxOutput: string | null;
    prices: { prompt: string; completion: string; cacheRead: string | null };
    capabilities: { key: CapabilitySpec['key']; on: boolean }[];
    openWeights: boolean;
    efforts: string[];
    /** The model lists efforts and "none" is not among them: it always reasons (the connection can only lower the effort). */
    alwaysReasons: boolean;
    subscription: SubscriptionBadge | null;
    /** Number of hosts the catalog entry names. */
    hostCount: number;
}

export function detailOf(model: CatalogModel, t: Translate): DetailView {
    return {
        id: model.id,
        name: model.name,
        description: model.description,
        category: categoryLabel(model.category, t),
        context: formatContext(model.contextLength),
        maxOutput: model.maxOutputTokens === null ? null : formatContext(model.maxOutputTokens),
        prices: {
            prompt: formatPrice(model.pricing.prompt),
            completion: formatPrice(model.pricing.completion),
            cacheRead: model.pricing.cacheRead === null ? null : formatPrice(model.pricing.cacheRead),
        },
        capabilities: CAPABILITIES.map((cap) => ({ key: cap.key, on: cap.has(model) })),
        openWeights: model.openWeights,
        efforts: model.reasoningEfforts,
        alwaysReasons: model.reasoningEfforts.length > 0 && !model.reasoningEfforts.includes('none'),
        subscription: subscriptionBadge(model, t),
        hostCount: model.providerIds.length,
    };
}

/* ------------------------------------------------------------------------------------------------ cost */

export interface CostInputs {
    promptTokens: number;
    completionTokens: number;
    /** 0..100. */
    cachedPercent: number;
}

export const DEFAULT_COST_INPUTS: CostInputs = { promptTokens: 20_000, completionTokens: 1_500, cachedPercent: 80 };

/** Reads the three fields of the estimate; an empty or wrong field keeps its default, the share is clamped to 0..100. */
export function parseCostInputs(prompt: string, completion: string, cached: string): CostInputs {
    const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));
    const cachedValue = parseNumber(cached);
    return {
        promptTokens: parseNumber(prompt) ?? DEFAULT_COST_INPUTS.promptTokens,
        completionTokens: parseNumber(completion) ?? DEFAULT_COST_INPUTS.completionTokens,
        cachedPercent: cachedValue === null ? DEFAULT_COST_INPUTS.cachedPercent : clampPercent(cachedValue),
    };
}

export interface CostView {
    /** Pay-as-you-go cost of one turn. */
    turn: string;
    /** The same turn with nothing read from cache (only shown when the model has a cache price and a share is set). */
    withoutCache: string | null;
    /** Cost of 100 such turns. */
    hundredTurns: string;
    /** The model has no cache price: the cached share changes nothing. */
    noCachePrice: boolean;
    /** A model in the subscription costs nothing real on the subscription; the figure is what it would cost pay-as-you-go. */
    subscriptionNote: string | null;
}

export function costView(model: CatalogModel, inputs: CostInputs, t: Translate): CostView {
    const usage = {
        promptTokens: inputs.promptTokens,
        completionTokens: inputs.completionTokens,
        cachedShare: inputs.cachedPercent / 100,
    };
    const turn = estimateTurnCost(model, usage);
    const noCachePrice = model.pricing.cacheRead === null;
    const plain = estimateTurnCost(model, { ...usage, cachedShare: 0 });
    const sub = model.subscription;
    return {
        turn: formatUsd(turn),
        withoutCache: !noCachePrice && inputs.cachedPercent > 0 ? formatUsd(plain) : null,
        hundredTurns: formatUsd(turn * 100),
        noCachePrice,
        subscriptionNote: sub.included
            ? sub.inputTokenMultiplier === 1
                ? t('catalog.cost.subscription')
                : t('catalog.cost.subscriptionMultiplier', { multiplier: trimZeros(String(sub.inputTokenMultiplier)) })
            : null,
    };
}

/* ------------------------------------------------------------------------------------------------ hosts */

export type HostPriority = 'balanced' | 'price' | 'speed' | 'uptime';

export const HOST_PRIORITIES: readonly HostPriority[] = ['balanced', 'price', 'speed', 'uptime'];

const PRIORITY_WEIGHTS: Record<HostPriority, { weightPrice: number; weightSpeed: number; weightUptime: number }> = {
    balanced: { weightPrice: 1, weightSpeed: 1, weightUptime: 1 },
    price: { weightPrice: 3, weightSpeed: 1, weightUptime: 1 },
    speed: { weightPrice: 1, weightSpeed: 3, weightUptime: 1 },
    uptime: { weightPrice: 1, weightSpeed: 1, weightUptime: 3 },
};

export interface HostCriteriaState {
    priority: HostPriority;
    /** '' = no preference. */
    preferQuantization: Quantization | '';
    /** USD per 1M tokens; null = no limit. */
    maxPrompt: number | null;
    maxCompletion: number | null;
}

export function defaultHostCriteria(): HostCriteriaState {
    return { priority: 'balanced', preferQuantization: '', maxPrompt: null, maxCompletion: null };
}

export function criteriaOf(state: HostCriteriaState): HostCriteria {
    return {
        ...PRIORITY_WEIGHTS[state.priority],
        ...(state.preferQuantization ? { preferQuantization: state.preferQuantization } : {}),
        ...(state.maxPrompt !== null || state.maxCompletion !== null
            ? { maxPrice: { prompt: state.maxPrompt, completion: state.maxCompletion } }
            : {}),
    };
}

export interface HostRow {
    rank: number;
    id: string;
    /** "fp4 (mxfp4)" when the host's label differs from the normalised one, "fp8", or "?" when it reports nothing. */
    quantization: string;
    /** "0.66 / 2.1" USD per 1M tokens, or "—". */
    price: string;
    tps: string;
    ttft: string;
    uptime: string;
    features: string[];
    /** Total score as a percentage of the best possible, "83". */
    score: string;
    overMaxPrice: boolean;
    /** The host is below the preferred precision. */
    belowQuantization: boolean;
    /** The host reports no precision and a preference is set. */
    unknownQuantization: boolean;
    /** Components the host reports nothing for. */
    missing: HostScore['missing'];
}

function quantizationText(host: ProviderEndpoint): string {
    if (host.quantization === null) return '?';
    if (host.rawQuantization && host.rawQuantization.toLowerCase() !== host.quantization) {
        return `${host.quantization} (${host.rawQuantization})`;
    }
    return host.quantization;
}

/** The hosts of a model, ranked for the criteria. */
export function hostRows(providers: ModelProviders, state: HostCriteriaState): HostRow[] {
    const scores = scoreHosts(providers.providers, criteriaOf(state));
    const byId = new Map(providers.providers.map((host) => [host.id, host]));
    const rows: HostRow[] = [];
    for (const score of scores) {
        const host = byId.get(score.providerId);
        if (!host) continue;
        rows.push({
            rank: score.rank,
            id: host.id,
            quantization: quantizationText(host),
            price: host.pricing ? formatPricePair(host.pricing.prompt, host.pricing.completion) : '—',
            tps: formatCount(host.tps, ''),
            ttft: host.ttftMs === null ? '—' : String(Math.round(host.ttftMs)),
            uptime: formatCount(host.uptime, '%'),
            features: host.features,
            score: String(Math.round(score.total * 100)),
            overMaxPrice: score.overMaxPrice,
            belowQuantization: score.meetsQuantization === false,
            unknownQuantization: state.preferQuantization !== '' && score.meetsQuantization === null,
            missing: score.missing,
        });
    }
    return rows;
}

export interface HostsSummary {
    /** Whether NanoGPT lets the connection choose hosts for this model at all. */
    selection: boolean;
    autoTps: string | null;
    autoTtft: string | null;
    /** Share of the prompt read from cache under automatic routing, "76%". */
    autoCache: string | null;
}

export function hostsSummary(providers: ModelProviders): HostsSummary {
    return {
        selection: providers.supportsProviderSelection,
        autoTps: providers.autoTps === null ? null : formatCount(providers.autoTps, ''),
        autoTtft: providers.autoTtftMs === null ? null : String(Math.round(providers.autoTtftMs)),
        autoCache: providers.autoCacheReadRate === null ? null : formatPercent(providers.autoCacheReadRate),
    };
}

/* ------------------------------------------------------------------------------------------------ hints */

export interface HintView {
    code: string;
    severity: RoutingHint['severity'];
    text: string;
    /** A one-click routing patch is attached. */
    suggestion: boolean;
    /** The patch in words ("precision floor fp8"), null without one. */
    suggestionText: string | null;
    /** The `billing.bypass` note: it explains what the suggestions cost, not a suggestion itself. */
    bypass: boolean;
}

/**
 * The i18n key of a hint. A rule with two readings (hosts known or not, found by the id or the shelf) has one text per
 * reading, chosen from its params.
 */
export function hintKey(hint: RoutingHint): string {
    const base = `catalog.hint.${hint.code}`;
    const { params } = hint;
    if (hint.code === 'quant.glmFp8') {
        if (params['hostsKnown'] === false) return `${base}.unknown`;
        if (params['okHosts'] === 0) return `${base}.noneOk`;
    }
    if (hint.code === 'shelf.uncensoredUnmeasured' && params['byShelf'] === false) return `${base}.byId`;
    return base;
}

/** Hint params as translate params: booleans become words nobody prints, the rest keep their value. */
export function hintParams(params: RoutingHint['params']): I18nParams {
    const out: I18nParams = {};
    for (const [key, value] of Object.entries(params)) out[key] = typeof value === 'boolean' ? String(value) : value;
    return out;
}

/** A routing patch in words. Only the fields a hint suggests are named; anything else is listed as `name: value`. */
export function suggestionText(patch: Partial<RoutingConfig>, t: Translate): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'enabled') continue;
        switch (key) {
            case 'minQuantization':
                parts.push(t('catalog.suggest.minQuantization', { value: String(value) }));
                break;
            case 'ignore':
                parts.push(t('catalog.suggest.ignore', { hosts: (value as string[]).join(', ') }));
                break;
            case 'only':
                parts.push(t('catalog.suggest.only', { hosts: (value as string[]).join(', ') }));
                break;
            case 'order':
                parts.push(t('catalog.suggest.order', { hosts: (value as string[]).join(', ') }));
                break;
            case 'quantizations':
                parts.push(t('catalog.suggest.quantizations', { value: (value as string[]).join(', ') }));
                break;
            default:
                parts.push(`${key}: ${JSON.stringify(value)}`);
        }
    }
    return parts.length > 0 ? parts.join('; ') : t('catalog.suggest.enable');
}

export function hintViews(hints: readonly RoutingHint[], t: Translate): HintView[] {
    return hints.map((hint) => ({
        code: hint.code,
        severity: hint.severity,
        text: t(hintKey(hint), hintParams(hint.params)),
        suggestion: hint.suggestedRouting !== undefined,
        suggestionText: hint.suggestedRouting ? suggestionText(hint.suggestedRouting, t) : null,
        bypass: hint.code === 'billing.bypass',
    }));
}

/** Several routing patches as one: lists (order, only, ignore, quantizations) are united, anything else the last one wins. */
export function mergeRoutingPatches(patches: readonly Partial<RoutingConfig>[]): Partial<RoutingConfig> {
    const merged: Record<string, unknown> = {};
    for (const patch of patches) {
        for (const [key, value] of Object.entries(patch)) {
            const before = merged[key];
            if (Array.isArray(value) && Array.isArray(before)) merged[key] = [...new Set([...before, ...value])];
            else merged[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    return merged as Partial<RoutingConfig>;
}

/* ------------------------------------------------------------------------------------------------ connections */

/**
 * What "Create a connection with this model" saves: the model, a name taken from it, the defaults of
 * `createConnection` for everything else, and the routing of the hints the user ticked (none = untouched routing).
 */
export function newConnectionPatch(
    model: CatalogModel,
    hints: readonly RoutingHint[],
    applied: ReadonlySet<string>,
): Partial<ConnectionConfig> & { name: string; modelId: string } {
    const routing = mergeRoutingPatches(
        hints.flatMap((hint) => (applied.has(hint.code) && hint.suggestedRouting ? [hint.suggestedRouting] : [])),
    );
    const patch: Partial<ConnectionConfig> & { name: string; modelId: string } = {
        name: model.name.trim().slice(0, 80) || model.id,
        modelId: model.id,
    };
    if (Object.keys(routing).length > 0) {
        // Merged over the defaults so the saved connection carries a whole routing object.
        patch.routing = { ...defaultRouting(), ...routing, enabled: true };
    }
    return patch;
}
