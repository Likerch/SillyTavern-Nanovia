// Typed catalog calls of the plugin's admin API (src/shared/contracts-catalog.ts, "admin API"), built on the plugin
// client's raw request. The plugin already normalised NanoGPT's answers; what arrives is read defensively all the same
// (an older or newer plugin, a proxy in between): a model or host that cannot be read is skipped, never thrown on.
// Like the rest of the plugin client, nothing here throws: every call resolves to a PluginResult.
import type { CatalogModel, ModelProviders, ProviderEndpoint, Quantization } from '../shared/contracts';
import type { CatalogResponse, ModelProvidersResponse } from '../shared/contracts-catalog';
import type { PluginClient, PluginResult } from './plugin-client';
import type { Logger } from './types';

export interface PluginCatalogClient {
    /** `GET /catalog` (`refresh` asks the plugin to fetch NanoGPT again). */
    catalog(options?: { refresh?: boolean }): Promise<PluginResult<CatalogResponse>>;
    /** `GET /catalog/providers?id=<model id>`: the id may carry suffixes, `modelId` of the answer is the catalog id. */
    providers(modelId: string, options?: { refresh?: boolean }): Promise<PluginResult<ModelProvidersResponse>>;
}

/** The catalog is ~700 KB: give the plugin more than the default call time when it has to fetch NanoGPT first. */
const CATALOG_TIMEOUT_MS = 30_000;
const PROVIDERS_TIMEOUT_MS = 20_000;

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positive(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n > 0 ? n : null;
}

function nonNegative(value: unknown): number | null {
    const n = finite(value);
    return n !== null && n >= 0 ? n : null;
}

function strings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

const QUANTIZATIONS: readonly string[] = ['int4', 'fp4', 'fp6', 'int8', 'fp8', 'fp16', 'bf16', 'fp32', 'unknown'];

/** One model of the contract shape (`CatalogModel`); null when it has no id or no usable prices. */
export function readCatalogModel(raw: unknown): CatalogModel | null {
    if (!isRecord(raw)) return null;
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
    if (!id) return null;
    const caps = isRecord(raw['capabilities']) ? raw['capabilities'] : {};
    const price = isRecord(raw['pricing']) ? raw['pricing'] : {};
    const sub = isRecord(raw['subscription']) ? raw['subscription'] : {};
    return {
        id,
        name: typeof raw['name'] === 'string' && raw['name'].trim() ? raw['name'].trim() : id,
        description: typeof raw['description'] === 'string' ? raw['description'] : '',
        contextLength: positive(raw['contextLength']),
        maxOutputTokens: positive(raw['maxOutputTokens']),
        capabilities: {
            vision: caps['vision'] === true,
            reasoning: caps['reasoning'] === true,
            toolCalling: caps['toolCalling'] === true,
            structuredOutput: caps['structuredOutput'] === true,
        },
        reasoningEfforts: strings(raw['reasoningEfforts']),
        openWeights: raw['openWeights'] === true,
        pricing: {
            prompt: nonNegative(price['prompt']) ?? 0,
            completion: nonNegative(price['completion']) ?? 0,
            cacheRead: nonNegative(price['cacheRead']),
        },
        category: typeof raw['category'] === 'string' && raw['category'] ? raw['category'] : null,
        subscription: {
            included: sub['included'] === true,
            inputTokenMultiplier: positive(sub['inputTokenMultiplier']) ?? 1,
        },
        providerIds: strings(raw['providerIds']),
        created: positive(raw['created']),
    };
}

/** A list of models of the contract shape: junk entries are skipped, a repeated id keeps its first entry. */
export function readCatalogModels(raw: unknown): CatalogModel[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: CatalogModel[] = [];
    for (const item of raw) {
        const model = readCatalogModel(item);
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        out.push(model);
    }
    return out;
}

function readEndpoint(raw: unknown): ProviderEndpoint | null {
    if (!isRecord(raw)) return null;
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
    if (!id) return null;
    const price = isRecord(raw['pricing']) ? raw['pricing'] : null;
    const prompt = price ? nonNegative(price['prompt']) : null;
    const completion = price ? nonNegative(price['completion']) : null;
    const quantization = raw['quantization'];
    return {
        id,
        quantization:
            typeof quantization === 'string' && QUANTIZATIONS.includes(quantization)
                ? (quantization as Quantization)
                : null,
        rawQuantization:
            typeof raw['rawQuantization'] === 'string' && raw['rawQuantization'] ? raw['rawQuantization'] : null,
        pricing:
            price && prompt !== null && completion !== null
                ? { prompt, completion, cacheRead: nonNegative(price['cacheRead']) }
                : null,
        tps: positive(raw['tps']),
        ttftMs: positive(raw['ttftMs']),
        uptime: nonNegative(raw['uptime']),
        maxOutputTokens: positive(raw['maxOutputTokens']),
        features: strings(raw['features']),
    };
}

/** A host list of the contract shape (`ModelProviders` + `fetchedAt`); null when it is not one. */
export function readModelProviders(raw: unknown, fallbackFetchedAt: number): ModelProvidersResponse | null {
    if (!isRecord(raw)) return null;
    const modelId = typeof raw['modelId'] === 'string' ? raw['modelId'].trim() : '';
    if (!modelId || !Array.isArray(raw['providers'])) return null;
    const seen = new Set<string>();
    const providers: ProviderEndpoint[] = [];
    for (const item of raw['providers']) {
        const endpoint = readEndpoint(item);
        if (!endpoint || seen.has(endpoint.id)) continue;
        seen.add(endpoint.id);
        providers.push(endpoint);
    }
    const rate = finite(raw['autoCacheReadRate']);
    const value: ModelProviders = {
        modelId,
        supportsProviderSelection: raw['supportsProviderSelection'] !== false,
        autoCacheReadRate: rate !== null && rate >= 0 && rate <= 1 ? rate : null,
        autoTps: positive(raw['autoTps']),
        autoTtftMs: positive(raw['autoTtftMs']),
        providers,
    };
    return { ...value, fetchedAt: positive(raw['fetchedAt']) ?? fallbackFetchedAt };
}

function invalid(what: string): PluginResult<never> {
    return { ok: false, error: { code: 'invalid_response', message: `unexpected ${what}`, status: null } };
}

export function createPluginCatalogClient(
    plugin: Pick<PluginClient, 'request'>,
    log: Logger,
    now: () => number = Date.now,
): PluginCatalogClient {
    return {
        async catalog(options) {
            const result = await plugin.request('GET', options?.refresh ? '/catalog?refresh=1' : '/catalog', {
                timeoutMs: CATALOG_TIMEOUT_MS,
            });
            if (!result.ok) return result;
            const data = result.data;
            if (!isRecord(data) || !Array.isArray(data['models'])) return invalid('catalog answer');
            const models = readCatalogModels(data['models']);
            if (models.length === 0) return invalid('catalog answer (no models)');
            if (models.length < data['models'].length)
                log.debug('the plugin sent models that could not be read; skipped');
            const source = data['source'];
            return {
                ok: true,
                data: {
                    models,
                    fetchedAt: positive(data['fetchedAt']) ?? now(),
                    source: source === 'live' || source === 'cache' || source === 'stale' ? source : 'cache',
                },
            };
        },

        async providers(modelId, options) {
            const query = `id=${encodeURIComponent(modelId)}${options?.refresh ? '&refresh=1' : ''}`;
            const result = await plugin.request('GET', `/catalog/providers?${query}`, {
                timeoutMs: PROVIDERS_TIMEOUT_MS,
            });
            if (!result.ok) return result;
            const value = readModelProviders(result.data, now());
            return value ? { ok: true, data: value } : invalid('host list');
        },
    };
}
