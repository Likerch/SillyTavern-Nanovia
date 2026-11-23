// What a feature receives (docs/ARCHITECTURE.md §5). Features never import app/; the App hands them this object.
import type { Host, PluginClient, ProfilesHost, RequestHooks, SecretsHost } from '../host';
import type { ConnectionsService } from './connections';
import type { Bus, I18n, I18nParams, Logger, PanelApi, SettingsService } from './types';

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
    /** Connection Manager profile host. */
    profiles: ProfilesHost;
    /** Write-only access to ST's secret store, for direct mode. */
    secrets: SecretsHost;
    /** `register(hook)` adds a hook to the fetch wrapper of chat-completion requests. */
    requests: RequestHooks;
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
