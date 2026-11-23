// Small controls of the Management forms that the generic ui/ set does not have: a number field (typed text, parsed by the
// form model), a date field, and a notice box with an optional button. Text always goes in as text.
import type { FeatureContext } from '../../core/context';
import type { MgmtDetail } from '../../core/mgmt';
import { button, el, textInput } from '../../ui';

export type NoticeKind = 'ok' | 'warn' | 'error';

export interface NoticeAction {
    label: string;
    onClick(): void | Promise<void>;
}

/** What every section of the tab gets: the context and the shared notice line under the head. */
export interface SectionDeps {
    ctx: FeatureContext;
    notify(kind: NoticeKind, text: string, action?: NoticeAction): void;
}

/** A section of the tab: its element, and a redraw for when the store or the connections changed. */
export interface Section {
    el: HTMLElement;
    update(detail: MgmtDetail): void;
}

/** A text field for a number: the value stays text until the form model parses it (so "0,5" or "" are the user's to type). */
export function numberField(options: {
    value: string;
    label: string;
    invalid?: boolean;
    disabled?: boolean;
    onInput(value: string): void;
}): HTMLInputElement {
    const input = textInput({
        value: options.value,
        label: options.label,
        disabled: options.disabled === true,
        onInput: options.onInput,
    });
    input.setAttribute('inputmode', 'decimal');
    if (options.invalid) input.setAttribute('aria-invalid', 'true');
    return input;
}

/** A calendar date field (`YYYY-MM-DD`); empty = no date. */
export function dateField(options: {
    value: string;
    label: string;
    invalid?: boolean;
    onInput(value: string): void;
}): HTMLInputElement {
    const input = el('input', {
        class: 'text_pole nanovia-text',
        attrs: { type: 'date', 'aria-label': options.label, 'aria-invalid': options.invalid ? 'true' : undefined },
    });
    input.value = options.value;
    const handler = (): void => options.onInput(input.value);
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
    return input;
}

/** A coloured notice line, with a button when the notice offers a next step. */
export function noticeBox(kind: NoticeKind, text: string, action?: NoticeAction): HTMLElement {
    return el('div', { class: ['nanovia-notice', `nanovia-notice-${kind}`] }, [
        el('div', { text }),
        action ? button({ label: action.label, kind: 'ghost', onClick: action.onClick }) : null,
    ]);
}
