// The «Account» tab: balance and subscription quota, spend (real cost beside the pay-as-you-go equivalent) and the recent
// requests with a "check exact cost" button. All decisions (what to show, how to word it) are in view-model.ts; this file
// draws, loads and keeps the tab in step with the stores.
import type { FeatureContext } from '../../core/context';
import { localMidnight } from '../../core/usage';
import type { SpendResult } from '../../core/usage';
import type { KeyInfo } from '../../shared/contracts';
import { mediumRowsOf } from '../../host';
import { button, chip, clear, el, field, select } from '../../ui';
import {
    SPEND_RANGES,
    accountNotice,
    balanceUpdated,
    connectionRows,
    formatUsd,
    keyOptionLabel,
    lookupView,
    mediumRows,
    modelRows,
    quotaBar,
    rangeBounds,
    recentRow,
    recommendedChip,
    spendCard,
    spendSourceNote,
} from './view-model';
import type { BreakdownRow, LookupView, QuotaBarSpec, RecentRowSpec, SpendRange } from './view-model';

/** How many recent requests the list shows. */
export const RECENT_LIMIT = 30;
/** The spend summaries are not asked for more often than this when records keep arriving. */
export const SPEND_THROTTLE_MS = 5_000;

type LookupState = { busy: true } | { busy: false; view: LookupView };

interface ViewState {
    /** The plugin's keys; null while unknown. */
    keys: KeyInfo[] | null;
    spend: Partial<Record<SpendRange, SpendResult>>;
    /** The range the breakdown tables describe. */
    range: SpendRange;
    lookups: Map<string, LookupState>;
}

export function renderAccountTab(root: HTMLElement, ctx: FeatureContext): () => void {
    const t = ctx.t;
    const state: ViewState = { keys: null, spend: {}, range: 'week', lookups: new Map() };
    let disposed = false;
    let loading = false;
    let rerun = false;
    let lastLoad = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    const headHost = el('div', { class: 'nanovia-account-head' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });
    const accountHost = el('div', { class: 'nanovia-account-cards' });
    const spendHost = el('section', { class: 'nanovia-account-section' });
    const recentHost = el('section', { class: 'nanovia-account-section' });
    root.append(headHost, noticeHost, accountHost, spendHost, recentHost);

    const nameOf = (connectionId: string): string | null => ctx.connections.get(connectionId)?.config.name ?? null;

    /* ---------------------------------------------------------------------------------------------- drawing */

    function drawHead(): void {
        clear(headHost);
        const keys = state.keys ?? [];
        const row = el('div', { class: 'nanovia-row' });
        if (keys.length > 0) {
            const options = [
                { value: '', label: t('account.key.activeOption') },
                ...keys.map((key) => ({ value: key.id, label: keyOptionLabel(key, t) })),
            ];
            row.appendChild(
                field(
                    t('account.key.label'),
                    select({
                        value: ctx.account.keyId() ?? '',
                        options,
                        label: t('account.key.label'),
                        onChange: async (value) => {
                            ctx.account.selectKey(value || null);
                            await ctx.account.refresh({ force: true });
                        },
                    }),
                ),
            );
        }
        row.appendChild(
            button({ label: t('account.refresh'), icon: 'rotate', kind: 'ghost', onClick: () => refreshAll() }),
        );
        headHost.appendChild(row);
    }

    function renderBar(spec: QuotaBarSpec): HTMLElement {
        const fill = el('div', { class: ['nanovia-bar-fill', `nanovia-bar-${spec.level}`] });
        const percent = Math.round((spec.fraction ?? 0) * 100);
        fill.style.width = `${percent}%`;
        return el('div', { class: 'nanovia-quota' }, [
            el('div', { class: 'nanovia-quota-label', text: spec.label }),
            el(
                'div',
                {
                    class: 'nanovia-bar',
                    attrs: {
                        role: 'progressbar',
                        'aria-label': spec.label,
                        'aria-valuemin': 0,
                        'aria-valuemax': 100,
                        'aria-valuenow': spec.fraction === null ? undefined : percent,
                    },
                },
                [fill],
            ),
            el('div', { class: 'nanovia-muted', text: spec.valueText }),
            spec.resetText ? el('div', { class: 'nanovia-muted', text: spec.resetText }) : null,
        ]);
    }

    function drawAccount(): void {
        const detail = ctx.account.detail();
        const now = Date.now();
        clear(noticeHost);
        clear(accountHost);

        const notice = accountNotice(detail, t);
        if (notice) {
            // An information notice has no colour of its own: the plain border of `.nanovia-notice`.
            const box = el('div', { class: ['nanovia-notice', `nanovia-notice-${notice.kind}`] }, [
                el('div', { text: notice.text }),
            ]);
            if (notice.action === 'keys') {
                box.appendChild(
                    button({
                        label: t('account.keys.open'),
                        kind: 'ghost',
                        onClick: () => ctx.panel.open?.('keys'),
                    }),
                );
            }
            noticeHost.appendChild(box);
        }

        const snapshot = detail.snapshot;
        if (!snapshot) return;

        const balance = el('div', { class: 'nanovia-card' }, [
            el('b', { text: t('account.balance.title') }),
            el('div', { class: 'nanovia-big', text: formatUsd(snapshot.usdBalance) }),
            snapshot.nanoBalance !== null && snapshot.nanoBalance !== 0
                ? el('div', { class: 'nanovia-muted', text: `${t('account.balance.nano')}: ${snapshot.nanoBalance}` })
                : null,
            el('div', { class: 'nanovia-muted', text: balanceUpdated(detail, now, t) ?? '' }),
        ]);

        const sub = snapshot.subscription;
        const subscription = el('div', { class: 'nanovia-card' }, [el('b', { text: t('account.subscription.title') })]);
        if (sub === null || !sub.active) {
            subscription.appendChild(
                el('div', {
                    class: 'nanovia-muted',
                    text: detail.subscriptionError ? t('account.subscription.unknown') : t('account.subscription.none'),
                }),
            );
        } else {
            for (const id of ['daily', 'weekly'] as const) {
                const window = sub[id];
                if (window.used === null && window.limit === null && window.resetsAt === null) continue;
                subscription.appendChild(renderBar(quotaBar(id, window, now, t)));
            }
            const recommended = recommendedChip(sub.recommendedMode, t);
            if (recommended) {
                subscription.appendChild(
                    el('div', { class: 'nanovia-row' }, [chip(recommended.label, recommended.kind, recommended.title)]),
                );
            }
        }
        accountHost.append(balance, subscription);
    }

    function breakdownTable(
        title: string,
        rows: BreakdownRow[],
        options: { nameColumn?: string; tokens?: boolean } = {},
    ): HTMLElement {
        const withTokens = options.tokens !== false;
        const head = el('tr', {}, [
            el('th', { text: options.nameColumn ?? t('account.spend.col.name') }),
            el('th', { text: t('account.spend.col.requests') }),
            el('th', { text: t('account.spend.col.real') }),
            el('th', { text: t('account.spend.col.equivalent') }),
            withTokens ? el('th', { text: t('account.spend.col.tokens') }) : null,
        ]);
        const body = rows.map((row) =>
            el('tr', { data: { row: row.key } }, [
                el('td', { class: 'nanovia-table-name', text: row.name }),
                el('td', { text: row.requests }),
                el('td', { text: row.real }),
                el('td', { class: 'nanovia-muted', text: row.equivalent }),
                withTokens ? el('td', { class: 'nanovia-muted', text: row.tokens }) : null,
            ]),
        );
        return el('div', { class: 'nanovia-table-block' }, [
            el('b', { text: title }),
            el('div', { class: 'nanovia-table-wrap' }, [
                el('table', { class: 'nanovia-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
            ]),
        ]);
    }

    function drawSpend(): void {
        clear(spendHost);
        spendHost.appendChild(el('h4', { class: 'nanovia-account-title', text: t('account.spend.title') }));
        spendHost.appendChild(el('div', { class: 'nanovia-muted nanovia-spend-note', text: t('account.spend.note') }));

        const cards = el('div', { class: 'nanovia-spend-cards' });
        for (const range of SPEND_RANGES) {
            const result = state.spend[range];
            const spec = spendCard(range, result?.summary.total ?? null, t);
            cards.appendChild(
                el('div', { class: 'nanovia-card nanovia-spend-card', data: { range } }, [
                    el('b', { text: spec.title }),
                    el('div', { class: 'nanovia-spend-pair' }, [
                        el('div', {}, [
                            el('div', { class: 'nanovia-muted', text: t('account.spend.real') }),
                            el('div', { class: 'nanovia-big nanovia-spend-real', text: spec.real }),
                        ]),
                        el('div', {}, [
                            el('div', { class: 'nanovia-muted', text: t('account.spend.equivalent') }),
                            el('div', { class: 'nanovia-big nanovia-spend-equivalent', text: spec.equivalent }),
                        ]),
                    ]),
                    el('div', {
                        class: 'nanovia-muted',
                        text: spec.empty
                            ? loading
                                ? t('account.spend.loading')
                                : ''
                            : `${t('account.spend.requests', { count: spec.requests })} · ${spec.tokens}`,
                    }),
                ]),
            );
        }
        spendHost.appendChild(cards);

        const current = state.spend[state.range];
        const source = spendSourceNote(current ?? state.spend.today ?? null, t);
        if (source) spendHost.appendChild(el('div', { class: 'nanovia-notice nanovia-notice-warn', text: source }));

        spendHost.appendChild(
            field(
                t('account.spend.details'),
                select<SpendRange>({
                    value: state.range,
                    options: SPEND_RANGES.map((range) => ({ value: range, label: t(`account.range.${range}`) })),
                    label: t('account.spend.details'),
                    onChange: (value) => {
                        state.range = value;
                        drawSpend();
                    },
                }),
            ),
        );
        if (current) {
            if (current.summary.total.requests === 0) {
                spendHost.appendChild(el('div', { class: 'nanovia-muted', text: t('account.spend.empty') }));
            } else {
                spendHost.append(
                    breakdownTable(
                        t('account.spend.byConnection'),
                        connectionRows(current.summary.byConnection, nameOf, t),
                    ),
                    breakdownTable(t('account.spend.byModel'), modelRows(current.summary.byModel)),
                );
                // Stage 0.7: a plugin that knows media also splits the spend by kind of request; an older one sends no such list.
                const byMedium = mediumRows(mediumRowsOf(current.summary), t);
                if (byMedium.length > 0) {
                    spendHost.appendChild(
                        breakdownTable(t('account.spend.byMedium'), byMedium, {
                            nameColumn: t('account.spend.col.medium'),
                            tokens: false,
                        }),
                    );
                }
            }
        }
    }

    function renderRecent(row: RecentRowSpec): HTMLElement {
        const lookup = row.requestId ? state.lookups.get(row.requestId) : undefined;
        const pluginUp = ctx.connections.pluginUp();
        const actions = el('div', { class: 'nanovia-row' });
        if (row.requestId) {
            const id = row.requestId;
            actions.appendChild(
                button({
                    label: t('account.recent.check'),
                    title: pluginUp ? t('account.recent.check.hint') : t('account.recent.check.needsPlugin'),
                    kind: 'ghost',
                    disabled: !pluginUp || lookup?.busy === true,
                    onClick: () => checkCost(id),
                }),
            );
        } else {
            actions.appendChild(el('span', { class: 'nanovia-muted', text: t('account.recent.noId') }));
        }
        if (lookup && !lookup.busy) {
            actions.appendChild(
                el('span', {
                    class: ['nanovia-lookup', `nanovia-lookup-${lookup.view.kind}`],
                    text: lookup.view.text,
                }),
            );
        }
        return el('div', { class: 'nanovia-card nanovia-recent-row', data: { request: row.requestId ?? '' } }, [
            el('div', { class: 'nanovia-recent-head' }, [
                el('span', { class: 'nanovia-muted', text: row.time }),
                el('b', { text: row.connection }),
                el('span', { class: 'nanovia-muted nanovia-recent-model', text: row.model }),
            ]),
            el('div', { class: 'nanovia-row nanovia-chips' }, [
                row.medium ? chip(row.medium.label, row.medium.kind) : null,
                chip(row.billing.label, row.billing.kind),
                row.source ? chip(row.source.label, row.source.kind, row.source.title) : null,
                row.error ? chip(row.error.label, 'error', row.error.title) : null,
            ]),
            el('div', { class: 'nanovia-recent-numbers' }, [
                el('span', { text: `${t('account.row.cost')}: ${row.cost}` }),
                el('span', { class: 'nanovia-muted', text: `${t('account.row.equivalent')}: ${row.equivalent}` }),
                row.units ? el('span', { class: 'nanovia-muted', text: row.units }) : null,
                row.tokens ? el('span', { class: 'nanovia-muted', text: row.tokens }) : null,
                row.cached ? el('span', { class: 'nanovia-muted', text: row.cached }) : null,
                el('span', { class: 'nanovia-muted', text: row.latency }),
            ]),
            actions,
        ]);
    }

    function drawRecent(): void {
        clear(recentHost);
        recentHost.appendChild(el('h4', { class: 'nanovia-account-title', text: t('account.recent.title') }));
        recentHost.appendChild(el('div', { class: 'nanovia-muted', text: t('account.recent.note') }));
        const now = Date.now();
        const records = ctx.usage.recent(RECENT_LIMIT);
        if (records.length === 0) {
            recentHost.appendChild(
                el('div', { class: 'nanovia-muted nanovia-empty', text: t('account.recent.empty') }),
            );
            return;
        }
        const list = el('div', { class: 'nanovia-cards' });
        records.forEach((record, index) => list.appendChild(renderRecent(recentRow(record, index, now, nameOf, t))));
        recentHost.appendChild(list);
    }

    function drawAll(): void {
        drawHead();
        drawAccount();
        drawSpend();
        drawRecent();
    }

    /* ---------------------------------------------------------------------------------------------- behaviour */

    async function loadKeys(): Promise<void> {
        if (ctx.connections.checked() && !ctx.connections.pluginUp()) {
            state.keys = null;
        } else {
            const result = await ctx.plugin.listKeys();
            state.keys = result.ok ? result.data : null;
        }
        if (!disposed) drawHead();
    }

    async function loadSpend(): Promise<void> {
        if (loading) {
            rerun = true;
            return;
        }
        loading = true;
        lastLoad = Date.now();
        drawSpend();
        try {
            const now = Date.now();
            const results = await Promise.all(
                SPEND_RANGES.map(
                    async (range) => [range, await ctx.usage.summary(rangeBounds(range, now, localMidnight))] as const,
                ),
            );
            for (const [range, result] of results) state.spend[range] = result;
        } finally {
            loading = false;
        }
        if (disposed) return;
        drawSpend();
        if (rerun) {
            rerun = false;
            void loadSpend();
        }
    }

    /** Records keep arriving while the tab is open; the summaries are asked for at most every few seconds. */
    function scheduleSpend(): void {
        if (disposed || trailing !== null) return;
        const wait = SPEND_THROTTLE_MS - (Date.now() - lastLoad);
        if (wait <= 0) {
            void loadSpend();
            return;
        }
        trailing = setTimeout(() => {
            trailing = null;
            void loadSpend();
        }, wait);
    }

    async function refreshAll(): Promise<void> {
        // Ask the plugin first: whether it answers decides what the stores do.
        await ctx.connections.refresh();
        await Promise.all([ctx.account.refresh({ force: true }), ctx.usage.refresh(), loadSpend(), loadKeys()]);
    }

    async function checkCost(requestId: string): Promise<void> {
        state.lookups.set(requestId, { busy: true });
        drawRecent();
        const result = await ctx.account.lookup(requestId);
        state.lookups.set(requestId, { busy: false, view: lookupView(result, t) });
        if (!disposed) drawRecent();
    }

    /* ------------------------------------------------------------------------------------------------ wiring */

    const stopWatching = ctx.usage.watch();
    const offs = [
        ctx.account.onChange(() => {
            if (disposed) return;
            drawHead();
            drawAccount();
        }),
        ctx.usage.onChange(() => {
            if (disposed) return;
            drawRecent();
            scheduleSpend();
        }),
        ctx.connections.onChange(() => {
            if (disposed) return;
            drawAccount();
            drawRecent();
        }),
    ];

    drawAll();
    void ctx.account.refresh();
    void loadSpend();
    void loadKeys();

    return () => {
        disposed = true;
        stopWatching();
        for (const off of offs) off();
        if (trailing !== null) clearTimeout(trailing);
        trailing = null;
    };
}
