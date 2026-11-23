// A list of ids shown as removable chips with a text box to add more (provider ids). The box offers suggestions
// through a <datalist>; ids are committed on Enter, comma, or when the box loses focus.
import { clear, el, uid } from '../../ui';
import { addProviderIds } from './view-model';

export interface ChipListOptions {
    /** aria-label of the text box. */
    label: string;
    placeholder?: string;
    values: readonly string[];
    /** aria-label of the remove button of one chip. */
    removeLabel(id: string): string;
    onChange(values: string[]): void;
}

export interface ChipList {
    node: HTMLElement;
    /** The ids the box offers (the ones already chosen are the caller's business to leave out). */
    setSuggestions(ids: readonly string[]): void;
}

export function chipListInput(options: ChipListOptions): ChipList {
    let values = [...options.values];
    const listId = uid('nanovia-suggest');
    const chips = el('div', { class: 'nanovia-chiplist-chips' });
    const datalist = el('datalist', { attrs: { id: listId } });
    const input = el('input', {
        class: 'text_pole nanovia-text',
        attrs: {
            type: 'text',
            list: listId,
            placeholder: options.placeholder,
            'aria-label': options.label,
            autocomplete: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
        },
    });

    function draw(): void {
        clear(chips);
        for (const id of values) {
            chips.appendChild(
                el('span', { class: 'nanovia-chip nanovia-chip-info nanovia-chip-item', data: { id } }, [
                    el('span', { text: id }),
                    el('button', {
                        class: 'nanovia-chip-remove',
                        text: '×',
                        attrs: { type: 'button', 'aria-label': options.removeLabel(id) },
                        on: { click: () => remove(id) },
                    }),
                ]),
            );
        }
    }

    function commit(): void {
        const typed = input.value;
        input.value = '';
        if (!typed.trim()) return;
        const next = addProviderIds(values, typed);
        if (next.length === values.length) return;
        values = next;
        draw();
        options.onChange([...values]);
    }

    function remove(id: string): void {
        values = values.filter((value) => value !== id);
        draw();
        options.onChange([...values]);
    }

    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commit();
        }
    });

    draw();
    return {
        node: el('div', { class: 'nanovia-chiplist' }, [chips, input, datalist]),
        setSuggestions(ids) {
            clear(datalist);
            for (const id of ids) datalist.appendChild(el('option', { attrs: { value: id } }));
        },
    };
}
