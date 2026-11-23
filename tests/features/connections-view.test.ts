// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import { renderConnectionsTab } from '../../src/features/connections/view';
import { NANOGPT_API_BASE, SECRET_KEY_CUSTOM } from '../../src/shared/constants';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { seedConnection } from '../helpers/fake-backend';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { POPUP_RESULT } from '../helpers/st-mock';

const KEY = 'sk-nano-typed-in-the-form-0001';

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let dispose: () => void;

beforeEach(async () => {
    h = createHarness();
    tc = createContext(h);
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    dispose?.();
    root.remove();
    h.restore();
});

async function open(): Promise<void> {
    await h.connections.refresh();
    dispose = renderConnectionsTab(root, tc.ctx);
}

async function settle(): Promise<void> {
    await flush();
    await flush();
}

function button(label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!found)
        throw new Error(
            `no button "${label}"; buttons: ${[...root.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`,
        );
    return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
    button(label).click();
    await settle();
}

function input(label: string): HTMLInputElement | HTMLTextAreaElement {
    const found = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
    if (!found) throw new Error(`no field "${label}"`);
    return found;
}

function type(label: string, value: string): void {
    const field = input(label);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
}

function choose(label: string, value: string): void {
    const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (!select) throw new Error(`no select "${label}"`);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

const text = (): string => root.textContent ?? '';

describe('the status banner', () => {
    it('shows a running plugin with its port and version, and the empty list', async () => {
        await open();
        expect(text()).toContain('Plugin is running');
        expect(text()).toContain('port 8787 · version 0.1.0');
        expect(text()).toContain('No connections yet');
        expect(button('New connection')).toBeTruthy();
    });

    it('says it is checking, not that the plugin is down, until the first answer; the mirror shows meanwhile', async () => {
        h.settings.update((s) => {
            s.mirror.push(createConnection({ name: 'Remembered', modelId: 'm', mode: 'direct' }, 'direct0001', 1));
        });
        dispose = renderConnectionsTab(root, tc.ctx);
        expect(text()).toContain('Checking the plugin…');
        expect(text()).not.toContain('Plugin is not answering');
        expect(root.querySelector('.nanovia-banner-checking')).not.toBeNull();
        expect(text()).toContain('Remembered');
        await h.connections.refresh();
        expect(text()).toContain('Plugin is running');
        expect(text()).toContain('Remembered');
    });

    it('explains a dead plugin and how to install it', async () => {
        h.backend.plugin.up = false;
        await open();
        expect(text()).toContain('Plugin is not answering');
        expect(text()).toContain('no answer from the SillyTavern server');
        expect(text()).toContain('plugins/nanovia');
        expect(root.querySelector('.nanovia-banner-down')).not.toBeNull();
    });

    it('tells a plugin that is not installed apart from one that is down', async () => {
        h.backend.plugin.installed = false;
        await open();
        expect(text()).toContain('not installed or not enabled');
    });

    it('refresh asks the plugin again and follows it back up', async () => {
        h.backend.plugin.up = false;
        await open();
        h.backend.plugin.up = true;
        await click('Refresh');
        expect(text()).toContain('Plugin is running');
        expect(text()).toContain('Refreshed.');
    });

    it('speaks Russian when the language is Russian', async () => {
        tc.setLocale('ru');
        await open();
        expect(text()).toContain('Плагин работает');
        expect(button('Новое подключение')).toBeTruthy();
    });
});

describe('the list', () => {
    it('shows a card per connection with its chips and note', async () => {
        seedConnection(
            h.backend,
            { name: 'Main', modelId: 'deepseek/deepseek-v4', billing: 'subscription', note: 'my daily driver' },
            'seed000001',
        );
        await open();
        const card = root.querySelector('[data-connection="seed000001"]');
        expect(card?.textContent).toContain('Main');
        expect(card?.textContent).toContain('deepseek/deepseek-v4');
        expect(card?.textContent).toContain('Auto → plugin');
        expect(card?.textContent).toContain('Subscription only');
        expect(card?.textContent).toContain('No profile');
        expect(card?.textContent).toContain('my daily driver');
    });

    it('puts names and notes in as text, never as markup', async () => {
        seedConnection(
            h.backend,
            { name: '<img src=x onerror=alert(1)>', modelId: 'm', note: '<b>bold</b>' },
            'seed000001',
        );
        await open();
        expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('.nanovia-card-note b')).toBeNull();
        expect(text()).toContain('<img src=x onerror=alert(1)>');
    });

    it('creates the missing profile and shows the new state', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'm' }, 'seed000001');
        await open();
        await click('Create profile');
        expect(h.manager.profiles).toHaveLength(1);
        expect(text()).toContain('Profile linked');
        expect(text()).toContain('Profile updated.');
    });

    it('issues a new token and says so', async () => {
        const result = await h.connections.save({ patch: { name: 'Main', modelId: 'm', mode: 'plugin' } });
        if (!result.ok) throw new Error('save failed');
        await open();
        const before = h.backend.plugin.tokens.get(result.data.id);
        await click('New token');
        expect(h.backend.plugin.tokens.get(result.data.id)).not.toBe(before);
        expect(text()).toContain('New token issued');
    });
});

describe('creating a connection', () => {
    it('creates a plugin connection and its profile from the form', async () => {
        await open();
        await click('New connection');
        type('Name', 'Daily');
        type('Model id', 'deepseek/deepseek-v4');
        choose('How it connects', 'plugin');
        choose('Billing', 'subscription');
        await click('Save');
        expect(text()).toContain('Connection saved.');
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created).toMatchObject({
            name: 'Daily',
            modelId: 'deepseek/deepseek-v4',
            mode: 'plugin',
            billing: 'subscription',
        });
        expect(h.manager.profiles[0]?.name).toBe('Nanovia · Daily');
        // Back to the list, with the new card.
        expect(root.querySelector('form')).toBeNull();
        expect(root.querySelector(`[data-connection="${created?.id}"]`)?.textContent).toContain('Daily');
    });

    it('sends the reasoning choices and the web-search toggle', async () => {
        await open();
        await click('New connection');
        type('Name', 'R');
        type('Model id', 'm');
        choose('Reasoning', 'fixed');
        choose('Reasoning effort', 'high');
        const toggles = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        toggles[1]!.checked = true;
        toggles[1]!.dispatchEvent(new Event('change', { bubbles: true }));
        await click('Save');
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created?.reasoning).toMatchObject({ policy: 'fixed', effort: 'high' });
        expect(created?.webSearch).toBe(true);
    });

    it('does not submit an empty form', async () => {
        await open();
        await click('New connection');
        await click('Save');
        expect(text()).toContain('The name is required.');
        expect(h.backend.plugin.connections.size).toBe(0);
        expect(root.querySelector('form')).not.toBeNull();
    });

    it('cancel goes back to the list without saving', async () => {
        await open();
        await click('New connection');
        type('Name', 'Nope');
        await click('Cancel');
        expect(root.querySelector('form')).toBeNull();
        expect(h.backend.plugin.connections.size).toBe(0);
    });

    it('shows what the plugin refused and keeps the form open', async () => {
        h.backend.plugin.failNext.set('POST /connections', {
            status: 400,
            code: 'bad_request',
            message: 'model unknown',
        });
        await open();
        await click('New connection');
        type('Name', 'A');
        type('Model id', 'm');
        choose('How it connects', 'plugin');
        await click('Save');
        expect(text()).toContain('The plugin refused the request: model unknown');
        expect(root.querySelector('form')).not.toBeNull();
    });

    it('a form that is open survives a background refresh', async () => {
        await open();
        await click('New connection');
        type('Name', 'Half typed');
        await h.connections.refresh();
        expect((input('Name') as HTMLInputElement).value).toBe('Half typed');
    });
});

describe('keys', () => {
    it("lists the plugin's keys, adds one without keeping its value, and selects it", async () => {
        h.backend.plugin.keys.push({ id: 'key-a', label: 'First', active: true, masked: 'sk-nano-…1111' });
        await open();
        await click('New connection');
        choose('How it connects', 'plugin');
        await settle();
        const select = root.querySelector<HTMLSelectElement>('select[aria-label="NanoGPT key"]')!;
        expect([...select.options].map((o) => o.textContent)).toEqual([
            'The active key',
            'First · sk-nano-…1111 (The active key)',
        ]);

        type('Key name', 'Second');
        type('Paste the key here', KEY);
        await click('Save key');
        expect([...h.backend.plugin.keyValues.values()]).toEqual([KEY]);
        expect(text()).toContain('Key added.');
        const after = root.querySelector<HTMLSelectElement>('select[aria-label="NanoGPT key"]')!;
        expect(after.options).toHaveLength(3);
        expect(after.value).toBe([...h.backend.plugin.keyValues.keys()][0]);
        // The typed value is gone from every field of the form, and from the page.
        for (const field of root.querySelectorAll<HTMLInputElement>('input')) expect(field.value).not.toBe(KEY);
        expect(root.innerHTML).not.toContain(KEY);
    });

    it('says the key list needs the plugin when it is down', async () => {
        h.backend.plugin.up = false;
        await open();
        await click('New connection');
        choose('How it connects', 'plugin');
        expect(text()).toContain('The key list needs the plugin.');
        expect(text()).toContain('Plugin-mode settings are saved here');
    });
});

describe('direct mode', () => {
    it('asks for the key in a password field, writes it to ST once and forgets it', async () => {
        h.backend.secrets.set(SECRET_KEY_CUSTOM, [{ id: 'mine', value: 'my-own', label: 'Mine', active: true }]);
        await open();
        await click('New connection');
        type('Name', 'Direct');
        type('Model id', 'm');
        choose('How it connects', 'direct');
        const field = root.querySelector<HTMLInputElement>('input[aria-label="NanoGPT key"]')!;
        expect(field.type).toBe('password');
        expect(field.getAttribute('autocomplete')).toBe('off');

        await click('Save');
        expect(text()).toContain('Enter your NanoGPT key');
        expect(h.backend.plugin.connections.size).toBe(0);

        type('NanoGPT key', KEY);
        await click('Save');
        expect(text()).toContain('Connection saved.');
        const rows = h.backend.secrets.get(SECRET_KEY_CUSTOM) ?? [];
        expect(rows.find((row) => row.value === KEY)).toBeTruthy();
        expect(rows.find((row) => row.active)?.id).toBe('mine');
        expect(h.manager.profiles[0]?.['api-url']).toBe(NANOGPT_API_BASE);
        expect(h.backend.plugin.connections.size).toBe(0);
        expect(root.innerHTML).not.toContain(KEY);
        expect(JSON.stringify(h.mock.extensionSettings)).not.toContain(KEY);
        expect(text()).toContain('Direct');
    });

    it('drops a key typed before the mode was changed to the plugin', async () => {
        await open();
        await click('New connection');
        type('Name', 'Changed my mind');
        type('Model id', 'm');
        choose('How it connects', 'direct');
        type('NanoGPT key', KEY);
        choose('How it connects', 'plugin');
        await click('Save');
        expect(text()).toContain('Connection saved.');
        expect(h.backend.secrets.get(SECRET_KEY_CUSTOM)?.some((row) => row.value === KEY) ?? false).toBe(false);
    });

    it('offers the switch to direct mode while the plugin is down, asking for the key once', async () => {
        const created = await h.connections.save({ patch: { name: 'Main', modelId: 'm', mode: 'plugin' } });
        if (!created.ok) throw new Error('save failed');
        h.backend.plugin.up = false;
        await open();
        await click('Switch to direct mode');
        expect(root.querySelector('form')).not.toBeNull();
        expect((root.querySelector('select[aria-label="How it connects"]') as HTMLSelectElement).value).toBe('direct');
        type('NanoGPT key', KEY);
        await click('Save');
        expect(h.connections.get(created.data.id)?.config.mode).toBe('direct');
        expect(h.manager.profiles[0]?.['api-url']).toBe(NANOGPT_API_BASE);
    });

    it('switches at once when a key is already on file', async () => {
        const created = await h.connections.save({
            patch: { name: 'Main', modelId: 'm', mode: 'direct' },
            directKey: KEY,
        });
        if (!created.ok) throw new Error('save failed');
        await h.connections.save({ id: created.data.id, patch: { mode: 'auto' } });
        h.backend.plugin.up = false;
        await open();
        await click('Switch to direct mode');
        expect(root.querySelector('form')).toBeNull();
        expect(text()).toContain('Switched to direct mode.');
        expect(h.connections.get(created.data.id)?.config.mode).toBe('direct');
    });
});

describe('deleting', () => {
    it('asks first, then removes the connection and its profile', async () => {
        const created = await h.connections.save({ patch: { name: 'Main', modelId: 'm', mode: 'plugin' } });
        if (!created.ok) throw new Error('save failed');
        await open();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        await click('Delete');
        expect(h.backend.plugin.connections.size).toBe(1);
        expect(h.mock.popups).toHaveLength(1);

        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        await click('Delete');
        expect(h.backend.plugin.connections.size).toBe(0);
        expect(h.manager.profiles).toHaveLength(0);
        expect(text()).toContain('Connection deleted.');
        expect(text()).toContain('No connections yet');
    });

    it('shows the plugin being down as the reason a plugin connection stays', async () => {
        const created = await h.connections.save({ patch: { name: 'Main', modelId: 'm', mode: 'plugin' } });
        if (!created.ok) throw new Error('save failed');
        await open();
        h.backend.plugin.up = false;
        await click('Delete');
        expect(text()).toContain('The plugin is not answering');
        expect(h.connections.list()).toHaveLength(1);
    });
});

describe('lifecycle', () => {
    it('follows the service while open and stops after dispose', async () => {
        await open();
        expect(text()).toContain('No connections yet');
        await h.connections.save({ patch: { name: 'Later', modelId: 'm', mode: 'plugin' } });
        expect(text()).toContain('Later');
        dispose();
        await h.connections.save({ patch: { name: 'After dispose', modelId: 'm', mode: 'plugin' } });
        expect(text()).not.toContain('After dispose');
    });

    it('does not touch the page after dispose even when a form was open', async () => {
        await open();
        await click('New connection');
        type('Name', 'Draft');
        dispose();
        const before = root.innerHTML;
        await h.connections.refresh();
        await h.connections.save({ patch: { name: 'Elsewhere', modelId: 'm', mode: 'plugin' } });
        expect(root.innerHTML).toBe(before);
    });
});

describe('Context Memory', () => {
    const holder = globalThis as unknown as Record<string, unknown>;

    afterEach(() => {
        delete holder['memory_intercept_messages'];
    });

    function memoryToggle(): HTMLInputElement {
        const label = [...root.querySelectorAll('label')].find(
            (node) => node.textContent?.trim() === 'NanoGPT Context Memory',
        );
        const found = label?.querySelector('input');
        if (!found) throw new Error('no Context Memory switch');
        return found;
    }

    function switchMemory(on: boolean): void {
        const box = memoryToggle();
        box.checked = on;
        box.dispatchEvent(new Event('change', { bubbles: true }));
    }

    it('is off by default, with the days field waiting, a hint about the bill and no warning', async () => {
        await open();
        await click('New connection');
        expect(memoryToggle().checked).toBe(false);
        expect((input('Keep for N days') as HTMLInputElement).disabled).toBe(true);
        expect((input('Keep for N days') as HTMLInputElement).placeholder).toBe('default');
        expect(text()).toContain('Billed separately from the subscription; off by default.');
        expect(root.querySelector('.nanovia-notice-warn')).toBeNull();
    });

    it('switching it on opens the days field, and Save sends both to the plugin', async () => {
        await open();
        await click('New connection');
        type('Name', 'Mem');
        type('Model id', 'm');
        choose('How it connects', 'plugin');
        switchMemory(true);
        expect((input('Keep for N days') as HTMLInputElement).disabled).toBe(false);
        type('Keep for N days', '30');
        await click('Save');
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created?.memory).toEqual({ enabled: true, expirationDays: 30 });
    });

    it('an empty days field means the default', async () => {
        await open();
        await click('New connection');
        type('Name', 'Mem');
        type('Model id', 'm');
        choose('How it connects', 'plugin');
        switchMemory(true);
        await click('Save');
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created?.memory).toEqual({ enabled: true, expirationDays: null });
    });

    it('is not saved with days that make no sense, and says why', async () => {
        await open();
        await click('New connection');
        type('Name', 'Mem');
        type('Model id', 'm');
        choose('How it connects', 'plugin');
        switchMemory(true);
        type('Keep for N days', '400');
        await click('Save');
        expect(text()).toContain('Days of Context Memory must be a whole number from 1 to 365');
        expect(h.backend.plugin.connections.size).toBe(0);
        expect(root.querySelector('form')).not.toBeNull();
        // Typed days are kept while the switch is off, and are not judged then.
        switchMemory(false);
        await click('Save');
        expect([...h.backend.plugin.connections.values()][0]?.memory.enabled).toBe(false);
    });

    it('shows the memory of a connection that is edited, and switching it off is saved', async () => {
        seedConnection(
            h.backend,
            { name: 'Remembering', modelId: 'm', mode: 'plugin', memory: { enabled: true, expirationDays: 7 } },
            'seed000001',
        );
        await open();
        await click('Edit');
        expect(memoryToggle().checked).toBe(true);
        expect((input('Keep for N days') as HTMLInputElement).value).toBe('7');
        expect((input('Keep for N days') as HTMLInputElement).disabled).toBe(false);
        switchMemory(false);
        await click('Save');
        expect(h.backend.plugin.connections.get('seed000001')?.memory.enabled).toBe(false);
    });

    it('warns while Qvink Memory is on too, in the language of the interface', async () => {
        holder['memory_intercept_messages'] = () => {};
        await open();
        await click('New connection');
        expect(root.querySelector('.nanovia-memory .nanovia-notice-warn')?.textContent).toContain(
            'Qvink Memory is on and also keeps a summary of your chats.',
        );
        dispose();
        root.replaceChildren();
        tc.setLocale('ru');
        dispose = renderConnectionsTab(root, tc.ctx);
        await settle();
        await click('Новое подключение');
        expect(root.querySelector('.nanovia-memory .nanovia-notice-warn')?.textContent).toContain(
            'Qvink Memory включена',
        );
        expect(text()).toContain('Контекстная память NanoGPT');
    });

    it('does not warn when Qvink is switched off in SillyTavern', async () => {
        holder['memory_intercept_messages'] = () => {};
        h.mock.extensionSettings['disabledExtensions'] = ['third-party/SillyTavern-MessageSummarize'];
        await open();
        await click('New connection');
        expect(root.querySelector('.nanovia-memory .nanovia-notice-warn')).toBeNull();
    });
});
