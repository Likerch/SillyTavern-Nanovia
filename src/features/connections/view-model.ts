// The Connections tab without the DOM: form state, validation, the patch the form produces, chips and messages.
// Pure functions of their arguments, so they are tested directly; view.ts only draws what they return.
import type { ConnectionEntry, OpIssue } from '../../core/connections';
import type { I18nParams } from '../../core/types';
import type { PluginError } from '../../host';
import type {
    ApiStatus,
    BillingMode,
    ConnectionConfig,
    ConnectionMode,
    ReasoningEffort,
    ReasoningPolicy,
} from '../../shared/contracts';
import type { ChipKind } from '../../ui';

export type Translate = (key: string, params?: I18nParams) => string;

export const CONNECTION_MODES: readonly ConnectionMode[] = ['auto', 'plugin', 'direct'];
export const BILLING_MODES: readonly BillingMode[] = ['auto', 'subscription', 'paygo'];
export const REASONING_POLICIES: readonly ReasoningPolicy[] = ['follow', 'fixed', 'off', 'default'];
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
];

export interface FormState {
    /** The connection being edited; null for a new one. */
    id: string | null;
    name: string;
    modelId: string;
    mode: ConnectionMode;
    /** Id of a key the plugin knows; '' = the active one. */
    keyId: string;
    billing: BillingMode;
    reasoningPolicy: ReasoningPolicy;
    /** '' until the user picks one (only used by the `fixed` policy). */
    reasoningEffort: ReasoningEffort | '';
    hideThoughts: boolean;
    webSearch: boolean;
    note: string;
    /** The NanoGPT key of a direct connection, typed once. Lives in this object only until the form is saved or closed. */
    directKey: string;
}

export function emptyForm(): FormState {
    return {
        id: null,
        name: '',
        modelId: '',
        mode: 'auto',
        keyId: '',
        billing: 'auto',
        reasoningPolicy: 'follow',
        reasoningEffort: '',
        hideThoughts: false,
        webSearch: false,
        note: '',
        directKey: '',
    };
}

export function formFromConfig(config: ConnectionConfig): FormState {
    return {
        id: config.id,
        name: config.name,
        modelId: config.modelId,
        mode: config.mode,
        keyId: config.keyId ?? '',
        billing: config.billing,
        reasoningPolicy: config.reasoning.policy,
        reasoningEffort: config.reasoning.effort ?? '',
        hideThoughts: config.reasoning.hideThoughts,
        webSearch: config.webSearch,
        note: config.note,
        directKey: '',
    };
}

/** The part of a ConnectionConfig the form controls. Everything else (routing, memory …) is left to be. */
export function patchFromForm(form: FormState): Partial<ConnectionConfig> {
    const patch: Partial<ConnectionConfig> = {
        name: form.name.trim(),
        modelId: form.modelId.trim(),
        mode: form.mode,
        billing: form.billing,
        webSearch: form.webSearch,
        note: form.note,
        reasoning: {
            policy: form.reasoningPolicy,
            effort: form.reasoningPolicy === 'fixed' ? effortOf(form) : null,
            hideThoughts: form.hideThoughts,
        },
    };
    // A direct connection has no plugin key to choose; leave whatever was chosen before.
    if (form.mode !== 'direct') patch.keyId = form.keyId || null;
    return patch;
}

function effortOf(form: FormState): ReasoningEffort {
    return form.reasoningEffort === '' ? 'medium' : form.reasoningEffort;
}

export interface FormContext {
    pluginUp: boolean;
    /** A direct key is already on file for the connection being edited. */
    hasDirectKey: boolean;
}

/** Whether the form must ask for the NanoGPT key (shown as a field and required). */
export function needsDirectKey(form: FormState, ctx: FormContext): boolean {
    if (ctx.hasDirectKey) return false;
    if (form.mode === 'direct') return true;
    return form.mode === 'auto' && !ctx.pluginUp && form.id === null;
}

/** Whether the key field is shown at all (also to replace a key on file). */
export function showsDirectKey(form: FormState, ctx: FormContext): boolean {
    return form.mode === 'direct' || needsDirectKey(form, ctx);
}

export interface FormIssue {
    field: 'name' | 'modelId' | 'directKey';
    code: 'required';
}

export function validateForm(form: FormState, ctx: FormContext): FormIssue[] {
    const issues: FormIssue[] = [];
    if (!form.name.trim()) issues.push({ field: 'name', code: 'required' });
    if (!form.modelId.trim()) issues.push({ field: 'modelId', code: 'required' });
    if (needsDirectKey(form, ctx) && !form.directKey.trim()) issues.push({ field: 'directKey', code: 'required' });
    return issues;
}

export interface ChipSpec {
    label: string;
    kind: ChipKind;
    title?: string;
}

/** The chips of one connection card, in display order. */
export function chipsFor(entry: ConnectionEntry, pluginUp: boolean, t: Translate): ChipSpec[] {
    const chips: ChipSpec[] = [];
    const { config } = entry;
    if (config.mode === 'auto') {
        const key =
            entry.effectiveMode === 'plugin' ? 'connections.chip.mode.autoPlugin' : 'connections.chip.mode.autoDirect';
        chips.push({ label: t(key), kind: 'info' });
    } else {
        chips.push({ label: t(`connections.chip.mode.${config.mode}`), kind: 'info' });
    }
    chips.push({
        label: t(`connections.chip.billing.${config.billing}`),
        kind: config.billing === 'subscription' ? 'ok' : 'muted',
    });

    if (entry.effectiveMode === 'direct' && !entry.hasDirectKey) {
        chips.push({ label: t('connections.chip.noKey'), kind: 'error', title: t('connections.chip.noKey.hint') });
    }
    const profileKind: Record<ConnectionEntry['profileState'], ChipKind> = {
        linked: 'ok',
        drifted: 'warn',
        missing: 'warn',
        none: 'muted',
        blocked: 'warn',
        unavailable: 'error',
    };
    chips.push({
        label: t(`connections.chip.profile.${entry.profileState}`),
        kind: profileKind[entry.profileState],
        title: entry.profileState === 'blocked' ? t('connections.chip.profile.blocked.hint') : undefined,
    });
    if (entry.pending)
        chips.push({ label: t('connections.chip.pending'), kind: 'warn', title: t('connections.chip.pending.hint') });
    if (entry.orphan && pluginUp)
        chips.push({ label: t('connections.chip.orphan'), kind: 'warn', title: t('connections.chip.orphan.hint') });
    return chips;
}

export type ActionId = 'edit' | 'delete' | 'rotate' | 'switchDirect' | 'repairProfile' | 'sendToPlugin';

export interface ActionSpec {
    id: ActionId;
    label: string;
    title?: string;
    kind: 'default' | 'danger';
}

/** The buttons a connection card offers right now. */
export function actionsFor(entry: ConnectionEntry, pluginUp: boolean, t: Translate): ActionSpec[] {
    const actions: ActionSpec[] = [{ id: 'edit', label: t('connections.action.edit'), kind: 'default' }];
    if (pluginUp && entry.view && entry.config.mode !== 'direct') {
        actions.push({
            id: 'rotate',
            label: t('connections.action.rotate'),
            title: t('connections.action.rotate.hint'),
            kind: 'default',
        });
    }
    if (!pluginUp && entry.config.mode !== 'direct') {
        actions.push({
            id: 'switchDirect',
            label: t('connections.action.switchDirect'),
            title: t('connections.action.switchDirect.hint'),
            kind: 'default',
        });
    }
    if (entry.orphan && pluginUp) {
        actions.push({ id: 'sendToPlugin', label: t('connections.action.sendToPlugin'), kind: 'default' });
    }
    if (entry.profileState === 'none' || entry.profileState === 'missing') {
        actions.push({ id: 'repairProfile', label: t('connections.action.repairProfile'), kind: 'default' });
    } else if (entry.profileState === 'drifted') {
        actions.push({ id: 'repairProfile', label: t('connections.action.repairProfile.fix'), kind: 'default' });
    }
    actions.push({ id: 'delete', label: t('connections.action.delete'), kind: 'danger' });
    return actions;
}

export interface BannerSpec {
    /** 'checking' until the plugin has been asked for the first time. */
    state: 'up' | 'down' | 'checking';
    up: boolean;
    title: string;
    detail: string;
    /** Extra paragraph (the proxy warning, or the install hint). */
    advice: string | null;
}

/** What the plugin status chip says. `checked` is false until the plugin has been asked once. */
export function bannerFor(
    status: ApiStatus | null,
    error: PluginError | null,
    pluginUp: boolean,
    t: Translate,
    checked = true,
): BannerSpec {
    if (!checked && !pluginUp) {
        return { state: 'checking', up: false, title: t('connections.status.checking'), detail: '', advice: null };
    }
    if (pluginUp && status) {
        return {
            state: 'up',
            up: true,
            title: t('connections.status.up'),
            detail: t('connections.status.upDetail', { port: status.proxy.port, version: status.version }),
            advice: status.proxy.up ? null : t('connections.status.proxyDown', { port: status.proxy.port }),
        };
    }
    const known = ['not_installed', 'unreachable', 'timeout', 'forbidden'];
    const code = error?.code ?? 'unreachable';
    const reason = known.includes(code)
        ? t(`connections.status.reason.${code}`)
        : t('connections.status.reason.other', { code });
    return {
        state: 'down',
        up: false,
        title: t('connections.status.down'),
        detail: reason,
        advice: t('connections.status.installHint'),
    };
}

/** Text of an operation's error or warning. */
export function issueText(issue: OpIssue, t: Translate): string {
    const params: I18nParams = {};
    for (const [key, value] of Object.entries(issue.params ?? {})) params[key] = value;
    if (issue.code === 'invalid' && typeof params['field'] === 'string') {
        params['field'] = t(`connections.field.${params['field']}`);
    }
    return t(`connections.issue.${issue.code}`, params);
}

/** Label of a select option of a key the plugin knows. */
export function keyLabel(key: { label: string; masked: string; active: boolean }, t: Translate): string {
    const base = key.label ? `${key.label} · ${key.masked}` : key.masked;
    return key.active ? `${base} (${t('connections.form.keyActive')})` : base;
}
