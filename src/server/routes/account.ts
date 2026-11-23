// Account routes of stage 0.4 (contracts-account.ts): the balance, the subscription quota and the cost of one request.
// All of them call NanoGPT with the key chosen by `?keyId` (default: the active key); the key never leaves the plugin.
//   GET  /account/balance?keyId       -> AccountBalance        (POST <site>/api/check-balance, x-api-key)
//   GET  /account/subscription?keyId  -> SubscriptionState     (GET <site>/api/subscription/v1/usage, Bearer)
//   POST /lookup/:requestId?keyId     -> RequestCostLookup     (GET <upstream>/usage/requests/<id>, Bearer)
import { isRecord, parseCost } from '../../domain/usage';
import type {
    AccountBalance,
    QuotaWindow,
    RequestCostLookup,
    SubscriptionState,
    SubscriptionUsage,
} from '../../shared/contracts-account';
import type { RouteModule } from '../types';
import { HttpError, route, sendJson, userOf } from './http';
import { callNanogpt, isOk, keyIdOf, rejectedAnswer, resolveKey } from './nanogpt';

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** Answers that mean "this key has no subscription endpoint" rather than "the call failed". */
const NO_SUBSCRIPTION_STATUSES = new Set([403, 404, 405, 410, 501]);
/** A Unix timestamp below this is in seconds, at or above it in milliseconds (1e11 s is the year 5138, 1e11 ms is 1973). */
const SECONDS_LIMIT = 1e11;

/** A number from a JSON number or a decimal string; null for anything else (a balance may be any finite value). */
function amount(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && DECIMAL.test(value.trim())) {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** `check-balance`: `usd_balance` and `nano_balance` are decimal strings. */
export function mapBalance(payload: Record<string, unknown>, fetchedAt: number): AccountBalance {
    return {
        usdBalance: amount(payload['usd_balance'] ?? payload['usdBalance']),
        nanoBalance: amount(payload['nano_balance'] ?? payload['nanoBalance']),
        fetchedAt,
    };
}

function timestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value < SECONDS_LIMIT ? Math.round(value * 1000) : value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = DECIMAL.test(value.trim()) ? timestamp(Number(value.trim())) : Date.parse(value);
        return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/** One window of the quota document: `{ used, remaining, percentUsed, resetAt }`, or null/absent for "no such window". */
function quotaWindow(raw: unknown, limit: unknown): QuotaWindow {
    const window = isRecord(raw) ? raw : null;
    const used = window ? amount(window['used']) : null;
    const remaining = window ? amount(window['remaining']) : null;
    return {
        used,
        limit: amount(limit) ?? (used !== null && remaining !== null ? used + remaining : null),
        resetsAt: window ? timestamp(window['resetAt'] ?? window['resetsAt']) : null,
    };
}

/**
 * NanoGPT's `GET /api/subscription/v1/usage` as SubscriptionUsage; null when the payload is not a quota document. The
 * limits sit in `limits.*InputTokens`, the usage in `dailyInputTokens` / `weeklyInputTokens` (`null` when there is no such
 * window); `routing.recommendedMode` says what NanoGPT advises right now ('unavailable' and anything else become null).
 */
export function mapSubscriptionUsage(payload: unknown): SubscriptionUsage | null {
    if (!isRecord(payload)) return null;
    const limits = isRecord(payload['limits']) ? payload['limits'] : {};
    const routing = isRecord(payload['routing']) ? payload['routing'] : {};
    const state = payload['state'];
    const active =
        typeof payload['active'] === 'boolean'
            ? payload['active']
            : typeof state === 'string'
              ? state === 'active'
              : null;
    const daily = quotaWindow(payload['dailyInputTokens'], limits['dailyInputTokens']);
    const weekly = quotaWindow(payload['weeklyInputTokens'], limits['weeklyInputTokens']);
    const hasWindow = isRecord(payload['dailyInputTokens']) || isRecord(payload['weeklyInputTokens']);
    if (active === null && !hasWindow) return null;
    const mode = routing['recommendedMode'];
    return {
        active: active ?? true,
        daily,
        weekly,
        recommendedMode: mode === 'subscription' || mode === 'paygo' ? mode : null,
    };
}

export const accountRoutes: RouteModule = (router, deps) => {
    router.get(
        '/account/balance',
        route(deps.log, async (req, res) => {
            const key = resolveKey(deps, userOf(req, deps), keyIdOf(req));
            const answer = await callNanogpt(deps, key, {
                method: 'POST',
                url: `${deps.config.siteBase}/api/check-balance`,
                auth: 'x-api-key',
                body: '{}',
            });
            if (!isOk(answer.status)) throw rejectedAnswer(answer.status);
            if (!isRecord(answer.json))
                throw new HttpError(502, 'bad_response', 'NanoGPT answered with something else than JSON');
            sendJson(res, 200, mapBalance(answer.json, deps.now()));
        }),
    );

    router.get(
        '/account/subscription',
        route(deps.log, async (req, res) => {
            const key = resolveKey(deps, userOf(req, deps), keyIdOf(req));
            const answer = await callNanogpt(deps, key, {
                method: 'GET',
                url: `${deps.config.siteBase}/api/subscription/v1/usage`,
                auth: 'bearer',
            });
            const none: SubscriptionState = { subscription: null, fetchedAt: deps.now() };
            if (NO_SUBSCRIPTION_STATUSES.has(answer.status)) return sendJson(res, 200, none);
            if (!isOk(answer.status)) throw rejectedAnswer(answer.status);
            const state: SubscriptionState = { subscription: mapSubscriptionUsage(answer.json), fetchedAt: deps.now() };
            sendJson(res, 200, state);
        }),
    );

    router.post(
        '/lookup/:requestId',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const requestId = req.params['requestId'] ?? '';
            if (!REQUEST_ID.test(requestId)) throw new HttpError(400, 'invalid_request', 'Not a request id');
            const key = resolveKey(deps, user, keyIdOf(req));
            const answer = await callNanogpt(deps, key, {
                method: 'GET',
                url: `${deps.config.upstreamBase}/usage/requests/${encodeURIComponent(requestId)}`,
                auth: 'bearer',
            });
            // 404: NanoGPT has not recorded the charge yet (or it is older than its retention). Never a zero.
            if (answer.status === 404) {
                const pending: RequestCostLookup = { requestId, ready: false, costUsd: null };
                return sendJson(res, 200, pending);
            }
            if (!isOk(answer.status)) throw rejectedAnswer(answer.status);
            if (!isRecord(answer.json))
                throw new HttpError(502, 'bad_response', 'NanoGPT answered with something else than JSON');
            sendJson(res, 200, {
                requestId,
                ready: true,
                costUsd: lookupCost(answer.json),
            } satisfies RequestCostLookup);
        }),
    );
};

/** The charge in USD: `cost` is a decimal string. 0 in any currency is 0; a paid amount in another currency is not dollars. */
function lookupCost(payload: Record<string, unknown>): number | null {
    const cost = parseCost(payload['cost']);
    if (cost === null) return null;
    const currency = typeof payload['currency'] === 'string' ? payload['currency'].trim().toUpperCase() : '';
    return currency === '' || currency === 'USD' || cost === 0 ? cost : null;
}
