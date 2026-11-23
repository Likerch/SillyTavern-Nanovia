import './style.css';
import type { Feature } from '../../core/context';
import { createSession } from './session';
import { CATALOG_STRINGS } from './strings';
import { renderCatalogTab } from './view';

export const CATALOG_FEATURE_ID = 'catalog';
export const CATALOG_TAB_ID = 'catalog';

/** Starts the first catalog load once the page is idle, so it never competes with SillyTavern's own start. */
export function scheduleIdle(task: () => void, timeoutMs = 4000): () => void {
    const host = globalThis as unknown as {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof host.requestIdleCallback === 'function') {
        const handle = host.requestIdleCallback(task, { timeout: timeoutMs });
        return () => host.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(task, 1000);
    return () => clearTimeout(timer);
}

/** Tab «Catalog»: NanoGPT's models with filters, prices, hosts and routing hints, and a way to turn one into a connection. */
export const catalogFeature: Feature = {
    id: CATALOG_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(CATALOG_STRINGS);
        const session = createSession();
        // Lazy: nothing is fetched at start. The first load happens when the page is idle, and again whenever the tab or
        // a model picker opens (a no-op while the copy is fresh).
        const cancelIdle = scheduleIdle(() => void ctx.catalog.refresh());
        const removeTab = ctx.panel.registerTab({
            id: CATALOG_TAB_ID,
            titleKey: 'catalog.tab',
            order: 200,
            render: (root, tabCtx) => renderCatalogTab(root, tabCtx, session),
        });
        return () => {
            cancelIdle();
            removeTab();
        };
    },
};
