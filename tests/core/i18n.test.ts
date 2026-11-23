import { describe, expect, it } from 'vitest';
import { createI18n, hostLocale } from '../../src/core/i18n';
import type { Locale } from '../../src/core/types';

describe('Translations', () => {
    function make(locale: Locale) {
        let current = locale;
        const i18n = createI18n(() => current);
        i18n.register({
            en: { 'a.both': 'Both EN', 'a.enOnly': 'English only', 'a.param': 'Port {port} of {name}' },
            ru: { 'a.both': 'Оба RU', 'a.ruOnly': 'Только русский', 'a.param': 'Порт {port} у {name}' },
        });
        return { i18n, setLocale: (value: Locale) => void (current = value) };
    }

    it('answers in the chosen language', () => {
        const { i18n, setLocale } = make('ru');
        expect(i18n.t('a.both')).toBe('Оба RU');
        setLocale('en');
        expect(i18n.t('a.both')).toBe('Both EN');
    });

    it('falls back to the other language, then to the key', () => {
        const { i18n, setLocale } = make('ru');
        expect(i18n.t('a.enOnly')).toBe('English only');
        expect(i18n.t('a.missing')).toBe('a.missing');
        setLocale('en');
        expect(i18n.t('a.ruOnly')).toBe('Только русский');
    });

    it('substitutes params and leaves unknown placeholders alone', () => {
        const { i18n } = make('en');
        expect(i18n.t('a.param', { port: 8787, name: 'plugin' })).toBe('Port 8787 of plugin');
        expect(i18n.t('a.param', { port: 1 })).toBe('Port 1 of {name}');
    });

    it('later registrations add to and override earlier ones', () => {
        const { i18n } = make('en');
        i18n.register({ en: { 'a.both': 'Changed', 'b.new': 'New' }, ru: {} });
        expect(i18n.t('a.both')).toBe('Changed');
        expect(i18n.t('b.new')).toBe('New');
        expect(i18n.has('b.new')).toBe(true);
        expect(i18n.has('nope')).toBe(false);
    });

    it('reports keys missing in the other language', () => {
        const { i18n } = make('en');
        expect(i18n.missingRussian()).toEqual(['a.enOnly']);
        expect(i18n.missingEnglish()).toEqual(['a.ruOnly']);
    });
});

describe('hostLocale', () => {
    it("reads ST's locale: Russian variants give ru, everything else en", () => {
        expect(hostLocale(() => 'ru-ru')).toBe('ru');
        expect(hostLocale(() => 'RU')).toBe('ru');
        expect(hostLocale(() => 'en-us')).toBe('en');
        expect(hostLocale(() => 'de-de')).toBe('en');
    });

    it('treats an unavailable locale as English and never throws', () => {
        expect(hostLocale(() => undefined)).toBe('en');
        expect(
            hostLocale(() => {
                throw new Error('no ST');
            }),
        ).toBe('en');
        expect(hostLocale()).toBe('en');
    });
});
