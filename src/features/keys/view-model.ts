// The Keys tab without the DOM: which connections use which key, what a balance check says, why the list could not be
// loaded. Pure functions of their arguments; view.ts draws what they return.
import type { I18nParams } from '../../core/types';
import { isPluginDown } from '../../host';
import type { PluginError } from '../../host';
import type { ConnectionConfig, KeyCheck, KeyInfo } from '../../shared/contracts';

export type Translate = (key: string, params?: I18nParams) => string;

export interface KeyUser {
    name: string;
    /** The connection names no key: it follows the active one, and this key is it. */
    viaActive: boolean;
}

export interface KeyRow {
    key: KeyInfo;
    users: KeyUser[];
}

/**
 * The keys with the connections that use them, the active key first. A direct-mode connection keeps its own key in
 * SillyTavern's secret store and never uses the plugin's keys.
 */
export function keyRows(keys: readonly KeyInfo[], connections: readonly ConnectionConfig[]): KeyRow[] {
    const rows = keys.map((key): KeyRow => {
        const users: KeyUser[] = [];
        for (const connection of connections) {
            if (connection.mode === 'direct') continue;
            if (connection.keyId === key.id) users.push({ name: connection.name, viaActive: false });
            else if (connection.keyId === null && key.active) users.push({ name: connection.name, viaActive: true });
        }
        return { key, users };
    });
    return rows.sort(
        (a, b) =>
            Number(b.key.active) - Number(a.key.active) ||
            a.key.label.localeCompare(b.key.label, undefined, { numeric: true }),
    );
}

/** What a key is called in a sentence: its label, or the masked value when it has none. */
export function keyName(key: Pick<KeyInfo, 'label' | 'masked'>): string {
    return key.label.trim() || key.masked;
}

/** "Used by: Main, Backup (by default)"; null when nothing uses the key. */
export function usersText(users: readonly KeyUser[], t: Translate): string | null {
    if (users.length === 0) return null;
    const names = users.map((user) => (user.viaActive ? t('keys.usedBy.byDefault', { name: user.name }) : user.name));
    return t('keys.usedBy', { names: names.join(', ') });
}

export function confirmDeleteText(row: KeyRow, t: Translate): string {
    const base = t('keys.confirm.delete', { name: keyName(row.key) });
    return row.users.length > 0 ? `${base}\n${t('keys.confirm.deleteUsed', { count: row.users.length })}` : base;
}

export interface CheckLine {
    kind: 'ok' | 'error';
    text: string;
}

/** The result of "check balance" in words. */
export function checkLine(check: KeyCheck, t: Translate): CheckLine {
    if (!check.ok) {
        return { kind: 'error', text: t('keys.check.failed', { reason: check.error ?? t('keys.check.unknown') }) };
    }
    const parts: string[] = [];
    if (check.usdBalance !== null) parts.push(`$${check.usdBalance}`);
    if (check.nanoBalance !== null) parts.push(`${check.nanoBalance} XNO`);
    if (parts.length === 0) return { kind: 'ok', text: t('keys.check.okNoBalance') };
    return { kind: 'ok', text: t('keys.check.ok', { balance: parts.join(' · ') }) };
}

export interface LoadFailure {
    /** The plugin itself is not there (as opposed to refusing this one request). */
    down: boolean;
    text: string;
}

/** Why the list of keys could not be loaded. */
export function loadFailure(error: PluginError, t: Translate): LoadFailure {
    const down = isPluginDown(error) || error.code === 'forbidden';
    const known = ['not_installed', 'unreachable', 'timeout', 'forbidden'];
    if (known.includes(error.code)) return { down, text: t(`keys.down.${error.code}`) };
    return { down, text: t('keys.down.other', { message: error.message }) };
}
