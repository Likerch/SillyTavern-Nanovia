// Typed client of the server plugin's admin API (src/shared/contracts.ts, route table "admin API"). The plugin sits
// behind ST's own session and CSRF check, so every call carries ST's request headers. Nothing here throws into the UI:
// every method resolves to a PluginResult, and a plugin that is missing or not answering is an ordinary error value.
import { normalizeConnection } from '../domain/connection';
import { PLUGIN_ADMIN_BASE } from '../shared/constants';
import type { ApiStatus, ConnectionConfig, ConnectionView, KeyCheck, KeyInfo } from '../shared/contracts';
import type { Logger } from './types';

export type PluginErrorCode =
    /** The request never got an answer (plugin stopped, network down). */
    | 'unreachable'
    /** No answer within the time limit. */
    | 'timeout'
    /** ST answered 404 to the plugin's route: the plugin is not installed or not loaded. */
    | 'not_installed'
    /** 401/403: ST's session or CSRF check refused the call. */
    | 'forbidden'
    /** The answer was not what the contract says. */
    | 'invalid_response'
    /** Any other error: the plugin's own code (`not_found`, `bad_request` …) or `http_<status>`. */
    | (string & {});

export interface PluginError {
    code: PluginErrorCode;
    message: string;
    /** HTTP status, null when there was no answer. */
    status: number | null;
}

export type PluginResult<T> = { ok: true; data: T } | { ok: false; error: PluginError };

/** Errors that mean "the plugin itself is not there", as opposed to "the plugin refused this request". */
export function isPluginDown(error: PluginError): boolean {
    return error.code === 'unreachable' || error.code === 'timeout' || error.code === 'not_installed';
}

export interface PluginClient {
    /** GET /status. */
    status(): Promise<PluginResult<ApiStatus>>;
    /** Does `/status` answer? Cached for a few seconds; `fresh` asks again. */
    available(options?: { fresh?: boolean }): Promise<boolean>;
    /** The last status that answered, null when the last call did not. Never asks. */
    lastStatus(): ApiStatus | null;
    /** Forgets the cached availability. */
    invalidate(): void;
    listConnections(): Promise<PluginResult<ConnectionView[]>>;
    createConnection(
        input: Partial<ConnectionConfig> & { name: string; modelId: string },
    ): Promise<PluginResult<ConnectionView>>;
    updateConnection(id: string, patch: Partial<ConnectionConfig>): Promise<PluginResult<ConnectionView>>;
    deleteConnection(id: string): Promise<PluginResult<true>>;
    rotateToken(id: string): Promise<PluginResult<ConnectionView>>;
    listKeys(): Promise<PluginResult<KeyInfo[]>>;
    /** The value goes to the plugin and nowhere else; it is not logged and not kept. */
    addKey(label: string, value: string): Promise<PluginResult<KeyInfo>>;
    deleteKey(id: string): Promise<PluginResult<true>>;
    checkKey(id: string): Promise<PluginResult<KeyCheck>>;
    /**
     * One raw call of the admin API (`path` starts with `/`, query included): what the typed wrappers of the stages
     * (host/plugin-account.ts …) are built on. Same rules as every other method: never throws, a dead plugin is an
     * ordinary error value, availability is noted.
     */
    request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<PluginResult<unknown>>;
}

export interface PluginClientDeps {
    ctx: () => STContext;
    log: Logger;
    /** Replaced in tests; defaults to the global fetch at call time. */
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    now?: () => number;
    /** How long an availability answer is trusted (ms). */
    ttlMs?: number;
    /** Default time limit of a call (ms). */
    timeoutMs?: number;
}

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CHECK_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function invalid(what: string): PluginResult<never> {
    return { ok: false, error: { code: 'invalid_response', message: `unexpected ${what}`, status: null } };
}

/** A connection of the wire as the browser uses it; null when it is not one. */
export function parseConnectionView(raw: unknown, now = Date.now()): ConnectionView | null {
    const config = normalizeConnection(raw, now);
    if (!config || !isRecord(raw)) return null;
    const proxyUrl = str(raw['proxyUrl']);
    const directUrl = str(raw['directUrl']);
    if (proxyUrl === null || directUrl === null) return null;
    const token = raw['tokenSecretId'];
    return { ...config, proxyUrl, directUrl, tokenSecretId: typeof token === 'string' && token ? token : null };
}

export function parseStatus(raw: unknown): ApiStatus | null {
    if (!isRecord(raw) || !isRecord(raw['proxy'])) return null;
    const proxy = raw['proxy'];
    const version = str(raw['version']);
    const host = str(proxy['host']);
    const port = proxy['port'];
    if (version === null || host === null || typeof port !== 'number' || !Number.isFinite(port)) return null;
    return {
        version,
        plugin: true,
        proxy: { up: proxy['up'] === true, host, port },
        secrets: raw['secrets'] === true,
        user: str(raw['user']) ?? '',
    };
}

function parseKey(raw: unknown): KeyInfo | null {
    if (!isRecord(raw)) return null;
    const id = str(raw['id']);
    if (!id) return null;
    return { id, label: str(raw['label']) ?? '', active: raw['active'] === true, masked: str(raw['masked']) ?? '' };
}

function parseKeyCheck(raw: unknown): KeyCheck | null {
    if (!isRecord(raw) || typeof raw['ok'] !== 'boolean') return null;
    return {
        ok: raw['ok'],
        usdBalance: str(raw['usdBalance']),
        nanoBalance: str(raw['nanoBalance']),
        error: str(raw['error']),
    };
}

export function createPluginClient(deps: PluginClientDeps): PluginClient {
    const { ctx, log } = deps;
    const now = deps.now ?? Date.now;
    const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
    const defaultTimeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        (deps.fetchImpl ?? globalThis.fetch)(input, init);

    let cached: { at: number; up: boolean } | null = null;
    let last: ApiStatus | null = null;
    let inflight: Promise<boolean> | null = null;

    function noteAnswered(): void {
        cached = { at: now(), up: true };
    }

    function noteDown(): void {
        cached = { at: now(), up: false };
        last = null;
    }

    async function call(
        method: string,
        path: string,
        body?: unknown,
        timeoutMs = defaultTimeout,
    ): Promise<PluginResult<unknown>> {
        const hasBody = body !== undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
            const headers = ctx().getRequestHeaders({ omitContentType: !hasBody });
            response = await doFetch(`${PLUGIN_ADMIN_BASE}${path}`, {
                method,
                headers,
                body: hasBody ? JSON.stringify(body) : undefined,
                signal: controller.signal,
                cache: 'no-cache',
            });
        } catch (error) {
            clearTimeout(timer);
            const timedOut = controller.signal.aborted;
            noteDown();
            log.debug(`plugin ${method} ${path}: ${timedOut ? 'timeout' : 'no answer'}`);
            return {
                ok: false,
                error: {
                    code: timedOut ? 'timeout' : 'unreachable',
                    message: error instanceof Error ? error.message : String(error),
                    status: null,
                },
            };
        }
        try {
            const text = await response.text();
            let json: unknown = undefined;
            let parsedOk = false;
            if (text) {
                try {
                    json = JSON.parse(text);
                    parsedOk = true;
                } catch {
                    parsedOk = false;
                }
            }
            if (!response.ok) {
                const wire = isRecord(json) && isRecord(json['error']) ? json['error'] : null;
                const code = wire ? str(wire['code']) : null;
                const message = (wire ? str(wire['message']) : null) ?? `HTTP ${response.status}`;
                let resolved: PluginErrorCode = code ?? `http_${response.status}`;
                if (!code) {
                    if (response.status === 404) resolved = 'not_installed';
                    else if (response.status === 401 || response.status === 403) resolved = 'forbidden';
                }
                // The plugin refusing one request (bad_request, not_found …) says nothing about whether it is there.
                if (resolved === 'not_installed') noteDown();
                return { ok: false, error: { code: resolved, message, status: response.status } };
            }
            noteAnswered();
            if (!parsedOk) return invalid('response (not JSON)');
            return { ok: true, data: json };
        } catch (error) {
            noteDown();
            return {
                ok: false,
                error: {
                    code: 'unreachable',
                    message: error instanceof Error ? error.message : String(error),
                    status: response.status,
                },
            };
        } finally {
            clearTimeout(timer);
        }
    }

    function map<T>(result: PluginResult<unknown>, read: (data: unknown) => T | null, what: string): PluginResult<T> {
        if (!result.ok) return result;
        const value = read(result.data);
        return value === null ? invalid(what) : { ok: true, data: value };
    }

    function viewOf(data: unknown): ConnectionView | null {
        return isRecord(data) ? parseConnectionView(data['connection'], now()) : null;
    }

    const client: PluginClient = {
        request: (method, path, body, timeoutMs) => call(method, path, body, timeoutMs),

        async status() {
            const result = map(await call('GET', '/status'), parseStatus, 'status');
            if (result.ok) {
                last = result.data;
                noteAnswered();
            } else {
                // Whatever the reason (not installed, CSRF refused, garbage), the plugin is not usable now.
                noteDown();
            }
            return result;
        },

        async available(options) {
            if (!options?.fresh && cached && now() - cached.at < ttl) return cached.up;
            if (inflight) return inflight;
            inflight = client
                .status()
                .then((result) => result.ok)
                .finally(() => {
                    inflight = null;
                });
            return inflight;
        },

        lastStatus: () => last,

        invalidate(): void {
            cached = null;
        },

        async listConnections() {
            return map(
                await call('GET', '/connections'),
                (data) => {
                    if (!isRecord(data) || !Array.isArray(data['connections'])) return null;
                    const views: ConnectionView[] = [];
                    for (const item of data['connections']) {
                        const view = parseConnectionView(item, now());
                        if (view) views.push(view);
                        else log.warn('the plugin sent a connection that could not be read; skipped');
                    }
                    return views;
                },
                'connection list',
            );
        },

        async createConnection(input) {
            return map(await call('POST', '/connections', input), viewOf, 'connection');
        },

        async updateConnection(id, patch) {
            return map(await call('PUT', `/connections/${encodeURIComponent(id)}`, patch), viewOf, 'connection');
        },

        async deleteConnection(id) {
            const result = await call('DELETE', `/connections/${encodeURIComponent(id)}`);
            return result.ok ? { ok: true, data: true } : result;
        },

        async rotateToken(id) {
            return map(
                await call('POST', `/connections/${encodeURIComponent(id)}/rotate-token`, {}),
                viewOf,
                'connection',
            );
        },

        async listKeys() {
            return map(
                await call('GET', '/keys'),
                (data) => {
                    if (!isRecord(data) || !Array.isArray(data['keys'])) return null;
                    return data['keys'].map(parseKey).filter((key): key is KeyInfo => key !== null);
                },
                'key list',
            );
        },

        async addKey(label, value) {
            return map(
                await call('POST', '/keys', { label, value }),
                (data) => (isRecord(data) ? parseKey(data['key']) : null),
                'key',
            );
        },

        async deleteKey(id) {
            const result = await call('DELETE', `/keys/${encodeURIComponent(id)}`);
            return result.ok ? { ok: true, data: true } : result;
        },

        async checkKey(id) {
            return map(
                await call('POST', `/keys/${encodeURIComponent(id)}/check`, {}, CHECK_TIMEOUT_MS),
                parseKeyCheck,
                'key check',
            );
        },
    };
    return client;
}
