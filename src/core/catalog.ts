// The browser's view of NanoGPT's model catalog (stage 0.3 implements it; until then this null object keeps every
// consumer working with "no catalog known"). Features read it through `ctx.catalog`; nothing here touches the network.
import type { CatalogModel, ModelProviders } from '../shared/contracts';
import type { RoutingHint } from '../shared/contracts-catalog';
import type { Unsubscribe } from './types';

export interface CatalogStatus {
    loaded: boolean;
    /** ms since epoch of the last successful load; null before the first one. */
    fetchedAt: number | null;
    /** Where the snapshot came from; null before the first load. */
    source: 'live' | 'cache' | 'stale' | null;
    /** The last failure, without secrets; null when the last load worked. */
    error: string | null;
    /** Where the snapshot in memory came from: the plugin, NanoGPT directly, or the copy stored in the browser. */
    via?: 'plugin' | 'direct' | 'storage' | null;
}

export interface CatalogStore {
    /** The snapshot as it is now (empty before the first load). Synchronous: safe to call while rendering. */
    models(): CatalogModel[];
    /** One model; an id with a trailing `:thinking`/`:online`/`:memory` style suffix falls back to the base id. */
    model(id: string): CatalogModel | null;
    /** Cached hosts of a model; null when not fetched yet (call `ensureProviders`). */
    providers(id: string): ModelProviders | null;
    /** Fetches (or reuses) the hosts of a model; null when they cannot be had. Never throws. */
    ensureProviders(id: string): Promise<ModelProviders | null>;
    /** Routing hints for a model with whatever host data is cached. */
    hints(id: string): RoutingHint[];
    status(): CatalogStatus;
    /** Reloads the snapshot (`force` bypasses the freshness window). Never throws. */
    refresh(force?: boolean): Promise<void>;
    /** Called after the snapshot or a hosts entry changed. */
    onChange(listener: () => void): Unsubscribe;
}

/** A store that knows nothing: the default until a real one is wired in. */
export function createEmptyCatalogStore(): CatalogStore {
    return {
        models: () => [],
        model: () => null,
        providers: () => null,
        ensureProviders: async () => null,
        hints: () => [],
        status: () => ({ loaded: false, fetchedAt: null, source: null, error: null }),
        refresh: async () => {},
        onChange: () => () => {},
    };
}
