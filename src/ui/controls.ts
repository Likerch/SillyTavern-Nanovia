// Form controls styled like SillyTavern's own (checkbox_label, text_pole).
import { el } from './dom';
import type { Child } from './dom';

let nextId = 0;

/** Unique id for label/for pairs. */
export function uid(prefix = 'nanovia'): string {
    nextId += 1;
    return `${prefix}-${nextId}`;
}

export interface ToggleOptions {
    label: string;
    checked: boolean;
    hint?: string;
    disabled?: boolean;
    onChange(checked: boolean): void | Promise<void>;
}

export function toggle(options: ToggleOptions): HTMLLabelElement {
    const id = uid('nanovia-toggle');
    const input = el('input', { attrs: { type: 'checkbox', id, disabled: options.disabled === true } });
    input.checked = options.checked;
    input.addEventListener('change', () => {
        void options.onChange(input.checked);
    });
    return el('label', { class: 'checkbox_label nanovia-toggle', attrs: { for: id }, title: options.hint }, [
        input,
        el('span', { text: options.label }),
    ]);
}

export interface SelectOption<T extends string> {
    value: T;
    label: string;
}

export interface SelectOptions<T extends string> {
    value: T;
    options: SelectOption<T>[];
    label?: string;
    disabled?: boolean;
    onChange(value: T): void | Promise<void>;
}

export function select<T extends string>(options: SelectOptions<T>): HTMLSelectElement {
    const node = el('select', {
        class: 'text_pole nanovia-select',
        attrs: { 'aria-label': options.label, disabled: options.disabled === true },
    });
    for (const option of options.options) {
        node.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
    }
    node.value = options.options.some((option) => option.value === options.value)
        ? options.value
        : (options.options[0]?.value ?? '');
    node.addEventListener('change', () => {
        const chosen = options.options.find((option) => option.value === node.value);
        if (chosen) void options.onChange(chosen.value);
    });
    return node;
}

export interface TextOptions {
    value: string;
    /** 'password' fields are never autofilled or spell-checked. */
    type?: 'text' | 'password';
    placeholder?: string;
    label?: string;
    disabled?: boolean;
    maxLength?: number;
    /** Fires on every keystroke. */
    onInput?(value: string): void;
    /** Fires when the value is committed (blur, Enter). */
    onChange?(value: string): void | Promise<void>;
}

export function textInput(options: TextOptions): HTMLInputElement {
    const secret = options.type === 'password';
    const node = el('input', {
        class: 'text_pole nanovia-text',
        attrs: {
            type: options.type ?? 'text',
            placeholder: options.placeholder,
            'aria-label': options.label,
            maxlength: options.maxLength,
            disabled: options.disabled === true,
            autocomplete: secret ? 'off' : undefined,
            autocapitalize: 'off',
            spellcheck: 'false',
        },
    });
    node.value = options.value;
    if (options.onInput) {
        const handler = options.onInput;
        node.addEventListener('input', () => handler(node.value));
    }
    if (options.onChange) {
        const handler = options.onChange;
        node.addEventListener('change', () => void handler(node.value));
    }
    return node;
}

export interface TextAreaOptions {
    value: string;
    rows?: number;
    placeholder?: string;
    label?: string;
    maxLength?: number;
    onInput?(value: string): void;
}

export function textArea(options: TextAreaOptions): HTMLTextAreaElement {
    const node = el('textarea', {
        class: 'text_pole nanovia-textarea',
        attrs: {
            rows: options.rows ?? 3,
            placeholder: options.placeholder,
            'aria-label': options.label,
            maxlength: options.maxLength,
        },
    });
    node.value = options.value;
    if (options.onInput) {
        const handler = options.onInput;
        node.addEventListener('input', () => handler(node.value));
    }
    return node;
}

export type ChipKind = 'ok' | 'warn' | 'error' | 'info' | 'muted';

/** A small coloured label: a status, a mode, a billing outcome. */
export function chip(label: string, kind: ChipKind = 'muted', title?: string): HTMLElement {
    return el('span', { class: ['nanovia-chip', `nanovia-chip-${kind}`], text: label, title });
}

/** A labelled row: label on the left (top on phones), control on the right, optional hint below. */
export function field(label: string, control: Child, hint?: string): HTMLElement {
    return el('div', { class: 'nanovia-field' }, [
        el('div', { class: 'nanovia-field-label', text: label }),
        el('div', { class: 'nanovia-field-control' }, [control]),
        hint ? el('div', { class: 'nanovia-field-hint', text: hint }) : null,
    ]);
}
