// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BILLING_STRINGS } from '../../src/core/billing-view';
import type { CatalogStore } from '../../src/core/catalog';
import { routingFeature } from '../../src/features/routing';
import { ROUTING_STRINGS } from '../../src/features/routing/strings';
import { renderRoutingTab } from '../../src/features/routing/view';
import type { ModelProviders } from '../../src/shared/contracts';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { seedConnection } from '../helpers/fake-backend';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { catalogOf, makeModel, makeProviders } from '../helpers/plan-fixtures';
import { POPUP_RESULT } from '../helpers/st-mock';

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(BILLING_STRINGS);
    tc.ctx.i18n.register(ROUTING_STRINGS);
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    dispose?.();
    dispose = undefined;
    root.remove();
    h.restore();
});

const MODEL = makeModel({ id: 'vendor/model', reasoningEfforts: ['none', 'low', 'high'] });

async function open(catalog: CatalogStore = catalogOf([MODEL], [makeProviders()])): Promise<void> {
    tc.ctx.catalog = catalog;
    await h.connections.refresh();
    dispose = renderRoutingTab(root, tc.ctx);
    await settle();
}

async function settle(): Promise<void> {
    await flush();
    await flush();
}

function seed(over: Record<string, unknown> = {}, id = 'seed000001'): void {
    seedConnection(h.backend, { name: 'Main', modelId: 'vendor/model', ...over } as never, id);
}

const text = (): string => root.textContent ?? '';

function field<T extends HTMLElement>(label: string): T {
    const found = root.querySelector<T>(`[aria-label="${label}"]`);
    if (!found) throw new Error(`no field "${label}"`);
    return found;
}

function type(label: string, value: string): void {
    const input = field<HTMLInputElement>(label);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function choose(label: string, value: string): void {
    const select = field<HTMLSelectElement>(label);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function checkbox(label: string): HTMLInputElement {
    const found = [...root.querySelectorAll<HTMLLabelElement>('label')].find(
        (node) => node.textContent?.trim() === label,
    );
    const input = found?.querySelector('input');
    if (!input) throw new Error(`no checkbox "${label}"`);
    return input;
}

function flip(label: string, checked: boolean): void {
    const input = checkbox(label);
    input.checked = checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
    button(label).click();
    await settle();
}

const section = (id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-section="${id}"]`)!;
const row = (name: string): HTMLElement => root.querySelector<HTMLElement>(`[data-field="${name}"]`)!;
const hidden = (selector: string): boolean => root.querySelector(selector)?.hasAttribute('hidden') ?? false;
const badge = (): string => root.querySelector('.nanovia-routing-badge')?.textContent ?? '';
const verdict = (): string => root.querySelector('.nanovia-verdict')?.textContent ?? '';
const chips = (name: string): string[] =>
    [...row(name).querySelectorAll('.nanovia-chip-item')].map((node) => node.getAttribute('data-id') ?? '');

describe('the empty state', () => {
    it('points at the Connections tab when there is no connection', async () => {
        await open();
        expect(text()).toContain('No connections yet');
        expect(root.querySelector('[data-section]')).toBeNull();
    });
});

describe('the tab', () => {
    it('shows the three sections for the first connection, with its saved values', async () => {
        seed({ routing: { enabled: true, order: ['alpha'], sort: 'price', zdr: true }, billing: 'auto' });
        await open();
        expect(field<HTMLSelectElement>('Connection').selectedOptions[0]?.textContent).toBe('Main · vendor/model');
        expect(section('routing')).toBeTruthy();
        expect(section('billing')).toBeTruthy();
        expect(section('reasoning')).toBeTruthy();
        expect(chips('order')).toEqual(['alpha']);
        expect(field<HTMLSelectElement>('Sort').value).toBe('price');
        expect(field<HTMLSelectElement>('Billing mode').value).toBe('auto');
        expect(checkbox('Zero data retention only').checked).toBe(true);
    });

    it('speaks Russian', async () => {
        tc.setLocale('ru');
        seed();
        await open();
        expect(text()).toContain('Маршрутизация');
        expect(text()).toContain('Вердикт');
        expect(button('Сохранить')).toBeTruthy();
    });

    it('registers itself as the tab «routing» with its strings', () => {
        const registered: { id: string; titleKey: string; order: number }[] = [];
        const ctx = {
            ...tc.ctx,
            panel: {
                registerTab: (tab: { id: string; titleKey: string; order: number }) => (registered.push(tab), () => {}),
            },
        };
        void routingFeature.init(ctx as never);
        expect(registered).toMatchObject([{ id: 'routing', titleKey: 'routing.tab' }]);
        expect(ctx.i18n.t('routing.tab')).toBe('Routing');
        expect(ctx.i18n.t('billing.reason.billing.forced')).toContain('pay as you go');
    });
});

describe('the live verdict', () => {
    it('starts in the subscription for default settings and follows every edit', async () => {
        seed();
        await open();
        expect(badge()).toBe('Subscription');
        expect(verdict()).toContain('Subscription');
        expect(verdict()).toContain('Requests are covered by the subscription.');

        // Routing is off by default: provider ids are kept but nothing is sent.
        type('Provider order', 'alpha');
        expect(badge()).toBe('Subscription');
        expect(hidden('.nanovia-off-note')).toBe(false);

        flip('Send routing preferences', true);
        expect(badge()).toBe('Pay as you go · +5%');
        expect(verdict()).toContain('+5% markup');
        expect(verdict()).toContain('Explicit routing (provider order) is billed pay as you go');
        expect(hidden('.nanovia-off-note')).toBe(true);
    });

    it('lists every reason and warning of the plan as sentences', async () => {
        seed({ routing: { enabled: true, only: ['alpha'], order: ['beta'], preferredMaxLatency: 2 }, webSearch: true });
        await open(catalogOf([makeModel({ id: 'vendor/model', included: false })], [makeProviders()]));
        const panel = verdict();
        expect(panel).toContain('vendor/model is not included in the subscription');
        expect(panel).toContain('Explicit routing (provider order, only these providers, preferred latency)');
        expect(panel).toContain('Web search (:online) is billed separately.');
        expect(panel).toContain('A preferred latency or throughput does nothing without a sort.');
        expect(panel).toContain('already limits the candidates');
        expect(root.querySelectorAll('.nanovia-reasons li')).toHaveLength(3);
        expect(root.querySelectorAll('.nanovia-warnings li')).toHaveLength(2);
    });

    it('says the catalog does not know the model, and improves when the catalog arrives', async () => {
        seed({ routing: { enabled: true, order: ['alpha'] } });
        const listeners: (() => void)[] = [];
        let known = false;
        const store: CatalogStore = {
            ...catalogOf(),
            model: (id) => (known ? catalogOf([MODEL]).model(id) : null),
            onChange: (listener) => {
                listeners.push(listener);
                return () => {};
            },
        };
        await open(store);
        expect(verdict()).toContain('Pay as you go');
        expect(verdict()).toContain('The catalog does not know this model yet');
        expect(text()).toContain('The catalog does not know this model: efforts are not limited');
        known = true;
        for (const listener of listeners) listener();
        expect(verdict()).not.toContain('The catalog does not know this model yet');
        expect(text()).toContain('The model can be switched off.');
    });

    it('says a model on a fixed route ignores the routing settings', async () => {
        seed({ routing: { enabled: true, order: ['alpha'] } });
        await open(catalogOf([MODEL], [makeProviders({ supportsProviderSelection: false })]));
        expect(hidden('.nanovia-fixed-note')).toBe(false);
        expect(badge()).toBe('Subscription');
        expect(verdict()).toContain('the routing settings (provider order) are ignored');
    });
});

describe('subscription-only mode', () => {
    it('locks every bypassing control with the reason, keeps zero data retention open, and lists what is stripped', async () => {
        seed({ routing: { enabled: true, order: ['alpha'], maxPrice: { prompt: 1, completion: null } } });
        await open();
        expect(badge()).toBe('Pay as you go · +5%');
        choose('Billing mode', 'subscription');

        for (const name of ['order', 'only', 'ignore', 'sort', 'quantizations', 'minQuantization', 'maxPrice']) {
            const controls = [
                ...row(name).querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select, button'),
            ];
            expect(controls.length, name).toBeGreaterThan(0);
            expect(
                controls.every((control) => control.disabled),
                name,
            ).toBe(true);
            expect(row(name).querySelector('.nanovia-lock')?.textContent).toContain('subscription-only');
        }
        for (const name of [
            'allowFallbacks',
            'requireParameters',
            'preferredMaxLatency',
            'preferredMinThroughput',
            'cachingRoute',
        ]) {
            expect(row(name).querySelector<HTMLInputElement>('input')?.disabled, name).toBe(true);
        }
        expect(row('zdr').querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
        expect(field<HTMLSelectElement>('Billing mode').disabled).toBe(false);

        expect(badge()).toBe('Subscription');
        expect(verdict()).toContain('Nanovia removes these settings from every request: provider order, price cap.');
        expect(verdict()).toContain('Nothing leaves the subscription');
    });

    it('unlocks the controls again when the mode changes back', async () => {
        seed();
        await open();
        choose('Billing mode', 'subscription');
        expect(field<HTMLSelectElement>('Sort').disabled).toBe(true);
        choose('Billing mode', 'paygo');
        expect(field<HTMLSelectElement>('Sort').disabled).toBe(false);
        expect(row('sort').querySelector('.nanovia-lock')?.hasAttribute('hidden')).toBe(true);
        expect(verdict()).toContain('This connection is set to pay as you go');
    });

    it('shows what leaves the subscription next to every bypassing control', async () => {
        seed();
        await open();
        for (const name of [
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
        ]) {
            expect(row(name).querySelector('.nanovia-bypass')?.textContent, name).toMatch(/subscription/i);
        }
        expect(row('order').querySelector('.nanovia-bypass')?.textContent).toContain('about 5%');
        expect(row('zdr').textContent).toContain('Keeps the subscription');
    });

    it('offers to remove what leaves the subscription, and the controls follow', async () => {
        seed({ routing: { enabled: true, order: ['alpha'], sort: 'price', zdr: true } });
        await open();
        await click('Remove what leaves the subscription');
        expect(chips('order')).toEqual([]);
        expect(field<HTMLSelectElement>('Sort').value).toBe('default');
        expect(checkbox('Zero data retention only').checked).toBe(true);
        expect(badge()).toBe('Subscription');
        expect(() => button('Remove what leaves the subscription')).toThrow();
        expect(text()).toContain('Unsaved changes');
    });
});

describe('the routing controls', () => {
    it('adds provider ids as chips (Enter, comma, blur), lower-cases them, removes them', async () => {
        seed({ routing: { enabled: true } });
        await open();
        const input = field<HTMLInputElement>('Provider order');
        input.value = 'DeepInfra';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
        expect(chips('order')).toEqual(['deepinfra']);
        type('Provider order', 'chutes, fireworks');
        expect(chips('order')).toEqual(['deepinfra', 'chutes', 'fireworks']);
        type('Provider order', 'chutes');
        expect(chips('order')).toEqual(['deepinfra', 'chutes', 'fireworks']);
        (row('order').querySelector('[aria-label="Remove chutes"]') as HTMLButtonElement).click();
        expect(chips('order')).toEqual(['deepinfra', 'fireworks']);
        expect(chips('only')).toEqual([]);
        type('Only these providers', 'x');
        type('Never these providers', 'y');
        expect(chips('only')).toEqual(['x']);
        expect(chips('ignore')).toEqual(['y']);
    });

    it('suggests the hosts the catalog knows, minus the ones already chosen, and asks for them on open', async () => {
        seed({ routing: { enabled: true, order: ['alpha'] } });
        const providers: ModelProviders = makeProviders({ ids: ['alpha', 'beta', 'gamma'] });
        const ensure = vi.fn(async () => providers);
        const catalog: CatalogStore = { ...catalogOf([MODEL], [providers]), ensureProviders: ensure };
        await open(catalog);
        expect(ensure).toHaveBeenCalledWith('vendor/model');
        const options = [...row('order').querySelectorAll('datalist option')].map((node) => node.getAttribute('value'));
        expect(options).toEqual(['beta', 'gamma']);
    });

    it('edits sort, precision allowlist and floor, price cap, fallbacks, parameters, zdr, preferences and caching', async () => {
        seed({ routing: { enabled: true } });
        await open();
        choose('Sort', 'throughput');
        flip('fp8', true);
        flip('int4', true);
        flip('int4', false);
        choose('Minimum precision', 'fp8');
        type('Prompt', '0.5');
        type('Completion', '1,5');
        flip('Allow fallbacks', false);
        flip('Require parameter support', true);
        flip('Zero data retention only', true);
        type('Preferred latency (seconds)', '3');
        type('Preferred throughput (tokens per second)', '40');
        flip('Route for prompt caching', true);
        expect(badge()).toBe('Pay as you go · +5%');

        await click('Save');
        const saved = h.backend.plugin.connections.get('seed000001');
        expect(saved?.routing).toEqual({
            enabled: true,
            order: [],
            only: [],
            ignore: [],
            sort: 'throughput',
            quantizations: ['fp8'],
            minQuantization: 'fp8',
            maxPrice: { prompt: 0.5, completion: 1.5 },
            allowFallbacks: false,
            requireParameters: true,
            zdr: true,
            preferredMaxLatency: 3,
            preferredMinThroughput: 40,
            cachingRoute: true,
        });
    });

    it('refuses a bad number: the field is marked and the draft keeps the last good value', async () => {
        seed({ routing: { enabled: true, maxPrice: { prompt: 2, completion: null } } });
        await open();
        const input = field<HTMLInputElement>('Prompt');
        expect(input.value).toBe('2');
        type('Prompt', 'abc');
        expect(input.classList.contains('nanovia-invalid')).toBe(true);
        await click('Save');
        expect(h.backend.plugin.connections.get('seed000001')?.routing.maxPrice.prompt).toBe(2);
        type('Prompt', '');
        expect(input.classList.contains('nanovia-invalid')).toBe(false);
        await click('Save');
        expect(h.backend.plugin.connections.get('seed000001')?.routing.maxPrice.prompt).toBeNull();
    });

    it('notes that a preferred latency needs a sort, and drops the note once there is one', async () => {
        seed({ routing: { enabled: true } });
        await open();
        const note = (): boolean => root.querySelector('.nanovia-warn-text')?.hasAttribute('hidden') ?? true;
        expect(note()).toBe(true);
        type('Preferred latency (seconds)', '2');
        expect(note()).toBe(false);
        expect(row('preferredMaxLatency').textContent).toContain('Needs a sort');
        choose('Sort', 'latency');
        expect(note()).toBe(true);
    });
});

describe('the reasoning section', () => {
    it('shows what the catalog says and the preview of what would be sent', async () => {
        seed();
        await open();
        const reasoning = section('reasoning').textContent ?? '';
        expect(reasoning).toContain('The model can be switched off. Efforts: none, low, high.');
        const rows = Object.fromEntries(
            [...section('reasoning').querySelectorAll<HTMLElement>('[data-scenario]')].map((node) => [
                node.dataset['scenario'],
                node.querySelector('code')?.textContent,
            ]),
        );
        expect(rows).toEqual({
            main: 'nothing, the model decides',
            mainNone: 'effort none',
            mainHigh: 'effort high',
            background: 'effort none',
        });
    });

    it('limits the fixed effort to what the model offers and saves it', async () => {
        seed();
        await open(catalogOf([makeModel({ id: 'vendor/model', reasoningEfforts: ['low', 'high'] })]));
        choose('Reasoning policy', 'fixed');
        const effort = field<HTMLSelectElement>('Effort');
        expect([...effort.options].map((option) => option.value)).toEqual(['low', 'medium', 'high']);
        expect(effort.value).toBe('medium');
        choose('Effort', 'high');
        expect(section('reasoning').textContent).toContain('effort high');
        checkbox('Leave the reasoning text out of the reply').checked = true;
        flip('Leave the reasoning text out of the reply', true);
        expect(section('reasoning').textContent).toContain('text hidden');
        await click('Save');
        expect(h.backend.plugin.connections.get('seed000001')?.reasoning).toEqual({
            policy: 'fixed',
            effort: 'high',
            hideThoughts: true,
        });
    });

    it('hides the effort select for the other policies and warns about a model that always reasons', async () => {
        seed();
        await open(catalogOf([makeModel({ id: 'vendor/model', reasoningEfforts: ['low', 'high'] })]));
        expect(field<HTMLSelectElement>('Reasoning policy').value).toBe('follow');
        expect(root.querySelector('.nanovia-effort')?.hasAttribute('hidden')).toBe(true);
        expect(section('reasoning').textContent).toContain('always reasons');
        choose('Reasoning policy', 'off');
        expect(verdict()).toContain('vendor/model always reasons (efforts: low, high)');
        choose('Reasoning policy', 'default');
        expect(verdict()).not.toContain('always reasons');
        expect(
            [...section('reasoning').querySelectorAll('code')].every(
                (node) => node.textContent === 'nothing, the model decides',
            ),
        ).toBe(true);
    });

    it('tells apart a model that does not reason', async () => {
        seed();
        await open(
            catalogOf([makeModel({ id: 'vendor/model', capabilities: { ...MODEL.capabilities, reasoning: false } })]),
        );
        expect(section('reasoning').textContent).toContain('does not reason');
    });
});

describe('saving', () => {
    it('sends billing, routing and reasoning through the connections service and clears the unsaved mark', async () => {
        seed();
        await open();
        flip('Send routing preferences', true);
        choose('Sort', 'price');
        choose('Billing mode', 'paygo');
        expect(text()).toContain('Unsaved changes');
        await click('Save');
        expect(text()).toContain('Saved.');
        expect(text()).not.toContain('Unsaved changes');
        const saved = h.backend.plugin.connections.get('seed000001');
        expect(saved).toMatchObject({ billing: 'paygo', routing: { enabled: true, sort: 'price' } });
        // The service rebuilt the list from the plugin; the tab shows the saved state without being rebuilt by hand.
        expect(field<HTMLSelectElement>('Sort').value).toBe('price');
        expect(h.connections.get('seed000001')?.config.billing).toBe('paygo');
    });

    it('shows the service’s error', async () => {
        seed();
        await open();
        choose('Billing mode', 'paygo');
        h.backend.plugin.failNext.set('PUT /connections/seed000001', {
            status: 400,
            code: 'bad_request',
            message: 'nope',
        });
        await click('Save');
        expect(root.querySelector('.nanovia-notice-error')?.textContent).toContain('nope');
        expect(text()).toContain('Unsaved changes');
    });

    it('revert goes back to the saved values', async () => {
        seed({ routing: { enabled: true, order: ['alpha'] } });
        await open();
        type('Provider order', 'beta');
        choose('Billing mode', 'paygo');
        expect(chips('order')).toEqual(['alpha', 'beta']);
        await click('Revert');
        expect(chips('order')).toEqual(['alpha']);
        expect(field<HTMLSelectElement>('Billing mode').value).toBe('auto');
        expect(text()).toContain('Changes discarded.');
        expect(text()).not.toContain('Unsaved changes');
    });

    it('does not follow a refresh over unsaved edits, but shows a changed connection when nothing is unsaved', async () => {
        seed({ routing: { enabled: true, order: ['alpha'] } });
        await open();
        // Nothing unsaved: a change on the plugin shows up.
        h.backend.plugin.connections.get('seed000001')!.routing.order = ['changed'];
        await h.connections.refresh();
        await settle();
        expect(chips('order')).toEqual(['changed']);
        // Unsaved edit: a change on the plugin does not erase it.
        type('Provider order', 'mine');
        h.backend.plugin.connections.get('seed000001')!.routing.order = ['other'];
        await h.connections.refresh();
        await settle();
        expect(chips('order')).toEqual(['changed', 'mine']);
    });
});

describe('several connections', () => {
    it('switches between them, and asks before dropping unsaved edits', async () => {
        seed({ name: 'Alpha', routing: { enabled: true, order: ['a'] } }, 'seed000001');
        seed({ name: 'Beta', routing: { enabled: true, order: ['b'] } }, 'seed000002');
        await open();
        expect(chips('order')).toEqual(['a']);
        choose('Connection', 'seed000002');
        await settle();
        expect(chips('order')).toEqual(['b']);

        type('Provider order', 'extra');
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        choose('Connection', 'seed000001');
        await settle();
        expect(h.mock.popups).toHaveLength(1);
        expect(chips('order')).toEqual(['b', 'extra']);
        expect(field<HTMLSelectElement>('Connection').value).toBe('seed000002');

        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        choose('Connection', 'seed000001');
        await settle();
        expect(chips('order')).toEqual(['a']);
    });

    it('follows a connection that was deleted', async () => {
        seed({ name: 'Alpha' }, 'seed000001');
        seed({ name: 'Beta' }, 'seed000002');
        await open();
        choose('Connection', 'seed000002');
        await settle();
        await h.connections.remove('seed000002');
        await settle();
        expect(field<HTMLSelectElement>('Connection').value).toBe('seed000001');
    });
});
