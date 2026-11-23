#!/usr/bin/env node
// Mock NanoGPT: a dependency-free stand-in for https://nano-gpt.com used by the Nanovia tests and the local stand.
//
//   node tools/mock-nanogpt/server.mjs [--port 5300] [--host 127.0.0.1]     (or: npm run mock; env MOCK_PORT)
//
// Routes and magic behaviours: tools/mock-nanogpt/README.md. Data: tools/fixtures (real catalog snapshot + mock/ models).
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as account from './lib/account.mjs';
import { checkInferenceKey, checkMgmtToken, fingerprint, hasScope, maskSecrets, maskedHeaders } from './lib/auth.mjs';
import { loadCatalog } from './lib/catalog.mjs';
import { handleChat } from './lib/chat.mjs';
import { applyCors, header, randomId, readBody, sendError, sendJson, sleep } from './lib/http.mjs';
import { MANAGEMENT_ROUTES, managementError } from './lib/management.mjs';
import { createState } from './lib/state.mjs';

export const DEFAULT_PORT = 5300;
export const DEFAULT_HOST = '127.0.0.1';

const FORCED_ERRORS = {
    401: ['invalid_api_key', 'Invalid API key'],
    402: ['insufficient_balance', 'Insufficient balance'],
    429: ['rate_limit_exceeded', 'Rate limit exceeded'],
    500: ['internal_error', 'Internal server error'],
    502: ['bad_gateway', 'Bad gateway'],
    503: ['service_unavailable', 'Service temporarily unavailable'],
};

/** `GET /api/models/:id/providers` style patterns -> a regexp with named groups. */
const compile = (pattern) => new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);

/** [method, pattern, auth, handler]; auth: 'key' (inference key), 'mgmt' (Management token, scope in the 5th slot) or null. */
const ROUTES = [
    ['GET', '/api/v1/models', null, account.models],
    ['GET', '/api/models/(?<id>.+)/providers', null, account.providers],
    ['POST', '/api/v1/chat/completions', 'key', handleChat],
    ['POST', '/api/check-balance', 'key', account.checkBalance],
    ['GET', '/api/subscription/v1/usage', 'key', account.subscription],
    ['GET', '/api/v1/subscription/usage', 'key', account.subscription],
    ['GET', '/api/v1/usage', 'key', account.usage],
    ['GET', '/api/v1/usage/requests/:id', 'key', account.requestBilling],
    ['POST', '/api/v1/images/generations', 'key', account.images],
    ['POST', '/api/v1/images', 'key', account.images],
    ...MANAGEMENT_ROUTES.map(([method, pattern, scope, handler]) => [method, pattern, 'mgmt', handler, scope]),
].map(([method, pattern, auth, handler, scope]) => ({
    method,
    re: pattern.includes('(?<') ? new RegExp(`^${pattern}$`) : compile(pattern),
    auth,
    handler,
    scope,
}));

/** Parses a request body for the log and the handlers: parsed JSON, else the raw text, else null. */
function parseBody(text) {
    if (!text) return { body: null, invalidJson: false };
    try {
        return { body: JSON.parse(text), invalidJson: false };
    } catch {
        return { body: null, invalidJson: true };
    }
}

/**
 * Creates the mock. `listen(port)` resolves with the real port (pass 0 for a random one); `state` is the live state
 * (balance, subscription counters, request log) and `catalog` the loaded fixtures.
 * @param {{ fixturesDir?: string, log?: (line: string) => void }} [options]
 */
export function createMockServer(options = {}) {
    const state = createState();
    const catalog = loadCatalog(options.fixturesDir);
    const say = options.log ?? (() => {});

    /**
     * The `x-mock-error` header: answer with that error before the route runs. Returns true when it did. The Management
     * API answers in its own envelope, with its own code for a 401.
     */
    function forcedError(req, res, ctx) {
        const wanted = header(req, 'x-mock-error');
        if (!wanted) return false;
        const status = Number.parseInt(wanted, 10);
        const [code, message] = FORCED_ERRORS[status] ?? [];
        if (!code) return false;
        if (ctx.management) {
            const retry = status === 429 || status === 503 ? { 'Retry-After': '1' } : undefined;
            managementError(ctx, status, status === 401 ? 'invalid_management_token' : code, message, undefined, retry);
        } else if (wanted === '502-empty') {
            res.writeHead(502, { 'Content-Length': '0' });
            res.end();
        } else {
            sendError(res, status, code, message, status === 429 ? { headers: { 'Retry-After': '1' } } : {});
        }
        return true;
    }

    /** The helper routes of the mock itself, outside the NanoGPT surface. */
    async function handleMock(req, res, url, text) {
        applyCors(req, res);
        const path = url.pathname;
        if (req.method === 'OPTIONS') return void res.writeHead(204).end();
        if (path === '/__mock/health') return sendJson(res, 200, { ok: true, models: catalog.models.length });
        if (path === '/__mock/requests' && req.method === 'GET') {
            const filter = url.searchParams.get('path');
            const limit = Number(url.searchParams.get('limit')) || 0;
            let rows = filter ? state.log.filter((entry) => entry.path.includes(filter)) : state.log;
            if (limit > 0) rows = rows.slice(-limit);
            return sendJson(res, 200, { requests: rows });
        }
        if (path === '/__mock/reset' && req.method === 'POST') {
            state.reset();
            return sendJson(res, 200, { ok: true });
        }
        if (path === '/__mock/state') {
            if (req.method === 'POST') patchState(parseBody(text).body ?? {});
            const { balanceUsd, nanoBalance, paidSpendAllowed, subscription } = state;
            return sendJson(res, 200, { balanceUsd, nanoBalance, paidSpendAllowed, subscription });
        }
        return sendError(res, 404, 'not_found', 'Unknown mock route');
    }

    /** `POST /__mock/state`: balanceUsd, paidSpendAllowed and the subscription counters can be set from a test. */
    function patchState(patch) {
        for (const field of ['balanceUsd', 'nanoBalance'])
            if (typeof patch[field] === 'number') state[field] = patch[field];
        if (typeof patch.paidSpendAllowed === 'boolean') state.paidSpendAllowed = patch.paidSpendAllowed;
        for (const [field, value] of Object.entries(patch.subscription ?? {})) {
            if (
                field in state.subscription &&
                (typeof value === 'number' || typeof value === 'boolean' || value === null)
            )
                state.subscription[field] = value;
        }
    }

    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://mock');
        const text = ['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') ? '' : await readBody(req);
        if (url.pathname.startsWith('/__mock/')) return handleMock(req, res, url, text);

        const management = url.pathname.startsWith('/api/management/');
        const requestId = randomId('req_');
        res.setHeader('X-Request-ID', requestId);
        if (!management) applyCors(req, res);

        const parsed = parseBody(text);
        const entry = {
            n: ++state.counter,
            at: new Date().toISOString(),
            method: req.method,
            path: url.pathname + url.search,
            headers: maskedHeaders(req.headers),
            body: parsed.invalidJson
                ? maskSecrets(text)
                : parsed.body === null
                  ? null
                  : JSON.parse(maskSecrets(JSON.stringify(parsed.body))),
            status: 0,
        };
        state.log.push(entry);
        // The status is logged when the head is written (a test reading the log right after the reply must see it).
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, ...rest) => {
            entry.status = status;
            return writeHead(status, ...rest);
        };
        res.on('close', () => {
            if (!res.writableFinished) entry.aborted = true;
        });
        say(`${req.method} ${entry.path}`);

        if (req.method === 'OPTIONS') return void res.writeHead(204).end();
        const delay = Math.min(Number(header(req, 'x-mock-delay-ms')) || 0, 10_000);
        if (delay) await sleep(delay);

        const ctx = {
            req,
            res,
            url,
            body: parsed.body,
            invalidJson: parsed.invalidJson,
            requestId,
            state,
            catalog,
            management,
            params: {},
        };
        const route = ROUTES.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!route) {
            const message = `No route ${req.method} ${url.pathname}`;
            return management
                ? managementError(ctx, 404, 'not_found', message)
                : sendError(res, 404, 'not_found', message);
        }
        ctx.params = { ...route.re.exec(url.pathname)?.groups };

        if (route.auth === 'key') {
            const checked = checkInferenceKey(req);
            if (!checked.key)
                return sendError(res, checked.status, checked.code, checked.message, { type: checked.type });
            ctx.keyId = fingerprint(checked.key);
        } else if (route.auth === 'mgmt') {
            const checked = checkMgmtToken(req);
            if (!checked.token) return managementError(ctx, checked.status, checked.code, checked.message);
            if (!hasScope(checked.scopes, route.scope)) {
                return managementError(ctx, 403, 'insufficient_scope', `This token lacks the ${route.scope} scope.`);
            }
        }
        if (forcedError(req, res, ctx)) return undefined;
        return route.handler(ctx);
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            say(`error: ${error?.stack ?? error}`);
            if (res.headersSent) res.destroy();
            else sendError(res, 500, 'internal_error', String(error?.message ?? error));
        });
    });

    return {
        server,
        state,
        catalog,
        listen(port = DEFAULT_PORT, host = DEFAULT_HOST) {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => resolve(server.address().port));
            });
        },
        close() {
            server.closeAllConnections?.();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

function argValue(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
    const args = process.argv.slice(2);
    const port = Number(argValue(args, '--port') ?? process.env.MOCK_PORT ?? DEFAULT_PORT);
    const host = argValue(args, '--host') ?? process.env.MOCK_HOST ?? DEFAULT_HOST;
    const mock = createMockServer({ log: args.includes('--quiet') ? undefined : (line) => console.log(line) });
    const actual = await mock.listen(port, host);
    console.log(
        `mock-nanogpt: http://${host}:${actual}/api/v1  (${mock.catalog.models.length} models, request log at /__mock/requests)`,
    );
    const stop = () => void mock.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error) => {
        console.error(`mock-nanogpt: ${error.message}`);
        process.exit(1);
    });
}
