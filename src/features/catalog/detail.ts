// The detail of one model: description, prices, capabilities, a cost estimate for a turn, the ranked hosts, routing
// hints, and the two ways to put the model to use (a new connection, or an existing one). The static part is drawn once;
// the hosts, hints and actions follow the catalog store and the connections. The decisions are in view-model.ts.
import type { OpIssue, OpResult } from '../../core/connections';
import type { FeatureContext } from '../../core/context';
import { QUANTIZATION_ORDER } from '../../domain/catalog';
import type { CatalogModel, Quantization } from '../../shared/contracts';
import { button, chip, clear, el, icon, select, textInput, toggle } from '../../ui';
import type { SelectOption } from '../../ui';
import { append } from '../../ui/dom';
import { issueText } from '../connections/view-model';
import type { CatalogSession } from './session';
import {
    CAPABILITIES,
    HOST_PRIORITIES,
    costView,
    detailOf,
    hintViews,
    hostRows,
    hostsSummary,
    newConnectionPatch,
    parseCostInputs,
    parseNumber,
} from './view-model';
import type { HostPriority, HostRow } from './view-model';

export interface DetailDeps {
    ctx: FeatureContext;
    session: CatalogSession;
    /** The catalog id of the model. */
    modelId: string;
    back(): void;
}

export interface DetailHandle {
    /** The catalog store or the connections changed: redraw what depends on them. */
    refresh(): void;
    dispose(): void;
}

type NoticeKind = 'ok' | 'warn' | 'error';

function kv(label: string, value: string | Node | null): HTMLElement | null {
    if (value === null) return null;
    return el('div', { class: 'nanovia-kv' }, [
        el('span', { class: 'nanovia-kv-key nanovia-muted', text: label }),
        typeof value === 'string' ? el('span', { class: 'nanovia-kv-value', text: value }) : value,
    ]);
}

export function renderDetail(host: HTMLElement, deps: DetailDeps): DetailHandle {
    const { ctx, session, modelId } = deps;
    const t = ctx.t;
    const model = ctx.catalog.model(modelId);
    let disposed = false;
    /** Hints whose suggested routing goes into the new connection. */
    const applied = new Set<string>();
    let hostsState: 'loading' | 'ready' | 'failed' = ctx.catalog.providers(modelId) ? 'ready' : 'loading';
    let lastProviders = ctx.catalog.providers(modelId);
    let chosenConnection = '';

    if (!model) {
        host.appendChild(el('div', { class: 'nanovia-muted', text: t('catalog.list.empty') }));
        return { refresh: () => {}, dispose: () => {} };
    }
    const current: CatalogModel = model;
    const view = detailOf(current, t);

    const costResult = el('div', { class: 'nanovia-cost-result', attrs: { 'aria-live': 'polite' } });
    const hostsHost = el('div', { class: 'nanovia-detail-block nanovia-hosts-block' });
    const hintsHost = el('div', { class: 'nanovia-detail-block nanovia-hints-block' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });
    const actionsHost = el('div', { class: 'nanovia-detail-block nanovia-actions-block' });

    /* ------------------------------------------------------------------------------------------ static part */

    const chips: HTMLElement[] = [chip(view.category, 'muted')];
    if (view.subscription) chips.push(chip(view.subscription.label, 'ok', view.subscription.title));
    if (view.openWeights) chips.push(chip(t('catalog.cap.openWeights'), 'info'));

    const capabilities = el(
        'div',
        { class: 'nanovia-row nanovia-caps-row' },
        view.capabilities.map((cap) => {
            const spec = CAPABILITIES.find((item) => item.key === cap.key);
            return el(
                'span',
                {
                    class: ['nanovia-cap-line', cap.on ? 'nanovia-cap-on' : 'nanovia-cap-off'],
                    data: { cap: cap.key, on: cap.on ? 'yes' : 'no' },
                },
                [icon(spec?.icon ?? 'circle'), el('span', { text: t(`catalog.cap.${cap.key}`) })],
            );
        }),
    );

    const efforts: (Node | null)[] =
        view.efforts.length > 0
            ? [
                  el('div', { class: 'nanovia-row' }, [
                      el('span', { class: 'nanovia-muted', text: t('catalog.detail.efforts') }),
                      ...view.efforts.map((effort) => chip(effort, 'info')),
                  ]),
                  el('div', {
                      class: 'nanovia-muted',
                      text: t(
                          view.alwaysReasons ? 'catalog.detail.efforts.alwaysOn' : 'catalog.detail.efforts.optional',
                      ),
                  }),
              ]
            : [el('div', { class: 'nanovia-muted', text: t('catalog.detail.efforts.none') })];

    /* ------------------------------------------------------------------------------------------ cost */

    function drawCost(): void {
        clear(costResult);
        const cost = costView(current, session.cost, t);
        append(costResult, [
            kv(
                t('catalog.cost.turn'),
                cost.withoutCache ? `${cost.turn} (${t('catalog.cost.withoutCache')} ${cost.withoutCache})` : cost.turn,
            ),
            kv(t('catalog.cost.hundred'), cost.hundredTurns),
            cost.noCachePrice ? el('div', { class: 'nanovia-muted', text: t('catalog.cost.noCachePrice') }) : null,
            cost.subscriptionNote ? el('div', { class: 'nanovia-muted', text: cost.subscriptionNote }) : null,
        ]);
    }

    const promptInput = textInput({
        value: String(session.cost.promptTokens),
        label: t('catalog.cost.prompt'),
        onInput: () => updateCost(),
    });
    const completionInput = textInput({
        value: String(session.cost.completionTokens),
        label: t('catalog.cost.completion'),
        onInput: () => updateCost(),
    });
    const cachedInput = textInput({
        value: String(session.cost.cachedPercent),
        label: t('catalog.cost.cached'),
        onInput: () => updateCost(),
    });

    function updateCost(): void {
        session.cost = parseCostInputs(promptInput.value, completionInput.value, cachedInput.value);
        drawCost();
    }

    const costBlock = el('div', { class: 'nanovia-detail-block' }, [
        el('h5', { text: t('catalog.cost.title') }),
        el('div', { class: 'nanovia-muted', text: t('catalog.cost.hint') }),
        el('div', { class: 'nanovia-cost-inputs' }, [
            labelled(t('catalog.cost.prompt'), promptInput),
            labelled(t('catalog.cost.completion'), completionInput),
            labelled(t('catalog.cost.cached'), cachedInput),
        ]),
        costResult,
    ]);

    /* ------------------------------------------------------------------------------------------ hosts */

    function criteriaControls(table: HTMLElement): HTMLElement {
        const priorities: SelectOption<HostPriority>[] = HOST_PRIORITIES.map((value) => ({
            value,
            label: t(`catalog.hosts.priority.${value}`),
        }));
        const precisions: SelectOption<string>[] = [
            { value: '', label: t('catalog.hosts.prefer.none') },
            ...QUANTIZATION_ORDER.map((value) => ({ value, label: value })),
        ];
        const maxPrompt = textInput({
            value: session.hosts.maxPrompt === null ? '' : String(session.hosts.maxPrompt),
            label: t('catalog.hosts.maxPrompt'),
            placeholder: t('catalog.filter.maxPricePlaceholder'),
            onInput: (value) => {
                session.hosts.maxPrompt = parseNumber(value);
                drawTable(table);
            },
        });
        const maxCompletion = textInput({
            value: session.hosts.maxCompletion === null ? '' : String(session.hosts.maxCompletion),
            label: t('catalog.hosts.maxCompletion'),
            placeholder: t('catalog.filter.maxPricePlaceholder'),
            onInput: (value) => {
                session.hosts.maxCompletion = parseNumber(value);
                drawTable(table);
            },
        });
        return el('div', { class: 'nanovia-criteria' }, [
            labelled(
                t('catalog.hosts.priority'),
                select({
                    value: session.hosts.priority,
                    options: priorities,
                    label: t('catalog.hosts.priority'),
                    onChange: (value) => {
                        session.hosts.priority = value;
                        drawTable(table);
                    },
                }),
            ),
            labelled(
                t('catalog.hosts.prefer'),
                select({
                    value: session.hosts.preferQuantization,
                    options: precisions,
                    label: t('catalog.hosts.prefer'),
                    onChange: (value) => {
                        const known: Quantization | undefined = QUANTIZATION_ORDER.find((item) => item === value);
                        session.hosts.preferQuantization = known ?? '';
                        drawTable(table);
                    },
                }),
            ),
            labelled(t('catalog.hosts.maxPrompt'), maxPrompt),
            labelled(t('catalog.hosts.maxCompletion'), maxCompletion),
        ]);
    }

    function hostCell(row: HostRow): HTMLElement {
        const flags: HTMLElement[] = [];
        if (row.overMaxPrice) flags.push(chip(t('catalog.hosts.flag.overPrice'), 'warn'));
        if (row.belowQuantization) flags.push(chip(t('catalog.hosts.flag.belowQuantization'), 'warn'));
        if (row.unknownQuantization) flags.push(chip(t('catalog.hosts.flag.unknownQuantization'), 'muted'));
        return el('td', {}, [el('div', { class: 'nanovia-host-name' }, [el('b', { text: row.id }), ...flags])]);
    }

    function drawTable(table: HTMLElement): void {
        clear(table);
        const providers = ctx.catalog.providers(modelId);
        if (!providers || providers.providers.length === 0) return;
        const rows = hostRows(providers, session.hosts);
        const heads = ['rank', 'host', 'quantization', 'price', 'tps', 'ttft', 'uptime', 'features', 'score'];
        table.appendChild(
            el('table', { class: 'nanovia-hosts' }, [
                el('thead', {}, [
                    el(
                        'tr',
                        {},
                        heads.map((name) => el('th', { text: t(`catalog.hosts.col.${name}`) })),
                    ),
                ]),
                el(
                    'tbody',
                    {},
                    rows.map((row) =>
                        el('tr', { data: { host: row.id, rank: row.rank } }, [
                            el('td', { text: String(row.rank) }),
                            hostCell(row),
                            el('td', { text: row.quantization }),
                            el('td', { class: 'nanovia-nowrap', text: row.price }),
                            el('td', { text: row.tps }),
                            el('td', { text: row.ttft }),
                            el('td', { text: row.uptime }),
                            el('td', { class: 'nanovia-host-features nanovia-muted', text: row.features.join(', ') }),
                            el('td', { text: row.score }),
                        ]),
                    ),
                ),
            ]),
        );
    }

    function drawHosts(): void {
        clear(hostsHost);
        hostsHost.appendChild(el('h5', { text: t('catalog.hosts.title') }));
        const providers = ctx.catalog.providers(modelId);
        if (!providers) {
            if (hostsState === 'failed') {
                hostsHost.append(
                    el('div', { class: 'nanovia-error-text', text: t('catalog.hosts.unavailable') }),
                    button({ label: t('catalog.retry'), icon: 'rotate', onClick: () => loadHosts(true) }),
                );
            } else {
                hostsHost.appendChild(el('div', { class: 'nanovia-muted', text: t('catalog.hosts.loading') }));
            }
            return;
        }
        const summary = hostsSummary(providers);
        if (!summary.selection) {
            hostsHost.appendChild(el('div', { class: 'nanovia-muted', text: t('catalog.hosts.fixedRoute') }));
        }
        if (summary.autoTps !== null || summary.autoTtft !== null || summary.autoCache !== null) {
            hostsHost.appendChild(
                el('div', {
                    class: 'nanovia-muted',
                    text: t('catalog.hosts.auto', {
                        tps: summary.autoTps ?? '—',
                        ttft: summary.autoTtft ?? '—',
                        cache: summary.autoCache ?? '—',
                    }),
                }),
            );
        }
        if (providers.providers.length === 0) {
            if (summary.selection)
                hostsHost.appendChild(el('div', { class: 'nanovia-muted', text: t('catalog.hosts.none') }));
            return;
        }
        const table = el('div', { class: 'nanovia-hosts-scroll' });
        hostsHost.append(
            criteriaControls(table),
            table,
            el('div', { class: 'nanovia-muted', text: t('catalog.hosts.note') }),
        );
        drawTable(table);
    }

    async function loadHosts(force = false): Promise<void> {
        hostsState = 'loading';
        drawHosts();
        const result = await ctx.catalog.ensureProviders(modelId, { force });
        if (disposed) return;
        hostsState = result ? 'ready' : 'failed';
        lastProviders = ctx.catalog.providers(modelId);
        drawHosts();
        drawHints();
    }

    /* ------------------------------------------------------------------------------------------ hints */

    function drawHints(): void {
        clear(hintsHost);
        hintsHost.appendChild(el('h5', { text: t('catalog.hints.title') }));
        const hints = ctx.catalog.hints(modelId);
        const views = hintViews(hints, t);
        if (views.length === 0) {
            hintsHost.appendChild(el('div', { class: 'nanovia-muted', text: t('catalog.hints.none') }));
            return;
        }
        for (const hint of views) {
            hintsHost.appendChild(
                el(
                    'div',
                    {
                        class: ['nanovia-hint', `nanovia-hint-${hint.severity}`, hint.bypass && 'nanovia-hint-bypass'],
                        data: { hint: hint.code },
                    },
                    [
                        el('div', { class: 'nanovia-hint-text' }, [
                            icon(hint.severity === 'warn' ? 'triangle-exclamation' : 'circle-info'),
                            el('span', { text: hint.text }),
                        ]),
                        hint.suggestion
                            ? toggle({
                                  label: `${t('catalog.hints.apply')}: ${hint.suggestionText ?? ''}`,
                                  checked: applied.has(hint.code),
                                  onChange: (checked) => {
                                      if (checked) applied.add(hint.code);
                                      else applied.delete(hint.code);
                                  },
                              })
                            : null,
                    ],
                ),
            );
        }
    }

    /* ------------------------------------------------------------------------------------------ actions */

    function notify(kind: NoticeKind, text: string): void {
        clear(noticeHost);
        noticeHost.appendChild(el('div', { class: ['nanovia-notice', `nanovia-notice-${kind}`], text }));
    }

    function report(result: OpResult<unknown>, success: string): void {
        if (!result.ok) {
            notify('error', issueText(result.error, t));
            return;
        }
        const warnings: OpIssue[] = result.warnings;
        if (warnings.length === 0) notify('ok', success);
        else notify('warn', [success, ...warnings.map((warning) => issueText(warning, t))].join(' '));
    }

    function drawActions(): void {
        clear(actionsHost);
        const entries = ctx.connections.list();
        actionsHost.appendChild(
            el('div', { class: 'nanovia-row' }, [
                button({
                    label: t('catalog.action.create'),
                    title: t('catalog.action.createHint'),
                    icon: 'plus',
                    kind: 'primary',
                    onClick: async () => {
                        const patch = newConnectionPatch(current, ctx.catalog.hints(modelId), applied);
                        report(
                            await ctx.connections.save({ patch }),
                            t('catalog.notice.created', { name: patch.name }),
                        );
                    },
                }),
            ]),
        );
        if (entries.length === 0) {
            actionsHost.appendChild(el('div', { class: 'nanovia-muted', text: t('catalog.action.useIn.none') }));
            return;
        }
        if (!entries.some((entry) => entry.config.id === chosenConnection))
            chosenConnection = entries[0]?.config.id ?? '';
        const options: SelectOption<string>[] = entries.map((entry) => ({
            value: entry.config.id,
            label: `${entry.config.name} · ${entry.config.modelId}`,
        }));
        actionsHost.appendChild(
            el('div', { class: 'nanovia-row' }, [
                el('span', { class: 'nanovia-muted', text: t('catalog.action.useIn') }),
                select({
                    value: chosenConnection,
                    options,
                    label: t('catalog.action.useIn.select'),
                    onChange: (value) => void (chosenConnection = value),
                }),
                button({
                    label: t('catalog.action.useIn.apply'),
                    onClick: async () => {
                        const entry = ctx.connections.get(chosenConnection);
                        if (!entry) return;
                        const result = await ctx.connections.save({ id: entry.config.id, patch: { modelId } });
                        report(result, t('catalog.notice.updated', { name: entry.config.name, model: view.name }));
                    },
                }),
            ]),
        );
    }

    /* ------------------------------------------------------------------------------------------ assembly */

    host.append(
        el('div', { class: 'nanovia-row' }, [
            button({ label: t('catalog.detail.back'), icon: 'arrow-left', kind: 'ghost', onClick: () => deps.back() }),
        ]),
        el('div', { class: 'nanovia-detail-head' }, [
            el('h4', { class: 'nanovia-detail-name', text: view.name }),
            el('div', { class: 'nanovia-muted nanovia-detail-id', text: view.id }),
            el('div', { class: 'nanovia-row nanovia-chips' }, chips),
        ]),
        el('div', { class: 'nanovia-detail-description', text: view.description || t('catalog.detail.noDescription') }),
        el('div', { class: 'nanovia-detail-block' }, [
            el('h5', { text: t('catalog.detail.prices') }),
            kv(t('catalog.detail.price.prompt'), view.prices.prompt),
            kv(t('catalog.detail.price.completion'), view.prices.completion),
            kv(t('catalog.detail.price.cacheRead'), view.prices.cacheRead),
            kv(t('catalog.detail.context'), view.context),
            kv(t('catalog.detail.maxOutput'), view.maxOutput),
        ]),
        el('div', { class: 'nanovia-detail-block' }, [
            el('h5', { text: t('catalog.detail.capabilities') }),
            capabilities,
            ...efforts,
        ]),
        costBlock,
        hostsHost,
        hintsHost,
        noticeHost,
        actionsHost,
    );
    drawCost();
    drawHosts();
    drawHints();
    drawActions();
    if (hostsState === 'loading') void loadHosts();

    return {
        refresh() {
            if (disposed) return;
            const providers = ctx.catalog.providers(modelId);
            if (providers !== lastProviders) {
                lastProviders = providers;
                if (providers) hostsState = 'ready';
                drawHosts();
                drawHints();
            }
            drawActions();
        },
        dispose() {
            disposed = true;
        },
    };
}

/** A label above a control (the cost and criteria forms are narrow and stack on phones). */
function labelled(label: string, control: Node): HTMLElement {
    return el('label', { class: 'nanovia-labelled' }, [el('span', { class: 'nanovia-muted', text: label }), control]);
}
