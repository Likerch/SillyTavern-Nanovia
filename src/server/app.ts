// Wires the plugin together: stores, token service, usage log, proxy listener and admin routes. index.ts feeds it the
// real ST adapter, the real fetch and the config file; tests feed it fakes.
import type { CatalogModel } from '../shared/contracts';
import { createCatalogService, type CatalogTuning } from './catalog';
import type { ServerConfig } from './config';
import { createProxyServer, type PipelineSteps, type ProxyServer } from './proxy';
import { ROUTE_MODULES } from './routes';
import { createStore } from './store';
import { createTokenService } from './tokens';
import { createUsageLog } from './usage-log';
import type { FetchLike, Logger, ProxyStatus, RouteModule, RouterLike, ServerDeps, StServices } from './types';
import { PLUGIN_VERSION } from './version';

export interface NanoviaOptions {
    config: ServerConfig;
    st: StServices;
    fetch: FetchLike;
    log: Logger;
    version?: string;
    now?: () => number;
    /** Overrides the catalog service's lookup (tests of the proxy). */
    lookupModel?: (modelId: string) => CatalogModel | null;
    /** Overrides the catalog service's provider-selection answer (tests of the proxy). */
    providerSelection?: (modelId: string) => boolean | null;
    /**
     * Catalog service knobs. `autoFetch` (default off, so a test never touches the network by itself) lets the service
     * fetch NanoGPT at start and whenever the proxy finds the data missing or old; index.ts turns it on.
     */
    catalog?: CatalogTuning;
    /** Defaults to ROUTE_MODULES. */
    routes?: RouteModule[];
    /** Defaults to REQUEST_STEPS / RESPONSE_STEPS. */
    steps?: PipelineSteps;
}

export interface Nanovia {
    deps: ServerDeps;
    proxy: ProxyServer;
    /** State of the proxy listener after start. */
    status: ProxyStatus;
    close(): Promise<void>;
}

/**
 * Opens the stores, starts the proxy listener (a taken port is logged and leaves the proxy down; the admin routes
 * still work) and registers the admin routes on `router`.
 */
export async function startNanovia(router: RouterLike, options: NanoviaOptions): Promise<Nanovia> {
    const { config, st, log } = options;
    const now = options.now ?? Date.now;
    const store = createStore({ dataRoot: () => st.dataRoot(), now, log });
    let proxy: ProxyServer | null = null;
    const version = options.version ?? PLUGIN_VERSION;
    const catalog = createCatalogService({
        ...options.catalog,
        siteBase: config.siteBase,
        dataRoot: () => st.dataRoot(),
        fetch: options.fetch,
        version,
        now,
        log,
    });
    const deps: ServerDeps = {
        version,
        config,
        st,
        store,
        tokens: createTokenService({ st, store }),
        usage: createUsageLog(log),
        fetch: options.fetch,
        proxy: () => proxy?.status() ?? { up: false, host: '127.0.0.1', port: config.port, error: null },
        catalog,
        lookupModel: options.lookupModel ?? ((modelId) => catalog.lookupModel(modelId)),
        providerSelection: options.providerSelection ?? ((modelId) => catalog.providerSelection(modelId)),
        now,
        log,
    };
    catalog.start(); // before the listener: the first request already finds the stored catalog
    proxy = options.steps ? createProxyServer(deps, options.steps) : createProxyServer(deps);
    const status = await proxy.listen();
    for (const register of options.routes ?? ROUTE_MODULES) register(router, deps);
    const running = proxy;
    return {
        deps,
        proxy: running,
        status,
        close: async () => {
            catalog.close();
            await running.close();
        },
    };
}
