// The «Catalog» tab: status line, filter bar, the list of models (drawn 50 at a time) and the detail of one model.
// All decisions (what passes the filter, what a row says) are in view-model.ts; this file draws and wires events.
import type { FeatureContext } from '../../core/context';
import type { CatalogSort } from '../../shared/contracts-catalog';
import { button, chip, clear, el, field, icon, select, textInput, toggle } from '../../ui';
import type { SelectOption } from '../../ui';
import { renderDetail } from './detail';
import type { DetailHandle } from './detail';
import type { CatalogSession } from './session';
import {
    CAPABILITIES,
    CONTEXT_CHOICES,
    PAGE_SIZE,
    SORTS,
    buildList,
    categoryChips,
    clearedFilters,
    formatContext,
    hasActiveFilters,
    parseNumber,
    statusView,
    toggleCategory,
} from './view-model';
import type { FilterState, ListRow } from './view-model';

export function renderCatalogTab(root: HTMLElement, ctx: FeatureContext, session: CatalogSession): () => void {
    const t = ctx.t;
    let disposed = false;
    let detail: DetailHandle | null = null;

    const statusHost = el('div', { class: 'nanovia-catalog-status' });
    const filtersHost = el('div', { class: 'nanovia-filters' });
    const countHost = el('div', { class: 'nanovia-muted nanovia-list-count', attrs: { 'aria-live': 'polite' } });
    const listHost = el('div', { class: 'nanovia-model-list' });
    const moreHost = el('div', { class: 'nanovia-row' });
    const listPane = el('div', { class: 'nanovia-catalog-list-pane' }, [filtersHost, countHost, listHost, moreHost]);
    const detailPane = el('div', { class: 'nanovia-catalog-detail-pane', attrs: { hidden: true } });
    root.append(statusHost, listPane, detailPane);

    let chipsHost: HTMLElement = el('div');
    let resetButton: HTMLButtonElement = button({});

    /* ------------------------------------------------------------------------------------------ status */

    function drawStatus(): void {
        clear(statusHost);
        const view = statusView(ctx.catalog.status(), ctx.catalog.models().length, Date.now(), t);
        const modifier = { ok: 'up', error: 'down', muted: 'checking', warn: 'warn' }[view.kind];
        const box = el('div', { class: ['nanovia-banner', `nanovia-banner-${modifier}`] }, [
            el('div', { class: 'nanovia-row' }, [
                el('span', { class: 'nanovia-status-text', text: view.text }),
                button({
                    label: t('catalog.refresh'),
                    icon: 'rotate',
                    kind: 'ghost',
                    onClick: () => ctx.catalog.refresh(true),
                }),
            ]),
            view.notice
                ? el('div', {
                      class: view.kind === 'error' ? 'nanovia-error-text' : 'nanovia-muted',
                      text: view.notice,
                  })
                : null,
        ]);
        statusHost.appendChild(box);
    }

    /* ------------------------------------------------------------------------------------------ filters */

    function change(next: FilterState): void {
        session.filters = next;
        session.shown = PAGE_SIZE;
        drawChips();
        drawList();
        resetButton.hidden = !hasActiveFilters(session.filters);
    }

    function drawChips(): void {
        clear(chipsHost);
        for (const entry of categoryChips(ctx.catalog.models(), session.filters, t)) {
            chipsHost.appendChild(
                el('button', {
                    class: ['nanovia-chip', 'nanovia-chip-toggle', entry.active && 'nanovia-chip-active'],
                    text: `${entry.label} (${entry.count})`,
                    data: { category: entry.key },
                    attrs: { type: 'button', 'aria-pressed': String(entry.active) },
                    on: { click: () => change(toggleCategory(session.filters, entry.key)) },
                }),
            );
        }
    }

    function buildFilters(): void {
        clear(filtersHost);
        const f = session.filters;
        const flag = (label: string, checked: boolean, apply: (state: FilterState, on: boolean) => FilterState) =>
            toggle({ label, checked, onChange: (on) => change(apply(session.filters, on)) });

        chipsHost = el('div', {
            class: 'nanovia-row nanovia-category-chips',
            attrs: { role: 'group', 'aria-label': t('catalog.filter.categories') },
        });
        resetButton = button({
            label: t('catalog.filter.reset'),
            icon: 'filter-circle-xmark',
            kind: 'ghost',
            onClick: () => {
                session.filters = clearedFilters(session.filters);
                session.shown = PAGE_SIZE;
                buildFilters();
                drawList();
            },
        });
        resetButton.hidden = !hasActiveFilters(f);

        const contextOptions: SelectOption<string>[] = CONTEXT_CHOICES.map((value) => ({
            value: String(value),
            label: value === 0 ? t('catalog.filter.minContext.any') : formatContext(value),
        }));
        const sortOptions: SelectOption<CatalogSort>[] = SORTS.map((value) => ({
            value,
            label: t(`catalog.sort.${value}`),
        }));

        filtersHost.append(
            textInput({
                value: f.text,
                label: t('catalog.filter.search'),
                placeholder: t('catalog.filter.searchPlaceholder'),
                onInput: (value) => change({ ...session.filters, text: value }),
            }),
            chipsHost,
            el('div', { class: 'nanovia-row nanovia-toggles' }, [
                flag(t('catalog.filter.subscriptionOnly'), f.subscriptionOnly, (s, on) => ({
                    ...s,
                    subscriptionOnly: on,
                })),
                ...CAPABILITIES.map((cap) =>
                    flag(t(`catalog.cap.${cap.key}`), f[cap.key], (s, on) => ({ ...s, [cap.key]: on })),
                ),
                flag(t('catalog.filter.openWeights'), f.openWeightsOnly, (s, on) => ({ ...s, openWeightsOnly: on })),
            ]),
            field(
                t('catalog.filter.minContext'),
                select({
                    value: String(f.minContext),
                    options: contextOptions,
                    label: t('catalog.filter.minContext'),
                    onChange: (value) => change({ ...session.filters, minContext: Number(value) }),
                }),
            ),
            field(
                t('catalog.filter.maxPrice'),
                textInput({
                    value: f.maxPromptPrice === null ? '' : String(f.maxPromptPrice),
                    label: t('catalog.filter.maxPrice'),
                    placeholder: t('catalog.filter.maxPricePlaceholder'),
                    onInput: (value) => change({ ...session.filters, maxPromptPrice: parseNumber(value) }),
                }),
            ),
            field(
                t('catalog.filter.sort'),
                select({
                    value: f.sort,
                    options: sortOptions,
                    label: t('catalog.filter.sort'),
                    onChange: (value) => change({ ...session.filters, sort: value }),
                }),
            ),
            el('div', { class: 'nanovia-row nanovia-toggles' }, [
                flag(t('catalog.filter.reverse'), f.reverse, (s, on) => ({ ...s, reverse: on })),
                flag(t('catalog.filter.group'), f.groupByVendor, (s, on) => ({ ...s, groupByVendor: on })),
                resetButton,
            ]),
        );
        drawChips();
    }

    /* ------------------------------------------------------------------------------------------ the list */

    function renderRow(row: ListRow): HTMLElement {
        const caps = el('span', { class: 'nanovia-caps' }, [
            ...CAPABILITIES.filter((cap) => row.capabilities.includes(cap.key)).map((cap) =>
                el(
                    'span',
                    {
                        class: 'nanovia-cap',
                        data: { cap: cap.key },
                        title: t(`catalog.cap.${cap.key}`),
                        attrs: { role: 'img', 'aria-label': t(`catalog.cap.${cap.key}`) },
                    },
                    [icon(cap.icon)],
                ),
            ),
            row.openWeights
                ? el(
                      'span',
                      {
                          class: 'nanovia-cap',
                          data: { cap: 'openWeights' },
                          title: t('catalog.cap.openWeights'),
                          attrs: { role: 'img', 'aria-label': t('catalog.cap.openWeights') },
                      },
                      [icon('lock-open')],
                  )
                : null,
        ]);
        return el(
            'button',
            {
                class: 'nanovia-model-row',
                data: { model: row.id },
                attrs: { type: 'button' },
                on: { click: () => openDetail(row.id) },
            },
            [
                el('span', { class: 'nanovia-model-head' }, [
                    el('b', { class: 'nanovia-model-name', text: row.name }),
                    row.subscription ? chip(row.subscription.label, 'ok', row.subscription.title) : null,
                ]),
                el('span', { class: 'nanovia-muted nanovia-model-id', text: row.id }),
                el('span', { class: 'nanovia-model-meta' }, [
                    el('span', { class: 'nanovia-model-price', text: row.price, title: t('catalog.list.priceTitle') }),
                    el('span', {
                        class: 'nanovia-model-context',
                        text: row.context,
                        title: t('catalog.list.contextTitle'),
                    }),
                    caps,
                ]),
            ],
        );
    }

    function drawList(): void {
        clear(listHost);
        clear(moreHost);
        countHost.textContent = '';
        const status = ctx.catalog.status();
        if (!status.loaded) {
            if (status.error) {
                listHost.append(
                    el('div', { class: 'nanovia-error-text nanovia-empty', text: t('catalog.status.failed') }),
                    button({ label: t('catalog.retry'), icon: 'rotate', onClick: () => ctx.catalog.refresh(true) }),
                );
            } else {
                listHost.appendChild(
                    el('div', { class: 'nanovia-muted nanovia-empty', text: t('catalog.status.loading') }),
                );
            }
            return;
        }
        const list = buildList(ctx.catalog.models(), session.filters, session.shown, t);
        if (list.matched === 0) {
            listHost.appendChild(el('div', { class: 'nanovia-muted nanovia-empty', text: t('catalog.list.empty') }));
            return;
        }
        countHost.textContent = t('catalog.list.count', {
            shown: list.shown,
            matched: list.matched,
            total: list.total,
        });
        for (const section of list.sections) {
            const group = el('div', { class: 'nanovia-model-group' });
            if (section.vendorLabel !== null) {
                group.appendChild(
                    el('div', {
                        class: 'nanovia-vendor-head',
                        text: `${section.vendorLabel} (${section.count})`,
                        data: { vendor: section.vendor ?? '' },
                    }),
                );
            }
            for (const row of section.rows) group.appendChild(renderRow(row));
            listHost.appendChild(group);
        }
        if (list.remaining > 0) {
            moreHost.appendChild(
                button({
                    label: t('catalog.list.showMore', { count: Math.min(PAGE_SIZE, list.remaining) }),
                    onClick: () => {
                        session.shown += PAGE_SIZE;
                        drawList();
                    },
                }),
            );
        }
    }

    /* ------------------------------------------------------------------------------------------ the detail */

    function showDetail(id: string): void {
        detail?.dispose();
        clear(detailPane);
        listPane.hidden = true;
        detailPane.hidden = false;
        detail = renderDetail(detailPane, { ctx, session, modelId: id, back: closeDetail });
        detailPane.scrollIntoView?.({ block: 'start' });
    }

    function openDetail(id: string): void {
        session.selected = id;
        showDetail(id);
    }

    function closeDetail(): void {
        detail?.dispose();
        detail = null;
        session.selected = null;
        clear(detailPane);
        detailPane.hidden = true;
        listPane.hidden = false;
        drawList();
    }

    /* ------------------------------------------------------------------------------------------ wiring */

    const offCatalog = ctx.catalog.onChange(() => {
        if (disposed) return;
        drawStatus();
        if (session.selected) {
            if (ctx.catalog.model(session.selected)) detail?.refresh();
            else closeDetail();
            return;
        }
        drawChips();
        drawList();
    });
    const offConnections = ctx.connections.onChange(() => {
        if (!disposed && session.selected) detail?.refresh();
    });

    drawStatus();
    buildFilters();
    drawList();
    if (session.selected) {
        if (ctx.catalog.model(session.selected)) showDetail(session.selected);
        else session.selected = null;
    }
    // Opening the tab is a reason to look at the catalog again (a no-op while the copy is fresh).
    void ctx.catalog.refresh();

    return () => {
        disposed = true;
        offCatalog();
        offConnections();
        detail?.dispose();
        detail = null;
    };
}
