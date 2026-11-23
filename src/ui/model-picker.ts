// A searchable model field: a plain text input (the value is always what is typed, so any model id works, with or
// without a catalog) with a dropdown of catalog models under it. The dropdown shows name, id, price and a subscription
// mark; typing narrows it, arrows and Enter pick, Escape closes. It opens on focus, asks the catalog to load, and follows
// the catalog while it is open (the list appears when the load finishes). With an empty catalog it only shows a note.
import type { CatalogStore } from '../core/catalog';
import type { I18nParams } from '../core/types';
import { filterCatalog, sortCatalog } from '../domain/catalog';
import type { CatalogModel } from '../shared/contracts';
import { uid } from './controls';
import { clear, el } from './dom';
import { formatPricePair } from './format';
import './model-picker.css';

/** Options shown at once; the rest is reached by typing. */
export const PICKER_LIMIT = 30;

export interface ModelPickerOptions {
    catalog: Pick<CatalogStore, 'models' | 'refresh' | 'onChange' | 'status'>;
    t(key: string, params?: I18nParams): string;
    value: string;
    /** The accessible name of the input. */
    label?: string;
    placeholder?: string;
    maxLength?: number;
    disabled?: boolean;
    /** Fires on every change of the text, typed or picked. */
    onInput(value: string): void;
}

/** The models to offer for what is typed: id and name matches, those that start with it first; nothing typed = all. */
export function pickerMatches(models: readonly CatalogModel[], text: string): CatalogModel[] {
    const query = text.trim();
    if (!query) return sortCatalog(models, 'subscription');
    const matched = filterCatalog(models, { text: query });
    const lower = query.toLowerCase();
    const rank = (model: CatalogModel): number =>
        model.id.toLowerCase() === lower ? 0 : model.id.toLowerCase().startsWith(lower) ? 1 : 2;
    return matched
        .map((model, index) => ({ model, index, rank: rank(model) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.model);
}

export function modelPicker(options: ModelPickerOptions): HTMLElement {
    const { catalog, t } = options;
    const listId = uid('nanovia-picker');
    const input = el('input', {
        class: 'text_pole nanovia-text',
        attrs: {
            type: 'text',
            role: 'combobox',
            'aria-label': options.label,
            'aria-autocomplete': 'list',
            'aria-expanded': 'false',
            'aria-controls': listId,
            placeholder: options.placeholder,
            maxlength: options.maxLength,
            disabled: options.disabled === true,
            autocomplete: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
        },
    });
    input.value = options.value;
    const list = el('div', { class: 'nanovia-picker-list', attrs: { id: listId, role: 'listbox', hidden: true } });
    const root = el('div', { class: 'nanovia-picker' }, [input, list]);

    let open = false;
    let active = -1;
    let shown: CatalogModel[] = [];
    let unsubscribe: (() => void) | null = null;

    function setActive(index: number): void {
        active = index;
        [...list.querySelectorAll('.nanovia-picker-option')].forEach((node, i) => {
            node.classList.toggle('nanovia-picker-active', i === index);
            node.setAttribute('aria-selected', String(i === index));
            if (i === index) node.scrollIntoView?.({ block: 'nearest' });
        });
    }

    function pick(model: CatalogModel): void {
        input.value = model.id;
        options.onInput(model.id);
        close();
    }

    function note(text: string): HTMLElement {
        return el('div', { class: 'nanovia-picker-note nanovia-muted', text });
    }

    function render(): void {
        clear(list);
        active = -1;
        const models = catalog.models();
        if (models.length === 0) {
            shown = [];
            list.appendChild(note(t(catalog.status().error ? 'ui.picker.unavailable' : 'ui.picker.loading')));
            return;
        }
        const matches = pickerMatches(models, input.value);
        shown = matches.slice(0, PICKER_LIMIT);
        if (matches.length === 0) {
            list.appendChild(note(t('ui.picker.noMatch')));
            return;
        }
        for (const model of shown) {
            const free = model.subscription.included;
            const row = el(
                'div',
                {
                    class: 'nanovia-picker-option',
                    data: { model: model.id },
                    attrs: { role: 'option', 'aria-selected': 'false' },
                },
                [
                    el('div', { class: 'nanovia-picker-main' }, [
                        el('span', { class: 'nanovia-picker-name', text: model.name }),
                        free
                            ? el('span', {
                                  class: 'nanovia-picker-sub',
                                  text: t('ui.picker.sub'),
                                  title: t('ui.picker.subTitle'),
                              })
                            : null,
                    ]),
                    el('div', { class: 'nanovia-picker-detail nanovia-muted' }, [
                        el('span', { class: 'nanovia-picker-id', text: model.id }),
                        el('span', {
                            class: 'nanovia-picker-price',
                            text: formatPricePair(model.pricing.prompt, model.pricing.completion),
                            title: t('ui.picker.priceTitle'),
                        }),
                    ]),
                ],
            );
            // mousedown (not click) would blur the input before the pick lands; keep the focus and pick on click.
            row.addEventListener('mousedown', (event) => event.preventDefault());
            row.addEventListener('click', () => pick(model));
            list.appendChild(row);
        }
        if (matches.length > shown.length) {
            list.appendChild(note(t('ui.picker.more', { count: matches.length - shown.length })));
        }
    }

    function openList(): void {
        if (options.disabled) return;
        if (!open) {
            open = true;
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            unsubscribe = catalog.onChange(() => {
                // The form that held this field may have been redrawn: a detached field stops following the catalog.
                if (!root.isConnected) return close();
                if (open) render();
            });
            void catalog.refresh();
        }
        render();
    }

    function close(): void {
        open = false;
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        unsubscribe?.();
        unsubscribe = null;
        active = -1;
    }

    input.addEventListener('focus', openList);
    input.addEventListener('click', openList);
    input.addEventListener('blur', close);
    input.addEventListener('input', () => {
        options.onInput(input.value);
        openList();
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (open) event.preventDefault();
            close();
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) openList();
            if (shown.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive(active < 0 ? (step > 0 ? 0 : shown.length - 1) : (active + step + shown.length) % shown.length);
            return;
        }
        if (event.key === 'Enter' && open && active >= 0) {
            const model = shown[active];
            if (model) {
                event.preventDefault();
                pick(model);
            }
        }
    });

    return root;
}
