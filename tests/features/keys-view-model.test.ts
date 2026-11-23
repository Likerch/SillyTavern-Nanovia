import { describe, expect, it } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import { KEYS_STRINGS } from '../../src/features/keys/strings';
import {
    checkLine,
    confirmDeleteText,
    keyName,
    keyRows,
    loadFailure,
    usersText,
} from '../../src/features/keys/view-model';
import type { KeyInfo } from '../../src/shared/contracts';
import { makeConnection } from '../helpers/plan-fixtures';

const i18n = createI18n(() => 'en');
i18n.register(KEYS_STRINGS);
const t = i18n.t.bind(i18n);

const key = (id: string, label: string, active = false): KeyInfo => ({ id, label, active, masked: `sk-nano-…${id}` });

describe('keyRows', () => {
    it('puts the active key first and lists the connections that use each key', () => {
        const keys = [key('k1', 'Spare'), key('k2', 'Main', true), key('k3', 'Alpha')];
        const connections = [
            makeConnection({ id: 'conn0001', name: 'Chat', keyId: null }),
            makeConnection({ id: 'conn0002', name: 'Background', keyId: 'k1' }),
            makeConnection({ id: 'conn0003', name: 'Other', keyId: 'k1' }),
        ];
        const rows = keyRows(keys, connections);
        expect(rows.map((row) => row.key.id)).toEqual(['k2', 'k3', 'k1']);
        expect(rows[0]?.users).toEqual([{ name: 'Chat', viaActive: true }]);
        expect(rows[1]?.users).toEqual([]);
        expect(rows[2]?.users).toEqual([
            { name: 'Background', viaActive: false },
            { name: 'Other', viaActive: false },
        ]);
    });

    it('ignores direct-mode connections: they keep their own key', () => {
        const rows = keyRows(
            [key('k1', 'Main', true)],
            [
                makeConnection({ mode: 'direct', keyId: null }),
                makeConnection({ id: 'conn0002', name: 'Plug', mode: 'plugin' }),
            ],
        );
        expect(rows[0]?.users).toEqual([{ name: 'Plug', viaActive: true }]);
    });

    it('a connection that names a key that is gone belongs to no row', () => {
        const rows = keyRows([key('k1', 'Main', true)], [makeConnection({ keyId: 'ghost' })]);
        expect(rows[0]?.users).toEqual([]);
    });

    it('sorts the rest by label, numbers in order', () => {
        const rows = keyRows([key('a', 'Key 10'), key('b', 'Key 2'), key('c', 'Key 1')], []);
        expect(rows.map((row) => row.key.label)).toEqual(['Key 1', 'Key 2', 'Key 10']);
    });
});

describe('texts', () => {
    it('names a key by its label, else by its masked value', () => {
        expect(keyName(key('k1', 'Main'))).toBe('Main');
        expect(keyName(key('k1', '  '))).toBe('sk-nano-…k1');
    });

    it('usersText', () => {
        expect(usersText([], t)).toBeNull();
        expect(
            usersText(
                [
                    { name: 'A', viaActive: true },
                    { name: 'B', viaActive: false },
                ],
                t,
            ),
        ).toBe('Used by: A (by default), B');
    });

    it('the delete confirmation warns when connections use the key', () => {
        const row = keyRows([key('k1', 'Main', true)], [makeConnection()])[0]!;
        expect(confirmDeleteText(row, t)).toContain('"Main"');
        expect(confirmDeleteText(row, t)).toContain('1 connection(s) use it');
        expect(confirmDeleteText({ key: row.key, users: [] }, t)).not.toContain('use it');
    });

    it('checkLine: a balance, a balance in XNO, none, a failure', () => {
        expect(checkLine({ ok: true, usdBalance: '1.50', nanoBalance: null, error: null }, t)).toEqual({
            kind: 'ok',
            text: 'Balance: $1.50',
        });
        expect(checkLine({ ok: true, usdBalance: '1.50', nanoBalance: '0.2', error: null }, t).text).toBe(
            'Balance: $1.50 · 0.2 XNO',
        );
        expect(checkLine({ ok: true, usdBalance: null, nanoBalance: null, error: null }, t).text).toContain(
            'did not report a balance',
        );
        expect(checkLine({ ok: false, usdBalance: null, nanoBalance: null, error: 'invalid key' }, t)).toEqual({
            kind: 'error',
            text: 'The check failed: invalid key',
        });
        expect(checkLine({ ok: false, usdBalance: null, nanoBalance: null, error: null }, t).text).toContain(
            'no reason given',
        );
    });

    it('loadFailure tells a missing plugin from a refused request', () => {
        expect(loadFailure({ code: 'not_installed', message: 'x', status: 404 }, t)).toEqual({
            down: true,
            text: expect.stringContaining('not installed') as string,
        });
        expect(loadFailure({ code: 'unreachable', message: 'x', status: null }, t).down).toBe(true);
        expect(loadFailure({ code: 'timeout', message: 'x', status: null }, t).text).toContain('in time');
        expect(loadFailure({ code: 'forbidden', message: 'x', status: 403 }, t).text).toContain('Reload the page');
        const other = loadFailure({ code: 'bad_request', message: 'broken', status: 400 }, t);
        expect(other).toEqual({ down: false, text: 'The keys could not be loaded: broken' });
    });

    it('has every English key in Russian and the other way round', () => {
        expect(i18n.missingRussian()).toEqual([]);
        expect(i18n.missingEnglish()).toEqual([]);
    });
});
