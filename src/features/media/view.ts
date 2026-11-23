// The «Media» tab: NanoGPT's image, speech, transcription and video through the plugin. A head with the state of the plugin
// and of the ST integration, a switcher of five sections (the catalog and the four studios) and the open section. The
// decisions are in view-model.ts and param-form.ts; the sections draw; this file composes them and keeps them in step with
// the media store.
import type { FeatureContext } from '../../core/context';
import { button, chip, clear, el } from '../../ui';
import { createCatalogSection } from './catalog-view';
import { createImageStudio } from './image-view';
import type { Studio, StudioDeps, TabHooks } from './controls';
import { MEDIA_SECTIONS } from './session';
import type { MediaSection, MediaSession } from './session';
import { createSttStudio } from './stt-view';
import { createTtsStudio } from './tts-view';
import { createVideoStudio } from './video-view';
import { bannerFor } from './view-model';

export function renderMediaTab(
    root: HTMLElement,
    ctx: FeatureContext,
    session: MediaSession,
    hooks: TabHooks = {},
): () => void {
    const t = ctx.t;
    let disposed = false;
    let studio: Studio | null = null;

    const bannerHost = el('div', { class: 'nanovia-banner-host' });
    const integrationHost = el('div', { class: 'nanovia-media-integration' });
    const navHost = el('div', {
        class: 'nanovia-row nanovia-media-nav',
        attrs: { role: 'group', 'aria-label': t('media.nav') },
    });
    const body = el('div', { class: 'nanovia-media-body' });

    const head = el('div', { class: 'nanovia-row nanovia-media-top' }, [
        el('b', { text: t('media.title') }),
        button({
            label: t('media.refresh'),
            icon: 'rotate',
            kind: 'ghost',
            onClick: async () => {
                await ctx.connections.refresh();
                await Promise.all([
                    ctx.media.ensure(session.filters.medium, { refresh: true }),
                    ctx.media.refreshVideos(),
                ]);
            },
        }),
    ]);

    root.append(
        head,
        el('div', { class: 'nanovia-muted nanovia-media-intro', text: t('media.intro') }),
        bannerHost,
        integrationHost,
        navHost,
        body,
    );

    function drawBanner(): void {
        clear(bannerHost);
        const banner = bannerFor(ctx.media.state(), ctx.media.problem(), t);
        if (!banner) return;
        const kindClass = banner.kind === 'error' ? 'nanovia-banner-down' : 'nanovia-banner-checking';
        const box = el('div', { class: ['nanovia-banner', kindClass] }, [
            el('div', { class: 'nanovia-row' }, [chip(banner.title, banner.kind === 'error' ? 'error' : 'warn')]),
            el('div', { class: banner.kind === 'error' ? 'nanovia-error-text' : '', text: banner.text }),
        ]);
        if (banner.action === 'keys') {
            box.appendChild(
                button({ label: t('media.banner.keys'), kind: 'ghost', onClick: () => ctx.panel.open?.('keys') }),
            );
        }
        bannerHost.appendChild(box);
    }

    /** The Doctor-style note: is «Nanovia» in the provider list of ST's TTS extension? */
    function drawIntegration(): void {
        clear(integrationHost);
        const state = session.integration();
        const spec = {
            pending: {
                kind: 'muted',
                label: t('media.integration.pending'),
                text: t('media.integration.pending.text'),
            },
            active: { kind: 'ok', label: t('media.integration.active'), text: t('media.integration.active.text') },
            unavailable: { kind: 'warn', label: t('media.integration.unavailable'), text: state.message ?? '' },
            failed: { kind: 'error', label: t('media.integration.failed'), text: state.message ?? '' },
        } as const;
        const item = spec[state.status];
        integrationHost.appendChild(
            el('div', { class: 'nanovia-row nanovia-media-integration-row', data: { integration: state.status } }, [
                chip(item.label, item.kind),
                el('span', { class: 'nanovia-muted', text: item.text }),
            ]),
        );
    }

    function factory(section: MediaSection, deps: StudioDeps): Studio {
        switch (section) {
            case 'image':
                return createImageStudio(deps);
            case 'tts':
                return createTtsStudio(deps);
            case 'stt':
                return createSttStudio(deps, hooks);
            case 'video':
                return createVideoStudio(deps);
            default:
                return createCatalogSection(deps);
        }
    }

    function drawNav(): void {
        clear(navHost);
        for (const section of MEDIA_SECTIONS) {
            const active = session.section === section;
            navHost.appendChild(
                el('button', {
                    class: ['nanovia-chip', 'nanovia-chip-toggle', active && 'nanovia-chip-active'],
                    text: t(`media.section.${section}`),
                    data: { section },
                    attrs: { type: 'button', 'aria-pressed': String(active) },
                    on: { click: () => go(section) },
                }),
            );
        }
    }

    function showSection(): void {
        studio?.dispose();
        studio = null;
        clear(body);
        studio = factory(session.section, { ctx, session, go });
        body.appendChild(studio.el);
    }

    function go(section: MediaSection): void {
        if (disposed) return;
        session.section = section;
        drawNav();
        showSection();
    }

    function redraw(): void {
        if (disposed) return;
        drawBanner();
        studio?.update();
    }

    const offs = [
        ctx.media.onChange(redraw),
        ctx.connections.onChange(() => {
            if (!disposed) drawBanner();
        }),
        session.onIntegration(() => {
            if (!disposed) drawIntegration();
        }),
    ];

    drawBanner();
    drawIntegration();
    drawNav();
    showSection();

    return () => {
        disposed = true;
        for (const off of offs) off();
        studio?.dispose();
        studio = null;
    };
}
