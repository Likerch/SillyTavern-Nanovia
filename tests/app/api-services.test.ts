// @vitest-environment happy-dom
// NANOVIA_API members that need the catalog, the usage and account stores and the panel (stage 0.4 / 0.5 additions).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiPublisher } from '../../src/app/api';
import type { ApiPublisher } from '../../src/app/api';
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { CatalogStore } from '../../src/core/catalog';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { CatalogModel, NanoviaApi } from '../../src/shared/contracts';
import { usageRecord } from '../helpers/account-fake';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const globals = globalThis as unknown as Record<string, unknown>;

function model(id: string, patch: Partial<CatalogModel> = {}): CatalogModel {
    return {
        id,
        name: id,
        description: '',
        contextLength: 128_000,
        maxOutputTokens: null,
        capabilities: { vision: true, reasoning: true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: ['none', 'low', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: true, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
        ...patch,
    };
}

function fakeCatalog(models: CatalogModel[], loaded = true): CatalogStore {
    return {
        ...createEmptyCatalogStore(),
        models: () => models,
        model: (id) => models.find((item) => item.id === id) ?? null,
        status: () => ({ loaded, fetchedAt: null, source: null, error: null }),
    };
}

let h: Harness;
let tc: TestContext;
let publisher: ApiPublisher;
let api: NanoviaApi;
let open: ReturnType<typeof vi.fn<(tab?: string) => void>>;
let qvink = false;

const CATALOG = [
    model('vendor/optional'),
    model('vendor/always', {
        reasoningEfforts: ['low', 'high'],
        capabilities: { vision: false, reasoning: true, toolCalling: false, structuredOutput: false },
    }),
    model('vendor/plain', { reasoningEfforts: [], pricing: { prompt: 0.1, completion: 0.1, cacheRead: null } }),
];

function start(catalog: CatalogStore = fakeCatalog(CATALOG)): void {
    h = createHarness();
    tc = createContext(h);
    open = vi.fn();
    publisher = createApiPublisher({
        version: '1.2.3',
        features: () => ['connections', 'account'],
        connections: h.connections,
        profiles: h.profiles,
        settings: h.settings,
        log: h.log,
        catalog,
        usage: tc.usage,
        account: tc.account,
        panel: { open },
        qvinkInstalled: () => qvink,
    });
    publisher.publish();
    api = publisher.api;
}

beforeEach(() => {
    qvink = false;
    start();
});

afterEach(() => {
    tc.usage.dispose();
    publisher.dispose();
    delete globals[NANOVIA_API_GLOBAL];
    h.restore();
});

async function connection(patch: Record<string, unknown> = {}): Promise<{ id: string; profileId: string }> {
    const saved = await h.connections.save({
        patch: {
            name: 'Main',
            modelId: 'vendor/optional',
            mode: 'plugin',
            reasoning: { policy: 'off', effort: null, hideThoughts: false },
            ...patch,
        },
    });
    if (!saved.ok) throw new Error('save failed');
    return { id: saved.data.id, profileId: h.manager.profiles.at(-1)!.id };
}

describe('feature detection', () => {
    it('lists the panel features that run and every member that is installed, once', () => {
        expect(api.features).toEqual([
            'connections',
            'account',
            'describeProfile',
            'describeUrl',
            'usage',
            'advice',
            'panel',
        ]);
        for (const name of ['usage', 'account', 'advice', 'openPanel', 'describeUrl', 'describeProfile']) {
            expect(api[name as keyof NanoviaApi], name).toBeDefined();
        }
        expect(api.version).toBe(1);
    });

    it('only adds members', () => {
        expect(Object.keys(api).sort()).toEqual([
            'account',
            'advice',
            'connections',
            'describeProfile',
            'describeUrl',
            'features',
            'nanoviaVersion',
            'openPanel',
            'usage',
            'version',
        ]);
    });
});

describe('describeProfile() capabilities', () => {
    it('are filled from the catalog', async () => {
        const { profileId } = await connection();
        expect(api.describeProfile(profileId)?.capabilities).toEqual({
            reasoning: true,
            reasoningEfforts: ['none', 'low', 'high'],
            canDisableReasoning: true,
            structuredOutput: true,
            toolCalling: true,
            vision: true,
        });
    });

    it('say a model that always reasons cannot be made quiet', async () => {
        const { profileId } = await connection({ modelId: 'vendor/always' });
        expect(api.describeProfile(profileId)?.capabilities).toMatchObject({
            reasoningEfforts: ['low', 'high'],
            canDisableReasoning: false,
            structuredOutput: false,
            vision: false,
        });
    });

    it('are null for a model the catalog does not know, and for a missing catalog', async () => {
        const { profileId } = await connection({ modelId: 'vendor/unlisted' });
        expect(api.describeProfile(profileId)?.capabilities).toBeNull();
        const { profileId: second } = await connection({ name: 'Second', modelId: 'vendor/optional' });
        publisher.dispose();
        publisher = createApiPublisher({
            version: '1',
            features: () => [],
            connections: h.connections,
            profiles: h.profiles,
            settings: h.settings,
            log: h.log,
        });
        expect(publisher.api.describeProfile(second)?.capabilities).toBeNull();
    });

    it('hands out copies of the efforts', async () => {
        const { profileId } = await connection();
        api.describeProfile(profileId)?.capabilities?.reasoningEfforts.push('max');
        expect(api.describeProfile(profileId)?.capabilities?.reasoningEfforts).toEqual(['none', 'low', 'high']);
    });
});

describe('describeUrl()', () => {
    it('resolves the proxy URL of a connection to its description', async () => {
        const { id } = await connection();
        const url = h.connections.get(id)!.view!.proxyUrl;
        expect(api.describeUrl?.(url)).toMatchObject({ connectionId: id, name: 'Main', modelId: 'vendor/optional' });
        expect(api.describeUrl?.(`${url}/`)?.connectionId).toBe(id);
        expect(api.describeUrl?.(url)?.capabilities?.canDisableReasoning).toBe(true);
    });

    it('answers null for anything else', async () => {
        const { id } = await connection();
        const url = h.connections.get(id)!.view!.proxyUrl;
        expect(api.describeUrl?.('https://api.nano-gpt.com/api/v1')).toBeNull();
        expect(api.describeUrl?.('http://127.0.0.1:8787/c/zzzzzzzz/v1')).toBeNull();
        expect(api.describeUrl?.(`${url}/chat/completions`)).toBeNull();
        expect(api.describeUrl?.('https://example.com/c/' + id + '/v1')).toBeNull();
        expect(api.describeUrl?.('')).toBeNull();
        expect(api.describeUrl?.('not a url')).toBeNull();
        expect(api.describeUrl?.(undefined as unknown as string)).toBeNull();
    });
});

describe('usage', () => {
    it('reads today and the recent requests of the store', async () => {
        const at = Date.now();
        await h.bus.emit('usage:record', {
            record: usageRecord({ at, requestId: 'r1', costUsd: 0.5, equivalentUsd: 1 }),
        });
        await h.bus.emit('usage:record', {
            record: usageRecord({ at: at + 1, requestId: 'r2', costUsd: 0, equivalentUsd: 2 }),
        });
        expect(api.usage?.today()).toMatchObject({ requests: 2, costUsd: 0.5, equivalentUsd: 3 });
        expect(api.usage?.recent(1).map((record) => record.requestId)).toEqual(['r2']);
        expect(api.usage?.recent().map((record) => record.requestId)).toEqual(['r2', 'r1']);
    });

    it('calls a listener for every new record until it unsubscribes', async () => {
        const seen = vi.fn();
        const off = api.usage!.onRecord(seen);
        await h.bus.emit('usage:record', { record: usageRecord({ requestId: 'a' }) });
        await h.bus.emit('usage:record', { record: usageRecord({ requestId: 'a' }) });
        off();
        await h.bus.emit('usage:record', { record: usageRecord({ requestId: 'b' }) });
        expect(seen).toHaveBeenCalledOnce();
        expect(seen.mock.calls[0]?.[0]).toMatchObject({ requestId: 'a' });
    });
});

describe('account', () => {
    it('has no snapshot until refreshed, then the brief of the account', async () => {
        expect(api.account?.snapshot()).toBeNull();
        tc.fake.subscription = {
            active: true,
            daily: { used: 1, limit: 4, resetsAt: null },
            weekly: { used: 0, limit: 0, resetsAt: null },
            recommendedMode: 'subscription',
        };
        await h.connections.refresh();
        const brief = await api.account?.refresh();
        expect(brief).toMatchObject({ usdBalance: '12.50', subscription: { dailyUsed: 0.25, weeklyUsed: null } });
        expect(api.account?.snapshot()).toEqual(brief);
    });

    it('answers null, without throwing, when the plugin is away', async () => {
        h.backend.plugin.up = false;
        await h.connections.refresh();
        await expect(api.account?.refresh()).resolves.toBeNull();
        expect(api.account?.snapshot()).toBeNull();
    });
});

describe('advice.backgroundProfile()', () => {
    it('is null for a profile that is not a Nanovia connection', async () => {
        await connection();
        h.manager.profiles.push({ id: 'foreign', name: 'My OpenAI', api: 'openai', model: 'gpt' });
        expect(api.advice?.backgroundProfile('foreign')).toBeNull();
        expect(api.advice?.backgroundProfile('nope')).toBeNull();
        expect(api.advice?.backgroundProfile('')).toBeNull();
    });

    it('is clean for a quiet model on a healthy connection, and suggests models from the catalog', async () => {
        const { profileId } = await connection();
        expect(api.advice?.backgroundProfile(profileId)).toEqual({
            ok: true,
            issues: [],
            suggestedModels: ['vendor/plain', 'vendor/optional'],
        });
    });

    it('reports a model that always reasons', async () => {
        const { profileId } = await connection({ modelId: 'vendor/always' });
        const advice = api.advice?.backgroundProfile(profileId);
        expect(advice?.ok).toBe(false);
        expect(advice?.issues.map((issue) => issue.code)).toEqual(['reasoning.alwaysOn']);
    });

    it('reports an unknown model, also while the catalog is empty', async () => {
        const { profileId } = await connection({ modelId: 'vendor/unlisted' });
        expect(api.advice?.backgroundProfile(profileId)?.issues).toEqual([
            { code: 'model.unknown', severity: 'info', params: { model: 'vendor/unlisted', catalogLoaded: true } },
        ]);
        publisher.dispose();
        start(createEmptyCatalogStore());
        const { profileId: again } = await connection({ modelId: 'vendor/unlisted' });
        expect(api.advice?.backgroundProfile(again)).toMatchObject({
            issues: [{ code: 'model.unknown', params: { catalogLoaded: false } }],
            suggestedModels: [],
        });
    });

    it('reports a plugin-mode connection while the plugin is down, and only then', async () => {
        const { profileId } = await connection();
        expect(api.advice?.backgroundProfile(profileId)?.issues).toEqual([]);
        h.backend.plugin.up = false;
        await h.connections.refresh();
        expect(api.advice?.backgroundProfile(profileId)?.issues.map((issue) => issue.code)).toEqual([
            'route.pluginDown',
        ]);
    });

    it('reports Context Memory next to Qvink, and explicit routing that leaves the subscription', async () => {
        const { profileId } = await connection({
            memory: { enabled: true, expirationDays: null },
            billing: 'auto',
            routing: { ...h.connections.list()[0]?.config.routing, enabled: true, only: ['host-a'] },
        });
        const codes = () => api.advice?.backgroundProfile(profileId)?.issues.map((issue) => issue.code);
        expect(codes()).toEqual(['billing.bypassesSubscription']);
        qvink = true;
        expect(codes()).toEqual(['billing.bypassesSubscription', 'memory.overlapsQvink']);
    });
});

describe('openPanel()', () => {
    it('opens the panel at the tab', () => {
        api.openPanel?.('account');
        api.openPanel?.();
        api.openPanel?.('');
        expect(open.mock.calls).toEqual([['account'], [undefined], [undefined]]);
    });

    it('survives a panel that throws', () => {
        open.mockImplementation(() => {
            throw new Error('no drawer');
        });
        expect(() => api.openPanel?.('account')).not.toThrow();
    });
});
