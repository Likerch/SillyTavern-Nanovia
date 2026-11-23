// The Management tab without the DOM: how the token is described, what the banner and the section gates say, how an
// error is worded, and how a key or a preset reads in a list. Pure functions of their arguments (the clock and the
// translator come in), so they are tested directly; the view files only draw what they return.
import type { MgmtDetail, MgmtState } from '../../core/mgmt';
import type { MgmtError } from '../../host';
import { KEY_LIMIT_KINDS, KEY_LIMIT_PERIODS, PRESET_LIMIT } from '../../domain/mgmt';
import type { KeyLimitKind, KeyLimitPeriod, ManagedKey, MgmtScope, ModelPreset } from '../../shared/contracts-mgmt';
import type { ChipKind } from '../../ui';
import { agoText, endOfDayUtc, formatDate, formatLimit, groupDigits } from './format';
import type { Translate } from './format';
import type { FormIssue } from './key-form-model';

export type { Translate } from './format';

/* ---------------------------------------------------------------------------------------------- the token */

export interface ChipSpec {
    label: string;
    kind: ChipKind;
    title?: string;
}

export type TokenStatusId = 'absent' | 'valid' | 'invalid' | 'unknown';

export interface TokenView {
    id: TokenStatusId;
    chip: ChipSpec;
    /** "Checked 5 min ago"; null when it was never checked. */
    checked: string | null;
    /** Why the token is not in good standing, worded; null when it is. */
    problem: string | null;
}

/** The token chip, the time of the last check, and what is wrong with a token that is not valid. Never the token itself. */
export function tokenView(detail: MgmtDetail, now: number, t: Translate): TokenView {
    const status = detail.status;
    if (!status || !status.present) {
        return { id: 'absent', chip: { label: t('mgmt.token.absent'), kind: 'muted' }, checked: null, problem: null };
    }
    const checked =
        status.checkedAt === null ? null : t('mgmt.token.checked', { when: agoText(status.checkedAt, now, t) });
    if (status.valid === true) {
        return {
            id: 'valid',
            chip: { label: t('mgmt.token.valid'), kind: 'ok', title: t('mgmt.token.valid.hint') },
            checked,
            problem: null,
        };
    }
    if (status.valid === false) {
        return {
            id: 'invalid',
            chip: { label: t('mgmt.token.invalid'), kind: 'error' },
            checked,
            problem: t('mgmt.token.invalid.problem'),
        };
    }
    // Stored but never confirmed (saved while NanoGPT could not be reached, or no call has been made since).
    const why = status.error === null ? null : t(`mgmt.token.why.${status.error}`);
    return {
        id: 'unknown',
        chip: { label: t('mgmt.token.unknown'), kind: 'warn', title: t('mgmt.token.unknown.hint') },
        checked,
        problem: why,
    };
}

/** A token the plugin could not confirm may be stored anyway; one NanoGPT rejected, or a malformed one, never. */
export function offersSaveAnyway(error: MgmtError): boolean {
    return error.kind === 'upstream' || error.kind === 'rate_limited';
}

export interface ScopeGuide {
    scope: MgmtScope;
    /** i18n key of what the scope is for. */
    purposeKey: string;
}

/** The scopes a token needs for what this tab does; `write` includes `read`. `usage:read` is not used by Nanovia. */
export const SCOPE_GUIDE: readonly ScopeGuide[] = [
    { scope: 'api_keys:write', purposeKey: 'mgmt.scope.keys' },
    { scope: 'model_presets:write', purposeKey: 'mgmt.scope.presets' },
];

/* ------------------------------------------------------------------------------------------ gates and banners */

/** Whether the tab's actions work: not while the plugin cannot be reached or does not know Management. */
export function actionsEnabled(state: MgmtState): boolean {
    return state !== 'needs_plugin' && state !== 'plugin_outdated' && state !== 'plugin_down' && state !== 'error';
}

export interface Banner {
    kind: 'error' | 'warn';
    title: string;
    text: string;
}

/** The banner under the head for the states where the tab cannot work at all; null otherwise. */
export function bannerFor(detail: MgmtDetail, t: Translate): Banner | null {
    switch (detail.state) {
        case 'needs_plugin':
            return { kind: 'warn', title: t('mgmt.banner.needsPlugin.title'), text: t('mgmt.banner.needsPlugin') };
        case 'plugin_outdated':
            return { kind: 'warn', title: t('mgmt.banner.outdated.title'), text: t('mgmt.banner.outdated') };
        case 'plugin_down':
            return {
                kind: 'error',
                title: t('mgmt.banner.down.title'),
                text: detail.error ? errorText(detail.error, t) : t('mgmt.error.pluginDown'),
            };
        case 'error':
            return {
                kind: 'error',
                title: t('mgmt.banner.error.title'),
                text: detail.error ? errorText(detail.error, t) : t('mgmt.error.other', { message: '' }),
            };
        default:
            return null;
    }
}

export interface Gate {
    /** The section may show its list and its actions. */
    open: boolean;
    /** Why it may not (or that it is still loading); null when open. */
    text: string | null;
}

/** Whether a section (keys, presets) can be used now, from the state of the whole tab. */
export function gateFor(state: MgmtState, t: Translate): Gate {
    switch (state) {
        case 'ready':
            return { open: true, text: null };
        case 'idle':
            return { open: false, text: t('mgmt.gate.loading') };
        case 'no_token':
            return { open: false, text: t('mgmt.gate.noToken') };
        case 'token_invalid':
            return { open: false, text: t('mgmt.gate.tokenInvalid') };
        default:
            return { open: false, text: t('mgmt.gate.plugin') };
    }
}

/* ------------------------------------------------------------------------------------------------ errors */

/** The `field: problem` part of an invalid_request message, without the lead-in sentence. */
function detailOf(message: string): string {
    const colon = message.indexOf(': ');
    return colon >= 0 ? message.slice(colon + 2) : message;
}

/** One error in the user's language. The plugin's English message is shown only where it carries the detail. */
export function errorText(error: MgmtError, t: Translate): string {
    switch (error.kind) {
        case 'plugin_down':
            return t('mgmt.error.pluginDown');
        case 'not_installed':
            return t('mgmt.error.notInstalled');
        case 'forbidden':
            return t('mgmt.error.forbidden');
        case 'token_missing':
            return t('mgmt.error.tokenMissing');
        case 'token_invalid':
            return t('mgmt.error.tokenInvalid');
        case 'scope_missing':
            return error.scope ? t('mgmt.error.scopeMissing', { scope: error.scope }) : t('mgmt.error.scopeMissingAny');
        case 'token_malformed':
            return t('mgmt.error.tokenMalformed');
        case 'rate_limited':
            return t('mgmt.error.rateLimited');
        case 'invalid_request':
            return t('mgmt.error.invalidRequest', { detail: detailOf(error.message) });
        case 'not_found':
            return t('mgmt.error.notFound');
        case 'preset_exists':
            return t('mgmt.error.presetExists');
        case 'conflict':
            return error.code === 'preset_limit_reached'
                ? t('mgmt.error.presetLimit', { limit: PRESET_LIMIT })
                : t('mgmt.error.conflict', { code: error.code });
        case 'too_large':
            return t('mgmt.error.tooLarge');
        case 'secrets_unavailable':
            return t('mgmt.error.secretsUnavailable');
        case 'secrets_failed':
            return t('mgmt.error.secretsFailed');
        case 'upstream':
            return error.code === 'upstream_timeout' ? t('mgmt.error.upstreamTimeout') : t('mgmt.error.upstream');
        case 'invalid_response':
            return t('mgmt.error.invalidResponse');
        case 'other':
            return t('mgmt.error.other', { message: error.message });
    }
}

/** The fields whose `conflict` has a message of its own. */
const CONFLICT_FIELDS = ['structuredOutputs', 'serviceTier', 'thinkingBudget'];

/** A form problem in the user's language. */
export function issueText(issue: FormIssue, t: Translate): string {
    const params: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(issue.params ?? {})) {
        params[name] = typeof value === 'number' ? groupDigits(value) : value;
    }
    switch (issue.code) {
        case 'conflict':
            return t(`mgmt.issue.conflict.${CONFLICT_FIELDS.includes(issue.field) ? issue.field : 'other'}`);
        case 'length':
            // A system prompt may be empty: only "too long" can be wrong with it.
            return t(issue.field === 'systemPrompt' ? 'mgmt.issue.tooLong' : 'mgmt.issue.length', params);
        default:
            return t(`mgmt.issue.${issue.code}`, params);
    }
}

/* ------------------------------------------------------------------------------------------------ keys */

export interface LimitLine {
    kind: KeyLimitKind;
    /** "USD", "Requests" … */
    label: string;
    /** "$5 / day · $20 / week". */
    text: string;
}

export interface KeyCardSpec {
    id: string;
    name: string;
    status: ChipSpec;
    zdr: ChipSpec | null;
    /** "Expires 2027-01-01 (UTC)", "Expired 2026-02-01 (UTC)" or "No expiry". */
    expiry: string;
    created: string | null;
    /** Only the kinds that have at least one limit set. */
    limits: LimitLine[];
    /** A limit of 0 blocks the key (the API treats 0 as a real limit). */
    blocked: boolean;
}

/** One kind's limits as text: only the periods that are set. Empty when none is. */
export function limitLine(kind: KeyLimitKind, limits: ManagedKey['limits'], t: Translate): LimitLine | null {
    const parts: string[] = [];
    for (const period of KEY_LIMIT_PERIODS) {
        const value = limits[kind][period];
        if (value !== null) parts.push(t(`mgmt.limit.per.${period}`, { value: formatLimit(kind, value) }));
    }
    return parts.length === 0 ? null : { kind, label: t(`mgmt.limit.kind.${kind}`), text: parts.join(' · ') };
}

/** The limits of a key as lines, in a fixed order; `[]` when it is unlimited. */
export function limitLines(limits: ManagedKey['limits'], t: Translate): LimitLine[] {
    const lines: LimitLine[] = [];
    for (const kind of KEY_LIMIT_KINDS) {
        const line = limitLine(kind, limits, t);
        if (line) lines.push(line);
    }
    return lines;
}

function zdrChip(policy: ManagedKey['zdrPolicy'], t: Translate): ChipSpec | null {
    switch (policy) {
        case 'zdr':
            return { label: t('mgmt.zdr.zdr'), kind: 'info', title: t('mgmt.zdr.zdr.hint') };
        case 'off':
            return { label: t('mgmt.zdr.off'), kind: 'muted', title: t('mgmt.zdr.off.hint') };
        case 'unset':
            return { label: t('mgmt.zdr.unset'), kind: 'warn', title: t('mgmt.zdr.unset.hint') };
        default:
            return null;
    }
}

export function expiryText(key: Pick<ManagedKey, 'expiresAt' | 'status'>, now: number, t: Translate): string {
    if (key.expiresAt === null) return t('mgmt.key.noExpiry');
    const date = formatDate(key.expiresAt);
    return key.status === 'expired' || key.expiresAt <= now
        ? t('mgmt.key.expired', { date })
        : t('mgmt.key.expires', { date });
}

/** Whether any limit of the key is 0, which stops the key from working. */
export function isBlocked(limits: ManagedKey['limits']): boolean {
    return KEY_LIMIT_KINDS.some((kind) =>
        KEY_LIMIT_PERIODS.some((period: KeyLimitPeriod) => limits[kind][period] === 0),
    );
}

export function keyCard(key: ManagedKey, now: number, t: Translate): KeyCardSpec {
    const expired = key.status === 'expired' || (key.expiresAt !== null && key.expiresAt <= now);
    return {
        id: key.id,
        name: key.name || t('mgmt.key.unnamed'),
        status: expired
            ? { label: t('mgmt.key.status.expired'), kind: 'error' }
            : { label: t('mgmt.key.status.active'), kind: 'ok' },
        zdr: zdrChip(key.zdrPolicy, t),
        expiry: expiryText(key, now, t),
        created: key.createdAt === null ? null : t('mgmt.key.created', { date: formatDate(key.createdAt) }),
        limits: limitLines(key.limits, t),
        blocked: isBlocked(key.limits),
    };
}

/** The label of the ST secret a created key is stored under (the plugin cuts it at 100 characters). */
export function secretLabel(prefix: string, name: string): string {
    return `${prefix}${name}`.slice(0, 100);
}

/* ------------------------------------------------------------------------------------------------ presets */

export interface PresetCardSpec {
    name: string;
    /** What an inference request calls it: `presets/<name>`. */
    modelId: string;
    model: string;
    /** The settings that are set, as short "label value" chips. */
    chips: string[];
    updated: string | null;
}

function labelled(t: Translate, key: string, value: string | number): string {
    return `${t(`mgmt.preset.f.${key}`)} ${value}`;
}

/** The set settings of a preset as short chips ("Temperature 0.8", "Thinking budget 8 000"). */
export function presetChips(preset: ModelPreset, t: Translate): string[] {
    const chips: string[] = [];
    const numbers: [string, number | null][] = [
        ['maxTokens', preset.maxTokens],
        ['temperature', preset.temperature],
        ['topP', preset.topP],
        ['topK', preset.topK],
        ['minP', preset.minP],
        ['topA', preset.topA],
        ['frequencyPenalty', preset.frequencyPenalty],
        ['presencePenalty', preset.presencePenalty],
        ['repetitionPenalty', preset.repetitionPenalty],
    ];
    for (const [key, value] of numbers) if (value !== null) chips.push(labelled(t, key, groupDigits(value)));
    if (preset.responseFormat) chips.push(labelled(t, 'responseFormat', preset.responseFormat));
    if (preset.structuredOutputs !== null) {
        chips.push(labelled(t, 'structuredOutputs', t(preset.structuredOutputs ? 'mgmt.on' : 'mgmt.off')));
    }
    if (preset.reasoningEffort) chips.push(labelled(t, 'reasoningEffort', preset.reasoningEffort));
    if (preset.reasoningSummary) chips.push(labelled(t, 'reasoningSummary', preset.reasoningSummary));
    if (preset.verbosity) chips.push(labelled(t, 'verbosity', preset.verbosity));
    if (preset.routing) chips.push(labelled(t, 'routing', preset.routing));
    if (preset.serviceTier) chips.push(labelled(t, 'serviceTier', preset.serviceTier));
    if (preset.thinking) {
        const budget = preset.thinking.budgetTokens;
        chips.push(
            preset.thinking.enabled && budget !== null
                ? labelled(t, 'thinkingBudget', groupDigits(budget))
                : labelled(t, 'thinking', t(preset.thinking.enabled ? 'mgmt.on' : 'mgmt.off')),
        );
    }
    if (preset.promptCaching) {
        const ttl = preset.promptCaching.ttl;
        chips.push(
            preset.promptCaching.enabled && ttl
                ? labelled(t, 'promptCaching', ttl)
                : labelled(t, 'promptCaching', t(preset.promptCaching.enabled ? 'mgmt.on' : 'mgmt.off')),
        );
    }
    if (preset.systemPrompt)
        chips.push(t('mgmt.preset.promptChars', { count: groupDigits(preset.systemPrompt.length) }));
    return chips;
}

export function presetCard(preset: ModelPreset, t: Translate): PresetCardSpec {
    return {
        name: preset.name,
        modelId: `presets/${preset.name}`,
        model: preset.model,
        chips: presetChips(preset, t),
        updated: preset.updatedAt === null ? null : t('mgmt.preset.updated', { date: formatDate(preset.updatedAt) }),
    };
}

/** True for a date (`YYYY-MM-DD`) that is today or later in UTC. */
export function isFutureDate(date: string, now: number): boolean {
    const end = endOfDayUtc(date);
    return end !== null && end >= now;
}
