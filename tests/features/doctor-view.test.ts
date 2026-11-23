// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureContext } from '../../src/core/context';
import { doctorFeature } from '../../src/features/doctor';
import { DOCTOR_STRINGS } from '../../src/features/doctor/strings';
import { KEYS_STRINGS } from '../../src/features/keys/strings';
import { renderDoctorTab } from '../../src/features/doctor/view';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(DOCTOR_STRINGS);
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
    for (let i = 0; i < 6; i++) await flush();
}

async function open(ctx: FeatureContext = tc.ctx): Promise<void> {
    dispose = renderDoctorTab(root, ctx);
    await settle();
}

const text = (): string => root.textContent ?? '';

function button(label: string, within: ParentNode = root): HTMLButtonElement {
    const found = [...within.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found as HTMLButtonElement;
}

function row(code: string): HTMLElement {
    const found = root.querySelector<HTMLElement>(`[data-code="${code}"]`);
    if (!found) throw new Error(`no row for ${code}`);
    return found;
}

const rowCodes = (selector: string): string[] =>
    [...root.querySelectorAll<HTMLElement>(`${selector} .nanovia-check`)].map((node) => node.dataset['code'] ?? '');

async function connection(patch: Record<string, unknown> = {}): Promise<string> {
    const saved = await h.connections.save({
        patch: { name: 'Chat', modelId: 'vendor/model', mode: 'plugin', ...patch },
    });
    if (!saved.ok) throw new Error(`save failed: ${saved.error.code}`);
    return saved.data.id;
}

function addKey(): void {
    h.backend.plugin.keys.push({ id: 'key-1', label: 'Main', active: true, masked: 'sk-nano-…abcd' });
}

describe('opening the tab', () => {
    it('runs the checks by itself and shows the findings, errors first, what passed folded away', async () => {
        await connection();
        await open();
        expect(h.connections.checked()).toBe(true);
        // Without a key a plugin connection cannot work: an error, and the catalog is only news.
        expect(rowCodes('.nanovia-doctor-error')).toEqual(['no_keys']);
        expect(rowCodes('.nanovia-doctor-info')).toEqual(['catalog_empty']);
        expect(rowCodes('.nanovia-doctor-ok')).toEqual(['plugin_ok', 'st_version_ok', 'connection_ok']);
        const order = [...root.querySelectorAll('.nanovia-doctor-group')].map((node) =>
            ['error', 'warn', 'info', 'ok'].find((level) => node.classList.contains(`nanovia-doctor-${level}`)),
        );
        expect(order).toEqual(['error', 'info', 'ok']);
        expect(root.querySelector('.nanovia-doctor-ok')?.hasAttribute('open')).toBe(false);
        expect(text()).toContain('Something needs fixing');
        expect(text()).toContain('Errors: 1');
        expect(text()).toContain('There is no NanoGPT key');
    });

    it('says it is checking while the run is under way', async () => {
        dispose = renderDoctorTab(root, tc.ctx);
        expect(text()).toContain('Checking…');
        expect(button('Run checks').disabled).toBe(true);
        await settle();
        expect(text()).not.toContain('Checking…');
        expect(button('Run checks').disabled).toBe(false);
    });

    it('says all is well when it is', async () => {
        addKey();
        await connection();
        // The catalog has not loaded in this stack: that alone is a note.
        await open();
        expect(text()).toContain('Nothing is broken; a few notes');
        expect(root.querySelector('.nanovia-doctor-error')).toBeNull();
        expect(root.querySelector('.nanovia-doctor-warn')).toBeNull();
    });

    it('speaks Russian', async () => {
        tc.setLocale('ru');
        await open();
        expect(text()).toContain('Запустить проверки');
        expect(text()).toContain('Плагин работает');
    });

    it('registers itself as the tab «doctor», just before «General»', () => {
        const registered: { id: string; titleKey: string; order: number }[] = [];
        const ctx = {
            ...tc.ctx,
            panel: {
                registerTab: (tab: { id: string; titleKey: string; order: number }) => (registered.push(tab), () => {}),
            },
        };
        void doctorFeature.init(ctx as never);
        expect(registered).toMatchObject([{ id: 'doctor', titleKey: 'doctor.tab', order: 500 }]);
        expect(tc.ctx.i18n.has('doctor.check.no_keys.title')).toBe(true);
        expect(tc.ctx.i18n.has('billing.reason.routing.explicit')).toBe(true);
    });
});

describe('the Run checks button', () => {
    it('asks the plugin and the keys again', async () => {
        addKey();
        await open();
        const statusCalls = (): number =>
            h.backend.pluginCalls().filter((call) => call.path.endsWith('/status')).length;
        const checkCalls = (): number => h.backend.pluginCalls().filter((call) => call.path.endsWith('/check')).length;
        const before = { status: statusCalls(), checks: checkCalls() };
        h.backend.plugin.up = false;
        button('Run checks').click();
        await settle();
        expect(statusCalls()).toBeGreaterThan(before.status);
        expect(rowCodes('.nanovia-doctor-warn')).toContain('plugin_down');
        expect(text()).toContain('There was no answer from the SillyTavern server.');

        h.backend.plugin.up = true;
        button('Run checks').click();
        await settle();
        expect(root.querySelector('[data-code="plugin_down"]')).toBeNull();
        expect(checkCalls()).toBeGreaterThan(before.checks);
    });

    it('clears the note about the last fix', async () => {
        await connection();
        h.manager.profiles.length = 0;
        await h.connections.refresh();
        await open();
        button('Repair the profile', row('profile_missing')).click();
        await settle();
        expect(text()).toContain('Done.');
        button('Run checks').click();
        await settle();
        expect(text()).not.toContain('Done.');
    });
});

describe('fixes', () => {
    it('repairs a profile that is gone, and the finding goes away', async () => {
        await connection();
        h.manager.profiles.length = 0;
        await h.connections.refresh();
        await open();
        expect(rowCodes('.nanovia-doctor-warn')).toEqual(['profile_missing']);

        button('Repair the profile', row('profile_missing')).click();
        await settle();
        expect(h.manager.profiles).toHaveLength(1);
        expect(root.querySelector('[data-code="profile_missing"]')).toBeNull();
        expect(text()).toContain('Done.');
        expect(row('connection_ok').textContent).toContain('"Chat": no problems');
    });

    it('checks a key again and shows the new answer', async () => {
        addKey();
        h.backend.plugin.keyChecks.set('key-1', {
            ok: false,
            usdBalance: null,
            nanoBalance: null,
            error: 'HTTP 401: revoked',
        });
        await open();
        expect(row('key_rejected').textContent).toContain('NanoGPT answered: HTTP 401: revoked');

        h.backend.plugin.keyChecks.delete('key-1');
        button('Check the key again', row('key_rejected')).click();
        await settle();
        expect(root.querySelector('[data-code="key_rejected"]')).toBeNull();
        expect(root.querySelector('[data-code="keys_ok"]')).not.toBeNull();
    });

    it('opens another tab of the panel and says nothing more', async () => {
        const open = vi.fn();
        (tc.ctx as { panel: unknown }).panel = { registerTab: () => () => {}, open };
        await connection();
        dispose = renderDoctorTab(root, tc.ctx);
        await settle();
        expect(button('Open "Keys"', row('no_keys'))).toBeDefined();
        button('Open "Keys"', row('no_keys')).click();
        await settle();
        expect(open).toHaveBeenCalledWith('keys');
        expect(text()).not.toContain('Done.');
    });

    it('says why a fix did not work', async () => {
        await connection();
        await open();
        // The panel of the test context cannot open tabs.
        button('Open "Keys"', row('no_keys')).click();
        await settle();
        expect(root.querySelector('.nanovia-notice-error')?.textContent).toBe('The panel cannot be opened from here.');
    });

    it('uses the connections’ own sentence for a refusal from the connections service', async () => {
        await connection();
        await open();
        const refusing = {
            ...tc.ctx,
            doctor: { ...tc.ctx.doctor, applyFix: async () => ({ ok: false as const, code: 'direct_key_required' }) },
        } as FeatureContext;
        dispose?.();
        root.replaceChildren();
        await open(refusing);
        button('Open "Keys"', row('no_keys')).click();
        await settle();
        expect(root.querySelector('.nanovia-notice-error')?.textContent).toBe(
            'Enter your NanoGPT key: direct mode needs it once.',
        );
    });
});

describe('following the service', () => {
    it('redraws when the service reports, and stops after the tab is closed', async () => {
        await open();
        // No key and nothing that needs one: a note.
        expect(row('no_keys').classList.contains('nanovia-check-info')).toBe(true);
        addKey();
        await connection();
        await tc.ctx.doctor.run();
        expect(root.querySelector('[data-code="no_keys"]')).toBeNull();
        expect(root.querySelector('[data-code="keys_ok"]')).not.toBeNull();

        dispose?.();
        dispose = undefined;
        const before = root.innerHTML;
        h.backend.plugin.keys.length = 0;
        await tc.ctx.doctor.run({ refresh: true });
        expect(root.innerHTML).toBe(before);
    });

    it('never shows a key value', async () => {
        addKey();
        h.backend.plugin.keyValues.set('key-1', 'sk-nano-never-shown-in-doctor-0001');
        await open();
        expect(root.innerHTML).not.toContain('never-shown-in-doctor');
    });
});
