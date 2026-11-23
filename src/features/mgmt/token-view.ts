// The token card of the «Management» tab. The token is write-only: it is typed into a password field, goes to the plugin
// once and is never shown again, not even in part. The field is the only place the value lives; it is cleared when the plugin
// took the token or when NanoGPT refused it, and kept only when the call could not decide (NanoGPT unreachable, a rate limit,
// the plugin not answering), so that "save anyway" or a retry does not need a second paste.
import type { MgmtDetail } from '../../core/mgmt';
import { isMgmtPluginDown } from '../../host';
import type { MgmtError } from '../../host';
import { checkMgmtToken } from '../../domain/mgmt';
import type { MgmtTokenIssue } from '../../domain/mgmt';
import { MGMT_TOKEN_PREFIX } from '../../shared/constants';
import { button, chip, clear, el, textInput } from '../../ui';
import type { Section, SectionDeps } from './controls';
import { SCOPE_GUIDE, actionsEnabled, errorText, offersSaveAnyway, tokenView } from './view-model';

const SHAPE_KEYS: Record<MgmtTokenIssue, string> = {
    not_string: 'mgmt.token.shape.empty',
    empty: 'mgmt.token.shape.empty',
    inference_key: 'mgmt.token.shape.inferenceKey',
    prefix: 'mgmt.token.shape.prefix',
    too_short: 'mgmt.token.shape.tooShort',
    too_long: 'mgmt.token.shape.tooLong',
    characters: 'mgmt.token.shape.characters',
};

/** Whether a failed save leaves the typed token in the field: when the call could not decide, a retry should not need a paste. */
function keepsToken(error: MgmtError): boolean {
    return offersSaveAnyway(error) || isMgmtPluginDown(error);
}

export function createTokenSection(deps: SectionDeps): Section {
    const { ctx, notify } = deps;
    const t = ctx.t;
    let detail: MgmtDetail = ctx.mgmt.detail();

    const statusHost = el('div', { class: 'nanovia-mgmt-tokenstatus' });
    const anywayHost = el('div', {
        class: 'nanovia-notice nanovia-notice-warn nanovia-mgmt-anyway',
        attrs: { hidden: true },
    });

    const input = textInput({
        value: '',
        type: 'password',
        label: t('mgmt.token.input'),
        placeholder: `${MGMT_TOKEN_PREFIX}…`,
        // A new value is a new question: the offer to store the old one anyway no longer applies.
        onInput: () => hideAnyway(),
    });

    function hideAnyway(): void {
        anywayHost.hidden = true;
        clear(anywayHost);
    }

    /** Sends what is in the field. The plugin checks it with NanoGPT; `force` stores it without that check. */
    async function save(force: boolean): Promise<void> {
        const value = input.value;
        hideAnyway();
        if (!force) {
            const shape = checkMgmtToken(value);
            if (!shape.ok) {
                input.value = '';
                notify('error', t(SHAPE_KEYS[shape.issue]));
                return;
            }
        }
        const result = await ctx.mgmt.saveToken(value, force ? { force: true } : undefined);
        if (result.ok) {
            input.value = '';
            notify(
                result.data.valid === true ? 'ok' : 'warn',
                result.data.valid === true ? t('mgmt.token.saved') : t('mgmt.token.savedUnverified'),
            );
            return;
        }
        if (!keepsToken(result.error)) input.value = '';
        notify('error', errorText(result.error, t));
        if (offersSaveAnyway(result.error)) {
            anywayHost.append(
                el('div', { text: t('mgmt.token.anyway.text') }),
                button({
                    label: t('mgmt.token.anyway.button'),
                    icon: 'triangle-exclamation',
                    onClick: () => save(true),
                }),
            );
            anywayHost.hidden = false;
        }
    }

    async function remove(): Promise<void> {
        const confirmed = await ctx.host.confirm(t('mgmt.token.confirmDelete'), t('mgmt.token.confirmDelete.title'));
        if (!confirmed) return;
        const result = await ctx.mgmt.deleteToken();
        if (result.ok) {
            hideAnyway();
            notify('ok', t('mgmt.token.deleted'));
        } else notify('error', errorText(result.error, t));
    }

    const saveButton = button({
        label: t('mgmt.token.save'),
        icon: 'key',
        kind: 'primary',
        onClick: () => save(false),
    });
    const deleteButton = button({ label: t('mgmt.token.delete'), icon: 'trash', kind: 'danger', onClick: remove });
    const checkButton = button({
        label: t('mgmt.token.check'),
        icon: 'rotate',
        kind: 'ghost',
        title: t('mgmt.token.check.hint'),
        onClick: async () => {
            await ctx.mgmt.refreshStatus({ verify: true });
            const after = ctx.mgmt.detail();
            if (after.error) notify('error', errorText(after.error, t));
            else if (after.status?.valid === true) notify('ok', t('mgmt.token.check.valid'));
            else if (after.status?.valid === false) notify('error', t('mgmt.token.check.invalid'));
            else notify('warn', t('mgmt.token.check.unknown'));
        },
    });

    const guide = el('details', { class: 'nanovia-details nanovia-mgmt-guide' }, [
        el('summary', { text: t('mgmt.guide.title') }),
        el('ol', { class: 'nanovia-mgmt-steps' }, [
            el('li', { text: t('mgmt.guide.step1') }),
            el('li', { text: t('mgmt.guide.step2', { prefix: MGMT_TOKEN_PREFIX }) }),
            el('li', { text: t('mgmt.guide.step3') }),
        ]),
        el('div', { class: 'nanovia-muted', text: t('mgmt.guide.scopes') }),
        el(
            'ul',
            { class: 'nanovia-mgmt-scopes' },
            SCOPE_GUIDE.map((item) => el('li', {}, [el('code', { text: item.scope }), ` ${t(item.purposeKey)}`])),
        ),
        el('div', { class: 'nanovia-muted', text: t('mgmt.guide.expiry') }),
        el('div', { class: 'nanovia-muted', text: t('mgmt.guide.privacy') }),
    ]);

    const root = el('section', { class: 'nanovia-mgmt-section nanovia-mgmt-token' }, [
        el('h4', { class: 'nanovia-mgmt-title', text: t('mgmt.token.title') }),
        statusHost,
        el('form', { class: 'nanovia-mgmt-tokenform', on: { submit: (event) => event.preventDefault() } }, [
            input,
            el('div', { class: 'nanovia-row' }, [saveButton, deleteButton]),
        ]),
        anywayHost,
        el('div', { class: 'nanovia-field-hint', text: t('mgmt.token.hint') }),
        guide,
    ]);

    function draw(): void {
        const view = tokenView(detail, Date.now(), t);
        const enabled = actionsEnabled(detail.state);
        clear(statusHost);
        statusHost.appendChild(
            el('div', { class: 'nanovia-row' }, [
                chip(view.chip.label, view.chip.kind, view.chip.title),
                view.checked ? el('span', { class: 'nanovia-muted', text: view.checked }) : null,
                view.id === 'absent' ? null : checkButton,
            ]),
        );
        if (view.problem) statusHost.appendChild(el('div', { class: 'nanovia-error-text', text: view.problem }));
        const present = detail.status?.present === true;
        input.disabled = !enabled;
        saveButton.disabled = !enabled;
        checkButton.disabled = !enabled;
        deleteButton.hidden = !present;
        deleteButton.disabled = !enabled;
        // Once the status is known, the guide starts open for someone with no token (it is what they need) and closed
        // for someone who has one; after that it is the user's to open and close.
        if (!guideSet && detail.status !== null) {
            guideSet = true;
            guide.open = !present;
        }
    }

    let guideSet = false;
    draw();

    return {
        el: root,
        update(next) {
            detail = next;
            draw();
        },
    };
}
