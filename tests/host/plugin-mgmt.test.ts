// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createPluginMgmt,
    isMgmtPluginDown,
    mgmtErrorOf,
    parseManagedKey,
    parseMgmtStatus,
    parseModelPreset,
} from '../../src/host/plugin-mgmt';
import type { PluginError } from '../../src/host/plugin-client';
import { SECRET_KEY_NANOGPT } from '../../src/shared/constants';
import { createMgmtFake } from '../helpers/mgmt-fake';
import type { MgmtFake } from '../helpers/mgmt-fake';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const TOKEN = 'sk-nano-mgmt-TESTTOKEN';

let h: Harness;
let fake: MgmtFake;

beforeEach(() => {
    h = createHarness();
    fake = createMgmtFake(h);
});

afterEach(() => h.restore());

describe('status', () => {
    it('reads "no token" without asking NanoGPT', async () => {
        const result = await fake.mgmt.status();
        expect(result).toEqual({ ok: true, data: { present: false, valid: null, checkedAt: null, error: null } });
        expect(fake.calls.map((call) => call.path)).toEqual(['/mgmt/status']);
    });

    it('reports the stored verdict, and `verify` asks again', async () => {
        fake.storeToken(TOKEN, true);
        expect(await fake.mgmt.status()).toMatchObject({ ok: true, data: { present: true, valid: true } });
        fake.upstream = 'rejects';
        const verified = await fake.mgmt.status({ verify: true });
        expect(verified).toMatchObject({
            ok: true,
            data: { present: true, valid: false, error: 'mgmt_token_invalid' },
        });
        expect(fake.calls.at(-1)?.path).toBe('/mgmt/status?verify=1');
    });

    it('says valid:null when NanoGPT cannot be reached during a verify', async () => {
        fake.storeToken(TOKEN, true);
        fake.upstream = 'down';
        expect(await fake.mgmt.status({ verify: true })).toMatchObject({
            ok: true,
            data: { present: true, valid: null, error: 'upstream_unreachable' },
        });
    });
});

describe('saveToken', () => {
    it('sends the token once in the body and gets only the status back', async () => {
        const result = await fake.mgmt.saveToken(TOKEN);
        expect(result).toMatchObject({ ok: true, data: { present: true, valid: true, error: null } });
        expect(JSON.stringify(result)).not.toContain('TESTTOKEN');
        expect(fake.token).toBe(TOKEN);
        const call = fake.callsTo('PUT /mgmt/token')[0];
        expect(call?.path).toBe('/mgmt/token');
        expect(call?.body).toEqual({ token: TOKEN });
    });

    it('maps a token that is not a Management token', async () => {
        const result = await fake.mgmt.saveToken('sk-nano-0000-1111-2222');
        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'token_malformed', code: 'mgmt_token_malformed', status: 400 },
        });
        expect(fake.token).toBeNull();
    });

    it('maps a token NanoGPT rejected, and stores nothing', async () => {
        fake.upstream = 'rejects';
        const result = await fake.mgmt.saveToken(TOKEN);
        expect(result).toMatchObject({ ok: false, error: { kind: 'token_invalid', status: 502 } });
        expect(fake.token).toBeNull();
    });

    it('refuses to store when NanoGPT cannot confirm, unless forced', async () => {
        fake.upstream = 'down';
        const refused = await fake.mgmt.saveToken(TOKEN);
        expect(refused).toMatchObject({ ok: false, error: { kind: 'upstream', code: 'upstream_unreachable' } });
        expect(fake.token).toBeNull();

        const forced = await fake.mgmt.saveToken(TOKEN, { force: true });
        expect(forced).toMatchObject({ ok: true, data: { present: true, valid: null, error: 'upstream_unreachable' } });
        expect(fake.token).toBe(TOKEN);
        expect(fake.calls.at(-1)?.path).toBe('/mgmt/token?force=1');
    });

    it('maps a rate limit', async () => {
        fake.upstream = 'rate_limited';
        expect(await fake.mgmt.saveToken(TOKEN)).toMatchObject({ ok: false, error: { kind: 'rate_limited' } });
    });

    it('scrubs the token from an error message that happens to contain it', async () => {
        fake.fail.set('PUT /mgmt/token', { status: 502, code: 'upstream_error', message: `echo ${TOKEN} here` });
        const result = await fake.mgmt.saveToken(TOKEN);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain('TESTTOKEN');
        expect(result.ok ? '' : result.error.message).toBe('echo … here');
    });

    it('deletes the token', async () => {
        fake.storeToken();
        expect(await fake.mgmt.deleteToken()).toEqual({ ok: true, data: true });
        expect(fake.token).toBeNull();
        // Also when there is none.
        expect(await fake.mgmt.deleteToken()).toEqual({ ok: true, data: true });
    });
});

describe('keys', () => {
    it('lists the keys of the contract', async () => {
        fake.storeToken();
        fake.addKey({
            name: 'Main',
            limits: { ...fake.addKey().limits, usd: { daily: 5, weekly: null, monthly: 50 } },
        });
        const result = await fake.mgmt.listKeys();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.keys).toHaveLength(2);
        expect(result.data.keys[1]).toMatchObject({ name: 'Main', limits: { usd: { daily: 5, monthly: 50 } } });
        expect(typeof result.data.fetchedAt).toBe('number');
    });

    it('maps "no token" and a rejected token', async () => {
        expect(await fake.mgmt.listKeys()).toMatchObject({ ok: false, error: { kind: 'token_missing', status: 409 } });
        fake.storeToken();
        fake.upstream = 'rejects';
        expect(await fake.mgmt.listKeys()).toMatchObject({ ok: false, error: { kind: 'token_invalid' } });
    });

    it('names the missing scope, from the message and from the call', async () => {
        fake.storeToken();
        fake.scopes = new Set(['model_presets:write']);
        const keys = await fake.mgmt.listKeys();
        expect(keys).toMatchObject({ ok: false, error: { kind: 'scope_missing', scope: 'api_keys:read' } });
        // The message of a plugin that names another scope wins over the call's own idea.
        fake.fail.set('GET /mgmt/keys', {
            status: 409,
            code: 'mgmt_scope_missing',
            message: 'lacks the api_keys:write scope',
        });
        expect(await fake.mgmt.listKeys()).toMatchObject({ ok: false, error: { scope: 'api_keys:write' } });
        // A message that names none falls back to what the call needed.
        fake.fail.set('GET /mgmt/keys', { status: 409, code: 'mgmt_scope_missing', message: 'no scope named' });
        expect(await fake.mgmt.listKeys()).toMatchObject({ ok: false, error: { scope: 'api_keys:read' } });
    });

    it('creates a key: the answer carries the secret id, never the secret', async () => {
        fake.storeToken();
        const result = await fake.mgmt.createKey({
            name: 'Roleplay',
            limits: { usd: { monthly: 20 } },
            zdrPolicy: 'zdr',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.key).toMatchObject({ name: 'Roleplay', zdrPolicy: 'zdr', limits: { usd: { monthly: 20 } } });
        expect(result.data.secretId).toBe(fake.createdSecretIds[0]);
        expect(JSON.stringify(result)).not.toContain('sk-nano-created');
        expect(h.backend.secrets.get(SECRET_KEY_NANOGPT)?.[0]?.label).toBe('Nanovia: Roleplay');
        expect(fake.callsTo('POST /mgmt/keys')[0]?.body).toEqual({
            name: 'Roleplay',
            limits: { usd: { monthly: 20 } },
            zdrPolicy: 'zdr',
        });
    });

    it('maps an invalid request with the plugin message', async () => {
        fake.storeToken();
        const result = await fake.mgmt.createKey({ name: 'x', limits: { usd: { daily: -1 } } });
        expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request', status: 400 } });
        expect(result.ok ? '' : result.error.message).toContain('limits.usd.daily');
    });

    it('maps the secret store trouble of a create', async () => {
        fake.storeToken();
        fake.fail.set('POST /mgmt/keys', { status: 503, code: 'secrets_unavailable' });
        expect(await fake.mgmt.createKey({ name: 'x' })).toMatchObject({
            ok: false,
            error: { kind: 'secrets_unavailable' },
        });
        fake.fail.set('POST /mgmt/keys', { status: 500, code: 'secrets_failed' });
        expect(await fake.mgmt.createKey({ name: 'x' })).toMatchObject({
            ok: false,
            error: { kind: 'secrets_failed' },
        });
    });

    it('updates the limits (a patch) and revokes', async () => {
        fake.storeToken();
        const key = fake.addKey({ name: 'Old' });
        const updated = await fake.mgmt.updateKey(key.id, { name: 'New', limits: { requests: { daily: 100 } } });
        expect(updated).toMatchObject({
            ok: true,
            data: { id: key.id, name: 'New', limits: { requests: { daily: 100 } } },
        });
        expect(fake.callsTo('PATCH /mgmt/keys/1')[0]?.body).toEqual({
            name: 'New',
            limits: { requests: { daily: 100 } },
        });

        expect(await fake.mgmt.revokeKey(key.id)).toEqual({ ok: true, data: true });
        expect(fake.keys).toHaveLength(0);
        expect(await fake.mgmt.revokeKey(key.id)).toMatchObject({
            ok: false,
            error: { kind: 'not_found', status: 404 },
        });
    });

    it('encodes the id in the path', async () => {
        fake.storeToken();
        await fake.mgmt.updateKey('a/b', { name: 'x' });
        expect(fake.calls.at(-1)?.path).toBe('/mgmt/keys/a%2Fb');
    });
});

describe('presets', () => {
    it('lists, creates, replaces and deletes', async () => {
        fake.storeToken();
        const created = await fake.mgmt.createPreset({ name: 'RP-Fast', model: 'vendor/model', temperature: 0.9 });
        expect(created).toMatchObject({ ok: true, data: { name: 'rp-fast', model: 'vendor/model', temperature: 0.9 } });

        const listed = await fake.mgmt.listPresets();
        expect(listed.ok && listed.data.presets.map((preset) => preset.name)).toEqual(['rp-fast']);

        const replaced = await fake.mgmt.replacePreset('rp-fast', {
            model: 'vendor/other',
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '1h' },
        });
        expect(replaced).toMatchObject({
            ok: true,
            data: {
                model: 'vendor/other',
                temperature: null,
                thinking: { enabled: true, budgetTokens: 4000 },
                promptCaching: { enabled: true, ttl: '1h' },
            },
        });

        expect(await fake.mgmt.deletePreset('rp-fast')).toEqual({ ok: true, data: true });
        expect(fake.presets.size).toBe(0);
        expect(await fake.mgmt.deletePreset('rp-fast')).toEqual({ ok: true, data: true });
    });

    it('maps a taken name and the other conflicts', async () => {
        fake.storeToken();
        fake.addPreset({ name: 'taken' });
        expect(await fake.mgmt.createPreset({ name: 'taken', model: 'm/x' })).toMatchObject({
            ok: false,
            error: { kind: 'preset_exists', code: 'preset_exists', status: 409 },
        });
        fake.fail.set('POST /mgmt/presets', { status: 409, code: 'preset_limit_reached' });
        expect(await fake.mgmt.createPreset({ name: 'new', model: 'm/x' })).toMatchObject({
            ok: false,
            error: { kind: 'conflict', code: 'preset_limit_reached' },
        });
    });

    it('maps oversize and invalid presets', async () => {
        fake.storeToken();
        expect(await fake.mgmt.replacePreset('a', { model: 'm/x', temperature: 5 })).toMatchObject({
            ok: false,
            error: { kind: 'invalid_request' },
        });
        fake.fail.set('PUT /mgmt/presets/:id', { status: 413, code: 'payload_too_large' });
        expect(await fake.mgmt.replacePreset('a', { model: 'm/x' })).toMatchObject({
            ok: false,
            error: { kind: 'too_large' },
        });
    });
});

describe('when the plugin is not there', () => {
    it('is an error value, not an exception', async () => {
        h.backend.plugin.up = false;
        const down = await fake.mgmt.status();
        expect(down).toMatchObject({ ok: false, error: { kind: 'plugin_down', code: 'unreachable', status: null } });
        expect(isMgmtPluginDown(down.ok ? ({} as never) : down.error)).toBe(true);

        h.backend.plugin.up = true;
        h.backend.plugin.installed = false;
        const missing = await fake.mgmt.listKeys();
        expect(missing).toMatchObject({ ok: false, error: { kind: 'not_installed' } });
        expect(isMgmtPluginDown(missing.ok ? ({} as never) : missing.error)).toBe(true);
    });

    it('is not "down" for a refusal of this one request', async () => {
        fake.storeToken();
        const refused = await fake.mgmt.updateKey('1', { name: 'x' });
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(isMgmtPluginDown(refused.error)).toBe(false);
    });

    it('tells ST refusing the session or CSRF check (401/403 without our code)', async () => {
        const mgmt = createPluginMgmt({
            client: {
                request: async () => ({ ok: false, error: { code: 'forbidden', message: 'Forbidden', status: 403 } }),
            },
        });
        const result = await mgmt.status();
        expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden', status: 403 } });
        expect(isMgmtPluginDown(result.ok ? ({} as never) : result.error)).toBe(true);
    });
});

describe('answers that are not what the contract says', () => {
    function mgmtWith(data: unknown) {
        return createPluginMgmt({ client: { request: async () => ({ ok: true, data }) } });
    }

    it('become invalid_response, never a half-filled object', async () => {
        for (const bad of [null, 'text', 42, [], {}]) {
            const mgmt = mgmtWith(bad);
            expect(await mgmt.status()).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
            expect(await mgmt.listKeys()).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
            expect(await mgmt.listPresets()).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
            expect(await mgmt.createKey({ name: 'x' })).toMatchObject({
                ok: false,
                error: { kind: 'invalid_response' },
            });
            expect(await mgmt.updateKey('1', { name: 'x' })).toMatchObject({
                ok: false,
                error: { kind: 'invalid_response' },
            });
            expect(await mgmt.createPreset({ name: 'x', model: 'm' })).toMatchObject({
                ok: false,
                error: { kind: 'invalid_response' },
            });
            expect(await mgmt.revokeKey('1')).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
        }
    });

    it('a non-JSON answer from the plugin client is invalid_response too', async () => {
        const result = await createPluginMgmt({
            client: {
                request: async () => ({
                    ok: false,
                    error: { code: 'invalid_response', message: 'unexpected response (not JSON)', status: null },
                }),
            },
        }).status();
        expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
    });

    it('lists skip what has no id or name and repeat nothing', async () => {
        const mgmt = createPluginMgmt({
            client: {
                request: async (_method, path) =>
                    path === '/mgmt/keys'
                        ? {
                              ok: true,
                              data: {
                                  keys: [{ id: 1, name: 'A' }, { name: 'no id' }, { id: '1', name: 'dup' }, 7],
                                  fetchedAt: 5,
                              },
                          }
                        : {
                              ok: true,
                              data: { presets: [{ name: 'a', model: 'm' }, { model: 'no name' }, { name: 'a' }, null] },
                          },
            },
            now: () => 99,
        });
        const keys = await mgmt.listKeys();
        expect(keys).toMatchObject({ ok: true, data: { fetchedAt: 5 } });
        expect(keys.ok && keys.data.keys.map((key) => key.name)).toEqual(['A']);
        const presets = await mgmt.listPresets();
        expect(presets.ok && presets.data.presets.map((preset) => preset.name)).toEqual(['a']);
        expect(presets.ok && presets.data.fetchedAt).toBe(99);
    });
});

describe('parsers', () => {
    it('parseMgmtStatus drops the verdict of a missing token and unknown error codes', () => {
        expect(parseMgmtStatus({ present: false, valid: true, checkedAt: 5, error: 'upstream_error' })).toEqual({
            present: false,
            valid: null,
            checkedAt: null,
            error: null,
        });
        expect(parseMgmtStatus({ present: true, valid: 'yes', checkedAt: 'x', error: 'weird' })).toEqual({
            present: true,
            valid: null,
            checkedAt: null,
            error: null,
        });
        expect(parseMgmtStatus({ valid: true })).toBeNull();
        expect(parseMgmtStatus('x')).toBeNull();
    });

    it('parseManagedKey fills every limit, drops junk and keeps ids as strings', () => {
        const key = parseManagedKey({
            id: 12,
            name: 'K',
            status: 'expired',
            createdAt: 5,
            expiresAt: 'later',
            limits: { usd: { daily: 1.5, weekly: -3, monthly: 'x' }, requests: 'nope' },
            zdrPolicy: 'strange',
        });
        expect(key).toEqual({
            id: '12',
            name: 'K',
            status: 'expired',
            createdAt: 5,
            expiresAt: null,
            limits: {
                requests: { daily: null, weekly: null, monthly: null },
                usd: { daily: 1.5, weekly: null, monthly: null },
                inputTokens: { daily: null, weekly: null, monthly: null },
                subscriptionInputTokens: { daily: null, weekly: null, monthly: null },
            },
            zdrPolicy: null,
        });
        expect(parseManagedKey({ name: 'no id' })).toBeNull();
        expect(parseManagedKey({ id: '  ' })).toBeNull();
    });

    it('parseModelPreset keeps what is valid and nulls what is not', () => {
        const preset = parseModelPreset({
            name: ' rp ',
            model: 'm/x',
            systemPrompt: 'be brief',
            temperature: 0.7,
            topK: 'x',
            routing: 'price',
            serviceTier: 'turbo',
            thinking: { enabled: true, budgetTokens: 2000.5 },
            promptCaching: { enabled: false, ttl: '1h' },
            structuredOutputs: 'yes',
        });
        expect(preset).toMatchObject({
            name: 'rp',
            model: 'm/x',
            systemPrompt: 'be brief',
            temperature: 0.7,
            topK: null,
            routing: 'price',
            serviceTier: null,
            thinking: { enabled: true, budgetTokens: null },
            promptCaching: { enabled: false, ttl: '1h' },
            structuredOutputs: null,
        });
        expect(parseModelPreset({ model: 'x' })).toBeNull();
        expect(parseModelPreset({ name: 'a', thinking: 'on', promptCaching: { ttl: '5m' } })).toMatchObject({
            thinking: null,
            promptCaching: null,
        });
    });
});

describe('mgmtErrorOf', () => {
    const base = (code: string, status: number | null = null): PluginError => ({ code, message: 'm', status });

    it('maps every code of the route table', () => {
        const kinds: Record<string, string> = {
            unreachable: 'plugin_down',
            timeout: 'plugin_down',
            not_installed: 'not_installed',
            forbidden: 'forbidden',
            invalid_response: 'invalid_response',
            mgmt_token_missing: 'token_missing',
            mgmt_token_invalid: 'token_invalid',
            mgmt_scope_missing: 'scope_missing',
            mgmt_token_malformed: 'token_malformed',
            invalid_request: 'invalid_request',
            not_found: 'not_found',
            preset_exists: 'preset_exists',
            payload_too_large: 'too_large',
            rate_limited: 'rate_limited',
            secrets_unavailable: 'secrets_unavailable',
            secrets_failed: 'secrets_failed',
            upstream_unreachable: 'upstream',
            upstream_timeout: 'upstream',
            upstream_error: 'upstream',
            bad_response: 'upstream',
            http_500: 'other',
        };
        for (const [code, kind] of Object.entries(kinds)) expect(mgmtErrorOf(base(code)).kind).toBe(kind);
    });

    it('treats any other 409 as a conflict and keeps its code', () => {
        expect(mgmtErrorOf(base('idempotency_key_reused', 409))).toMatchObject({
            kind: 'conflict',
            code: 'idempotency_key_reused',
        });
    });

    it('leaves out the scope of other errors', () => {
        expect('scope' in mgmtErrorOf(base('rate_limited'), 'api_keys:read')).toBe(false);
    });
});
