// The «Keys» tab: the NanoGPT keys the plugin holds (several, with labels), which connections use each, a balance check,
// add and delete. A key's value is typed into a password field, posted once and forgotten: nothing here keeps it, and the
// plugin never sends it back (only the masked form).
import type { FeatureContext } from '../../core/context';
import type { KeyCheck, KeyInfo } from '../../shared/contracts';
import { button, chip, clear, el, textInput } from '../../ui';
import { checkLine, confirmDeleteText, keyName, keyRows, loadFailure, usersText } from './view-model';
import type { KeyRow, LoadFailure } from './view-model';

type NoticeKind = 'ok' | 'warn' | 'error';

export function renderKeysTab(root: HTMLElement, ctx: FeatureContext): () => void {
    const t = ctx.t;
    let keys: KeyInfo[] | null = null;
    let failure: LoadFailure | null = null;
    let loading = true;
    let disposed = false;
    /** Balance checks by key id; 'pending' while one runs. Lives as long as the tab. */
    const checks = new Map<string, KeyCheck | 'pending'>();

    const headHost = el('div', { class: 'nanovia-row nanovia-keys-head' });
    const noticeHost = el('div', { class: 'nanovia-notice-host', attrs: { 'aria-live': 'polite' } });
    const listHost = el('div', { class: 'nanovia-keys-body' });
    const addHost = el('div', { class: 'nanovia-keys-addhost' });
    root.append(headHost, noticeHost, listHost, addHost);

    function notify(kind: NoticeKind, text: string): void {
        clear(noticeHost);
        noticeHost.appendChild(el('div', { class: ['nanovia-notice', `nanovia-notice-${kind}`], text }));
    }

    /* ---------------------------------------------------------------------------------------------- drawing */

    function drawHead(): void {
        clear(headHost);
        headHost.append(
            el('b', { text: t('keys.title') }),
            button({
                label: t('keys.refresh'),
                icon: 'rotate',
                kind: 'ghost',
                onClick: async () => {
                    await load();
                    if (failure === null) notify('ok', t('keys.notice.refreshed'));
                },
            }),
        );
    }

    function drawCard(row: KeyRow): HTMLElement {
        const { key } = row;
        const users = usersText(row.users, t);
        const check = checks.get(key.id);
        const line = check && check !== 'pending' ? checkLine(check, t) : null;
        return el('div', { class: 'nanovia-key-card', data: { key: key.id } }, [
            el('div', { class: 'nanovia-row' }, [
                el('b', { class: 'nanovia-key-name', text: keyName(key) }),
                el('code', { class: 'nanovia-key-masked nanovia-muted', text: key.masked }),
                key.active ? chip(t('keys.active'), 'ok', t('keys.active.hint')) : null,
            ]),
            el('div', { class: 'nanovia-muted nanovia-key-users', text: users ?? t('keys.unused') }),
            line
                ? el('div', {
                      class: ['nanovia-key-check', line.kind === 'ok' ? 'nanovia-ok-text' : 'nanovia-error-text'],
                      text: line.text,
                  })
                : null,
            check === 'pending'
                ? el('div', { class: 'nanovia-muted nanovia-key-check', text: t('keys.check.running') })
                : null,
            el('div', { class: 'nanovia-row' }, [
                button({
                    label: t('keys.action.check'),
                    icon: 'wallet',
                    title: t('keys.action.check.hint'),
                    disabled: check === 'pending',
                    onClick: () => runCheck(key),
                }),
                button({
                    label: t('keys.action.delete'),
                    icon: 'trash',
                    kind: 'danger',
                    onClick: () => remove(row),
                }),
            ]),
        ]);
    }

    function drawList(): void {
        clear(listHost);
        if (failure) {
            listHost.appendChild(
                el('div', { class: 'nanovia-banner nanovia-banner-down' }, [
                    el('div', { class: 'nanovia-row' }, [chip(t('keys.down.title'), 'error')]),
                    el('div', { class: 'nanovia-error-text', text: failure.text }),
                    el('div', { class: 'nanovia-muted', text: t('keys.down.hint') }),
                ]),
            );
            return;
        }
        if (keys === null) {
            listHost.appendChild(el('div', { class: 'nanovia-muted', text: loading ? t('keys.loading') : '' }));
            return;
        }
        if (keys.length === 0) {
            listHost.appendChild(
                el('div', { class: 'nanovia-notice nanovia-notice-warn nanovia-no-keys', text: t('keys.none') }),
            );
            return;
        }
        const configs = ctx.connections.list().map((entry) => entry.config);
        listHost.appendChild(el('div', { class: 'nanovia-key-list' }, keyRows(keys, configs).map(drawCard)));
    }

    /** The add form is built once (so what is typed survives a redraw of the list) and hidden while the plugin is down. */
    function buildAddForm(): void {
        let keyLabel = '';
        let keyValue = '';
        const nameInput = textInput({
            value: '',
            label: t('keys.add.name'),
            placeholder: t('keys.add.name'),
            maxLength: 80,
            onInput: (value) => void (keyLabel = value),
        });
        const valueInput = textInput({
            value: '',
            type: 'password',
            label: t('keys.add.value'),
            placeholder: t('keys.add.value'),
            onInput: (value) => void (keyValue = value),
        });
        const submit = button({
            label: t('keys.add.save'),
            icon: 'key',
            kind: 'primary',
            onClick: async () => {
                const value = keyValue;
                const label = keyLabel.trim() || t('keys.add.defaultLabel');
                // The value leaves the input and the closure before the request: nothing keeps it afterwards.
                keyValue = '';
                valueInput.value = '';
                if (!value.trim()) {
                    notify('error', t('keys.add.empty'));
                    return;
                }
                const result = await ctx.plugin.addKey(label, value);
                if (!result.ok) {
                    notify('error', t('keys.add.failed', { message: result.error.message }));
                    return;
                }
                keyLabel = '';
                nameInput.value = '';
                await load();
                notify('ok', t('keys.add.added'));
                void ctx.connections.refresh();
            },
        });
        addHost.appendChild(
            el('details', { class: 'nanovia-details', attrs: { open: true } }, [
                el('summary', { text: t('keys.add.title') }),
                el('div', { class: 'nanovia-key-add' }, [
                    nameInput,
                    valueInput,
                    submit,
                    el('div', { class: 'nanovia-field-hint', text: t('keys.add.hint') }),
                ]),
            ]),
        );
    }

    function showAddForm(): void {
        addHost.hidden = failure !== null;
    }

    /* -------------------------------------------------------------------------------------------- behaviour */

    async function load(): Promise<void> {
        loading = true;
        if (keys === null) drawList();
        const result = await ctx.plugin.listKeys();
        if (disposed) return;
        loading = false;
        if (result.ok) {
            keys = result.data;
            failure = null;
        } else {
            keys = null;
            failure = loadFailure(result.error, t);
        }
        drawList();
        showAddForm();
    }

    async function runCheck(key: KeyInfo): Promise<void> {
        checks.set(key.id, 'pending');
        drawList();
        const result = await ctx.plugin.checkKey(key.id);
        if (disposed) return;
        checks.set(
            key.id,
            result.ok ? result.data : { ok: false, usdBalance: null, nanoBalance: null, error: result.error.message },
        );
        drawList();
    }

    async function remove(row: KeyRow): Promise<void> {
        const confirmed = await ctx.host.confirm(confirmDeleteText(row, t), t('keys.confirm.title'));
        if (!confirmed) return;
        const result = await ctx.plugin.deleteKey(row.key.id);
        if (!result.ok) {
            notify('error', t('keys.delete.failed', { message: result.error.message }));
            return;
        }
        checks.delete(row.key.id);
        await load();
        notify('ok', t('keys.delete.done'));
        void ctx.connections.refresh();
    }

    /* ----------------------------------------------------------------------------------------------- wiring */

    // Which connections use a key follows the connections; an open add form is not touched.
    const off = ctx.connections.onChange(() => {
        if (!disposed) drawList();
    });

    drawHead();
    buildAddForm();
    showAddForm();
    drawList();
    void load();

    return () => {
        disposed = true;
        off();
        checks.clear();
    };
}
