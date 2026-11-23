// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keysFeature } from '../../src/features/keys';
import { KEYS_STRINGS } from '../../src/features/keys/strings';
import { renderKeysTab } from '../../src/features/keys/view';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { seedConnection } from '../helpers/fake-backend';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { POPUP_RESULT } from '../helpers/st-mock';

const SECRET = 'sk-nano-pasted-value-0001-wxyz';

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(KEYS_STRINGS);
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    dispose?.();
    dispose = undefined;
    root.remove();
    h.restore();
});

async function settle(): Promise<void> {
    await flush();
    await flush();
}

async function open(): Promise<void> {
    await h.connections.refresh();
    dispose = renderKeysTab(root, tc.ctx);
    await settle();
}

const text = (): string => root.textContent ?? '';

function addKeyRow(label: string, value: string, active = false): string {
    const id = `key-${h.backend.plugin.keys.length + 1}`;
    h.backend.plugin.keys.push({ id, label, active, masked: `sk-nano-…${value.slice(-4)}` });
    h.backend.plugin.keyValues.set(id, value);
    return id;
}

function button(label: string, within: ParentNode = root): HTMLButtonElement {
    const found = [...within.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found as HTMLButtonElement;
}

function card(id: string): HTMLElement {
    const found = root.querySelector<HTMLElement>(`[data-key="${id}"]`);
    if (!found) throw new Error(`no card for ${id}`);
    return found;
}

function type(label: string, value: string): void {
    const input = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
    if (!input) throw new Error(`no field "${label}"`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('the list', () => {
    it('warns when there is no key at all', async () => {
        await open();
        expect(root.querySelector('.nanovia-no-keys')?.textContent).toContain('There is no NanoGPT key yet');
        expect(root.querySelector('.nanovia-key-card')).toBeNull();
        // The add form is there to fix it.
        expect(root.querySelector('input[type="password"]')).not.toBeNull();
    });

    it('lists the keys with label, masked value, the active badge and who uses each', async () => {
        const spare = addKeyRow('Spare', 'sk-nano-aaaa-1111');
        const main = addKeyRow('Main', 'sk-nano-bbbb-2222', true);
        seedConnection(h.backend, { name: 'Chat', modelId: 'm/a' }, 'seed000001');
        seedConnection(h.backend, { name: 'Background', modelId: 'm/b', keyId: spare }, 'seed000002');
        seedConnection(h.backend, { name: 'Direct one', modelId: 'm/c', mode: 'direct' }, 'seed000003');
        await open();

        const cards = [...root.querySelectorAll('.nanovia-key-card')].map(
            (node) => (node as HTMLElement).dataset['key'],
        );
        expect(cards).toEqual([main, spare]);
        expect(card(main).textContent).toContain('Main');
        expect(card(main).textContent).toContain('sk-nano-…2222');
        expect(card(main).textContent).toContain('Active');
        expect(card(main).textContent).toContain('Used by: Chat (by default)');
        expect(card(spare).textContent).toContain('Used by: Background');
        expect(card(spare).textContent).not.toContain('Active');
        expect(text()).not.toContain('Direct one');
        expect(root.querySelector('.nanovia-no-keys')).toBeNull();
    });

    it('never shows a key value', async () => {
        addKeyRow('Main', SECRET, true);
        await open();
        expect(root.innerHTML).not.toContain(SECRET);
        expect(root.innerHTML).toContain('wxyz');
    });

    it('speaks Russian', async () => {
        tc.setLocale('ru');
        addKeyRow('Main', SECRET, true);
        await open();
        expect(text()).toContain('Ключи NanoGPT');
        expect(text()).toContain('Проверить баланс');
        expect(text()).toContain('Активный');
    });

    it('registers itself as the tab «keys»', () => {
        const registered: { id: string; titleKey: string }[] = [];
        const ctx = {
            ...tc.ctx,
            panel: { registerTab: (tab: { id: string; titleKey: string }) => (registered.push(tab), () => {}) },
        };
        void keysFeature.init(ctx as never);
        expect(registered).toMatchObject([{ id: 'keys', titleKey: 'keys.tab' }]);
    });
});

describe('when the plugin is down', () => {
    it('says so clearly, hides the add form, and recovers on refresh', async () => {
        h.backend.plugin.up = false;
        await open();
        expect(root.querySelector('.nanovia-banner-down')?.textContent).toContain('Plugin is not answering');
        expect(text()).toContain('no answer from the SillyTavern server');
        expect(root.querySelector('.nanovia-keys-addhost')?.hasAttribute('hidden')).toBe(true);
        expect(root.querySelector('.nanovia-no-keys')).toBeNull();

        h.backend.plugin.up = true;
        addKeyRow('Main', SECRET, true);
        button('Refresh').click();
        await settle();
        expect(root.querySelector('.nanovia-banner-down')).toBeNull();
        expect(root.querySelector('.nanovia-key-card')).not.toBeNull();
        expect(root.querySelector('.nanovia-keys-addhost')?.hasAttribute('hidden')).toBe(false);
        expect(text()).toContain('Refreshed.');
    });

    it('tells a missing plugin from a refused request', async () => {
        h.backend.plugin.installed = false;
        await open();
        expect(text()).toContain('not installed or not enabled');
    });

    it('shows another plugin error with its message and without calling the plugin down', async () => {
        h.backend.plugin.failNext.set('GET /keys', { status: 500, code: 'internal', message: 'disk full' });
        await open();
        expect(text()).toContain('The keys could not be loaded: disk full');
    });
});

describe('adding a key', () => {
    it('posts label and value once, clears the field, refreshes the list', async () => {
        await open();
        type('Key name', 'Backup');
        type('Paste the key here', SECRET);
        button('Save key').click();
        await settle();

        expect(h.backend.plugin.keys).toHaveLength(1);
        expect(h.backend.plugin.keys[0]?.label).toBe('Backup');
        expect([...h.backend.plugin.keyValues.values()]).toEqual([SECRET]);
        const posted = h.backend.pluginCalls().find((call) => call.method === 'POST' && call.path.endsWith('/keys'));
        expect(posted?.body).toEqual({ label: 'Backup', value: SECRET });

        expect(root.querySelector<HTMLInputElement>('[aria-label="Paste the key here"]')?.value).toBe('');
        expect(root.querySelector<HTMLInputElement>('[aria-label="Key name"]')?.value).toBe('');
        expect(root.innerHTML).not.toContain(SECRET);
        expect(text()).toContain('Key added.');
        expect(card('key-1').textContent).toContain('Backup');
        expect(root.querySelector('.nanovia-no-keys')).toBeNull();
    });

    it('is a password field', async () => {
        await open();
        expect(root.querySelector('[aria-label="Paste the key here"]')?.getAttribute('type')).toBe('password');
    });

    it('does not keep the value when the plugin refuses it, and shows the message', async () => {
        await open();
        h.backend.plugin.failNext.set('POST /keys', { status: 400, code: 'bad_request', message: 'not a NanoGPT key' });
        type('Paste the key here', SECRET);
        button('Save key').click();
        await settle();
        expect(text()).toContain('The key was not added: not a NanoGPT key');
        expect(root.querySelector<HTMLInputElement>('[aria-label="Paste the key here"]')?.value).toBe('');
        expect(root.innerHTML).not.toContain(SECRET);
    });

    it('asks for a key when nothing was pasted, and gives an unnamed key a name', async () => {
        await open();
        button('Save key').click();
        await settle();
        expect(text()).toContain('Paste a key first.');
        expect(h.backend.pluginCalls().some((call) => call.method === 'POST' && call.path.endsWith('/keys'))).toBe(
            false,
        );
        type('Paste the key here', SECRET);
        button('Save key').click();
        await settle();
        expect(h.backend.plugin.keys[0]?.label).toBe('NanoGPT key');
    });
});

describe('deleting a key', () => {
    it('asks first, then deletes and refreshes', async () => {
        const id = addKeyRow('Main', SECRET, true);
        await open();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        button('Delete', card(id)).click();
        await settle();
        expect(h.mock.popups).toHaveLength(1);
        expect(h.backend.plugin.keys).toHaveLength(1);

        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        button('Delete', card(id)).click();
        await settle();
        expect(h.backend.plugin.keys).toHaveLength(0);
        expect(text()).toContain('Key deleted.');
        expect(root.querySelector('.nanovia-no-keys')).not.toBeNull();
    });

    it('says in the confirmation how many connections use the key', async () => {
        const id = addKeyRow('Main', SECRET, true);
        seedConnection(h.backend, { name: 'Chat', modelId: 'm/a' }, 'seed000001');
        await open();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        button('Delete', card(id)).click();
        await settle();
        const shown = h.mock.popups[0]?.content as HTMLElement;
        expect(shown.textContent).toContain('1 connection(s) use it');
    });

    it('shows a failure and keeps the key listed', async () => {
        const id = addKeyRow('Main', SECRET, true);
        await open();
        h.backend.plugin.failNext.set(`DELETE /keys/${id}`, { status: 500, code: 'internal', message: 'locked' });
        button('Delete', card(id)).click();
        await settle();
        expect(text()).toContain('The key was not deleted: locked');
        expect(root.querySelector('.nanovia-key-card')).not.toBeNull();
    });
});

describe('checking the balance', () => {
    it('shows the balance under the key', async () => {
        const id = addKeyRow('Main', SECRET, true);
        await open();
        button('Check balance', card(id)).click();
        await settle();
        expect(card(id).textContent).toContain('Balance: $1.50');
        expect(card(id).querySelector('.nanovia-ok-text')).not.toBeNull();
    });

    it('shows a failed check as an error', async () => {
        const id = addKeyRow('Main', SECRET, true);
        await open();
        h.backend.plugin.failNext.set(`POST /keys/${id}/check`, {
            status: 502,
            code: 'upstream',
            message: 'NanoGPT is down',
        });
        button('Check balance', card(id)).click();
        await settle();
        expect(card(id).textContent).toContain('The check failed: NanoGPT is down');
        expect(card(id).querySelector('.nanovia-error-text')).not.toBeNull();
    });

    it('keeps the result when the list is redrawn by a change of connections', async () => {
        const id = addKeyRow('Main', SECRET, true);
        await open();
        button('Check balance', card(id)).click();
        await settle();
        seedConnection(h.backend, { name: 'Late', modelId: 'm/a' }, 'seed000009');
        await h.connections.refresh();
        await settle();
        expect(card(id).textContent).toContain('Balance: $1.50');
        expect(card(id).textContent).toContain('Late');
    });
});
