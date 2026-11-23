import './style.css';
import type { Feature } from '../../core/context';
import { KEYS_STRINGS } from './strings';
import { renderKeysTab } from './view';

export const KEYS_FEATURE_ID = 'keys';
export const KEYS_TAB_ID = 'keys';

/** Tab «Keys»: the NanoGPT keys the plugin holds, which connections use them, balance check, add and delete. */
export const keysFeature: Feature = {
    id: KEYS_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(KEYS_STRINGS);
        return ctx.panel.registerTab({
            id: KEYS_TAB_ID,
            titleKey: 'keys.tab',
            order: 300,
            render: (root, tabCtx) => renderKeysTab(root, tabCtx),
        });
    },
};
