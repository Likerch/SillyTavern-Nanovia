// Credentials: NanoGPT inference keys (`sk-nano-…`), Management tokens (`sk-nano-mgmt-…`), and masking for the log.
import { createHash } from 'node:crypto';
import { header } from './http.mjs';

const INFERENCE_KEY = /^sk-nano-[A-Za-z0-9_-]{8,}$/;
const MGMT_PREFIX = 'sk-nano-mgmt-';
const SECRET_IN_TEXT = /(sk-nano-(?:mgmt-)?)([A-Za-z0-9_-]+)/g;
const ALL_SCOPES = ['usage:read', 'api_keys:read', 'api_keys:write', 'model_presets:read', 'model_presets:write'];

/** The credential of a request: `Authorization: Bearer …` or `x-api-key`. */
export function credentialOf(req) {
    const authorization = header(req, 'authorization');
    const bearer = authorization && /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return (bearer ? bearer[1].trim() : null) ?? header(req, 'x-api-key')?.trim() ?? null;
}

/** Checks the inference key of a request. Returns `{ key }` or `{ status, code, message, type }`. */
export function checkInferenceKey(req) {
    const key = credentialOf(req);
    if (!key) {
        return {
            status: 401,
            code: 'missing_api_key',
            type: 'missing_api_key',
            message:
                "You didn't provide an API key. Provide your API key in an Authorization header using Bearer auth.",
        };
    }
    if (key.startsWith(MGMT_PREFIX)) {
        return {
            status: 401,
            code: 'invalid_api_key',
            message: 'Management tokens cannot authenticate inference endpoints.',
        };
    }
    if (!INFERENCE_KEY.test(key)) {
        return {
            status: 401,
            code: 'malformed_api_key',
            message: 'The API key is malformed. Keys look like sk-nano-<id>.',
        };
    }
    return { key };
}

/**
 * Checks a Management token. The scopes come from the token itself so tests can pick them:
 * `sk-nano-mgmt-usage…` reads usage only, `…keysread…` reads keys only, `…presetsread…` reads presets only,
 * `…expired…` / `…revoked…` are rejected, anything else holds every scope.
 */
export function checkMgmtToken(req) {
    const authorization = header(req, 'authorization');
    const bearer = authorization && /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = bearer?.[1].trim() ?? '';
    const rest = token.slice(MGMT_PREFIX.length);
    if (!token.startsWith(MGMT_PREFIX) || rest.length < 4 || /^(expired|revoked)/.test(rest)) {
        return {
            status: 401,
            code: 'invalid_management_token',
            message: 'Missing, invalid, expired or revoked management token.',
        };
    }
    let scopes = ALL_SCOPES;
    if (rest.startsWith('usage')) scopes = ['usage:read'];
    else if (rest.startsWith('keysread')) scopes = ['api_keys:read'];
    else if (rest.startsWith('presetsread')) scopes = ['model_presets:read'];
    return { token, scopes };
}

/** `write` scopes include their `read`. */
export function hasScope(scopes, needed) {
    return scopes.includes(needed) || (needed.endsWith(':read') && scopes.includes(needed.replace(':read', ':write')));
}

/** A short stable id of a secret, so records can be told apart without keeping the secret. */
export const fingerprint = (secret) => createHash('sha256').update(secret).digest('hex').slice(0, 12);

/** `sk-nano-1234567890` -> `sk-nano-…7890`; the key never appears in full in the request log. */
export function maskSecrets(text) {
    return String(text).replace(
        SECRET_IN_TEXT,
        (_match, prefix, rest) => `${prefix}…${rest.length > 8 ? rest.slice(-4) : ''}`,
    );
}

const SECRET_HEADERS = new Set(['authorization', 'x-api-key', 'proxy-authorization', 'cookie']);

/** Request headers as the log shows them: lower-case names, secrets masked. */
export function maskedHeaders(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        const text = Array.isArray(value) ? value.join(', ') : String(value);
        if (!SECRET_HEADERS.has(name)) out[name] = text;
        else out[name] = name !== 'cookie' && text.includes('sk-nano-') ? maskSecrets(text) : '***';
    }
    return out;
}
