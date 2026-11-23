// The Nanovia block in ST's Extensions panel: an inline drawer (like every other extension) in the right column
// #extensions_settings2 with a tab bar. Features add tabs through `registerTab`; ST opens and closes `.inline-drawer`
// itself through a delegated document listener (script.js), so no handler is needed for the drawer.
import type { I18n, Logger, PanelApi, TabDefinition, Unsubscribe } from '../core/types';
import { clear, el } from './dom';

export const PANEL_ROOT_ID = 'nanovia-settings';

export interface PanelDeps<Ctx> {
    i18n: I18n;
    log: Logger;
    /** What a tab's render() receives as its second argument. */
    ctx: () => Ctx;
    /** The tab that was open last (persisted by the caller). */
    getLastTab(): string;
    setLastTab(id: string): void;
}

export class SettingsPanel<Ctx> implements PanelApi<Ctx> {
    private readonly tabs = new Map<string, TabDefinition<Ctx>>();
    /** The tab the user wants open: the last one chosen (or remembered); it may be registered later than the others. */
    private preferred: string;
    private activeId = '';
    private disposeBody: (() => void) | null = null;
    private root: HTMLElement | null = null;
    private title: HTMLElement | null = null;
    private bar: HTMLElement | null = null;
    private body: HTMLElement | null = null;

    constructor(private readonly deps: PanelDeps<Ctx>) {
        this.preferred = deps.getLastTab();
    }

    /** Puts the drawer into the Extensions panel. false when the panel is not in the page (yet). */
    mount(): boolean {
        if (this.root) return true;
        if (typeof document === 'undefined') return false;
        const container =
            document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
        if (!container) {
            this.deps.log.debug('extensions panel not found; the Nanovia drawer is not mounted');
            return false;
        }
        document.getElementById(PANEL_ROOT_ID)?.remove();
        this.title = el('b', { text: this.deps.i18n.t('ui.title') });
        this.bar = el('div', { class: 'nanovia-tabs', attrs: { role: 'tablist' } });
        this.body = el('div', { class: 'nanovia-tab-body', attrs: { role: 'tabpanel' } });
        this.root = el('div', { class: 'extension_container nanovia-ui', attrs: { id: PANEL_ROOT_ID } }, [
            el('div', { class: 'inline-drawer' }, [
                el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
                    this.title,
                    el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
                ]),
                el('div', { class: 'inline-drawer-content nanovia-panel' }, [this.bar, this.body]),
            ]),
        ]);
        container.appendChild(this.root);
        this.activeId = this.pick();
        this.renderBar();
        this.renderBody();
        return true;
    }

    registerTab(tab: TabDefinition<Ctx>): Unsubscribe {
        if (this.tabs.has(tab.id)) this.deps.log.warn(`tab "${tab.id}" replaced`);
        this.tabs.set(tab.id, tab);
        this.refresh();
        return () => {
            if (this.tabs.get(tab.id) !== tab) return;
            this.tabs.delete(tab.id);
            this.refresh();
        };
    }

    /** Opens a tab by id (no-op for an unknown id). */
    select(id: string): void {
        if (!this.tabs.has(id)) return;
        this.preferred = id;
        this.deps.setLastTab(id);
        this.refresh();
    }

    /**
     * Shows the drawer to the user: opens ST's Extensions panel and the Nanovia drawer in it (each only when it is
     * closed; ST toggles both from its own delegated click handlers) and selects `tabId` when it is a known tab.
     * Best effort: a page without the Extensions panel just does nothing.
     */
    open(tabId?: string): void {
        if (tabId) this.select(tabId);
        if (!this.root && !this.mount()) return;
        const root = this.root;
        if (!root || typeof document === 'undefined') return;
        try {
            const block = document.getElementById('rm_extensions_block');
            const opener = document.querySelector<HTMLElement>('#extensions-settings-button .drawer-toggle');
            if (opener && block && !block.classList.contains('openDrawer')) opener.click();
            const header = root.querySelector<HTMLElement>('.inline-drawer-toggle');
            const icon = root.querySelector('.inline-drawer-icon');
            // ST flips `down` <-> `up` on the icon each time it toggles the drawer.
            if (header && icon?.classList.contains('down')) header.click();
            root.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        } catch (error) {
            this.deps.log.debug('could not open the Nanovia drawer', error);
        }
    }

    activeTab(): string {
        return this.activeId;
    }

    tabIds(): string[] {
        return this.ordered().map((tab) => tab.id);
    }

    /** The language changed: titles and the open tab are built again. */
    relabel(): void {
        if (this.title) this.title.textContent = this.deps.i18n.t('ui.title');
        this.renderBar();
        this.renderBody();
    }

    dispose(): void {
        this.releaseBody();
        this.tabs.clear();
        this.root?.remove();
        this.root = null;
        this.title = null;
        this.bar = null;
        this.body = null;
        this.activeId = '';
    }

    private ordered(): TabDefinition<Ctx>[] {
        return [...this.tabs.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    }

    private pick(): string {
        return this.tabs.has(this.preferred) ? this.preferred : (this.ordered()[0]?.id ?? '');
    }

    /** Rebuilds the tab bar; the body only when the open tab changed (so a new tab does not wipe a form being filled). */
    private refresh(): void {
        const next = this.pick();
        const changed = next !== this.activeId;
        this.activeId = next;
        this.renderBar();
        if (changed) this.renderBody();
    }

    private renderBar(): void {
        if (!this.bar) return;
        clear(this.bar);
        for (const tab of this.ordered()) {
            const active = tab.id === this.activeId;
            this.bar.appendChild(
                el('button', {
                    class: ['menu_button', 'nanovia-tab', active && 'nanovia-tab-active'],
                    text: this.deps.i18n.t(tab.titleKey),
                    data: { tab: tab.id },
                    attrs: { type: 'button', role: 'tab', 'aria-selected': String(active) },
                    on: { click: () => this.select(tab.id) },
                }),
            );
        }
    }

    private renderBody(): void {
        this.releaseBody();
        if (!this.body) return;
        clear(this.body);
        const tab = this.tabs.get(this.activeId);
        if (!tab) return;
        try {
            const dispose = tab.render(this.body, this.deps.ctx());
            this.disposeBody = typeof dispose === 'function' ? dispose : null;
        } catch (error) {
            this.deps.log.error(`tab ${tab.id} failed to render`, error);
            this.body.appendChild(el('div', { class: 'nanovia-error-text', text: this.deps.i18n.t('ui.tab.failed') }));
        }
    }

    private releaseBody(): void {
        const dispose = this.disposeBody;
        this.disposeBody = null;
        try {
            dispose?.();
        } catch (error) {
            this.deps.log.error('tab cleanup failed', error);
        }
    }
}
