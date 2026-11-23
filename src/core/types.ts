// Small types shared by the browser services (core), the UI and the features. Types only.
import type { Logger, Unsubscribe } from '../host/types';
import type { ApiStatus, ConnectionConfig } from '../shared/contracts';

export type { Logger, Unsubscribe };

export type Locale = 'ru' | 'en';
export type Dict = Record<string, string>;

/** One feature's dictionaries; keys are namespaced `<feature>.<key>`. */
export interface I18nParts {
    en: Dict;
    ru: Dict;
}

export type I18nParams = Record<string, string | number>;

export interface I18n {
    register(parts: I18nParts): void;
    locale(): Locale;
    t(key: string, params?: I18nParams): string;
    has(key: string): boolean;
}

/** Events on Nanovia's own bus. */
export interface NanoviaEvents {
    /** The list of connections (or their link state) changed. */
    'connections:changed': { count: number };
    /** The plugin answered (or stopped answering) the last time we asked. */
    'plugin:status': { up: boolean; status: ApiStatus | null };
    /** A setting changed; `key` is the top-level key or '*'. */
    'settings:changed': { key: string };
}

export interface Bus {
    on<K extends keyof NanoviaEvents>(
        event: K,
        handler: (payload: NanoviaEvents[K]) => void | Promise<void>,
    ): Unsubscribe;
    emit<K extends keyof NanoviaEvents>(event: K, payload: NanoviaEvents[K]): Promise<void>;
}

/** Interface preferences and the local bookkeeping of connections. Never a secret. */
export interface NanoviaSettings {
    schemaVersion: number;
    debug: boolean;
    uiLanguage: 'auto' | 'ru' | 'en';
    /** Id of the panel tab that was open last. */
    lastTab: string;
    /** connectionId -> Connection Manager profile id. */
    profiles: Record<string, string>;
    /** connectionId -> id of the ST secret (under api_key_custom) that holds the NanoGPT key of a direct connection. */
    directSecrets: Record<string, string>;
    /** Last known connections: the offline copy, and the only home of direct-mode connections. No keys. */
    mirror: ConnectionConfig[];
    /** Connection ids edited while the plugin did not answer; they are sent on the next refresh. */
    pending: string[];
}

export interface SettingsService {
    get(): NanoviaSettings;
    set<K extends keyof NanoviaSettings>(key: K, value: NanoviaSettings[K]): void;
    /** Mutates the settings in place, then saves and notifies once. */
    update(mutator: (settings: NanoviaSettings) => void, key?: string): void;
    save(): void;
    onChange(listener: (key: string) => void): Unsubscribe;
}

/** A panel tab: `render` fills `root` and may return a cleanup. */
export interface TabDefinition<Ctx = unknown> {
    id: string;
    titleKey: string;
    /** Ascending; ties are broken by id. */
    order: number;
    render(root: HTMLElement, ctx: Ctx): void | (() => void);
}

export interface PanelApi<Ctx = unknown> {
    registerTab(tab: TabDefinition<Ctx>): Unsubscribe;
}
