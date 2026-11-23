// The edit/create form of a managed key without the DOM: the state the inputs write into, what a ManagedKey turns into,
// and what the state turns back into (a KeyLimitsPatch with only the changed fields, or a KeyCreateInput). Validation is
// the plugin's own (domain/mgmt.ts sanitize*), so a refusal here is exactly what the plugin would answer; the form only
// adds what the plugin cannot know (an unreadable number, a date in the past) and maps field paths to form fields.
import {
    KEY_LIMIT_KINDS,
    KEY_LIMIT_PERIODS,
    KEY_LIMIT_RANGES,
    KEY_NAME_MAX_LENGTH,
    sanitizeKeyCreateInput,
    sanitizeKeyLimitsPatch,
} from '../../domain/mgmt';
import type { InputIssue, IssueCode } from '../../domain/mgmt';
import type {
    KeyCreateInput,
    KeyLimitKind,
    KeyLimitPeriod,
    KeyLimitsPatch,
    KeyZdrPolicy,
    ManagedKey,
} from '../../shared/contracts-mgmt';
import { endOfDayUtc, formatDate, numberText, parseNumberText } from './format';

/** A form problem: `field` is a form field id (`name`, `expiry`, `zdr`, `limits.usd.daily`), `code` says what is wrong. */
export interface FormIssue {
    field: string;
    /** The first group is the plugin's own; `number` (not a number), `past`, `date` (not a date) and `format` (a name) are the form's. */
    code: IssueCode | 'number' | 'past' | 'date' | 'format';
    params?: Record<string, string | number>;
}

/** `keep`: leave the policy as it is (edit) or let NanoGPT choose (create). */
export type ZdrChoice = 'keep' | KeyZdrPolicy;

export interface KeyFormState {
    name: string;
    /** `YYYY-MM-DD` (UTC, valid until the end of that day); '' = no expiry. */
    expiry: string;
    zdr: ZdrChoice;
    /** What is typed in each limit field; '' = unlimited, '0' blocks the key. */
    limits: Record<KeyLimitKind, Record<KeyLimitPeriod, string>>;
}

export function limitField(kind: KeyLimitKind, period: KeyLimitPeriod): string {
    return `limits.${kind}.${period}`;
}

function blankLimits(): KeyFormState['limits'] {
    const blank = (): Record<KeyLimitPeriod, string> => ({ daily: '', weekly: '', monthly: '' });
    return { requests: blank(), usd: blank(), inputTokens: blank(), subscriptionInputTokens: blank() };
}

export function emptyKeyForm(): KeyFormState {
    return { name: '', expiry: '', zdr: 'keep', limits: blankLimits() };
}

export function keyFormFromKey(key: ManagedKey): KeyFormState {
    const limits = blankLimits();
    for (const kind of KEY_LIMIT_KINDS) {
        for (const period of KEY_LIMIT_PERIODS) limits[kind][period] = numberText(key.limits[kind][period]);
    }
    return {
        name: key.name,
        expiry: key.expiresAt === null ? '' : formatDate(key.expiresAt),
        zdr: key.zdrPolicy ?? 'keep',
        limits,
    };
}

/** The largest value a limit field takes (for hints and messages). */
export function limitMax(kind: KeyLimitKind, period: KeyLimitPeriod): number {
    return KEY_LIMIT_RANGES[kind].max[period];
}

/** Maps a path of the plugin's validation (`expiresAt`, `limits.usd.daily`) to a form field and adds what the text needs. */
function formIssue(raw: InputIssue): FormIssue {
    const field = raw.field === 'expiresAt' ? 'expiry' : raw.field === 'zdrPolicy' ? 'zdr' : raw.field;
    const limit = /^limits\.(\w+)\.(\w+)$/.exec(field);
    const kind = KEY_LIMIT_KINDS.find((item) => item === limit?.[1]);
    const period = KEY_LIMIT_PERIODS.find((item) => item === limit?.[2]);
    const params: Record<string, string | number> = {};
    if (kind && period) {
        params['min'] = 0;
        params['max'] = limitMax(kind, period);
    }
    if (field === 'name') params['max'] = KEY_NAME_MAX_LENGTH;
    return Object.keys(params).length > 0 ? { field, code: raw.code, params } : { field, code: raw.code };
}

interface ParsedLimits {
    values: Partial<Record<KeyLimitKind, Partial<Record<KeyLimitPeriod, number | null>>>>;
    issues: FormIssue[];
}

/** Reads every limit field; a field that is not a number is an issue, an empty one is null (unlimited). */
function parseLimits(form: KeyFormState): ParsedLimits {
    const values: ParsedLimits['values'] = {};
    const issues: FormIssue[] = [];
    for (const kind of KEY_LIMIT_KINDS) {
        for (const period of KEY_LIMIT_PERIODS) {
            const value = parseNumberText(form.limits[kind][period]);
            if (value === undefined) {
                issues.push({ field: limitField(kind, period), code: 'number' });
                continue;
            }
            (values[kind] ??= {})[period] = value;
        }
    }
    return { values, issues };
}

/** The expiry as a moment: null for no expiry, undefined (and an issue) for a date that is not one or is already past. */
function parseExpiry(form: KeyFormState, now: number, issues: FormIssue[]): number | null | undefined {
    if (!form.expiry.trim()) return null;
    const end = endOfDayUtc(form.expiry);
    if (end === null) {
        issues.push({ field: 'expiry', code: 'date' });
        return undefined;
    }
    if (end < now) {
        issues.push({ field: 'expiry', code: 'past' });
        return undefined;
    }
    return end;
}

export type KeyPatchResult =
    | { ok: true; patch: KeyLimitsPatch }
    /** Nothing differs from the key as it is: nothing to send. */
    | { ok: false; unchanged: true; issues: [] }
    | { ok: false; unchanged: false; issues: FormIssue[] };

/**
 * The PATCH for an edited key: only the fields that differ from `original`, the limits per cell (an emptied cell is
 * `null`, which clears the limit). Everything sent has passed the plugin's own checks.
 */
export function buildKeyPatch(original: ManagedKey, form: KeyFormState, now: number): KeyPatchResult {
    const issues: FormIssue[] = [];
    const patch: KeyLimitsPatch = {};

    if (form.name.trim() !== original.name.trim()) patch.name = form.name;

    const originalExpiry = original.expiresAt === null ? '' : formatDate(original.expiresAt);
    if (form.expiry.trim() !== originalExpiry) {
        const expiresAt = parseExpiry(form, now, issues);
        if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    }

    if (form.zdr !== 'keep' && form.zdr !== original.zdrPolicy) patch.zdrPolicy = form.zdr;

    const parsed = parseLimits(form);
    issues.push(...parsed.issues);
    for (const kind of KEY_LIMIT_KINDS) {
        for (const period of KEY_LIMIT_PERIODS) {
            const value = parsed.values[kind]?.[period];
            if (value === undefined || value === original.limits[kind][period]) continue;
            patch.limits ??= {};
            (patch.limits[kind] ??= {})[period] = value;
        }
    }

    if (issues.length > 0) return { ok: false, unchanged: false, issues };
    if (Object.keys(patch).length === 0) return { ok: false, unchanged: true, issues: [] };
    const checked = sanitizeKeyLimitsPatch(patch);
    if (!checked.ok) return { ok: false, unchanged: false, issues: checked.issues.map(formIssue) };
    return { ok: true, patch: checked.value };
}

export type KeyCreateResult = { ok: true; input: KeyCreateInput } | { ok: false; issues: FormIssue[] };

/** The POST body for a new key: the name, and only the limits, expiry and policy that were filled in. */
export function buildKeyCreate(form: KeyFormState, now: number): KeyCreateResult {
    const issues: FormIssue[] = [];
    const input: KeyCreateInput = { name: form.name };

    const expiresAt = parseExpiry(form, now, issues);
    if (typeof expiresAt === 'number') input.expiresAt = expiresAt;

    if (form.zdr === 'zdr' || form.zdr === 'off') input.zdrPolicy = form.zdr;

    const parsed = parseLimits(form);
    issues.push(...parsed.issues);
    for (const kind of KEY_LIMIT_KINDS) {
        for (const period of KEY_LIMIT_PERIODS) {
            const value = parsed.values[kind]?.[period];
            // On create an empty field is simply not sent: a new key is unlimited where nothing is set.
            if (value === undefined || value === null) continue;
            input.limits ??= {};
            (input.limits[kind] ??= {})[period] = value;
        }
    }

    if (issues.length > 0) return { ok: false, issues };
    const checked = sanitizeKeyCreateInput(input);
    if (!checked.ok) return { ok: false, issues: checked.issues.map(formIssue) };
    return { ok: true, input: checked.value };
}
