// Settings in extension_settings.nanovia: interface preferences and the local bookkeeping of connections (profile
// links, direct-secret ids, the mirror of the plugin's list). Never a key or a token. The root object keeps its
// identity so ST's own save picks up every change.
import { isValidConnectionId, normalizeConnection } from '../domain/connection';
import type { ConnectionConfig } from '../shared/contracts';
import { NANOVIA_SETTINGS_KEY } from '../shared/constants';
import type { Logger, NanoviaSettings, SettingsService, Unsubscribe } from './types';

export const SETTINGS_KEY = NANOVIA_SETTINGS_KEY;
export const SETTINGS_SCHEMA_VERSION = 1;

export const UI_LANGUAGES = ['auto', 'ru', 'en'] as const;

export function defaultSettings(): NanoviaSettings {
    return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        debug: false,
        uiLanguage: 'auto',
        lastTab: '',
        profiles: {},
        directSecrets: {},
        mirror: [],
        pending: [],
    };
}

/** One migration step: moves raw stored settings from schema N to N + 1 (mutates in place). */
export type SettingsMigration = (raw: Record<string, unknown>) => void;

/**
 * Migration steps by the schema they start from: `SETTINGS_MIGRATIONS[1]` moves 1 -> 2, and so on. Add a step and bump
 * SETTINGS_SCHEMA_VERSION together. Schema 0 is "no version stored" (first run): nothing to move.
 */
export const SETTINGS_MIGRATIONS: Record<number, SettingsMigration> = {};

function isDict(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A connectionId -> string map with junk entries dropped. */
function idMap(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!isDict(value)) return out;
    for (const [key, item] of Object.entries(value)) {
        if (isValidConnectionId(key) && typeof item === 'string' && item.trim()) out[key] = item;
    }
    return out;
}

function mirrorList(value: unknown, now: number): ConnectionConfig[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: ConnectionConfig[] = [];
    for (const raw of value) {
        const config = normalizeConnection(raw, now);
        if (!config || seen.has(config.id)) continue;
        seen.add(config.id);
        out.push(config);
    }
    return out;
}

function idList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isValidConnectionId))];
}

/**
 * Runs the migration steps from the stored schema up to `target`, then rebuilds the object from known keys only:
 * defaults for missing or wrongly typed values, the mirror re-validated through the connection model. Never throws: a
 * failing step is logged and skipped.
 */
export function migrateSettings(
    raw: unknown,
    log?: Logger,
    migrations: Record<number, SettingsMigration> = SETTINGS_MIGRATIONS,
    target: number = SETTINGS_SCHEMA_VERSION,
    now: number = Date.now(),
): NanoviaSettings {
    const source: Record<string, unknown> = isDict(raw) ? raw : {};
    const stored = typeof source['schemaVersion'] === 'number' ? source['schemaVersion'] : 0;
    let version = stored;
    while (version < target) {
        const step = migrations[version];
        if (step) {
            try {
                step(source);
            } catch (error) {
                log?.error(`settings migration from schema ${version} failed`, error);
            }
        }
        version++;
    }
    const defaults = defaultSettings();
    const language = source['uiLanguage'];
    return {
        schemaVersion: Math.max(target, stored),
        debug: typeof source['debug'] === 'boolean' ? source['debug'] : defaults.debug,
        uiLanguage: language === 'ru' || language === 'en' || language === 'auto' ? language : defaults.uiLanguage,
        lastTab: typeof source['lastTab'] === 'string' ? source['lastTab'] : defaults.lastTab,
        profiles: idMap(source['profiles']),
        directSecrets: idMap(source['directSecrets']),
        mirror: mirrorList(source['mirror'], now),
        pending: idList(source['pending']),
    };
}

export class Settings implements SettingsService {
    private readonly listeners = new Set<(key: string) => void>();
    private root: NanoviaSettings;

    constructor(
        private readonly getStore: () => Record<string, unknown>,
        private readonly persist: () => void,
        private readonly log: Logger,
    ) {
        this.root = this.load();
    }

    /** Re-reads extensionSettings (ST may replace the object after a settings reload). */
    reload(): void {
        this.root = this.load();
    }

    get(): NanoviaSettings {
        return this.root;
    }

    set<K extends keyof NanoviaSettings>(key: K, value: NanoviaSettings[K]): void {
        this.root[key] = value;
        this.save();
        this.notify(key);
    }

    update(mutator: (settings: NanoviaSettings) => void, key = '*'): void {
        mutator(this.root);
        this.save();
        this.notify(key);
    }

    save(): void {
        try {
            this.persist();
        } catch (error) {
            this.log.error('could not save settings', error);
        }
    }

    /** Lifecycle `clean`: drops everything Nanovia stored in settings. */
    reset(): void {
        delete this.getStore()[SETTINGS_KEY];
        this.root = this.load();
        this.save();
        this.notify('*');
    }

    onChange(listener: (key: string) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(key: string): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(key);
            } catch (error) {
                this.log.error('settings listener failed', error);
            }
        }
    }

    private load(): NanoviaSettings {
        const store = this.getStore();
        const root = migrateSettings(store[SETTINGS_KEY], this.log);
        store[SETTINGS_KEY] = root;
        return root;
    }
}
