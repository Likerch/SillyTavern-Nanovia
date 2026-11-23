// The stage 0.6 routes of the plugin's admin API for browser-side tests (/mgmt/*): the token (write-only), keys with
// limits, model presets. It wraps a harness's FakeBackend (everything else is delegated to it, and
// `backend.plugin.up / installed` apply here too) and hands out a plugin client and the typed PluginMgmt over the
// wrapped fetch. It follows the real routes' rules by running the same pure checks (domain/mgmt.ts) and speaks the
// route table's error codes, so the browser code is exercised against what the plugin really answers.
import {
    PRESET_LIMIT,
    checkKeyId,
    checkMgmtToken,
    checkPresetName,
    describeIssues,
    describeTokenIssue,
    sanitizeKeyCreateInput,
    sanitizeKeyLimitsPatch,
    sanitizePresetInput,
} from '../../src/domain/mgmt';
import { createPluginClient } from '../../src/host/plugin-client';
import type { PluginClient } from '../../src/host/plugin-client';
import { createPluginMgmt } from '../../src/host/plugin-mgmt';
import type { PluginMgmt } from '../../src/host/plugin-mgmt';
import { SECRET_KEY_NANOGPT, SECRET_LABEL_PREFIX } from '../../src/shared/constants';
import type {
    KeyLimitKind,
    KeyLimitPeriod,
    ManagedKey,
    MgmtErrorCode,
    MgmtScope,
    MgmtStatus,
    ModelPreset,
} from '../../src/shared/contracts-mgmt';
import type { Harness } from './harness';

const PREFIX = '/api/plugins/nanovia';

export interface MgmtCall {
    method: string;
    /** Path and query, without the plugin prefix. */
    path: string;
    body: unknown;
}

/** What NanoGPT does with the token: knows it, rejects it, or cannot be reached. */
export type UpstreamMode = 'ok' | 'rejects' | 'down' | 'rate_limited';

export interface MgmtFake {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    client: PluginClient;
    mgmt: PluginMgmt;
    /** The stored token; null = none. Test assertions only: no route returns it. */
    token: string | null;
    /** The stored verdict (what `/mgmt/status` reports). */
    check: { valid: boolean | null; checkedAt: number | null; error: MgmtErrorCode | null };
    /** How NanoGPT answers to the stored token and to a token being checked. */
    upstream: UpstreamMode;
    /** false: the plugin answers its other routes but not /mgmt/* (an older plugin): ST's own 404. */
    hasRoutes: boolean;
    /** The scopes the stored token holds (write includes read). */
    scopes: Set<MgmtScope>;
    keys: ManagedKey[];
    presets: Map<string, ModelPreset>;
    /** The ids of the ST secrets made for created keys, in order. */
    createdSecretIds: string[];
    /** Fixed failures by route ('GET /mgmt/keys', 'PUT /mgmt/presets/:name'): they answer until removed. */
    fail: Map<string, { status: number; code: string; message?: string }>;
    calls: MgmtCall[];
    callsTo(route: string): MgmtCall[];
    /** Stores a token as if it had been saved and verified. */
    storeToken(token?: string, valid?: boolean | null): void;
    addKey(patch?: Partial<ManagedKey>): ManagedKey;
    addPreset(patch?: Partial<ModelPreset> & { name: string }): ModelPreset;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function failure(status: number, code: string, message = code): Response {
    return json({ error: { code, message } }, status);
}

export function emptyKeyLimits(): ManagedKey['limits'] {
    const empty = (): Record<KeyLimitPeriod, number | null> => ({ daily: null, weekly: null, monthly: null });
    return { requests: empty(), usd: empty(), inputTokens: empty(), subscriptionInputTokens: empty() };
}

export function blankPreset(name: string, model = 'vendor/model'): ModelPreset {
    return {
        name,
        model,
        systemPrompt: null,
        maxTokens: null,
        topK: null,
        temperature: null,
        topP: null,
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
        routing: null,
        serviceTier: null,
        thinking: null,
        promptCaching: null,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_000,
    };
}

export function createMgmtFake(h: Harness): MgmtFake {
    let clock = 1_800_000_000_000;
    let nextKey = 1;
    let nextSecret = 1;

    const fake: MgmtFake = {
        fetch: async () => new Response('unset', { status: 500 }),
        client: undefined as unknown as PluginClient,
        mgmt: undefined as unknown as PluginMgmt,
        token: null,
        check: { valid: null, checkedAt: null, error: null },
        hasRoutes: true,
        upstream: 'ok',
        scopes: new Set<MgmtScope>(['usage:read', 'api_keys:write', 'model_presets:write']),
        keys: [],
        presets: new Map(),
        createdSecretIds: [],
        fail: new Map(),
        calls: [],
        callsTo: (route) => fake.calls.filter((call) => `${call.method} ${call.path.split('?')[0]}`.startsWith(route)),
        storeToken(token = 'sk-nano-mgmt-TESTTOKEN', valid = true) {
            fake.token = token;
            fake.check = { valid, checkedAt: ++clock, error: valid === false ? 'mgmt_token_invalid' : null };
        },
        addKey(patch = {}) {
            const id = String(nextKey++);
            const key: ManagedKey = {
                id,
                name: `Key ${id}`,
                status: 'active',
                createdAt: 1_800_000_000_000,
                expiresAt: null,
                limits: emptyKeyLimits(),
                zdrPolicy: 'off',
                ...patch,
            };
            fake.keys.push(key);
            nextKey = Math.max(nextKey, Number(key.id) + 1);
            return key;
        },
        addPreset(patch = { name: 'preset' }) {
            const preset: ModelPreset = { ...blankPreset(patch.name), ...patch };
            fake.presets.set(preset.name, preset);
            return preset;
        },
    };

    function statusOf(): MgmtStatus {
        if (fake.token === null) return { present: false, valid: null, checkedAt: null, error: null };
        return { present: true, ...fake.check };
    }

    function has(scope: MgmtScope): boolean {
        if (fake.scopes.has(scope)) return true;
        // `write` includes `read`.
        return scope.endsWith(':read') && fake.scopes.has(scope.replace(':read', ':write') as MgmtScope);
    }

    /** The common gate of every call that uses the stored token: no token, rejected token, no rate, missing scope. */
    function gate(needed: MgmtScope): Response | null {
        if (fake.token === null)
            return failure(409, 'mgmt_token_missing', 'No Management token is stored; add one first');
        if (fake.upstream === 'rejects') {
            fake.check = { valid: false, checkedAt: ++clock, error: 'mgmt_token_invalid' };
            return failure(
                502,
                'mgmt_token_invalid',
                'NanoGPT rejected the Management token (revoked, expired or wrong)',
            );
        }
        if (fake.upstream === 'down') return failure(502, 'upstream_unreachable', 'NanoGPT could not be reached');
        if (fake.upstream === 'rate_limited') {
            return failure(429, 'rate_limited', 'NanoGPT is rate limiting this token; try again later');
        }
        if (fake.check.valid !== true) fake.check = { valid: true, checkedAt: ++clock, error: null };
        if (!has(needed)) return failure(409, 'mgmt_scope_missing', `The Management token lacks the ${needed} scope`);
        return null;
    }

    function accepted<T>(
        result: { ok: true; value: T } | { ok: false; issues: Parameters<typeof describeIssues>[0] },
    ): { value: T } | { response: Response } {
        if (result.ok) return { value: result.value };
        const tooLarge = result.issues.some((issue) => issue.code === 'too_large');
        return {
            response: failure(
                tooLarge ? 413 : 400,
                tooLarge ? 'payload_too_large' : 'invalid_request',
                describeIssues(result.issues),
            ),
        };
    }

    function route(method: string, full: string, body: unknown): Response | null {
        const [path = '', query = ''] = full.split('?');
        if (!path.startsWith('/mgmt/')) return null;
        const params = new URLSearchParams(query);
        const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        const generic = path.replace(/^\/mgmt\/(keys|presets)\/[^/]+$/, '/mgmt/$1/:id');
        const forced = fake.fail.get(`${method} ${generic}`) ?? fake.fail.get(`${method} ${path}`);
        if (forced) return failure(forced.status, forced.code, forced.message);

        if (method === 'GET' && path === '/mgmt/status') {
            if (params.get('verify') === '1' && fake.token !== null) {
                if (fake.upstream === 'ok') fake.check = { valid: true, checkedAt: ++clock, error: null };
                else if (fake.upstream === 'rejects') {
                    fake.check = { valid: false, checkedAt: ++clock, error: 'mgmt_token_invalid' };
                } else {
                    // No verdict: the answer says so, the stored state is kept.
                    return json({
                        present: true,
                        valid: null,
                        checkedAt: ++clock,
                        error: fake.upstream === 'rate_limited' ? 'rate_limited' : 'upstream_unreachable',
                    });
                }
            }
            return json(statusOf());
        }
        if (method === 'PUT' && path === '/mgmt/token') {
            const shape = checkMgmtToken(record['token']);
            if (!shape.ok) return failure(400, 'mgmt_token_malformed', describeTokenIssue(shape.issue));
            const force = params.get('force') === '1';
            const verdict =
                fake.upstream === 'ok' ? true : fake.upstream === 'rejects' ? false : (null as boolean | null);
            if (verdict === false) {
                return failure(502, 'mgmt_token_invalid', 'NanoGPT rejected the Management token; nothing was stored');
            }
            if (verdict === null && !force) {
                return fake.upstream === 'rate_limited'
                    ? failure(429, 'rate_limited', 'NanoGPT is rate limiting this token; nothing was stored')
                    : failure(502, 'upstream_unreachable', 'NanoGPT could not confirm the token; nothing was stored');
            }
            fake.token = shape.token;
            fake.check = {
                valid: verdict,
                checkedAt: ++clock,
                error: verdict === null ? 'upstream_unreachable' : null,
            };
            return json(statusOf());
        }
        if (method === 'DELETE' && path === '/mgmt/token') {
            fake.token = null;
            fake.check = { valid: null, checkedAt: null, error: null };
            return json({ ok: true });
        }

        if (method === 'GET' && path === '/mgmt/keys') {
            return gate('api_keys:read') ?? json({ keys: fake.keys, fetchedAt: ++clock });
        }
        if (method === 'POST' && path === '/mgmt/keys') {
            const input = accepted(sanitizeKeyCreateInput(body));
            if ('response' in input) return input.response;
            const blocked = gate('api_keys:write');
            if (blocked) return blocked;
            const created = fake.addKey({
                name: input.value.name,
                expiresAt: input.value.expiresAt ?? null,
                zdrPolicy: input.value.zdrPolicy ?? 'off',
                createdAt: ++clock,
            });
            for (const [kind, periods] of Object.entries(input.value.limits ?? {}) as [
                KeyLimitKind,
                Partial<Record<KeyLimitPeriod, number | null>>,
            ][]) {
                Object.assign(created.limits[kind], periods);
            }
            const secretId = `mgmt-secret-${nextSecret++}`;
            fake.createdSecretIds.push(secretId);
            const rows = h.backend.secrets.get(SECRET_KEY_NANOGPT) ?? [];
            rows.push({
                id: secretId,
                value: `sk-nano-created-${created.id}`,
                label: `${SECRET_LABEL_PREFIX}${created.name}`,
                active: false,
            });
            h.backend.secrets.set(SECRET_KEY_NANOGPT, rows);
            return json({ key: created, secretId });
        }
        const keyItem = /^\/mgmt\/keys\/([^/]+)$/.exec(path);
        if (keyItem) {
            const id = checkKeyId(decodeURIComponent(keyItem[1] ?? ''));
            if (id === null) return failure(400, 'invalid_request', 'The key id must be a positive whole number');
            if (method === 'PATCH') {
                const patch = accepted(sanitizeKeyLimitsPatch(body));
                if ('response' in patch) return patch.response;
                const blocked = gate('api_keys:write');
                if (blocked) return blocked;
                const key = fake.keys.find((item) => item.id === id);
                if (!key) return failure(404, 'not_found', 'NanoGPT has no such key or preset');
                if (patch.value.name !== undefined) key.name = patch.value.name;
                if (patch.value.expiresAt !== undefined) key.expiresAt = patch.value.expiresAt;
                if (patch.value.zdrPolicy !== undefined) key.zdrPolicy = patch.value.zdrPolicy;
                for (const [kind, periods] of Object.entries(patch.value.limits ?? {}) as [
                    KeyLimitKind,
                    Partial<Record<KeyLimitPeriod, number | null>>,
                ][]) {
                    Object.assign(key.limits[kind], periods);
                }
                return json({ key });
            }
            if (method === 'DELETE') {
                const blocked = gate('api_keys:write');
                if (blocked) return blocked;
                const index = fake.keys.findIndex((item) => item.id === id);
                if (index < 0) return failure(404, 'not_found', 'NanoGPT has no such key or preset');
                fake.keys.splice(index, 1);
                return json({ ok: true });
            }
        }

        if (method === 'GET' && path === '/mgmt/presets') {
            return gate('model_presets:read') ?? json({ presets: [...fake.presets.values()], fetchedAt: ++clock });
        }
        if (method === 'POST' && path === '/mgmt/presets') {
            const name = checkPresetName(record['name']);
            if (name === null) return failure(400, 'invalid_request', 'The preset name is not valid');
            const rest = { ...record };
            delete rest['name'];
            const input = accepted(sanitizePresetInput(rest));
            if ('response' in input) return input.response;
            const blocked = gate('model_presets:write');
            if (blocked) return blocked;
            if (fake.presets.has(name)) return failure(409, 'preset_exists', 'A preset with this name exists');
            if (fake.presets.size >= PRESET_LIMIT) return failure(409, 'preset_limit_reached', 'too many presets');
            const preset: ModelPreset = { ...input.value, name, createdAt: ++clock, updatedAt: clock };
            fake.presets.set(name, preset);
            return json({ preset });
        }
        const presetItem = /^\/mgmt\/presets\/([^/]+)$/.exec(path);
        if (presetItem) {
            const name = checkPresetName(decodeURIComponent(presetItem[1] ?? ''));
            if (name === null) return failure(400, 'invalid_request', 'The preset name is not valid');
            if (method === 'PUT') {
                const input = accepted(sanitizePresetInput(body));
                if ('response' in input) return input.response;
                const blocked = gate('model_presets:write');
                if (blocked) return blocked;
                const before = fake.presets.get(name);
                const preset: ModelPreset = {
                    ...input.value,
                    name,
                    createdAt: before?.createdAt ?? ++clock,
                    updatedAt: ++clock,
                };
                fake.presets.set(name, preset);
                return json({ preset });
            }
            if (method === 'DELETE') {
                const blocked = gate('model_presets:write');
                if (blocked) return blocked;
                fake.presets.delete(name);
                return json({ ok: true });
            }
        }
        return failure(404, 'not_found', 'no such route');
    }

    fake.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(`${PREFIX}/mgmt/`)) return h.backend.fetch(input, init);
        const method = (init?.method ?? 'GET').toUpperCase();
        const full = url.slice(PREFIX.length);
        let body: unknown = undefined;
        if (typeof init?.body === 'string') {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }
        fake.calls.push({ method, path: full, body });
        if (!h.backend.plugin.up) throw new TypeError('Failed to fetch');
        if (!h.backend.plugin.installed || !fake.hasRoutes) {
            return new Response('<html>Cannot GET</html>', { status: 404 });
        }
        return route(method, full, body) ?? failure(404, 'not_found', 'no such route');
    };
    fake.client = createPluginClient({
        ctx: () => h.mock.context,
        log: h.log,
        fetchImpl: fake.fetch,
        ttlMs: 0,
        timeoutMs: 200,
    });
    fake.mgmt = createPluginMgmt({ client: fake.client, now: () => clock });
    return fake;
}
