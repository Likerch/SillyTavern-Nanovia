// The «Routing» tab: pick a connection, edit its routing, billing mode and reasoning policy, watch the billing verdict
// change live, save through the connections service (which syncs the plugin and the Connection Manager profile).
// Decisions live in view-model.ts, the sections in sections.ts; this file is the shell: selector, notices, save/revert.
import type { OpResult } from '../../core/connections';
import type { FeatureContext } from '../../core/context';
import type { ConnectionConfig } from '../../shared/contracts';
import { button, chip, clear, el, select } from '../../ui';
import { issueText } from '../connections/view-model';
import { buildBillingSection, buildReasoningSection, buildRoutingSection } from './sections';
import type { SectionEnv, SectionView, ViewData } from './sections';
import {
    connectionLabel,
    controlStates,
    draftOf,
    isDirty,
    outcomeBadge,
    patchOf,
    reasoningCaps,
    reasoningPreview,
    verdictFor,
} from './view-model';
import type { RoutingDraft } from './view-model';

type NoticeKind = 'ok' | 'warn' | 'error';

export function renderRoutingTab(root: HTMLElement, ctx: FeatureContext): () => void {
    const t = ctx.t;
    let selected: string | null = null;
    let draft: RoutingDraft | null = null;
    let sections: SectionView[] = [];
    /** The saved values the draft was taken from, as text: tells an edit of the user from a change of the connection. */
    let shownBaseline = '';
    let disposed = false;
    let notice: { kind: NoticeKind; text: string } | null = null;

    const headHost = el('div', { class: 'nanovia-routing-head' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });
    const bodyHost = el('div', { class: 'nanovia-routing-body' });
    root.append(headHost, noticeHost, bodyHost);

    /** The chip that follows the draft in the header, filled in by `update()`. */
    const badgeHost = el('span', { class: 'nanovia-routing-badge' });
    const dirtyHost = el('span', { class: 'nanovia-routing-dirty' });

    /* ------------------------------------------------------------------------------------------ helpers */

    function baselineOf(config: ConnectionConfig): string {
        return JSON.stringify(patchOf(draftOf(config)));
    }

    function current() {
        return selected ? ctx.connections.get(selected) : null;
    }

    function drawNotice(): void {
        clear(noticeHost);
        if (!notice) return;
        noticeHost.appendChild(
            el('div', { class: ['nanovia-notice', `nanovia-notice-${notice.kind}`], text: notice.text }),
        );
    }

    function notify(kind: NoticeKind, text: string): void {
        notice = { kind, text };
        drawNotice();
    }

    function report(result: OpResult<unknown>, success: string): boolean {
        if (!result.ok) {
            notify('error', issueText(result.error, t));
            return false;
        }
        if (result.warnings.length === 0) notify('ok', success);
        else notify('warn', [success, ...result.warnings.map((warning) => issueText(warning, t))].join(' '));
        return true;
    }

    function compute(data: { config: ConnectionConfig; draft: RoutingDraft }): ViewData {
        const { config } = data;
        const model = ctx.catalog.model(config.modelId);
        const providers = ctx.catalog.providers(model?.id ?? config.modelId);
        const verdict = verdictFor(config, data.draft, model, providers?.supportsProviderSelection ?? null);
        return {
            config,
            draft: data.draft,
            model,
            providers,
            verdict,
            controls: controlStates(data.draft),
            caps: reasoningCaps(model),
            preview: reasoningPreview(model, data.draft.reasoning),
        };
    }

    /* ------------------------------------------------------------------------------------------ drawing */

    function update(): void {
        const entry = current();
        if (!entry || !draft) return;
        const data = compute({ config: entry.config, draft });
        for (const view of sections) view.update(data);
        const badge = outcomeBadge(data.verdict, t);
        clear(badgeHost);
        badgeHost.appendChild(chip(badge.label, badge.kind, t('routing.header.badge.hint')));
        clear(dirtyHost);
        if (isDirty(entry.config, draft)) dirtyHost.appendChild(chip(t('routing.dirty'), 'warn'));
    }

    function buildBody(): void {
        clear(bodyHost);
        sections = [];
        const entry = current();
        if (!entry || !draft) {
            bodyHost.appendChild(el('div', { class: 'nanovia-muted nanovia-empty', text: t('routing.empty') }));
            return;
        }
        const env: SectionEnv = {
            ctx,
            t,
            draft,
            changed: update,
            rebuild: () => {
                buildBody();
            },
        };
        sections = [buildRoutingSection(env), buildBillingSection(env), buildReasoningSection(env)];
        for (const view of sections) bodyHost.appendChild(view.node);
        update();
    }

    function drawHead(): void {
        clear(headHost);
        const entries = ctx.connections.list();
        if (entries.length === 0) return;
        const chooser = select({
            value: selected ?? '',
            options: entries.map((entry) => ({ value: entry.config.id, label: connectionLabel(entry.config) })),
            label: t('routing.connection'),
            onChange: (id) => void choose(id),
        });
        headHost.appendChild(
            el('div', { class: 'nanovia-row nanovia-routing-bar' }, [
                chooser,
                badgeHost,
                dirtyHost,
                button({ label: t('routing.save'), icon: 'check', kind: 'primary', onClick: () => save() }),
                button({ label: t('routing.revert'), icon: 'rotate-left', onClick: () => revert() }),
            ]),
        );
    }

    /* ------------------------------------------------------------------------------------------ behaviour */

    function loadHosts(): void {
        const entry = current();
        if (!entry) return;
        const modelId = entry.config.modelId;
        const id = ctx.catalog.model(modelId)?.id ?? modelId;
        void ctx.catalog.ensureProviders(id).then(() => {
            if (!disposed && current()?.config.modelId === modelId) update();
        });
    }

    async function choose(id: string): Promise<void> {
        const entry = current();
        if (id === selected) return;
        if (entry && draft && isDirty(entry.config, draft)) {
            const discard = await ctx.host.confirm(t('routing.confirm.discard'), t('routing.confirm.title'));
            if (!discard) {
                drawHead();
                update();
                return;
            }
        }
        open(id);
    }

    function open(id: string | null): void {
        selected = id;
        notice = null;
        drawNotice();
        const entry = current();
        draft = entry ? draftOf(entry.config) : null;
        shownBaseline = entry ? baselineOf(entry.config) : '';
        drawHead();
        buildBody();
        loadHosts();
    }

    function revert(): void {
        const entry = current();
        if (!entry) return;
        draft = draftOf(entry.config);
        shownBaseline = baselineOf(entry.config);
        buildBody();
        notify('ok', t('routing.notice.reverted'));
    }

    async function save(): Promise<void> {
        const entry = current();
        if (!entry || !draft) return;
        const result = await ctx.connections.save({ id: entry.config.id, patch: patchOf(draft) });
        report(result, t('routing.notice.saved'));
    }

    /** The connections changed (a save, a refresh): follow them unless the user has edits that would be lost. */
    function onConnections(): void {
        if (disposed) return;
        const entry = current();
        if (!entry) {
            open(ctx.connections.list()[0]?.config.id ?? null);
            return;
        }
        const baseline = baselineOf(entry.config);
        if (draft && JSON.stringify(patchOf(draft)) === shownBaseline && baseline !== shownBaseline) {
            // Nothing unsaved, and the connection changed underneath: show it as it is now.
            draft = draftOf(entry.config);
            shownBaseline = baseline;
            drawHead();
            buildBody();
            return;
        }
        // Unsaved edits stay (a save makes them the connection's own: the dirty mark goes away by itself).
        shownBaseline = baseline;
        drawHead();
        update();
    }

    /* ------------------------------------------------------------------------------------------ wiring */

    const offConnections = ctx.connections.onChange(onConnections);
    const offCatalog = ctx.catalog.onChange(() => {
        if (!disposed) update();
    });

    open(ctx.connections.list()[0]?.config.id ?? null);

    return () => {
        disposed = true;
        offConnections();
        offCatalog();
        draft = null;
    };
}
