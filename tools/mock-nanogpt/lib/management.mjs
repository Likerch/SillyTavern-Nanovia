// The Management API (`/api/management/v1/*`): API keys, model presets, subscription usage.
// Errors follow its own envelope `{ error: { code, message, request_id, details? } }`.
import { randomUUID } from 'node:crypto';
import { header, sendJson } from './http.mjs';
import { subscriptionUsage } from './state.mjs';

const KEY_LIMITS = [
    'daily_rpd_limit',
    'daily_input_token_limit',
    'daily_usd_limit',
    'weekly_usd_limit',
    'monthly_usd_limit',
    'weekly_request_limit',
    'monthly_request_limit',
    'weekly_input_token_limit',
    'monthly_input_token_limit',
    'daily_subscription_input_token_limit',
    'weekly_subscription_input_token_limit',
    'monthly_subscription_input_token_limit',
];
const KEY_WRITABLE = ['name', 'expires_at', 'zdr_policy', ...KEY_LIMITS];
const PRESET_FIELDS = [
    'model',
    'system_prompt',
    'max_tokens',
    'top_k',
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'min_p',
    'top_a',
    'response_format_type',
    'reasoning_effort',
    'reasoning_summary',
    'verbosity',
    'provider_routing_preference',
    'service_tier',
    'structured_outputs',
    'thinking',
    'prompt_caching',
];

function fail(ctx, status, code, message, details) {
    sendJson(ctx.res, status, { error: { code, message, request_id: ctx.requestId, ...(details ? { details } : {}) } });
}

/** Problems of a write body: unknown fields and badly typed limits. */
function keyProblems(body, allowed) {
    const details = [];
    for (const field of Object.keys(body))
        if (!allowed.includes(field)) details.push({ field, issue: 'unknown field' });
    for (const field of KEY_LIMITS) {
        const value = body[field];
        if (value === undefined || value === null) continue;
        const ok = typeof value === 'number' && value >= 0 && (field.endsWith('_usd_limit') || Number.isInteger(value));
        if (!ok) details.push({ field, issue: 'must be null or a non-negative number' });
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120)) {
        details.push({ field: 'name', issue: 'must be a non-empty string of at most 120 characters' });
    }
    return details;
}

function keyDoc(record) {
    const expired = record.expires_at && Date.parse(record.expires_at) <= Date.now();
    return { ...record, status: expired ? 'expired' : 'active' };
}

function newKey(body, id) {
    const record = {
        id: String(id),
        object: 'api_key',
        name: body.name.trim(),
        status: 'active',
        created_at: new Date().toISOString(),
    };
    record.expires_at = body.expires_at ?? null;
    for (const field of KEY_LIMITS) record[field] = body[field] ?? null;
    record.zdr_policy = body.zdr_policy ?? 'unset';
    return record;
}

const listKeys = (ctx) => sendJson(ctx.res, 200, { data: [...ctx.state.keys.values()].map(keyDoc) });

function createKey(ctx) {
    const { state, body } = ctx;
    const idempotencyKey = header(ctx.req, 'idempotency-key');
    if (!idempotencyKey)
        return fail(ctx, 400, 'idempotency_key_required', 'Creating an API key requires an Idempotency-Key header.');
    const fingerprint = JSON.stringify(body);
    const earlier = state.idempotency.get(idempotencyKey);
    if (earlier) {
        if (earlier.fingerprint !== fingerprint)
            return fail(ctx, 409, 'idempotency_key_reused', 'This Idempotency-Key was used with a different body.');
        return sendJson(ctx.res, 201, { ...keyDoc(state.keys.get(earlier.id)), key: earlier.secret });
    }
    const details =
        !body || typeof body.name !== 'string'
            ? [{ field: 'name', issue: 'required' }]
            : keyProblems(body, KEY_WRITABLE);
    if (details.length) return fail(ctx, 400, 'invalid_request', 'The request body is not valid.', details);
    const record = newKey(body, state.nextKeyId++);
    const secret = `sk-nano-${randomUUID()}`;
    state.keys.set(record.id, record);
    state.idempotency.set(idempotencyKey, { id: record.id, secret, fingerprint });
    return sendJson(ctx.res, 201, { ...keyDoc(record), key: secret });
}

function getKey(ctx) {
    const record = ctx.state.keys.get(ctx.params.id);
    if (!record) return fail(ctx, 404, 'not_found', 'No such API key.');
    return sendJson(ctx.res, 200, keyDoc(record));
}

function patchKey(ctx) {
    const record = ctx.state.keys.get(ctx.params.id);
    if (!record) return fail(ctx, 404, 'not_found', 'No such API key.');
    const body = ctx.body;
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0)
        return fail(ctx, 400, 'invalid_request', 'Send at least one field.');
    const details = keyProblems(
        body,
        KEY_WRITABLE.filter((f) => f !== 'zdr_policy'),
    );
    if (details.length) return fail(ctx, 400, 'invalid_request', 'The request body is not valid.', details);
    Object.assign(record, body, body.name ? { name: body.name.trim() } : {});
    return sendJson(ctx.res, 200, keyDoc(record));
}

function deleteKey(ctx) {
    if (!ctx.state.keys.delete(ctx.params.id)) return fail(ctx, 404, 'not_found', 'No such API key.');
    ctx.res.writeHead(204);
    return ctx.res.end();
}

function presetName(ctx) {
    const name = decodeURIComponent(ctx.params.name);
    if (/^[A-Za-z0-9._-]{1,64}$/.test(name)) return name;
    fail(ctx, 400, 'invalid_name', 'A preset name is 1-64 letters, digits, dots, dashes or underscores.');
    return null;
}

const listPresets = (ctx) => sendJson(ctx.res, 200, { data: [...ctx.state.presets.values()] });

function getPreset(ctx) {
    const name = presetName(ctx);
    if (!name) return undefined;
    const preset = ctx.state.presets.get(name);
    return preset ? sendJson(ctx.res, 200, preset) : fail(ctx, 404, 'not_found', 'No such model preset.');
}

function putPreset(ctx) {
    const name = presetName(ctx);
    if (!name) return undefined;
    const body = ctx.body;
    const details = [];
    if (!body || typeof body !== 'object') details.push({ field: 'body', issue: 'must be a JSON object' });
    else {
        if (typeof body.model !== 'string' || !body.model) details.push({ field: 'model', issue: 'required' });
        for (const field of Object.keys(body))
            if (!PRESET_FIELDS.includes(field)) details.push({ field, issue: 'unknown field' });
    }
    if (details.length) return fail(ctx, 400, 'invalid_request', 'The request body is not valid.', details);
    const now = new Date().toISOString();
    const earlier = ctx.state.presets.get(name);
    const preset = {
        name,
        ...Object.fromEntries(PRESET_FIELDS.map((f) => [f, null])),
        ...body,
        created_at: earlier?.created_at ?? now,
        updated_at: now,
    };
    ctx.state.presets.set(name, preset);
    return sendJson(ctx.res, 200, preset);
}

function deletePreset(ctx) {
    const name = presetName(ctx);
    if (!name) return undefined;
    if (!ctx.state.presets.delete(name)) return fail(ctx, 404, 'not_found', 'No such model preset.');
    ctx.res.writeHead(204);
    return ctx.res.end();
}

const BASE = '/api/management/v1';

/** The route table: [method, path pattern, required scope, handler]. */
export const MANAGEMENT_ROUTES = [
    [
        'GET',
        `${BASE}/subscription/usage`,
        'usage:read',
        (ctx) => sendJson(ctx.res, 200, subscriptionUsage(ctx.state, { inference: false })),
    ],
    ['GET', `${BASE}/api-keys`, 'api_keys:read', listKeys],
    ['POST', `${BASE}/api-keys`, 'api_keys:write', createKey],
    ['GET', `${BASE}/api-keys/:id`, 'api_keys:read', getKey],
    ['PATCH', `${BASE}/api-keys/:id`, 'api_keys:write', patchKey],
    ['DELETE', `${BASE}/api-keys/:id`, 'api_keys:write', deleteKey],
    ['GET', `${BASE}/model-presets`, 'model_presets:read', listPresets],
    ['GET', `${BASE}/model-presets/:name`, 'model_presets:read', getPreset],
    ['PUT', `${BASE}/model-presets/:name`, 'model_presets:write', putPreset],
    ['DELETE', `${BASE}/model-presets/:name`, 'model_presets:write', deletePreset],
];

export { fail as managementError };
