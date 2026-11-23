// The Management API (`/api/management/v1/*`): API keys, model presets, subscription usage. Follows the published
// contract (https://nano-gpt.com/management-openapi.json, version 2026-09-09-beta): the same fields, ranges and
// status codes. Errors use its envelope `{ error: { code, message, request_id, details? } }`.
// Error codes the docs name: invalid_management_token, insufficient_scope, model_preset_not_found, invalid_preset_name,
// invalid_preset, preset_name_conflict, preset_limit_reached, service_unavailable. The rest (idempotency_key_required,
// idempotency_key_reused, invalid_request, not_found, payload_too_large) are this mock's own guesses: the docs leave the
// code of those errors open.
import { randomUUID } from 'node:crypto';
import { header, sendJson } from './http.mjs';
import { PRESET_FIELD_NAMES } from './management-seed.mjs';
import { subscriptionUsage } from './state.mjs';

const INT_MAX = 2_147_483_647;
/** Limit field -> [largest value, whole numbers only]. The smallest is 0; USD steps are 0.0001. */
const KEY_LIMITS = {
    daily_rpd_limit: [10_000_000, true],
    daily_input_token_limit: [INT_MAX, true],
    daily_usd_limit: [100_000, false],
    weekly_usd_limit: [100_000, false],
    monthly_usd_limit: [100_000, false],
    weekly_request_limit: [INT_MAX, true],
    monthly_request_limit: [INT_MAX, true],
    weekly_input_token_limit: [INT_MAX, true],
    monthly_input_token_limit: [INT_MAX, true],
    daily_subscription_input_token_limit: [INT_MAX, true],
    weekly_subscription_input_token_limit: [INT_MAX, true],
    monthly_subscription_input_token_limit: [INT_MAX, true],
};
const KEY_WRITABLE = ['name', 'expires_at', 'zdr_policy', ...Object.keys(KEY_LIMITS)];
const PRESET_BODY_LIMIT = 16 * 1024;
const PRESET_COUNT_LIMIT = 100;
const PRESET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

/** [min, max, whole numbers only] of the numeric preset fields. */
const PRESET_NUMBERS = {
    max_tokens: [1, 1_000_000, true],
    top_k: [0, 1_000_000, true],
    temperature: [0, 2, false],
    top_p: [0, 1, false],
    min_p: [0, 1, false],
    top_a: [0, 1, false],
    frequency_penalty: [-2, 2, false],
    presence_penalty: [-2, 2, false],
    repetition_penalty: [-2, 2, false],
};
const PRESET_ENUMS = {
    response_format_type: ['text', 'json_object'],
    reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    reasoning_summary: ['auto', 'concise', 'detailed'],
    verbosity: ['low', 'medium', 'high'],
    provider_routing_preference: ['auto', 'speed', 'throughput', 'latency', 'price', 'caching'],
    service_tier: ['auto', 'default', 'flex', 'priority', 'ultrafast'],
};

function fail(ctx, status, code, message, details, headers) {
    sendJson(
        ctx.res,
        status,
        { error: { code, message, request_id: ctx.requestId, ...(details ? { details } : {}) } },
        headers,
    );
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Problems of a key write body: unknown fields and badly typed or out-of-range values. */
function keyProblems(body, allowed, zdrChoices) {
    const details = [];
    for (const field of Object.keys(body))
        if (!allowed.includes(field)) details.push({ field, issue: 'unknown field' });
    for (const [field, [max, whole]] of Object.entries(KEY_LIMITS)) {
        const value = body[field];
        if (value === undefined || value === null) continue;
        const stepOk = whole || Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6;
        const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max && stepOk;
        if (!ok || (whole && !Number.isInteger(value))) {
            details.push({ field, issue: `must be null or ${whole ? 'a whole' : 'a'} number from 0 to ${max}` });
        }
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120)) {
        details.push({ field: 'name', issue: 'must be a non-empty string of at most 120 characters' });
    }
    if (body.expires_at !== undefined && body.expires_at !== null && !isDate(body.expires_at)) {
        details.push({ field: 'expires_at', issue: 'must be null or a date-time' });
    }
    if (body.zdr_policy !== undefined && !zdrChoices.includes(body.zdr_policy)) {
        details.push({ field: 'zdr_policy', issue: `must be one of: ${zdrChoices.join(', ')}` });
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
        expires_at: body.expires_at ?? null,
    };
    for (const field of Object.keys(KEY_LIMITS)) record[field] = body[field] ?? null;
    record.zdr_policy = body.zdr_policy ?? 'off';
    return record;
}

/** The key behind `:id`, or null after answering 404 (unknown, malformed and revoked ids all look alike). */
function keyOf(ctx) {
    const record = /^[1-9][0-9]*$/.test(ctx.params.id) ? ctx.state.keys.get(ctx.params.id) : undefined;
    if (!record) fail(ctx, 404, 'not_found', 'No such API key.');
    return record ?? null;
}

const listKeys = (ctx) => sendJson(ctx.res, 200, { data: [...ctx.state.keys.values()].map(keyDoc) });

function createKey(ctx) {
    const { state, body } = ctx;
    const idempotencyKey = header(ctx.req, 'idempotency-key');
    if (!idempotencyKey)
        return fail(ctx, 400, 'idempotency_key_required', 'Creating an API key requires an Idempotency-Key header.');
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        return fail(ctx, 400, 'invalid_request', 'The request is not valid.', [
            { field: 'Idempotency-Key', issue: 'must be 8 to 200 characters' },
        ]);
    }
    const fingerprint = JSON.stringify(body);
    const earlier = state.idempotency.get(idempotencyKey);
    if (earlier) {
        if (earlier.fingerprint !== fingerprint)
            return fail(ctx, 409, 'idempotency_key_reused', 'This Idempotency-Key was used with a different body.');
        return sendJson(
            ctx.res,
            201,
            { ...keyDoc(state.keys.get(earlier.id)), key: earlier.secret },
            { 'Idempotent-Replayed': 'true' },
        );
    }
    const details = !isObject(body)
        ? [{ field: 'body', issue: 'must be a JSON object' }]
        : [
              ...(typeof body.name !== 'string' ? [{ field: 'name', issue: 'required' }] : []),
              ...keyProblems(body, KEY_WRITABLE, ['zdr', 'off']),
          ];
    if (details.length) return fail(ctx, 400, 'invalid_request', 'The request body is not valid.', details);
    const record = newKey(body, state.nextKeyId++);
    const secret = `sk-nano-${randomUUID()}`;
    state.keys.set(record.id, record);
    state.idempotency.set(idempotencyKey, { id: record.id, secret, fingerprint });
    return sendJson(ctx.res, 201, { ...keyDoc(record), key: secret });
}

function getKey(ctx) {
    const record = keyOf(ctx);
    return record ? sendJson(ctx.res, 200, keyDoc(record)) : undefined;
}

function patchKey(ctx) {
    const record = keyOf(ctx);
    if (!record) return undefined;
    const body = ctx.body;
    if (!isObject(body) || Object.keys(body).length === 0)
        return fail(ctx, 400, 'invalid_request', 'Send at least one field.', [
            { field: 'body', issue: 'minProperties 1' },
        ]);
    const details = keyProblems(body, KEY_WRITABLE, ['zdr', 'off', 'unset']);
    if (body.name === null) details.push({ field: 'name', issue: 'is not nullable' });
    if (details.length) return fail(ctx, 400, 'invalid_request', 'The request body is not valid.', details);
    Object.assign(record, body, body.name ? { name: body.name.trim() } : {});
    return sendJson(ctx.res, 200, keyDoc(record));
}

function deleteKey(ctx) {
    const record = keyOf(ctx);
    if (!record) return undefined;
    ctx.state.keys.delete(record.id);
    ctx.res.writeHead(204);
    return ctx.res.end();
}

/** The lower-cased preset name behind `:name`, or null after answering 400. */
function presetName(ctx) {
    let name = '';
    try {
        name = decodeURIComponent(ctx.params.name);
    } catch {
        // falls through to the pattern check
    }
    if (PRESET_NAME.test(name)) return name.toLowerCase();
    fail(
        ctx,
        400,
        'invalid_preset_name',
        'A preset name is 1-80 letters, digits, dashes or underscores, starting with a letter or digit.',
    );
    return null;
}

/** Problems of a preset body: unknown fields, ranges, enums, and the rules that cross fields. */
function presetProblems(body) {
    const details = [];
    if (!isObject(body)) return [{ field: 'body', issue: 'must be a JSON object' }];
    for (const field of Object.keys(body))
        if (!PRESET_FIELD_NAMES.includes(field)) details.push({ field, issue: 'unknown field' });
    if (typeof body.model !== 'string' || !body.model || body.model.length > 256) {
        details.push({ field: 'model', issue: 'required, 1 to 256 characters' });
    }
    const set = (field) => body[field] !== undefined && body[field] !== null;
    if (set('system_prompt') && (typeof body.system_prompt !== 'string' || body.system_prompt.length > 12_000)) {
        details.push({ field: 'system_prompt', issue: 'must be a string of at most 12000 characters' });
    }
    for (const [field, [min, max, whole]] of Object.entries(PRESET_NUMBERS)) {
        const value = body[field];
        if (!set(field)) continue;
        if (typeof value !== 'number' || !(value >= min && value <= max) || (whole && !Number.isInteger(value))) {
            details.push({ field, issue: `must be a ${whole ? 'whole ' : ''}number from ${min} to ${max}` });
        }
    }
    for (const [field, choices] of Object.entries(PRESET_ENUMS)) {
        if (set(field) && !choices.includes(body[field]))
            details.push({ field, issue: `must be one of: ${choices.join(', ')}` });
    }
    if (set('structured_outputs')) {
        if (typeof body.structured_outputs !== 'boolean')
            details.push({ field: 'structured_outputs', issue: 'must be a boolean' });
        else if (body.structured_outputs && body.response_format_type !== 'json_object')
            details.push({ field: 'structured_outputs', issue: 'requires response_format_type json_object' });
    }
    if (set('thinking')) {
        const t = body.thinking;
        const budget = isObject(t) ? t.budget_tokens : undefined;
        const ok =
            typeof t === 'boolean' ||
            (isObject(t) &&
                t.type === 'enabled' &&
                (budget === undefined || (Number.isInteger(budget) && budget >= 1 && budget <= 1_000_000)));
        if (!ok) details.push({ field: 'thinking', issue: 'must be a boolean or { type: "enabled", budget_tokens }' });
    }
    if (set('prompt_caching')) {
        const c = body.prompt_caching;
        const ok =
            typeof c === 'boolean' ||
            (isObject(c) && typeof c.enabled === 'boolean' && (c.ttl === undefined || ['5m', '1h'].includes(c.ttl)));
        if (!ok) details.push({ field: 'prompt_caching', issue: 'must be a boolean or { enabled, ttl: "5m"|"1h" }' });
    }
    const ranked = ['speed', 'throughput', 'latency', 'price'].includes(body.provider_routing_preference);
    if (['flex', 'priority'].includes(body.service_tier) && ranked) {
        details.push({ field: 'service_tier', issue: 'flex and priority cannot go with ranked provider routing' });
    }
    return details;
}

const listPresets = (ctx) => sendJson(ctx.res, 200, { data: [...ctx.state.presets.values()] });

function getPreset(ctx) {
    const name = presetName(ctx);
    if (!name) return undefined;
    const preset = ctx.state.presets.get(name);
    return preset ? sendJson(ctx.res, 200, preset) : fail(ctx, 404, 'model_preset_not_found', 'No such model preset.');
}

function putPreset(ctx) {
    const name = presetName(ctx);
    if (!name) return undefined;
    const body = ctx.body;
    if (Buffer.byteLength(JSON.stringify(body ?? null)) > PRESET_BODY_LIMIT)
        return fail(ctx, 413, 'payload_too_large', 'The request body is limited to 16 KiB.');
    const details = presetProblems(body);
    if (details.length) return fail(ctx, 400, 'invalid_preset', 'The preset is not valid.', details);
    const earlier = ctx.state.presets.get(name);
    if (!earlier && ctx.state.presets.size >= PRESET_COUNT_LIMIT)
        return fail(ctx, 409, 'preset_limit_reached', 'The account already has 100 API-managed presets.');
    const now = new Date().toISOString();
    const preset = {
        name,
        ...Object.fromEntries(PRESET_FIELD_NAMES.map((f) => [f, null])),
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
    ctx.state.presets.delete(name); // 204 even when it is already gone
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
