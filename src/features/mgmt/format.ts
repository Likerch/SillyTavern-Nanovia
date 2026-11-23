// Formatting and parsing for the Management tab: UTC dates (the API's windows and expiry are UTC), limit values, what a
// user typed into a number field, "5 min ago". Pure functions; the translator comes in where words are needed.
import type { I18nParams } from '../../core/types';
import type { KeyLimitKind } from '../../shared/contracts-mgmt';
import { trimZeros } from '../../ui/format';

export type Translate = (key: string, params?: I18nParams) => string;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A non-breaking space, so a grouped number does not wrap in the middle. */
const NBSP = String.fromCharCode(0xa0);

/** `YYYY-MM-DD` of a moment, in UTC. */
export function formatDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

/** The last millisecond of a `YYYY-MM-DD` day in UTC; null for text that is not a real calendar date. */
export function endOfDayUtc(date: string): number | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const moment = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    // Date.UTC rolls 2026-02-31 over to March: a date that does not survive the round trip is not a date.
    if (moment.getUTCFullYear() !== year || moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day) {
        return null;
    }
    return moment.getTime();
}

/** 1500000 -> "1 500 000" (non-breaking spaces; the same in every language). */
export function groupDigits(value: number): string {
    const [whole = '0', fraction] = String(value).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return fraction ? `${grouped}.${fraction}` : grouped;
}

/** A limit as the list shows it: USD as `$5` / `$0.0025`, counts grouped. */
export function formatLimit(kind: KeyLimitKind, value: number): string {
    if (kind === 'usd') return `$${trimZeros(value.toFixed(4))}`;
    return groupDigits(value);
}

/**
 * What a user typed into a number field: '' (or only spaces) = null ("no value"), a decimal number (a comma works as the
 * decimal mark, spaces inside are grouping) = the number, anything else = undefined (not a number).
 */
export function parseNumberText(text: string): number | null | undefined {
    const trimmed = text.trim();
    if (!trimmed) return null;
    // `\s` covers the non-breaking spaces that groupDigits() puts into numbers.
    const compact = trimmed.replace(/\s/g, '').replace(',', '.');
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(compact)) return undefined;
    const value = Number(compact);
    return Number.isFinite(value) ? value : undefined;
}

/** A number as a field shows it (no exponent, no float noise). */
export function numberText(value: number | null): string {
    if (value === null) return '';
    return trimZeros(Number(value.toPrecision(12)).toFixed(10));
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function agoText(at: number, now: number, t: Translate): string {
    const age = Math.max(0, now - at);
    if (age < MINUTE_MS) return t('mgmt.ago.now');
    if (age < HOUR_MS) return t('mgmt.ago.minutes', { count: Math.floor(age / MINUTE_MS) });
    if (age < DAY_MS) return t('mgmt.ago.hours', { count: Math.floor(age / HOUR_MS) });
    return t('mgmt.ago.days', { count: Math.floor(age / DAY_MS) });
}
