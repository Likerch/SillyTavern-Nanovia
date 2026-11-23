// Small pieces the Media studios share: the notice box, a number field, reading a file into a data URL, copying text, the
// cost block of a finished call and the busy/error line. Text always goes in as text.
import type { FeatureContext } from '../../core/context';
import type { MediaError, recorderSupport, startRecording } from '../../host';
import type { MediaCost, Medium } from '../../shared/contracts-media';
import { button, chip, clear, el, textInput } from '../../ui';
import type { MediaSection, MediaSession } from './session';
import { costView, errorText, mayHaveBeenCharged } from './view-model';

export type NoticeKind = 'ok' | 'warn' | 'error';

/** What every studio gets, and what it gives back for the tab to keep in step. */
export interface StudioDeps {
    ctx: FeatureContext;
    session: MediaSession;
    /** Opens another section of the tab (the catalog's «Use» button opens the studio). */
    go(section: MediaSection): void;
}

/** Browser pieces a test replaces (the microphone, the length of an audio file); the tab uses the real ones otherwise. */
export interface TabHooks {
    startRecording?: typeof startRecording;
    recorderSupport?: typeof recorderSupport;
    audioDuration?: (file: Blob) => Promise<number | null>;
}

export interface Studio {
    el: HTMLElement;
    /** The media store changed (a catalog, a result, a job, the plugin's state): redraw what depends on it. */
    update(): void;
    dispose(): void;
}

/** A coloured notice line. */
export function noticeBox(kind: NoticeKind, text: string): HTMLElement {
    return el(
        'div',
        { class: ['nanovia-notice', `nanovia-notice-${kind}`], attrs: { role: kind === 'error' ? 'alert' : 'status' } },
        [el('div', { text })],
    );
}

/** A text field for a number: the value stays text until the form model parses it (so "0,5" or "" are the user's to type). */
export function numberInput(options: {
    value: string;
    label: string;
    placeholder?: string;
    invalid?: boolean;
    disabled?: boolean;
    onInput(value: string): void;
}): HTMLInputElement {
    const input = textInput({
        value: options.value,
        label: options.label,
        disabled: options.disabled === true,
        ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
        onInput: options.onInput,
    });
    input.setAttribute('inputmode', 'decimal');
    if (options.invalid) input.setAttribute('aria-invalid', 'true');
    return input;
}

/** A file read into a data URL (`data:image/png;base64,…`); rejects when the browser cannot read it. */
export function readAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
        reader.readAsDataURL(file);
    });
}

/** Puts text on the clipboard; the old textarea trick where the async API is missing (a page without a secure context). */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Fall through to the textarea route.
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const done = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        area.remove();
        return done;
    } catch {
        return false;
    }
}

/** The cost of a finished call: what was billed, where the figure comes from, what was estimated, and what that means. */
export function costBlock(cost: MediaCost, medium: Medium, t: FeatureContext['t']): HTMLElement {
    const view = costView(cost, medium, t);
    return el('div', { class: 'nanovia-media-cost', data: { source: cost.source } }, [
        el('div', { class: 'nanovia-row' }, [
            el('b', { text: t('media.cost.billed') }),
            el('span', { class: 'nanovia-media-money', text: view.billed }),
            chip(view.source.label, view.source.kind),
            view.paymentSource ? chip(view.paymentSource, 'muted', t('media.cost.paymentSource')) : null,
        ]),
        view.estimated
            ? el('div', { class: 'nanovia-muted', text: t('media.cost.estimated', { cost: view.estimated }) })
            : null,
        el('div', { class: 'nanovia-field-hint', text: view.note }),
    ]);
}

/** The line under a button: nothing, "working…", or why the call failed (with the warning when it may have been charged). */
export function statusLine(
    host: HTMLElement,
    t: FeatureContext['t'],
    state: { busy: string | null; error: MediaError | null },
): void {
    clear(host);
    if (state.busy) {
        host.appendChild(
            el('div', { class: 'nanovia-muted nanovia-media-busy', text: state.busy, attrs: { role: 'status' } }),
        );
        return;
    }
    if (!state.error) return;
    host.appendChild(noticeBox('error', errorText(state.error, t)));
    if (mayHaveBeenCharged(state.error)) host.appendChild(noticeBox('warn', t('media.error.timeout.charged')));
}

/** A «copy» button that says it worked. */
export function copyButton(label: string, doneLabel: string, text: () => string): HTMLButtonElement {
    const node: HTMLButtonElement = button({
        label,
        icon: 'copy',
        kind: 'ghost',
        onClick: async () => {
            const done = await copyText(text());
            const span = node.querySelector('span');
            if (!done || !span) return;
            span.textContent = doneLabel;
            setTimeout(() => {
                span.textContent = label;
            }, 1500);
        },
    });
    return node;
}
