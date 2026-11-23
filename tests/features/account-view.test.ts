// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature } from '../../src/core/context';
import { accountFeature } from '../../src/features/account';
import { SPEND_THROTTLE_MS, renderAccountTab } from '../../src/features/account/view';
import type { SubscriptionUsage } from '../../src/shared/contracts-account';
import { usageRecord } from '../helpers/account-fake';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    root = document.createElement('div');
    document.body.appendChild(root);
    dispose = undefined;
});

afterEach(() => {
    dispose?.();
    tc.usage.dispose();
    root.remove();
    vi.useRealTimers();
    h.restore();
});

/** Lets pending promises and (real) timers run; with fake timers it only drains microtasks. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
        if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
        else await flush();
    }
};

/** Asks the plugin (as the app does at start), then draws the tab. */
async function open(): Promise<void> {
    await h.connections.refresh();
    dispose = renderAccountTab(root, tc.ctx);
    await settle();
}

const text = (selector: string): string => root.querySelector(selector)?.textContent ?? '';
const all = (selector: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(selector)];

function button(label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!found) {
        const labels = [...root.querySelectorAll('button')].map((b) => b.textContent).join(' | ');
        throw new Error(`no button "${label}"; buttons: ${labels}`);
    }
    return found;
}

async function click(label: string): Promise<void> {
    button(label).click();
    await settle();
}

function choose(ariaLabel: string, value: string): void {
    const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`);
    if (!select) throw new Error(`no select "${ariaLabel}"`);
    select.value = value;
    select.dispatchEvent(new Event('change'));
}

const SUBSCRIPTION: SubscriptionUsage = {
    active: true,
    daily: { used: 2500, limit: 10_000, resetsAt: Date.now() + 3 * HOUR },
    weekly: { used: 90_000, limit: 100_000, resetsAt: Date.now() + 3 * DAY },
    recommendedMode: 'paygo',
};

async function savedConnection(name = 'Main'): Promise<string> {
    const saved = await h.connections.save({ patch: { name, modelId: 'vendor/a', mode: 'plugin' } });
    if (!saved.ok) throw new Error('save failed');
    return saved.data.id;
}

describe('the account cards', () => {
    it('show the balance, both quota bars and what NanoGPT recommends', async () => {
        tc.fake.subscription = SUBSCRIPTION;
        tc.fake.nanoBalance = 0.25;
        await open();
        const cards = text('.nanovia-account-cards');
        expect(cards).toContain('Balance');
        expect(cards).toContain('$12.50');
        expect(cards).toContain('XNO: 0.25');
        expect(cards).toContain('Subscription');
        expect(cards).toContain('2500 of 10k tokens (25%)');
        expect(cards).toContain('90k of 100k tokens (90%)');
        expect(cards).toContain('resets in 2 h');
        expect(cards).toContain('NanoGPT recommends: pay-as-you-go');
        const bars = all('[role="progressbar"]');
        expect(bars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['25', '90']);
        expect(bars[0]?.firstElementChild?.className).toContain('nanovia-bar-ok');
        expect(bars[1]?.firstElementChild?.className).toContain('nanovia-bar-warn');
        expect(text('.nanovia-notice-host')).toBe('');
        expect(text('.nanovia-account-cards')).toContain('Updated');
    });

    it('say there is no subscription when the account has none', async () => {
        await open();
        expect(text('.nanovia-account-cards')).toContain('No active subscription');
        expect(all('[role="progressbar"]')).toHaveLength(0);
    });

    it('draw a window only when NanoGPT reports something about it', async () => {
        tc.fake.subscription = {
            ...SUBSCRIPTION,
            weekly: { used: null, limit: null, resetsAt: null },
            recommendedMode: null,
        };
        await open();
        expect(all('[role="progressbar"]')).toHaveLength(1);
        expect(text('.nanovia-account-cards')).not.toContain('recommends');
    });

    it('are replaced by a clear message when the plugin is not answering', async () => {
        h.backend.plugin.up = false;
        await open();
        expect(text('.nanovia-notice-host')).toContain('plugin is not answering');
        expect(all('.nanovia-account-cards > *')).toHaveLength(0);
        expect(tc.fake.callsTo('GET /account')).toHaveLength(0);
    });

    it('keep the last numbers and say they are old when the plugin goes away later', async () => {
        await open();
        expect(text('.nanovia-account-cards')).toContain('$12.50');
        h.backend.plugin.up = false;
        button('Refresh').click();
        await settle();
        expect(text('.nanovia-account-cards')).toContain('$12.50');
        expect(text('.nanovia-account-cards')).toContain('the last refresh failed');
        expect(text('.nanovia-notice-host')).toContain('last ones');
    });

    it('explain that balance and subscription need the plugin when it is not installed', async () => {
        h.backend.plugin.installed = false;
        await open();
        expect(text('.nanovia-notice-host')).toContain('read by the Nanovia plugin');
        expect(all('.nanovia-account-cards > *')).toHaveLength(0);
    });

    it('point to the Keys tab when the plugin has no key', async () => {
        tc.fake.balances.delete('');
        const openPanel = vi.fn();
        tc.ctx.panel = { registerTab: () => () => {}, open: openPanel };
        await open();
        expect(text('.nanovia-notice-host')).toContain('no NanoGPT key');
        await click('Open the Keys tab');
        expect(openPanel).toHaveBeenCalledWith('keys');
    });

    it('say what NanoGPT answered when it refuses the key', async () => {
        tc.fake.fail.set('GET /account/balance', { status: 502, code: 'key_rejected' });
        await open();
        expect(text('.nanovia-notice-host')).toContain('rejected the key');
        expect(button('Open the Keys tab')).toBeDefined();
    });
});

describe('the key selector', () => {
    function twoKeys(): void {
        h.backend.plugin.keys.push(
            { id: 'k1', label: 'Main', active: true, masked: 'sk-nano-…1111' },
            { id: 'k2', label: 'Spare', active: false, masked: 'sk-nano-…2222' },
        );
        tc.fake.balances.set('k2', 3.5);
    }

    it('is absent without keys, and lists the active key first when there are some', async () => {
        await open();
        expect(root.querySelector('select[aria-label="NanoGPT key"]')).toBeNull();
        dispose?.();
        root.replaceChildren();
        twoKeys();
        dispose = renderAccountTab(root, tc.ctx);
        await settle();
        const select = root.querySelector<HTMLSelectElement>('select[aria-label="NanoGPT key"]')!;
        expect([...select.options].map((o) => o.textContent)).toEqual([
            'Active key',
            'Main · sk-nano-…1111 (active)',
            'Spare · sk-nano-…2222',
        ]);
    });

    it('reads the account of the chosen key and forgets the numbers of the previous one', async () => {
        twoKeys();
        await open();
        expect(text('.nanovia-account-cards')).toContain('$12.50');
        choose('NanoGPT key', 'k2');
        await settle();
        expect(text('.nanovia-account-cards')).toContain('$3.50');
        expect(tc.account.keyId()).toBe('k2');
        expect(tc.fake.callsTo('GET /account/balance').map((call) => call.path)).toContain('/account/balance?keyId=k2');
        choose('NanoGPT key', '');
        await settle();
        expect(tc.account.keyId()).toBeNull();
        expect(text('.nanovia-account-cards')).toContain('$12.50');
    });
});

describe('the refresh button', () => {
    it('asks the plugin and the account again, ignoring the cache', async () => {
        await open();
        const before = tc.fake.callsTo('GET /account/balance').length;
        tc.fake.balances.set('', 99);
        await click('Refresh');
        expect(tc.fake.callsTo('GET /account/balance').length).toBe(before + 1);
        expect(text('.nanovia-account-cards')).toContain('$99.00');
    });

    it('notices the plugin coming back', async () => {
        h.backend.plugin.up = false;
        await open();
        expect(text('.nanovia-notice-host')).toContain('not answering');
        h.backend.plugin.up = true;
        await click('Refresh');
        expect(text('.nanovia-account-cards')).toContain('$12.50');
        expect(text('.nanovia-notice-host')).toBe('');
    });
});

describe('spend', () => {
    async function seed(): Promise<string> {
        const id = await savedConnection('Main');
        const now = Date.now();
        tc.fake.records.push(
            usageRecord({
                at: now - 2000,
                connectionId: id,
                model: 'vendor/a',
                billing: 'paygo',
                costUsd: 0.5,
                equivalentUsd: 0.5,
            }),
            usageRecord({
                at: now - 1000,
                connectionId: id,
                model: 'vendor/b',
                billing: 'subscription',
                costUsd: 0,
                equivalentUsd: 2,
            }),
            usageRecord({ at: now - 10 * DAY, connectionId: null, model: 'vendor/old', costUsd: 7, equivalentUsd: 9 }),
        );
        return id;
    }

    it('puts the real cost beside the pay-as-you-go equivalent for today, 7 days and 30 days', async () => {
        await seed();
        await open();
        const real = (range: string) => text(`.nanovia-spend-card[data-range="${range}"] .nanovia-spend-real`);
        const equivalent = (range: string) =>
            text(`.nanovia-spend-card[data-range="${range}"] .nanovia-spend-equivalent`);
        expect([real('today'), equivalent('today')]).toEqual(['$0.50', '$2.50']);
        expect([real('week'), equivalent('week')]).toEqual(['$0.50', '$2.50']);
        expect([real('month'), equivalent('month')]).toEqual(['$7.50', '$11.50']);
        expect(text('.nanovia-spend-card[data-range="month"]')).toContain('3 requests');
        expect(text('.nanovia-spend-card[data-range="today"]')).toContain('Real cost');
        expect(text('.nanovia-spend-card[data-range="today"]')).toContain('Equivalent (informational)');
    });

    it('says in plain words that the equivalent never counts toward a cap', async () => {
        await open();
        expect(text('.nanovia-spend-note')).toContain('informational');
        expect(text('.nanovia-spend-note')).toContain('never counts toward any spending cap');
    });

    it('breaks the chosen period down by connection (by name) and by model', async () => {
        const id = await seed();
        await open();
        const rows = (block: number) => all('.nanovia-table-block')[block]!.querySelectorAll('tbody tr');
        expect(all('.nanovia-table-block')).toHaveLength(2);
        expect([...rows(0)].map((row) => row.textContent)).toEqual([expect.stringContaining('Main')]);
        expect([...rows(1)].map((row) => row.querySelector('td')?.textContent)).toEqual(['vendor/a', 'vendor/b']);
        expect(rows(0)[0]?.getAttribute('data-row')).toBe(id);

        choose('Details for', 'month');
        expect([...rows(0)].map((row) => row.querySelector('td')?.textContent)).toEqual(['outside Nanovia', 'Main']);
        expect([...rows(1)].map((row) => row.querySelector('td')?.textContent)).toEqual([
            'vendor/old',
            'vendor/a',
            'vendor/b',
        ]);
    });

    it('says when a period has no requests', async () => {
        await open();
        expect(text('section')).toContain('No requests in this period.');
        expect(all('.nanovia-table-block')).toHaveLength(0);
    });

    it('falls back to what the browser saw, and says so, when the plugin is not answering', async () => {
        h.backend.plugin.up = false;
        await h.bus.emit('usage:record', {
            record: usageRecord({
                at: Date.now(),
                requestId: 'd1',
                model: 'direct/x',
                costUsd: 0.2,
                equivalentUsd: 0.4,
            }),
        });
        await open();
        expect(text('.nanovia-spend-card[data-range="today"] .nanovia-spend-real')).toBe('$0.20');
        expect(text('.nanovia-account-section')).toContain('cover only the requests this browser has seen');
        expect(all('.nanovia-table-block')).toHaveLength(2);
    });

    it('uses another sentence when there is no plugin at all', async () => {
        h.backend.plugin.installed = false;
        await open();
        expect(text('.nanovia-account-section')).toContain('Without the plugin');
    });

    it('draws a dash, not a zero, for a period it could not read', async () => {
        const stuck = createContext(h);
        stuck.ctx.usage.summary = () => new Promise(() => {});
        await h.connections.refresh();
        dispose = renderAccountTab(root, stuck.ctx);
        await settle();
        expect(text('.nanovia-spend-card[data-range="today"] .nanovia-spend-real')).toBe('—');
        stuck.usage.dispose();
    });
});

describe('recent requests', () => {
    const emit = (patch: Parameters<typeof usageRecord>[0]) =>
        h.bus.emit('usage:record', { record: usageRecord({ at: Date.now(), ...patch }) });

    it('lists what the browser saw, newest first, with billing, both costs, tokens, cache share and latency', async () => {
        const id = await savedConnection('Main');
        await emit({ at: Date.now() - 5000, requestId: 'old', model: 'vendor/old', connectionId: id });
        await emit({
            requestId: 'new',
            model: 'vendor/new',
            connectionId: id,
            billing: 'subscription',
            costUsd: 0,
            equivalentUsd: 0.034,
            promptTokens: 2000,
            completionTokens: 300,
            cachedTokens: 1500,
            latencyMs: 2400,
        });
        await open();
        const rows = all('.nanovia-recent-row');
        expect(rows.map((row) => row.dataset['request'])).toEqual(['new', 'old']);
        const first = rows[0]!.textContent ?? '';
        expect(first).toContain('Main');
        expect(first).toContain('vendor/new');
        expect(first).toContain('subscription');
        expect(first).toContain('Cost: $0.00');
        expect(first).toContain('Equivalent: $0.034');
        expect(first).toContain('2000 → 300 tokens');
        expect(first).toContain('75% cached');
        expect(first).toContain('2.4 s');
    });

    it('flags a failed request and shows an unknown cost as a dash', async () => {
        await emit({
            requestId: 'bad',
            status: 502,
            error: 'upstream_unreachable',
            billing: 'unknown',
            costUsd: null,
            equivalentUsd: null,
        });
        await open();
        const row = all('.nanovia-recent-row')[0]!;
        expect(row.textContent).toContain('error');
        expect(row.querySelector('.nanovia-chip-error')?.getAttribute('title')).toBe('upstream_unreachable');
        expect(row.textContent).toContain('Cost: —');
        expect(row.textContent).toContain('outside Nanovia');
    });

    it('says there is nothing yet', async () => {
        await open();
        expect(text('.nanovia-account-section:last-child')).toContain('No requests seen yet.');
    });

    it('shows a request that arrives while the tab is open', async () => {
        await open();
        expect(all('.nanovia-recent-row')).toHaveLength(0);
        await emit({ requestId: 'live', model: 'vendor/live' });
        await settle();
        expect(all('.nanovia-recent-row').map((row) => row.dataset['request'])).toEqual(['live']);
    });

    it('checks the exact cost: "not ready" shows no figure, a ready answer shows it', async () => {
        await emit({ requestId: 'req-1' });
        await open();
        await click('Check exact cost');
        expect(text('.nanovia-lookup')).toBe('Not ready yet, try again later.');
        expect(text('.nanovia-recent-row')).not.toContain('Exact cost');

        tc.fake.lookups.set('req-1', { requestId: 'req-1', ready: true, costUsd: 0.0123 });
        await click('Check exact cost');
        expect(text('.nanovia-lookup')).toBe('Exact cost: $0.0123');
        expect(tc.fake.callsTo('POST /lookup').map((call) => call.path)).toEqual(['/lookup/req-1', '/lookup/req-1']);
    });

    it('does not offer the check without a request id, and disables it without the plugin', async () => {
        await emit({ requestId: null });
        await open();
        expect(text('.nanovia-recent-row')).toContain('no request id');
        expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Check exact cost')).toBe(false);

        dispose?.();
        root.replaceChildren();
        await emit({ requestId: 'req-2' });
        h.backend.plugin.up = false;
        await open();
        const check = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Check exact cost')!;
        expect(check.disabled).toBe(true);
        expect(check.getAttribute('title')).toContain('Needs the Nanovia plugin');
    });

    it('reports a plugin that stops answering in the middle of a check', async () => {
        await emit({ requestId: 'req-3' });
        await open();
        h.backend.plugin.up = false;
        await click('Check exact cost');
        expect(text('.nanovia-lookup')).toBe('The plugin is not answering.');
    });
});

describe('watching', () => {
    it('starts the usage polling while the tab is open and stops it when it closes', async () => {
        const stop = vi.fn();
        const watch = vi.spyOn(tc.usage, 'watch').mockReturnValue(stop);
        await open();
        expect(watch).toHaveBeenCalledOnce();
        expect(stop).not.toHaveBeenCalled();
        dispose?.();
        dispose = undefined;
        expect(stop).toHaveBeenCalledOnce();
    });

    it('asks the plugin for the three periods once on opening, and not again on every record', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await open();
        const spend = () => tc.fake.callsTo('GET /spend').length;
        const afterOpen = spend();
        expect(afterOpen).toBeGreaterThanOrEqual(3);

        await h.bus.emit('usage:record', { record: usageRecord({ at: Date.now(), requestId: 'a' }) });
        await h.bus.emit('usage:record', { record: usageRecord({ at: Date.now(), requestId: 'b' }) });
        await settle();
        expect(spend()).toBe(afterOpen);
        await vi.advanceTimersByTimeAsync(SPEND_THROTTLE_MS);
        await settle();
        // One trailing load for both records (three periods), not one per record.
        expect(spend()).toBe(afterOpen + 3);
    });

    it('stops reacting after it is closed', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await open();
        await h.bus.emit('usage:record', { record: usageRecord({ at: Date.now(), requestId: 'a' }) });
        const calls = tc.fake.callsTo('GET /spend').length;
        dispose?.();
        dispose = undefined;
        await vi.advanceTimersByTimeAsync(10 * SPEND_THROTTLE_MS);
        await h.bus.emit('usage:record', { record: usageRecord({ at: Date.now(), requestId: 'b' }) });
        await settle();
        expect(tc.fake.callsTo('GET /spend').length).toBe(calls);
        expect(all('.nanovia-recent-row')).toHaveLength(1);
    });
});

describe('language', () => {
    it('draws in Russian when the interface is Russian', async () => {
        tc.setLocale('ru');
        await open();
        expect(text('.nanovia-account-cards')).toContain('Баланс');
        expect(text('.nanovia-account-cards')).toContain('Активной подписки нет');
        expect(text('.nanovia-account-section')).toContain('Расходы');
        expect(text('.nanovia-spend-note')).toContain('никогда не учитывается');
        expect(button('Обновить')).toBeDefined();
    });
});

describe('the feature', () => {
    it('registers the tab «Account» and its strings, and gives the tab back on cleanup', () => {
        const registered: { id: string; titleKey: string; order: number }[] = [];
        const off = vi.fn();
        const ctx = {
            ...tc.ctx,
            panel: {
                registerTab: (tab: { id: string; titleKey: string; order: number }) => {
                    registered.push(tab);
                    return off;
                },
            },
        };
        const feature: Feature = accountFeature;
        expect(feature.id).toBe('account');
        const cleanup = feature.init(ctx);
        expect(registered).toHaveLength(1);
        expect(registered[0]).toMatchObject({ id: 'account', titleKey: 'account.tab' });
        expect(registered[0]!.order).toBeGreaterThan(100);
        expect(registered[0]!.order).toBeLessThan(1000);
        expect(ctx.i18n.t('account.tab')).toBe('Account');
        expect(typeof cleanup).toBe('function');
        (cleanup as () => void)();
        expect(off).toHaveBeenCalledOnce();
    });
});
