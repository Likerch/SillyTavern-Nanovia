import './style.css';
import type { Feature } from '../../core/context';
import { CONNECTIONS_STRINGS } from './strings';
import { renderConnectionsTab } from './view';

export const CONNECTIONS_FEATURE_ID = 'connections';
export const CONNECTIONS_TAB_ID = 'connections';

/** Tab «Connections»: the plugin status, the connections and their Connection Manager profiles. */
export const connectionsFeature: Feature = {
    id: CONNECTIONS_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(CONNECTIONS_STRINGS);
        return ctx.panel.registerTab({
            id: CONNECTIONS_TAB_ID,
            titleKey: 'connections.tab',
            order: 100,
            render: (root, tabCtx) => renderConnectionsTab(root, tabCtx),
        });
    },
};
