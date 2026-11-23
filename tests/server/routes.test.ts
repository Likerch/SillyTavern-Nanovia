/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_KEY_CUSTOM, SECRET_KEY_NANOGPT } from '../../src/shared/constants';
import { hashToken } from '../../src/server/tokens';
import {
    NANO_KEY,
    boot,
    chat,
    cleanTempDirs,
    jsonUpstream,
    startServer,
    type Harness,
    type TestServer,
} from './helpers';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanTempDirs();
});

async function harness(options: Parameters<typeof boot>[0] = {}): Promise<Harness> {
    const h = await boot(options);
    closers.push(() => h.close());
    return h;
}

async function server(s: Promise<TestServer>): Promise<TestServer> {
    const started = await s;
    closers.push(() => started.close());
    return started;
}

const registryOf = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.root, '_nanovia', 'registry.json'), 'utf8'));

describe('GET /status', () => {
    it('reports the version, the bound proxy, the secret store and the user', async () => {
        const h = await harness();
        const { status, json } = await h.api('GET', '/status');
        expect(status).toBe(200);
        expect(json).toEqual({
            version: '9.9.9-test',
            plugin: true,
            proxy: { up: true, host: '127.0.0.1', port: h.app.proxy.status().port },
            secrets: true,
            user: 'default-user',
        });
        expect((await h.api('GET', '/status', undefined, 'alice')).json['user']).toBe('alice');
    });

    it('reports secrets: false in degraded mode', async () => {
        const h = await harness();
        h.st.available = false;
        expect((await h.api('GET', '/status')).json['secrets']).toBe(false);
    });
});

describe('connections', () => {
    it('lists nothing at first and creates a connection with defaults and a proxy token', async () => {
        const h = await harness();
        expect((await h.api('GET', '/connections')).json).toEqual({ connections: [] });
        const created = await h.api('POST', '/connections', { name: 'Main', modelId: 'zai-org/glm-5' });
        expect(created.status).toBe(200);
        const view = created.json['connection'];
        expect(view).toMatchObject({
            name: 'Main',
            modelId: 'zai-org/glm-5',
            mode: 'auto',
            billing: 'auto',
            stripNeutralSamplers: true,
            modelLock: false,
            keyId: null,
            directUrl: 'https://api.nano-gpt.com/api/v1',
        });
        expect(view.id).toMatch(/^[a-z0-9]{8}$/);
        expect(view.proxyUrl).toBe(`http://127.0.0.1:${h.app.proxy.status().port}/c/${view.id}/v1`);
        expect(view.tokenSecretId).toBeTruthy();

        const listed = (await h.api('GET', '/connections')).json['connections'];
        expect(listed).toHaveLength(1);
        expect(listed[0].id).toBe(view.id);
    });

    it('stores the token in ST under api_key_custom, labelled, and only its hash in the registry', async () => {
        const h = await harness();
        const { view, token } = await h.connect({ name: 'Narrator' });
        const secrets = h.st.listSecrets('default-user', SECRET_KEY_CUSTOM);
        expect(secrets).toHaveLength(1);
        expect(secrets[0]).toMatchObject({ id: view.tokenSecretId, label: 'Nanovia: Narrator' });
        expect(token).toBe(secrets[0]!.value);
        const registry = registryOf(h);
        expect(registry.version).toBe(1);
        expect(registry.tokens[hashToken(token)]).toMatchObject({ connectionId: view.id, userHandle: 'default-user' });
        expect(JSON.stringify(registry)).not.toContain(token);
        // the token reaches nobody through the admin API
        const all = (await h.api('GET', '/connections')).text;
        expect(all).not.toContain(token);
    });

    it('persists connections per user under <user root>/nanovia/connections.json', async () => {
        const h = await harness();
        const a = await h.connect({ name: 'Alice conn' }, 'alice');
        await h.connect({ name: 'Bob conn' }, 'bob');
        const file = path.join(h.st.userRoot('alice'), 'nanovia', 'connections.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(raw.version).toBe(1);
        expect(raw.connections.map((c: any) => c.id)).toEqual([a.view.id]);
        expect((await h.api('GET', '/connections', undefined, 'alice')).json['connections']).toHaveLength(1);
        expect((await h.api('GET', '/connections', undefined, 'bob')).json['connections']).toHaveLength(1);
        expect((await h.api('GET', '/connections', undefined, 'carol')).json['connections']).toHaveLength(0);
        expect((await h.api('PUT', `/connections/${a.view.id}`, { note: 'x' }, 'bob')).status).toBe(404);
    });

    it('validates input with 400 and { error: { code, message } }', async () => {
        const h = await harness();
        for (const body of [
            {},
            { name: 'x' },
            { modelId: 'm' },
            { name: '  ', modelId: 'm' },
            { name: 'x', modelId: 'm', mode: 'weird' },
            { name: 'x', modelId: 'm', billing: 5 },
            { name: 'x', modelId: 'm', modelLock: 'yes' },
            { name: 'x', modelId: 'm', routing: [] },
            { name: 'x', modelId: 'm', keyId: '' },
        ]) {
            const res = await h.api('POST', '/connections', body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.json['error']).toEqual({ code: 'invalid_request', message: expect.any(String) });
        }
        const notObject = await fetch(`${h.admin}/connections`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '[1]',
        });
        expect(notObject.status).toBe(400);
        expect((await h.api('GET', '/connections')).json['connections']).toHaveLength(0);
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(0);
    });

    it('updates fields, keeps id and createdAt, and merges nested objects', async () => {
        let clock = 1_000;
        const h = await harness({ now: () => (clock += 100) });
        const { view } = await h.connect();
        const res = await h.api('PUT', `/connections/${view.id}`, {
            id: 'hijack00',
            createdAt: 1,
            name: 'Renamed',
            modelLock: true,
            routing: { enabled: true, sort: 'price' },
            reasoning: { policy: 'fixed', effort: 'high' },
        });
        expect(res.status).toBe(200);
        const updated = res.json['connection'];
        expect(updated).toMatchObject({
            id: view.id,
            name: 'Renamed',
            modelLock: true,
            createdAt: view.createdAt,
            routing: { enabled: true, sort: 'price', allowFallbacks: true },
            reasoning: { policy: 'fixed', effort: 'high', hideThoughts: false },
        });
        expect(updated.updatedAt).toBeGreaterThan(view.updatedAt);
        expect(updated.tokenSecretId).toBe(view.tokenSecretId);
        expect((await h.api('PUT', `/connections/${view.id}`, { mode: 'nope' })).status).toBe(400);
    });

    it('keeps the label of the token secret in step with the name', async () => {
        const h = await harness();
        const { view } = await h.connect({ name: 'Old' });
        await h.api('PUT', `/connections/${view.id}`, { name: 'New' });
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)[0]?.label).toBe('Nanovia: New');
    });

    it('404s unknown ids on every connection route', async () => {
        const h = await harness();
        for (const [method, route] of [
            ['PUT', '/connections/zzzzzzzz'],
            ['DELETE', '/connections/zzzzzzzz'],
            ['POST', '/connections/zzzzzzzz/rotate-token'],
        ] as const) {
            const res = await h.api(method, route, {});
            expect(res.status, `${method} ${route}`).toBe(404);
            expect(res.json['error']).toMatchObject({ code: 'not_found' });
        }
    });

    it('token lifecycle: direct mode has no token, switching creates and revokes it', async () => {
        const h = await harness();
        const direct = await h.connect({ name: 'Direct', mode: 'direct' });
        expect(direct.view.tokenSecretId).toBeNull();
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(0);

        const toPlugin = await h.api('PUT', `/connections/${direct.view.id}`, { mode: 'plugin' });
        const created = toPlugin.json['connection'];
        expect(created.tokenSecretId).toBeTruthy();
        const token = h.st.readSecret('default-user', SECRET_KEY_CUSTOM, created.tokenSecretId);
        expect(registryOf(h).tokens[hashToken(token)].connectionId).toBe(direct.view.id);

        const toDirect = await h.api('PUT', `/connections/${direct.view.id}`, { mode: 'direct' });
        expect(toDirect.json['connection'].tokenSecretId).toBeNull();
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(0);
        expect(registryOf(h).tokens).toEqual({});

        const back = await h.api('PUT', `/connections/${direct.view.id}`, { mode: 'auto' });
        const again = back.json['connection'];
        expect(again.tokenSecretId).toBeTruthy();
        expect(again.tokenSecretId).not.toBe(created.tokenSecretId);
        const newToken = h.st.readSecret('default-user', SECRET_KEY_CUSTOM, again.tokenSecretId);
        expect(newToken).not.toBe(token);
        expect(Object.keys(registryOf(h).tokens)).toEqual([hashToken(newToken)]);
    });

    it('delete removes the connection, the token secret and the registry entry', async () => {
        const h = await harness();
        const keep = await h.connect({ name: 'Keep' });
        const drop = await h.connect({ name: 'Drop' });
        const res = await h.api('DELETE', `/connections/${drop.view.id}`);
        expect(res.json).toEqual({ ok: true });
        expect((await h.api('GET', '/connections')).json['connections'].map((c: any) => c.id)).toEqual([keep.view.id]);
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM).map((s) => s.id)).toEqual([keep.view.tokenSecretId]);
        expect(Object.keys(registryOf(h).tokens)).toEqual([hashToken(keep.token)]);
    });

    it('rotate-token swaps the token: the new one works at the proxy, the old one is rejected', async () => {
        const upstream = await server(jsonUpstream());
        const h = await harness({ config: { upstreamBase: `${upstream.origin}/api/v1`, upstreamFallbackBase: null } });
        h.st.addNanoKey();
        const { view, token } = await h.connect();
        expect((await chat(h, view.id, token, { messages: [] })).status).toBe(200);

        const res = await h.api('POST', `/connections/${view.id}/rotate-token`);
        expect(res.status).toBe(200);
        const rotated = res.json['connection'];
        expect(rotated.id).toBe(view.id);
        expect(rotated.tokenSecretId).not.toBe(view.tokenSecretId);
        const newToken = h.st.readSecret('default-user', SECRET_KEY_CUSTOM, rotated.tokenSecretId);
        expect(newToken).not.toBe(token);
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(1);
        expect((await chat(h, view.id, token, { messages: [] })).status).toBe(401);
        expect((await chat(h, view.id, newToken, { messages: [] })).status).toBe(200);
    });

    it('rotate-token on a direct connection is 409', async () => {
        const h = await harness();
        const { view } = await h.connect({ mode: 'direct' });
        const res = await h.api('POST', `/connections/${view.id}/rotate-token`);
        expect(res.status).toBe(409);
        expect(res.json['error']).toMatchObject({ code: 'direct_mode' });
    });

    it('leaves the Custom key the user had active as the active one', async () => {
        const h = await harness();
        const mine = h.st.writeSecret('default-user', SECRET_KEY_CUSTOM, 'my-own-custom-key', 'mine');
        await h.connect();
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM).find((s) => s.active)?.id).toBe(mine);
    });

    it('degraded mode: a connection is created without a token, rotation says 503', async () => {
        const h = await harness();
        h.st.available = false;
        const created = await h.api('POST', '/connections', { name: 'Degraded', modelId: 'm' });
        expect(created.status).toBe(200);
        expect(created.json['connection'].tokenSecretId).toBeNull();
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(0);
        const rotate = await h.api('POST', `/connections/${created.json['connection'].id}/rotate-token`);
        expect(rotate.status).toBe(503);
    });

    it('survives a hand-corrupted connections.json', async () => {
        const h = await harness();
        await h.connect();
        fs.writeFileSync(path.join(h.st.userRoot('default-user'), 'nanovia', 'connections.json'), '{{{');
        expect((await h.api('GET', '/connections')).json).toEqual({ connections: [] });
        expect((await h.api('POST', '/connections', { name: 'Fresh', modelId: 'm' })).status).toBe(200);
    });
});

describe('keys', () => {
    it('lists keys masked, with label and active flag, never the value', async () => {
        const h = await harness();
        expect((await h.api('GET', '/keys')).json).toEqual({ keys: [] });
        const first = h.st.addNanoKey('default-user', NANO_KEY, 'main');
        h.st.addNanoKey('default-user', 'sk-nano-second-key-value-0000', 'spare');
        const res = await h.api('GET', '/keys');
        expect(res.status).toBe(200);
        expect(res.json['keys']).toEqual([
            { id: first, label: 'main', active: false, masked: 'sk-nano-…TAIL' },
            { id: expect.any(String), label: 'spare', active: true, masked: 'sk-nano-…0000' },
        ]);
        expect(res.text).not.toContain(NANO_KEY);
        expect(res.text).not.toContain('second-key-value');
    });

    it('adds a key into api_key_nanogpt and returns it masked', async () => {
        const h = await harness();
        const res = await h.api('POST', '/keys', { label: 'Work', value: `  ${NANO_KEY}  ` });
        expect(res.status).toBe(200);
        expect(res.json['key']).toEqual({
            id: expect.any(String),
            label: 'Work',
            active: true,
            masked: 'sk-nano-…TAIL',
        });
        expect(res.text).not.toContain(NANO_KEY);
        expect(h.st.readSecret('default-user', SECRET_KEY_NANOGPT, res.json['key'].id)).toBe(NANO_KEY);
        const unlabeled = await h.api('POST', '/keys', { value: 'sk-nano-another-value-0000' });
        expect(unlabeled.json['key'].label).toBe('NanoGPT');
    });

    it('rejects empty, spaced or non-string values and labels', async () => {
        const h = await harness();
        for (const body of [
            {},
            { value: '' },
            { value: 'has space' },
            { value: 'line\nbreak' },
            { value: 5 },
            { value: 'ok', label: 7 },
        ]) {
            expect((await h.api('POST', '/keys', body)).status, JSON.stringify(body)).toBe(400);
        }
        expect(h.st.listSecrets('default-user', SECRET_KEY_NANOGPT)).toHaveLength(0);
    });

    it('deletes a key by id and 404s an unknown one; proxy tokens cannot be deleted through it', async () => {
        const h = await harness();
        const id = h.st.addNanoKey();
        const { view } = await h.connect();
        expect((await h.api('DELETE', `/keys/${view.tokenSecretId}`)).status).toBe(404);
        expect(h.st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(1);
        expect((await h.api('DELETE', `/keys/${id}`)).json).toEqual({ ok: true });
        expect((await h.api('GET', '/keys')).json).toEqual({ keys: [] });
        expect((await h.api('DELETE', `/keys/${id}`)).status).toBe(404);
    });

    it('keeps keys per user', async () => {
        const h = await harness();
        h.st.addNanoKey('alice');
        expect((await h.api('GET', '/keys', undefined, 'alice')).json['keys']).toHaveLength(1);
        expect((await h.api('GET', '/keys', undefined, 'bob')).json['keys']).toHaveLength(0);
    });

    it('checks a balance against <site>/api/check-balance with the key in x-api-key', async () => {
        const site = await server(
            startServer((_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ usd_balance: '12.34', nano_balance: '0.5' }));
            }),
        );
        const h = await harness({ config: { siteBase: site.origin } });
        const id = h.st.addNanoKey();
        const res = await h.api('POST', `/keys/${id}/check`);
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ ok: true, usdBalance: '12.34', nanoBalance: '0.5', error: null });
        expect(site.requests[0]).toMatchObject({ method: 'POST', url: '/api/check-balance' });
        expect(site.requests[0]!.headers['x-api-key']).toBe(NANO_KEY);
        expect(res.text).not.toContain(NANO_KEY);
    });

    it('reports a failed check as ok: false without echoing the key', async () => {
        const rejecting = await server(
            startServer((_req, res) => {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: `invalid key ${NANO_KEY}` }));
            }),
        );
        const h = await harness({ config: { siteBase: rejecting.origin } });
        const id = h.st.addNanoKey();
        const res = await h.api('POST', `/keys/${id}/check`);
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ ok: false, usdBalance: null, nanoBalance: null });
        expect(res.json['error']).toContain('HTTP 401');
        expect(res.text).not.toContain(NANO_KEY);

        const unreachable = await harness({ config: { siteBase: 'http://127.0.0.1:1' } });
        const other = unreachable.st.addNanoKey();
        const failed = await unreachable.api('POST', `/keys/${other}/check`);
        expect(failed.json).toMatchObject({ ok: false, error: 'NanoGPT could not be reached' });
        expect((await unreachable.api('POST', '/keys/missing/check')).status).toBe(404);
    });

    it('degraded mode: an empty list, 503 for writes', async () => {
        const h = await harness();
        h.st.available = false;
        expect((await h.api('GET', '/keys')).json).toEqual({ keys: [] });
        expect((await h.api('POST', '/keys', { value: 'x-y-z' })).status).toBe(503);
        expect((await h.api('DELETE', '/keys/abc')).status).toBe(503);
    });
});
