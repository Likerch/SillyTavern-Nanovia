import './style.css';
import type { Feature } from '../../core/context';
import { createSession } from './session';
import { MEDIA_STRINGS } from './strings';
import { registerNanoviaTts } from './tts-provider';
import { renderMediaTab } from './view';

export const MEDIA_FEATURE_ID = 'media';
export const MEDIA_TAB_ID = 'media';

/**
 * Tab «Media»: the catalogs of NanoGPT's image, video, speech and transcription models and a studio for each, all through
 * the plugin; plus the «Nanovia» provider in ST's own TTS extension (registered at start, switched off quietly when ST
 * has no such extension).
 */
export const mediaFeature: Feature = {
    id: MEDIA_FEATURE_ID,
    init(ctx) {
        ctx.i18n.register(MEDIA_STRINGS);
        const session = createSession();
        void registerNanoviaTts(ctx, session).catch((error: unknown) => {
            // registerNanoviaTts never throws; this is for a future change.
            ctx.log.error('TTS provider registration failed', error);
            session.setIntegration('failed', error instanceof Error ? error.message : String(error));
        });
        return ctx.panel.registerTab({
            id: MEDIA_TAB_ID,
            titleKey: 'media.tab',
            // After «Management» (350), before «Account» (400).
            order: 380,
            render: (root, tabCtx) => renderMediaTab(root, tabCtx, session),
        });
    },
};
