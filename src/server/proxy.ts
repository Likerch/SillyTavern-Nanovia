// The local OpenAI-compatible proxy (docs/ARCHITECTURE.md §4): its own listener on 127.0.0.1, because ST's router
// would demand a session cookie and a CSRF token from ST's server-side Custom-source fetch.
//
//   GET  /health                           -> { ok: true, version }                     (no auth)
//   GET  /c/<id>/v1/models                 -> OpenAI model list with the connection's model
//   POST /c/<id>/v1/chat/completions       -> NanoGPT, streamed chunk by chunk or in one piece
//
// Keys, tokens and request bodies are never logged and never appear in an error message.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { UsageRecord } from '../shared/contracts';
import { PROXY_HOST, RESPONSE_HEADERS, SECRET_KEY_NANOGPT } from '../shared/constants';
import { createProxyContext, parseHints } from './context';
import { REQUEST_STEPS, RESPONSE_STEPS } from './pipeline';
import { SecretValue } from './secret-value';
import { hashToken } from './tokens';
import { callUpstream, UpstreamError, type UpstreamHandle } from './upstream';
import type { ProxyContext, ProxyStatus, RequestStep, ResponseStep, ServerDeps, UpstreamInfo } from './types';

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ROUTE = /^\/c\/([a-z0-9]{6,16})\/v1\/(models|chat\/completions)\/?$/;
const REQUEST_ID_HEADERS = ['x-request-id', 'x-nanogpt-request-id', 'request-id'];

export interface ProxyServer {
    /** Starts listening; never rejects: a taken port leaves the proxy down and says why in the status. */
    listen(): Promise<ProxyStatus>;
    close(): Promise<void>;
    status(): ProxyStatus;
}

export interface PipelineSteps {
    request: RequestStep[];
    response: ResponseStep[];
}

type BodyResult =
    { ok: true; value: Record<string, unknown> } | { ok: false; status: number; code: string; message: string };

export function createProxyServer(
    deps: ServerDeps,
    steps: PipelineSteps = { request: REQUEST_STEPS, response: RESPONSE_STEPS },
): ProxyServer {
    const { config, log } = deps;
    let state: ProxyStatus = { up: false, host: PROXY_HOST, port: config.port, error: null };

    const server = http.createServer((req, res) => {
        res.on('error', () => {});
        handle(req, res).catch((error: unknown) => {
            log.error(`proxy request failed (${describe(error)})`);
            if (!res.headersSent) sendError(res, 500, 'server_error', 'internal_error', 'Internal error');
            else res.destroy();
        });
    });

    async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const pathname = (req.url ?? '/').split('?')[0] ?? '/';
        if (pathname === '/health') {
            if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET');
            return sendJson(res, 200, { ok: true, version: deps.version });
        }
        const match = ROUTE.exec(pathname);
        if (!match) return sendError(res, 404, 'invalid_request_error', 'not_found', 'Unknown path');
        const connectionId = match[1] as string;
        const endpoint = match[2] as 'models' | 'chat/completions';
        const wanted = endpoint === 'models' ? 'GET' : 'POST';
        if (req.method !== wanted) return sendMethodNotAllowed(res, wanted);

        const auth = authenticate(req, connectionId);
        if (!auth.ok) {
            return sendError(res, 401, 'authentication_error', auth.code, auth.message);
        }
        const connection = deps.store.connections.get(auth.userRoot, connectionId);
        if (!connection) {
            return sendError(
                res,
                404,
                'invalid_request_error',
                'connection_not_found',
                'This connection does not exist',
            );
        }

        if (endpoint === 'models') {
            return sendJson(
                res,
                200,
                {
                    object: 'list',
                    data: [
                        {
                            id: connection.modelId,
                            object: 'model',
                            created: Math.floor(connection.createdAt / 1000),
                            owned_by: 'nanogpt',
                        },
                    ],
                },
                { [RESPONSE_HEADERS.connection]: connection.id },
            );
        }
        await chatCompletions(req, res, auth.user, auth.userRoot, connection);
    }

    function authenticate(
        req: http.IncomingMessage,
        connectionId: string,
    ): { ok: true; user: string; userRoot: string } | { ok: false; code: string; message: string } {
        const token = presentedToken(req);
        if (!token) return { ok: false, code: 'missing_token', message: 'Missing proxy token' };
        const entry = deps.store.registry.lookup(hashToken(token));
        if (!entry || entry.connectionId !== connectionId) {
            return { ok: false, code: 'invalid_token', message: 'Invalid proxy token for this connection' };
        }
        try {
            return { ok: true, user: entry.userHandle, userRoot: deps.st.userRoot(entry.userHandle) };
        } catch {
            return { ok: false, code: 'invalid_token', message: 'Invalid proxy token for this connection' };
        }
    }

    async function chatCompletions(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        user: string,
        userRoot: string,
        connection: ProxyContext['connection'],
    ): Promise<void> {
        const startedAt = deps.now();
        const clientAbort = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished) clientAbort.abort();
        });
        const connectionHeader = { [RESPONSE_HEADERS.connection]: connection.id };

        /** Answers with an error before a context exists and keeps the attempt in the usage log. */
        const early = async (
            status: number,
            type: string,
            code: string,
            message: string,
            stream = false,
        ): Promise<void> => {
            sendError(res, status, type, code, message, connectionHeader);
            await deps.usage.append(userRoot, {
                ...blankUsage(connection.id, connection.modelId, startedAt, deps.now()),
                status,
                stream,
                error: code,
            });
        };

        const parsed = await readJsonBody(req);
        if (!parsed.ok) return early(parsed.status, 'invalid_request_error', parsed.code, parsed.message);
        const incoming = parsed.value;
        const stream = incoming['stream'] === true;

        let key: SecretValue | null;
        try {
            key = resolveKey(user, connection.keyId);
        } catch {
            return early(500, 'server_error', 'secrets_error', 'The secret store could not be read', stream);
        }
        if (!key) {
            const message = connection.keyId
                ? 'The NanoGPT key chosen for this connection no longer exists'
                : 'No NanoGPT key is stored; add one in SillyTavern';
            return early(409, 'invalid_request_error', 'no_key', message, stream);
        }

        const ctx = createProxyContext({
            localId: randomBytes(4).toString('hex'),
            now: startedAt,
            user,
            connection,
            key,
            model: deps.lookupModel(typeof incoming['model'] === 'string' ? incoming['model'] : connection.modelId),
            hints: parseHints(req.headers),
            body: incoming,
            signal: clientAbort.signal,
        });

        try {
            for (const step of steps.request) await step(ctx);
        } catch (error) {
            log.error(`request step failed (${describe(error, key)})`);
            ctx.usage.model = ctx.plan.model;
            return finishWithError(ctx, res, userRoot, 500, 'server_error', 'internal_error', 'Internal error');
        }
        ctx.usage.model = ctx.plan.model;

        let upstream: UpstreamHandle;
        try {
            upstream = await callUpstream({
                fetch: deps.fetch,
                base: config.upstreamBase,
                fallbackBase: config.upstreamFallbackBase,
                body: JSON.stringify(ctx.plan.body),
                headers: ctx.plan.headers,
                key,
                stream: ctx.stream,
                timeoutMs: config.timeoutMs,
                signal: clientAbort.signal,
                userAgent: `Nanovia/${deps.version}`,
            });
        } catch (error) {
            return failUpstream(ctx, res, userRoot, error);
        }

        try {
            await relay(ctx, upstream, res, userRoot);
        } finally {
            upstream.close();
        }
    }

    /** Passes the upstream answer to the client, runs the response steps and writes the usage record. */
    async function relay(
        ctx: ProxyContext,
        upstream: UpstreamHandle,
        res: http.ServerResponse,
        userRoot: string,
    ): Promise<void> {
        const ok = upstream.status >= 200 && upstream.status < 300;
        const sse = ctx.stream && ok && (upstream.headers['content-type'] ?? '').includes('text/event-stream');
        const info: UpstreamInfo = {
            status: upstream.status,
            headers: upstream.headers,
            requestId: firstHeader(upstream.headers, REQUEST_ID_HEADERS),
            base: upstream.base,
            stream: sse,
            body: null,
        };
        ctx.upstream = info;
        ctx.usage.requestId = info.requestId;

        if (sse) {
            let failure: UpstreamError | null = null;
            res.writeHead(info.status, clientHeaders(ctx, info, true));
            res.flushHeaders();
            res.socket?.setNoDelay(true);
            try {
                for await (const chunk of upstream.body) {
                    upstream.touch();
                    await writeChunk(res, chunk);
                    if (clientGone(ctx)) break;
                }
            } catch (error) {
                failure = error instanceof UpstreamError ? error : new UpstreamError('unreachable', null);
            }
            if (failure && failure.kind !== 'aborted' && !res.destroyed) {
                const text =
                    failure.kind === 'timeout' ? 'The upstream stopped sending data' : 'The upstream connection broke';
                const code = failure.kind === 'timeout' ? 'upstream_timeout' : 'upstream_unreachable';
                res.write(`data: ${JSON.stringify(errorBody('upstream_error', code, text))}\n\n`);
            }
            const aborted = clientGone(ctx) || failure?.kind === 'aborted';
            ctx.usage.status = aborted ? 499 : failure ? (failure.kind === 'timeout' ? 504 : 502) : info.status;
            ctx.usage.error = aborted
                ? 'client_closed'
                : failure
                  ? failure.kind === 'timeout'
                      ? 'upstream_timeout'
                      : 'upstream_unreachable'
                  : null;
            if (!res.writableEnded && !res.destroyed) res.end();
            await runResponseSteps(ctx);
            await finish(ctx, userRoot);
            return;
        }

        const chunks: Buffer[] = [];
        try {
            for await (const chunk of upstream.body) {
                upstream.touch();
                chunks.push(Buffer.from(chunk));
            }
        } catch (error) {
            return failUpstream(ctx, res, userRoot, error);
        }
        let body: Buffer = Buffer.concat(chunks);
        if (!ok) body = normalizeErrorBody(info.status, body, ctx.key);
        info.body = body;
        ctx.usage.status = info.status;
        if (!ok) ctx.usage.error = upstreamErrorCode(body) ?? `http_${info.status}`;
        await runResponseSteps(ctx);

        const out = info.body ?? Buffer.alloc(0);
        if (!res.destroyed) {
            res.writeHead(info.status, { ...clientHeaders(ctx, info, false), 'content-length': String(out.length) });
            res.end(out);
        }
        await finish(ctx, userRoot);
    }

    function clientGone(ctx: ProxyContext): boolean {
        return ctx.signal.aborted;
    }

    async function runResponseSteps(ctx: ProxyContext): Promise<void> {
        for (const step of steps.response) {
            try {
                await step(ctx);
            } catch (error) {
                log.warn(`response step failed (${describe(error, ctx.key)})`);
            }
        }
    }

    async function finish(ctx: ProxyContext, userRoot: string): Promise<void> {
        ctx.usage.latencyMs = Math.max(0, deps.now() - ctx.startedAt);
        await deps.usage.append(userRoot, ctx.usage);
    }

    async function finishWithError(
        ctx: ProxyContext,
        res: http.ServerResponse,
        userRoot: string,
        status: number,
        type: string,
        code: string,
        message: string,
    ): Promise<void> {
        sendError(res, status, type, code, message, { [RESPONSE_HEADERS.connection]: ctx.connection.id });
        ctx.usage.status = status;
        ctx.usage.error = code;
        await finish(ctx, userRoot);
    }

    async function failUpstream(
        ctx: ProxyContext,
        res: http.ServerResponse,
        userRoot: string,
        error: unknown,
    ): Promise<void> {
        const failure = error instanceof UpstreamError ? error : new UpstreamError('unreachable', null);
        if (failure.kind === 'aborted') {
            ctx.usage.status = 499;
            ctx.usage.error = 'client_closed';
            return finish(ctx, userRoot);
        }
        const timeout = failure.kind === 'timeout';
        const code = timeout ? 'upstream_timeout' : 'upstream_unreachable';
        log.warn(
            `upstream ${failure.kind} for connection ${ctx.connection.id}${failure.code ? ` (${failure.code})` : ''}`,
        );
        const message = timeout ? 'NanoGPT did not answer in time' : 'NanoGPT could not be reached';
        return finishWithError(ctx, res, userRoot, timeout ? 504 : 502, 'upstream_error', code, message);
    }

    function resolveKey(user: string, keyId: string | null): SecretValue | null {
        if (!deps.st.available) return config.nanogptKey ? new SecretValue(config.nanogptKey) : null;
        const value = deps.st.readSecret(user, SECRET_KEY_NANOGPT, keyId);
        return value ? new SecretValue(value) : null;
    }

    return {
        status: () => state,
        listen() {
            return new Promise<ProxyStatus>((resolve) => {
                const onError = (error: NodeJS.ErrnoException): void => {
                    state = { up: false, host: PROXY_HOST, port: config.port, error: error.code ?? 'ERROR' };
                    log.error(
                        error.code === 'EADDRINUSE'
                            ? `port ${config.port} is already in use: the proxy is not running (set NANOVIA_PORT or "port" in config.json)`
                            : `the proxy listener failed (${error.code ?? error.message})`,
                    );
                    resolve(state);
                };
                server.once('error', onError);
                server.listen(config.port, PROXY_HOST, () => {
                    server.off('error', onError);
                    server.on('error', (error: NodeJS.ErrnoException) =>
                        log.error(`proxy listener error (${error.code ?? error.message})`),
                    );
                    const address = server.address() as AddressInfo;
                    state = { up: true, host: PROXY_HOST, port: address.port, error: null };
                    resolve(state);
                });
            });
        },
        close() {
            return new Promise<void>((resolve) => {
                const wasUp = state.up;
                state = { ...state, up: false };
                if (!wasUp) return resolve();
                server.close(() => resolve());
                server.closeAllConnections();
            });
        },
    };
}

/* ------------------------------------------------------------------------------------------------ helpers */

function presentedToken(req: http.IncomingMessage): string | null {
    const authorization = req.headers['authorization'];
    if (typeof authorization === 'string') {
        const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
        if (m?.[1]) return m[1];
    }
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
    return null;
}

function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
    return new Promise((resolve) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            resolve(tooLarge());
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        let overflow = false;
        const settle = (result: BodyResult): void => {
            if (done) return;
            done = true;
            resolve(result);
        };
        req.on('data', (chunk: Buffer) => {
            if (overflow) return; // the rest is read and thrown away; the 413 is already on its way
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                overflow = true;
                chunks.length = 0;
                settle(tooLarge());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (size === 0) {
                settle(invalid('invalid_json', 'The request body is empty'));
                return;
            }
            let value: unknown;
            try {
                value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
                settle(invalid('invalid_json', 'The request body is not valid JSON'));
                return;
            }
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                settle(invalid('invalid_request', 'The request body must be a JSON object'));
                return;
            }
            settle({ ok: true, value: value as Record<string, unknown> });
        });
        req.on('error', () => settle(invalid('invalid_request', 'The request could not be read')));
        req.on('close', () => settle(invalid('invalid_request', 'The request was cut off')));
    });
}

function invalid(code: string, message: string): BodyResult {
    return { ok: false, status: 400, code, message };
}

function tooLarge(): BodyResult {
    return { ok: false, status: 413, code: 'payload_too_large', message: 'The request body is larger than 32 MiB' };
}

function blankUsage(connectionId: string, model: string, startedAt: number, now: number): UsageRecord {
    return {
        at: startedAt,
        connectionId,
        requestId: null,
        model,
        billing: 'unknown',
        costUsd: null,
        equivalentUsd: null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        latencyMs: Math.max(0, now - startedAt),
        status: 0,
        stream: false,
        consumer: 'unknown',
        error: null,
    };
}

function errorBody(
    type: string,
    code: string,
    message: string,
): { error: { message: string; type: string; code: string } } {
    return { error: { message, type, code } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent || res.destroyed) return;
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(payload.length),
        'cache-control': 'no-store',
        ...headers,
    });
    res.end(payload);
}

function sendError(
    res: http.ServerResponse,
    status: number,
    type: string,
    code: string,
    message: string,
    headers: Record<string, string> = {},
): void {
    sendJson(res, status, errorBody(type, code, message), {
        ...headers,
        ...(status === 413 ? { connection: 'close' } : {}),
    });
}

function sendMethodNotAllowed(res: http.ServerResponse, allow: string): void {
    sendError(res, 405, 'invalid_request_error', 'method_not_allowed', 'Method not allowed', { allow });
}

/** Headers of the reply to the client: what the upstream said about the content, plus ours. */
function clientHeaders(ctx: ProxyContext, info: UpstreamInfo, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    const contentType = info.headers['content-type'];
    headers['content-type'] = contentType ?? (stream ? 'text/event-stream' : 'application/json');
    const cacheControl = info.headers['cache-control'];
    if (cacheControl) headers['cache-control'] = cacheControl;
    else if (stream) headers['cache-control'] = 'no-cache';
    if (stream) headers['x-accel-buffering'] = 'no';
    const retryAfter = info.headers['retry-after'];
    if (retryAfter && info.status >= 400) headers['retry-after'] = headerSafe(retryAfter);

    headers[RESPONSE_HEADERS.connection] = ctx.connection.id;
    headers[RESPONSE_HEADERS.billing] = ctx.plan.billing.outcome;
    if (info.requestId) headers[RESPONSE_HEADERS.requestId] = headerSafe(info.requestId);
    if (ctx.plan.warnings.length > 0) {
        headers[RESPONSE_HEADERS.warnings] = headerSafe(ctx.plan.warnings.map((w) => w.code).join(','));
    }
    for (const [name, value] of Object.entries(ctx.responseHeaders)) headers[name.toLowerCase()] = headerSafe(value);
    return headers;
}

function headerSafe(value: string): string {
    return value.replace(/[^\x20-\x7e]/g, '').slice(0, 500);
}

function firstHeader(headers: Record<string, string>, names: string[]): string | null {
    for (const name of names) {
        const value = headers[name];
        if (value) return value;
    }
    return null;
}

/** Writes a chunk and waits for the socket to drain, so a slow client slows the upstream read instead of buffering. */
function writeChunk(res: http.ServerResponse, chunk: Uint8Array): Promise<void> {
    if (res.destroyed || res.writableEnded) return Promise.resolve();
    if (res.write(chunk)) return Promise.resolve();
    return new Promise((resolve) => {
        const done = (): void => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
        };
        res.once('drain', done);
        res.once('close', done);
    });
}

/**
 * A non-2xx upstream body goes through untouched when it is already an OpenAI-shaped error; anything else (an HTML page
 * from a gateway, plain text) is wrapped into that shape so every client can read it.
 */
function normalizeErrorBody(status: number, body: Buffer, key: SecretValue): Buffer {
    try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) return body;
    } catch {
        // not JSON: wrapped below
    }
    const text = key
        .redact(body.toString('utf8'))
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
    const message = text ? `NanoGPT answered HTTP ${status}: ${text}` : `NanoGPT answered HTTP ${status}`;
    return Buffer.from(JSON.stringify(errorBody('upstream_error', 'upstream_error', message)));
}

function upstreamErrorCode(body: Buffer): string | null {
    try {
        const parsed = JSON.parse(body.toString('utf8')) as { error?: { code?: unknown } };
        const code = parsed?.error?.code;
        if (typeof code === 'string' && code) return code.slice(0, 80);
        if (typeof code === 'number') return String(code);
    } catch {
        // no code
    }
    return null;
}

function describe(error: unknown, key?: SecretValue): string {
    const text = error instanceof Error ? error.message : 'unknown error';
    return key ? key.redact(text) : text;
}
