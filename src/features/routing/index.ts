import './style.css';
import { BILLING_STRINGS } from '../../core/billing-view';
import type { Feature } from '../../core/context';
import { ROUTING_STRINGS } from './strings';
import { renderRoutingTab } from './view';

export const ROUTING_FEATURE_ID = 'routing';
export const ROUTING_TAB_ID = 'routing';

/** Tab «Routing»: provider routing, the billing mode with its live verdict, and the reasoning policy of a connection. */
export const routingFeature: Feature = {
    id: ROUTING_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(BILLING_STRINGS);
        ctx.i18n.register(ROUTING_STRINGS);
        return ctx.panel.registerTab({
            id: ROUTING_TAB_ID,
            titleKey: 'routing.tab',
            order: 200,
            render: (root, tabCtx) => renderRoutingTab(root, tabCtx),
        });
    },
};
