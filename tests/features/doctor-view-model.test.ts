import { describe, expect, it } from 'vitest';
import { BILLING_STRINGS } from '../../src/core/billing-view';
import { createI18n } from '../../src/core/i18n';
import { DOCTOR_CODES, DOCTOR_LEVELS } from '../../src/domain/doctor';
import type { DoctorCheck, DoctorFixAction } from '../../src/domain/doctor';
import { CONNECTIONS_STRINGS } from '../../src/features/connections/strings';
import { KEYS_STRINGS } from '../../src/features/keys/strings';
import { DOCTOR_STRINGS } from '../../src/features/doctor/strings';
import {
    LEVEL_CHIP,
    checkParams,
    checkRow,
    fixFailureText,
    fixLabel,
    groupChecks,
    headline,
    summaryChips,
} from '../../src/features/doctor/view-model';

function translator(locale: 'en' | 'ru', extra: { en: Record<string, string>; ru: Record<string, string> }[] = []) {
    const i18n = createI18n(() => locale);
    i18n.register(DOCTOR_STRINGS);
    for (const parts of extra) i18n.register(parts);
    return { t: i18n.t.bind(i18n), has: i18n.has.bind(i18n) };
}

const en = translator('en', [BILLING_STRINGS, KEYS_STRINGS, CONNECTIONS_STRINGS]);
const ru = translator('ru', [BILLING_STRINGS, KEYS_STRINGS, CONNECTIONS_STRINGS]);

function check(patch: Partial<DoctorCheck> & { code: string }): DoctorCheck {
    return { id: patch.code, level: 'warn', ...patch };
}

describe('strings', () => {
    it('every English key has a Russian one and the other way round', () => {
        expect(Object.keys(DOCTOR_STRINGS.en).filter((key) => !(key in DOCTOR_STRINGS.ru))).toEqual([]);
        expect(Object.keys(DOCTOR_STRINGS.ru).filter((key) => !(key in DOCTOR_STRINGS.en))).toEqual([]);
    });

    it('keeps the same placeholders in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        for (const [key, text] of Object.entries(DOCTOR_STRINGS.en)) {
            expect(placeholders(DOCTOR_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });

    it('has a title and an explanation for every code the domain can emit', () => {
        for (const code of DOCTOR_CODES) {
            for (const part of ['title', 'detail']) {
                const key = `doctor.check.${code}.${part}`;
                expect(DOCTOR_STRINGS.en[key], key).toBeTruthy();
                expect(DOCTOR_STRINGS.ru[key], key).toBeTruthy();
            }
        }
    });

    it('has every key the view builds from a value', () => {
        const actions: DoctorFixAction[] = ['refresh', 'repair-profile', 'open-tab', 'switch-direct', 'check-key'];
        const keys = [
            ...actions.map((action) => `doctor.fix.${action}`),
            'doctor.fix.refreshCatalog',
            ...DOCTOR_LEVELS.flatMap((level) => [
                `doctor.level.${level}`,
                `doctor.group.${level}`,
                `doctor.headline.${level}`,
            ]),
            ...['not_installed', 'unreachable', 'timeout', 'forbidden', 'other'].map((c) => `doctor.reason.${c}`),
            ...['daily', 'weekly'].map((w) => `doctor.window.${w}`),
            ...['missing_target', 'no_panel', 'unexpected', 'unknown'].map((c) => `doctor.fix.error.${c}`),
            'doctor.tab',
            'doctor.run',
            'doctor.running',
            'doctor.hint',
        ];
        const missing = keys.filter((key) => !(key in DOCTOR_STRINGS.en) || !(key in DOCTOR_STRINGS.ru));
        expect(missing).toEqual([]);
    });

    it('does not leave a placeholder open when every parameter is given', () => {
        const filled = (code: string, params: DoctorCheck['params']) => {
            const row = checkRow(check({ code, params }), en.t, en.has);
            return `${row.title} ${row.detail}`;
        };
        expect(filled('plugin_ok', { port: 8787, version: '0.1.0' })).not.toMatch(/\{\w+\}/);
        expect(filled('low_balance', { balance: '0.42', names: 'A, B' })).toContain('$0.42');
    });
});

describe('checkParams', () => {
    it('passes numbers and text through and turns booleans into text', () => {
        expect(
            checkParams(check({ code: 'plugin_ok', params: { port: 8787, version: '0.1', flag: true } }), en.t),
        ).toEqual({
            port: 8787,
            version: '0.1',
            flag: 'true',
        });
        expect(checkParams(check({ code: 'plugin_ok' }), en.t)).toEqual({});
    });

    it('words why the plugin is down, a reason it does not know by its code', () => {
        const reason = (value: string) =>
            checkParams(check({ code: 'plugin_down', params: { reason: value } }), en.t)['reason'];
        expect(reason('not_installed')).toContain('not installed or not enabled');
        expect(reason('timeout')).toBe('The plugin did not answer in time.');
        expect(reason('http_500')).toBe('The plugin sent an unexpected answer (http_500).');
    });

    it('words why the catalog is empty', () => {
        const reason = (value: string) =>
            checkParams(check({ code: 'catalog_empty', params: { reason: value } }), en.t)['reason'];
        expect(reason('')).toBe('It has not been loaded yet.');
        expect(reason('HTTP 502')).toBe('The last load failed: HTTP 502.');
    });

    it('gives a rejected key without a reason a sentence of its own', () => {
        const reason = (value: string) =>
            checkParams(check({ code: 'key_rejected', params: { label: 'A', reason: value } }), en.t)['reason'];
        expect(reason('')).toBe('no reason given');
        expect(reason('HTTP 401')).toBe('HTTP 401');
    });

    it('turns the billing verdict code into the sentence the Routing tab shows', () => {
        const params = (reason: string, fields = '') =>
            checkParams(
                check({ code: 'leaves_subscription', params: { name: 'A', model: 'vendor/model', reason, fields } }),
                en.t,
            )['reason'];
        expect(params('routing.explicit', 'order, sort')).toBe(
            'Explicit routing (provider order, sort) is billed pay as you go with about 5% markup and leaves the subscription.',
        );
        expect(params('model.notIncluded')).toBe(
            'vendor/model is not included in the subscription, so it is billed per token.',
        );
        expect(params('')).toBe('no reason given');
        expect(
            checkParams(
                check({ code: 'leaves_subscription', params: { reason: 'routing.explicit', fields: 'sort' } }),
                ru.t,
            )['reason'],
        ).toContain('Явная маршрутизация (сортировка)');
    });

    it('words the quota window', () => {
        const window = (value: string, translate = en) =>
            checkParams(
                check({ code: 'subscription_quota_high', params: { window: value, percent: 90 } }),
                translate.t,
            )['window'];
        expect(window('daily')).toBe('daily');
        expect(window('weekly', ru)).toBe('за неделю');
    });
});

describe('fixLabel', () => {
    it('says what each fix does', () => {
        expect(fixLabel({ action: 'refresh' }, en.t, en.has)).toBe('Refresh');
        expect(fixLabel({ action: 'refresh', target: 'catalog' }, en.t, en.has)).toBe('Reload the catalog');
        expect(fixLabel({ action: 'repair-profile', target: 'x' }, en.t, en.has)).toBe('Repair the profile');
        expect(fixLabel({ action: 'switch-direct', target: 'x' }, en.t, en.has)).toBe('Switch to direct mode');
        expect(fixLabel({ action: 'check-key', target: 'k' }, en.t, en.has)).toBe('Check the key again');
        expect(fixLabel({ action: 'repair-profile', target: 'x' }, ru.t, ru.has)).toBe('Починить профиль');
    });

    it('names the tab it opens by its title, or by its id when that tab has none', () => {
        expect(fixLabel({ action: 'open-tab', target: 'keys' }, en.t, en.has)).toBe('Open "Keys"');
        expect(fixLabel({ action: 'open-tab', target: 'connections' }, ru.t, ru.has)).toBe('Открыть «Подключения»');
        expect(fixLabel({ action: 'open-tab', target: 'mgmt' }, en.t, en.has)).toBe('Open "mgmt"');
        expect(fixLabel({ action: 'open-tab' }, en.t, en.has)).toBe('Open ""');
    });
});

describe('checkRow', () => {
    it('writes the title and the explanation with the params and carries the fix', () => {
        const row = checkRow(
            check({
                id: 'profile_missing:abc12345',
                code: 'profile_missing',
                params: { name: 'Chat' },
                fix: { action: 'repair-profile', target: 'abc12345' },
            }),
            en.t,
            en.has,
        );
        expect(row).toEqual({
            id: 'profile_missing:abc12345',
            code: 'profile_missing',
            level: 'warn',
            title: 'No Connection Manager profile for "Chat"',
            detail: 'The connection will not show up in SillyTavern’s list of connections until its profile exists.',
            fix: {
                fix: { action: 'repair-profile', target: 'abc12345' },
                label: 'Repair the profile',
            },
        });
    });

    it('has no fix when the check offers none', () => {
        expect(checkRow(check({ code: 'secrets_unavailable' }), en.t, en.has).fix).toBeNull();
    });

    it('shows a code the dictionaries do not know as itself, without an explanation', () => {
        expect(checkRow(check({ code: 'brand_new' }), en.t, en.has)).toMatchObject({ title: 'brand_new', detail: '' });
    });

    it('speaks Russian', () => {
        const row = checkRow(check({ code: 'no_keys', level: 'error' }), ru.t, ru.has);
        expect(row.title).toBe('Нет ключа NanoGPT');
        expect(row.detail).toContain('«Ключи»');
    });
});

describe('groups and the headline', () => {
    const checks: DoctorCheck[] = [
        check({ code: 'plugin_ok', level: 'ok' }),
        check({ code: 'mgmt_token_missing', level: 'info' }),
        check({ code: 'plugin_down', level: 'warn', params: { reason: 'unreachable' } }),
        check({ code: 'no_keys', level: 'error' }),
        check({ code: 'st_version_ok', level: 'ok', params: { version: '1.19.0' } }),
        check({ id: 'key_rejected:b', code: 'key_rejected', level: 'error', params: { label: 'B', reason: '' } }),
    ];

    it('sorts the findings into levels and keeps the order within a level', () => {
        const groups = groupChecks(checks, en.t, en.has);
        expect(groups.error.map((row) => row.id)).toEqual(['no_keys', 'key_rejected:b']);
        expect(groups.warn.map((row) => row.id)).toEqual(['plugin_down']);
        expect(groups.info.map((row) => row.id)).toEqual(['mgmt_token_missing']);
        expect(groups.ok.map((row) => row.id)).toEqual(['plugin_ok', 'st_version_ok']);
        expect(groupChecks([], en.t, en.has)).toEqual({ error: [], warn: [], info: [], ok: [] });
    });

    it('says one sentence about the worst level', () => {
        expect(headline({ ok: 3, info: 1, warn: 1, error: 2 }, en.t)).toBe('Something needs fixing');
        expect(headline({ ok: 3, info: 1, warn: 1, error: 0 }, en.t)).toBe('Worth a look');
        expect(headline({ ok: 3, info: 1, warn: 0, error: 0 }, en.t)).toBe('Nothing is broken; a few notes');
        expect(headline({ ok: 3, info: 0, warn: 0, error: 0 }, en.t)).toBe('Everything looks fine');
        expect(headline({ ok: 0, info: 0, warn: 0, error: 0 }, ru.t)).toBe('Всё в порядке');
    });

    it('counts the levels that have something, worst first', () => {
        expect(summaryChips({ ok: 5, info: 0, warn: 1, error: 2 }, en.t)).toEqual([
            { level: 'error', label: 'Errors: 2' },
            { level: 'warn', label: 'Warnings: 1' },
            { level: 'ok', label: 'In order: 5' },
        ]);
        expect(summaryChips({ ok: 0, info: 0, warn: 0, error: 0 }, en.t)).toEqual([]);
        expect(Object.keys(LEVEL_CHIP).sort()).toEqual([...DOCTOR_LEVELS].sort());
    });
});

describe('fixFailureText', () => {
    it('uses our own sentence for our own codes', () => {
        expect(fixFailureText({ ok: false, code: 'no_panel' }, en.t, en.has)).toBe(
            'The panel cannot be opened from here.',
        );
        expect(fixFailureText({ ok: false, code: 'unexpected', params: { message: 'x' } }, ru.t, ru.has)).toContain(
            'Исправление не удалось',
        );
    });

    it('uses the connections’ sentence for theirs, with the params they came with', () => {
        expect(fixFailureText({ ok: false, code: 'direct_key_required' }, en.t, en.has)).toBe(
            'Enter your NanoGPT key: direct mode needs it once.',
        );
        expect(
            fixFailureText(
                { ok: false, code: 'plugin_error', params: { message: 'disk full', status: 500 } },
                en.t,
                en.has,
            ),
        ).toBe('The plugin refused the request: disk full');
    });

    it('falls back to a general sentence with the code when nobody knows it (or the connections feature is not there)', () => {
        expect(fixFailureText({ ok: false, code: 'brand_new' }, en.t, en.has)).toBe(
            'The fix did not work (brand_new).',
        );
        const alone = translator('en');
        expect(fixFailureText({ ok: false, code: 'direct_key_required' }, alone.t, alone.has)).toBe(
            'The fix did not work (direct_key_required).',
        );
    });
});
