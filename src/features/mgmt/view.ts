// The «Management» tab: NanoGPT's Management API through the plugin. A token card (write-only), the managed API keys with
// their limits, and the model presets. The decisions (what a state says, what a form turns into) are in view-model.ts and
// the two form models; the sections draw; this file composes them and keeps them in step with the store.
import type { FeatureContext } from '../../core/context';
import type { MgmtDetail } from '../../core/mgmt';
import { button, chip, clear, el } from '../../ui';
import { noticeBox } from './controls';
import type { NoticeAction, NoticeKind } from './controls';
import { createKeysSection } from './keys-view';
import { createPresetsSection } from './presets-view';
import { createTokenSection } from './token-view';
import { bannerFor } from './view-model';

export function renderMgmtTab(root: HTMLElement, ctx: FeatureContext): () => void {
    const t = ctx.t;
    let disposed = false;

    const bannerHost = el('div', { class: 'nanovia-banner-host' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });

    function notify(kind: NoticeKind, text: string, action?: NoticeAction): void {
        clear(noticeHost);
        noticeHost.appendChild(noticeBox(kind, text, action));
    }

    const deps = { ctx, notify };
    const token = createTokenSection(deps);
    const keys = createKeysSection(deps);
    const presets = createPresetsSection(deps);

    const head = el('div', { class: 'nanovia-row nanovia-mgmt-top' }, [
        el('b', { text: t('mgmt.title') }),
        chip(t('mgmt.beta.chip'), 'info', t('mgmt.beta')),
        button({
            label: t('mgmt.refresh'),
            icon: 'rotate',
            kind: 'ghost',
            onClick: async () => {
                await ctx.mgmt.refresh({ force: true });
                const detail = ctx.mgmt.detail();
                if (detail.state === 'ready' && !detail.keys.error && !detail.presets.error) {
                    notify('ok', t('mgmt.notice.refreshed'));
                }
            },
        }),
    ]);

    root.append(
        head,
        el('div', { class: 'nanovia-muted nanovia-mgmt-beta', text: t('mgmt.beta') }),
        bannerHost,
        noticeHost,
        token.el,
        keys.el,
        presets.el,
    );

    function drawBanner(detail: MgmtDetail): void {
        clear(bannerHost);
        const banner = bannerFor(detail, t);
        if (!banner) return;
        bannerHost.appendChild(
            el(
                'div',
                {
                    class: [
                        'nanovia-banner',
                        banner.kind === 'error' ? 'nanovia-banner-down' : 'nanovia-banner-checking',
                    ],
                },
                [
                    el('div', { class: 'nanovia-row' }, [
                        chip(banner.title, banner.kind === 'error' ? 'error' : 'warn'),
                    ]),
                    el('div', { class: banner.kind === 'error' ? 'nanovia-error-text' : '', text: banner.text }),
                ],
            ),
        );
    }

    function redraw(): void {
        if (disposed) return;
        const detail = ctx.mgmt.detail();
        drawBanner(detail);
        token.update(detail);
        keys.update(detail);
        presets.update(detail);
    }

    const offs = [
        ctx.mgmt.onChange(redraw),
        // "Create from connection" offers the connections as they are now.
        ctx.connections.onChange(() => {
            if (!disposed) presets.update(ctx.mgmt.detail());
        }),
    ];

    redraw();
    void ctx.mgmt.refresh();

    return () => {
        disposed = true;
        for (const off of offs) off();
    };
}
