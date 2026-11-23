import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginClient, isPluginDown } from '../../src/host/plugin-client';
import type { PluginClient } from '../../src/host/plugin-client';
import { createFakeBackend, seedConnection } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { memoryLogger } from '../helpers/fakes';
import type { MemoryLogger } from '../helpers/fakes';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;
let backend: FakeBackend;
let log: MemoryLogger;
let clock = 0;
let client: PluginClient;

beforeEach(() => {
    mock = installStMock();
    backend = createFakeBackend();
    mock.fetchImpl = backend.fetch;
    backend.csrf = mock.csrfToken;
    log = memoryLogger();
    clock = 1000;
    client = createPluginClient({
        ctx: () => mock.context,
        log,
        fetchImpl: backend.fetch,
        now: () => clock,
        ttlMs: 5000,
        timeoutMs: 50,
    });
});

afterEach(() => mock.restore());

describe('status and availability', () => {
    it('reads the status and remembers it', async () => {
        expect(client.lastStatus()).toBeNull();
        const result = await client.status();
        expect(result).toMatchObject({ ok: true, data: { version: '0.1.0', proxy: { up: true, port: 8787 } } });
        expect(client.lastStatus()?.user).toBe('default-user');
    });

    it("sends ST's CSRF header on every call, and a content type only with a body", async () => {
        await client.status();
        await client.createConnection({ name: 'A', modelId: 'm' });
        const [get, post] = backend.pluginCalls();
        expect(get?.headers['X-CSRF-Token']).toBe('csrf-token-1');
        expect(get?.headers['Content-Type']).toBeUndefined();
        expect(post?.headers['Content-Type']).toBe('application/json');
    });

    it('caches availability for the TTL, and fresh asks again', async () => {
        expect(await client.available()).toBe(true);
        backend.plugin.up = false;
        clock += 1000;
        expect(await client.available()).toBe(true);
        expect(backend.pluginCalls()).toHaveLength(1);
        expect(await client.available({ fresh: true })).toBe(false);
        expect(backend.pluginCalls()).toHaveLength(2);
        clock += 6000;
        backend.plugin.up = true;
        expect(await client.available()).toBe(true);
    });

    it('answers concurrent availability questions with one request', async () => {
        const answers = await Promise.all([client.available(), client.available(), client.available()]);
        expect(answers).toEqual([true, true, true]);
        expect(backend.pluginCalls()).toHaveLength(1);
    });

    it('invalidate forgets the cache', async () => {
        await client.available();
        client.invalidate();
        await client.available();
        expect(backend.pluginCalls()).toHaveLength(2);
    });

    it('is down, never throwing, when nothing answers', async () => {
        backend.plugin.up = false;
        const result = await client.status();
        expect(result).toMatchObject({ ok: false, error: { code: 'unreachable', status: null } });
        expect(await client.available({ fresh: true })).toBe(false);
        expect(client.lastStatus()).toBeNull();
        if (result.ok) throw new Error('expected a failure');
        expect(isPluginDown(result.error)).toBe(true);
    });

    it('tells a missing plugin (ST answers 404) from a refused request (403)', async () => {
        backend.plugin.installed = false;
        const missing = await client.status();
        expect(missing).toMatchObject({ ok: false, error: { code: 'not_installed', status: 404 } });
        expect(await client.available({ fresh: true })).toBe(false);

        backend.plugin.installed = true;
        backend.csrf = 'another-token';
        const refused = await client.status();
        expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
        expect(await client.available({ fresh: true })).toBe(false);
    });

    it('reports a timeout when the plugin does not answer in time', async () => {
        const hanging = createPluginClient({
            ctx: () => mock.context,
            log,
            timeoutMs: 20,
            fetchImpl: (_input, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                }),
        });
        const result = await hanging.status();
        expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
    });

    it("rejects an answer that is not the contract's shape", async () => {
        const odd = createPluginClient({
            ctx: () => mock.context,
            log,
            fetchImpl: async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
        });
        expect(await odd.status()).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
        const html = createPluginClient({
            ctx: () => mock.context,
            log,
            fetchImpl: async () => new Response('<html>nope</html>', { status: 200 }),
        });
        expect(await html.listKeys()).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
    });
});

describe('connections', () => {
    it('creates, lists, updates, rotates and deletes', async () => {
        const created = await client.createConnection({
            name: 'Main',
            modelId: 'deepseek/deepseek-v4',
            mode: 'plugin',
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        const id = created.data.id;
        expect(created.data).toMatchObject({
            name: 'Main',
            mode: 'plugin',
            proxyUrl: `http://127.0.0.1:8787/c/${id}/v1`,
            directUrl: 'https://api.nano-gpt.com/api/v1',
        });
        expect(created.data.tokenSecretId).toBeTruthy();

        const listed = await client.listConnections();
        expect(listed.ok && listed.data.map((c) => c.id)).toEqual([id]);

        const updated = await client.updateConnection(id, { billing: 'subscription' });
        expect(updated).toMatchObject({ ok: true, data: { id, billing: 'subscription' } });

        const oldToken = created.data.tokenSecretId;
        const rotated = await client.rotateToken(id);
        expect(rotated.ok && rotated.data.tokenSecretId).not.toBe(oldToken);

        expect(await client.deleteConnection(id)).toEqual({ ok: true, data: true });
        const empty = await client.listConnections();
        expect(empty).toEqual({ ok: true, data: [] });
    });

    it("turns the plugin's error body into a typed error", async () => {
        const missing = await client.updateConnection('abc12345', { note: 'x' });
        expect(missing).toMatchObject({
            ok: false,
            error: { code: 'not_found', status: 404, message: 'no such connection' },
        });
        const bad = await client.createConnection({ name: '', modelId: '' });
        expect(bad).toMatchObject({ ok: false, error: { code: 'bad_request', status: 400 } });
        backend.plugin.failNext.set('GET /connections', { status: 500, code: 'internal', message: 'boom' });
        expect(await client.listConnections()).toMatchObject({ ok: false, error: { code: 'internal', status: 500 } });
        // A refused request does not make the plugin unavailable.
        expect(await client.available()).toBe(true);
    });

    it('labels an error without a body by its status', async () => {
        const odd = createPluginClient({
            ctx: () => mock.context,
            log,
            fetchImpl: async () => new Response('oops', { status: 502 }),
        });
        expect(await odd.listConnections()).toMatchObject({ ok: false, error: { code: 'http_502', status: 502 } });
    });

    it('skips connections of the list that are not valid and warns', async () => {
        seedConnection(backend, { name: 'Good', modelId: 'm' }, 'good1234');
        backend.plugin.connections.set('broken', { id: 'x', name: '', modelId: '' } as never);
        const result = await client.listConnections();
        expect(result.ok && result.data.map((c) => c.id)).toEqual(['good1234']);
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
    });
});

describe('keys', () => {
    it('adds a key without ever echoing or logging its value', async () => {
        const value = 'sk-nano-0123456789abcdef';
        const added = await client.addKey('Main key', value);
        expect(added).toMatchObject({ ok: true, data: { label: 'Main key', active: true } });
        expect(JSON.stringify(added)).not.toContain(value);
        expect(backend.plugin.keyValues.size).toBe(1);
        expect(JSON.stringify(log.lines)).not.toContain(value);
    });

    it('lists, checks and deletes keys', async () => {
        const added = await client.addKey('K', 'sk-nano-aaaa1111');
        if (!added.ok) throw new Error('add failed');
        const listed = await client.listKeys();
        expect(listed.ok && listed.data).toEqual([added.data]);
        expect(await client.checkKey(added.data.id)).toEqual({
            ok: true,
            data: { ok: true, usdBalance: '1.50', nanoBalance: null, error: null },
        });
        expect(await client.deleteKey(added.data.id)).toEqual({ ok: true, data: true });
        expect(await client.checkKey(added.data.id)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });
});

describe('request', () => {
    it('makes a raw call with the same headers and notes that the plugin answered', async () => {
        const result = await client.request('GET', '/status');
        expect(result).toMatchObject({ ok: true, data: { plugin: true } });
        expect(backend.pluginCalls().at(-1)?.headers['X-CSRF-Token']).toBe('csrf-token-1');
        expect(await client.available()).toBe(true);
    });

    it('never throws: a missing route and a dead plugin are error values', async () => {
        expect(await client.request('GET', '/nowhere')).toMatchObject({ ok: false, error: { code: 'not_found' } });
        backend.plugin.up = false;
        expect(await client.request('GET', '/status')).toMatchObject({ ok: false, error: { code: 'unreachable' } });
        expect(await client.available()).toBe(false);
    });
});
