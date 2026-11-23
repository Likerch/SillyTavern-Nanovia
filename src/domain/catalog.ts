// Catalog logic (stage 3): turns NanoGPT's catalog and host lists into the contract types, filters and sorts them,
// estimates the cost of a turn and ranks the hosts of a model. Pure: no network, no clock; callers pass the data.
import type { CatalogModel, ModelProviders, ProviderEndpoint, Quantization } from '../shared/contracts';
import type {
    CatalogCategoryCount,
    CatalogQuery,
    CatalogSort,
    CatalogVendorGroup,
    HostComponent,
    HostCriteria,
    HostScore,
    TurnUsage,
} from '../shared/contracts-catalog';

/** Weight precisions from the coarsest to the finest. `unknown` is outside the scale. */
export const QUANTIZATION_ORDER: readonly Quantization[] = [
    'int4',
    'fp4',
    'fp6',
    'int8',
    'fp8',
    'fp16',
    'bf16',
    'fp32',
];

/** Uptime (percent) at or below which a host's uptime component is 0; 100% is 1. */
export const UPTIME_FLOOR = 90;

/** Group name of the models whose id has no vendor part. */
export const OTHER_VENDOR = 'other';

type Raw = Record<string, unknown>;

/* ------------------------------------------------------------------------------------------------ small helpers */

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Raw {
    return isRecord(value) ? value : {};
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n >= 0 ? n : null;
}

function positive(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n > 0 ? n : null;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const s = text(item);
        if (s) out.push(s);
    }
    return out;
}

/** Cleans float noise of unit conversions (0.0000042 * 1000 = 0.004200000000000001). */
function roundUsd(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}

function round4(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/** NanoGPT lists `…Per1kTokens`; the contracts hold USD per 1M tokens. */
function per1kToPer1m(value: number): number {
    return roundUsd(value * 1000);
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function compareNumbers(a: number, b: number): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------------ normalising */

/** `created` is seconds in NanoGPT's list; a millisecond value is tolerated. */
function toSeconds(value: unknown): number | null {
    const n = positive(value);
    if (n === null) return null;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * One entry of `GET /api/v1/models?detailed=true`. Null when it has no id. Everything else is tolerated: a missing
 * price becomes 0 (NanoGPT lists a few models as "varies by modality" without a price), a missing window becomes null.
 * `pricing.prompt/completion` are already USD per 1M; `cacheReadInputPer1kTokens` is per 1k and converted.
 */
export function normalizeCatalogModel(raw: unknown): CatalogModel | null {
    if (!isRecord(raw)) return null;
    const id = text(raw['id']);
    if (!id) return null;
    const caps = record(raw['capabilities']);
    const price = record(raw['pricing']);
    const sub = record(raw['subscription']);
    const cacheRead = nonNegative(price['cacheReadInputPer1kTokens']);
    return {
        id,
        name: text(raw['name']) || id,
        description: text(raw['description']),
        contextLength: positive(raw['context_length']),
        maxOutputTokens: positive(raw['max_output_tokens']),
        capabilities: {
            vision: caps['vision'] === true,
            reasoning: caps['reasoning'] === true,
            toolCalling: caps['tool_calling'] === true,
            structuredOutput: caps['structured_output'] === true,
        },
        reasoningEfforts: strings(raw['reasoning_efforts']),
        openWeights: raw['open_weights'] === true,
        pricing: {
            prompt: roundUsd(nonNegative(price['prompt']) ?? 0),
            completion: roundUsd(nonNegative(price['completion']) ?? 0),
            cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead),
        },
        category: text(raw['category']) || null,
        subscription: {
            included: sub['included'] === true,
            inputTokenMultiplier: positive(sub['inputTokenMultiplier']) ?? 1,
        },
        providerIds: strings(raw['providers']),
        created: toSeconds(raw['created']),
    };
}

/**
 * The whole answer of the models endpoint: the `{ data: [...] }` envelope or a bare array. Junk entries are skipped,
 * the order is kept, and a repeated id keeps its first entry.
 */
export function normalizeCatalog(rawList: unknown): CatalogModel[] {
    const list = Array.isArray(rawList)
        ? rawList
        : isRecord(rawList) && Array.isArray(rawList['data'])
          ? rawList['data']
          : [];
    const seen = new Set<string>();
    const out: CatalogModel[] = [];
    for (const item of list) {
        const model = normalizeCatalogModel(item);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        out.push(model);
    }
    return out;
}

/** Spellings of a host's weight precision (compared without case, spaces, `-`, `_` and `.`). */
const QUANTIZATION_ALIASES: Record<string, Quantization> = {
    fp4: 'fp4',
    mxfp4: 'fp4',
    nvfp4: 'fp4',
    int4: 'int4',
    '4bit': 'int4',
    fp6: 'fp6',
    mxfp6: 'fp6',
    int8: 'int8',
    '8bit': 'int8',
    fp8: 'fp8',
    mxfp8: 'fp8',
    float8: 'fp8',
    fp8e4m3: 'fp8',
    fp8e5m2: 'fp8',
    fp16: 'fp16',
    float16: 'fp16',
    half: 'fp16',
    bf16: 'bf16',
    bfloat16: 'bf16',
    fp32: 'fp32',
    float32: 'fp32',
};

/**
 * Maps what a host reports to the contract: `quantization` is the normalised precision (mxfp4/nvfp4 -> fp4, native,
 * unknown, `-` and labels we do not know -> 'unknown'); both fields are null when the host reports nothing.
 * `rawQuantization` keeps the label as the host wrote it.
 */
export function mapQuantization(raw: unknown): { quantization: Quantization | null; rawQuantization: string | null } {
    const label = text(raw);
    if (!label) return { quantization: null, rawQuantization: null };
    const key = label.toLowerCase().replace(/[\s_\-.]/g, '');
    return { quantization: QUANTIZATION_ALIASES[key] ?? 'unknown', rawQuantization: label };
}

function priceOf(raw: unknown): ProviderEndpoint['pricing'] {
    const p = record(raw);
    const input = nonNegative(p['inputPer1kTokens']);
    const output = nonNegative(p['outputPer1kTokens']);
    if (input === null || output === null) return null;
    const cacheRead = nonNegative(p['cacheReadInputPer1kTokens']);
    return {
        prompt: per1kToPer1m(input),
        completion: per1kToPer1m(output),
        cacheRead: cacheRead === null ? null : per1kToPer1m(cacheRead),
    };
}

/** NanoGPT reports `uptime: { uptimePct }` (percent); a bare number is taken as percent too. */
function uptimeOf(raw: unknown): number | null {
    const n = isRecord(raw) ? nonNegative(raw['uptimePct']) : nonNegative(raw);
    return n !== null && n <= 100 ? n : null;
}

/** `features` is an object of flags (`{ toolCalling: true, … }`): the names that are true. A list of names is kept. */
function featuresOf(raw: unknown): string[] {
    if (Array.isArray(raw)) return strings(raw);
    if (!isRecord(raw)) return [];
    return Object.keys(raw).filter((key) => raw[key] === true);
}

function normalizeEndpoint(raw: unknown): ProviderEndpoint | null {
    if (!isRecord(raw)) return null;
    const id = text(raw['provider']);
    // A host marked unavailable cannot be picked, so it is not offered (the contract has no field for it).
    if (!id || raw['available'] === false) return null;
    const { quantization, rawQuantization } = mapQuantization(raw['quantization']);
    return {
        id,
        quantization,
        rawQuantization,
        pricing: priceOf(raw['pricing']),
        tps: positive(raw['tps']),
        ttftMs: positive(raw['ttftMs']),
        uptime: uptimeOf(raw['uptime']),
        maxOutputTokens: positive(raw['maxOutputTokens']),
        features: featuresOf(raw['features']),
    };
}

/**
 * The answer of `GET /api/models/:id/providers`. `modelId` is the id the caller asked for (the answer's `canonicalId`
 * fills in when it is empty). A model without provider selection answers `supportsProviderSelection: false` and no host
 * list: that is a valid result with no hosts. Null when the body is not recognisable (an error shape, junk).
 * Prices become USD per 1M; unavailable hosts are dropped; a repeated host keeps its first entry.
 */
export function normalizeModelProviders(modelId: string, raw: unknown): ModelProviders | null {
    if (!isRecord(raw)) return null;
    const hosts = raw['providers'];
    const recognisable =
        Array.isArray(hosts) ||
        typeof raw['supportsProviderSelection'] === 'boolean' ||
        typeof raw['canonicalId'] === 'string';
    if (!recognisable) return null;
    const id = text(modelId) || text(raw['canonicalId']);
    if (!id) return null;
    const rate = finite(raw['autoCacheReadRate']);
    const seen = new Set<string>();
    const providers: ProviderEndpoint[] = [];
    for (const item of Array.isArray(hosts) ? hosts : []) {
        const endpoint = normalizeEndpoint(item);
        if (!endpoint || seen.has(endpoint.id)) continue;
        seen.add(endpoint.id);
        providers.push(endpoint);
    }
    return {
        modelId: id,
        supportsProviderSelection: raw['supportsProviderSelection'] !== false,
        autoCacheReadRate: rate !== null && rate >= 0 && rate <= 1 ? rate : null,
        autoTps: positive(raw['autoTps']),
        autoTtftMs: positive(raw['autoTtftMs']),
        providers,
    };
}

/* ------------------------------------------------------------------------------------------------ precision */

/** Position on the precision scale (int4 lowest); null for 'unknown', null and undefined. */
export function quantizationRank(q: Quantization | null | undefined): number | null {
    if (!q) return null;
    const index = QUANTIZATION_ORDER.indexOf(q);
    return index < 0 ? null : index;
}

/**
 * Does precision `q` reach the floor `min`? No floor (null or 'unknown') always passes. A host with an unknown precision
 * gives null: it cannot be checked, and what NanoGPT does with it is up to NanoGPT.
 */
export function meetsMinQuantization(
    q: Quantization | null | undefined,
    min: Quantization | null | undefined,
): boolean | null {
    const floor = quantizationRank(min);
    if (floor === null) return true;
    const rank = quantizationRank(q);
    return rank === null ? null : rank >= floor;
}

/* ------------------------------------------------------------------------------------------------ filter, sort */

/** Case-folds for search: lower case, ё = е, compatibility forms unified. No `\w`, so Cyrillic is safe. */
function fold(value: string): string {
    return value.normalize('NFKC').toLowerCase().replace(/ё/g, 'е');
}

/** The models that pass every field of the query, in their incoming order. */
export function filterCatalog(models: readonly CatalogModel[], query: CatalogQuery): CatalogModel[] {
    const words = fold(query.text ?? '')
        .split(/\s+/)
        .filter(Boolean);
    const categories = (query.categories ?? []).map(fold);
    const caps = query.capabilities ?? {};
    const minContext = finite(query.minContext);
    const maxPrompt = finite(query.maxPromptPrice);
    return models.filter((m) => {
        if (words.length > 0) {
            const haystack = fold(`${m.id}\n${m.name}\n${m.description}`);
            if (!words.every((w) => haystack.includes(w))) return false;
        }
        if (categories.length > 0 && !categories.includes(fold(m.category ?? ''))) return false;
        if (query.subscriptionOnly && !m.subscription.included) return false;
        if (caps.vision && !m.capabilities.vision) return false;
        if (caps.reasoning && !m.capabilities.reasoning) return false;
        if (caps.tools && !m.capabilities.toolCalling) return false;
        if (caps.structured && !m.capabilities.structuredOutput) return false;
        if (minContext !== null && (m.contextLength === null || m.contextLength < minContext)) return false;
        if (maxPrompt !== null && m.pricing.prompt > maxPrompt) return false;
        if (query.openWeightsOnly && !m.openWeights) return false;
        return true;
    });
}

/** The shelves of the list with their sizes, the biggest first (equal sizes keep the order of first appearance). */
export function listCategories(models: readonly CatalogModel[]): CatalogCategoryCount[] {
    const counts = new Map<string | null, number>();
    for (const m of models) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
    return [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

const NAME_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Unknown values (null) always go last, whichever way the order runs. */
function compareNullable(a: number | null, b: number | null, direction: 1 | -1): number {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return direction * compareNumbers(a, b);
}

/** A sorted copy; see `CatalogSort` for the orders. `reverse` turns the order around. Ties keep their incoming order. */
export function sortCatalog(models: readonly CatalogModel[], sort: CatalogSort, reverse = false): CatalogModel[] {
    const dir: 1 | -1 = reverse ? -1 : 1;
    const price = (m: CatalogModel): number => m.pricing.prompt + m.pricing.completion;
    const compare = (a: CatalogModel, b: CatalogModel): number => {
        switch (sort) {
            case 'name':
                return dir * NAME_COLLATOR.compare(a.name, b.name);
            case 'price':
                return dir * compareNumbers(price(a), price(b));
            case 'context':
                return compareNullable(a.contextLength, b.contextLength, reverse ? 1 : -1);
            case 'newest':
                return compareNullable(a.created, b.created, reverse ? 1 : -1);
            case 'subscription':
                return dir * (Number(b.subscription.included) - Number(a.subscription.included));
        }
    };
    return [...models].sort(compare);
}

/* ------------------------------------------------------------------------------------------------ vendors */

/** The part of the id before the first `/`, lower case (`z-ai/glm-5.3` -> `z-ai`, `TEE/glm-5.3` -> `tee`); else 'other'. */
export function vendorOf(id: string): string {
    const slash = id.indexOf('/');
    const vendor = slash > 0 ? id.slice(0, slash).trim().toLowerCase() : '';
    return vendor || OTHER_VENDOR;
}

/** Groups by vendor. Groups come in the order their first model appears, so a prior sort carries over. */
export function groupByVendor(models: readonly CatalogModel[]): CatalogVendorGroup[] {
    const groups = new Map<string, CatalogVendorGroup>();
    for (const model of models) {
        const vendor = vendorOf(model.id);
        const group = groups.get(vendor);
        if (group) group.models.push(model);
        else groups.set(vendor, { vendor, models: [model] });
    }
    return [...groups.values()];
}

/* ------------------------------------------------------------------------------------------------ cost */

function tokens(value: unknown): number {
    return nonNegative(value) ?? 0;
}

/**
 * Pay-as-you-go cost of one turn in USD. The cached part of the prompt is billed at `pricing.cacheRead` (the plain
 * prompt price when the model has none). A subscription-included model costs nothing real: that is for the caller.
 */
export function estimateTurnCost(model: CatalogModel, usage: TurnUsage): number {
    const prompt = tokens(usage.promptTokens);
    const completion = tokens(usage.completionTokens);
    const cached = prompt * clamp01(finite(usage.cachedShare) ?? 0);
    const { prompt: promptPrice, completion: completionPrice, cacheRead } = model.pricing;
    const usd =
        ((prompt - cached) * promptPrice + cached * (cacheRead ?? promptPrice) + completion * completionPrice) / 1e6;
    return roundUsd(usd);
}

/* ------------------------------------------------------------------------------------------------ hosts */

function normalisedWeights(criteria: HostCriteria): { price: number; speed: number; uptime: number } {
    const w = (v: number): number => nonNegative(v) ?? 0;
    const price = w(criteria.weightPrice);
    const speed = w(criteria.weightSpeed);
    const uptime = w(criteria.weightUptime);
    const sum = price + speed + uptime;
    return sum > 0
        ? { price: price / sum, speed: speed / sum, uptime: uptime / sum }
        : { price: 1 / 3, speed: 1 / 3, uptime: 1 / 3 };
}

function numbersOf(values: (number | null)[]): number[] {
    return values.filter((v): v is number => v !== null);
}

/** Order inside the ranking: hosts over the price cap last, then hosts below the preferred precision. */
function tierOf(overMaxPrice: boolean, meets: boolean | null, hasPreference: boolean): number {
    if (overMaxPrice) return 3;
    if (meets === false) return 2;
    return hasPreference && meets === null ? 1 : 0;
}

/**
 * Ranks the hosts of one model for the given priorities. Components and the total are described at `HostScore`;
 * hosts in the same tier (see `tierOf`) are ordered by total, then by their incoming order.
 */
export function scoreHosts(providers: readonly ProviderEndpoint[], criteria: HostCriteria): HostScore[] {
    const weights = normalisedWeights(criteria);
    const blended = providers.map((p) => (p.pricing ? p.pricing.prompt + p.pricing.completion : null));
    const cheapest = Math.min(...numbersOf(blended));
    const bestTps = Math.max(...numbersOf(providers.map((p) => positive(p.tps))));
    const bestTtft = Math.min(...numbersOf(providers.map((p) => positive(p.ttftMs))));
    const preference = criteria.preferQuantization;
    const hasPreference = quantizationRank(preference) !== null;
    const cap = criteria.maxPrice;

    const scored = providers.map((p, index) => {
        const missing: HostComponent[] = [];
        const own = blended[index] ?? null;

        let price = 0;
        if (own === null) missing.push('price');
        else price = own <= cheapest ? 1 : cheapest / own;

        const parts: number[] = [];
        const tps = positive(p.tps);
        const ttft = positive(p.ttftMs);
        if (tps !== null) parts.push(tps / bestTps);
        if (ttft !== null) parts.push(bestTtft / ttft);
        let speed = 0;
        if (parts.length === 0) missing.push('speed');
        else speed = parts.reduce((sum, v) => sum + v, 0) / parts.length;

        let uptime = 0;
        if (p.uptime === null) missing.push('uptime');
        else uptime = clamp01((p.uptime - UPTIME_FLOOR) / (100 - UPTIME_FLOOR));

        const overMaxPrice =
            !!cap &&
            !!p.pricing &&
            ((cap.prompt !== null && p.pricing.prompt > cap.prompt) ||
                (cap.completion !== null && p.pricing.completion > cap.completion));
        const meetsQuantization = hasPreference ? meetsMinQuantization(p.quantization, preference) : null;
        const total = weights.price * price + weights.speed * speed + weights.uptime * uptime;
        return {
            index,
            tier: tierOf(overMaxPrice, meetsQuantization, hasPreference),
            score: {
                providerId: p.id,
                rank: 0,
                total: round4(total),
                price: round4(price),
                speed: round4(speed),
                uptime: round4(uptime),
                missing,
                overMaxPrice,
                meetsQuantization,
            } satisfies HostScore,
        };
    });
    scored.sort((a, b) => a.tier - b.tier || b.score.total - a.score.total || a.index - b.index);
    return scored.map((entry, i) => ({ ...entry.score, rank: i + 1 }));
}
