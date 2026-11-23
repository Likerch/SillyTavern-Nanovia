// The catalog, account and usage routes (everything except chat and the Management API).
import { sendError, sendJson } from './http.mjs';
import { subscriptionUsage } from './state.mjs';

/** A 1x1 transparent PNG, the answer of the image stubs. */
export const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** GET /api/v1/models[?detailed=true] */
export function models({ res, url, catalog }) {
    const detailed = url.searchParams.get('detailed') === 'true';
    const data = detailed
        ? catalog.models
        : catalog.models.map(({ id, object, created, owned_by }) => ({ id, object, created, owned_by }));
    sendJson(res, 200, { object: 'list', data });
}

/** GET /api/models/:id/providers (the id is URL-encoded and may hold slashes) */
export function providers({ res, params, catalog }) {
    const response = catalog.providersFor(decodeURIComponent(params.id));
    if (!response) return sendError(res, 404, 'model_not_found', `Model '${decodeURIComponent(params.id)}' not found`);
    return sendJson(res, 200, response);
}

/** POST /api/check-balance */
export function checkBalance({ res, state }) {
    sendJson(res, 200, {
        usd_balance: state.balanceUsd.toFixed(8),
        nano_balance: state.nanoBalance.toFixed(8),
        nanoDepositAddress: 'nano_1mocknanogpt0000000000000000000000000000000000000000000000000',
    });
}

/** GET /api/subscription/v1/usage (alias /api/v1/subscription/usage) */
export function subscription({ res, state }) {
    sendJson(res, 200, subscriptionUsage(state, { inference: true }));
}

const dateOf = (at) => new Date(at).toISOString().slice(0, 10);

function totals(rows) {
    const sum = (field) => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
    const costUsd = Number(sum('cost').toFixed(10));
    return {
        requests: rows.length,
        costUsd,
        refundedUsd: 0,
        netCostUsd: costUsd,
        inputTokens: sum('input'),
        outputTokens: sum('output'),
        reasoningTokens: sum('reasoning'),
        totalTokens: sum('input') + sum('output'),
    };
}

/** Rows grouped by `keyOf(row)`, each group summarised with `extra(first row)`. */
function groupRows(rows, keyOf, extra) {
    const groups = new Map();
    for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
    return [...groups.values()].map((group) => ({ ...extra(group[0]), ...totals(group) }));
}

/** GET /api/v1/usage[?from&to&group_by] : aggregates of the requests this key made through the mock. */
export function usage({ res, url, state, keyId }) {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (Boolean(from) !== Boolean(to))
        return sendError(res, 400, 'invalid_parameter_value', '`from` and `to` must be provided together');
    const groupBy = (url.searchParams.get('group_by') ?? 'day,model').split(',').sort().join(',');
    const rows = state.records.filter(
        (r) => r.keyId === keyId && (!from || (dateOf(r.at) >= from && dateOf(r.at) <= to)),
    );
    const today = dateOf(Date.now());
    const doc = {
        object: 'usage',
        scope: 'current_key',
        apiKey: { id: 1 },
        from: from ?? dateOf(Date.now() - 29 * 86_400_000),
        to: to ?? today,
        timezone: 'UTC',
        groupBy,
        asOf: new Date().toISOString(),
        totals: totals(rows),
    };
    if (groupBy.includes('day'))
        doc.byDay = groupRows(
            rows,
            (r) => dateOf(r.at),
            (r) => ({ date: dateOf(r.at) }),
        );
    if (groupBy.includes('model'))
        doc.byModel = groupRows(
            rows,
            (r) => r.model,
            (r) => ({ model: r.model }),
        );
    if (groupBy === 'day,model') {
        doc.byDayModel = groupRows(
            rows,
            (r) => `${dateOf(r.at)}|${r.model}`,
            (r) => ({ date: dateOf(r.at), model: r.model }),
        );
    }
    return sendJson(res, 200, doc);
}

/** GET /api/v1/usage/requests/:id : the recorded primary charge of one request (24 hours, same key only). */
export function requestBilling({ res, params, state, keyId }) {
    const record = state.billing.get(decodeURIComponent(params.id));
    if (!record || record.keyId !== keyId) {
        return sendError(res, 404, 'request_not_found', 'No billing record for this request id.', {
            headers: { 'Retry-After': '30' },
        });
    }
    return sendJson(res, 200, {
        object: 'request_billing',
        request_id: decodeURIComponent(params.id),
        created_at: new Date(record.at).toISOString(),
        expires_at: new Date(record.at + 86_400_000).toISOString(),
        as_of: new Date().toISOString(),
        cost: record.cost.toFixed(8),
        currency: 'USD',
        cost_scope: 'primary_charge',
        usage: { input_tokens: record.input, output_tokens: record.output, reasoning_tokens: record.reasoning },
    });
}

/** POST /api/v1/images/generations and POST /api/v1/images (stage 7 stubs): one tiny PNG. */
export function images({ res }) {
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: [{ b64_json: TINY_PNG_BASE64 }] });
}
