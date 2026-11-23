import './style.css';
import type { Feature } from '../../core/context';
import { ACCOUNT_STRINGS } from './strings';
import { renderAccountTab } from './view';

export const ACCOUNT_FEATURE_ID = 'account';
export const ACCOUNT_TAB_ID = 'account';

/** Tab «Account»: the NanoGPT balance and subscription quota, what was spent, and the recent requests. */
export const accountFeature: Feature = {
    id: ACCOUNT_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(ACCOUNT_STRINGS);
        return ctx.panel.registerTab({
            id: ACCOUNT_TAB_ID,
            titleKey: 'account.tab',
            order: 400,
            render: (root, tabCtx) => renderAccountTab(root, tabCtx),
        });
    },
};
