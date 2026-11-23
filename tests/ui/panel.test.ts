// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import type { Locale, SettingsService } from '../../src/core/types';
import { Settings } from '../../src/core/settings';
import { GENERAL_TAB_ID, PANEL_ROOT_ID, SettingsPanel, UI_STRINGS, generalTab } from '../../src/ui';
import { memoryLogger } from '../helpers/fakes';
import type { MemoryLogger } from '../helpers/fakes';

interface Ctx {
    marker: string;
}

let locale: Locale;
let log: MemoryLogger;
let last: string;
let panel: SettingsPanel<Ctx>;

function makePanel(): SettingsPanel<Ctx> {
    const i18n = createI18n(() => locale);
    i18n.register(UI_STRINGS);
    i18n.register({
        en: { 'test.a': 'Alpha', 'test.b': 'Beta', 'test.c': 'Gamma' },
        ru: { 'test.a': 'Альфа', 'test.b': 'Бета', 'test.c': 'Гамма' },
    });
    return new SettingsPanel<Ctx>({
        i18n,
        log,
        ctx: () => ({ marker: 'ctx' }),
        getLastTab: () => last,
        setLastTab: (id) => void (last = id),
    });
}

beforeEach(() => {
    locale = 'en';
    log = memoryLogger();
    last = '';
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    panel = makePanel();
});

afterEach(() => {
    panel.dispose();
    document.body.innerHTML = '';
});

const root = () => document.getElementById(PANEL_ROOT_ID);
const titles = () => [...document.querySelectorAll('.nanovia-tab')].map((tab) => tab.textContent);
const body = () => document.querySelector('.nanovia-tab-body')!;

function tab(
    id: string,
    order: number,
    render: (el: HTMLElement, ctx: Ctx) => void | (() => void) = (el) => void (el.textContent = id),
) {
    return { id, titleKey: `test.${id}`, order, render };
}

describe('mounting', () => {
    it('puts an ST inline drawer into the Extensions panel', () => {
        expect(panel.mount()).toBe(true);
        expect(document.querySelector('#extensions_settings2 #nanovia-settings .inline-drawer')).not.toBeNull();
        expect(document.querySelector('.inline-drawer-header b')?.textContent).toBe('Nanovia');
        expect(document.querySelector('.inline-drawer-content')).not.toBeNull();
    });

    it('does nothing, and says so, without an Extensions panel; a later mount works', () => {
        document.body.innerHTML = '';
        expect(panel.mount()).toBe(false);
        expect(root()).toBeNull();
        document.body.innerHTML = '<div id="extensions_settings"></div>';
        expect(panel.mount()).toBe(true);
        expect(document.querySelector('#extensions_settings #nanovia-settings')).not.toBeNull();
    });

    it('is idempotent and replaces a drawer left by an earlier instance', () => {
        panel.mount();
        panel.mount();
        expect(document.querySelectorAll(`#${PANEL_ROOT_ID}`)).toHaveLength(1);
        const second = makePanel();
        second.mount();
        expect(document.querySelectorAll(`#${PANEL_ROOT_ID}`)).toHaveLength(1);
        second.dispose();
        expect(root()).toBeNull();
    });

    it('renders tabs registered before the drawer exists', () => {
        panel.registerTab(tab('a', 1));
        expect(root()).toBeNull();
        panel.mount();
        expect(titles()).toEqual(['Alpha']);
        expect(body().textContent).toBe('a');
    });
});

describe('tabs', () => {
    it('orders them by `order`, then id, and opens the first', () => {
        panel.mount();
        panel.registerTab(tab('c', 30));
        panel.registerTab(tab('b', 20));
        panel.registerTab(tab('a', 20));
        expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma']);
        expect(panel.tabIds()).toEqual(['a', 'b', 'c']);
        expect(panel.activeTab()).toBe('a');
        expect(body().textContent).toBe('a');
        expect(document.querySelector('.nanovia-tab-active')?.textContent).toBe('Alpha');
    });

    it('hands the context to render and gives the tab a role and a selected state', () => {
        panel.mount();
        const render = vi.fn();
        panel.registerTab(tab('a', 1, render));
        expect(render).toHaveBeenCalledWith(body(), { marker: 'ctx' });
        const button = document.querySelector('.nanovia-tab')!;
        expect(button.getAttribute('role')).toBe('tab');
        expect(button.getAttribute('aria-selected')).toBe('true');
        expect(document.querySelector('.nanovia-tabs')?.getAttribute('role')).toBe('tablist');
    });

    it('switches on click, cleaning up the tab that closes, and remembers the choice', () => {
        panel.mount();
        const cleanup = vi.fn();
        panel.registerTab(
            tab('a', 1, (el) => {
                el.textContent = 'A body';
                return cleanup;
            }),
        );
        panel.registerTab(tab('b', 2));
        (document.querySelectorAll('.nanovia-tab')[1] as HTMLButtonElement).click();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(body().textContent).toBe('b');
        expect(last).toBe('b');
        expect(panel.activeTab()).toBe('b');
        panel.select('nope');
        expect(panel.activeTab()).toBe('b');
    });

    it('opens the remembered tab even when it registers after the others', () => {
        // The panel reads the remembered tab when it is created (the settings are loaded by then).
        last = 'c';
        panel = makePanel();
        panel.mount();
        panel.registerTab(tab('a', 1));
        expect(panel.activeTab()).toBe('a');
        panel.registerTab(tab('c', 3));
        expect(panel.activeTab()).toBe('c');
        expect(body().textContent).toBe('c');
        // A tab registered after that does not wipe the open one.
        const render = vi.fn();
        panel.registerTab(tab('d', 4, render));
        expect(render).not.toHaveBeenCalled();
        expect(panel.activeTab()).toBe('c');
    });

    it('falls back to the first tab when the open one goes away', () => {
        panel.mount();
        panel.registerTab(tab('a', 1));
        const off = panel.registerTab(tab('b', 2));
        panel.select('b');
        off();
        expect(panel.activeTab()).toBe('a');
        expect(titles()).toEqual(['Alpha']);
        expect(body().textContent).toBe('a');
    });

    it('a replaced tab is not removed by its stale unsubscribe', () => {
        panel.mount();
        const first = panel.registerTab(tab('a', 1));
        panel.registerTab(tab('a', 1, (el) => void (el.textContent = 'second')));
        first();
        expect(panel.tabIds()).toEqual(['a']);
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
    });

    it('shows an error line for a tab that fails to render, and logs it', () => {
        panel.mount();
        panel.registerTab(
            tab('a', 1, () => {
                throw new Error('boom');
            }),
        );
        expect(body().textContent).toBe(UI_STRINGS.en['ui.tab.failed']);
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('survives a cleanup that throws', () => {
        panel.mount();
        panel.registerTab(
            tab('a', 1, () => () => {
                throw new Error('cleanup');
            }),
        );
        panel.registerTab(tab('b', 2));
        expect(() => panel.select('b')).not.toThrow();
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('relabel rebuilds titles and the open tab in the new language', () => {
        panel.mount();
        const render = vi.fn();
        panel.registerTab(tab('a', 1, render));
        locale = 'ru';
        panel.relabel();
        expect(titles()).toEqual(['Альфа']);
        expect(render).toHaveBeenCalledTimes(2);
    });

    it("dispose runs the open tab's cleanup and removes the drawer", () => {
        panel.mount();
        const cleanup = vi.fn();
        panel.registerTab(tab('a', 1, () => cleanup));
        panel.dispose();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(root()).toBeNull();
    });
});

describe('the general tab', () => {
    function makeSettings(): SettingsService {
        const store: Record<string, unknown> = {};
        return new Settings(
            () => store,
            () => {},
            log,
        );
    }

    it('changes the language and debug switch in the settings', () => {
        const settings = makeSettings();
        const i18n = createI18n(() => locale);
        i18n.register(UI_STRINGS);
        panel.mount();
        panel.registerTab(generalTab<Ctx>({ settings, i18n, version: '1.2.3' }) as never);
        expect(panel.activeTab()).toBe(GENERAL_TAB_ID);
        expect(body().textContent).toContain('Version 1.2.3');

        const select = body().querySelector('select')!;
        expect([...select.options].map((o) => o.value)).toEqual(['auto', 'ru', 'en']);
        select.value = 'ru';
        select.dispatchEvent(new Event('change'));
        expect(settings.get().uiLanguage).toBe('ru');

        const debug = body().querySelector('input[type="checkbox"]') as HTMLInputElement;
        debug.checked = true;
        debug.dispatchEvent(new Event('change'));
        expect(settings.get().debug).toBe(true);
    });

    it('is the last tab', () => {
        const settings = makeSettings();
        const i18n = createI18n(() => locale);
        i18n.register(UI_STRINGS);
        panel.registerTab(tab('a', 100));
        panel.registerTab(generalTab<Ctx>({ settings, i18n, version: '1' }) as never);
        expect(panel.tabIds()).toEqual(['a', GENERAL_TAB_ID]);
    });
});
