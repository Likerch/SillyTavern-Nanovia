import type { Dict, I18n, I18nParams, I18nParts, Locale } from './types';

/**
 * Both dictionaries are bundled: every feature registers its parts on init, so the manifest needs no locale files and
 * there is no merge step. Russian is the primary language; a key missing in the chosen language falls back to the other
 * one (English first), and a key missing everywhere shows as itself.
 */
export class Translations implements I18n {
    private readonly en: Dict = {};
    private readonly ru: Dict = {};

    constructor(private readonly resolveLocale: () => Locale) {}

    register(parts: I18nParts): void {
        Object.assign(this.en, parts.en);
        Object.assign(this.ru, parts.ru);
    }

    locale(): Locale {
        return this.resolveLocale();
    }

    t(key: string, params?: I18nParams): string {
        const locale = this.locale();
        const text = (locale === 'ru' ? (this.ru[key] ?? this.en[key]) : (this.en[key] ?? this.ru[key])) ?? key;
        if (!params) return text;
        return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
    }

    has(key: string): boolean {
        return Object.hasOwn(this.en, key) || Object.hasOwn(this.ru, key);
    }

    /** Keys present in English but missing in Russian (used by tests). */
    missingRussian(): string[] {
        return Object.keys(this.en).filter((key) => !Object.hasOwn(this.ru, key));
    }

    /** Keys present in Russian but missing in English (used by tests). */
    missingEnglish(): string[] {
        return Object.keys(this.ru).filter((key) => !Object.hasOwn(this.en, key));
    }
}

/** ST keeps the UI language in `getCurrentLocale()` (and localStorage 'language', e.g. 'ru-ru'). */
export function hostLocale(getLocale?: () => string | undefined): Locale {
    let value: string | undefined;
    try {
        value = getLocale?.() ?? globalThis.localStorage?.getItem('language') ?? undefined;
    } catch {
        value = undefined;
    }
    return value?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function createI18n(resolveLocale: () => Locale): Translations {
    return new Translations(resolveLocale);
}
