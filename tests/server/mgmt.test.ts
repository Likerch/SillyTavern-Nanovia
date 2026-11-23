// Stage 0.6 admin routes: the Management token (write-only), keys with limits, model presets. Run over the real express
// test router against the mock NanoGPT (tools/mock-nanogpt, whose Management API follows the published contract) and,
// for answers the mock never gives, small fake servers.
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRET_KEY_NANOGPT, SECRET_LABEL_PREFIX } from '../../src/shared/constants';
import { createStore, MGMT_FILE } from '../../src/server/store';
import type { FetchInit, FetchLike } from '../../src/server/types';
import {
    FakeSt,
    cleanTempDirs,
    closedPort,
    makeTempDir,
    recordingLogger,
    startServer,
    type Harness,
    type TestServer,
} from './helpers';
import { startMockStack, type MockStack, type MockStackOptions } from './mock-stack';

const TOKEN = 'sk-nano-mgmt-TESTTOKEN';
const OTHER_TOKEN = 'sk-nano-mgmt-OTHERFAKE99';
/** The part of a token that must appear nowhere but the file and the Authorization header. */
const SECRET_PART = /TESTTOKEN|OTHERFAKE99/;
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanTempDirs();
});

/* ------------------------------------------------------------------------------------------------ harness */

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
}

/** A fetch that remembers every call and can add headers (`x-mock-error`) to what it forwards. */
function recording(extra: () => Record<string, string> = () => ({})) {
    const calls: Call[] = [];
    const real = globalThis.fetch as unknown as FetchLike;
    const fetch: FetchLike = (url, init) => {
        calls.push({
            url,
            method: init.method,
            headers: { ...init.headers },
            body: typeof init.body === 'string' ? init.body : undefined,
        });
        return real(url, { ...init, headers: { ...init.headers, ...extra() } });
    };
    return { fetch, calls };
}

async function stack(extra: MockStackOptions = {}): Promise<MockStack> {
    const s = await startMockStack({ now: () => NOW, ...extra });
    closers.push(() => s.close());
    return s;
}

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
    const server = await startServer(handler);
    closers.push(() => server.close());
    return server;
}

const userDir = (h: Harness, user = 'default-user') => path.join(h.st.userRoot(user), 'nanovia');
const tokenFile = (h: Harness, user = 'default-user') => path.join(userDir(h, user), MGMT_FILE);

/** Puts a token into the user's store without asking NanoGPT (the state `PUT /mgmt/token` would leave). */
function storeToken(h: Harness, token = TOKEN, valid: boolean | null = true, user = 'default-user'): void {
    const check = { valid, checkedAt: NOW, error: null };
    h.app.deps.store.mgmt.write(h.st.userRoot(user), { token, check });
}

async function withToken(s: MockStack, token = TOKEN, user?: string): Promise<void> {
    const res = await s.h.api('PUT', '/mgmt/token', { token }, user);
    expect(res.status, res.text).toBe(200);
}

const mockCalls = (s: MockStack) => s.seen('/api/management');

function jsonReply(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** A plugin whose Management base is a fake server that answers `reply`, with a stored token. */
async function fakeStack(
    reply: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ s: MockStack; fake: TestServer }> {
    const fake = await serve(reply);
    const s = await stack({ config: { mgmtBase: `${fake.origin}/api/management/v1` } });
    storeToken(s.h);
    return { s, fake };
}

/* ------------------------------------------------------------------------------------------------ token store */

describe('the Management token store', () => {
    function setup() {
        const root = makeTempDir();
        const { log, lines } = recordingLogger();
        const store = createStore({ dataRoot: () => root, now: () => 1, log });
        return { root, store, lines, alice: path.join(root, 'alice'), bob: path.join(root, 'bob') };
    }
    const record = (token = TOKEN) => ({ token, check: { valid: true, checkedAt: 5, error: null } });

    it('has nothing at first and round-trips a record as { version, token, check }', () => {
        const { store, alice } = setup();
        expect(store.mgmt.read(alice)).toBeNull();
        store.mgmt.write(alice, record());
        expect(store.mgmt.read(alice)).toEqual(record());
        const raw = JSON.parse(fs.readFileSync(path.join(alice, 'nanovia', MGMT_FILE), 'utf8'));
        expect(raw).toEqual({ version: 1, ...record() });
    });

    it.skipIf(process.platform === 'win32')('writes the file with mode 0600', () => {
        const { store, alice } = setup();
        store.mgmt.write(alice, record());
        store.mgmt.write(alice, record(OTHER_TOKEN));
        expect(fs.statSync(path.join(alice, 'nanovia', MGMT_FILE)).mode & 0o777).toBe(0o600);
    });

    it('writes atomically: no temp files are left behind', () => {
        const { store, alice } = setup();
        store.mgmt.write(alice, record());
        store.mgmt.write(alice, record(OTHER_TOKEN));
        expect(fs.readdirSync(path.join(alice, 'nanovia'))).toEqual([MGMT_FILE]);
    });

    it('keeps users apart and clears one without touching the other', () => {
        const { store, alice, bob } = setup();
        store.mgmt.write(alice, record());
        store.mgmt.write(bob, record(OTHER_TOKEN));
        expect(store.mgmt.read(alice)?.token).toBe(TOKEN);
        expect(store.mgmt.read(bob)?.token).toBe(OTHER_TOKEN);
        store.mgmt.clear(alice);
        expect(store.mgmt.read(alice)).toBeNull();
        expect(fs.existsSync(path.join(alice, 'nanovia', MGMT_FILE))).toBe(false);
        expect(store.mgmt.read(bob)?.token).toBe(OTHER_TOKEN);
        expect(() => store.mgmt.clear(alice)).not.toThrow(); // already gone
    });

    it('reads leniently: garbage, a bad token and a missing check block', () => {
        const { store, alice, lines } = setup();
        const file = path.join(alice, 'nanovia', MGMT_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        for (const text of ['{ broken', '[]', '{}', '{"token": 5}', '{"token": "has space"}', '{"token": ""}']) {
            fs.writeFileSync(file, text);
            expect(store.mgmt.read(alice), text).toBeNull();
        }
        fs.writeFileSync(file, JSON.stringify({ version: 1, token: TOKEN }));
        expect(store.mgmt.read(alice)).toEqual({ token: TOKEN, check: { valid: null, checkedAt: null, error: null } });
        fs.writeFileSync(
            file,
            JSON.stringify({ token: TOKEN, check: { valid: 'yes', checkedAt: 'now', error: 'weird' } }),
        );
        expect(store.mgmt.read(alice)?.check).toEqual({ valid: null, checkedAt: null, error: null });
        fs.writeFileSync(
            file,
            JSON.stringify({ token: TOKEN, check: { valid: false, checkedAt: 9, error: 'rate_limited' } }),
        );
        expect(store.mgmt.read(alice)?.check).toEqual({ valid: false, checkedAt: 9, error: 'rate_limited' });
        expect(lines.join('\n')).not.toMatch(SECRET_PART);
    });

    it('drops the aside copy of a corrupt file when it clears', () => {
        const { store, alice } = setup();
        const file = path.join(alice, 'nanovia', MGMT_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ broken');
        expect(store.mgmt.read(alice)).toBeNull();
        store.mgmt.write(alice, record()); // copies the broken file aside first
        expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
        store.mgmt.clear(alice);
        expect(fs.readdirSync(path.join(alice, 'nanovia'))).toEqual([]);
    });
});

/* ------------------------------------------------------------------------------------------------ token routes */

describe('GET /mgmt/status', () => {
    it('says there is no token, without calling NanoGPT', async () => {
        const s = await stack();
        const res = await s.h.api('GET', '/mgmt/status');
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ present: false, valid: null, checkedAt: null, error: null });
        expect((await s.h.api('GET', '/mgmt/status?verify=1')).json).toEqual(res.json);
        expect(mockCalls(s)).toHaveLength(0);
    });

    it('reports the stored check offline, and re-checks with ?verify=1', async () => {
        const s = await stack();
        await withToken(s);
        expect(mockCalls(s)).toHaveLength(1);
        const offline = await s.h.api('GET', '/mgmt/status');
        expect(offline.json).toEqual({ present: true, valid: true, checkedAt: NOW, error: null });
        expect(mockCalls(s)).toHaveLength(1); // no new call

        const verified = await s.h.api('GET', '/mgmt/status?verify=1');
        expect(verified.json).toEqual({ present: true, valid: true, checkedAt: NOW, error: null });
        expect(mockCalls(s)).toHaveLength(2);
        expect(mockCalls(s)[1]).toMatchObject({ method: 'GET', path: '/api/management/v1/api-keys' });
    });

    it('turns to invalid when NanoGPT no longer recognises the token, and keeps that', async () => {
        const s = await stack();
        storeToken(s.h, 'sk-nano-mgmt-expired0123456789', true);
        const verified = await s.h.api('GET', '/mgmt/status?verify=1');
        expect(verified.json).toEqual({ present: true, valid: false, checkedAt: NOW, error: 'mgmt_token_invalid' });
        expect((await s.h.api('GET', '/mgmt/status')).json).toMatchObject({
            valid: false,
            error: 'mgmt_token_invalid',
        });
    });

    it('says "could not tell" when NanoGPT is out of reach and leaves the stored verdict alone', async () => {
        const s = await stack({ config: { mgmtBase: `http://127.0.0.1:${await closedPort()}/api/management/v1` } });
        storeToken(s.h);
        const verified = await s.h.api('GET', '/mgmt/status?verify=1');
        expect(verified.json).toEqual({ present: true, valid: null, checkedAt: NOW, error: 'upstream_unreachable' });
        expect((await s.h.api('GET', '/mgmt/status')).json).toEqual({
            present: true,
            valid: true,
            checkedAt: NOW,
            error: null,
        });
    });
});

describe('PUT /mgmt/token', () => {
    it('proves the token with one read call, stores it and answers with the status only', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        const res = await s.h.api('PUT', '/mgmt/token', { token: `  ${TOKEN}\n` });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ present: true, valid: true, checkedAt: NOW, error: null });
        expect(res.text).not.toMatch(SECRET_PART);

        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0]).toMatchObject({
            method: 'GET',
            url: `${s.origin}/api/management/v1/api-keys`,
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        const file = JSON.parse(fs.readFileSync(tokenFile(s.h), 'utf8'));
        expect(file).toEqual({ version: 1, token: TOKEN, check: { valid: true, checkedAt: NOW, error: null } });
    });

    it('turns a malformed token away before any call, naming the problem without echoing it', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        const cases: [unknown, RegExp][] = [
            [undefined, /"token" must be a string/],
            [42, /"token" must be a string/],
            ['   ', /empty/],
            ['sk-nano-0123456789abcdef0123456789ab-KEYTAIL', /inference API key/],
            ['sk-other-TESTTOKEN12345', /starts with sk-nano-mgmt-/],
            ['sk-nano-mgmt-abc', /too short/],
            ['sk-nano-mgmt-TEST TOKEN', /spaces/],
        ];
        for (const [token, message] of cases) {
            const res = await s.h.api('PUT', '/mgmt/token', { token });
            expect(res.status, String(token)).toBe(400);
            expect(res.json['error'].code).toBe('mgmt_token_malformed');
            expect(res.json['error'].message).toMatch(message);
            expect(res.text).not.toMatch(/TEST TOKEN|KEYTAIL|sk-nano-mgmt-abc/);
        }
        expect((await s.h.api('PUT', '/mgmt/token')).status).toBe(400);
        expect(rec.calls).toHaveLength(0);
        expect(fs.existsSync(tokenFile(s.h))).toBe(false);
    });

    it('refuses a token NanoGPT rejects and stores nothing', async () => {
        const s = await stack();
        const res = await s.h.api('PUT', '/mgmt/token', { token: 'sk-nano-mgmt-expired0123456789' });
        expect(res.status).toBe(502);
        expect(res.json['error'].code).toBe('mgmt_token_invalid');
        expect(res.text).not.toContain('expired0123456789');
        expect(fs.existsSync(tokenFile(s.h))).toBe(false);
        expect((await s.h.api('GET', '/mgmt/status')).json['present']).toBe(false);
    });

    it('keeps the earlier token when a new one is refused', async () => {
        const s = await stack();
        await withToken(s);
        const res = await s.h.api('PUT', '/mgmt/token', { token: 'sk-nano-mgmt-revoked0123456789' });
        expect(res.status).toBe(502);
        expect(JSON.parse(fs.readFileSync(tokenFile(s.h), 'utf8')).token).toBe(TOKEN);
    });

    it('stores a refused token anyway with ?force=1, remembering that it is invalid', async () => {
        const s = await stack();
        const res = await s.h.api('PUT', '/mgmt/token?force=1', { token: 'sk-nano-mgmt-expired0123456789' });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({ present: true, valid: false, checkedAt: NOW, error: 'mgmt_token_invalid' });
        expect(JSON.parse(fs.readFileSync(tokenFile(s.h), 'utf8')).token).toBe('sk-nano-mgmt-expired0123456789');
        expect((await s.h.api('PUT', '/mgmt/token?force=true', { token: TOKEN })).json['valid']).toBe(true);
    });

    it('accepts a token that lacks the probe scope: NanoGPT knows it', async () => {
        const s = await stack();
        const res = await s.h.api('PUT', '/mgmt/token', { token: 'sk-nano-mgmt-usage0123456789' });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({ present: true, valid: true });
        const keys = await s.h.api('GET', '/mgmt/keys');
        expect(keys.status).toBe(409);
        expect(keys.json['error']).toMatchObject({ code: 'mgmt_scope_missing' });
        expect(keys.json['error'].message).toContain('api_keys:read');
        expect((await s.h.api('GET', '/mgmt/status')).json['valid']).toBe(true);
    });

    it('does not store what it could not verify, unless forced', async () => {
        const s = await stack({ config: { mgmtBase: `http://127.0.0.1:${await closedPort()}/api/management/v1` } });
        const refused = await s.h.api('PUT', '/mgmt/token', { token: TOKEN });
        expect(refused.status).toBe(502);
        expect(refused.json['error'].code).toBe('upstream_unreachable');
        expect(refused.json['error'].message).toContain('force=1');
        expect(fs.existsSync(tokenFile(s.h))).toBe(false);

        const forced = await s.h.api('PUT', '/mgmt/token?force=1', { token: TOKEN });
        expect(forced.json).toEqual({ present: true, valid: null, checkedAt: NOW, error: 'upstream_unreachable' });
        expect(fs.existsSync(tokenFile(s.h))).toBe(true);
    });

    it('maps a rate limit and a server error of NanoGPT to refusals without a verdict', async () => {
        let inject = '';
        const rec = recording((): Record<string, string> => (inject ? { 'x-mock-error': inject } : {}));
        const s = await stack({ fetch: rec.fetch });
        inject = '429';
        const limited = await s.h.api('PUT', '/mgmt/token', { token: TOKEN });
        expect([limited.status, limited.json['error'].code]).toEqual([429, 'rate_limited']);
        inject = '503';
        const down = await s.h.api('PUT', '/mgmt/token', { token: TOKEN });
        expect([down.status, down.json['error'].code]).toEqual([502, 'upstream_error']);
        expect(fs.existsSync(tokenFile(s.h))).toBe(false);
        const forced = await s.h.api('PUT', '/mgmt/token?force=1', { token: TOKEN });
        expect(forced.json).toMatchObject({ present: true, valid: null, error: 'upstream_error' });
    });

    it('answers 504 when NanoGPT does not answer in time', async () => {
        const realSetTimeout = globalThis.setTimeout;
        // The call's 15 s timer runs for 20 ms in this test; every other timer is untouched.
        const spy = vi
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation(((fn: () => void, ms?: number) =>
                realSetTimeout(fn, ms === 15_000 ? 20 : ms)) as unknown as typeof setTimeout);
        try {
            const hang: FetchLike = (_url, init: FetchInit) =>
                new Promise((_resolve, reject) =>
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
                );
            const s = await stack({ fetch: hang });
            const refused = await s.h.api('PUT', '/mgmt/token', { token: TOKEN });
            expect([refused.status, refused.json['error'].code]).toEqual([504, 'upstream_timeout']);
            const forced = await s.h.api('PUT', '/mgmt/token?force=1', { token: TOKEN });
            expect(forced.json).toMatchObject({ valid: null, error: 'upstream_timeout' });
            const keys = await s.h.api('GET', '/mgmt/keys');
            expect([keys.status, keys.json['error'].code]).toEqual([504, 'upstream_timeout']);
        } finally {
            spy.mockRestore();
        }
    });

    it('replaces the stored token', async () => {
        const s = await stack();
        await withToken(s);
        await withToken(s, OTHER_TOKEN);
        expect(JSON.parse(fs.readFileSync(tokenFile(s.h), 'utf8')).token).toBe(OTHER_TOKEN);
    });
});

describe('DELETE /mgmt/token', () => {
    it('removes the token for good, and is fine when there is none', async () => {
        const s = await stack();
        await withToken(s);
        const res = await s.h.api('DELETE', '/mgmt/token');
        expect(res.json).toEqual({ ok: true });
        expect(fs.existsSync(tokenFile(s.h))).toBe(false);
        expect((await s.h.api('GET', '/mgmt/status')).json['present']).toBe(false);
        expect((await s.h.api('GET', '/mgmt/keys')).status).toBe(409);
        expect((await s.h.api('DELETE', '/mgmt/token')).json).toEqual({ ok: true });
    });
});

/* ------------------------------------------------------------------------------------------------ missing token */

describe('without a stored token', () => {
    it('every route that needs one answers 409 mgmt_token_missing and calls nobody', async () => {
        const s = await stack();
        const calls: [string, string, unknown?][] = [
            ['GET', '/mgmt/keys'],
            ['POST', '/mgmt/keys', { name: 'x' }],
            ['PATCH', '/mgmt/keys/1', { name: 'x' }],
            ['DELETE', '/mgmt/keys/1'],
            ['GET', '/mgmt/presets'],
            ['POST', '/mgmt/presets', { name: 'x', model: 'm' }],
            ['PUT', '/mgmt/presets/x', { model: 'm' }],
            ['DELETE', '/mgmt/presets/x'],
        ];
        for (const [method, route, body] of calls) {
            const res = await s.h.api(method, route, body);
            expect([method, route, res.status, res.json['error']?.code]).toEqual([
                method,
                route,
                409,
                'mgmt_token_missing',
            ]);
        }
        expect(mockCalls(s)).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------------------------------------ keys */

describe('GET /mgmt/keys', () => {
    it('lists the keys in the contract shape, with the token in the Authorization header', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        rec.calls.length = 0;
        const res = await s.h.api('GET', '/mgmt/keys');
        expect(res.status).toBe(200);
        expect(res.json['fetchedAt']).toBe(NOW);
        const keys = res.json['keys'];
        expect(keys.map((k: any) => [k.id, k.name, k.status])).toEqual([
            ['1', 'Nanovia main', 'active'],
            ['2', 'Roleplay capped', 'active'],
            ['3', 'Old test key', 'expired'],
        ]);
        expect(keys[0]).toEqual({
            id: '1',
            name: 'Nanovia main',
            status: 'active',
            createdAt: Date.parse('2026-09-01T09:00:00.000Z'),
            expiresAt: null,
            limits: {
                requests: { daily: null, weekly: null, monthly: null },
                usd: { daily: 5, weekly: 20, monthly: 50 },
                inputTokens: { daily: null, weekly: null, monthly: null },
                subscriptionInputTokens: { daily: null, weekly: null, monthly: null },
            },
            zdrPolicy: 'off',
        });
        expect(keys[1]).toMatchObject({
            expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
            zdrPolicy: 'zdr',
            limits: { requests: { daily: 300, weekly: 1500, monthly: 6000 } },
        });
        expect(keys[2]).toMatchObject({ zdrPolicy: 'unset', limits: { usd: { daily: 0 } } });
        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0]).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } });
        expect(res.text).not.toMatch(SECRET_PART);
    });

    it('turns the stored status to invalid when NanoGPT rejects the token, and answers 502', async () => {
        const s = await stack();
        storeToken(s.h, 'sk-nano-mgmt-expired0123456789', true);
        const res = await s.h.api('GET', '/mgmt/keys');
        expect(res.status).toBe(502);
        expect(res.json['error'].code).toBe('mgmt_token_invalid');
        expect((await s.h.api('GET', '/mgmt/status')).json).toMatchObject({
            valid: false,
            error: 'mgmt_token_invalid',
        });
    });

    it('turns an unknown status to valid once a call succeeds', async () => {
        const s = await stack();
        const config = s.h.app.deps.config;
        const real = config.mgmtBase;
        config.mgmtBase = `http://127.0.0.1:${await closedPort()}/api/management/v1`;
        await s.h.api('PUT', '/mgmt/token?force=1', { token: TOKEN });
        expect((await s.h.api('GET', '/mgmt/status')).json).toMatchObject({
            valid: null,
            error: 'upstream_unreachable',
        });
        config.mgmtBase = real;
        expect((await s.h.api('GET', '/mgmt/keys')).status).toBe(200);
        expect((await s.h.api('GET', '/mgmt/status')).json).toEqual({
            present: true,
            valid: true,
            checkedAt: NOW,
            error: null,
        });
    });

    it('keeps a stored verdict when only the network failed', async () => {
        const s = await stack({ config: { mgmtBase: `http://127.0.0.1:${await closedPort()}/api/management/v1` } });
        storeToken(s.h);
        const res = await s.h.api('GET', '/mgmt/keys');
        expect([res.status, res.json['error'].code]).toEqual([502, 'upstream_unreachable']);
        expect((await s.h.api('GET', '/mgmt/status')).json['valid']).toBe(true);
    });
});

describe('PATCH /mgmt/keys/:id', () => {
    it('changes limits, the name and the expiry, and clears a limit with null', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        rec.calls.length = 0;
        const expiresAt = Date.parse('2030-06-01T00:00:00.000Z');
        const res = await s.h.api('PATCH', '/mgmt/keys/1', {
            name: ' Renamed ',
            expiresAt,
            limits: {
                usd: { monthly: 30, daily: null },
                requests: { daily: 400 },
                subscriptionInputTokens: { weekly: 9000 },
            },
        });
        expect(res.status, res.text).toBe(200);
        expect(res.json['key']).toMatchObject({
            id: '1',
            name: 'Renamed',
            expiresAt,
            limits: {
                usd: { daily: null, weekly: 20, monthly: 30 },
                requests: { daily: 400, weekly: null, monthly: null },
                subscriptionInputTokens: { weekly: 9000 },
            },
        });
        expect(JSON.parse(rec.calls[0]!.body ?? '{}')).toEqual({
            name: 'Renamed',
            expires_at: '2030-06-01T00:00:00.000Z',
            monthly_usd_limit: 30,
            daily_usd_limit: null,
            daily_rpd_limit: 400,
            weekly_subscription_input_token_limit: 9000,
        });
        expect(rec.calls[0]).toMatchObject({ method: 'PATCH', url: `${s.origin}/api/management/v1/api-keys/1` });
        expect(s.mock.state.keys.get('1')).toMatchObject({
            name: 'Renamed',
            monthly_usd_limit: 30,
            daily_usd_limit: null,
        });
        const cleared = await s.h.api('PATCH', '/mgmt/keys/1', { expiresAt: null });
        expect(cleared.json['key'].expiresAt).toBeNull();
    });

    it('refuses bad input before any call to NanoGPT', async () => {
        const s = await stack();
        await withToken(s);
        const before = mockCalls(s).length;
        const bad: [unknown, string][] = [
            [{}, 'body'],
            [{ limits: { usd: { daily: -1 } } }, 'limits.usd.daily'],
            [{ limits: { usd: { daily: 0.00001 } } }, 'limits.usd.daily'],
            [{ limits: { requests: { daily: 1.5 } } }, 'limits.requests.daily'],
            [{ limits: { requests: { daily: 10_000_001 } } }, 'limits.requests.daily'],
            [{ limits: { inputTokens: { weekly: 2_147_483_648 } } }, 'limits.inputTokens.weekly'],
            [{ limits: { usd: { yearly: 5 } } }, 'limits.usd.yearly'],
            [{ limits: { tokens: { daily: 5 } } }, 'limits.tokens'],
            [{ name: '   ' }, 'name'],
            [{ name: 'x'.repeat(121) }, 'name'],
            [{ expiresAt: 'tomorrow' }, 'expiresAt'],
            [{ zdrPolicy: 'maybe' }, 'zdrPolicy'],
            [{ daily_usd_limit: 5 }, 'daily_usd_limit'],
        ];
        for (const [body, field] of bad) {
            const res = await s.h.api('PATCH', '/mgmt/keys/1', body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.json['error'].code).toBe('invalid_request');
            expect(res.json['error'].message).toContain(field);
        }
        for (const id of ['0', '01', 'abc', '-1', '1.5']) {
            const res = await s.h.api('PATCH', `/mgmt/keys/${id}`, { name: 'x' });
            expect([id, res.status, res.json['error'].code]).toEqual([id, 400, 'invalid_request']);
        }
        expect(mockCalls(s)).toHaveLength(before);
    });

    it('answers 404 for a key NanoGPT does not know', async () => {
        const s = await stack();
        await withToken(s);
        const res = await s.h.api('PATCH', '/mgmt/keys/99', { name: 'x' });
        expect([res.status, res.json['error'].code]).toEqual([404, 'not_found']);
    });

    it('names the missing scope', async () => {
        const s = await stack();
        await withToken(s, 'sk-nano-mgmt-keysread0123456789');
        expect((await s.h.api('GET', '/mgmt/keys')).status).toBe(200);
        const res = await s.h.api('PATCH', '/mgmt/keys/1', { name: 'x' });
        expect([res.status, res.json['error'].code]).toEqual([409, 'mgmt_scope_missing']);
        expect(res.json['error'].message).toContain('api_keys:write');
    });
});

describe('POST /mgmt/keys', () => {
    it('creates a key, stores its secret in ST (not as the active key) and never returns it', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        rec.calls.length = 0;
        const activeBefore = s.h.st.readSecret('default-user', SECRET_KEY_NANOGPT, null);
        const res = await s.h.api('POST', '/mgmt/keys', {
            name: ' Roleplay ',
            zdrPolicy: 'zdr',
            limits: { usd: { daily: 2, monthly: 30 } },
        });
        expect(res.status, res.text).toBe(200);
        const { key, secretId } = res.json as { key: any; secretId: string };
        expect(key).toMatchObject({
            id: '4',
            name: 'Roleplay',
            zdrPolicy: 'zdr',
            limits: { usd: { daily: 2, monthly: 30 } },
        });

        const created = s.mock.state.keys.get('4');
        expect(created).toMatchObject({ daily_usd_limit: 2, monthly_usd_limit: 30, zdr_policy: 'zdr' });
        const stored = s.h.st.listSecrets('default-user', SECRET_KEY_NANOGPT).find((e) => e.id === secretId);
        expect(stored).toMatchObject({ label: `${SECRET_LABEL_PREFIX}Roleplay`, active: false });
        expect(stored?.value).toMatch(/^sk-nano-/);
        expect(s.h.st.readSecret('default-user', SECRET_KEY_NANOGPT, null)).toBe(activeBefore);
        expect(res.text).not.toContain(stored?.value ?? 'x');
        expect(res.text).not.toMatch(SECRET_PART);

        expect(rec.calls).toHaveLength(1);
        expect(rec.calls[0]!.headers['idempotency-key']).toMatch(/^nanovia-[0-9a-f-]{36}$/);
        expect(JSON.parse(rec.calls[0]!.body ?? '{}')).toEqual({
            name: 'Roleplay',
            zdr_policy: 'zdr',
            daily_usd_limit: 2,
            monthly_usd_limit: 30,
        });
    });

    it('uses a fresh Idempotency-Key for every create', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        await s.h.api('POST', '/mgmt/keys', { name: 'a' });
        await s.h.api('POST', '/mgmt/keys', { name: 'a' });
        const keys = rec.calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
        expect(new Set(keys).size).toBe(2);
        expect(s.mock.state.keys.size).toBe(5);
    });

    it('refuses bad input before anything is made, and needs the secret store', async () => {
        const s = await stack();
        await withToken(s);
        const before = mockCalls(s).length;
        for (const body of [
            {},
            { name: '' },
            { name: 'x', zdrPolicy: 'unset' },
            { name: 'x', limits: { usd: { daily: -2 } } },
            { name: 'x', status: 'active' },
        ]) {
            const res = await s.h.api('POST', '/mgmt/keys', body);
            expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
        }
        s.h.st.available = false;
        const down = await s.h.api('POST', '/mgmt/keys', { name: 'x' });
        expect([down.status, down.json['error'].code]).toEqual([503, 'secrets_unavailable']);
        expect(mockCalls(s)).toHaveLength(before);
        expect(s.mock.state.keys.size).toBe(3);
    });

    it('retries once with the same Idempotency-Key when the answer is lost, and makes one key', async () => {
        let fail = true;
        const rec = recording();
        const flaky: FetchLike = (url, init) => {
            if (fail && init.method === 'POST') {
                fail = false;
                rec.calls.push({
                    url,
                    method: init.method,
                    headers: { ...init.headers },
                    body: typeof init.body === 'string' ? init.body : undefined,
                });
                return Promise.reject(new Error('socket hang up'));
            }
            return rec.fetch(url, init);
        };
        const s = await stack({ fetch: flaky });
        await withToken(s);
        const res = await s.h.api('POST', '/mgmt/keys', { name: 'Flaky' });
        expect(res.status, res.text).toBe(200);
        const posts = rec.calls.filter((c) => c.method === 'POST');
        expect(posts).toHaveLength(2);
        expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
        expect(s.mock.state.keys.size).toBe(4);
        expect(s.h.st.listSecrets('default-user', SECRET_KEY_NANOGPT)).toHaveLength(2);
    });

    it('gives up after the retry with 502 and stores no secret', async () => {
        const down: FetchLike = (_url, init) =>
            init.method === 'POST'
                ? Promise.reject(new Error('refused'))
                : (globalThis.fetch as unknown as FetchLike)(_url, init);
        const s = await stack({ fetch: down });
        await withToken(s);
        const res = await s.h.api('POST', '/mgmt/keys', { name: 'x' });
        expect([res.status, res.json['error'].code]).toEqual([502, 'upstream_unreachable']);
        expect(s.h.st.listSecrets('default-user', SECRET_KEY_NANOGPT)).toHaveLength(1); // only the one from the stack
    });

    it('reports a key that was made but could not be stored, naming its id and never its secret', async () => {
        class FailingSt extends FakeSt {
            failing = false;
            override writeSecret(...args: Parameters<FakeSt['writeSecret']>): string {
                if (this.failing) throw new Error('disk full');
                return super.writeSecret(...args);
            }
        }
        const st = new FailingSt(makeTempDir());
        const s = await stack({ st });
        await withToken(s);
        st.failing = true;
        const res = await s.h.api('POST', '/mgmt/keys', { name: 'Lost' });
        expect([res.status, res.json['error'].code]).toEqual([500, 'secrets_failed']);
        expect(res.json['error'].message).toContain('Key 4');
        const secret = String((s.mock.state.idempotency as Map<string, any>).values().next().value.secret);
        expect(res.text).not.toContain(secret);
        expect(s.h.logs.join('\n')).not.toContain(secret);
        expect(s.mock.state.keys.has('4')).toBe(true);
    });

    it('answers 502 bad_response when NanoGPT creates a key without its secret', async () => {
        const { s } = await fakeStack((_req, res) =>
            jsonReply(res, 201, { id: '7', name: 'x', status: 'active', created_at: '2026-11-01T00:00:00Z' }),
        );
        const res = await s.h.api('POST', '/mgmt/keys', { name: 'x' });
        expect([res.status, res.json['error'].code]).toEqual([502, 'bad_response']);
    });
});

describe('DELETE /mgmt/keys/:id', () => {
    it('revokes a key', async () => {
        const s = await stack();
        await withToken(s);
        const res = await s.h.api('DELETE', '/mgmt/keys/2');
        expect(res.json).toEqual({ ok: true });
        expect(s.mock.state.keys.has('2')).toBe(false);
        expect((await s.h.api('GET', '/mgmt/keys')).json['keys'].map((k: any) => k.id)).toEqual(['1', '3']);
    });

    it('answers 404 for an unknown key and 400 for a bad id', async () => {
        const s = await stack();
        await withToken(s);
        expect((await s.h.api('DELETE', '/mgmt/keys/77')).json['error'].code).toBe('not_found');
        expect((await s.h.api('DELETE', '/mgmt/keys/abc')).status).toBe(400);
        expect(s.mock.state.keys.size).toBe(3);
    });
});

/* ------------------------------------------------------------------------------------------------ presets */

describe('GET /mgmt/presets', () => {
    it('lists the presets in the contract shape', async () => {
        const s = await stack();
        await withToken(s);
        const res = await s.h.api('GET', '/mgmt/presets');
        expect(res.status).toBe(200);
        expect(res.json['fetchedAt']).toBe(NOW);
        const [fast, analyst] = res.json['presets'];
        expect(fast).toEqual({
            name: 'rp-fast',
            model: 'deepseek/deepseek-v4.1-flash',
            systemPrompt: 'You are a vivid roleplay narrator.',
            maxTokens: 1200,
            topK: null,
            temperature: 0.9,
            topP: 0.95,
            minP: null,
            topA: null,
            frequencyPenalty: null,
            presencePenalty: null,
            repetitionPenalty: null,
            responseFormat: null,
            structuredOutputs: null,
            reasoningEffort: null,
            reasoningSummary: null,
            verbosity: null,
            routing: 'speed',
            serviceTier: null,
            thinking: null,
            promptCaching: null,
            createdAt: Date.parse('2026-10-02T08:00:00.000Z'),
            updatedAt: Date.parse('2026-10-02T08:00:00.000Z'),
        });
        expect(analyst).toMatchObject({
            name: 'analyst',
            responseFormat: 'json_object',
            structuredOutputs: true,
            reasoningEffort: 'high',
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '1h' },
        });
    });

    it('names the missing scope', async () => {
        const s = await stack();
        await withToken(s, 'sk-nano-mgmt-keysread0123456789');
        const res = await s.h.api('GET', '/mgmt/presets');
        expect([res.status, res.json['error'].code]).toEqual([409, 'mgmt_scope_missing']);
        expect(res.json['error'].message).toContain('model_presets:read');
    });
});

describe('model preset writes', () => {
    it('POST creates a preset (name lower-cased) and answers with it', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        rec.calls.length = 0;
        const res = await s.h.api('POST', '/mgmt/presets', {
            name: 'Story-Teller',
            model: ' z-ai/glm-5.3 ',
            systemPrompt: 'Narrate.',
            temperature: 0.7,
            thinking: { enabled: true, budgetTokens: 2000 },
            promptCaching: { enabled: true, ttl: '5m' },
        });
        expect(res.status, res.text).toBe(200);
        expect(res.json['preset']).toMatchObject({
            name: 'story-teller',
            model: 'z-ai/glm-5.3',
            systemPrompt: 'Narrate.',
            temperature: 0.7,
            topP: null,
            thinking: { enabled: true, budgetTokens: 2000 },
            promptCaching: { enabled: true, ttl: '5m' },
        });
        expect(rec.calls.map((c) => `${c.method} ${c.url.replace(s.origin, '')}`)).toEqual([
            'GET /api/management/v1/model-presets/story-teller',
            'PUT /api/management/v1/model-presets/story-teller',
        ]);
        expect(JSON.parse(rec.calls[1]!.body ?? '{}')).toEqual({
            model: 'z-ai/glm-5.3',
            system_prompt: 'Narrate.',
            temperature: 0.7,
            thinking: { type: 'enabled', budget_tokens: 2000 },
            prompt_caching: { enabled: true, ttl: '5m' },
        });
        expect(s.mock.state.presets.has('story-teller')).toBe(true);
    });

    it('POST will not replace a preset that exists', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        rec.calls.length = 0;
        const res = await s.h.api('POST', '/mgmt/presets', { name: 'RP-FAST', model: 'other/model' });
        expect([res.status, res.json['error'].code]).toEqual([409, 'preset_exists']);
        expect(rec.calls.map((c) => c.method)).toEqual(['GET']);
        expect(s.mock.state.presets.get('rp-fast')).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash' });
    });

    it('PUT replaces a whole preset (what is left out becomes null) or creates it', async () => {
        const s = await stack();
        await withToken(s);
        const replaced = await s.h.api('PUT', '/mgmt/presets/rp-fast', { model: 'z-ai/glm-5.3', topP: 0.8 });
        expect(replaced.status, replaced.text).toBe(200);
        expect(replaced.json['preset']).toMatchObject({
            name: 'rp-fast',
            model: 'z-ai/glm-5.3',
            topP: 0.8,
            temperature: null,
            maxTokens: null,
            systemPrompt: null,
            createdAt: Date.parse('2026-10-02T08:00:00.000Z'),
        });
        const created = await s.h.api('PUT', '/mgmt/presets/Brand-New', { model: 'm' });
        expect(created.json['preset']).toMatchObject({ name: 'brand-new', model: 'm' });
        expect(s.mock.state.presets.size).toBe(3);
        // a ModelPreset sent back untouched is fine: name and dates are ignored
        const echoed = await s.h.api('PUT', '/mgmt/presets/brand-new', { ...created.json['preset'], temperature: 1 });
        expect(echoed.status, echoed.text).toBe(200);
        expect(echoed.json['preset'].temperature).toBe(1);
    });

    it('DELETE removes a preset, also one that is already gone', async () => {
        const s = await stack();
        await withToken(s);
        expect((await s.h.api('DELETE', '/mgmt/presets/analyst')).json).toEqual({ ok: true });
        expect(s.mock.state.presets.has('analyst')).toBe(false);
        expect((await s.h.api('DELETE', '/mgmt/presets/analyst')).json).toEqual({ ok: true });
    });

    it('refuses bad names and bodies before any call, and a body over 16 KiB with 413', async () => {
        const s = await stack();
        await withToken(s);
        const before = mockCalls(s).length;
        for (const name of ['-bad', 'has space', 'a'.repeat(81), 'dot.name', 'a%2Fb']) {
            const res = await s.h.api('PUT', `/mgmt/presets/${name}`, { model: 'm' });
            expect([name, res.status, res.json['error'].code]).toEqual([name, 400, 'invalid_request']);
            const created = await s.h.api('POST', '/mgmt/presets', { name, model: 'm' });
            expect([name, created.status]).toEqual([name, 400]);
        }
        expect((await s.h.api('POST', '/mgmt/presets', { model: 'm' })).status).toBe(400); // no name
        expect((await s.h.api('DELETE', '/mgmt/presets/-bad')).status).toBe(400);
        const bad: [unknown, string][] = [
            [{}, 'model'],
            [{ model: 'm', temperature: 2.5 }, 'temperature'],
            [{ model: 'm', maxTokens: 0 }, 'maxTokens'],
            [{ model: 'm', reasoningEffort: 'ultra' }, 'reasoningEffort'],
            [{ model: 'm', structuredOutputs: true }, 'structuredOutputs'],
            [{ model: 'm', serviceTier: 'flex', routing: 'latency' }, 'serviceTier'],
            [{ model: 'm', provider: { only: ['x'] } }, 'provider'],
            [{ model: 'm', thinking: { enabled: false, budgetTokens: 5 } }, 'thinking.budgetTokens'],
        ];
        for (const [body, field] of bad) {
            const res = await s.h.api('PUT', '/mgmt/presets/ok', body);
            expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
            expect(res.json['error'].message).toContain(field);
        }
        const huge = await s.h.api('PUT', '/mgmt/presets/ok', { model: 'm', systemPrompt: '€'.repeat(6000) });
        expect([huge.status, huge.json['error'].code]).toEqual([413, 'payload_too_large']);
        expect(mockCalls(s)).toHaveLength(before);
    });

    it("passes NanoGPT's own conflict code through (the 100-preset limit)", async () => {
        const s = await stack();
        await withToken(s);
        for (let i = 0; i < 98; i++) s.mock.state.presets.set(`p${i}`, { name: `p${i}`, model: 'm' });
        const res = await s.h.api('PUT', '/mgmt/presets/one-too-many', { model: 'm' });
        expect([res.status, res.json['error'].code]).toEqual([409, 'preset_limit_reached']);
        expect((await s.h.api('PUT', '/mgmt/presets/p0', { model: 'other' })).status).toBe(200);
    });

    it('names the missing write scope for a read-only token', async () => {
        const s = await stack();
        await withToken(s, 'sk-nano-mgmt-presetsread0123456789');
        expect((await s.h.api('GET', '/mgmt/presets')).status).toBe(200);
        const res = await s.h.api('PUT', '/mgmt/presets/x', { model: 'm' });
        expect([res.status, res.json['error'].code]).toEqual([409, 'mgmt_scope_missing']);
        expect(res.json['error'].message).toContain('model_presets:write');
        const created = await s.h.api('POST', '/mgmt/presets', { name: 'x', model: 'm' });
        expect(created.json['error'].message).toContain('model_presets:write');
    });
});

/* ------------------------------------------------------------------------------------------------ NanoGPT answers */

describe('what NanoGPT answers', () => {
    it('maps statuses the mock rarely gives', async () => {
        let inject = '';
        const rec = recording((): Record<string, string> => (inject ? { 'x-mock-error': inject } : {}));
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        const cases: [string, number, string][] = [
            ['429', 429, 'rate_limited'],
            ['503', 502, 'upstream_error'],
            ['500', 502, 'upstream_error'],
            ['401', 502, 'mgmt_token_invalid'],
        ];
        for (const [forced, status, code] of cases) {
            inject = forced;
            const res = await s.h.api('GET', '/mgmt/keys');
            expect([forced, res.status, res.json['error'].code]).toEqual([forced, status, code]);
        }
        expect((await s.h.api('GET', '/mgmt/status')).json).toMatchObject({
            valid: false,
            error: 'mgmt_token_invalid',
        });
    });

    it('turns a 400 into invalid_request with the field and issue, a 413 and a 409', async () => {
        const answers: Record<string, [number, unknown]> = {
            PATCH: [
                400,
                {
                    error: {
                        code: 'invalid_request',
                        message: 'bad',
                        request_id: 'r',
                        details: [{ field: 'name', issue: 'too\nlong' }, { nope: 1 }],
                    },
                },
            ],
            PUT: [413, { error: { code: 'payload_too_large', message: 'big', request_id: 'r' } }],
            DELETE: [409, { error: { code: 'Not A Code!', message: 'conflict', request_id: 'r' } }],
            GET: [403, '<html>Cloudflare</html>'],
        };
        const { s } = await fakeStack((req, res) => {
            const [status, body] = answers[req.method ?? 'GET'] ?? [500, {}];
            jsonReply(res, status, body);
        });
        const patch = await s.h.api('PATCH', '/mgmt/keys/1', { name: 'x' });
        expect([patch.status, patch.json['error'].code]).toEqual([400, 'invalid_request']);
        expect(patch.json['error'].message).toContain('name: too long');
        const put = await s.h.api('PUT', '/mgmt/presets/x', { model: 'm' });
        expect([put.status, put.json['error'].code]).toEqual([413, 'payload_too_large']);
        const del = await s.h.api('DELETE', '/mgmt/keys/1');
        expect([del.status, del.json['error'].code]).toEqual([409, 'conflict']);
        const forbidden = await s.h.api('GET', '/mgmt/keys');
        expect([forbidden.status, forbidden.json['error'].code]).toEqual([502, 'upstream_error']);
        expect(forbidden.json['error'].message).not.toContain('Cloudflare');
    });

    it('answers 502 bad_response for a payload that is not what was asked for', async () => {
        const { s } = await fakeStack((_req, res) => jsonReply(res, 200, { hello: 'world' }));
        const keys = await s.h.api('GET', '/mgmt/keys');
        expect([keys.status, keys.json['error'].code]).toEqual([502, 'bad_response']);
        expect((await s.h.api('GET', '/mgmt/presets')).json['error'].code).toBe('bad_response');
        expect((await s.h.api('PATCH', '/mgmt/keys/1', { name: 'x' })).json['error'].code).toBe('bad_response');
        expect((await s.h.api('PUT', '/mgmt/presets/x', { model: 'm' })).json['error'].code).toBe('bad_response');
    });

    it('tolerates extra and missing fields in the lists', async () => {
        const { s } = await fakeStack((req, res) => {
            if (req.url?.endsWith('/api-keys')) {
                return jsonReply(res, 200, {
                    data: [{ id: 5, name: 'Sparse', surprise: true }, 'junk', null],
                    next: 'x',
                });
            }
            return jsonReply(res, 200, { data: [{ name: 'Only-Name' }, { model: 'no name' }] });
        });
        const keys = await s.h.api('GET', '/mgmt/keys');
        expect(keys.json['keys']).toHaveLength(1);
        expect(keys.json['keys'][0]).toMatchObject({ id: '5', name: 'Sparse', status: 'active', expiresAt: null });
        const presets = await s.h.api('GET', '/mgmt/presets');
        expect(presets.json['presets']).toEqual([
            expect.objectContaining({ name: 'only-name', model: '', temperature: null }),
        ]);
    });
});

/* ------------------------------------------------------------------------------------------------ secrecy */

describe('the token stays secret', () => {
    it('is in no response, no log line and no mock log entry across a whole session', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        const seen: string[] = [];
        const call = async (method: string, route: string, body?: unknown, user?: string) => {
            const res = await s.h.api(method, route, body, user);
            seen.push(res.text);
            return res;
        };
        await call('GET', '/mgmt/status');
        await call('PUT', '/mgmt/token', { token: 'sk-nano-mgmt-TEST TOKEN' });
        await call('PUT', '/mgmt/token', { token: TOKEN });
        await call('PUT', '/mgmt/token?force=1', { token: OTHER_TOKEN });
        await call('GET', '/mgmt/status?verify=1');
        for (const [method, route, body] of [
            ['GET', '/mgmt/keys'],
            ['POST', '/mgmt/keys', { name: 'k' }],
            ['PATCH', '/mgmt/keys/1', { name: 'k2' }],
            ['PATCH', '/mgmt/keys/1', { limits: { usd: { daily: -1 } } }],
            ['DELETE', '/mgmt/keys/3'],
            ['GET', '/mgmt/presets'],
            ['POST', '/mgmt/presets', { name: 'p', model: 'm' }],
            ['PUT', '/mgmt/presets/p', { model: 'm2' }],
            ['PUT', '/mgmt/presets/p', { model: 'm', temperature: 9 }],
            ['DELETE', '/mgmt/presets/p'],
        ] as [string, string, unknown?][]) {
            await call(method, route, body);
        }
        s.h.app.deps.config.mgmtBase = `http://127.0.0.1:${await closedPort()}/api/management/v1`;
        await call('GET', '/mgmt/keys');
        await call('PUT', '/mgmt/token?force=1', { token: TOKEN });
        await call('DELETE', '/mgmt/token');

        for (const text of seen) expect(text).not.toMatch(SECRET_PART);
        expect(s.h.logs.join('\n')).not.toMatch(SECRET_PART);
        expect(JSON.stringify(s.mock.state.log)).not.toMatch(SECRET_PART);
        expect(s.h.logs.some((line) => line.includes('Management token'))).toBe(true); // it does log that, just not the value
        expect(rec.calls.some((c) => c.headers['authorization'] === `Bearer ${TOKEN}`)).toBe(true);
    });

    it('is scrubbed from texts NanoGPT sends back', async () => {
        const { s } = await fakeStack((req, res) => {
            const auth = req.headers['authorization'] ?? '';
            jsonReply(res, 400, {
                error: {
                    code: 'invalid_request',
                    message: `bad ${auth}`,
                    request_id: 'r',
                    details: [{ field: 'name', issue: `echo ${String(auth).replace('Bearer ', '')}` }],
                },
            });
        });
        const res = await s.h.api('PATCH', '/mgmt/keys/1', { name: 'x' });
        expect(res.status).toBe(400);
        expect(res.text).not.toMatch(SECRET_PART);
        expect(res.json['error'].message).toContain('[redacted]');
        expect(s.h.logs.join('\n')).not.toMatch(SECRET_PART);
    });

    it('is never put in a URL or a body', async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s);
        await s.h.api('GET', '/mgmt/keys');
        await s.h.api('PATCH', '/mgmt/keys/1', { name: 'x' });
        await s.h.api('PUT', '/mgmt/presets/p', { model: 'm' });
        for (const call of rec.calls) {
            expect(call.url).not.toMatch(SECRET_PART);
            expect(call.body ?? '').not.toMatch(SECRET_PART);
        }
    });
});

describe('users are kept apart', () => {
    it("stores each user's token in their own folder and calls NanoGPT with the right one", async () => {
        const rec = recording();
        const s = await stack({ fetch: rec.fetch });
        await withToken(s, TOKEN, 'alice');
        expect((await s.h.api('GET', '/mgmt/status', undefined, 'bob')).json['present']).toBe(false);
        const bobKeys = await s.h.api('GET', '/mgmt/keys', undefined, 'bob');
        expect([bobKeys.status, bobKeys.json['error'].code]).toEqual([409, 'mgmt_token_missing']);

        await withToken(s, OTHER_TOKEN, 'bob');
        expect(JSON.parse(fs.readFileSync(tokenFile(s.h, 'alice'), 'utf8')).token).toBe(TOKEN);
        expect(JSON.parse(fs.readFileSync(tokenFile(s.h, 'bob'), 'utf8')).token).toBe(OTHER_TOKEN);
        expect(tokenFile(s.h, 'alice')).not.toBe(tokenFile(s.h, 'bob'));
        expect(fs.existsSync(tokenFile(s.h))).toBe(false); // the default user has none

        rec.calls.length = 0;
        await s.h.api('GET', '/mgmt/keys', undefined, 'alice');
        await s.h.api('GET', '/mgmt/keys', undefined, 'bob');
        expect(rec.calls.map((c) => c.headers['authorization'])).toEqual([`Bearer ${TOKEN}`, `Bearer ${OTHER_TOKEN}`]);

        await s.h.api('DELETE', '/mgmt/token', undefined, 'bob');
        expect((await s.h.api('GET', '/mgmt/status', undefined, 'alice')).json['present']).toBe(true);
        expect((await s.h.api('GET', '/mgmt/status', undefined, 'bob')).json['present']).toBe(false);
    });

    it("turns one user's token invalid without touching another's", async () => {
        const s = await stack();
        storeToken(s.h, 'sk-nano-mgmt-expired0123456789', true, 'alice');
        storeToken(s.h, TOKEN, true, 'bob');
        await s.h.api('GET', '/mgmt/keys', undefined, 'alice');
        expect((await s.h.api('GET', '/mgmt/status', undefined, 'alice')).json['valid']).toBe(false);
        expect((await s.h.api('GET', '/mgmt/status', undefined, 'bob')).json['valid']).toBe(true);
    });
});

describe('the Management base', () => {
    it('is the only host the token goes to, with no fallback when it fails', async () => {
        const rec = recording();
        const dead = `http://127.0.0.1:${await closedPort()}/api/management/v1`;
        const s = await stack({ fetch: rec.fetch, config: { mgmtBase: dead } });
        await s.h.api('PUT', '/mgmt/token?force=1', { token: TOKEN });
        await s.h.api('GET', '/mgmt/keys');
        await s.h.api('POST', '/mgmt/keys', { name: 'x' }); // retried once, still the same base
        await s.h.api('GET', '/mgmt/status?verify=1');
        expect(rec.calls.length).toBeGreaterThanOrEqual(4);
        for (const call of rec.calls) expect(call.url.startsWith(`${dead}/`), call.url).toBe(true);
    });

    it('defaults to the real Management API and is independent of the other bases', async () => {
        const h = (await stack()).h;
        const { NANOGPT_MGMT_BASE } = await import('../../src/shared/constants');
        expect(NANOGPT_MGMT_BASE).toBe('https://nano-gpt.com/api/management/v1');
        expect(h.app.deps.config.mgmtBase).not.toBe(h.app.deps.config.siteBase);
    });
});

describe('the route table', () => {
    it('registers every Management route, PATCH included', async () => {
        const registered: string[] = [];
        const { mgmtRoutes } = await import('../../src/server/routes/mgmt');
        const record = (method: string) => (route: string) => registered.push(`${method} ${route}`);
        const s = await stack();
        mgmtRoutes(
            {
                get: record('GET'),
                post: record('POST'),
                put: record('PUT'),
                patch: record('PATCH'),
                delete: record('DELETE'),
            },
            s.h.app.deps,
        );
        expect(registered.sort()).toEqual([
            'DELETE /mgmt/keys/:id',
            'DELETE /mgmt/presets/:name',
            'DELETE /mgmt/token',
            'GET /mgmt/keys',
            'GET /mgmt/presets',
            'GET /mgmt/status',
            'PATCH /mgmt/keys/:id',
            'POST /mgmt/keys',
            'POST /mgmt/presets',
            'PUT /mgmt/presets/:name',
            'PUT /mgmt/token',
        ]);
    });
});
