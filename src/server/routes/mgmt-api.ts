// What the Management routes share: one careful call to NanoGPT's Management API with a user's token, the check that
// proves a token, and the translation of NanoGPT's answers into the admin API's errors (contracts-mgmt.ts). The token
// never appears in an error, a log line or a reply: it goes on the wire in the Authorization header only, and every text
// that came back from NanoGPT is scrubbed of it first.
import { isRecord } from '../../domain/usage';
import type { MgmtErrorCode, MgmtScope, MgmtStatus } from '../../shared/contracts-mgmt';
import { SecretValue } from '../secret-value';
import type { MgmtCheck, MgmtRecord } from '../store';
import type { ServerDeps } from '../types';
import { HttpError, type RequestUser } from './http';
import { isOk } from './nanogpt';

const CALL_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LENGTH = 200;

export interface MgmtRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Below the Management base (`/api-keys/12`). */
    path: string;
    body?: unknown;
    /** Required by `POST /api-keys`: NanoGPT replays an identical create instead of making a second key. */
    idempotencyKey?: string;
}

export interface MgmtAnswer {
    status: number;
    /** The parsed body; null when there is none (204) or it is not JSON. Every string in it is already free of the token. */
    json: unknown;
}

/** One call to the Management API at `config.mgmtBase`, and nowhere else. Resolves for any HTTP status; rejects with an HttpError for transport failures. */
export async function callMgmt(deps: ServerDeps, token: SecretValue, request: MgmtRequest): Promise<MgmtAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    timer.unref?.();
    try {
        const headers: Record<string, string> = {
            accept: 'application/json',
            authorization: `Bearer ${token.reveal()}`,
        };
        if (request.body !== undefined) headers['content-type'] = 'application/json';
        if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
        const response = await deps.fetch(`${deps.config.mgmtBase}${request.path}`, {
            method: request.method,
            headers,
            ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
            signal: controller.signal,
        });
        const text = token.redact(await response.text());
        let json: unknown = null;
        try {
            json = JSON.parse(text);
        } catch {
            // an empty body (204) or not JSON
        }
        return { status: response.status, json };
    } catch {
        if (controller.signal.aborted) throw new HttpError(504, 'upstream_timeout', 'NanoGPT did not answer in time');
        throw new HttpError(502, 'upstream_unreachable', 'NanoGPT could not be reached');
    } finally {
        clearTimeout(timer);
    }
}

/** `{ error: { code, message, request_id, details } }` of the Management API, read leniently. */
function errorBody(json: unknown): { code: string | null; detail: string } {
    const error = isRecord(json) && isRecord(json['error']) ? json['error'] : {};
    const code = typeof error['code'] === 'string' ? error['code'] : null;
    const parts: string[] = [];
    if (Array.isArray(error['details'])) {
        for (const item of error['details']) {
            if (isRecord(item) && typeof item['field'] === 'string' && typeof item['issue'] === 'string') {
                parts.push(`${item['field']}: ${item['issue']}`);
            }
        }
    }
    // eslint-disable-next-line no-control-regex
    const detail = parts.join('; ').replace(/[\u0000-\u001f\u007f]/g, ' ');
    return { code, detail: detail.slice(0, MAX_DETAIL_LENGTH) };
}

/**
 * The HttpError for an answer a route cannot use. NanoGPT's own text is not echoed, except the `field: issue` pairs of a
 * 400 and the code of a 409. 401 and 403 never go back as such: ST's front end reads them as "log in again".
 */
export function mgmtFailure(answer: MgmtAnswer, needed: MgmtScope | null): HttpError {
    const { code, detail } = errorBody(answer.json);
    switch (answer.status) {
        case 400:
            return new HttpError(400, 'invalid_request', `NanoGPT refused the request${detail ? `: ${detail}` : ''}`);
        case 401:
            return new HttpError(
                502,
                'mgmt_token_invalid',
                'NanoGPT rejected the Management token (revoked, expired or wrong)',
            );
        case 403:
            if (code === 'insufficient_scope') {
                return new HttpError(
                    409,
                    'mgmt_scope_missing',
                    `The Management token lacks the ${needed ?? 'required'} scope`,
                );
            }
            return new HttpError(502, 'upstream_error', 'NanoGPT answered HTTP 403');
        case 404:
            return new HttpError(404, 'not_found', 'NanoGPT has no such key or preset');
        case 409:
            return new HttpError(
                409,
                code !== null && /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : 'conflict',
                'NanoGPT refused the change as a conflict',
            );
        case 413:
            return new HttpError(413, 'payload_too_large', 'The request body is too large for NanoGPT');
        case 429:
            return new HttpError(429, 'rate_limited', 'NanoGPT is rate limiting this token; try again later');
        default:
            return new HttpError(502, 'upstream_error', `NanoGPT answered HTTP ${answer.status}`);
    }
}

function isScopeRefusal(answer: MgmtAnswer): boolean {
    return answer.status === 403 && errorBody(answer.json).code === 'insufficient_scope';
}

/**
 * Proves a token with one cheap read call (`GET /api-keys`). NanoGPT recognising the token is what counts: a 403
 * insufficient_scope also means "known token, lacks api_keys:read" (a usage-only token, say), so it is valid. Never
 * throws; trouble reaching NanoGPT leaves `valid: null`.
 */
export async function probeToken(deps: ServerDeps, token: SecretValue): Promise<MgmtCheck> {
    const checkedAt = deps.now();
    try {
        const answer = await callMgmt(deps, token, { method: 'GET', path: '/api-keys' });
        if (isOk(answer.status) || isScopeRefusal(answer)) return { valid: true, checkedAt, error: null };
        if (answer.status === 401) return { valid: false, checkedAt, error: 'mgmt_token_invalid' };
        return { valid: null, checkedAt, error: answer.status === 429 ? 'rate_limited' : 'upstream_error' };
    } catch (error) {
        const code: MgmtErrorCode =
            error instanceof HttpError && error.code === 'upstream_timeout'
                ? 'upstream_timeout'
                : 'upstream_unreachable';
        return { valid: null, checkedAt, error: code };
    }
}

export function statusOf(record: MgmtRecord | null): MgmtStatus {
    if (!record) return { present: false, valid: null, checkedAt: null, error: null };
    return { present: true, ...record.check };
}

/** The HttpError a failed check turns into when the token is not to be stored. */
export function refusedCheck(check: MgmtCheck): HttpError {
    if (check.valid === false) {
        return new HttpError(502, 'mgmt_token_invalid', 'NanoGPT rejected the Management token; nothing was stored');
    }
    const note = '; nothing was stored (store it anyway with force=1)';
    if (check.error === 'upstream_timeout') {
        return new HttpError(504, 'upstream_timeout', `NanoGPT did not answer in time${note}`);
    }
    if (check.error === 'rate_limited') {
        return new HttpError(429, 'rate_limited', `NanoGPT is rate limiting this token${note}`);
    }
    const code = check.error === 'upstream_error' ? 'upstream_error' : 'upstream_unreachable';
    return new HttpError(502, code, `NanoGPT could not confirm the token${note}`);
}

/** Writes a check into the stored record, if that token is still the stored one (it may be replaced while a call runs). */
export function storeCheck(deps: ServerDeps, user: RequestUser, token: string, check: MgmtCheck): void {
    const current = deps.store.mgmt.read(user.root);
    if (current && current.token === token) deps.store.mgmt.write(user.root, { token, check });
}

/** The outcome of a call that carried the stored token: written only when the state changed (a read costs no disk write). */
function rememberCheck(deps: ServerDeps, user: RequestUser, token: string, check: MgmtCheck): void {
    const current = deps.store.mgmt.read(user.root);
    if (current && current.check.valid === check.valid && current.check.error === check.error) return;
    storeCheck(deps, user, token, check);
}

export interface StoredCallOptions {
    /** Statuses besides 2xx that are answers, not failures (a 404 that means "name is free"). */
    allow?: readonly number[];
}

/**
 * A call with the user's stored token. No token: 409 mgmt_token_missing. A 401 turns the stored status to invalid and
 * answers 502 mgmt_token_invalid; a success (or a scope refusal) turns it to valid. Any other status outside 2xx and
 * `options.allow` becomes the HttpError of mgmtFailure. `needed` names the scope for the error text.
 */
export async function callStored(
    deps: ServerDeps,
    user: RequestUser,
    needed: MgmtScope,
    request: MgmtRequest,
    options: StoredCallOptions = {},
): Promise<MgmtAnswer> {
    const record = deps.store.mgmt.read(user.root);
    if (!record) throw new HttpError(409, 'mgmt_token_missing', 'No Management token is stored; add one first');
    const answer = await callMgmt(deps, new SecretValue(record.token), request);
    if (answer.status === 401) {
        rememberCheck(deps, user, record.token, { valid: false, checkedAt: deps.now(), error: 'mgmt_token_invalid' });
    } else if (isOk(answer.status) || isScopeRefusal(answer)) {
        rememberCheck(deps, user, record.token, { valid: true, checkedAt: deps.now(), error: null });
    }
    if (isOk(answer.status) || options.allow?.includes(answer.status)) return answer;
    throw mgmtFailure(answer, needed);
}
