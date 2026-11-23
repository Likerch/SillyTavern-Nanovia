// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startNanovia } from '../../src/app/app';
import type { Runtime } from '../../src/app/app';
import type { Feature } from '../../src/core/context';
import { SETTINGS_KEY } from '../../src/core/settings';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
import { createAccountFake, usageRecord } from '../helpers/account-fake';
import type { AccountFake } from '../helpers/account-fake';
import { createFakeBackend, seedConnection } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { flush, memoryLogger } from '../helpers/fakes';
import type { Harness } from '../helpers/harness';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

const globals = globalThis as unknown as Record<string, unknown>;

let mock: StMock;
let backend: FakeBackend;
let runtime: Runtime | null;
let nativeFetch: typeof fetch;

beforeEach(() => {
    mock = installStMock();
    nativeFetch = globalThis.fetch;
    backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    mock.fetchImpl = backend.fetch;
    seedConnectionManager(mock);
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    runtime = null;
});

afterEach(async () => {
    await runtime?.stop();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

describe('startNanovia', () => {
    it('mounts the drawer with the Connections and General tabs, and publishes the API', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(document.querySelector('#extensions_settings2 #nanovia-settings')).not.toBeNull();
        // Later stages add tabs; the Connections tab is there, and «General» always comes last.
        expect(runtime.panel.tabIds()).toContain('connections');
        expect(runtime.panel.tabIds().at(-1)).toBe('general');
        expect(runtime.panel.activeTab()).not.toBe('');
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.version).toBe(1);
        expect(api.features).toContain('connections');
        expect(api.nanoviaVersion).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('asks the plugin once at start, in the background', async () => {
        seedConnection(backend, { name: 'Main', modelId: 'm' }, 'seed000001');
        runtime = await startNanovia();
        const started = runtime;
        // The first ask is a chain of awaits (status, list, secret refresh); wait for its outcome, not a fixed tick count.
        await vi.waitFor(() => expect(started.connections.list().map((e) => e.config.id)).toEqual(['seed000001']));
        expect(runtime.connections.pluginUp()).toBe(true);
        expect((globals[NANOVIA_API_GLOBAL] as NanoviaApi).connections()).toHaveLength(1);
        expect(document.querySelector('[data-connection="seed000001"]')).not.toBeNull();
    });

    it('starts with a dead plugin and shows it', async () => {
        backend.plugin.up = false;
        runtime = await startNanovia();
        await flush();
        await flush();
        expect(runtime.connections.pluginUp()).toBe(false);
        // ST's locale in the mock is Russian.
        expect(document.querySelector('#nanovia-settings')?.textContent).toContain('Плагин не отвечает');
    });

    it('gives features the context, runs their cleanup at stop, and survives a feature that throws', async () => {
        const cleanup = vi.fn();
        const seen: string[] = [];
        const features: Feature[] = [
            {
                id: 'broken',
                init() {
                    throw new Error('boom');
                },
            },
            {
                id: 'fine',
                init(ctx) {
                    seen.push(
                        ctx.version,
                        typeof ctx.plugin.status,
                        typeof ctx.registerRequestHook,
                        typeof ctx.panel.registerTab,
                    );
                    return cleanup;
                },
            },
        ];
        runtime = await startNanovia({ features, skipInitialRefresh: true });
        expect(seen[0]).toMatch(/^\d/);
        expect(seen.slice(1)).toEqual(['function', 'function', 'function']);
        expect((globals[NANOVIA_API_GLOBAL] as NanoviaApi).features).toEqual([
            'fine',
            'describeProfile',
            'describeUrl',
            'usage',
            'account',
            'mgmt',
            'advice',
            'panel',
        ]);
        await runtime.stop();
        expect(cleanup).toHaveBeenCalledOnce();
        runtime = null;
    });

    it('installs the request hook and adds the hint headers for a proxy request', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: 'http://127.0.0.1:8787/c/abc12345/v1',
                type: 'normal',
                reasoning_effort: 'high',
            }),
        });
        const sent = mock.requests.at(-1);
        const body = JSON.parse(String(sent?.init?.body)) as { custom_include_headers: string };
        expect(body.custom_include_headers).toBe('x-nanovia-consumer: "main"\nx-nanovia-effort: "high"\n');
    });

    it('lets a feature register its own request hook, and drops it again', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const hook = vi.fn((request: { body: Record<string, unknown> }) => {
            request.body['added_by_feature'] = true;
        });
        const off = runtime.ctx.registerRequestHook(hook);
        const post = () =>
            fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ model: 'm' }) });
        await post();
        expect(JSON.parse(String(mock.requests.at(-1)?.init?.body))).toEqual({ model: 'm', added_by_feature: true });
        off();
        await post();
        expect(hook).toHaveBeenCalledOnce();
    });

    it('changing the language relabels the drawer', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(document.querySelector('.nanovia-tab')?.textContent).toBe('Подключения');
        runtime.settings.set('uiLanguage', 'en');
        expect(document.querySelector('.nanovia-tab')?.textContent).toBe('Connections');
    });

    it("follows ST's locale when the language is automatic", async () => {
        mock.locale = 'en-us';
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(document.querySelector('.nanovia-tab')?.textContent).toBe('Connections');
    });

    it('waits for APP_READY when the Extensions panel is not in the page yet', async () => {
        document.body.innerHTML = '';
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(document.getElementById('nanovia-settings')).toBeNull();
        document.body.innerHTML = '<div id="extensions_settings2"></div>';
        await mock.eventSource.emit('app_ready');
        expect(document.getElementById('nanovia-settings')).not.toBeNull();
    });

    it('stop removes the drawer, the API and the fetch wrapper, and leaves no listeners', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(globalThis.fetch).not.toBe(nativeFetch);
        await runtime.stop();
        runtime = null;
        expect(document.getElementById('nanovia-settings')).toBeNull();
        expect(globals[NANOVIA_API_GLOBAL]).toBeUndefined();
        expect(globalThis.fetch).toBeTypeOf('function');
        // The request hook is gone: a proxy request goes out unchanged.
        const init = {
            method: 'POST',
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: 'http://127.0.0.1:8787/c/abc12345/v1',
            }),
        };
        await fetch('/api/backends/chat-completions/generate', init);
        expect(mock.requests.at(-1)?.init?.body).toBe(init.body);
        expect(mock.eventSource.count('app_ready')).toBe(0);
    });

    it('can start again after a stop (a reload of the extension)', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        await runtime.stop();
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(document.querySelectorAll('#nanovia-settings')).toHaveLength(1);
        expect(Object.keys(mock.extensionSettings)).toContain(SETTINGS_KEY);
    });

    it('keeps its settings under extension_settings.nanovia, with no secret in them', async () => {
        const saved = await (async () => {
            runtime = await startNanovia({ skipInitialRefresh: true });
            return runtime.connections.save({
                patch: { name: 'Direct', modelId: 'm', mode: 'direct' },
                directKey: 'sk-nano-never-in-settings-0001',
            });
        })();
        expect(saved.ok).toBe(true);
        const stored = mock.extensionSettings[SETTINGS_KEY];
        expect(JSON.stringify(stored)).not.toContain('sk-nano-never-in-settings-0001');
        expect(JSON.stringify(mock.extensionSettings)).not.toContain('sk-nano-never-in-settings-0001');
    });
});

describe('account, usage and the panel API', () => {
    let fake: AccountFake;

    beforeEach(() => {
        fake = createAccountFake({ backend, mock, log: memoryLogger() } as unknown as Harness);
        mock.fetchImpl = fake.fetch;
    });

    it('registers the Account tab and publishes usage, account and openPanel', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(runtime.panel.tabIds()).toContain('account');
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.features).toEqual(expect.arrayContaining(['account', 'usage', 'advice', 'panel', 'describeUrl']));
        expect(typeof api.usage?.today).toBe('function');
        expect(typeof api.account?.refresh).toBe('function');
        expect(typeof api.advice?.backgroundProfile).toBe('function');
        expect(typeof api.openPanel).toBe('function');
    });

    it("loads today's usage from the plugin once, after the first answer of the plugin", async () => {
        fake.records.push(
            usageRecord({ at: Date.now() - 1000, costUsd: 0.75, equivalentUsd: 1.5, requestId: 'srv-1' }),
        );
        runtime = await startNanovia();
        await flush();
        await flush();
        const calls = fake.callsTo('GET /spend');
        expect(calls).toHaveLength(1);
        expect(calls[0]?.path).toMatch(/^\/spend\?from=\d+&to=\d+$/);
        expect(runtime.usage.today()).toMatchObject({ requests: 1, costUsd: 0.75, equivalentUsd: 1.5 });
        expect(fake.callsTo('GET /account')).toHaveLength(0);
    });

    it('does not ask a dead plugin for usage', async () => {
        backend.plugin.up = false;
        runtime = await startNanovia();
        await flush();
        await flush();
        expect(fake.callsTo('GET /spend')).toHaveLength(0);
        expect(runtime.usage.state().pluginLoaded).toBe(false);
    });

    it('counts the requests the browser sees (direct mode) and tells the API listeners', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        const seen: string[] = [];
        api.usage?.onRecord((record) => seen.push(record.model));
        await runtime.ctx.bus.emit('usage:record', {
            record: usageRecord({ at: Date.now(), model: 'direct/model', costUsd: 0.2, equivalentUsd: 0.2 }),
        });
        expect(seen).toEqual(['direct/model']);
        expect(api.usage?.recent(1)[0]?.model).toBe('direct/model');
    });

    it('opens the drawer at a tab through the API', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        api.openPanel?.('account');
        expect(runtime.panel.activeTab()).toBe('account');
        api.openPanel?.('general');
        expect(runtime.panel.activeTab()).toBe('general');
        api.openPanel?.('no-such-tab');
        expect(runtime.panel.activeTab()).toBe('general');
    });

    it('stops polling when the app stops', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            runtime = await startNanovia({ skipInitialRefresh: true });
            runtime.panel.select('account');
            await flush();
            const before = fake.callsTo('GET /spend').length;
            expect(before).toBeGreaterThan(0);
            await runtime.stop();
            runtime = null;
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(fake.callsTo('GET /spend')).toHaveLength(before);
        } finally {
            vi.useRealTimers();
        }
    });
});
