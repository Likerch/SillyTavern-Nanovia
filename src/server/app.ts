// Wires the plugin together: stores, token service, usage log, proxy listener and admin routes. index.ts feeds it the
// real ST adapter, the real fetch and the config file; tests feed it fakes.
import type { CatalogModel } from '../shared/contracts';
import type { ServerConfig } from './config';
import { createProxyServer, type PipelineSteps, type ProxyServer } from './proxy';
import { ROUTE_MODULES } from './routes';
import { createStore } from './store';
import { createTokenService } from './tokens';
import { createUsageLog } from './usage-log';
import type {
    FetchLike,
    Logger,
    ProxyStatus,
    RouteModule,
    RouterLike,
    ServerDeps,
    StServices,
} from './types';
import { PLUGIN_VERSION } from './version';

export interface NanoviaOptions {
    config: ServerConfig;
    st: StServices;
    fetch: FetchLike;
    log: Logger;
    version?: string;
    now?: () => number;
    lookupModel?: (modelId: string) => CatalogModel | null;
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
    const deps: ServerDeps = {
        version: options.version ?? PLUGIN_VERSION,
        config,
        st,
        store,
        tokens: createTokenService({ st, store }),
        usage: createUsageLog(log),
        fetch: options.fetch,
        proxy: () => proxy?.status() ?? { up: false, host: '127.0.0.1', port: config.port, error: null },
        lookupModel: options.lookupModel ?? (() => null),
        now,
        log,
    };
    proxy = options.steps ? createProxyServer(deps, options.steps) : createProxyServer(deps);
    const status = await proxy.listen();
    for (const register of options.routes ?? ROUTE_MODULES) register(router, deps);
    const running = proxy;
    return {
        deps,
        proxy: running,
        status,
        close: () => running.close(),
    };
}
