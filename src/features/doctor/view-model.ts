// The Diagnostics tab without the DOM: the words of each finding, the grouping by level, the label of a fix and the
// sentence about a fix that failed. Pure functions of their arguments (the translator comes in), so they are tested
// directly; view.ts only draws what they return.
import { billingReasonText } from '../../core/billing-view';
import type { DoctorFixResult } from '../../core/doctor';
import type { I18nParams } from '../../core/types';
import { DOCTOR_LEVELS } from '../../domain/doctor';
import type { DoctorCheck, DoctorFix, DoctorLevel, DoctorSummary } from '../../domain/doctor';
import type { ChipKind } from '../../ui';

export type Translate = (key: string, params?: I18nParams) => string;
/** Whether the dictionaries know a key (a feature that is not installed leaves its keys out). */
export type Has = (key: string) => boolean;

export const LEVEL_CHIP: Readonly<Record<DoctorLevel, ChipKind>> = {
    error: 'error',
    warn: 'warn',
    info: 'info',
    ok: 'ok',
};

export interface FixSpec {
    fix: DoctorFix;
    label: string;
}

export interface CheckRow {
    id: string;
    code: string;
    level: DoctorLevel;
    title: string;
    detail: string;
    fix: FixSpec | null;
}

const PLUGIN_REASONS = ['not_installed', 'unreachable', 'timeout', 'forbidden'];

/** The params of a check as the text wants them: codes turned into words, nothing left as a bare key. */
export function checkParams(check: DoctorCheck, t: Translate): I18nParams {
    const params: I18nParams = {};
    for (const [key, value] of Object.entries(check.params ?? {})) {
        params[key] = typeof value === 'boolean' ? String(value) : value;
    }
    const text = (key: string): string => String(params[key] ?? '');
    switch (check.code) {
        case 'plugin_down': {
            const reason = text('reason');
            params['reason'] = PLUGIN_REASONS.includes(reason)
                ? t(`doctor.reason.${reason}`)
                : t('doctor.reason.other', { code: reason });
            break;
        }
        case 'catalog_empty':
            params['reason'] = text('reason')
                ? t('doctor.catalog.failed', { reason: text('reason') })
                : t('doctor.catalog.notLoaded');
            break;
        case 'key_rejected':
            if (!text('reason')) params['reason'] = t('doctor.noReason');
            break;
        case 'leaves_subscription':
            params['reason'] = text('reason')
                ? billingReasonText(
                      { code: text('reason'), params: { fields: text('fields'), model: text('model') } },
                      t,
                  )
                : t('doctor.noReason');
            break;
        case 'subscription_quota_high':
            params['window'] = t(`doctor.window.${text('window')}`);
            break;
        default:
            break;
    }
    return params;
}

/** What a fix button says: "Refresh", "Repair the profile", "Open "Keys"". */
export function fixLabel(fix: DoctorFix, t: Translate, has: Has): string {
    switch (fix.action) {
        case 'refresh':
            return t(fix.target === 'catalog' ? 'doctor.fix.refreshCatalog' : 'doctor.fix.refresh');
        case 'open-tab': {
            const target = fix.target ?? '';
            // By convention a tab's title is `<feature>.tab`.
            const title = target && has(`${target}.tab`) ? t(`${target}.tab`) : target;
            return t('doctor.fix.open-tab', { tab: title });
        }
        default:
            return t(`doctor.fix.${fix.action}`);
    }
}

/** One finding as a row: title, explanation and the fix button, in the interface language. */
export function checkRow(check: DoctorCheck, t: Translate, has: Has): CheckRow {
    const params = checkParams(check, t);
    const titleKey = `doctor.check.${check.code}.title`;
    const detailKey = `doctor.check.${check.code}.detail`;
    return {
        id: check.id,
        code: check.code,
        level: check.level,
        // A code the dictionaries do not know yet is shown as itself.
        title: has(titleKey) ? t(titleKey, params) : check.code,
        detail: has(detailKey) ? t(detailKey, params) : '',
        fix: check.fix ? { fix: check.fix, label: fixLabel(check.fix, t, has) } : null,
    };
}

export type CheckGroups = Record<DoctorLevel, CheckRow[]>;

/** The findings by level, each group in the order the checks were made. */
export function groupChecks(checks: readonly DoctorCheck[], t: Translate, has: Has): CheckGroups {
    const groups: CheckGroups = { error: [], warn: [], info: [], ok: [] };
    for (const check of checks) groups[check.level].push(checkRow(check, t, has));
    return groups;
}

/** One sentence about the whole result. */
export function headline(summary: DoctorSummary, t: Translate): string {
    for (const level of DOCTOR_LEVELS) {
        if (summary[level] > 0) return t(`doctor.headline.${level}`);
    }
    return t('doctor.headline.ok');
}

export interface SummaryChip {
    level: DoctorLevel;
    label: string;
}

/** "Errors: 2", "Warnings: 1" … for the levels that have something. */
export function summaryChips(summary: DoctorSummary, t: Translate): SummaryChip[] {
    return DOCTOR_LEVELS.filter((level) => summary[level] > 0).map((level) => ({
        level,
        label: `${t(`doctor.group.${level}`)}: ${summary[level]}`,
    }));
}

/** The sentence about a fix that did not work: ours, then the connections' own, then a general one. */
export function fixFailureText(result: Extract<DoctorFixResult, { ok: false }>, t: Translate, has: Has): string {
    const params: I18nParams = { code: result.code, ...(result.params ?? {}) };
    for (const key of [`doctor.fix.error.${result.code}`, `connections.issue.${result.code}`]) {
        if (has(key)) return t(key, params);
    }
    return t('doctor.fix.error.unknown', params);
}
