// Fixtures for the tests of routing, billing views and direct mode: catalog models, connections, a small catalog store.
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { CatalogStore } from '../../src/core/catalog';
import { createConnection, defaultRouting } from '../../src/domain/connection';
import type { CatalogModel, ConnectionConfig, ModelProviders, RoutingConfig } from '../../src/shared/contracts';

export function makeModel(
    over: Partial<CatalogModel> & { included?: boolean; multiplier?: number } = {},
): CatalogModel {
    const { included, multiplier, ...rest } = over;
    return {
        id: 'vendor/model',
        name: 'Model',
        description: '',
        contextLength: 128000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: ['low', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: included ?? true, inputTokenMultiplier: multiplier ?? 1 },
        providerIds: [],
        created: null,
        ...rest,
    };
}

export function makeConnection(
    over: Partial<Omit<ConnectionConfig, 'routing'>> & { routing?: Partial<RoutingConfig> } = {},
): ConnectionConfig {
    const { routing, ...rest } = over;
    const base = createConnection({ name: 'Test', modelId: 'vendor/model' }, 'abc12345', 1);
    return { ...base, ...rest, routing: { ...defaultRouting(), ...routing } };
}

export function makeProviders(over: Partial<ModelProviders> & { ids?: string[] } = {}): ModelProviders {
    const { ids, ...rest } = over;
    return {
        modelId: 'vendor/model',
        supportsProviderSelection: true,
        autoCacheReadRate: null,
        autoTps: null,
        autoTtftMs: null,
        providers: (ids ?? ['alpha', 'beta']).map((id) => ({
            id,
            quantization: 'fp8',
            rawQuantization: 'fp8',
            pricing: null,
            tps: null,
            ttftMs: null,
            uptime: null,
            maxOutputTokens: null,
            features: [],
        })),
        ...rest,
    };
}

/** A catalog store over fixed data: `models` by id (suffixes fall back to the base id), `providers` by model id. */
export function catalogOf(models: CatalogModel[] = [], providers: ModelProviders[] = []): CatalogStore {
    const store = createEmptyCatalogStore();
    const byId = new Map(models.map((model) => [model.id, model]));
    const hosts = new Map(providers.map((entry) => [entry.modelId, entry]));
    return {
        ...store,
        models: () => models,
        model: (id) => byId.get(id) ?? byId.get(id.replace(/:(online|memory(-\d+)?)$/, '')) ?? null,
        providers: (id) => hosts.get(id) ?? null,
        ensureProviders: async (id) => hosts.get(id) ?? null,
    };
}
