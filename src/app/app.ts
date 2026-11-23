// Builds the App: host doors, core services, the panel, the features and the public API. The only place that knows
// every layer.
import { version as packageVersion } from '../../package.json';
import { createAccountStore } from '../core/account';
import type { AccountStore } from '../core/account';
import { createBus } from '../core/bus';
import { createConnectionsService } from '../core/connections';
import type { ConnectionsService } from '../core/connections';
import { createBrowserCatalogStore } from '../core/catalog-store';
import { createDoctorService } from '../core/doctor';
import type { Feature, FeatureContext } from '../core/context';
import { createI18n, hostLocale } from '../core/i18n';
import { ConsoleLogger, createLogger } from '../core/logger';
import { createMgmtStore } from '../core/mgmt';
import { Settings } from '../core/settings';
import type { Unsubscribe } from '../core/types';
import { createUsageStore } from '../core/usage';
import type { UsageStore } from '../core/usage';
import { FEATURES } from '../features';
import {
    createHost,
    createPluginAccount,
    createPluginClient,
    createPluginMgmt,
    createProfilesHost,
    createDirectMode,
    createSecretsHost,
    installFetchHook,
    proxyHintsHook,
} from '../host';
import { SettingsPanel, UI_STRINGS, generalTab, setButtonErrorHandler } from '../ui';
import { createApiPublisher } from './api';
import type { ApiPublisher } from './api';

export const NANOVIA_VERSION: string = packageVersion;

export interface Runtime {
    ctx: FeatureContext;
    settings: Settings;
    connections: ConnectionsService;
    usage: UsageStore;
    account: AccountStore;
    panel: SettingsPanel<FeatureContext>;
    api: ApiPublisher;
    stop(): Promise<void>;
}

export interface StartOptions {
    /** Replaced in tests; defaults to the registry of features/index.ts. */
    features?: Feature[];
    /** Skip the first ask of the plugin (tests drive `connections.refresh()` themselves). */
    skipInitialRefresh?: boolean;
}

export async function startNanovia(options: StartOptions = {}): Promise<Runtime> {
    const features = options.features ?? FEATURES;
    const log = createLogger();
    const host = createHost(log.scope('host'));
    const settings = new Settings(
        () => host.ctx().extensionSettings,
        () => host.ctx().saveSettingsDebounced(),
        log.scope('settings'),
    );
    ConsoleLogger.setLevel(settings.get().debug ? 'debug' : 'info');
    setButtonErrorHandler((error) => log.scope('ui').error('a button handler failed', error));

    const i18n = createI18n(() => {
        const choice = settings.get().uiLanguage;
        if (choice === 'ru' || choice === 'en') return choice;
        return hostLocale(() => host.locale());
    });
    i18n.register(UI_STRINGS);

    const bus = createBus(log.scope('bus'));
    const requests = installFetchHook(log.scope('request'));
    requests.register(proxyHintsHook);

    const plugin = createPluginClient({ ctx: host.ctx, log: log.scope('plugin') });
    const profiles = createProfilesHost({ ctx: host.ctx, events: host.events, log: log.scope('profiles') });
    const secrets = createSecretsHost({
        ctx: host.ctx,
        log: log.scope('secrets'),
        // ST's own secret list (secrets.js) learns of the change; a failed import only leaves it stale until reload.
        afterChange: async () => {
            const module = await host.modules.secrets();
            const read = module['readSecretState'];
            if (typeof read === 'function') await (read as () => Promise<void>)();
        },
    });
    const connections = createConnectionsService({
        settings,
        plugin,
        profiles,
        secrets,
        bus,
        log: log.scope('connections'),
    });

    const catalog = createBrowserCatalogStore({ plugin, bus, log: log.scope('catalog') });

    // Money and the account (stage 0.4): both read the plugin through the same typed calls.
    const pluginAccount = createPluginAccount({ client: plugin });
    const usage = createUsageStore({ bus, account: pluginAccount, connections, log: log.scope('usage') });
    const account = createAccountStore({ account: pluginAccount, connections, log: log.scope('account') });

    // The Management API (stage 0.6): the token is write-only, the plugin makes every call.
    const mgmt = createMgmtStore({
        mgmt: createPluginMgmt({ client: plugin }),
        connections,
        log: log.scope('mgmt'),
    });

    // The panel hands the context to its tabs lazily and the context carries the panel: fill it in after both exist.
    const ctx = {} as FeatureContext;
    const panel = new SettingsPanel<FeatureContext>({
        i18n,
        log: log.scope('panel'),
        ctx: () => ctx,
        getLastTab: () => settings.get().lastTab,
        setLastTab: (id) => settings.set('lastTab', id),
    });
    // The Doctor reads everything above; the catalog comes through the context, which is told about it later.
    const doctor = createDoctorService({
        connections,
        plugin,
        profiles,
        account,
        catalog: () => ctx.catalog,
        panel: () => panel,
        host,
        // Known only once the plugin has answered about the token; before that the check is skipped, not guessed.
        mgmtToken: () => {
            mgmt.warm();
            return mgmt.detail().status?.present ?? null;
        },
        log: log.scope('doctor'),
    });
    Object.assign(ctx, {
        version: NANOVIA_VERSION,
        host,
        settings,
        plugin,
        connections,
        catalog,
        usage,
        account,
        doctor,
        mgmt,
        profiles,
        secrets,
        registerRequestHook: (hook) => requests.register(hook),
        panel,
        i18n,
        t: i18n.t.bind(i18n),
        bus,
        log,
    } satisfies FeatureContext);

    // Direct mode: plans requests of direct connections and watches their usage. It reads the catalog through ctx, so a
    // catalog that is wired in later is picked up without changes here.
    const directMode = createDirectMode({
        connections: () =>
            connections.list().map((entry) => ({ config: entry.config, effectiveMode: entry.effectiveMode })),
        directSecrets: () => settings.get().directSecrets,
        model: (id) => ctx.catalog.model(id),
        providers: (id) => ctx.catalog.providers(id),
        emit: (record) => void bus.emit('usage:record', { record }),
        log: log.scope('direct'),
    });
    const owned: Unsubscribe[] = [
        () => usage.dispose(),
        requests.register(directMode.hook),
        requests.observe(directMode.observer),
    ];
    owned.push(panel.registerTab(generalTab<FeatureContext>({ settings, i18n, version: NANOVIA_VERSION })));

    const running: Feature[] = [];
    for (const feature of features) {
        try {
            const dispose = feature.init(ctx);
            running.push(feature);
            if (typeof dispose === 'function') owned.push(dispose);
        } catch (error) {
            log.error(`feature "${feature.id}" failed to start`, error);
        }
    }

    // The Extensions panel is part of ST's static page, but stay safe: retry once ST says it is ready.
    if (!panel.mount()) owned.push(host.events.on('APP_READY', () => void panel.mount()));

    owned.push(
        settings.onChange((key) => {
            if (key === 'debug' || key === '*') ConsoleLogger.setLevel(settings.get().debug ? 'debug' : 'info');
            if (key === 'uiLanguage' || key === '*') panel.relabel();
            void bus.emit('settings:changed', { key });
        }),
    );

    const api = createApiPublisher({
        version: NANOVIA_VERSION,
        features: () => running.map((feature) => feature.id),
        connections,
        profiles,
        settings,
        catalog,
        usage,
        account,
        doctor,
        mgmt,
        panel: { open: (tab) => panel.open(tab) },
        log: log.scope('api'),
    });
    api.publish();

    if (!options.skipInitialRefresh) {
        // The plugin is asked first, so the usage store knows whether it may ask for today's summary.
        void connections
            .refresh()
            .then(() => usage.refresh())
            .catch((error: unknown) => log.error('first refresh failed', error));
    }
    log.info(`${NANOVIA_VERSION} started`);

    return {
        ctx,
        settings,
        connections,
        usage,
        account,
        panel,
        api,
        async stop() {
            for (const off of owned.splice(0).reverse()) {
                try {
                    off();
                } catch (error) {
                    log.error('cleanup failed', error);
                }
            }
            api.dispose();
            panel.dispose();
            requests.uninstall();
            bus.clear();
            host.dispose();
        },
    };
}
