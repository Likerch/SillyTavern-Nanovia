// The «Model presets» section of the Management tab: the presets the Management API holds (a named bundle of a model, a
// system prompt, sampling and reasoning settings that an inference request calls as `presets/<name>`), a form that covers
// every documented setting with its range, duplicate, delete with confirmation, and a "create from connection" action that
// fills model and routing from one of the user's connections.
import type { MgmtDetail } from '../../core/mgmt';
import { PRESET_LIMIT, PRESET_MODEL_MAX_LENGTH, PRESET_PROMPT_MAX_LENGTH } from '../../domain/mgmt';
import type { ModelPreset } from '../../shared/contracts-mgmt';
import { button, chip, clear, el, field, select, textArea, textInput } from '../../ui';
import type { SelectOption } from '../../ui';
import { modelPicker } from '../../ui/model-picker';
import { noticeBox, numberField } from './controls';
import type { Section, SectionDeps } from './controls';
import { groupDigits } from './format';
import type { FormIssue } from './key-form-model';
import {
    CACHE_TTLS,
    PRESET_NUMBER_RULES,
    REASONING_EFFORTS,
    REASONING_SUMMARIES,
    RESPONSE_FORMATS,
    ROUTINGS,
    SERVICE_TIERS,
    VERBOSITIES,
    buildPreset,
    duplicatePresetForm,
    emptyPresetForm,
    presetCreateInput,
    presetFormFromConnection,
    presetFormFromPreset,
} from './preset-form-model';
import type { Optional, PresetFormState, Tri } from './preset-form-model';
import { errorText, gateFor, issueText, presetCard } from './view-model';
import type { Translate } from './view-model';

interface Editor {
    mode: 'create' | 'edit';
    /** The preset being edited (its name stays); null for a new one. */
    original: ModelPreset | null;
    form: PresetFormState;
    /** Text above the form: what a "create from connection" carried over and what it could not. */
    note: string | null;
    issues: FormIssue[];
    /** The answer of the last attempt, shown next to the buttons. */
    error: string | null;
    /** The name field is marked: the name is taken. */
    nameTaken: boolean;
    element: HTMLElement;
}

function fieldLabel(name: string, t: Translate): string {
    if (name === 'name') return t('mgmt.preset.f.name');
    if (name === 'body') return t('mgmt.preset.f.body');
    return t(`mgmt.preset.f.${name}`);
}

function optionalOptions<T extends string>(values: readonly T[], t: Translate): SelectOption<Optional<T>>[] {
    return [{ value: '', label: t('mgmt.opt.unset') }, ...values.map((value) => ({ value, label: value }))];
}

function triOptions(t: Translate): SelectOption<Tri>[] {
    return [
        { value: '', label: t('mgmt.opt.unset') },
        { value: 'on', label: t('mgmt.on') },
        { value: 'off', label: t('mgmt.off') },
    ];
}

export function createPresetsSection(deps: SectionDeps): Section {
    const { ctx, notify } = deps;
    const t = ctx.t;
    let detail: MgmtDetail = ctx.mgmt.detail();
    let editor: Editor | null = null;
    /** The connection chosen for "create from connection". */
    let connectionId = '';

    const newButton = button({
        label: t('mgmt.presets.new'),
        icon: 'plus',
        kind: 'primary',
        onClick: () => openEditor('create', null, emptyPresetForm(), null),
    });
    const fromHost = el('div', { class: 'nanovia-row nanovia-mgmt-from' });
    const body = el('div', { class: 'nanovia-mgmt-body' });
    const root = el('section', { class: 'nanovia-mgmt-section nanovia-mgmt-presets' }, [
        el('div', { class: 'nanovia-row nanovia-mgmt-head' }, [
            el('h4', { class: 'nanovia-mgmt-title', text: t('mgmt.presets.title') }),
            newButton,
        ]),
        el('div', { class: 'nanovia-muted', text: t('mgmt.presets.note', { limit: PRESET_LIMIT }) }),
        fromHost,
        body,
    ]);

    const names = (): string[] => (detail.presets.items ?? []).map((preset) => preset.name);

    /* ---------------------------------------------------------------------------------------------- editor */

    function openEditor(
        mode: Editor['mode'],
        original: ModelPreset | null,
        form: PresetFormState,
        note: string | null,
    ): void {
        editor = { mode, original, form, note, issues: [], error: null, nameTaken: false, element: el('form') };
        drawEditor();
        drawBody();
        editor.element.scrollIntoView?.({ block: 'nearest' });
    }

    function closeEditor(): void {
        editor = null;
        drawBody();
    }

    function drawEditor(): void {
        const state = editor;
        if (!state) return;
        const { form } = state;
        const invalid = (name: string): boolean => state.issues.some((issue) => issue.field === name);

        const nameControl =
            state.mode === 'create'
                ? textInput({
                      value: form.name,
                      label: t('mgmt.preset.f.name'),
                      maxLength: 80,
                      onInput: (value) => void (form.name = value),
                  })
                : el('code', { class: 'nanovia-mgmt-fixedname', text: form.name });
        if (state.mode === 'create' && (invalid('name') || state.nameTaken))
            nameControl.setAttribute('aria-invalid', 'true');

        const counter = el('div', {
            class: 'nanovia-field-hint nanovia-mgmt-counter',
            text: t('mgmt.preset.promptCount', {
                count: groupDigits(form.systemPrompt.length),
                max: groupDigits(PRESET_PROMPT_MAX_LENGTH),
            }),
        });
        const prompt = textArea({
            value: form.systemPrompt,
            rows: 6,
            label: t('mgmt.preset.f.systemPrompt'),
            onInput: (value) => {
                form.systemPrompt = value;
                counter.textContent = t('mgmt.preset.promptCount', {
                    count: groupDigits(value.length),
                    max: groupDigits(PRESET_PROMPT_MAX_LENGTH),
                });
            },
        });
        if (invalid('systemPrompt')) prompt.setAttribute('aria-invalid', 'true');

        function optional<T extends string>(
            key: keyof PresetFormState,
            values: readonly T[],
            hint?: string,
        ): HTMLElement {
            const label = t(`mgmt.preset.f.${key}`);
            const control = select<Optional<T>>({
                value: form[key] as Optional<T>,
                options: optionalOptions(values, t),
                label,
                onChange: (value) => void ((form as unknown as Record<string, string>)[key] = value),
            });
            if (invalid(key)) control.setAttribute('aria-invalid', 'true');
            return field(label, control, hint);
        }

        function tri(key: 'structuredOutputs' | 'thinking' | 'promptCaching', hint?: string): HTMLElement {
            const label = t(`mgmt.preset.f.${key}`);
            return field(
                label,
                select<Tri>({
                    value: form[key],
                    options: triOptions(t),
                    label,
                    onChange: (value) => {
                        form[key] = value;
                        // The budget and the cache lifetime exist only for a thinking / caching that is set.
                        if (key !== 'structuredOutputs') drawEditor();
                    },
                }),
                hint,
            );
        }

        const sampling = PRESET_NUMBER_RULES.map((rule) => {
            const label = t(`mgmt.preset.f.${rule.key}`);
            return field(
                label,
                numberField({
                    value: form.numbers[rule.key],
                    label,
                    invalid: invalid(rule.key),
                    onInput: (value) => void (form.numbers[rule.key] = value),
                }),
                t(rule.integer ? 'mgmt.preset.rangeInt' : 'mgmt.preset.range', {
                    min: groupDigits(rule.min),
                    max: groupDigits(rule.max),
                }),
            );
        });

        const reasoning: HTMLElement[] = [
            optional('reasoningEffort', REASONING_EFFORTS),
            optional('reasoningSummary', REASONING_SUMMARIES),
            optional('verbosity', VERBOSITIES),
            optional('routing', ROUTINGS, t('mgmt.preset.routingHint')),
            optional('serviceTier', SERVICE_TIERS, t('mgmt.preset.tierHint')),
            tri('thinking'),
        ];
        if (form.thinking === 'on') {
            const label = t('mgmt.preset.f.thinkingBudget');
            reasoning.push(
                field(
                    label,
                    numberField({
                        value: form.thinkingBudget,
                        label,
                        invalid: invalid('thinkingBudget'),
                        onInput: (value) => void (form.thinkingBudget = value),
                    }),
                    t('mgmt.preset.rangeInt', { min: 1, max: groupDigits(1_000_000) }),
                ),
            );
        }
        reasoning.push(tri('promptCaching'));
        if (form.promptCaching !== '') {
            reasoning.push(optional('cacheTtl', CACHE_TTLS));
        }

        const group = (title: string, children: (Node | null)[]): HTMLElement =>
            el('fieldset', { class: 'nanovia-mgmt-group' }, [el('legend', { text: title }), ...children]);

        const children: (Node | null)[] = [
            el('h4', {
                class: 'nanovia-form-title',
                text:
                    state.mode === 'create'
                        ? t('mgmt.presets.form.titleNew')
                        : t('mgmt.presets.form.titleEdit', { name: form.name }),
            }),
            state.note ? el('div', { class: 'nanovia-notice nanovia-mgmt-fromnote', text: state.note }) : null,
            group(t('mgmt.preset.group.model'), [
                field(
                    t('mgmt.preset.f.name'),
                    nameControl,
                    state.mode === 'create' ? t('mgmt.preset.nameHint') : t('mgmt.preset.nameFixed'),
                ),
                field(
                    t('mgmt.preset.f.model'),
                    modelPicker({
                        catalog: ctx.catalog,
                        t,
                        value: form.model,
                        label: t('mgmt.preset.f.model'),
                        maxLength: PRESET_MODEL_MAX_LENGTH,
                        onInput: (value) => void (form.model = value),
                    }),
                    t('mgmt.preset.modelHint'),
                ),
                field(t('mgmt.preset.f.systemPrompt'), prompt, undefined),
                counter,
            ]),
            group(t('mgmt.preset.group.sampling'), [
                ...sampling,
                optional('responseFormat', RESPONSE_FORMATS),
                tri('structuredOutputs', t('mgmt.preset.structuredHint')),
            ]),
            group(t('mgmt.preset.group.reasoning'), reasoning),
            el('div', { class: 'nanovia-field-hint', text: t('mgmt.preset.replaceHint') }),
        ];
        if (state.issues.length > 0) {
            children.push(
                el(
                    'ul',
                    { class: 'nanovia-error-text nanovia-mgmt-issues' },
                    state.issues.map((issue) =>
                        el('li', { text: `${fieldLabel(issue.field, t)}: ${issueText(issue, t)}` }),
                    ),
                ),
            );
        }
        if (state.error)
            children.push(el('div', { class: 'nanovia-error-text nanovia-mgmt-formerror', text: state.error }));
        children.push(
            el('div', { class: 'nanovia-row nanovia-form-actions' }, [
                button({ label: t('mgmt.presets.form.save'), icon: 'check', kind: 'primary', onClick: () => submit() }),
                button({ label: t('mgmt.form.cancel'), onClick: () => closeEditor() }),
            ]),
        );
        const next = el(
            'form',
            { class: 'nanovia-form nanovia-mgmt-form', on: { submit: (event) => event.preventDefault() } },
            children,
        );
        state.element.replaceWith(next);
        state.element = next;
    }

    async function submit(): Promise<void> {
        const state = editor;
        if (!state) return;
        state.error = null;
        state.nameTaken = false;
        const built = buildPreset(state.form, { checkName: state.mode === 'create' });
        if (!built.ok) {
            state.issues = built.issues;
            drawEditor();
            return;
        }
        const original = state.original;
        const result =
            state.mode === 'create' || !original
                ? await ctx.mgmt.createPreset(presetCreateInput(built.name, built.input))
                : await ctx.mgmt.replacePreset(original.name, built.input);
        if (!result.ok) {
            state.issues = [];
            state.error = errorText(result.error, t);
            state.nameTaken = result.error.kind === 'preset_exists';
            drawEditor();
            return;
        }
        closeEditor();
        notify(
            'ok',
            t(state.mode === 'create' ? 'mgmt.presets.created' : 'mgmt.presets.saved', { name: result.data.name }),
        );
    }

    async function remove(preset: ModelPreset): Promise<void> {
        const confirmed = await ctx.host.confirm(
            t('mgmt.presets.confirmDelete', { name: preset.name }),
            t('mgmt.presets.confirmDelete.title'),
        );
        if (!confirmed) return;
        const result = await ctx.mgmt.deletePreset(preset.name);
        if (!result.ok) {
            notify('error', errorText(result.error, t));
            return;
        }
        if (editor?.original?.name === preset.name) editor = null;
        notify('ok', t('mgmt.presets.deleted', { name: preset.name }));
    }

    function fromConnection(): void {
        const entry = ctx.connections.get(connectionId) ?? ctx.connections.list()[0] ?? null;
        if (!entry) return;
        const { form, droppedRouting } = presetFormFromConnection(entry.config, names());
        const note = [
            t('mgmt.presets.fromConnection.note', { name: entry.config.name }),
            droppedRouting ? t('mgmt.presets.fromConnection.dropped') : null,
        ]
            .filter((line): line is string => line !== null)
            .join(' ');
        openEditor('create', null, form, note);
    }

    /* ---------------------------------------------------------------------------------------------- drawing */

    function drawFrom(enabled: boolean): void {
        clear(fromHost);
        const entries = ctx.connections.list();
        if (entries.length === 0) return;
        if (!entries.some((entry) => entry.config.id === connectionId)) connectionId = entries[0]?.config.id ?? '';
        fromHost.append(
            select<string>({
                value: connectionId,
                options: entries.map((entry) => ({ value: entry.config.id, label: entry.config.name })),
                label: t('mgmt.presets.fromConnection.pick'),
                disabled: !enabled,
                onChange: (value) => void (connectionId = value),
            }),
            button({
                label: t('mgmt.presets.fromConnection'),
                icon: 'link',
                title: t('mgmt.presets.fromConnection.hint'),
                disabled: !enabled,
                onClick: () => fromConnection(),
            }),
        );
    }

    function drawCard(preset: ModelPreset): HTMLElement {
        const spec = presetCard(preset, t);
        return el('div', { class: 'nanovia-card nanovia-mgmt-presetcard', data: { preset: preset.name } }, [
            el('div', { class: 'nanovia-row' }, [
                el('b', { class: 'nanovia-mgmt-name', text: spec.name }),
                el('code', { class: 'nanovia-muted', text: spec.modelId }),
            ]),
            el('div', {
                class: 'nanovia-muted nanovia-mgmt-model',
                text: t('mgmt.preset.model', { model: spec.model }),
            }),
            spec.chips.length === 0
                ? el('div', { class: 'nanovia-muted', text: t('mgmt.preset.noSettings') })
                : el(
                      'div',
                      { class: 'nanovia-row nanovia-chips' },
                      spec.chips.map((text) => chip(text, 'muted')),
                  ),
            spec.updated ? el('div', { class: 'nanovia-muted', text: spec.updated }) : null,
            el('div', { class: 'nanovia-row' }, [
                button({
                    label: t('mgmt.presets.edit'),
                    icon: 'pen',
                    onClick: () => openEditor('edit', preset, presetFormFromPreset(preset), null),
                }),
                button({
                    label: t('mgmt.presets.duplicate'),
                    icon: 'copy',
                    onClick: () =>
                        openEditor(
                            'create',
                            null,
                            duplicatePresetForm(preset, names()),
                            t('mgmt.presets.duplicate.note', { name: preset.name }),
                        ),
                }),
                button({
                    label: t('mgmt.presets.delete'),
                    icon: 'trash',
                    kind: 'danger',
                    onClick: () => remove(preset),
                }),
            ]),
        ]);
    }

    function drawBody(): void {
        clear(body);
        const gate = gateFor(detail.state, t);
        newButton.disabled = !gate.open;
        drawFrom(gate.open);
        if (!gate.open) {
            editor = null;
            body.appendChild(el('div', { class: 'nanovia-muted nanovia-mgmt-gate', text: gate.text ?? '' }));
            return;
        }
        const list = detail.presets;
        if (list.error) body.appendChild(noticeBox('error', errorText(list.error, t)));
        if (editor && editor.mode === 'create') body.appendChild(editor.element);
        if (list.items === null) {
            if (!list.error) body.appendChild(el('div', { class: 'nanovia-muted', text: t('mgmt.loading') }));
            return;
        }
        if (list.items.length === 0) {
            body.appendChild(el('div', { class: 'nanovia-muted nanovia-empty', text: t('mgmt.presets.empty') }));
            return;
        }
        const cards = el('div', { class: 'nanovia-cards nanovia-mgmt-cards' });
        for (const preset of list.items) {
            if (editor?.mode === 'edit' && editor.original?.name === preset.name) cards.appendChild(editor.element);
            else cards.appendChild(drawCard(preset));
        }
        body.appendChild(cards);
    }

    drawBody();

    return {
        el: root,
        update(next) {
            detail = next;
            const editing = editor?.mode === 'edit' ? editor.original : null;
            const items = detail.presets.items;
            if (editing && items !== null && !items.some((preset) => preset.name === editing.name)) editor = null;
            drawBody();
        },
    };
}
