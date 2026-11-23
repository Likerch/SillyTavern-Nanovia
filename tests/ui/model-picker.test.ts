// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { CatalogStore } from '../../src/core/catalog';
import { UI_STRINGS } from '../../src/ui/strings';
import { PICKER_LIMIT, modelPicker, pickerMatches } from '../../src/ui/model-picker';
import type { CatalogModel } from '../../src/shared/contracts';
import { createI18n } from '../../src/core/i18n';
import { GLM, SAMPLE_MODELS, createCatalogRig } from '../helpers/catalog-fakes';
import type { CatalogRig } from '../helpers/catalog-fakes';
import { flush } from '../helpers/fakes';

const i18n = createI18n(() => 'en');
i18n.register(UI_STRINGS);
const t = i18n.t.bind(i18n);

let host: HTMLElement;
let values: string[];

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    values = [];
});

afterEach(() => {
    host.remove();
});

function mount(catalog: Pick<CatalogStore, 'models' | 'refresh' | 'onChange' | 'status'>, value = '') {
    const picker = modelPicker({
        catalog,
        t,
        value,
        label: 'Model id',
        onInput: (next) => void values.push(next),
    });
    host.appendChild(picker);
    const input = picker.querySelector('input') as HTMLInputElement;
    const list = picker.querySelector('.nanovia-picker-list') as HTMLElement;
    return { picker, input, list };
}

function type(input: HTMLInputElement, text: string): void {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(input: HTMLInputElement, name: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
}

const optionIds = (list: HTMLElement): string[] =>
    [...list.querySelectorAll<HTMLElement>('.nanovia-picker-option')].map((node) => node.dataset['model'] ?? '');

async function loaded(): Promise<CatalogRig> {
    const rig = createCatalogRig();
    await rig.store.refresh();
    return rig;
}

describe('without a catalog', () => {
    it('is a plain text field: what is typed is the value', () => {
        const catalog = createEmptyCatalogStore();
        const { input, list } = mount(catalog, 'my/model');
        expect(input.value).toBe('my/model');
        expect(input.getAttribute('aria-label')).toBe('Model id');
        expect(list.hidden).toBe(true);
        input.focus();
        type(input, 'other/model');
        expect(values).toEqual(['other/model']);
        expect(list.textContent).toContain('Loading the model catalog');
    });

    it('says when the catalog is not available, and asks it to load when it opens', () => {
        let refreshed = 0;
        const catalog: CatalogStore = {
            ...createEmptyCatalogStore(),
            status: () => ({ loaded: false, fetchedAt: null, source: null, error: 'unreachable' }),
            refresh: async () => void refreshed++,
        };
        const { input, list } = mount(catalog);
        input.dispatchEvent(new Event('focus'));
        expect(refreshed).toBe(1);
        expect(list.hidden).toBe(false);
        expect(list.textContent).toContain('not available');
        input.dispatchEvent(new Event('blur'));
        expect(list.hidden).toBe(true);
    });
});

describe('with a catalog', () => {
    it('offers the models on focus, subscription ones first, with name, id and price', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.dispatchEvent(new Event('focus'));
        expect(list.hidden).toBe(false);
        expect(input.getAttribute('aria-expanded')).toBe('true');
        const ids = optionIds(list);
        expect(ids).toHaveLength(Math.min(PICKER_LIMIT, SAMPLE_MODELS.length));
        const firstOutside = SAMPLE_MODELS.findIndex((m) => !m.subscription.included);
        expect(firstOutside).toBeGreaterThan(0);
        expect(store.model(ids[0] ?? '')?.subscription.included).toBe(true);
        const glm = list.querySelector(`[data-model="${GLM}"]`);
        expect(glm?.textContent).toContain('GLM 5.3');
        expect(glm?.textContent).toContain(GLM);
        expect(glm?.textContent).toContain('0.6 / 1.1');
        expect(glm?.querySelector('.nanovia-picker-sub')?.textContent).toBe('sub');
        const ember = list.querySelector('[data-model="fireworks/ember-1"]');
        expect(ember?.querySelector('.nanovia-picker-sub')).toBeNull();
    });

    it('narrows while typing and keeps the typed text as the value', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.focus();
        type(input, 'glm 5.3');
        expect(values).toEqual(['glm 5.3']);
        const ids = optionIds(list);
        expect(ids).toContain(GLM);
        expect(ids).not.toContain('fireworks/ember-1');
        // The id that starts with the text comes first.
        type(input, GLM);
        expect(optionIds(list)[0]).toBe(GLM);
    });

    it('says so when nothing matches, and the text still counts', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.focus();
        type(input, 'zzz-nothing-like-this');
        expect(optionIds(list)).toEqual([]);
        expect(list.textContent).toContain('used as the model id');
        expect(values.at(-1)).toBe('zzz-nothing-like-this');
    });

    it('picks with a click: sets the id, reports it and closes', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.focus();
        list.querySelector<HTMLElement>(`[data-model="${GLM}"]`)?.click();
        expect(input.value).toBe(GLM);
        expect(values).toEqual([GLM]);
        expect(list.hidden).toBe(true);
    });

    it('does not take the focus away on mousedown on an option', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.focus();
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        list.querySelector('.nanovia-picker-option')?.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('works from the keyboard: arrows move, Enter picks, Escape closes', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.focus();
        type(input, 'glm');
        const ids = optionIds(list);
        key(input, 'ArrowDown');
        key(input, 'ArrowDown');
        const active = list.querySelector('.nanovia-picker-active') as HTMLElement;
        expect(active.dataset['model']).toBe(ids[1]);
        expect(active.getAttribute('aria-selected')).toBe('true');
        key(input, 'ArrowUp');
        expect((list.querySelector('.nanovia-picker-active') as HTMLElement).dataset['model']).toBe(ids[0]);
        const enter = key(input, 'Enter');
        expect(enter.defaultPrevented).toBe(true);
        expect(input.value).toBe(ids[0]);
        expect(list.hidden).toBe(true);

        type(input, 'glm');
        expect(list.hidden).toBe(false);
        key(input, 'Escape');
        expect(list.hidden).toBe(true);
    });

    it('Enter without a highlighted option is left alone (the form keeps its own behaviour)', async () => {
        const { store } = await loaded();
        const { input } = mount(store);
        input.focus();
        type(input, 'glm');
        expect(key(input, 'Enter').defaultPrevented).toBe(false);
    });

    it('wraps around at both ends', async () => {
        const { store } = await loaded();
        const { input, list } = mount(store);
        input.focus();
        type(input, 'glm');
        const ids = optionIds(list);
        key(input, 'ArrowUp');
        expect((list.querySelector('.nanovia-picker-active') as HTMLElement).dataset['model']).toBe(ids.at(-1));
        key(input, 'ArrowDown');
        expect((list.querySelector('.nanovia-picker-active') as HTMLElement).dataset['model']).toBe(ids[0]);
    });

    it('shows at most PICKER_LIMIT options and says how many more there are', () => {
        const many: CatalogModel[] = Array.from({ length: PICKER_LIMIT + 7 }, (_, i) => ({
            ...(SAMPLE_MODELS[0] as CatalogModel),
            id: `v/model-${i}`,
            name: `Model ${i}`,
        }));
        const catalog: CatalogStore = { ...createEmptyCatalogStore(), models: () => many };
        const { input, list } = mount(catalog);
        input.focus();
        expect(optionIds(list)).toHaveLength(PICKER_LIMIT);
        expect(list.textContent).toContain('7 more');
    });

    it('fills the list in when the catalog finishes loading while it is open, and stops following when closed', async () => {
        const rig = createCatalogRig();
        const { input, list } = mount(rig.store);
        input.focus();
        // focus asked the store to load; let it finish.
        await flush();
        await flush();
        expect(optionIds(list).length).toBeGreaterThan(0);
        expect(rig.plugin.calls).toEqual(['GET /catalog']);

        input.dispatchEvent(new Event('blur'));
        const before = list.innerHTML;
        await rig.store.refresh(true);
        expect(list.innerHTML).toBe(before);
    });

    it('a field that was removed from the page stops following the catalog', async () => {
        const rig = createCatalogRig();
        await rig.store.refresh();
        const { picker, input } = mount(rig.store);
        input.focus();
        picker.remove();
        let renders = 0;
        const observer = new MutationObserver(() => void renders++);
        observer.observe(picker, { childList: true, subtree: true });
        await rig.store.refresh(true);
        await flush();
        observer.disconnect();
        expect(renders).toBe(0);
    });

    it('can be disabled', async () => {
        const { store } = await loaded();
        const picker = modelPicker({ catalog: store, t, value: 'x', disabled: true, onInput: () => {} });
        host.appendChild(picker);
        const input = picker.querySelector('input') as HTMLInputElement;
        expect(input.disabled).toBe(true);
        input.dispatchEvent(new Event('focus'));
        expect((picker.querySelector('.nanovia-picker-list') as HTMLElement).hidden).toBe(true);
    });
});

describe('pickerMatches', () => {
    it('puts the exact id first, then ids that start with the text, then the rest in catalog order', () => {
        const ids = pickerMatches(SAMPLE_MODELS, 'glm').map((m) => m.id);
        expect(ids.length).toBeGreaterThan(3);
        const startsWith = ids.filter((id) => id.toLowerCase().startsWith('glm'));
        expect(ids.slice(0, startsWith.length)).toEqual(startsWith);
        expect(pickerMatches(SAMPLE_MODELS, GLM)[0]?.id).toBe(GLM);
    });

    it('lists every model, subscription first, for an empty text', () => {
        const all = pickerMatches(SAMPLE_MODELS, '  ');
        expect(all).toHaveLength(SAMPLE_MODELS.length);
        const firstOutside = all.findIndex((m) => !m.subscription.included);
        expect(all.slice(firstOutside).every((m) => !m.subscription.included)).toBe(true);
    });
});
