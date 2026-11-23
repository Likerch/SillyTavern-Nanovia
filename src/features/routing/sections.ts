// The three sections of the Routing tab (routing, billing, reasoning). A section is built once for the draft it edits:
// its controls write into the draft and call `env.changed()`; `update(data)` then refreshes everything that is derived
// (locked controls, hints, the verdict panel, the preview) without recreating the inputs, so focus and typing survive.
import { billingOutcomeLabel, billingReasonText, planWarningText, strippedLabels } from '../../core/billing-view';
import type { FeatureContext } from '../../core/context';
import { PROVIDER_MARKUP_PERCENT } from '../../shared/constants';
import type {
    BillingMode,
    CatalogModel,
    ConnectionConfig,
    ModelProviders,
    Quantization,
    ReasoningEffort,
    ReasoningPolicy,
    RoutingSort,
} from '../../shared/contracts';
import { button, chip, clear, el, field, select, textInput, toggle } from '../../ui';
import type { Child, SelectOption } from '../../ui';
import { chipListInput } from './chips';
import {
    BILLING_MODES,
    MIN_QUANTIZATIONS,
    QUANTIZATIONS,
    REASONING_POLICIES,
    ROUTING_SORTS,
    capabilityLine,
    describeReasoning,
    effortChoices,
    hasBypassingSettings,
    makeSubscriptionSafe,
    numberText,
    outcomeKind,
    parseNumberInput,
    preferenceNeedsSort,
    providerSuggestions,
    routingIgnored,
    verdictSummaryKey,
} from './view-model';
import type {
    ControlStates,
    PreviewRow,
    ReasoningCaps,
    RoutingDraft,
    RoutingFieldName,
    Translate,
    Verdict,
} from './view-model';

/** Everything derived from the draft, recomputed after every change. */
export interface ViewData {
    config: ConnectionConfig;
    draft: RoutingDraft;
    model: CatalogModel | null;
    providers: ModelProviders | null;
    verdict: Verdict;
    controls: ControlStates;
    caps: ReasoningCaps;
    preview: PreviewRow[];
}

export interface SectionEnv {
    ctx: FeatureContext;
    t: Translate;
    /** The draft this section edits. The same object for the lifetime of the section. */
    draft: RoutingDraft;
    /** The draft changed: derived data is recomputed and every section is updated. */
    changed(): void;
    /** The draft was replaced wholesale (e.g. made subscription-safe): the controls must be built again from it. */
    rebuild(): void;
}

export interface SectionView {
    node: HTMLElement;
    update(data: ViewData): void;
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;

function section(id: string, title: string, children: Child[]): HTMLElement {
    return el('details', { class: 'nanovia-section', attrs: { open: true }, data: { section: id } }, [
        el('summary', { class: 'nanovia-section-title', text: title }),
        ...children,
    ]);
}

function setDisabled(root: HTMLElement, disabled: boolean): void {
    for (const control of root.querySelectorAll<FormControl>('input, select, button')) control.disabled = disabled;
}

function options<T extends string>(values: readonly T[], label: (value: T) => string): SelectOption<T>[] {
    return values.map((value) => ({ value, label: label(value) }));
}

/* ------------------------------------------------------------------------------------------------- routing */

export function buildRoutingSection(env: SectionEnv): SectionView {
    const { t, draft } = env;
    const routing = draft.routing;
    const rows = new Map<RoutingFieldName | 'zdr', HTMLElement>();
    const locks = new Map<RoutingFieldName, HTMLElement>();
    const suggestors: { setSuggestions(ids: readonly string[]): void; read(): readonly string[] }[] = [];

    /** A row of a setting that leaves the subscription: the control, "what leaves the subscription", and the lock reason. */
    function bypassRow(name: RoutingFieldName, control: HTMLElement): HTMLElement {
        const lock = el('div', { class: 'nanovia-field-hint nanovia-lock', attrs: { hidden: true } });
        locks.set(name, lock);
        const row = el('div', { class: 'nanovia-row-block', data: { field: name } }, [
            control,
            el('div', {
                class: 'nanovia-field-hint nanovia-bypass',
                text: t(`routing.bypass.${name}`, { markup: PROVIDER_MARKUP_PERCENT }),
            }),
            lock,
        ]);
        rows.set(name, row);
        return row;
    }

    function idsRow(name: 'order' | 'only' | 'ignore'): HTMLElement {
        const list = chipListInput({
            label: t(`routing.field.${name}`),
            placeholder: t('routing.providers.placeholder'),
            values: routing[name],
            removeLabel: (id) => t('routing.providers.remove', { id }),
            onChange: (values) => {
                routing[name] = values;
                env.changed();
            },
        });
        suggestors.push({ setSuggestions: list.setSuggestions, read: () => routing[name] });
        return bypassRow(name, field(t(`routing.field.${name}`), list.node, t(`routing.field.${name}.hint`)));
    }

    function numberRow(
        name: 'preferredMaxLatency' | 'preferredMinThroughput',
        read: () => number | null,
        write: (value: number | null) => void,
    ): HTMLElement {
        const input = textInput({
            value: numberText(read()),
            label: t(`routing.field.${name}`),
            placeholder: t('routing.field.noLimit'),
            onInput: (value) => {
                const parsed = parseNumberInput(value);
                input.classList.toggle('nanovia-invalid', !parsed.ok);
                if (!parsed.ok) return;
                write(parsed.value);
                env.changed();
            },
        });
        return bypassRow(name, field(t(`routing.field.${name}`), input, t(`routing.field.${name}.hint`)));
    }

    function priceInput(side: 'prompt' | 'completion'): HTMLInputElement {
        const input = textInput({
            value: numberText(routing.maxPrice[side]),
            label: t(`routing.field.maxPrice.${side}`),
            placeholder: t(`routing.field.maxPrice.${side}`),
            onInput: (value) => {
                const parsed = parseNumberInput(value);
                input.classList.toggle('nanovia-invalid', !parsed.ok);
                if (!parsed.ok) return;
                routing.maxPrice[side] = parsed.value;
                env.changed();
            },
        });
        return input;
    }

    function boolRow(
        name: 'allowFallbacks' | 'requireParameters' | 'cachingRoute',
        read: () => boolean,
        write: (value: boolean) => void,
    ): HTMLElement {
        return bypassRow(
            name,
            toggle({
                label: t(`routing.field.${name}`),
                checked: read(),
                hint: t(`routing.field.${name}.hint`),
                onChange: (checked) => {
                    write(checked);
                    env.changed();
                },
            }),
        );
    }

    const enabled = toggle({
        label: t('routing.enabled'),
        checked: routing.enabled,
        hint: t('routing.enabled.hint'),
        onChange: (checked) => {
            routing.enabled = checked;
            env.changed();
        },
    });
    const offNote = el('div', {
        class: 'nanovia-muted nanovia-off-note',
        text: t('routing.offNote'),
        attrs: { hidden: true },
    });
    const lockedNote = el('div', {
        class: 'nanovia-notice nanovia-notice-warn nanovia-locked-note',
        text: t('routing.lockedNote'),
        attrs: { hidden: true },
    });
    const fixedNote = el('div', {
        class: 'nanovia-notice nanovia-notice-warn nanovia-fixed-note',
        text: t('routing.fixedRoute'),
        attrs: { hidden: true },
    });
    const needsSort = el('div', {
        class: 'nanovia-field-hint nanovia-warn-text',
        text: t('routing.needsSortNow'),
        attrs: { hidden: true },
    });

    const quantizationBox = el(
        'div',
        { class: 'nanovia-checks', attrs: { role: 'group', 'aria-label': t('routing.field.quantizations') } },
        QUANTIZATIONS.map((value: Quantization) =>
            toggle({
                label: value,
                checked: routing.quantizations.includes(value),
                onChange: (checked) => {
                    routing.quantizations = checked
                        ? [...routing.quantizations.filter((q) => q !== value), value]
                        : routing.quantizations.filter((q) => q !== value);
                    env.changed();
                },
            }),
        ),
    );

    const minOptions: SelectOption<string>[] = [
        { value: '', label: t('routing.field.minQuantization.none') },
        ...MIN_QUANTIZATIONS.map((value) => ({ value, label: value })),
    ];

    const zdr = el('div', { class: 'nanovia-row-block', data: { field: 'zdr' } }, [
        toggle({
            label: t('routing.field.zdr'),
            checked: routing.zdr,
            hint: t('routing.field.zdr.hint'),
            onChange: (checked) => {
                routing.zdr = checked;
                env.changed();
            },
        }),
        el('div', { class: 'nanovia-field-hint', text: t('routing.field.zdr.keeps') }),
    ]);
    rows.set('zdr', zdr);

    const node = section('routing', t('routing.section.routing'), [
        el('div', { class: 'nanovia-field-hint', text: t('routing.section.routing.hint') }),
        enabled,
        lockedNote,
        offNote,
        fixedNote,
        idsRow('order'),
        idsRow('only'),
        idsRow('ignore'),
        bypassRow(
            'sort',
            field(
                t('routing.field.sort'),
                select({
                    value: routing.sort,
                    options: options<RoutingSort>(ROUTING_SORTS, (value) => t(`routing.sort.${value}`)),
                    label: t('routing.field.sort'),
                    onChange: (value) => {
                        routing.sort = value;
                        env.changed();
                    },
                }),
                t('routing.field.sort.hint'),
            ),
        ),
        bypassRow(
            'quantizations',
            field(t('routing.field.quantizations'), quantizationBox, t('routing.field.quantizations.hint')),
        ),
        bypassRow(
            'minQuantization',
            field(
                t('routing.field.minQuantization'),
                select({
                    value: routing.minQuantization ?? '',
                    options: minOptions,
                    label: t('routing.field.minQuantization'),
                    onChange: (value) => {
                        routing.minQuantization = MIN_QUANTIZATIONS.find((q) => q === value) ?? null;
                        env.changed();
                    },
                }),
                t('routing.field.minQuantization.hint'),
            ),
        ),
        bypassRow(
            'maxPrice',
            field(
                t('routing.field.maxPrice'),
                el('div', { class: 'nanovia-row nanovia-pair' }, [priceInput('prompt'), priceInput('completion')]),
                t('routing.field.maxPrice.hint'),
            ),
        ),
        boolRow(
            'allowFallbacks',
            () => routing.allowFallbacks,
            (value) => void (routing.allowFallbacks = value),
        ),
        boolRow(
            'requireParameters',
            () => routing.requireParameters,
            (value) => void (routing.requireParameters = value),
        ),
        zdr,
        numberRow(
            'preferredMaxLatency',
            () => routing.preferredMaxLatency,
            (value) => void (routing.preferredMaxLatency = value),
        ),
        numberRow(
            'preferredMinThroughput',
            () => routing.preferredMinThroughput,
            (value) => void (routing.preferredMinThroughput = value),
        ),
        needsSort,
        boolRow(
            'cachingRoute',
            () => routing.cachingRoute,
            (value) => void (routing.cachingRoute = value),
        ),
    ]);

    return {
        node,
        update(data) {
            const { controls, verdict } = data;
            for (const [name, row] of rows) {
                const state = controls[name];
                setDisabled(row, state.disabled);
                row.classList.toggle('nanovia-locked', state.disabled);
                if (name !== 'zdr') {
                    const lock = locks.get(name);
                    if (lock) {
                        lock.textContent = state.reason ? t(state.reason) : '';
                        lock.hidden = !state.reason;
                    }
                }
            }
            lockedNote.hidden = draft.billing !== 'subscription';
            offNote.hidden = draft.routing.enabled;
            fixedNote.hidden = !routingIgnored(verdict);
            needsSort.hidden = !(
                draft.routing.enabled &&
                draft.billing !== 'subscription' &&
                preferenceNeedsSort(draft.routing)
            );
            for (const suggestor of suggestors) {
                suggestor.setSuggestions(providerSuggestions(data.providers, suggestor.read()));
            }
        },
    };
}

/* ------------------------------------------------------------------------------------------------- billing */

export function buildBillingSection(env: SectionEnv): SectionView {
    const { t, draft } = env;
    const modeHint = el('div', { class: 'nanovia-field-hint' });
    const panel = el('div', { class: 'nanovia-verdict', attrs: { 'aria-live': 'polite' } });

    const mode = field(
        t('routing.billing.mode'),
        select({
            value: draft.billing,
            options: options<BillingMode>(BILLING_MODES, (value) => t(`routing.billing.${value}`)),
            label: t('routing.billing.mode'),
            onChange: (value) => {
                draft.billing = value;
                env.changed();
            },
        }),
    );
    mode.appendChild(modeHint);

    function drawPanel(data: ViewData): void {
        const { verdict } = data;
        clear(panel);
        const head = el('div', { class: 'nanovia-row nanovia-verdict-head' }, [
            el('b', { text: t('routing.verdict.title') }),
            chip(billingOutcomeLabel(verdict.outcome, t), outcomeKind(verdict.outcome)),
            verdict.markupPercent > 0
                ? chip(t('routing.verdict.markup', { percent: verdict.markupPercent }), 'warn')
                : null,
            verdict.subscriptionSafe ? chip(t('routing.verdict.safe'), 'ok', t('routing.verdict.safe.hint')) : null,
        ]);
        panel.appendChild(head);
        panel.appendChild(el('div', { class: 'nanovia-muted', text: t(verdictSummaryKey(verdict)) }));

        if (verdict.reasons.length > 0) {
            panel.appendChild(
                el(
                    'ul',
                    { class: 'nanovia-reasons' },
                    verdict.reasons.map((reason) => el('li', { text: billingReasonText(reason, t) })),
                ),
            );
        }
        if (verdict.warnings.length > 0) {
            panel.appendChild(
                el(
                    'ul',
                    { class: 'nanovia-warnings' },
                    verdict.warnings.map((warning) => el('li', { text: planWarningText(warning, t) })),
                ),
            );
        }
        if (verdict.stripped.length > 0) {
            panel.appendChild(
                el('div', {
                    class: 'nanovia-stripped',
                    text: t('routing.verdict.stripped', { fields: strippedLabels(verdict.stripped, t).join(', ') }),
                }),
            );
        }
        if (draft.billing !== 'subscription' && hasBypassingSettings(draft)) {
            panel.appendChild(
                el('div', { class: 'nanovia-row' }, [
                    button({
                        label: t('routing.verdict.makeSafe'),
                        title: t('routing.verdict.makeSafe.hint'),
                        icon: 'shield-halved',
                        onClick: () => {
                            Object.assign(draft.routing, makeSubscriptionSafe(data.config, draft, data.model).routing);
                            env.rebuild();
                        },
                    }),
                ]),
            );
        }
    }

    return {
        node: section('billing', t('routing.section.billing'), [
            el('div', { class: 'nanovia-field-hint', text: t('routing.section.billing.hint') }),
            mode,
            panel,
        ]),
        update(data) {
            modeHint.textContent = t(`routing.billing.${draft.billing}.hint`);
            drawPanel(data);
        },
    };
}

/* ------------------------------------------------------------------------------------------------- reasoning */

export function buildReasoningSection(env: SectionEnv): SectionView {
    const { t, draft } = env;
    const reasoning = draft.reasoning;
    const policyHint = el('div', { class: 'nanovia-field-hint' });
    const capsLine = el('div', { class: 'nanovia-muted nanovia-caps' });
    const preview = el('div', {
        class: 'nanovia-preview',
        attrs: { role: 'table', 'aria-label': t('routing.preview.title') },
    });

    const policy = field(
        t('routing.reasoning.policy'),
        select({
            value: reasoning.policy,
            options: options<ReasoningPolicy>(REASONING_POLICIES, (value) => t(`routing.reasoning.${value}`)),
            label: t('routing.reasoning.policy'),
            onChange: (value) => {
                reasoning.policy = value;
                env.changed();
            },
        }),
    );
    policy.appendChild(policyHint);

    // The effort list depends on the model (known only once the catalog is there), so it is refilled when it changes.
    const effortHost = el('div', { class: 'nanovia-effort' });
    let effortSignature = '';
    function drawEffort(caps: ReasoningCaps): void {
        const current = reasoning.effort ?? 'medium';
        const choices = effortChoices(caps, current);
        const signature = `${choices.join(',')}|${current}`;
        effortHost.hidden = reasoning.policy !== 'fixed';
        if (signature === effortSignature) return;
        effortSignature = signature;
        clear(effortHost);
        effortHost.appendChild(
            field(
                t('routing.reasoning.effort'),
                select({
                    value: current,
                    options: options<ReasoningEffort>(choices, (value) => t(`billing.effort.${value}`)),
                    label: t('routing.reasoning.effort'),
                    onChange: (value) => {
                        reasoning.effort = value;
                        env.changed();
                    },
                }),
                t('routing.reasoning.effort.hint'),
            ),
        );
    }

    function drawPreview(rows: PreviewRow[]): void {
        clear(preview);
        preview.appendChild(el('div', { class: 'nanovia-field-hint', text: t('routing.preview.title') }));
        for (const row of rows) {
            preview.appendChild(
                el('div', { class: 'nanovia-preview-row', attrs: { role: 'row' }, data: { scenario: row.id } }, [
                    el('span', { class: 'nanovia-preview-case', text: t(`routing.preview.row.${row.id}`) }),
                    el('code', { class: 'nanovia-preview-result', text: describeReasoning(row.params, t) }),
                    ...row.warnings.map((warning) =>
                        el('div', {
                            class: 'nanovia-field-hint nanovia-preview-warning',
                            text: planWarningText(warning, t),
                        }),
                    ),
                ]),
            );
        }
    }

    return {
        node: section('reasoning', t('routing.section.reasoning'), [
            policy,
            effortHost,
            toggle({
                label: t('routing.reasoning.hide'),
                checked: reasoning.hideThoughts,
                hint: t('routing.reasoning.hide.hint'),
                onChange: (checked) => {
                    reasoning.hideThoughts = checked;
                    env.changed();
                },
            }),
            capsLine,
            preview,
        ]),
        update(data) {
            policyHint.textContent = t(`routing.reasoning.${reasoning.policy}.hint`);
            drawEffort(data.caps);
            capsLine.textContent = capabilityLine(data.caps, t);
            drawPreview(data.preview);
        },
    };
}
