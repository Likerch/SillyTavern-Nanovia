import { describe, expect, it } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import { scoreHosts } from '../../src/domain/catalog';
import { HINT_CODES, routingHints } from '../../src/domain/catalog-hints';
import { CATALOG_STRINGS } from '../../src/features/catalog/strings';
import {
    CAPABILITIES,
    CONTEXT_CHOICES,
    DEFAULT_COST_INPUTS,
    PAGE_SIZE,
    buildList,
    categoryChips,
    categoryLabel,
    clearedFilters,
    costView,
    criteriaOf,
    defaultFilters,
    defaultHostCriteria,
    detailOf,
    errorText,
    formatAge,
    formatContext,
    formatPercent,
    formatPrice,
    formatPricePair,
    formatUsd,
    hasActiveFilters,
    hintKey,
    hintParams,
    hintViews,
    hostRows,
    hostsSummary,
    mergeRoutingPatches,
    newConnectionPatch,
    parseCostInputs,
    parseNumber,
    queryOf,
    rowOf,
    statusView,
    subscriptionBadge,
    suggestionText,
    toggleCategory,
    vendorLabel,
} from '../../src/features/catalog/view-model';
import type { FilterState } from '../../src/features/catalog/view-model';
import type { CatalogModel } from '../../src/shared/contracts';
import type { RoutingHint } from '../../src/shared/contracts-catalog';
import {
    DEEPSEEK,
    EMBER,
    GLM,
    GLM_FIXED_ROUTE,
    SAMPLE_MODELS,
    TEE_GLM,
    sampleProviders,
} from '../helpers/catalog-fakes';

const i18n = createI18n(() => 'en');
i18n.register(CATALOG_STRINGS);
const t = i18n.t.bind(i18n);

const byId = (id: string): CatalogModel => {
    const model = SAMPLE_MODELS.find((m) => m.id === id);
    if (!model) throw new Error(`no ${id}`);
    return model;
};
const ids = (models: readonly { id: string }[]): string[] => models.map((m) => m.id);

describe('formatting', () => {
    it('prices in three significant digits', () => {
        expect(formatPrice(0.0387)).toBe('0.0387');
        expect(formatPrice(0.6)).toBe('0.6');
        expect(formatPrice(1.1)).toBe('1.1');
        expect(formatPrice(15)).toBe('15');
        expect(formatPrice(0.060500000000000005)).toBe('0.0605');
        expect(formatPrice(0)).toBe('0');
        expect(formatPrice(-1)).toBe('0');
        expect(formatPrice(Number.NaN)).toBe('0');
        expect(formatPrice(0.00000089)).toBe('0.00000089');
        expect(formatPricePair(0.6, 1.1)).toBe('0.6 / 1.1');
    });

    it('context in K and M, in 1024s for the usual powers of two', () => {
        expect(formatContext(1_048_576)).toBe('1M');
        expect(formatContext(131_072)).toBe('128K');
        expect(formatContext(65_536)).toBe('64K');
        expect(formatContext(200_000)).toBe('200K');
        expect(formatContext(1_000_000)).toBe('1M');
        expect(formatContext(512_000)).toBe('512K');
        expect(formatContext(49_152)).toBe('48K');
        expect(formatContext(500)).toBe('500');
        expect(formatContext(null)).toBe('?');
        expect(formatContext(0)).toBe('?');
    });

    it('costs with at least two decimals unless tiny', () => {
        expect(formatUsd(0)).toBe('$0');
        expect(formatUsd(0.00001)).toBe('<$0.0001');
        expect(formatUsd(0.0123)).toBe('$0.0123');
        expect(formatUsd(0.5)).toBe('$0.50');
        expect(formatUsd(1.5)).toBe('$1.50');
        expect(formatUsd(12.3456)).toBe('$12.35');
        expect(formatUsd(0.05)).toBe('$0.05');
        expect(formatPercent(0.7622)).toBe('76%');
    });

    it('ages', () => {
        expect(formatAge(1000, 1000 + 30_000, t)).toBe('just now');
        expect(formatAge(0, 5 * 60_000, t)).toBe('5 min ago');
        expect(formatAge(0, 3 * 3_600_000, t)).toBe('3 h ago');
        expect(formatAge(0, 3 * 86_400_000, t)).toBe('3 d ago');
        expect(formatAge(5000, 1000, t)).toBe('just now');
    });

    it('numbers typed by people', () => {
        expect(parseNumber(' 20 000 ')).toBe(20000);
        expect(parseNumber('1,5')).toBe(1.5);
        expect(parseNumber('')).toBeNull();
        expect(parseNumber('abc')).toBeNull();
        expect(parseNumber('-3')).toBeNull();
    });
});

describe('names', () => {
    it('shelves in the user language, unknown ones as NanoGPT names them', () => {
        expect(categoryLabel('Uncensored', t)).toBe('Uncensored');
        expect(categoryLabel('Roleplay/storytelling models', t)).toBe('Roleplay and storytelling');
        expect(categoryLabel('Private/TEE', t)).toBe('Private / TEE');
        expect(categoryLabel('More', t)).toBe('More');
        expect(categoryLabel(null, t)).toBe('No shelf');
        expect(categoryLabel('', t)).toBe('No shelf');
        expect(categoryLabel('Brand new shelf', t)).toBe('Brand new shelf');
        expect(vendorLabel('z-ai', t)).toBe('z-ai');
        expect(vendorLabel('other', t)).toBe('other');
    });

    it('subscription badges say the multiplier when it is not 1', () => {
        expect(subscriptionBadge(byId(GLM), t)?.label).toBe('In subscription');
        expect(subscriptionBadge(byId('deepseek/deepseek-v4-pro-0813'), t)?.label).toBe('In subscription ×2');
        expect(subscriptionBadge(byId(EMBER), t)).toBeNull();
    });
});

describe('filter state', () => {
    it('starts with no filter and turns every control into the query', () => {
        const state = defaultFilters();
        expect(queryOf(state)).toEqual({});
        expect(hasActiveFilters(state)).toBe(false);
        const set: FilterState = {
            ...state,
            text: ' glm ',
            categories: ['Uncensored', ''],
            subscriptionOnly: true,
            vision: true,
            tools: true,
            minContext: 131072,
            maxPromptPrice: 1,
            openWeightsOnly: true,
        };
        expect(queryOf(set)).toEqual({
            text: ' glm ',
            categories: ['Uncensored', ''],
            subscriptionOnly: true,
            capabilities: { vision: true, tools: true },
            minContext: 131072,
            maxPromptPrice: 1,
            openWeightsOnly: true,
        });
        expect(hasActiveFilters(set)).toBe(true);
    });

    it('a blank text, sort, reverse and grouping are not filters', () => {
        const state = { ...defaultFilters(), text: '   ', sort: 'price' as const, reverse: true, groupByVendor: true };
        expect(hasActiveFilters(state)).toBe(false);
    });

    it('clearing keeps the sort and the grouping', () => {
        const state = {
            ...defaultFilters(),
            text: 'x',
            vision: true,
            sort: 'context' as const,
            reverse: true,
            groupByVendor: true,
        };
        expect(clearedFilters(state)).toEqual({
            ...defaultFilters(),
            sort: 'context',
            reverse: true,
            groupByVendor: true,
        });
    });

    it('toggles a shelf on and off', () => {
        const on = toggleCategory(defaultFilters(), 'Uncensored');
        expect(on.categories).toEqual(['Uncensored']);
        expect(toggleCategory(on, '').categories).toEqual(['Uncensored', '']);
        expect(toggleCategory(on, 'Uncensored').categories).toEqual([]);
    });

    it('offers the context choices the filter uses', () => {
        expect(CONTEXT_CHOICES[0]).toBe(0);
        expect([...CONTEXT_CHOICES]).toEqual([...CONTEXT_CHOICES].sort((a, b) => a - b));
    });
});

describe('the list', () => {
    it('shows every model of the catalog by default, sorted by name', () => {
        const list = buildList(SAMPLE_MODELS, defaultFilters(), PAGE_SIZE, t);
        expect(list.total).toBe(SAMPLE_MODELS.length);
        expect(list.matched).toBe(SAMPLE_MODELS.length);
        expect(list.shown).toBe(SAMPLE_MODELS.length);
        expect(list.remaining).toBe(0);
        expect(list.sections).toHaveLength(1);
        expect(list.sections[0]?.vendor).toBeNull();
        const names = list.sections[0]?.rows.map((row) => row.name) ?? [];
        expect(names).toEqual(
            [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })),
        );
    });

    it('draws a row with price, context, capabilities and the subscription badge', () => {
        const row = rowOf(byId(GLM), t);
        expect(row).toMatchObject({
            id: GLM,
            name: 'GLM 5.3',
            price: '0.6 / 1.1',
            context: '1M',
            openWeights: true,
        });
        expect(row.capabilities).toEqual(['reasoning', 'tools', 'structured']);
        expect(row.subscription?.label).toBe('In subscription');
        expect(rowOf(byId(DEEPSEEK), t).capabilities).toEqual(['vision', 'reasoning', 'tools', 'structured']);
        expect(rowOf(byId('fastgpt'), t).context).toBe('?');
    });

    it('cuts to the first page and says how many are left', () => {
        const list = buildList(SAMPLE_MODELS, defaultFilters(), 5, t);
        expect(list.shown).toBe(5);
        expect(list.remaining).toBe(SAMPLE_MODELS.length - 5);
        expect(list.sections[0]?.rows).toHaveLength(5);
        const many = Array.from({ length: 130 }, (_, i) => ({
            ...(SAMPLE_MODELS[0] as CatalogModel),
            id: `v/m${i}`,
            name: `M${i}`,
        }));
        const paged = buildList(many, defaultFilters(), PAGE_SIZE, t);
        expect([paged.shown, paged.remaining]).toEqual([50, 80]);
        expect(buildList(many, defaultFilters(), PAGE_SIZE * 3, t).remaining).toBe(0);
        expect(buildList(many, defaultFilters(), -4, t).shown).toBe(0);
    });

    it('filters by text, shelf, subscription, capabilities, context, price and open weights', () => {
        const run = (patch: Partial<FilterState>) =>
            ids(buildList(SAMPLE_MODELS, { ...defaultFilters(), ...patch }, 999, t).sections.flatMap((s) => s.rows));
        expect(run({ text: 'glm 5.3 flash' })).toEqual(['z-ai/glm-5.3-flash-apex-abliterated']);
        expect(run({ categories: ['Private/TEE'] }).sort()).toEqual([TEE_GLM, 'TEE/glm-5.2'].sort());
        expect(run({ categories: [''] })).toContain('auto-model');
        expect(run({ subscriptionOnly: true }).every((id) => byId(id).subscription.included)).toBe(true);
        expect(run({ vision: true }).every((id) => byId(id).capabilities.vision)).toBe(true);
        expect(run({ vision: true, structured: true }).every((id) => byId(id).capabilities.structuredOutput)).toBe(
            true,
        );
        expect(run({ minContext: 1_048_576 }).every((id) => (byId(id).contextLength ?? 0) >= 1_048_576)).toBe(true);
        expect(run({ maxPromptPrice: 0.1 }).every((id) => byId(id).pricing.prompt <= 0.1)).toBe(true);
        expect(run({ openWeightsOnly: true }).every((id) => byId(id).openWeights)).toBe(true);
        expect(run({ text: 'zzzz-no-such-model' })).toEqual([]);
    });

    it('sorts and reverses', () => {
        const run = (patch: Partial<FilterState>) =>
            ids(buildList(SAMPLE_MODELS, { ...defaultFilters(), ...patch }, 999, t).sections.flatMap((s) => s.rows));
        const cheapest = run({ sort: 'price' })[0] ?? '';
        expect(byId(cheapest).pricing.prompt + byId(cheapest).pricing.completion).toBe(0);
        expect(run({ sort: 'price', reverse: true })[0]).toBe('sakana/fugu-ultra');
        expect(byId(run({ sort: 'subscription' })[0] ?? '').subscription.included).toBe(true);
        expect(run({ sort: 'name' }).reverse()).toEqual(run({ sort: 'name', reverse: true }));
    });

    it('groups by vendor, headings carry the size of the whole group, not only the drawn part', () => {
        const state = { ...defaultFilters(), groupByVendor: true };
        const full = buildList(SAMPLE_MODELS, state, 999, t);
        expect(full.sections.map((s) => s.vendor)).toContain('z-ai');
        const zai = full.sections.find((s) => s.vendor === 'z-ai');
        expect(zai?.count).toBe(zai?.rows.length);
        expect(zai?.vendorLabel).toBe('z-ai');
        expect(full.sections.find((s) => s.vendor === 'other')?.vendorLabel).toBe('other');
        const cut = buildList(SAMPLE_MODELS, state, 2, t);
        const drawn = cut.sections.reduce((sum, s) => sum + s.rows.length, 0);
        expect(drawn).toBe(2);
        for (const section of cut.sections) {
            expect(section.count).toBe(full.sections.find((s) => s.vendor === section.vendor)?.count);
        }
    });

    it('chips: every shelf with its size in the whole catalog, whatever the filter, and which are on', () => {
        const state = toggleCategory({ ...defaultFilters(), text: 'glm' }, 'Uncensored');
        const chips = categoryChips(SAMPLE_MODELS, state, t);
        expect(chips.reduce((sum, chip) => sum + chip.count, 0)).toBe(SAMPLE_MODELS.length);
        expect(chips.find((chip) => chip.key === 'Uncensored')).toMatchObject({ label: 'Uncensored', active: true });
        expect(chips.find((chip) => chip.key === 'More')?.active).toBe(false);
        expect(chips.find((chip) => chip.key === '')).toMatchObject({ label: 'No shelf' });
        expect(chips.map((c) => c.label)).toEqual(expect.arrayContaining(['Uncensored', 'Private / TEE', 'More']));
        expect(buildList(SAMPLE_MODELS, state, 999, t).chips).toEqual(chips);
    });
});

describe('the status line', () => {
    const base = { loaded: true, fetchedAt: 0, source: 'live' as const, error: null, via: 'plugin' as const };

    it('says it is loading, or why it failed', () => {
        expect(statusView({ loaded: false, fetchedAt: null, source: null, error: null }, 0, 0, t)).toEqual({
            kind: 'muted',
            text: 'Loading the catalog…',
            notice: null,
        });
        expect(statusView({ loaded: false, fetchedAt: null, source: null, error: 'timeout' }, 0, 0, t)).toEqual({
            kind: 'error',
            text: 'The catalog could not be loaded.',
            notice: 'the answer took too long',
        });
    });

    it('reports the count, where the data came from and how old it is', () => {
        expect(statusView(base, 612, 5 * 60_000, t)).toEqual({
            kind: 'ok',
            text: '612 models · via the plugin · updated 5 min ago',
            notice: null,
        });
        expect(statusView({ ...base, via: 'direct' }, 3, 0, t).text).toBe(
            '3 models · straight from NanoGPT · updated just now',
        );
        expect(statusView({ ...base, via: 'storage', source: 'cache' }, 3, 0, t).text).toContain(
            'stored in this browser',
        );
        expect(statusView({ ...base, via: null }, 3, 0, t).text).toBe('3 models · updated just now');
    });

    it('warns with the cached-data notice when the data is stale', () => {
        const stale = statusView({ ...base, source: 'stale' }, 3, 0, t);
        expect(stale.kind).toBe('warn');
        expect(stale.notice).toContain('stored data');
        const failed = statusView({ ...base, source: 'stale', error: 'http_503' }, 3, 0, t);
        expect(failed.notice).toContain('HTTP 503');
    });

    it('turns error codes into words', () => {
        expect(errorText('unreachable', t)).toBe('no answer from the network');
        expect(errorText('http_502', t)).toBe('HTTP 502');
        expect(errorText('weird', t)).toBe('error weird');
    });
});

describe('one model', () => {
    it('describes it', () => {
        const view = detailOf(byId(GLM), t);
        expect(view).toMatchObject({
            id: GLM,
            name: 'GLM 5.3',
            category: 'More',
            context: '1M',
            maxOutput: '128K',
            prices: { prompt: '0.6', completion: '1.1', cacheRead: '0.2' },
            openWeights: true,
            alwaysReasons: true,
        });
        expect(view.capabilities.map((cap) => [cap.key, cap.on])).toEqual([
            ['vision', false],
            ['reasoning', true],
            ['tools', true],
            ['structured', true],
        ]);
        expect(view.efforts.length).toBeGreaterThan(0);
        expect(view.subscription?.label).toBe('In subscription');
    });

    it('a model that can drop reasoning does not "always reason"; one with no efforts has no choice', () => {
        expect(detailOf(byId(DEEPSEEK), t).alwaysReasons).toBe(false);
        expect(detailOf(byId('fastgpt'), t)).toMatchObject({
            efforts: [],
            alwaysReasons: false,
            maxOutput: '32K',
            context: '?',
        });
        expect(detailOf(byId('fastgpt'), t).prices.cacheRead).toBeNull();
    });

    it('lists every capability the row can show', () => {
        expect(CAPABILITIES.map((cap) => cap.key)).toEqual(['vision', 'reasoning', 'tools', 'structured']);
    });
});

describe('the cost of a turn', () => {
    it('uses 20000 / 1500 / 80% by default', () => {
        expect(DEFAULT_COST_INPUTS).toEqual({ promptTokens: 20000, completionTokens: 1500, cachedPercent: 80 });
    });

    it('prices a turn with the cached share at the cache price', () => {
        // GLM 5.3: 0.6 in, 1.1 out, 0.2 cached. 4000 fresh + 16000 cached + 1500 out.
        const cost = costView(byId(GLM), DEFAULT_COST_INPUTS, t);
        expect(cost.turn).toBe(formatUsd((4000 * 0.6 + 16000 * 0.2 + 1500 * 1.1) / 1e6));
        expect(cost.withoutCache).toBe(formatUsd((20000 * 0.6 + 1500 * 1.1) / 1e6));
        expect(cost.hundredTurns).toBe(formatUsd(((4000 * 0.6 + 16000 * 0.2 + 1500 * 1.1) / 1e6) * 100));
        expect(cost.noCachePrice).toBe(false);
        expect(cost.subscriptionNote).toContain('costs nothing extra');
    });

    it('has nothing to say about the cache for a model without a cache price, and no subscription note outside it', () => {
        const cost = costView(byId(EMBER), { promptTokens: 1_000_000, completionTokens: 0, cachedPercent: 50 }, t);
        expect(cost.noCachePrice).toBe(byId(EMBER).pricing.cacheRead === null);
        expect(cost.subscriptionNote).toBeNull();
        const plain = costView(byId(GLM), { promptTokens: 1000, completionTokens: 1000, cachedPercent: 0 }, t);
        expect(plain.withoutCache).toBeNull();
        expect(costView(byId('deepseek/deepseek-v4-pro-0813'), DEFAULT_COST_INPUTS, t).subscriptionNote).toContain(
            '×2',
        );
    });

    it('reads the three fields, keeping defaults for empty or wrong ones and clamping the share', () => {
        expect(parseCostInputs('1000', '200', '30')).toEqual({
            promptTokens: 1000,
            completionTokens: 200,
            cachedPercent: 30,
        });
        expect(parseCostInputs('', 'x', '')).toEqual(DEFAULT_COST_INPUTS);
        expect(parseCostInputs('1', '1', '250').cachedPercent).toBe(100);
        expect(parseCostInputs('1', '1', '-5').cachedPercent).toBe(80);
        expect(parseCostInputs('1', '1', '0').cachedPercent).toBe(0);
    });
});

describe('hosts', () => {
    const glm = sampleProviders(GLM);

    it('ranks every host and shows what each reports', () => {
        const rows = hostRows(glm, defaultHostCriteria());
        expect(rows).toHaveLength(glm.providers.length);
        expect(rows.map((row) => row.rank)).toEqual(rows.map((_, i) => i + 1));
        const zai = rows.find((row) => row.id === 'zai');
        expect(zai?.quantization).toBe('fp8');
        expect(rows.find((row) => row.id === 'runinfra')?.quantization).toBe('fp4 (nvfp4)');
        expect(rows.find((row) => row.id === 'nube')?.quantization).toBe('?');
        expect(rows.find((row) => row.id === 'venice')?.quantization).toBe('unknown');
        expect(zai?.price).toMatch(/^\d[\d.]* \/ \d[\d.]*$/);
        expect(rows.every((row) => Number(row.score) >= 0 && Number(row.score) <= 100)).toBe(true);
    });

    it('ranks by the weights of the chosen priority', () => {
        for (const [priority, weights] of [
            ['price', { weightPrice: 3, weightSpeed: 1, weightUptime: 1 }],
            ['speed', { weightPrice: 1, weightSpeed: 3, weightUptime: 1 }],
            ['uptime', { weightPrice: 1, weightSpeed: 1, weightUptime: 3 }],
        ] as const) {
            const rows = hostRows(glm, { ...defaultHostCriteria(), priority });
            expect(rows.map((row) => row.id)).toEqual(
                scoreHosts(glm.providers, weights).map((score) => score.providerId),
            );
        }
        const price = hostRows(glm, { ...defaultHostCriteria(), priority: 'price' }).map((row) => row.id);
        const uptime = hostRows(glm, { ...defaultHostCriteria(), priority: 'uptime' }).map((row) => row.id);
        expect(price).not.toEqual(uptime);
    });

    it('moves hosts below the preferred precision and over the price cap to the end and flags them', () => {
        const rows = hostRows(glm, { ...defaultHostCriteria(), preferQuantization: 'fp8', maxPrompt: 0.7 });
        const flagged = rows.filter((row) => row.belowQuantization || row.overMaxPrice);
        expect(flagged.length).toBeGreaterThan(0);
        const firstFlagged = rows.findIndex((row) => row.belowQuantization || row.overMaxPrice);
        expect(
            rows
                .slice(firstFlagged)
                .every((row) => row.belowQuantization || row.overMaxPrice || row.unknownQuantization),
        ).toBe(true);
        expect(rows.find((row) => row.id === 'zai')).toMatchObject({ belowQuantization: false });
        expect(rows.find((row) => row.id === 'nebius')).toMatchObject({ belowQuantization: true });
        expect(rows.find((row) => row.id === 'venice')).toMatchObject({ unknownQuantization: true });
        const noPreference = hostRows(glm, defaultHostCriteria());
        expect(noPreference.some((row) => row.belowQuantization || row.unknownQuantization)).toBe(false);
    });

    it('turns the criteria state into HostCriteria', () => {
        expect(criteriaOf(defaultHostCriteria())).toEqual({ weightPrice: 1, weightSpeed: 1, weightUptime: 1 });
        expect(criteriaOf({ priority: 'speed', preferQuantization: 'fp8', maxPrompt: 1, maxCompletion: null })).toEqual(
            {
                weightPrice: 1,
                weightSpeed: 3,
                weightUptime: 1,
                preferQuantization: 'fp8',
                maxPrice: { prompt: 1, completion: null },
            },
        );
    });

    it('summarises the model-level facts', () => {
        expect(hostsSummary(glm)).toEqual({ selection: true, autoTps: '198.2', autoTtft: '1289', autoCache: '76%' });
        expect(hostsSummary(sampleProviders(GLM_FIXED_ROUTE)).selection).toBe(false);
        expect(hostRows(sampleProviders(GLM_FIXED_ROUTE), defaultHostCriteria())).toEqual([]);
    });
});

describe('hints', () => {
    it('has an English and a Russian text for every code, and for the variants the view picks', () => {
        const keys = [
            ...HINT_CODES.map((code) => `catalog.hint.${code}`),
            'catalog.hint.quant.glmFp8.unknown',
            'catalog.hint.quant.glmFp8.noneOk',
            'catalog.hint.shelf.uncensoredUnmeasured.byId',
        ];
        for (const key of keys) {
            expect(CATALOG_STRINGS.en[key], `en ${key}`).toBeTruthy();
            expect(CATALOG_STRINGS.ru[key], `ru ${key}`).toBeTruthy();
        }
    });

    it('picks the text for the reading of the rule', () => {
        const hint = (code: string, params: RoutingHint['params']): RoutingHint => ({ code, severity: 'warn', params });
        expect(hintKey(hint('quant.glmFp8', { hostsKnown: true, okHosts: 3 }))).toBe('catalog.hint.quant.glmFp8');
        expect(hintKey(hint('quant.glmFp8', { hostsKnown: false }))).toBe('catalog.hint.quant.glmFp8.unknown');
        expect(hintKey(hint('quant.glmFp8', { hostsKnown: true, okHosts: 0 }))).toBe(
            'catalog.hint.quant.glmFp8.noneOk',
        );
        expect(hintKey(hint('shelf.uncensoredUnmeasured', { byShelf: true }))).toBe(
            'catalog.hint.shelf.uncensoredUnmeasured',
        );
        expect(hintKey(hint('shelf.uncensoredUnmeasured', { byShelf: false }))).toBe(
            'catalog.hint.shelf.uncensoredUnmeasured.byId',
        );
        expect(hintKey(hint('hosts.few', { hosts: 2 }))).toBe('catalog.hint.hosts.few');
    });

    it('renders every code the domain can produce with no placeholder left over', () => {
        const hosts = sampleProviders(GLM);
        const all: RoutingHint[] = [
            ...routingHints(byId(GLM), null),
            ...routingHints(byId(GLM), hosts),
            ...routingHints(byId(GLM_FIXED_ROUTE), sampleProviders(GLM_FIXED_ROUTE)),
            ...routingHints(byId(EMBER), sampleProviders(EMBER)),
            ...routingHints(byId('GLM-4.6-Derestricted-v5'), null),
            ...routingHints(byId(DEEPSEEK), sampleProviders(DEEPSEEK)),
            ...routingHints(byId('z-ai/glm-5.3-uncensored'), null),
            {
                code: 'cache.lowRate',
                severity: 'info',
                params: { percent: 40, threshold: 60 },
            },
            {
                code: 'quant.glmFp8',
                severity: 'warn',
                params: { model: 'x/glm', hostsKnown: true, lowHosts: 2, low: 'a, b', okHosts: 0 },
            },
        ];
        const seen = new Set(all.map((hint) => hint.code));
        for (const view of hintViews(all, t)) {
            expect(view.text, view.code).not.toMatch(/\{\w+\}/);
            expect(view.text.length).toBeGreaterThan(20);
        }
        // The sample catalog exercises most rules; the rest are covered by the synthetic hints above.
        expect(seen.has('quant.glmFp8')).toBe(true);
        expect(seen.has('reasoning.alwaysOn')).toBe(true);
        expect(seen.has('shelf.uncensoredUnmeasured')).toBe(true);
        expect(seen.has('billing.bypass')).toBe(true);
    });

    it('marks suggestions, describes them in words and styles the billing note apart', () => {
        const views = hintViews(routingHints(byId(GLM), sampleProviders(GLM)), t);
        const glm = views.find((view) => view.code === 'quant.glmFp8');
        expect(glm).toMatchObject({
            severity: 'warn',
            suggestion: true,
            suggestionText: 'precision floor fp8',
            bypass: false,
        });
        expect(glm?.text).toContain('below fp8');
        const bypass = views.find((view) => view.code === 'billing.bypass');
        expect(bypass).toMatchObject({ bypass: true, suggestion: false, severity: 'info' });
        expect(bypass?.text).toContain('5%');
        expect(views.map((v) => v.severity)).toEqual(
            [...views.map((v) => v.severity)].sort((a) => (a === 'warn' ? -1 : 1)),
        );
    });

    it('params keep numbers and turn booleans into text', () => {
        expect(hintParams({ a: 1, b: 'x', c: true, d: false })).toEqual({ a: 1, b: 'x', c: 'true', d: 'false' });
    });

    it('suggestions in words', () => {
        expect(suggestionText({ enabled: true, minQuantization: 'fp8' }, t)).toBe('precision floor fp8');
        expect(suggestionText({ enabled: true, ignore: ['a', 'b'] }, t)).toBe('ignore hosts a, b');
        expect(suggestionText({ enabled: true, only: ['a'], order: ['b', 'c'] }, t)).toBe(
            'only hosts a; try hosts in order b, c',
        );
        expect(suggestionText({ enabled: true, quantizations: ['fp8', 'bf16'] }, t)).toBe('only precisions fp8, bf16');
        expect(suggestionText({ enabled: true, sort: 'price' }, t)).toBe('sort: "price"');
        expect(suggestionText({ enabled: true }, t)).toBe('turn provider routing on');
    });
});

describe('a connection from a model', () => {
    const hints = routingHints(byId(GLM), sampleProviders(GLM));
    const glm = hints.find((hint) => hint.code === 'quant.glmFp8') as RoutingHint;

    it('merges routing patches: lists united, anything else the last one wins', () => {
        expect(mergeRoutingPatches([])).toEqual({});
        expect(
            mergeRoutingPatches([
                { enabled: true, ignore: ['a'], minQuantization: 'fp8' },
                { enabled: true, ignore: ['b', 'a'], minQuantization: 'fp16' },
            ]),
        ).toEqual({ enabled: true, ignore: ['a', 'b'], minQuantization: 'fp16' });
    });

    it('without ticked hints it is the model and a name, nothing else (the defaults are createConnection’s)', () => {
        expect(newConnectionPatch(byId(GLM), hints, new Set())).toEqual({ name: 'GLM 5.3', modelId: GLM });
        expect(newConnectionPatch(byId(GLM), hints, new Set(['hosts.few']))).toEqual({ name: 'GLM 5.3', modelId: GLM });
    });

    it('with a ticked hint it carries a whole routing object with that suggestion', () => {
        const patch = newConnectionPatch(byId(GLM), hints, new Set(['quant.glmFp8']));
        expect(patch.routing).toMatchObject({
            enabled: true,
            minQuantization: 'fp8',
            order: [],
            only: [],
            ignore: [],
            sort: 'default',
            allowFallbacks: true,
        });
        expect(glm.suggestedRouting).toMatchObject({ minQuantization: 'fp8' });
    });

    it('unites the suggestions of several ticked hints', () => {
        const synthetic: RoutingHint[] = [
            { code: 'a', severity: 'warn', params: {}, suggestedRouting: { enabled: true, ignore: ['x'] } },
            {
                code: 'b',
                severity: 'warn',
                params: {},
                suggestedRouting: { enabled: true, ignore: ['y'], minQuantization: 'fp8' },
            },
            { code: 'c', severity: 'info', params: {} },
        ];
        const patch = newConnectionPatch(byId(GLM), synthetic, new Set(['a', 'b', 'c']));
        expect(patch.routing).toMatchObject({ ignore: ['x', 'y'], minQuantization: 'fp8', enabled: true });
    });

    it('cuts a long name to 80 characters and falls back to the id when the name is blank', () => {
        const long = { ...byId(GLM), name: 'N'.repeat(120) };
        expect(newConnectionPatch(long, [], new Set()).name).toHaveLength(80);
        expect(newConnectionPatch({ ...byId(GLM), name: '   ' }, [], new Set()).name).toBe(GLM);
    });
});
