// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mgmtFeature } from '../../src/features/mgmt';
import { MGMT_STRINGS } from '../../src/features/mgmt/strings';
import { renderMgmtTab } from '../../src/features/mgmt/view';
import { SECRET_KEY_NANOGPT } from '../../src/shared/constants';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { seedConnection } from '../helpers/fake-backend';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { emptyKeyLimits } from '../helpers/mgmt-fake';
import { POPUP_RESULT } from '../helpers/st-mock';

const TOKEN = 'sk-nano-mgmt-TESTTOKEN';
const SECRET_PART = 'TESTTOKEN';

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let dispose: (() => void) | undefined;
let openPanel: ReturnType<typeof vi.fn<(tab?: string) => void>>;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(MGMT_STRINGS);
    openPanel = vi.fn<(tab?: string) => void>();
    tc.ctx.panel.open = openPanel;
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
    for (let i = 0; i < 4; i++) await flush();
}

async function open(): Promise<void> {
    await h.connections.refresh();
    dispose = renderMgmtTab(root, tc.ctx);
    await settle();
}

const fake = (): TestContext['mgmtFake'] => tc.mgmtFake;
const text = (): string => root.textContent ?? '';

function button(label: string, within: ParentNode = root): HTMLButtonElement {
    const found = [...within.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!found) {
        const labels = [...within.querySelectorAll('button')].map((node) => node.textContent?.trim()).join(' | ');
        throw new Error(`no button "${label}"; buttons: ${labels}`);
    }
    return found;
}

async function click(label: string, within: ParentNode = root): Promise<void> {
    button(label, within).click();
    await settle();
}

function input(label: string, within: ParentNode = root): HTMLInputElement {
    const found = within.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!found) throw new Error(`no field "${label}"`);
    return found;
}

function type(label: string, value: string, within: ParentNode = root): void {
    const field = input(label, within);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(label: string, value: string, within: ParentNode = root): void {
    const found = within.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    if (!found) throw new Error(`no select "${label}"`);
    found.value = value;
    found.dispatchEvent(new Event('change', { bubbles: true }));
}

function keyCard(id: string): HTMLElement {
    const found = root.querySelector<HTMLElement>(`[data-key="${id}"]`);
    if (!found) throw new Error(`no card for key ${id}`);
    return found;
}

function presetCard(name: string): HTMLElement {
    const found = root.querySelector<HTMLElement>(`[data-preset="${name}"]`);
    if (!found) throw new Error(`no card for preset ${name}`);
    return found;
}

const form = (): HTMLElement => {
    const found = root.querySelector<HTMLElement>('.nanovia-mgmt-form');
    if (!found) throw new Error('no form is open');
    return found;
};

function addKey(patch: Parameters<TestContext['mgmtFake']['addKey']>[0] = {}): string {
    return fake().addKey(patch).id;
}

/** The whole page, as text and markup, holds no part of the token. */
function expectNoToken(): void {
    expect(root.innerHTML).not.toContain(SECRET_PART);
    expect(text()).not.toContain(SECRET_PART);
}

describe('the tab', () => {
    it('registers itself as «mgmt», after Keys and before Account', () => {
        const registered: { id: string; titleKey: string; order: number }[] = [];
        const ctx = {
            ...tc.ctx,
            panel: {
                registerTab: (tab: { id: string; titleKey: string; order: number }) => (registered.push(tab), () => {}),
            },
        };
        void mgmtFeature.init(ctx as never);
        expect(registered).toMatchObject([{ id: 'mgmt', titleKey: 'mgmt.tab', order: 350 }]);
        expect(tc.ctx.t('mgmt.tab')).toBe('Management');
    });

    it('speaks Russian', async () => {
        tc.setLocale('ru');
        fake().storeToken(TOKEN, true);
        addKey({ name: 'Основной' });
        await open();
        expect(text()).toContain('Управление NanoGPT');
        expect(text()).toContain('Токен управления');
        expect(text()).toContain('Действует');
        expect(text()).toContain('Управляемые ключи API');
        expect(text()).toContain('Пресеты моделей');
        expect(text()).toContain('бета');
    });

    it('always says that NanoGPT calls the API a beta', async () => {
        await open();
        expect(text()).toContain('NanoGPT calls this API a beta');
    });

    it('stops listening to the store when it is closed', async () => {
        fake().storeToken();
        await open();
        const before = text();
        dispose?.();
        dispose = undefined;
        addKey({ name: 'Added later' });
        await tc.mgmt.refreshKeys();
        await settle();
        expect(text()).toBe(before);
    });
});

describe('states', () => {
    it('no plugin: says Management needs it and disables every action', async () => {
        h.backend.plugin.installed = false;
        await open();
        expect(root.querySelector('.nanovia-banner')?.textContent).toContain('Nanovia server plugin');
        expect(text()).toContain('Needs the plugin');
        expect(input('Management token').disabled).toBe(true);
        expect(button('Save').disabled).toBe(true);
        expect(button('New key').disabled).toBe(true);
        expect(button('New preset').disabled).toBe(true);
        expect(root.querySelector('.nanovia-key-card, .nanovia-mgmt-keycard')).toBeNull();
        // The way out stays: asking again.
        expect(button('Refresh').disabled).toBe(false);
    });

    it('an old plugin without the routes is told apart from a missing one', async () => {
        fake().hasRoutes = false;
        await open();
        expect(root.querySelector('.nanovia-banner')?.textContent).toContain('does not know the Management routes');
        expect(button('Save').disabled).toBe(true);
    });

    it('a plugin that does not answer: says so and recovers on Refresh', async () => {
        h.backend.plugin.up = false;
        await open();
        expect(root.querySelector('.nanovia-banner-down')?.textContent).toContain('not answering');
        expect(button('New key').disabled).toBe(true);

        h.backend.plugin.up = true;
        fake().storeToken();
        addKey({ name: 'Main' });
        await click('Refresh');
        expect(root.querySelector('.nanovia-banner')).toBeNull();
        expect(keyCard('1').textContent).toContain('Main');
        expect(text()).toContain('Refreshed.');
    });

    it('no token: guides the user and keeps the sections closed', async () => {
        await open();
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('No token');
        const guide = root.querySelector<HTMLDetailsElement>('.nanovia-mgmt-guide');
        expect(guide?.open).toBe(true);
        expect(guide?.textContent).toContain('Settings, then Security');
        expect(guide?.textContent).toContain('sk-nano-mgmt-');
        expect(guide?.textContent).toContain('api_keys:write');
        expect(guide?.textContent).toContain('model_presets:write');
        expect(guide?.textContent).toContain('90 days');
        expect(text()).toContain('Add a Management token above');
        expect(button('New key').disabled).toBe(true);
        expect(button('Delete token').hidden).toBe(true);
        expect(input('Management token').disabled).toBe(false);
    });

    it('an invalid token: chip, explanation, and the sections closed', async () => {
        fake().storeToken(TOKEN, false);
        await open();
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('Rejected');
        expect(root.querySelector('.nanovia-mgmt-tokenstatus')?.textContent).toContain('revoked');
        expect(text()).toContain('NanoGPT rejected the stored token');
        expect(button('New key').disabled).toBe(true);
        expect(button('Delete token').hidden).toBe(false);
        expect(fake().callsTo('GET /mgmt/keys')).toHaveLength(0);
        expectNoToken();
    });

    it('a valid token: chip, the time of the check, the guide closed, the sections open', async () => {
        fake().storeToken(TOKEN, true);
        await open();
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('Valid');
        expect(root.querySelector('.nanovia-mgmt-tokenstatus')?.textContent).toMatch(/Checked (just now|\d+ min ago)/);
        expect(root.querySelector<HTMLDetailsElement>('.nanovia-mgmt-guide')?.open).toBe(false);
        expect(button('New key').disabled).toBe(false);
        expect(button('New preset').disabled).toBe(false);
    });

    it('a token that was never verified says so', async () => {
        fake().storeToken(TOKEN, null);
        fake().check = { valid: null, checkedAt: null, error: 'upstream_unreachable' };
        // Reading the lists succeeds, which turns the verdict to valid by the time the tab has loaded.
        fake().upstream = 'down';
        await open();
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('Not verified');
        expect(root.querySelector('.nanovia-mgmt-tokenstatus')?.textContent).toContain('could not reach NanoGPT');
    });

    it('a missing scope names the scope, for the section it concerns only', async () => {
        fake().storeToken();
        fake().scopes = new Set(['model_presets:write']);
        fake().addPreset({ name: 'rp' });
        await open();
        const keys = root.querySelector('.nanovia-mgmt-keys')?.textContent ?? '';
        expect(keys).toContain('lacks the api_keys:read scope');
        expect(root.querySelector('.nanovia-mgmt-presets')?.textContent).not.toContain('lacks the');
        expect(presetCard('rp')).toBeTruthy();
    });

    it('a rate limit is said in words, and the page stays usable', async () => {
        fake().storeToken();
        fake().upstream = 'rate_limited';
        await open();
        expect(root.querySelector('.nanovia-mgmt-keys')?.textContent).toContain('limiting how often');
        expect(root.querySelector('.nanovia-mgmt-presets')?.textContent).toContain('limiting how often');
        expect(button('Refresh').disabled).toBe(false);
        expect(button('Save').disabled).toBe(false);
    });
});

describe('saving the token', () => {
    it('the field is a password field that is not autofilled', async () => {
        await open();
        const field = input('Management token');
        expect(field.getAttribute('type')).toBe('password');
        expect(field.getAttribute('autocomplete')).toBe('off');
        expect(field.getAttribute('placeholder')).toBe('sk-nano-mgmt-…');
    });

    it('sends the token once, clears the field, and shows only the status', async () => {
        addKey({ name: 'Main' });
        await open();
        type('Management token', TOKEN);
        await click('Save');

        expect(fake().token).toBe(TOKEN);
        const calls = fake().callsTo('PUT /mgmt/token');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({ token: TOKEN });
        expect(input('Management token').value).toBe('');
        expect(text()).toContain('Token saved: NanoGPT accepted it.');
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('Valid');
        expect(button('Delete token').hidden).toBe(false);
        // The token has opened the sections: the key is listed.
        expect(keyCard('1').textContent).toContain('Main');
        expectNoToken();
        // And the store holds no value of it.
        expect(JSON.stringify(tc.mgmt.detail())).not.toContain(SECRET_PART);
    });

    it('an empty field and a wrong kind of key are turned away before anything is sent', async () => {
        await open();
        await click('Save');
        expect(text()).toContain('Paste the token first.');
        type('Management token', 'sk-nano-00000000-1111-2222');
        await click('Save');
        expect(text()).toContain('This is an inference API key');
        expect(input('Management token').value).toBe('');
        type('Management token', 'something-else-entirely');
        await click('Save');
        expect(text()).toContain('starts with sk-nano-mgmt-');
        expect(fake().callsTo('PUT /mgmt/token')).toHaveLength(0);
    });

    it('a token NanoGPT rejected is not stored, the field is cleared, and "save anyway" is not offered', async () => {
        fake().upstream = 'rejects';
        await open();
        type('Management token', TOKEN);
        await click('Save');
        expect(fake().token).toBeNull();
        expect(text()).toContain('NanoGPT rejected the Management token');
        expect(input('Management token').value).toBe('');
        expect(root.querySelector('.nanovia-mgmt-anyway')?.hasAttribute('hidden')).toBe(true);
        expect(text()).not.toContain('Save without checking');
        expectNoToken();
    });

    it('when NanoGPT cannot be reached it offers to save anyway, and keeps the token for it', async () => {
        fake().upstream = 'down';
        await open();
        type('Management token', TOKEN);
        await click('Save');
        expect(fake().token).toBeNull();
        expect(text()).toContain('NanoGPT could not be reached');
        const anyway = root.querySelector<HTMLElement>('.nanovia-mgmt-anyway');
        expect(anyway?.hasAttribute('hidden')).toBe(false);
        expect(anyway?.textContent).toContain('could not confirm this token');
        // The only place the token still is: the field the user typed it into (never in the text or markup).
        expect(input('Management token').value).toBe(TOKEN);
        expectNoToken();

        await click('Save without checking');
        const sent = fake()
            .calls.filter((call) => call.path.startsWith('/mgmt/token'))
            .map((call) => call.path);
        expect(sent).toEqual(['/mgmt/token', '/mgmt/token?force=1']);
        expect(fake().token).toBe(TOKEN);
        expect(input('Management token').value).toBe('');
        expect(text()).toContain('saved without confirmation');
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('Not verified');
        expect(root.querySelector('.nanovia-mgmt-anyway')?.hasAttribute('hidden')).toBe(true);
        expectNoToken();
    });

    it('a rate limit offers it too; typing a new value withdraws the offer', async () => {
        fake().upstream = 'rate_limited';
        await open();
        type('Management token', TOKEN);
        await click('Save');
        expect(text()).toContain('Save without checking');
        type('Management token', `${TOKEN}2`);
        expect(root.querySelector('.nanovia-mgmt-anyway')?.hasAttribute('hidden')).toBe(true);
        expect(text()).not.toContain('Save without checking');
    });

    it('when the plugin stops answering the token stays in the field, but no "save anyway" is offered', async () => {
        await open();
        h.backend.plugin.up = false;
        type('Management token', TOKEN);
        await click('Save');
        expect(text()).toContain('not answering');
        expect(text()).not.toContain('Save without checking');
        expect(input('Management token').value).toBe(TOKEN);
        expectNoToken();
    });

    it('deletes the token after a confirmation', async () => {
        fake().storeToken();
        addKey();
        await open();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        await click('Delete token');
        expect(fake().token).toBe(TOKEN);
        expect(h.mock.popups).toHaveLength(1);

        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        await click('Delete token');
        expect(fake().token).toBeNull();
        expect(text()).toContain('Token deleted.');
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('No token');
        expect(root.querySelector('.nanovia-mgmt-keycard')).toBeNull();
        expect(button('New key').disabled).toBe(true);
    });

    it('"Check now" asks NanoGPT and shows the verdict', async () => {
        fake().storeToken();
        await open();
        await click('Check now');
        expect(fake().calls.some((call) => call.path === '/mgmt/status?verify=1')).toBe(true);
        expect(text()).toContain('NanoGPT accepts the token.');

        fake().upstream = 'rejects';
        await click('Check now');
        expect(text()).toContain('NanoGPT rejected the token.');
        expect(root.querySelector('.nanovia-mgmt-token .nanovia-chip')?.textContent).toBe('Rejected');
    });
});

describe('managed keys: the list', () => {
    it('shows name, status, expiry, a compact limit summary and the ZDR policy', async () => {
        fake().storeToken();
        const limits = emptyKeyLimits();
        limits.usd = { daily: 5, weekly: null, monthly: 50 };
        limits.requests.daily = 200;
        const id = addKey({
            name: 'Roleplay',
            expiresAt: Date.UTC(2099, 0, 1),
            zdrPolicy: 'zdr',
            limits,
        });
        addKey({ name: 'Old test key', status: 'expired', expiresAt: Date.UTC(2020, 0, 1), zdrPolicy: 'unset' });
        await open();

        const card = keyCard(id);
        expect(card.textContent).toContain('Roleplay');
        expect(card.textContent).toContain('Active');
        expect(card.textContent).toContain('Expires 2099-01-01 (UTC)');
        expect(card.textContent).toContain('ZDR routes only');
        expect(card.querySelector('[data-kind="usd"]')?.textContent).toContain('$5 / day · $50 / month');
        expect(card.querySelector('[data-kind="requests"]')?.textContent).toContain('200 / day');
        expect(card.querySelector('[data-kind="inputTokens"]')).toBeNull();

        const old = keyCard('2');
        expect(old.textContent).toContain('Expired');
        expect(old.textContent).toContain('Policy not set');
        expect(old.textContent).toContain('No limits.');
    });

    it('says that NanoGPT shows neither a masked tail nor usage, and shows no tail or secret', async () => {
        fake().storeToken();
        addKey({ name: 'Main' });
        await open();
        expect(root.querySelector('.nanovia-mgmt-keys')?.textContent).toContain(
            'shows neither the end of a key nor how much each key has used',
        );
        // No key value or masked tail anywhere (the only `sk-nano-` text is the Management token's own prefix).
        expect(root.innerHTML).not.toMatch(/sk-nano-(?!mgmt-)/);
        expect(keyCard('1').innerHTML).not.toContain('…');
        expect(keyCard('1').textContent).not.toContain('sk-nano');
    });

    it('marks a key that a limit of 0 blocks', async () => {
        fake().storeToken();
        const limits = emptyKeyLimits();
        limits.usd.daily = 0;
        const id = addKey({ limits });
        await open();
        expect(keyCard(id).textContent).toContain('Blocked');
    });

    it('says when there are no keys', async () => {
        fake().storeToken();
        await open();
        expect(root.querySelector('.nanovia-mgmt-keys')?.textContent).toContain('no managed keys for this token yet');
    });
});

describe('managed keys: editing limits', () => {
    it('opens a form with the key’s values and sends only what changed', async () => {
        fake().storeToken();
        const limits = emptyKeyLimits();
        limits.usd.monthly = 20;
        const id = addKey({ name: 'Main', limits, expiresAt: Date.UTC(2099, 0, 1), zdrPolicy: 'off' });
        await open();
        await click('Edit limits', keyCard(id));

        expect(root.querySelector('.nanovia-mgmt-keycard')).toBeNull();
        expect(input('Name', form()).value).toBe('Main');
        expect(input('Expires on (UTC)', form()).value).toBe('2099-01-01');
        expect(input('USD, Per month', form()).value).toBe('20');
        expect(input('USD, Per day', form()).value).toBe('');

        type('Requests, Per day', '100', form());
        type('USD, Per month', '', form());
        await click('Save', form());

        const patch = fake().callsTo('PATCH /mgmt/keys/1')[0];
        expect(patch?.body).toEqual({ limits: { requests: { daily: 100 }, usd: { monthly: null } } });
        expect(text()).toContain('Key “Main” updated.');
        expect(root.querySelector('.nanovia-mgmt-form')).toBeNull();
        expect(keyCard(id).querySelector('[data-kind="requests"]')?.textContent).toContain('100 / day');
        expect(keyCard(id).querySelector('[data-kind="usd"]')).toBeNull();
    });

    it('changes the name, the expiry and the policy', async () => {
        fake().storeToken();
        const id = addKey({ name: 'Main', zdrPolicy: 'off' });
        await open();
        await click('Edit limits', keyCard(id));
        type('Name', 'Renamed', form());
        type('Expires on (UTC)', '2099-12-31', form());
        choose('Data policy', 'zdr', form());
        await click('Save', form());
        expect(fake().callsTo('PATCH /mgmt/keys/1')[0]?.body).toEqual({
            name: 'Renamed',
            expiresAt: Date.UTC(2099, 11, 31, 23, 59, 59, 999),
            zdrPolicy: 'zdr',
        });
        expect(keyCard(id).textContent).toContain('Renamed');
        expect(keyCard(id).textContent).toContain('ZDR routes only');
    });

    it('offers the legacy policy only to a key that has it', async () => {
        fake().storeToken();
        const legacy = addKey({ zdrPolicy: 'unset' });
        const normal = addKey({ zdrPolicy: 'off' });
        await open();
        await click('Edit limits', keyCard(legacy));
        const options = (): string[] =>
            [...form().querySelectorAll('select[aria-label="Data policy"] option')].map(
                (node) => (node as HTMLOptionElement).value,
            );
        expect(options()).toEqual(['keep', 'zdr', 'off', 'unset']);
        await click('Cancel', form());
        await click('Edit limits', keyCard(normal));
        expect(options()).toEqual(['keep', 'zdr', 'off']);
    });

    it('says "nothing changed" and sends nothing', async () => {
        fake().storeToken();
        const id = addKey();
        await open();
        await click('Edit limits', keyCard(id));
        await click('Save', form());
        expect(text()).toContain('Nothing changed.');
        expect(fake().callsTo('PATCH')).toHaveLength(0);
        expect(root.querySelector('.nanovia-mgmt-form')).not.toBeNull();
    });

    it('lists what is wrong at its field and sends nothing', async () => {
        fake().storeToken();
        const id = addKey();
        await open();
        await click('Edit limits', keyCard(id));
        type('USD, Per day', 'five', form());
        type('USD, Per week', '100001', form());
        type('Requests, Per day', '1.5', form());
        type('Expires on (UTC)', '2020-01-01', form());
        await click('Save', form());

        const issues = form().querySelector('.nanovia-mgmt-issues')?.textContent ?? '';
        expect(issues).toContain('USD, Per day: Not a number.');
        expect(issues).toContain('Expires on (UTC): Pick today or a later day.');
        expect(fake().callsTo('PATCH')).toHaveLength(0);
        expect(input('USD, Per day', form()).getAttribute('aria-invalid')).toBe('true');
        expect(input('Expires on (UTC)', form()).getAttribute('aria-invalid')).toBe('true');
        // What was typed stays for the next try.
        expect(input('USD, Per week', form()).value).toBe('100001');

        type('USD, Per day', '', form());
        type('Expires on (UTC)', '', form());
        await click('Save', form());
        const second = form().querySelector('.nanovia-mgmt-issues')?.textContent ?? '';
        expect(second).toContain('USD, Per week: Must be between 0 and 100');
        expect(second).toContain('Requests, Per day: Must be a whole number.');
        expect(fake().callsTo('PATCH')).toHaveLength(0);
    });

    it('shows what the plugin or NanoGPT answers next to the buttons and keeps the form open', async () => {
        fake().storeToken();
        const id = addKey();
        await open();
        await click('Edit limits', keyCard(id));
        type('Name', 'Other', form());
        fake().fail.set('PATCH /mgmt/keys/:id', { status: 429, code: 'rate_limited' });
        await click('Save', form());
        expect(form().querySelector('.nanovia-mgmt-formerror')?.textContent).toContain('limiting how often');
        expect(input('Name', form()).value).toBe('Other');
        fake().fail.clear();
        await click('Save', form());
        expect(root.querySelector('.nanovia-mgmt-form')).toBeNull();
    });

    it('Cancel closes the form without sending', async () => {
        fake().storeToken();
        const id = addKey();
        await open();
        await click('Edit limits', keyCard(id));
        type('Name', 'Other', form());
        await click('Cancel', form());
        expect(root.querySelector('.nanovia-mgmt-form')).toBeNull();
        expect(fake().callsTo('PATCH')).toHaveLength(0);
        expect(keyCard(id).textContent).toContain('Key 1');
    });
});

describe('managed keys: creating', () => {
    it('creates a key; the secret goes to ST’s secret store and is never shown', async () => {
        fake().storeToken();
        await open();
        await click('New key');
        type('Name', 'Capped', form());
        type('USD, Per month', '20', form());
        type('Requests, Per day', '500', form());
        choose('Data policy', 'zdr', form());
        await click('Save', form());

        expect(fake().callsTo('POST /mgmt/keys')[0]?.body).toEqual({
            name: 'Capped',
            zdrPolicy: 'zdr',
            limits: { usd: { monthly: 20 }, requests: { daily: 500 } },
        });
        expect(text()).toContain('Key created and saved in SillyTavern as “Nanovia: Capped”.');
        const rows = h.backend.secrets.get(SECRET_KEY_NANOGPT) ?? [];
        expect(rows.map((row) => row.label)).toEqual(['Nanovia: Capped']);
        expect(root.innerHTML).not.toContain('sk-nano-created');
        expect(rows[0]?.value ?? '').not.toBe('');
        expect(text()).not.toContain(rows[0]?.value ?? 'never');
        expect(keyCard('1').textContent).toContain('Capped');
        expect(root.querySelector('.nanovia-mgmt-form')).toBeNull();

        await click('Open the Keys tab');
        expect(openPanel).toHaveBeenCalledWith('keys');
    });

    it('a name alone is enough; nothing else is sent', async () => {
        fake().storeToken();
        await open();
        await click('New key');
        type('Name', 'Plain', form());
        await click('Save', form());
        expect(fake().callsTo('POST /mgmt/keys')[0]?.body).toEqual({ name: 'Plain' });
    });

    it('a new key cannot be given the legacy policy', async () => {
        fake().storeToken();
        await open();
        await click('New key');
        const values = [...form().querySelectorAll('select[aria-label="Data policy"] option')].map(
            (node) => (node as HTMLOptionElement).value,
        );
        expect(values).toEqual(['keep', 'zdr', 'off']);
        expect(form().textContent).toContain('NanoGPT default');
    });

    it('turns away a blank name, a past expiry and a bad number, all at once', async () => {
        fake().storeToken();
        await open();
        await click('New key');
        type('Expires on (UTC)', '2020-01-01', form());
        type('USD, Per day', 'many', form());
        await click('Save', form());
        const issues = form().querySelector('.nanovia-mgmt-issues')?.textContent ?? '';
        expect(issues).toContain('Expires on (UTC): Pick today or a later day.');
        expect(issues).toContain('USD, Per day: Not a number.');
        type('Expires on (UTC)', '', form());
        type('USD, Per day', '', form());
        await click('Save', form());
        expect(form().querySelector('.nanovia-mgmt-issues')?.textContent).toContain(
            'Name: Must be 1 to 120 characters.',
        );
        expect(fake().callsTo('POST /mgmt/keys')).toHaveLength(0);
    });

    it('a key made but not stored is reported and listed, so it can be revoked', async () => {
        fake().storeToken();
        await open();
        await click('New key');
        type('Name', 'Orphan', form());
        fake().addKey({ name: 'Orphan' });
        fake().fail.set('POST /mgmt/keys', { status: 500, code: 'secrets_failed' });
        await click('Save', form());
        expect(form().querySelector('.nanovia-mgmt-formerror')?.textContent).toContain('could not store its secret');
        expect(keyCard('1').textContent).toContain('Orphan');
    });

    it('says when ST’s secret store is down: no key was made', async () => {
        fake().storeToken();
        await open();
        await click('New key');
        type('Name', 'X', form());
        fake().fail.set('POST /mgmt/keys', { status: 503, code: 'secrets_unavailable' });
        await click('Save', form());
        expect(form().querySelector('.nanovia-mgmt-formerror')?.textContent).toContain('Nothing changed at NanoGPT');
    });
});

describe('managed keys: revoking', () => {
    it('asks first and says what happens, then revokes', async () => {
        fake().storeToken();
        const id = addKey({ name: 'Main' });
        await open();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        await click('Revoke', keyCard(id));
        expect(fake().keys).toHaveLength(1);
        const shown = (h.mock.popups[0]?.content as HTMLElement).textContent ?? '';
        expect(shown).toContain('stops working at once and cannot be restored');
        expect(shown).toContain('“Main”');

        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        await click('Revoke', keyCard(id));
        expect(fake().keys).toHaveLength(0);
        expect(text()).toContain('Key “Main” revoked.');
        expect(root.querySelector('.nanovia-mgmt-keycard')).toBeNull();
    });

    it('a key that is already gone is reported and the list is refreshed', async () => {
        fake().storeToken();
        const id = addKey({ name: 'Ghost' });
        await open();
        fake().keys.length = 0;
        await click('Revoke', keyCard(id));
        expect(text()).toContain('no longer exists at NanoGPT');
        expect(root.querySelector('.nanovia-mgmt-keycard')).toBeNull();
    });

    it('a scope that only reads is named when a write is refused', async () => {
        fake().storeToken();
        const id = addKey({ name: 'Main' });
        fake().scopes = new Set(['api_keys:read', 'model_presets:write']);
        await open();
        await click('Revoke', keyCard(id));
        expect(text()).toContain('lacks the api_keys:write scope');
        expect(keyCard(id)).toBeTruthy();
    });
});

describe('model presets: the list', () => {
    it('shows the name as a model id, the model and the settings that are set', async () => {
        fake().storeToken();
        fake().addPreset({
            name: 'rp-fast',
            model: 'vendor/model',
            temperature: 0.8,
            maxTokens: 1500,
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '1h' },
            systemPrompt: 'Be brief.',
        });
        fake().addPreset({ name: 'plain', model: 'vendor/other' });
        await open();
        const card = presetCard('rp-fast');
        expect(card.textContent).toContain('presets/rp-fast');
        expect(card.textContent).toContain('Model: vendor/model');
        expect(card.textContent).toContain('Temperature 0.8');
        expect(card.textContent).toContain('Prompt caching 1h');
        expect(card.textContent).toContain('System prompt 9 characters');
        expect(presetCard('plain').textContent).toContain('Only the model, no other settings.');
    });

    it('says when there are none', async () => {
        fake().storeToken();
        await open();
        expect(root.querySelector('.nanovia-mgmt-presets')?.textContent).toContain('There are no presets yet.');
    });
});

describe('model presets: creating and editing', () => {
    it('creates a preset from the form, every setting with its range, grouped', async () => {
        fake().storeToken();
        await open();
        await click('New preset');
        const groups = [...form().querySelectorAll('legend')].map((node) => node.textContent);
        expect(groups).toEqual(['Model and system prompt', 'Sampling and output', 'Reasoning and provider options']);
        expect(form().textContent).toContain('From 0 to 2.');
        expect(form().textContent).toContain('A whole number from 1 to 1');

        type('Name', 'RP-Fast', form());
        type('Model', 'vendor/model', form());
        const prompt = form().querySelector<HTMLTextAreaElement>('textarea');
        if (!prompt) throw new Error('no system prompt field');
        prompt.value = 'Be brief.';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        expect(form().querySelector('.nanovia-mgmt-counter')?.textContent).toContain('9 /');
        type('Temperature', '0,8', form());
        type('Max tokens', '1500', form());
        choose('Routing preference', 'price', form());
        choose('Reasoning effort', 'high', form());
        await click('Save', form());

        const call = fake().callsTo('POST /mgmt/presets')[0];
        expect(call?.body).toMatchObject({
            name: 'rp-fast',
            model: 'vendor/model',
            systemPrompt: 'Be brief.',
            temperature: 0.8,
            maxTokens: 1500,
            routing: 'price',
            reasoningEffort: 'high',
            topK: null,
            thinking: null,
        });
        expect(text()).toContain('Preset “rp-fast” created.');
        expect(presetCard('rp-fast').textContent).toContain('Routing preference price');
        expect(root.querySelector('.nanovia-mgmt-form')).toBeNull();
    });

    it('thinking and caching reveal their details only when set', async () => {
        fake().storeToken();
        await open();
        await click('New preset');
        expect(form().querySelector('input[aria-label="Thinking budget (tokens)"]')).toBeNull();
        expect(form().querySelector('select[aria-label="Cache lifetime"]')).toBeNull();
        choose('Thinking', 'on', form());
        choose('Prompt caching', 'on', form());
        type('Thinking budget (tokens)', '4000', form());
        choose('Cache lifetime', '1h', form());
        type('Name', 'think', form());
        type('Model', 'vendor/model', form());
        await click('Save', form());
        expect(fake().callsTo('POST /mgmt/presets')[0]?.body).toMatchObject({
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '1h' },
        });
    });

    it('names what is wrong, with the ranges, and sends nothing', async () => {
        fake().storeToken();
        await open();
        await click('New preset');
        type('Name', '-bad name', form());
        type('Temperature', '5', form());
        type('Max tokens', 'lots', form());
        choose('Structured outputs', 'on', form());
        await click('Save', form());
        const issues = form().querySelector('.nanovia-mgmt-issues')?.textContent ?? '';
        expect(issues).toContain('Name: Use letters, digits');
        expect(issues).toContain('Max tokens: Not a number.');
        expect(fake().callsTo('POST /mgmt/presets')).toHaveLength(0);

        type('Max tokens', '100', form());
        type('Name', 'ok', form());
        type('Model', 'vendor/model', form());
        await click('Save', form());
        const second = form().querySelector('.nanovia-mgmt-issues')?.textContent ?? '';
        expect(second).toContain('Temperature: Must be between 0 and 2.');
        expect(second).toContain('Structured outputs: Needs the response format json_object.');
        expect(fake().callsTo('POST /mgmt/presets')).toHaveLength(0);
    });

    it('tells a name that is taken, keeps the form, and marks the name', async () => {
        fake().storeToken();
        fake().addPreset({ name: 'taken' });
        await open();
        await click('New preset');
        type('Name', 'Taken', form());
        type('Model', 'vendor/model', form());
        await click('Save', form());
        expect(form().querySelector('.nanovia-mgmt-formerror')?.textContent).toContain('already exists');
        expect(input('Name', form()).getAttribute('aria-invalid')).toBe('true');
        expect(input('Model', form()).value).toBe('vendor/model');
        type('Name', 'free', form());
        await click('Save', form());
        expect(fake().presets.has('free')).toBe(true);
    });

    it('says when NanoGPT has too many presets', async () => {
        fake().storeToken();
        await open();
        await click('New preset');
        type('Name', 'one-more', form());
        type('Model', 'vendor/model', form());
        fake().fail.set('POST /mgmt/presets', { status: 409, code: 'preset_limit_reached' });
        await click('Save', form());
        expect(form().querySelector('.nanovia-mgmt-formerror')?.textContent).toContain('at most 100 presets');
    });

    it('edits a preset in place: the name stays, nothing else is dropped', async () => {
        fake().storeToken();
        fake().addPreset({
            name: 'rp',
            model: 'vendor/model',
            systemPrompt: 'Stay in character.',
            temperature: 0.8,
            topP: 0.9,
            routing: 'caching',
            thinking: { enabled: true, budgetTokens: 2000 },
        });
        await open();
        await click('Edit', presetCard('rp'));
        expect(root.querySelector('.nanovia-mgmt-presetcard')).toBeNull();
        expect(form().querySelector('input[aria-label="Name"]')).toBeNull();
        expect(form().querySelector('.nanovia-mgmt-fixedname')?.textContent).toBe('rp');
        expect(input('Temperature', form()).value).toBe('0.8');
        type('Temperature', '1.1', form());
        await click('Save', form());

        const call = fake().callsTo('PUT /mgmt/presets/rp')[0];
        expect(call?.body).toMatchObject({
            model: 'vendor/model',
            systemPrompt: 'Stay in character.',
            temperature: 1.1,
            topP: 0.9,
            routing: 'caching',
            thinking: { enabled: true, budgetTokens: 2000 },
        });
        expect(text()).toContain('Preset “rp” saved.');
        expect(presetCard('rp').textContent).toContain('Temperature 1.1');
    });

    it('clearing a field clears the setting', async () => {
        fake().storeToken();
        fake().addPreset({ name: 'rp', temperature: 0.8, reasoningEffort: 'high' });
        await open();
        await click('Edit', presetCard('rp'));
        type('Temperature', '', form());
        choose('Reasoning effort', '', form());
        await click('Save', form());
        expect(fake().presets.get('rp')).toMatchObject({ temperature: null, reasoningEffort: null });
    });
});

describe('model presets: duplicate, delete, from a connection', () => {
    it('duplicates a preset under a free name', async () => {
        fake().storeToken();
        fake().addPreset({ name: 'rp', model: 'vendor/model', temperature: 0.4 });
        await open();
        await click('Duplicate', presetCard('rp'));
        expect(form().textContent).toContain('A copy of “rp”');
        expect(input('Name', form()).value).toBe('rp-copy');
        expect(input('Temperature', form()).value).toBe('0.4');
        await click('Save', form());
        expect([...fake().presets.keys()]).toEqual(['rp', 'rp-copy']);
        expect(presetCard('rp-copy')).toBeTruthy();
    });

    it('deletes a preset after a confirmation', async () => {
        fake().storeToken();
        fake().addPreset({ name: 'rp' });
        await open();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        await click('Delete', presetCard('rp'));
        expect(fake().presets.size).toBe(1);
        expect((h.mock.popups[0]?.content as HTMLElement).textContent).toContain('presets/rp');

        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        await click('Delete', presetCard('rp'));
        expect(fake().presets.size).toBe(0);
        expect(text()).toContain('Preset “rp” deleted.');
    });

    it('shows a refusal to delete', async () => {
        fake().storeToken();
        fake().addPreset({ name: 'rp' });
        await open();
        fake().scopes = new Set(['api_keys:write', 'model_presets:read']);
        await click('Delete', presetCard('rp'));
        expect(text()).toContain('lacks the model_presets:write scope');
        expect(presetCard('rp')).toBeTruthy();
    });

    it('creates a preset from a connection: model and routing, only what a preset supports', async () => {
        fake().storeToken();
        seedConnection(
            h.backend,
            {
                name: 'Main chat',
                modelId: 'deepseek/deepseek-v4',
                routing: {
                    enabled: true,
                    sort: 'price',
                    order: ['alpha'],
                    only: [],
                    ignore: [],
                    quantizations: [],
                    minQuantization: null,
                    maxPrice: { prompt: null, completion: null },
                    allowFallbacks: true,
                    requireParameters: false,
                    zdr: false,
                    preferredMaxLatency: null,
                    preferredMinThroughput: null,
                    cachingRoute: false,
                },
                reasoning: { policy: 'fixed', effort: 'high', hideThoughts: false },
            },
            'seed000001',
        );
        await open();
        expect(root.querySelector('select[aria-label="Connection"] option')?.textContent).toBe('Main chat');
        await click('From connection');

        expect(form().textContent).toContain('Filled from the connection “Main chat”');
        expect(form().textContent).toContain(
            'Provider lists, price caps and quantisation filters are not part of a preset',
        );
        expect(input('Name', form()).value).toBe('main-chat');
        expect(input('Model', form()).value).toBe('deepseek/deepseek-v4');
        expect(form().querySelector<HTMLSelectElement>('select[aria-label="Routing preference"]')?.value).toBe('price');
        expect(form().querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]')?.value).toBe('high');
        expect(input('Temperature', form()).value).toBe('');

        await click('Save', form());
        expect(fake().callsTo('POST /mgmt/presets')[0]?.body).toMatchObject({
            name: 'main-chat',
            model: 'deepseek/deepseek-v4',
            routing: 'price',
            reasoningEffort: 'high',
            temperature: null,
        });
    });

    it('offers the connection only when there is one, and follows the list of connections', async () => {
        fake().storeToken();
        await open();
        expect(root.querySelector('select[aria-label="Connection"]')).toBeNull();
        expect(text()).not.toContain('From connection');
        seedConnection(h.backend, { name: 'Late', modelId: 'm/a' }, 'seed000009');
        await h.connections.refresh();
        await settle();
        expect(root.querySelector('select[aria-label="Connection"] option')?.textContent).toBe('Late');
    });
});
