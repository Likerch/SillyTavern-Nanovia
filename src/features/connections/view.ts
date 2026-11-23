// The «Connections» tab: the plugin status, the list of connections with their actions, and the create/edit form.
// All decisions (what to show, what a form turns into, what a message says) are in view-model.ts; this file draws.
import type { ConnectionEntry, OpIssue, OpResult } from '../../core/connections';
import type { FeatureContext } from '../../core/context';
import type { KeyInfo } from '../../shared/contracts';
import { button, chip, clear, el } from '../../ui';
import { renderConnectionForm } from './form';
import {
    actionsFor,
    bannerFor,
    chipsFor,
    emptyForm,
    formFromConfig,
    issueText,
    patchFromForm,
    validateForm,
} from './view-model';
import type { ActionId, FormState } from './view-model';

type NoticeKind = 'ok' | 'warn' | 'error';

interface ViewState {
    editing: { form: FormState; entry: ConnectionEntry | null } | null;
    /** The plugin's keys; null while unknown. */
    keys: KeyInfo[] | null;
    notice: { kind: NoticeKind; text: string } | null;
}

export function renderConnectionsTab(root: HTMLElement, ctx: FeatureContext): () => void {
    const t = ctx.t;
    const state: ViewState = { editing: null, keys: null, notice: null };
    let disposed = false;

    const bannerHost = el('div', { class: 'nanovia-banner-host' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });
    const bodyHost = el('div', { class: 'nanovia-connections-body' });
    root.append(bannerHost, noticeHost, bodyHost);

    function notify(kind: NoticeKind, text: string): void {
        state.notice = { kind, text };
        drawNotice();
    }

    /** Shows the outcome of an operation: its error, or its success text followed by any warnings. */
    function report(result: OpResult<unknown>, success: string): boolean {
        if (!result.ok) {
            notify('error', issueText(result.error, t));
            return false;
        }
        const warnings: OpIssue[] = result.warnings;
        if (warnings.length === 0) notify('ok', success);
        else notify('warn', [success, ...warnings.map((warning) => issueText(warning, t))].join(' '));
        return true;
    }

    /* ---------------------------------------------------------------------------------------------- drawing */

    function drawBanner(): void {
        clear(bannerHost);
        const up = ctx.connections.pluginUp();
        const banner = bannerFor(
            ctx.connections.pluginStatus(),
            ctx.connections.pluginError(),
            up,
            t,
            ctx.connections.checked(),
        );
        const header = el('div', { class: 'nanovia-row' }, [
            chip(banner.title, banner.state === 'up' ? 'ok' : banner.state === 'down' ? 'error' : 'muted'),
            banner.detail ? el('span', { class: 'nanovia-muted', text: banner.detail }) : null,
            button({
                label: t('connections.refresh'),
                icon: 'rotate',
                kind: 'ghost',
                onClick: async () => {
                    await ctx.connections.refresh();
                    notify('ok', t('connections.notice.refreshed'));
                },
            }),
        ]);
        const box = el('div', { class: ['nanovia-banner', `nanovia-banner-${banner.state}`] }, [header]);
        if (banner.advice) {
            box.appendChild(
                el('div', { class: banner.up ? 'nanovia-error-text' : 'nanovia-muted', text: banner.advice }),
            );
        }
        bannerHost.appendChild(box);
    }

    function drawNotice(): void {
        clear(noticeHost);
        if (!state.notice) return;
        noticeHost.appendChild(
            el('div', { class: ['nanovia-notice', `nanovia-notice-${state.notice.kind}`], text: state.notice.text }),
        );
    }

    function drawBody(): void {
        clear(bodyHost);
        if (state.editing) {
            const { form, entry } = state.editing;
            bodyHost.appendChild(
                renderConnectionForm({
                    ctx,
                    form,
                    entry,
                    keys: state.keys,
                    redraw: drawBody,
                    save: saveForm,
                    cancel: closeForm,
                    addKey,
                }),
            );
            return;
        }
        bodyHost.appendChild(
            el('div', { class: 'nanovia-row' }, [
                button({
                    label: t('connections.new'),
                    icon: 'plus',
                    kind: 'primary',
                    onClick: () => openForm(emptyForm(), null),
                }),
            ]),
        );
        const entries = ctx.connections.list();
        if (entries.length === 0) {
            bodyHost.appendChild(el('div', { class: 'nanovia-muted nanovia-empty', text: t('connections.empty') }));
            return;
        }
        const list = el('div', { class: 'nanovia-cards' });
        for (const entry of entries) list.appendChild(renderCard(entry));
        bodyHost.appendChild(list);
    }

    function renderCard(entry: ConnectionEntry): HTMLElement {
        const pluginUp = ctx.connections.pluginUp();
        const chips = chipsFor(entry, pluginUp, t).map((spec) => chip(spec.label, spec.kind, spec.title));
        const actions = actionsFor(entry, pluginUp, t).map((action) =>
            button({
                label: action.label,
                title: action.title,
                kind: action.kind === 'danger' ? 'danger' : 'default',
                onClick: () => runAction(action.id, entry),
            }),
        );
        return el('div', { class: 'nanovia-card', data: { connection: entry.config.id } }, [
            el('div', { class: 'nanovia-card-head' }, [
                el('b', { class: 'nanovia-card-name', text: entry.config.name }),
                el('span', { class: 'nanovia-muted nanovia-card-model', text: entry.config.modelId }),
            ]),
            el('div', { class: 'nanovia-row nanovia-chips' }, chips),
            entry.config.note ? el('div', { class: 'nanovia-muted nanovia-card-note', text: entry.config.note }) : null,
            el('div', { class: 'nanovia-row nanovia-card-actions' }, actions),
        ]);
    }

    function drawAll(): void {
        drawBanner();
        drawNotice();
        drawBody();
    }

    /* --------------------------------------------------------------------------------------------- behaviour */

    async function loadKeys(): Promise<void> {
        if (!ctx.connections.pluginUp()) {
            state.keys = null;
            return;
        }
        const result = await ctx.plugin.listKeys();
        state.keys = result.ok ? result.data : null;
    }

    async function openForm(form: FormState, entry: ConnectionEntry | null): Promise<void> {
        state.notice = null;
        drawNotice();
        state.editing = { form, entry };
        drawBody();
        if (form.mode !== 'direct' && ctx.connections.pluginUp()) {
            await loadKeys();
            // Redraw only when the same form is still open (the user may have cancelled in the meantime).
            if (!disposed && state.editing?.form === form) drawBody();
        }
    }

    function closeForm(): void {
        state.editing = null;
        drawBody();
    }

    async function saveForm(): Promise<void> {
        const editing = state.editing;
        if (!editing) return;
        const { form, entry } = editing;
        const issues = validateForm(form, {
            pluginUp: ctx.connections.pluginUp(),
            hasDirectKey: entry?.hasDirectKey ?? false,
        });
        const first = issues[0];
        if (first) {
            notify(
                'error',
                issueText(
                    first.field === 'directKey'
                        ? { code: 'direct_key_required' }
                        : { code: 'invalid', params: { field: first.field } },
                    t,
                ),
            );
            return;
        }
        const result = await ctx.connections.save({
            id: form.id ?? undefined,
            patch: patchFromForm(form),
            directKey: form.directKey || undefined,
        });
        if (report(result, t('connections.notice.saved'))) {
            form.directKey = '';
            state.editing = null;
            drawBody();
        }
    }

    async function addKey(label: string, value: string): Promise<void> {
        const result = await ctx.plugin.addKey(label, value);
        if (!result.ok) {
            notify('error', issueText({ code: 'plugin_error', params: { message: result.error.message } }, t));
            return;
        }
        await loadKeys();
        if (state.editing) state.editing.form.keyId = result.data.id;
        notify('ok', t('connections.key.added'));
        drawBody();
    }

    async function runAction(action: ActionId, entry: ConnectionEntry): Promise<void> {
        const id = entry.config.id;
        switch (action) {
            case 'edit':
                await openForm(formFromConfig(entry.config), entry);
                return;
            case 'delete': {
                const confirmed = await ctx.host.confirm(
                    t('connections.confirm.delete', { name: entry.config.name }),
                    t('connections.confirm.title'),
                );
                if (!confirmed) return;
                report(await ctx.connections.remove(id), t('connections.notice.deleted'));
                return;
            }
            case 'rotate':
                report(await ctx.connections.rotateToken(id), t('connections.notice.rotated'));
                return;
            case 'switchDirect':
                if (entry.hasDirectKey) {
                    report(await ctx.connections.switchToDirect(id), t('connections.notice.switched'));
                } else {
                    // The key is asked once, in the form that already knows how.
                    await openForm({ ...formFromConfig(entry.config), mode: 'direct' }, entry);
                }
                return;
            case 'repairProfile':
                report(await ctx.connections.repairProfile(id), t('connections.notice.profile'));
                return;
            case 'sendToPlugin':
                report(await ctx.connections.sendToPlugin(id), t('connections.notice.sent'));
                return;
        }
    }

    /* ------------------------------------------------------------------------------------------------ wiring */

    // The list and the banner follow the service; an open form is left alone (it would lose what is typed).
    const off = ctx.connections.onChange(() => {
        if (disposed) return;
        drawBanner();
        if (!state.editing) drawBody();
    });

    drawAll();

    return () => {
        disposed = true;
        off();
        // Whatever was typed into the form (a key, maybe) goes with it.
        state.editing = null;
    };
}
