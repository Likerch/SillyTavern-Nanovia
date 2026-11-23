import './style.css';
import { BILLING_STRINGS } from '../../core/billing-view';
import type { Feature } from '../../core/context';
import { DOCTOR_STRINGS } from './strings';
import { renderDoctorTab } from './view';

export const DOCTOR_FEATURE_ID = 'doctor';
export const DOCTOR_TAB_ID = 'doctor';

/** Tab «Diagnostics»: checks the whole setup and offers a one-click fix for what it finds. */
export const doctorFeature: Feature = {
    id: DOCTOR_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(BILLING_STRINGS);
        ctx.i18n.register(DOCTOR_STRINGS);
        return ctx.panel.registerTab({
            id: DOCTOR_TAB_ID,
            titleKey: 'doctor.tab',
            // Just before «General» (1000).
            order: 500,
            render: (root, tabCtx) => renderDoctorTab(root, tabCtx),
        });
    },
};
