// Typed calls of the stage 0.4 admin routes (src/shared/contracts-account.ts, "Route table of stage 0.4"): the NanoGPT
// balance, the subscription quota, the usage summary and the exact cost of one request. Built on the plugin client's raw
// `request`, so the same rules hold: nothing throws, a dead plugin is an ordinary error value, and an answer that is
// not what the contract says becomes `invalid_response` instead of a half-filled object.
import { isRecord } from '../domain/usage';
import type {
    AccountBalance,
    ConnectionUsage,
    DayUsage,
    ModelUsage,
    QuotaWindow,
    RequestCostLookup,
    SubscriptionState,
    SubscriptionUsage,
    UsageSummary,
    UsageTotals,
} from '../shared/contracts-account';
import type { PluginClient, PluginResult } from './plugin-client';

export interface SpendRange {
    /** ms since epoch, inclusive. */
    from: number;
    /** ms since epoch, exclusive. */
    to: number;
}

export interface PluginAccount {
    /** GET /account/balance. `keyId` is an id from GET /keys; null/absent = the active key. */
    balance(keyId?: string | null): Promise<PluginResult<AccountBalance>>;
    /** GET /account/subscription. `subscription` is null when the account has none. */
    subscription(keyId?: string | null): Promise<PluginResult<SubscriptionState>>;
    /** GET /spend: the plugin's usage log summed over `range`, optionally for one connection. */
    spend(range: SpendRange, connectionId?: string | null): Promise<PluginResult<UsageSummary>>;
    /** POST /lookup/:requestId: NanoGPT's own figure for one request. `ready: false` is "ask again later". */
    lookup(requestId: string, keyId?: string | null): Promise<PluginResult<RequestCostLookup>>;
}

export interface PluginAccountDeps {
    client: Pick<PluginClient, 'request'>;
    now?: () => number;
}

/** NanoGPT answers within 15 s on the plugin's side; the browser waits a little longer than that. */
const NANOGPT_TIMEOUT_MS = 20_000;
const SPEND_TIMEOUT_MS = 15_000;

function invalid(what: string): PluginResult<never> {
    return { ok: false, error: { code: 'invalid_response', message: `unexpected ${what}`, status: null } };
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A finite number from a JSON number or a decimal string; null otherwise. */
function numberOf(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && DECIMAL.test(value.trim())) {
        const n = Number(value.trim());
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function countOf(value: unknown): number {
    const n = numberOf(value);
    return n !== null && n > 0 ? n : 0;
}

export function parseBalance(raw: unknown, now: number): AccountBalance | null {
    if (!isRecord(raw)) return null;
    return {
        usdBalance: numberOf(raw['usdBalance']),
        nanoBalance: numberOf(raw['nanoBalance']),
        fetchedAt: numberOf(raw['fetchedAt']) ?? now,
    };
}

function parseWindow(raw: unknown): QuotaWindow {
    const window = isRecord(raw) ? raw : {};
    return {
        used: numberOf(window['used']),
        limit: numberOf(window['limit']),
        resetsAt: numberOf(window['resetsAt']),
    };
}

function parseSubscriptionUsage(raw: unknown): SubscriptionUsage | null {
    if (!isRecord(raw) || typeof raw['active'] !== 'boolean') return null;
    const mode = raw['recommendedMode'];
    return {
        active: raw['active'],
        daily: parseWindow(raw['daily']),
        weekly: parseWindow(raw['weekly']),
        recommendedMode: mode === 'subscription' || mode === 'paygo' ? mode : null,
    };
}

export function parseSubscriptionState(raw: unknown, now: number): SubscriptionState | null {
    if (!isRecord(raw)) return null;
    const subscription = raw['subscription'];
    // `null` is a valid answer (no subscription); anything else must be a quota document.
    if (subscription !== null && subscription !== undefined && parseSubscriptionUsage(subscription) === null)
        return null;
    return {
        subscription: subscription ? parseSubscriptionUsage(subscription) : null,
        fetchedAt: numberOf(raw['fetchedAt']) ?? now,
    };
}

function parseTotals(raw: unknown): UsageTotals | null {
    if (!isRecord(raw) || numberOf(raw['requests']) === null) return null;
    return {
        requests: countOf(raw['requests']),
        costUsd: countOf(raw['costUsd']),
        equivalentUsd: countOf(raw['equivalentUsd']),
        promptTokens: countOf(raw['promptTokens']),
        completionTokens: countOf(raw['completionTokens']),
        cachedTokens: countOf(raw['cachedTokens']),
    };
}

/** The rows of a breakdown list; a row that cannot be read is dropped, a list that is not a list is empty. */
function rows<T>(raw: unknown, read: (item: Record<string, unknown>, totals: UsageTotals) => T | null): T[] {
    if (!Array.isArray(raw)) return [];
    const out: T[] = [];
    for (const item of raw) {
        const totals = parseTotals(item);
        if (!totals || !isRecord(item)) continue;
        const row = read(item, totals);
        if (row) out.push(row);
    }
    return out;
}

export function parseSpend(raw: unknown): UsageSummary | null {
    if (!isRecord(raw)) return null;
    const from = numberOf(raw['from']);
    const to = numberOf(raw['to']);
    const total = parseTotals(raw['total']);
    if (from === null || to === null || total === null) return null;
    return {
        from,
        to,
        total,
        byDay: rows<DayUsage>(raw['byDay'], (item, totals) =>
            typeof item['day'] === 'string' ? { day: item['day'], ...totals } : null,
        ),
        byConnection: rows<ConnectionUsage>(raw['byConnection'], (item, totals) => ({
            connectionId: typeof item['connectionId'] === 'string' ? item['connectionId'] : null,
            ...totals,
        })),
        byModel: rows<ModelUsage>(raw['byModel'], (item, totals) =>
            typeof item['model'] === 'string' ? { model: item['model'], ...totals } : null,
        ),
    };
}

export function parseLookup(raw: unknown): RequestCostLookup | null {
    if (!isRecord(raw) || typeof raw['requestId'] !== 'string' || typeof raw['ready'] !== 'boolean') return null;
    const cost = numberOf(raw['costUsd']);
    return {
        requestId: raw['requestId'],
        ready: raw['ready'],
        // A figure that is not ready yet is never a number: "not ready" must not read as zero.
        costUsd: raw['ready'] && cost !== null && cost >= 0 ? cost : null,
    };
}

function map<T>(result: PluginResult<unknown>, read: (data: unknown) => T | null, what: string): PluginResult<T> {
    if (!result.ok) return result;
    const value = read(result.data);
    return value === null ? invalid(what) : { ok: true, data: value };
}

function query(params: Record<string, string | number | null | undefined>): string {
    const parts: string[] = [];
    for (const [name, value] of Object.entries(params)) {
        if (value === null || value === undefined || value === '') continue;
        parts.push(`${name}=${encodeURIComponent(String(value))}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
}

export function createPluginAccount(deps: PluginAccountDeps): PluginAccount {
    const { client } = deps;
    const now = deps.now ?? Date.now;
    return {
        async balance(keyId) {
            const path = `/account/balance${query({ keyId })}`;
            return map(
                await client.request('GET', path, undefined, NANOGPT_TIMEOUT_MS),
                (d) => parseBalance(d, now()),
                'balance',
            );
        },

        async subscription(keyId) {
            const path = `/account/subscription${query({ keyId })}`;
            return map(
                await client.request('GET', path, undefined, NANOGPT_TIMEOUT_MS),
                (d) => parseSubscriptionState(d, now()),
                'subscription',
            );
        },

        async spend(range, connectionId) {
            const path = `/spend${query({ from: range.from, to: range.to, connectionId })}`;
            return map(await client.request('GET', path, undefined, SPEND_TIMEOUT_MS), parseSpend, 'spend summary');
        },

        async lookup(requestId, keyId) {
            const path = `/lookup/${encodeURIComponent(requestId)}${query({ keyId })}`;
            return map(await client.request('POST', path, {}, NANOGPT_TIMEOUT_MS), parseLookup, 'cost lookup');
        },
    };
}
