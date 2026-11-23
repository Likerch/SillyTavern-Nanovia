// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { CatalogStore } from '../../src/core/catalog';
import { estimateTurnCost } from '../../src/domain/catalog';
import { catalogFeature, scheduleIdle } from '../../src/features/catalog';
import { createSession } from '../../src/features/catalog/session';
import type { CatalogSession } from '../../src/features/catalog/session';
import { CATALOG_STRINGS } from '../../src/features/catalog/strings';
import { renderCatalogTab } from '../../src/features/catalog/view';
import { PAGE_SIZE, formatUsd } from '../../src/features/catalog/view-model';
import type { CatalogModel } from '../../src/shared/contracts';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { createCatalogRig, GLM, SAMPLE_MODELS, SAMPLE_MODEL_COUNT } from '../helpers/catalog-fakes';
import type { CatalogRig } from '../helpers/catalog-fakes';
import { seedConnection } from '../helpers/fake-backend';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

let h: Harness;
let tc: TestContext;
let rig: CatalogRig;
let root: HTMLElement;
let session: CatalogSession;
let dispose: (() => void) | undefined;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    rig = createCatalogRig();
    // The catalog store runs over its own fakes; connections go through the harness's fake plugin.
    Object.assign(tc.ctx, { catalog: rig.store });
    tc.ctx.i18n.register(CATALOG_STRINGS);
    root = document.createElement('div');
    document.body.appendChild(root);
    session = createSession();
});

afterEach(() => {
    dispose?.();
    dispose = undefined;
    root.remove();
    h.restore();
});

async function settle(): Promise<void> {
    await flush();
    await flush();
}

/** Opens the tab with the catalog already loaded. */
async function open(): Promise<void> {
    await rig.store.refresh();
    await h.connections.refresh();
    dispose = renderCatalogTab(root, tc.ctx, session);
}

const text = (): string => root.textContent ?? '';
const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.nanovia-model-row')];
const rowIds = (): string[] => rows().map((row) => row.dataset['model'] ?? '');
const rowNamed = (id: string): HTMLElement => {
    const found = root.querySelector<HTMLElement>(`.nanovia-model-row[data-model="${id}"]`);
    if (!found) throw new Error(`no row for ${id}; rows: ${rowIds().join(', ')}`);
    return found;
};

function button(label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!found) {
        throw new Error(
            `no button "${label}"; buttons: ${[...root.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`,
        );
    }
    return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
    button(label).click();
    await settle();
}

function field(label: string): HTMLInputElement | HTMLSelectElement {
    const found = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
    if (!found) throw new Error(`no field "${label}"`);
    return found;
}

function type(label: string, value: string): void {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function choose(label: string, value: string): void {
    const select = field(label);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function tick(label: string, on = true): void {
    const input = [...root.querySelectorAll<HTMLLabelElement>('label.checkbox_label')]
        .find((node) => node.textContent?.trim().startsWith(label))
        ?.querySelector('input');
    if (!input) throw new Error(`no toggle "${label}"`);
    input.checked = on;
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

const chipFor = (key: string): HTMLElement => {
    const found = root.querySelector<HTMLElement>(`.nanovia-category-chips [data-category="${key}"]`);
    if (!found) throw new Error(`no chip ${key}`);
    return found;
};

describe('states', () => {
    it('says it is loading while nothing is there yet, and draws the list once it arrives', async () => {
        dispose = renderCatalogTab(root, tc.ctx, session);
        expect(text()).toContain('Loading the catalog…');
        expect(rows()).toHaveLength(0);
        await settle();
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(text()).toContain(`${SAMPLE_MODEL_COUNT} models · via the plugin · updated just now`);
        expect(text()).toContain(`Showing ${SAMPLE_MODEL_COUNT} of ${SAMPLE_MODEL_COUNT} models`);
    });

    it('opening the tab asks the store to load, and a refresh button forces it', async () => {
        await open();
        expect(rig.plugin.calls).toEqual(['GET /catalog']);
        await click('Refresh');
        expect(rig.plugin.calls).toEqual(['GET /catalog', 'GET /catalog?refresh=1']);
    });

    it('shows the failure and a retry button when nothing could be loaded, then recovers', async () => {
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        dispose = renderCatalogTab(root, tc.ctx, session);
        await settle();
        expect(text()).toContain('The catalog could not be loaded.');
        expect(text()).toContain('no answer from the network');
        expect(root.querySelector('.nanovia-banner-down')).not.toBeNull();
        expect(rows()).toHaveLength(0);
        rig.nano.mode = 'ok';
        await click('Try again');
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(root.querySelector('.nanovia-banner-up')).not.toBeNull();
        expect(text()).toContain('straight from NanoGPT');
    });

    it('keeps the list and warns with the stored-data notice when a refresh fails', async () => {
        await open();
        rig.plugin.up = false;
        rig.nano.mode = 'down';
        await click('Refresh');
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect(root.querySelector('.nanovia-banner-warn')).not.toBeNull();
        expect(text()).toContain('Showing stored data');
        expect(text()).toContain('no answer from the network');
    });

    it('speaks Russian', async () => {
        tc.setLocale('ru');
        await open();
        expect(text()).toContain('через плагин');
        expect(button('Обновить')).toBeTruthy();
        expect(rowNamed(GLM).textContent).toContain('В подписке');
        expect(text()).toContain('Без цензуры');
    });
});

describe('rows', () => {
    it('show name, id, price, context, capabilities and the subscription badge', async () => {
        await open();
        const glm = rowNamed(GLM);
        expect(glm.querySelector('.nanovia-model-name')?.textContent).toBe('GLM 5.3');
        expect(glm.querySelector('.nanovia-model-id')?.textContent).toBe(GLM);
        expect(glm.querySelector('.nanovia-model-price')?.textContent).toBe('0.6 / 1.1');
        expect(glm.querySelector('.nanovia-model-context')?.textContent).toBe('1M');
        expect([...glm.querySelectorAll<HTMLElement>('.nanovia-cap')].map((cap) => cap.dataset['cap'])).toEqual([
            'reasoning',
            'tools',
            'structured',
            'openWeights',
        ]);
        expect(glm.querySelector('.nanovia-cap')?.getAttribute('aria-label')).toBe('Reasoning');
        expect(glm.querySelector('.nanovia-chip-ok')?.textContent).toBe('In subscription');
        expect(rowNamed('deepseek/deepseek-v4-pro-0813').textContent).toContain('In subscription ×2');
        expect(rowNamed('fireworks/ember-1').querySelector('.nanovia-chip-ok')).toBeNull();
    });
});

describe('filters', () => {
    it('search narrows the list as you type and says when nothing matches', async () => {
        await open();
        type('Search models', 'glm 5.3');
        expect(rowIds()).toContain(GLM);
        expect(rowIds()).not.toContain('fireworks/ember-1');
        expect(text()).toContain(`of ${rows().length} models (${SAMPLE_MODEL_COUNT} in the catalog)`);
        type('Search models', 'zzz-nothing');
        expect(rows()).toHaveLength(0);
        expect(text()).toContain('No model matches the filters.');
        type('Search models', '');
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
    });

    it('shelf chips carry their sizes and toggle', async () => {
        await open();
        const chips = [...root.querySelectorAll('.nanovia-category-chips .nanovia-chip')].map(
            (chip) => chip.textContent,
        );
        expect(chips).toContain('Uncensored (4)');
        expect(chips).toContain('Private / TEE (2)');
        expect(chips.join()).toContain('More');
        expect(chips.join()).toContain('No shelf');
        chipFor('Private/TEE').click();
        expect(rowIds().sort()).toEqual(['TEE/glm-5.2', 'TEE/glm-5.3']);
        expect(chipFor('Private/TEE').getAttribute('aria-pressed')).toBe('true');
        chipFor('Uncensored').click();
        expect(rows()).toHaveLength(6);
        chipFor('Private/TEE').click();
        chipFor('Uncensored').click();
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
    });

    it('subscription, capability, open-weights, context and price filters', async () => {
        await open();
        tick('Included in the subscription');
        expect(rows().length).toBeGreaterThan(0);
        expect(rowIds().every((id) => SAMPLE_MODELS.find((m) => m.id === id)?.subscription.included)).toBe(true);
        tick('Included in the subscription', false);

        tick('Images in');
        expect(rowIds().every((id) => SAMPLE_MODELS.find((m) => m.id === id)?.capabilities.vision)).toBe(true);
        tick('Images in', false);

        tick('Open weights only');
        expect(rowIds().every((id) => SAMPLE_MODELS.find((m) => m.id === id)?.openWeights)).toBe(true);
        tick('Open weights only', false);

        choose('Context at least', '1048576');
        expect(rowIds().every((id) => (SAMPLE_MODELS.find((m) => m.id === id)?.contextLength ?? 0) >= 1_048_576)).toBe(
            true,
        );
        choose('Context at least', '0');
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);

        type('Max prompt price, USD per 1M', '0.1');
        expect(rows().length).toBeGreaterThan(0);
        expect(rowIds().every((id) => (SAMPLE_MODELS.find((m) => m.id === id)?.pricing.prompt ?? 99) <= 0.1)).toBe(
            true,
        );
    });

    it('sorts, reverses and groups by vendor', async () => {
        await open();
        choose('Sort by', 'price');
        const cheapest = SAMPLE_MODELS.find((m) => m.id === rowIds()[0]);
        expect((cheapest?.pricing.prompt ?? 1) + (cheapest?.pricing.completion ?? 1)).toBe(0);
        tick('Reverse order');
        expect(rowIds()[0]).toBe('sakana/fugu-ultra');

        tick('Group by vendor');
        const heads = [...root.querySelectorAll<HTMLElement>('.nanovia-vendor-head')].map((head) => head.textContent);
        expect(heads).toContain('z-ai (5)');
        expect(heads.join()).toContain('other');
        tick('Group by vendor', false);
        expect(root.querySelector('.nanovia-vendor-head')).toBeNull();
    });

    it('a reset button shows when a filter is set and clears the filters but keeps the sort', async () => {
        await open();
        const reset = button('Reset filters');
        expect(reset.hidden).toBe(true);
        choose('Sort by', 'price');
        type('Search models', 'glm');
        expect(reset.hidden).toBe(false);
        expect(rows().length).toBeLessThan(SAMPLE_MODEL_COUNT);
        await click('Reset filters');
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
        expect((field('Search models') as HTMLInputElement).value).toBe('');
        expect((field('Sort by') as HTMLSelectElement).value).toBe('price');
        expect(button('Reset filters').hidden).toBe(true);
    });

    it('keeps the filters when the tab is drawn again (the panel redraws it on every visit)', async () => {
        await open();
        type('Search models', 'ember');
        choose('Sort by', 'context');
        dispose?.();
        clearRoot();
        dispose = renderCatalogTab(root, tc.ctx, session);
        expect((field('Search models') as HTMLInputElement).value).toBe('ember');
        expect((field('Sort by') as HTMLSelectElement).value).toBe('context');
        expect(rowIds()).toEqual(['fireworks/ember-1']);
    });
});

function clearRoot(): void {
    while (root.firstChild) root.removeChild(root.firstChild);
}

describe('paging', () => {
    function many(count: number): CatalogModel[] {
        return Array.from({ length: count }, (_, i) => ({
            ...(SAMPLE_MODELS[0] as CatalogModel),
            id: `vendor/model-${String(i).padStart(3, '0')}`,
            name: `Model ${String(i).padStart(3, '0')}`,
        }));
    }

    it('draws 50 at a time and "show more" adds the next page; a filter starts over', async () => {
        await rig.store.refresh();
        const models = many(130);
        // A store over a long list: the tab only reads the snapshot.
        const long = { ...rig.store, models: () => models };
        Object.assign(tc.ctx, { catalog: long });
        dispose = renderCatalogTab(root, tc.ctx, session);
        expect(rows()).toHaveLength(PAGE_SIZE);
        expect(text()).toContain('Showing 50 of 130 models');
        await click('Show 50 more');
        expect(rows()).toHaveLength(100);
        await click('Show 30 more');
        expect(rows()).toHaveLength(130);
        expect(() => button('Show 50 more')).toThrow();
        type('Search models', 'model-00');
        expect(rows()).toHaveLength(10);
        type('Search models', '');
        expect(rows()).toHaveLength(PAGE_SIZE);
    });
});

describe('the detail of a model', () => {
    async function openGlm(): Promise<void> {
        await open();
        rowNamed(GLM).click();
        await settle();
    }

    it('replaces the list, describes the model and goes back', async () => {
        await openGlm();
        expect(root.querySelector('.nanovia-catalog-list-pane')?.hasAttribute('hidden')).toBe(true);
        expect(root.querySelector('.nanovia-catalog-detail-pane')?.hasAttribute('hidden')).toBe(false);
        const detail = root.querySelector('.nanovia-catalog-detail-pane')?.textContent ?? '';
        expect(root.querySelector('.nanovia-detail-name')?.textContent).toBe('GLM 5.3');
        expect(detail).toContain(GLM);
        expect(detail).toContain('long-horizon autonomous coding');
        expect(detail).toContain('Prompt0.6');
        expect(detail).toContain('Completion1.1');
        expect(detail).toContain('Cached prompt0.2');
        expect(detail).toContain('Context window1M');
        expect(detail).toContain('In subscription');
        expect(detail).toContain('This model always reasons');
        expect(session.selected).toBe(GLM);
        const caps = [...root.querySelectorAll<HTMLElement>('.nanovia-cap-line')].map(
            (cap) => `${cap.dataset['cap']}:${cap.dataset['on']}`,
        );
        expect(caps).toEqual(['vision:no', 'reasoning:yes', 'tools:yes', 'structured:yes']);

        await click('Back to the list');
        expect(root.querySelector('.nanovia-catalog-list-pane')?.hasAttribute('hidden')).toBe(false);
        expect(root.querySelector('.nanovia-catalog-detail-pane')?.hasAttribute('hidden')).toBe(true);
        expect(session.selected).toBeNull();
        expect(rows()).toHaveLength(SAMPLE_MODEL_COUNT);
    });

    it('comes back on the same model when the tab is drawn again', async () => {
        await openGlm();
        dispose?.();
        clearRoot();
        dispose = renderCatalogTab(root, tc.ctx, session);
        expect(root.querySelector('.nanovia-detail-name')?.textContent).toBe('GLM 5.3');
    });

    it('estimates a turn with 20000 / 1500 / 80% and follows the numbers typed', async () => {
        await openGlm();
        const result = (): string => root.querySelector('.nanovia-cost-result')?.textContent ?? '';
        expect((field('Prompt tokens') as HTMLInputElement).value).toBe('20000');
        expect((field('Reply tokens') as HTMLInputElement).value).toBe('1500');
        expect((field('Prompt read from cache, %') as HTMLInputElement).value).toBe('80');
        const glm = SAMPLE_MODELS.find((m) => m.id === GLM) as CatalogModel;
        const turn = estimateTurnCost(glm, { promptTokens: 20000, completionTokens: 1500, cachedShare: 0.8 });
        const plain = estimateTurnCost(glm, { promptTokens: 20000, completionTokens: 1500, cachedShare: 0 });
        expect(turn).toBeCloseTo(0.00725, 9);
        expect(result()).toContain('One turn' + formatUsd(turn));
        expect(result()).toContain('without cache ' + formatUsd(plain));
        expect(result()).toContain('100 turns' + formatUsd(turn * 100));
        expect(result()).toContain('costs nothing extra');
        type('Prompt read from cache, %', '0');
        expect(result()).toContain('One turn' + formatUsd(plain));
        expect(result()).not.toContain('without cache');
        type('Prompt tokens', '1000000');
        type('Reply tokens', '0');
        expect(result()).toContain('One turn$0.60');
        expect(session.cost).toEqual({ promptTokens: 1_000_000, completionTokens: 0, cachedPercent: 0 });
    });

    it('loads the hosts through the store and ranks them', async () => {
        await openGlm();
        expect(rig.plugin.calls.at(-1)).toBe(`GET /catalog/providers?id=${encodeURIComponent(GLM)}`);
        const table = root.querySelector('.nanovia-hosts');
        expect(table).not.toBeNull();
        const body = [...root.querySelectorAll<HTMLElement>('.nanovia-hosts tbody tr')];
        expect(body.length).toBeGreaterThan(10);
        expect(body.map((row) => row.dataset['rank'])).toEqual(body.map((_, i) => String(i + 1)));
        const zai = root.querySelector('.nanovia-hosts tr[data-host="zai"]');
        expect(zai?.textContent).toContain('fp8');
        expect(root.querySelector('.nanovia-hosts tr[data-host="runinfra"]')?.textContent).toContain('fp4 (nvfp4)');
        expect(text()).toContain(
            'Automatic routing: 198.2 tokens/s, first token after 1289 ms, 76% of the prompt from cache.',
        );
    });

    it('re-ranks the hosts with the criteria: preferred precision and price cap', async () => {
        await openGlm();
        const order = (): string[] =>
            [...root.querySelectorAll<HTMLElement>('.nanovia-hosts tbody tr')].map((row) => row.dataset['host'] ?? '');
        const before = order();
        choose('Prefer precision', 'fp8');
        const after = order();
        expect(after).not.toEqual(before);
        expect(root.querySelector('.nanovia-hosts tr[data-host="nebius"]')?.textContent).toContain(
            'below the preferred precision',
        );
        expect(after.indexOf('zai')).toBeLessThan(after.indexOf('nebius'));
        type('Hosts: max prompt price, USD per 1M', '0.01');
        expect(root.querySelectorAll('.nanovia-hosts tbody tr .nanovia-chip-warn').length).toBeGreaterThan(0);
        expect(session.hosts.preferQuantization).toBe('fp8');
        choose('Rank by', 'speed');
        expect(session.hosts.priority).toBe('speed');
    });

    it('says when the host list cannot be loaded and offers a retry', async () => {
        rig.plugin.up = false;
        rig.nano.mode = 'ok';
        await open();
        rig.nano.mode = 'down';
        rowNamed(GLM).click();
        await settle();
        expect(text()).toContain('The host list could not be loaded.');
        rig.nano.mode = 'ok';
        await click('Try again');
        expect(root.querySelector('.nanovia-hosts')).not.toBeNull();
    });

    it('explains a fixed-route model, which has no hosts to choose', async () => {
        await open();
        rowNamed('z-ai/glm-4.5v').click();
        await settle();
        expect(text()).toContain('fixed route');
        expect(root.querySelector('.nanovia-hosts')).toBeNull();
    });

    it('shows the routing hints with severity styling, the billing note, and suggestions as checkboxes', async () => {
        await openGlm();
        const warn = root.querySelector('.nanovia-hint-warn[data-hint="quant.glmFp8"]');
        expect(warn?.textContent).toContain('below fp8');
        expect(warn?.textContent).toContain('precision floor fp8');
        expect(warn?.querySelector('input[type="checkbox"]')).not.toBeNull();
        const info = root.querySelector('.nanovia-hint-info[data-hint="reasoning.alwaysOn"]');
        expect(info?.textContent).toContain('always reasons');
        expect(info?.querySelector('input')).toBeNull();
        const bypass = root.querySelector('.nanovia-hint-bypass[data-hint="billing.bypass"]');
        expect(bypass?.textContent).toContain('takes a subscription model off the subscription');
        // Warnings come before infos.
        const codes = [...root.querySelectorAll<HTMLElement>('.nanovia-hint')].map((node) => node.dataset['hint']);
        expect(codes.indexOf('quant.glmFp8')).toBeLessThan(codes.indexOf('reasoning.alwaysOn'));
    });

    it('says when there is nothing special to know', async () => {
        await open();
        rowNamed('fastgpt').click();
        await settle();
        expect(root.querySelector('.nanovia-hint')).toBeNull();
        expect(text()).toContain('Nothing special to know about this model.');
    });

    it('goes back to the list when the model leaves the catalog', async () => {
        const models = [...SAMPLE_MODELS];
        const listeners = new Set<() => void>();
        const live: CatalogStore = {
            ...createEmptyCatalogStore(),
            models: () => models,
            model: (id) => models.find((m) => m.id === id) ?? null,
            status: () => ({ loaded: true, fetchedAt: 1, source: 'live', error: null, via: 'plugin' }),
            onChange: (listener) => {
                listeners.add(listener);
                return () => void listeners.delete(listener);
            },
        };
        Object.assign(tc.ctx, { catalog: live });
        dispose = renderCatalogTab(root, tc.ctx, session);
        rowNamed(GLM).click();
        expect(root.querySelector('.nanovia-detail-name')).not.toBeNull();
        models.splice(
            models.findIndex((m) => m.id === GLM),
            1,
        );
        for (const listener of listeners) listener();
        expect(root.querySelector('.nanovia-catalog-detail-pane')?.hasAttribute('hidden')).toBe(true);
        expect(session.selected).toBeNull();
        expect(rowIds()).not.toContain(GLM);
    });
});

describe('turning a model into a connection', () => {
    async function openDetail(id = GLM): Promise<void> {
        await open();
        rowNamed(id).click();
        await settle();
    }

    it('creates one with the model and the defaults', async () => {
        await openDetail();
        await click('Create a connection with this model');
        expect(text()).toContain('Connection "GLM 5.3" created.');
        const created = [...h.backend.plugin.connections.values()];
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ name: 'GLM 5.3', modelId: GLM, mode: 'auto', billing: 'auto' });
        expect(created[0]?.routing.enabled).toBe(false);
        expect(h.connections.list()).toHaveLength(1);
    });

    it('applies the routing of the hints that are ticked', async () => {
        await openDetail();
        tick('Use this routing in the new connection: precision floor fp8');
        await click('Create a connection with this model');
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created?.routing).toMatchObject({ enabled: true, minQuantization: 'fp8' });
    });

    it('forgets the ticks of the previous model', async () => {
        await openDetail();
        tick('Use this routing in the new connection: precision floor fp8');
        await click('Back to the list');
        rowNamed(GLM).click();
        await settle();
        await click('Create a connection with this model');
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created?.routing.enabled).toBe(false);
    });

    it('says why it cannot when the plugin is down and there is no key for direct mode', async () => {
        await openDetail();
        h.backend.plugin.up = false;
        await click('Create a connection with this model');
        expect(root.querySelector('.nanovia-notice-error')?.textContent).toContain('key');
        expect(h.backend.plugin.connections.size).toBe(0);
    });

    it('offers to use the model in an existing connection and sets its model id', async () => {
        seedConnection(h.backend, { name: 'Daily', modelId: 'old/model' }, 'seed000001');
        seedConnection(h.backend, { name: 'Backup', modelId: 'other/model' }, 'seed000002');
        await openDetail();
        const select = field('Connection') as HTMLSelectElement;
        expect([...select.options].map((option) => option.textContent).sort()).toEqual([
            'Backup · other/model',
            'Daily · old/model',
        ]);
        choose('Connection', 'seed000002');
        await click('Use this model');
        expect(text()).toContain(`Connection "Backup" now uses GLM 5.3.`);
        expect(h.backend.plugin.connections.get('seed000002')?.modelId).toBe(GLM);
        expect(h.backend.plugin.connections.get('seed000001')?.modelId).toBe('old/model');
        // The list in the select follows the change.
        expect([...(field('Connection') as HTMLSelectElement).options].map((option) => option.textContent)).toContain(
            `Backup · ${GLM}`,
        );
    });

    it('with no connection yet it says to create one first', async () => {
        await openDetail();
        expect(text()).toContain('No connections yet: create one first.');
        expect(root.querySelector('[aria-label="Connection"]')).toBeNull();
    });
});

describe('the feature', () => {
    it('registers its strings and its tab, loads the catalog when the page is idle, and cleans up', async () => {
        const registered: { id: string; titleKey: string; order: number }[] = [];
        let removed = 0;
        const idle: { run: (() => void) | null; cancelled: number } = { run: null, cancelled: 0 };
        const host = globalThis as unknown as Record<string, unknown>;
        host['requestIdleCallback'] = (callback: () => void) => {
            idle.run = callback;
            return 7;
        };
        host['cancelIdleCallback'] = () => void idle.cancelled++;
        try {
            const ctx = {
                ...tc.ctx,
                catalog: rig.store,
                panel: {
                    registerTab: (tab: { id: string; titleKey: string; order: number }) => {
                        registered.push(tab);
                        return () => void removed++;
                    },
                },
            } as unknown as typeof tc.ctx;
            const stop = catalogFeature.init(ctx) as () => void;
            expect(registered).toEqual([
                expect.objectContaining({ id: 'catalog', titleKey: 'catalog.tab', order: 150 }),
            ]);
            expect(ctx.i18n.has('catalog.hint.hosts.few')).toBe(true);
            // Nothing is fetched at start.
            expect(rig.plugin.calls).toEqual([]);
            idle.run?.();
            await settle();
            expect(rig.plugin.calls).toEqual(['GET /catalog']);
            stop();
            expect(removed).toBe(1);
            expect(idle.cancelled).toBe(1);
        } finally {
            delete host['requestIdleCallback'];
            delete host['cancelIdleCallback'];
        }
    });

    it('falls back to a timer where requestIdleCallback does not exist', () => {
        vi.useFakeTimers();
        try {
            let ran = 0;
            const cancel = scheduleIdle(() => void ran++);
            vi.advanceTimersByTime(1500);
            expect(ran).toBe(1);
            const second = scheduleIdle(() => void ran++);
            second();
            vi.advanceTimersByTime(1500);
            expect(ran).toBe(1);
            cancel();
        } finally {
            vi.useRealTimers();
        }
    });

    it('has every English string in Russian and the other way round', () => {
        expect(Object.keys(CATALOG_STRINGS.en).sort()).toEqual(Object.keys(CATALOG_STRINGS.ru).sort());
        for (const [key, value] of Object.entries(CATALOG_STRINGS.ru)) {
            const placeholders = (text: string): string[] =>
                [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
            expect(placeholders(value), key).toEqual(placeholders(CATALOG_STRINGS.en[key] ?? ''));
        }
    });
});
