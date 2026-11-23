// What the account routes share: the NanoGPT key of a request (`?keyId` or the active one) and one careful call to a
// NanoGPT endpoint. A key never appears in an error, a log line or a reply; transport trouble becomes an HttpError in
// the admin API's shape (HTTP status + `{ error: { code, message } }`).
import { SECRET_KEY_NANOGPT } from '../../shared/constants';
import { SecretValue } from '../secret-value';
import type { RouteRequest, ServerDeps } from '../types';
import { HttpError, type RequestUser } from './http';

const CALL_TIMEOUT_MS = 15_000;
const MAX_KEY_ID_LENGTH = 200;

/** The first value of a query parameter as a trimmed string; null when it is absent or empty. */
export function queryText(req: RouteRequest, name: string): string | null {
    const raw = req.query?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `?keyId`: an id of GET /keys, or null for the active key. */
export function keyIdOf(req: RouteRequest): string | null {
    const id = queryText(req, 'keyId');
    if (id !== null && id.length > MAX_KEY_ID_LENGTH) {
        throw new HttpError(400, 'invalid_request', '"keyId" is not a key id');
    }
    return id;
}

/** The NanoGPT key to call with: the chosen one, else the active one (the config file's key when ST's store is missing). */
export function resolveKey(deps: ServerDeps, user: RequestUser, keyId: string | null): SecretValue {
    const { st, config } = deps;
    if (!st.available) {
        if (keyId === null && config.nanogptKey) return new SecretValue(config.nanogptKey);
        throw new HttpError(503, 'secrets_unavailable', 'ST secret store is unavailable');
    }
    if (keyId !== null) {
        const known = st.listSecrets(user.handle, SECRET_KEY_NANOGPT).some((s) => s.id === keyId);
        const value = known ? st.readSecret(user.handle, SECRET_KEY_NANOGPT, keyId) : '';
        if (!value) throw new HttpError(404, 'not_found', 'Unknown key');
        return new SecretValue(value);
    }
    const value = st.readSecret(user.handle, SECRET_KEY_NANOGPT, null);
    if (!value) throw new HttpError(409, 'no_key', 'No NanoGPT key is stored; add one in SillyTavern');
    return new SecretValue(value);
}

export interface NanogptRequest {
    method: 'GET' | 'POST';
    url: string;
    /** `bearer` for most endpoints, `x-api-key` for `check-balance`. */
    auth: 'bearer' | 'x-api-key';
    body?: string;
}

export interface NanogptAnswer {
    status: number;
    /** The parsed body; null when it is not JSON. Every string in it is already free of the key. */
    json: unknown;
}

/** One call to NanoGPT. Resolves for any HTTP status (the caller decides); rejects only for transport failures. */
export async function callNanogpt(deps: ServerDeps, key: SecretValue, request: NanogptRequest): Promise<NanogptAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    timer.unref?.();
    try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (request.auth === 'bearer') headers['authorization'] = `Bearer ${key.reveal()}`;
        else headers['x-api-key'] = key.reveal();
        if (request.body !== undefined) headers['content-type'] = 'application/json';
        const response = await deps.fetch(request.url, {
            method: request.method,
            headers,
            ...(request.body !== undefined ? { body: request.body } : {}),
            signal: controller.signal,
        });
        const text = key.redact(await response.text());
        let json: unknown = null;
        try {
            json = JSON.parse(text);
        } catch {
            // not JSON
        }
        return { status: response.status, json };
    } catch {
        if (controller.signal.aborted) throw new HttpError(504, 'upstream_timeout', 'NanoGPT did not answer in time');
        throw new HttpError(502, 'upstream_unreachable', 'NanoGPT could not be reached');
    } finally {
        clearTimeout(timer);
    }
}

/** The HttpError for an answer the route cannot use. The upstream's own message is not echoed. */
export function rejectedAnswer(status: number): HttpError {
    if (status === 401 || status === 403) {
        return new HttpError(502, 'key_rejected', `NanoGPT rejected the key (HTTP ${status})`);
    }
    if (status === 429) return new HttpError(429, 'rate_limited', 'NanoGPT is rate limiting this key');
    return new HttpError(502, 'upstream_error', `NanoGPT answered HTTP ${status}`);
}

export function isOk(status: number): boolean {
    return status >= 200 && status < 300;
}
