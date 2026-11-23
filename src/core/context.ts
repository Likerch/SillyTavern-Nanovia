// What a feature receives (docs/ARCHITECTURE.md §5). Features never import app/; the App hands them this object.
import type { Host, PluginClient, ProfilesHost, RequestHooks, SecretsHost } from '../host';
import type { AccountStore } from './account';
import type { CatalogStore } from './catalog';
import type { ConnectionsService } from './connections';
import type { DoctorService } from './doctor';
import type { MgmtStore } from './mgmt';
import type { Bus, I18n, I18nParams, Logger, PanelApi, SettingsService } from './types';
import type { UsageStore } from './usage';

export interface FeatureContext {
    /** The extension's version (package.json). */
    version: string;
    host: Host;
    /** UI preferences and the local bookkeeping of connections; never a secret. */
    settings: SettingsService;
    /** Typed client of the server plugin's admin API; every call resolves to a result, none throws. */
    plugin: PluginClient;
    /** The live list of connections and everything that changes it. */
    connections: ConnectionsService;
    /** The model catalog as the browser knows it (an empty store until it is loaded). */
    catalog: CatalogStore;
    /** Money spent: the plugin's usage log plus the requests this browser saw (stage 0.4). */
    usage: UsageStore;
    /** Balance and subscription quota of the NanoGPT account, read through the plugin (stage 0.4). */
    account: AccountStore;
    /** The checks of the whole setup, with one-click fixes (stage 0.6). */
    doctor: DoctorService;
    /** NanoGPT's Management API through the plugin: the write-only token, managed keys with limits, model presets (stage 0.6). */
    mgmt: MgmtStore;
    /** Connection Manager profile host. */
    profiles: ProfilesHost;
    /** Write-only access to ST's secret store, for direct mode. */
    secrets: SecretsHost;
    /**
     * Adds a hook to the fetch wrapper of chat-completion requests: it receives the parsed body of every request to
     * `/api/backends/chat-completions/generate` and may change it (see host/fetch-hook.ts). Returns the remover.
     */
    registerRequestHook: RequestHooks['register'];
    /** `registerTab({ id, titleKey, order, render(root, ctx) { …; return dispose } })`. */
    panel: PanelApi<FeatureContext>;
    i18n: I18n;
    t(key: string, params?: I18nParams): string;
    bus: Bus;
    log: Logger;
}

/** A panel feature. `init` runs once at start; its return value (if any) runs at stop. */
export interface Feature {
    /** Also listed in `NANOVIA_API.features`. */
    id: string;
    init(ctx: FeatureContext): void | (() => void);
}
