// The create/edit form of a connection. It owns no state of its own: `form` is the FormState of view-model.ts and the
// inputs write into it, so a redraw (the mode changed, a key was added) shows the same values again.
import type { ConnectionEntry } from '../../core/connections';
import type { FeatureContext } from '../../core/context';
import { qvinkState } from '../../host';
import type { KeyInfo } from '../../shared/contracts';
import { button, chip, el, field, select, textArea, textInput, toggle } from '../../ui';
import type { SelectOption } from '../../ui';
import { modelPicker } from '../../ui/model-picker';
import {
    BILLING_MODES,
    CONNECTION_MODES,
    REASONING_EFFORTS,
    REASONING_POLICIES,
    keyLabel,
    needsDirectKey,
    showsDirectKey,
    warnsQvinkOverlap,
} from './view-model';
import type { FormState } from './view-model';

export interface FormDeps {
    ctx: FeatureContext;
    form: FormState;
    /** The connection being edited; null for a new one. */
    entry: ConnectionEntry | null;
    /** Keys the plugin knows; null while unknown (plugin down or not loaded yet). */
    keys: KeyInfo[] | null;
    redraw(): void;
    save(): Promise<void>;
    cancel(): void;
    addKey(label: string, value: string): Promise<void>;
}

/** A hint line that follows the value of the control above it. */
function hintLine(text: string): HTMLElement {
    return el('div', { class: 'nanovia-field-hint', text });
}

export function renderConnectionForm(deps: FormDeps): HTMLElement {
    const { ctx, form, entry } = deps;
    const t = ctx.t;
    const pluginUp = ctx.connections.pluginUp();
    const formCtx = { pluginUp, hasDirectKey: entry?.hasDirectKey ?? false };

    const modeOptions: SelectOption<FormState['mode']>[] = CONNECTION_MODES.map((value) => ({
        value,
        label: t(`connections.mode.${value}`),
    }));
    const modeHint = hintLine(t(`connections.mode.${form.mode}.hint`));
    const modeRow = field(
        t('connections.form.mode'),
        select({
            value: form.mode,
            options: modeOptions,
            label: t('connections.form.mode'),
            onChange: (value) => {
                form.mode = value;
                deps.redraw();
            },
        }),
    );
    modeRow.appendChild(modeHint);

    const billingOptions: SelectOption<FormState['billing']>[] = BILLING_MODES.map((value) => ({
        value,
        label: t(`connections.billing.${value}`),
    }));
    const billingHint = hintLine(t(`connections.billing.${form.billing}.hint`));
    const billingRow = field(
        t('connections.form.billing'),
        select({
            value: form.billing,
            options: billingOptions,
            label: t('connections.form.billing'),
            onChange: (value) => {
                form.billing = value;
                billingHint.textContent = t(`connections.billing.${value}.hint`);
            },
        }),
    );
    billingRow.appendChild(billingHint);

    const policyOptions: SelectOption<FormState['reasoningPolicy']>[] = REASONING_POLICIES.map((value) => ({
        value,
        label: t(`connections.reasoning.${value}`),
    }));
    const policyHint = hintLine(t(`connections.reasoning.${form.reasoningPolicy}.hint`));
    const policyRow = field(
        t('connections.form.reasoning'),
        select({
            value: form.reasoningPolicy,
            options: policyOptions,
            label: t('connections.form.reasoning'),
            onChange: (value) => {
                form.reasoningPolicy = value;
                deps.redraw();
            },
        }),
    );
    policyRow.appendChild(policyHint);

    const children: (Node | null)[] = [
        el('h4', {
            class: 'nanovia-form-title',
            text: t(entry ? 'connections.form.titleEdit' : 'connections.form.titleNew'),
        }),
        field(
            t('connections.form.name'),
            textInput({
                value: form.name,
                label: t('connections.form.name'),
                maxLength: 80,
                onInput: (value) => void (form.name = value),
            }),
            t('connections.form.nameHint'),
        ),
        field(
            t('connections.form.model'),
            // A searchable pick from the catalog; typing any id by hand works too (and is all there is without a catalog).
            modelPicker({
                catalog: ctx.catalog,
                t,
                value: form.modelId,
                label: t('connections.form.model'),
                maxLength: 200,
                onInput: (value) => void (form.modelId = value),
            }),
            t('connections.form.modelHint'),
        ),
        modeRow,
    ];

    // The key: one of the plugin's keys, or (direct mode) the NanoGPT key itself, typed once.
    if (form.mode !== 'direct') children.push(renderKeyPicker(deps, pluginUp));
    if (showsDirectKey(form, formCtx)) {
        const onFile = formCtx.hasDirectKey;
        children.push(
            field(
                t('connections.form.directKey'),
                textInput({
                    value: form.directKey,
                    type: 'password',
                    label: t('connections.form.directKey'),
                    placeholder: onFile ? t('connections.form.directKeyOnFile') : '',
                    onInput: (value) => void (form.directKey = value),
                }),
                needsDirectKey(form, formCtx)
                    ? t('connections.form.directKeyHint')
                    : t('connections.form.directKeyOnFile'),
            ),
        );
    }

    children.push(billingRow, policyRow);
    if (form.reasoningPolicy === 'fixed') {
        const effortOptions: SelectOption<string>[] = REASONING_EFFORTS.map((value) => ({
            value,
            label: t(`connections.effort.${value}`),
        }));
        children.push(
            field(
                t('connections.form.effort'),
                select({
                    value: form.reasoningEffort === '' ? 'medium' : form.reasoningEffort,
                    options: effortOptions,
                    label: t('connections.form.effort'),
                    onChange: (value) => {
                        form.reasoningEffort = REASONING_EFFORTS.find((effort) => effort === value) ?? 'medium';
                    },
                }),
            ),
        );
        // Picking nothing means the default shown in the select; make that the state too.
        if (form.reasoningEffort === '') form.reasoningEffort = 'medium';
    }
    children.push(
        toggle({
            label: t('connections.form.hideThoughts'),
            checked: form.hideThoughts,
            onChange: (checked) => void (form.hideThoughts = checked),
        }),
        toggle({
            label: t('connections.form.webSearch'),
            checked: form.webSearch,
            onChange: (checked) => void (form.webSearch = checked),
        }),
        renderMemory(deps),
        field(
            t('connections.form.note'),
            textArea({
                value: form.note,
                rows: 2,
                label: t('connections.form.note'),
                maxLength: 1000,
                onInput: (value) => void (form.note = value),
            }),
        ),
    );
    if (!pluginUp && form.mode !== 'direct') {
        children.push(el('div', { class: 'nanovia-muted', text: t('connections.form.offline') }));
    }
    children.push(
        el('div', { class: 'nanovia-row nanovia-form-actions' }, [
            button({ label: t('connections.form.save'), icon: 'check', kind: 'primary', onClick: () => deps.save() }),
            button({ label: t('connections.form.cancel'), onClick: () => deps.cancel() }),
        ]),
    );
    return el('form', { class: 'nanovia-form', on: { submit: (event) => event.preventDefault() } }, children);
}

/**
 * NanoGPT Context Memory: the switch, how long NanoGPT keeps the context, a hint that it is billed separately (and off by
 * default) and, while Qvink Memory is on too, the warning that both summarise the same chat.
 */
function renderMemory(deps: FormDeps): HTMLElement {
    const { ctx, form } = deps;
    const t = ctx.t;
    const days = textInput({
        value: form.memoryDays,
        label: t('connections.form.memoryDays'),
        placeholder: t('connections.form.memoryDaysPlaceholder'),
        maxLength: 3,
        disabled: !form.memoryEnabled,
        onInput: (value) => void (form.memoryDays = value),
    });
    const box = el('div', { class: 'nanovia-memory' }, [
        toggle({
            label: t('connections.form.memory'),
            checked: form.memoryEnabled,
            onChange: (checked) => {
                form.memoryEnabled = checked;
                days.disabled = !checked;
            },
        }),
        hintLine(t('connections.form.memoryHint')),
        field(t('connections.form.memoryDays'), days, t('connections.form.memoryDaysHint')),
    ]);
    if (warnsQvinkOverlap(qvinkState(ctx.host.ctx))) {
        box.appendChild(
            el('div', { class: 'nanovia-notice nanovia-notice-warn', text: t('connections.form.memoryQvink') }),
        );
    }
    return box;
}

/** The key select (keys the plugin knows) and the small «add a key» form under it. */
function renderKeyPicker(deps: FormDeps, pluginUp: boolean): HTMLElement {
    const { ctx, form, keys } = deps;
    const t = ctx.t;
    const wrapper = el('div', { class: 'nanovia-keys' });
    if (!pluginUp || keys === null) {
        wrapper.appendChild(field(t('connections.form.key'), chip(t('connections.form.keysUnavailable'), 'muted')));
        return wrapper;
    }
    const options: SelectOption<string>[] = [
        { value: '', label: t('connections.form.keyActive') },
        ...keys.map((key) => ({ value: key.id, label: keyLabel(key, t) })),
    ];
    if (form.keyId && !options.some((option) => option.value === form.keyId)) {
        options.push({ value: form.keyId, label: form.keyId });
    }
    wrapper.appendChild(
        field(
            t('connections.form.key'),
            select({
                value: form.keyId,
                options,
                label: t('connections.form.key'),
                onChange: (value) => void (form.keyId = value),
            }),
            t('connections.form.keyHint'),
        ),
    );

    let keyName = '';
    let keyValue = '';
    const valueInput = textInput({
        value: '',
        type: 'password',
        label: t('connections.key.value'),
        placeholder: t('connections.key.value'),
        onInput: (value) => void (keyValue = value),
    });
    const nameInput = textInput({
        value: '',
        label: t('connections.key.name'),
        placeholder: t('connections.key.name'),
        maxLength: 80,
        onInput: (value) => void (keyName = value),
    });
    const addBox = el('div', { class: 'nanovia-keys-add' }, [
        nameInput,
        valueInput,
        button({
            label: t('connections.key.save'),
            icon: 'key',
            onClick: async () => {
                const value = keyValue;
                const label = keyName.trim() || t('connections.key.add');
                // The value leaves the input and the closure before the request: nothing keeps it afterwards.
                keyValue = '';
                valueInput.value = '';
                if (!value.trim()) return;
                await deps.addKey(label, value);
            },
        }),
        el('div', { class: 'nanovia-field-hint', text: t('connections.key.hint') }),
    ]);
    const details = el('details', { class: 'nanovia-details' }, [
        el('summary', { text: t('connections.key.add') }),
        addBox,
    ]);
    wrapper.appendChild(details);
    return wrapper;
}
