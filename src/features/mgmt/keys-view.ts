// The «Managed API keys» section of the Management tab: the keys NanoGPT lists for the Management token (name, status,
// expiry, a compact summary of the limits, the ZDR policy), an editor for the limits, creation (the plugin puts the new
// key's secret straight into ST's secret store: it is never shown here) and revoking with an explicit confirmation.
// NanoGPT's API shows neither a masked tail nor per-key usage, and the section says so.
import type { MgmtDetail } from '../../core/mgmt';
import { KEY_LIMIT_KINDS, KEY_LIMIT_PERIODS, KEY_NAME_MAX_LENGTH } from '../../domain/mgmt';
import { SECRET_LABEL_PREFIX } from '../../shared/constants';
import type { KeyLimitKind, KeyLimitPeriod, ManagedKey } from '../../shared/contracts-mgmt';
import { button, chip, clear, el, field, select, textInput } from '../../ui';
import type { SelectOption } from '../../ui';
import { dateField, noticeBox, numberField } from './controls';
import type { Section, SectionDeps } from './controls';
import { buildKeyCreate, buildKeyPatch, emptyKeyForm, keyFormFromKey, limitField, limitMax } from './key-form-model';
import type { FormIssue, KeyFormState, ZdrChoice } from './key-form-model';
import { groupDigits } from './format';
import { errorText, gateFor, issueText, keyCard, secretLabel } from './view-model';
import type { Translate } from './view-model';

interface Editor {
    /** The key being edited; null = a new key. */
    key: ManagedKey | null;
    form: KeyFormState;
    issues: FormIssue[];
    /** The answer of the last attempt, shown next to the buttons. */
    error: string | null;
    element: HTMLElement;
}

function fieldLabel(field: string, t: Translate): string {
    if (field === 'name') return t('mgmt.keys.form.name');
    if (field === 'expiry') return t('mgmt.keys.form.expiry');
    if (field === 'zdr') return t('mgmt.keys.form.zdr');
    const cell = /^limits\.(\w+)\.(\w+)$/.exec(field);
    if (cell)
        return t('mgmt.keys.form.cell', { kind: t(`mgmt.limit.kind.${cell[1]}`), period: t(`mgmt.period.${cell[2]}`) });
    return field;
}

function zdrOptions(editing: ManagedKey | null, t: Translate): SelectOption<ZdrChoice>[] {
    const options: SelectOption<ZdrChoice>[] = [
        { value: 'keep', label: t(editing ? 'mgmt.zdr.choice.keep' : 'mgmt.zdr.choice.default') },
        { value: 'zdr', label: t('mgmt.zdr.zdr') },
        { value: 'off', label: t('mgmt.zdr.off') },
    ];
    // A legacy key shows the policy it has; a new key cannot be given it.
    if (editing?.zdrPolicy === 'unset') options.push({ value: 'unset', label: t('mgmt.zdr.unset') });
    return options;
}

export function createKeysSection(deps: SectionDeps): Section {
    const { ctx, notify } = deps;
    const t = ctx.t;
    let detail: MgmtDetail = ctx.mgmt.detail();
    let editor: Editor | null = null;

    const newButton = button({
        label: t('mgmt.keys.new'),
        icon: 'plus',
        kind: 'primary',
        onClick: () => openEditor(null),
    });
    const body = el('div', { class: 'nanovia-mgmt-body' });
    const root = el('section', { class: 'nanovia-mgmt-section nanovia-mgmt-keys' }, [
        el('div', { class: 'nanovia-row nanovia-mgmt-head' }, [
            el('h4', { class: 'nanovia-mgmt-title', text: t('mgmt.keys.title') }),
            newButton,
        ]),
        el('div', { class: 'nanovia-muted', text: t('mgmt.keys.note') }),
        body,
    ]);

    /* ---------------------------------------------------------------------------------------------- editor */

    function openEditor(key: ManagedKey | null): void {
        const form = key ? keyFormFromKey(key) : emptyKeyForm();
        editor = { key, form, issues: [], error: null, element: el('form') };
        drawEditor();
        drawBody();
        editor.element.scrollIntoView?.({ block: 'nearest' });
    }

    function closeEditor(): void {
        editor = null;
        drawBody();
    }

    function limitInput(state: Editor, kind: KeyLimitKind, period: KeyLimitPeriod): HTMLElement {
        const id = limitField(kind, period);
        return numberField({
            value: state.form.limits[kind][period],
            label: fieldLabel(id, t),
            invalid: state.issues.some((issue) => issue.field === id),
            onInput: (value) => void (state.form.limits[kind][period] = value),
        });
    }

    /** Builds the form into `editor.element` (again after a failed attempt, so the messages show; the values live in `form`). */
    function drawEditor(): void {
        const state = editor;
        if (!state) return;
        const { form } = state;
        const invalid = (name: string): boolean => state.issues.some((issue) => issue.field === name);

        const grid = el('table', { class: 'nanovia-table nanovia-mgmt-limits' }, [
            el('thead', {}, [
                el('tr', {}, [
                    el('th'),
                    ...KEY_LIMIT_PERIODS.map((period) => el('th', { text: t(`mgmt.period.${period}`) })),
                ]),
            ]),
            el(
                'tbody',
                {},
                KEY_LIMIT_KINDS.map((kind) =>
                    el('tr', { data: { kind } }, [
                        el('th', { class: 'nanovia-mgmt-kind', text: t(`mgmt.limit.kind.${kind}`) }),
                        ...KEY_LIMIT_PERIODS.map((period) => el('td', {}, [limitInput(state, kind, period)])),
                    ]),
                ),
            ),
        ]);

        const children: (Node | null)[] = [
            el('h4', {
                class: 'nanovia-form-title',
                text: state.key
                    ? t('mgmt.keys.form.titleEdit', { name: state.key.name })
                    : t('mgmt.keys.form.titleNew'),
            }),
            field(
                t('mgmt.keys.form.name'),
                textInput({
                    value: form.name,
                    label: t('mgmt.keys.form.name'),
                    maxLength: KEY_NAME_MAX_LENGTH,
                    onInput: (value) => void (form.name = value),
                }),
                state.key ? undefined : t('mgmt.keys.form.nameHint', { prefix: SECRET_LABEL_PREFIX }),
            ),
            field(
                t('mgmt.keys.form.expiry'),
                dateField({
                    value: form.expiry,
                    label: t('mgmt.keys.form.expiry'),
                    invalid: invalid('expiry'),
                    onInput: (value) => void (form.expiry = value),
                }),
                t('mgmt.keys.form.expiryHint'),
            ),
            field(
                t('mgmt.keys.form.zdr'),
                select<ZdrChoice>({
                    value: form.zdr,
                    options: zdrOptions(state.key, t),
                    label: t('mgmt.keys.form.zdr'),
                    onChange: (value) => void (form.zdr = value),
                }),
                t('mgmt.keys.form.zdrHint'),
            ),
            el('b', { text: t('mgmt.keys.form.limits') }),
            el('div', { class: 'nanovia-table-wrap' }, [grid]),
            el('div', { class: 'nanovia-field-hint', text: t('mgmt.keys.form.limitsHint') }),
            el('div', {
                class: 'nanovia-field-hint',
                text: t('mgmt.keys.form.limitsMax', {
                    daily: groupDigits(limitMax('requests', 'daily')),
                    other: groupDigits(limitMax('inputTokens', 'daily')),
                    usd: groupDigits(limitMax('usd', 'daily')),
                }),
            }),
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
                button({ label: t('mgmt.keys.form.save'), icon: 'check', kind: 'primary', onClick: () => submit() }),
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
        const now = Date.now();
        if (state.key) {
            const built = buildKeyPatch(state.key, state.form, now);
            if (!built.ok) {
                if (built.unchanged) {
                    notify('warn', t('mgmt.keys.unchanged'));
                    return;
                }
                state.issues = built.issues;
                drawEditor();
                return;
            }
            const name = state.key.name;
            const result = await ctx.mgmt.updateKey(state.key.id, built.patch);
            if (!result.ok) {
                state.issues = [];
                state.error = errorText(result.error, t);
                drawEditor();
                return;
            }
            closeEditor();
            notify('ok', t('mgmt.keys.updated', { name: result.data.name || name }));
            return;
        }
        const built = buildKeyCreate(state.form, now);
        if (!built.ok) {
            state.issues = built.issues;
            drawEditor();
            return;
        }
        const result = await ctx.mgmt.createKey(built.input);
        if (!result.ok) {
            state.issues = [];
            state.error = errorText(result.error, t);
            drawEditor();
            return;
        }
        closeEditor();
        // The secret went into ST's secret store; all that is shown is where it is.
        notify('ok', t('mgmt.keys.created', { label: secretLabel(SECRET_LABEL_PREFIX, result.data.key.name) }), {
            label: t('mgmt.keys.openKeys'),
            onClick: () => ctx.panel.open?.('keys'),
        });
    }

    async function revoke(key: ManagedKey): Promise<void> {
        const name = key.name || t('mgmt.key.unnamed');
        const confirmed = await ctx.host.confirm(
            t('mgmt.keys.confirmRevoke', { name }),
            t('mgmt.keys.confirmRevoke.title'),
        );
        if (!confirmed) return;
        const result = await ctx.mgmt.revokeKey(key.id);
        if (!result.ok) {
            notify('error', errorText(result.error, t));
            return;
        }
        if (editor?.key?.id === key.id) editor = null;
        notify('ok', t('mgmt.keys.revoked', { name }));
    }

    /* ---------------------------------------------------------------------------------------------- drawing */

    function drawCard(key: ManagedKey, now: number): HTMLElement {
        const spec = keyCard(key, now, t);
        const limits =
            spec.limits.length === 0
                ? [el('div', { class: 'nanovia-muted', text: t('mgmt.keys.noLimits') })]
                : spec.limits.map((line) =>
                      el('div', { class: 'nanovia-mgmt-limit', data: { kind: line.kind } }, [
                          el('span', { class: 'nanovia-muted', text: `${line.label}: ` }),
                          el('span', { text: line.text }),
                      ]),
                  );
        return el('div', { class: 'nanovia-card nanovia-mgmt-keycard', data: { key: key.id } }, [
            el('div', { class: 'nanovia-row' }, [
                el('b', { class: 'nanovia-mgmt-name', text: spec.name }),
                el('span', { class: 'nanovia-muted', text: `#${spec.id}` }),
            ]),
            el('div', { class: 'nanovia-row nanovia-chips' }, [
                chip(spec.status.label, spec.status.kind),
                spec.zdr ? chip(spec.zdr.label, spec.zdr.kind, spec.zdr.title) : null,
                spec.blocked ? chip(t('mgmt.keys.blocked'), 'warn', t('mgmt.keys.blocked.hint')) : null,
            ]),
            el('div', { class: 'nanovia-muted' }, [spec.expiry, spec.created ? ` · ${spec.created}` : '']),
            el('div', { class: 'nanovia-mgmt-limits-summary' }, limits),
            el('div', { class: 'nanovia-row' }, [
                button({ label: t('mgmt.keys.edit'), icon: 'sliders', onClick: () => openEditor(key) }),
                button({ label: t('mgmt.keys.revoke'), icon: 'ban', kind: 'danger', onClick: () => revoke(key) }),
            ]),
        ]);
    }

    function drawBody(): void {
        clear(body);
        const gate = gateFor(detail.state, t);
        newButton.disabled = !gate.open;
        if (!gate.open) {
            // The tab cannot use keys now; an open editor would only fail. It is dropped, its values with it.
            editor = null;
            body.appendChild(el('div', { class: 'nanovia-muted nanovia-mgmt-gate', text: gate.text ?? '' }));
            return;
        }
        const list = detail.keys;
        if (list.error) {
            body.appendChild(noticeBox('error', errorText(list.error, t)));
        }
        if (editor && !editor.key) body.appendChild(editor.element);
        if (list.items === null) {
            if (!list.error) body.appendChild(el('div', { class: 'nanovia-muted', text: t('mgmt.loading') }));
            return;
        }
        if (list.items.length === 0) {
            body.appendChild(el('div', { class: 'nanovia-muted nanovia-empty', text: t('mgmt.keys.empty') }));
            return;
        }
        const now = Date.now();
        const cards = el('div', { class: 'nanovia-cards nanovia-mgmt-cards' });
        for (const key of list.items) {
            // The key being edited shows its form in place of its card.
            if (editor?.key?.id === key.id) cards.appendChild(editor.element);
            else cards.appendChild(drawCard(key, now));
        }
        body.appendChild(cards);
    }

    drawBody();

    return {
        el: root,
        update(next) {
            detail = next;
            // A key that was revoked elsewhere takes its editor with it.
            const editing = editor?.key;
            const items = detail.keys.items;
            if (editing && items !== null && !items.some((key) => key.id === editing.id)) editor = null;
            drawBody();
        },
    };
}
