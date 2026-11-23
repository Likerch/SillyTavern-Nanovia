// An in-memory stand-in for what the browser talks to: the Nanovia plugin's admin API and ST's /api/secrets routes.
// Use `backend.fetch` as `fetchImpl` (or as StMock.fetchImpl). Toggle `backend.plugin.up / installed` to simulate a dead
// or missing plugin. Values written through /keys and /api/secrets are kept only so tests can assert where they went.
import { createConnection, mergeConnection } from '../../src/domain/connection';
import { NANOGPT_API_BASE, SECRET_KEY_CUSTOM, SECRET_LABEL_PREFIX } from '../../src/shared/constants';
import type { ConnectionConfig, ConnectionView, KeyInfo } from '../../src/shared/contracts';

export interface SecretRow {
    id: string;
    value: string;
    label: string;
    active: boolean;
}

export interface RecordedCall {
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
}

export interface FakeBackend {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    plugin: {
        /** false: the route answers 404 like a missing plugin. */
        installed: boolean;
        /** false: nothing answers (connection refused). */
        up: boolean;
        port: number;
        proxyUp: boolean;
        connections: Map<string, ConnectionConfig>;
        /** connectionId -> id of its token secret under api_key_custom. */
        tokens: Map<string, string>;
        keys: KeyInfo[];
        /** Key values the plugin received (test assertions only). */
        keyValues: Map<string, string>;
        /** Makes the next call to a path (exact, e.g. 'POST /connections') fail with this status and error code. */
        failNext: Map<string, { status: number; code: string; message?: string }>;
        /** true: POST /connections always generates its own id, like a plugin that does not take one. */
        ignoreIds: boolean;
    };
    /** ST's secret store: key name -> rows. */
    secrets: Map<string, SecretRow[]>;
    calls: RecordedCall[];
    csrf: string;
    /** Calls to the plugin, newest last. */
    pluginCalls(): RecordedCall[];
}

const PLUGIN_PREFIX = '/api/plugins/nanovia';

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function errorBody(status: number, code: string, message = code): Response {
    return json({ error: { code, message } }, status);
}

export function createFakeBackend(): FakeBackend {
    let counter = 0;
    const next = (prefix: string): string => `${prefix}-${++counter}`;
    let clock = 1_700_000_000_000;

    const backend: FakeBackend = {
        plugin: {
            installed: true,
            up: true,
            port: 8787,
            proxyUp: true,
            connections: new Map(),
            tokens: new Map(),
            keys: [],
            keyValues: new Map(),
            failNext: new Map(),
            ignoreIds: false,
        },
        secrets: new Map(),
        calls: [],
        csrf: 'csrf-token-1',
        fetch: async () => new Response('unset', { status: 500 }),
        pluginCalls: () => backend.calls.filter((call) => call.path.startsWith(PLUGIN_PREFIX)),
    };

    function rows(key: string): SecretRow[] {
        let list = backend.secrets.get(key);
        if (!list) {
            list = [];
            backend.secrets.set(key, list);
        }
        return list;
    }

    function writeSecret(key: string, value: string, label: string, activate = true): string {
        const list = rows(key);
        if (activate) for (const row of list) row.active = false;
        const id = next('secret');
        list.push({ id, value, label, active: activate });
        return id;
    }

    function view(config: ConnectionConfig): ConnectionView {
        return {
            ...config,
            proxyUrl: `http://127.0.0.1:${backend.plugin.port}/c/${config.id}/v1`,
            directUrl: NANOGPT_API_BASE,
            tokenSecretId: backend.plugin.tokens.get(config.id) ?? null,
        };
    }

    function maskedKey(value: string): string {
        return `sk-nano-…${value.slice(-4)}`;
    }

    function pluginRoute(method: string, path: string, body: Record<string, unknown>): Response {
        const plugin = backend.plugin;
        const fail = plugin.failNext.get(`${method} ${path}`);
        if (fail) {
            plugin.failNext.delete(`${method} ${path}`);
            return errorBody(fail.status, fail.code, fail.message);
        }
        if (method === 'GET' && path === '/status') {
            return json({
                version: '0.1.0',
                plugin: true,
                proxy: { up: plugin.proxyUp, host: '127.0.0.1', port: plugin.port },
                secrets: true,
                user: 'default-user',
            });
        }
        if (method === 'GET' && path === '/connections') {
            return json({ connections: [...plugin.connections.values()].map(view) });
        }
        if (method === 'POST' && path === '/connections') {
            const name = body['name'];
            const modelId = body['modelId'];
            if (typeof name !== 'string' || typeof modelId !== 'string' || !name || !modelId) {
                return errorBody(400, 'bad_request', 'name and modelId are required');
            }
            const wanted =
                !plugin.ignoreIds && typeof body['id'] === 'string' && /^[a-z0-9]{6,16}$/.test(body['id'])
                    ? body['id']
                    : null;
            const id = wanted && !plugin.connections.has(wanted) ? wanted : `srv${String(++counter).padStart(6, '0')}`;
            const config = createConnection({ ...(body as Partial<ConnectionConfig>), name, modelId }, id, ++clock);
            plugin.connections.set(id, config);
            plugin.tokens.set(
                id,
                writeSecret(SECRET_KEY_CUSTOM, `token-${id}`, `${SECRET_LABEL_PREFIX}${name}`, false),
            );
            return json({ connection: view(config) });
        }
        const item = /^\/connections\/([^/]+)(\/rotate-token)?$/.exec(path);
        if (item) {
            const id = decodeURIComponent(item[1] ?? '');
            const config = plugin.connections.get(id);
            if (!config) return errorBody(404, 'not_found', 'no such connection');
            if (method === 'PUT' && !item[2]) {
                const merged = mergeConnection(config, body, ++clock);
                plugin.connections.set(id, merged);
                return json({ connection: view(merged) });
            }
            if (method === 'DELETE' && !item[2]) {
                plugin.connections.delete(id);
                const token = plugin.tokens.get(id);
                plugin.tokens.delete(id);
                if (token) {
                    const list = rows(SECRET_KEY_CUSTOM);
                    const index = list.findIndex((row) => row.id === token);
                    if (index >= 0) list.splice(index, 1);
                }
                return json({ ok: true });
            }
            if (method === 'POST' && item[2]) {
                const old = plugin.tokens.get(id);
                if (old) {
                    const list = rows(SECRET_KEY_CUSTOM);
                    const index = list.findIndex((row) => row.id === old);
                    if (index >= 0) list.splice(index, 1);
                }
                plugin.tokens.set(
                    id,
                    writeSecret(SECRET_KEY_CUSTOM, `token2-${id}`, `${SECRET_LABEL_PREFIX}${config.name}`, false),
                );
                return json({ connection: view(config) });
            }
        }
        if (method === 'GET' && path === '/keys') return json({ keys: plugin.keys });
        if (method === 'POST' && path === '/keys') {
            const label = body['label'];
            const value = body['value'];
            if (typeof label !== 'string' || typeof value !== 'string' || !value) return errorBody(400, 'bad_request');
            const key: KeyInfo = { id: next('key'), label, active: plugin.keys.length === 0, masked: maskedKey(value) };
            plugin.keys.push(key);
            plugin.keyValues.set(key.id, value);
            return json({ key });
        }
        const keyItem = /^\/keys\/([^/]+)(\/check)?$/.exec(path);
        if (keyItem) {
            const id = decodeURIComponent(keyItem[1] ?? '');
            const index = plugin.keys.findIndex((key) => key.id === id);
            if (index < 0) return errorBody(404, 'not_found', 'no such key');
            if (method === 'DELETE' && !keyItem[2]) {
                plugin.keys.splice(index, 1);
                plugin.keyValues.delete(id);
                return json({ ok: true });
            }
            if (method === 'POST' && keyItem[2]) {
                return json({ ok: true, usdBalance: '1.50', nanoBalance: null, error: null });
            }
        }
        return errorBody(404, 'not_found', 'no such route');
    }

    function secretsRoute(path: string, body: Record<string, unknown>): Response {
        const key = typeof body['key'] === 'string' ? body['key'] : '';
        if (path === '/write') {
            if (!key || typeof body['value'] !== 'string') return new Response('Invalid key or value', { status: 400 });
            const label = typeof body['label'] === 'string' ? body['label'] : 'Unlabeled';
            return json({ id: writeSecret(key, body['value'], label) });
        }
        if (path === '/read') {
            const state: Record<string, unknown> = {};
            for (const [name, list] of backend.secrets) {
                state[name] = list.length
                    ? list.map((row) => ({ id: row.id, value: '**********', label: row.label, active: row.active }))
                    : null;
            }
            return json(state);
        }
        if (path === '/rotate') {
            const list = rows(key);
            const target = list.find((row) => row.id === body['id']);
            if (!target) return new Response('not found', { status: 404 });
            for (const row of list) row.active = false;
            target.active = true;
            return new Response(null, { status: 204 });
        }
        if (path === '/delete') {
            const list = rows(key);
            const index = list.findIndex((row) => (body['id'] ? row.id === body['id'] : row.active));
            if (index >= 0) list.splice(index, 1);
            if (list.length && !list.some((row) => row.active)) list[0]!.active = true;
            return new Response(null, { status: 204 });
        }
        return new Response('not found', { status: 404 });
    }

    backend.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        const headers = (init?.headers ?? {}) as Record<string, string>;
        let body: unknown = undefined;
        if (typeof init?.body === 'string') {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }
        backend.calls.push({ method, path: url, body, headers });
        const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

        if (url.startsWith(PLUGIN_PREFIX)) {
            if (!backend.plugin.up) throw new TypeError('Failed to fetch');
            if (backend.csrf && headers['X-CSRF-Token'] !== backend.csrf)
                return new Response('Forbidden', { status: 403 });
            if (!backend.plugin.installed) return new Response('<html>Cannot GET</html>', { status: 404 });
            return pluginRoute(method, url.slice(PLUGIN_PREFIX.length).split('?')[0] ?? '', record);
        }
        if (url.startsWith('/api/secrets/')) {
            if (backend.csrf && headers['X-CSRF-Token'] !== backend.csrf)
                return new Response('Forbidden', { status: 403 });
            return secretsRoute(url.slice('/api/secrets'.length), record);
        }
        return new Response('not found', { status: 404 });
    };

    return backend;
}

/** A plugin-side connection ready to seed `backend.plugin.connections`. */
export function seedConnection(
    backend: FakeBackend,
    input: Partial<ConnectionConfig> & { name: string; modelId: string },
    id = `seed${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
): ConnectionConfig {
    const config = createConnection(input, id, 1_700_000_000_000);
    backend.plugin.connections.set(id, config);
    const rowsOfKey = backend.secrets.get(SECRET_KEY_CUSTOM) ?? [];
    const tokenId = `token-secret-${id}`;
    rowsOfKey.push({ id: tokenId, value: `token-${id}`, label: `${SECRET_LABEL_PREFIX}${input.name}`, active: false });
    backend.secrets.set(SECRET_KEY_CUSTOM, rowsOfKey);
    backend.plugin.tokens.set(id, tokenId);
    return config;
}
