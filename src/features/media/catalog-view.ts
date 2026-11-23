// The catalog section: the four media as a switcher, a search box, the adult-capable and cheapest-first filters, and a card
// per model with its price (worded through i18n), capability chips and a «Use» button that opens the studio with that model.
// The lists are long, so cards are drawn a page at a time; the filters live in the session so they survive a redraw.
import type { ModelSort, TtsKind } from '../../core/media-select';
import { MEDIA_MEDIA } from '../../shared/contracts-media';
import type { MediaModel } from '../../shared/contracts-media';
import { button, chip, clear, el, select, textInput, toggle } from '../../ui';
import type { Studio, StudioDeps } from './controls';
import { CATALOG_PAGE_SIZE } from './session';
import { capabilityChips, errorText, mediumLabel, priceText, priceTitle } from './view-model';

export function createCatalogSection(deps: StudioDeps): Studio {
    const { ctx, session, go } = deps;
    const t = ctx.t;
    const filters = session.filters;
    let disposed = false;

    const switcherHost = el('div', {
        class: 'nanovia-row nanovia-media-switcher',
        attrs: { role: 'group', 'aria-label': t('media.catalog.medium') },
    });
    const controlsHost = el('div', { class: 'nanovia-media-catalog-controls' });
    const statusHost = el('div', { class: 'nanovia-media-catalog-status', attrs: { 'aria-live': 'polite' } });
    const listHost = el('div', { class: 'nanovia-cards nanovia-media-models' });
    const moreHost = el('div', { class: 'nanovia-row' });
    const root = el('div', { class: 'nanovia-media-catalog' }, [
        switcherHost,
        controlsHost,
        statusHost,
        listHost,
        moreHost,
    ]);

    function drawSwitcher(): void {
        clear(switcherHost);
        for (const medium of MEDIA_MEDIA) {
            const active = filters.medium === medium;
            switcherHost.appendChild(
                el('button', {
                    class: ['nanovia-chip', 'nanovia-chip-toggle', active && 'nanovia-chip-active'],
                    text: mediumLabel(medium, t),
                    data: { medium },
                    attrs: { type: 'button', 'aria-pressed': String(active) },
                    on: {
                        click: () => {
                            filters.medium = medium;
                            filters.shown = CATALOG_PAGE_SIZE;
                            drawSwitcher();
                            drawControls();
                            void ctx.media.ensure(medium);
                            drawList();
                        },
                    },
                }),
            );
        }
    }

    function drawControls(): void {
        clear(controlsHost);
        const row = el('div', { class: 'nanovia-row nanovia-media-picker-controls' }, [
            toggle({
                label: t('media.filter.uncensored'),
                checked: filters.uncensored,
                hint: t('media.filter.uncensored.hint'),
                onChange: (on) => {
                    filters.uncensored = on;
                    filters.shown = CATALOG_PAGE_SIZE;
                    drawList();
                },
            }),
            select<ModelSort>({
                value: filters.sort,
                label: t('media.filter.sort'),
                options: [
                    { value: 'name', label: t('media.sort.name') },
                    { value: 'price', label: t('media.sort.price') },
                ],
                onChange: (value) => {
                    filters.sort = value;
                    drawList();
                },
            }),
            filters.medium === 'tts'
                ? select<TtsKind>({
                      value: filters.ttsKind,
                      label: t('media.filter.ttsKind'),
                      options: [
                          { value: 'speech', label: t('media.filter.ttsKind.speech') },
                          { value: 'music', label: t('media.filter.ttsKind.music') },
                          { value: 'all', label: t('media.filter.ttsKind.all') },
                      ],
                      onChange: (value) => {
                          filters.ttsKind = value;
                          drawList();
                      },
                  })
                : null,
            button({
                label: t('media.catalog.refresh'),
                icon: 'rotate',
                kind: 'ghost',
                onClick: async () => {
                    await ctx.media.ensure(filters.medium, { refresh: true });
                },
            }),
        ]);
        controlsHost.append(
            textInput({
                value: filters.search,
                label: t('media.picker.search'),
                placeholder: t('media.picker.search'),
                onInput: (value) => {
                    filters.search = value;
                    filters.shown = CATALOG_PAGE_SIZE;
                    drawList();
                },
            }),
            row,
        );
    }

    function modelCard(model: MediaModel): HTMLElement {
        const title = priceTitle(model.price);
        return el('div', { class: 'nanovia-card nanovia-media-model', data: { model: model.id } }, [
            el('div', { class: 'nanovia-row nanovia-media-model-head' }, [
                el('b', { class: 'nanovia-media-model-name', text: model.name }),
                model.owner ? el('span', { class: 'nanovia-muted', text: model.owner }) : null,
                model.category ? chip(model.category, 'muted') : null,
            ]),
            el('div', { class: 'nanovia-muted nanovia-media-model-id' }, [el('code', { text: model.id })]),
            el('div', { class: 'nanovia-row' }, [
                el('span', {
                    class: 'nanovia-media-money',
                    text: priceText(model.price, t),
                    ...(title ? { title } : {}),
                }),
                ...capabilityChips(model, t).map((spec) => chip(spec.label, spec.kind, spec.title)),
            ]),
            model.description
                ? el('div', { class: 'nanovia-field-hint nanovia-media-description', text: model.description })
                : null,
            el('div', { class: 'nanovia-row' }, [
                button({
                    label: t('media.catalog.use'),
                    icon: 'arrow-right',
                    kind: 'primary',
                    title: t('media.catalog.use.hint', { section: t(`media.section.${filters.medium}`) }),
                    onClick: () => {
                        session.pickModel(model.medium, model.id);
                        go(session.section);
                    },
                }),
            ]),
        ]);
    }

    function drawList(): void {
        if (disposed) return;
        const view = ctx.media.catalogView(filters.medium);
        clear(statusHost);
        clear(listHost);
        clear(moreHost);

        const source =
            view.source === 'stale'
                ? t('media.catalog.source.stale')
                : view.source === 'cache'
                  ? t('media.catalog.source.cache')
                  : null;
        if (view.models.length === 0) {
            if (view.status === 'failed' && view.error) {
                statusHost.append(
                    el('div', { class: 'nanovia-error-text', text: errorText(view.error, t) }),
                    button({
                        label: t('media.catalog.retry'),
                        icon: 'rotate',
                        kind: 'ghost',
                        onClick: async () => {
                            await ctx.media.ensure(filters.medium, { refresh: true });
                        },
                    }),
                );
            } else {
                statusHost.appendChild(
                    el('div', {
                        class: 'nanovia-muted',
                        text: view.status === 'ready' ? t('media.catalog.empty') : t('media.catalog.loading'),
                    }),
                );
            }
            return;
        }

        const found = ctx.media.select(filters.medium, {
            search: filters.search,
            uncensored: filters.uncensored,
            sort: filters.sort,
            ttsKind: filters.ttsKind,
        });
        statusHost.appendChild(
            el('div', { class: 'nanovia-muted' }, [
                t('media.catalog.count', { shown: found.length, total: view.models.length }),
                source ? ` · ${source}` : null,
            ]),
        );
        if (view.status === 'failed' && view.error) {
            statusHost.appendChild(el('div', { class: 'nanovia-error-text', text: errorText(view.error, t) }));
        }
        if (found.length === 0) {
            statusHost.appendChild(el('div', { class: 'nanovia-muted', text: t('media.picker.noMatch') }));
            return;
        }
        for (const model of found.slice(0, filters.shown)) listHost.appendChild(modelCard(model));
        if (found.length > filters.shown) {
            moreHost.appendChild(
                button({
                    label: t('media.catalog.more', {
                        count: Math.min(CATALOG_PAGE_SIZE, found.length - filters.shown),
                    }),
                    kind: 'ghost',
                    onClick: () => {
                        filters.shown += CATALOG_PAGE_SIZE;
                        drawList();
                    },
                }),
            );
        }
    }

    drawSwitcher();
    drawControls();
    drawList();
    void ctx.media.ensure(filters.medium);

    return {
        el: root,
        update: drawList,
        dispose() {
            disposed = true;
        },
    };
}
