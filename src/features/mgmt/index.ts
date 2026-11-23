import './style.css';
import type { Feature } from '../../core/context';
import { MGMT_STRINGS } from './strings';
import { renderMgmtTab } from './view';

export const MGMT_FEATURE_ID = 'mgmt';
export const MGMT_TAB_ID = 'mgmt';

/** Tab «Management»: the Management token (write-only), the API keys it manages with their limits, and model presets. */
export const mgmtFeature: Feature = {
    id: MGMT_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(MGMT_STRINGS);
        return ctx.panel.registerTab({
            id: MGMT_TAB_ID,
            titleKey: 'mgmt.tab',
            // After «Keys» (300), before «Account» (400).
            order: 350,
            render: (root, tabCtx) => renderMgmtTab(root, tabCtx),
        });
    },
};
