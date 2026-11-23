// Stage 0.4 contracts: balance, subscription quota, usage and cost summaries, request cost lookup. Types only; the
// shared contract file of the stage so parallel branches never edit contracts.ts (docs/ARCHITECTURE.md §6).
import type { UsageTotals } from './contracts';

// Money is always USD unless a field says otherwise. `costUsd` is real money (0 = the subscription covered the request);
// `equivalentUsd` is what the same request would cost at pay-as-you-go prices and never counts toward a spend cap.

/* ------------------------------------------------------------------------------------------------ account */

/** What `GET /account/balance` returns: NanoGPT's `check-balance`, parsed from its decimal strings. */
export interface AccountBalance {
    /** null when NanoGPT did not report it or the value could not be read. */
    usdBalance: number | null;
    nanoBalance: number | null;
    /** When the answer was fetched (ms since epoch). */
    fetchedAt: number;
}

/** One quota window of the subscription (tokens; the unit NanoGPT meters). */
export interface QuotaWindow {
    used: number | null;
    /** null = no limit reported. */
    limit: number | null;
    /** When the window resets (ms since epoch); null when unknown. */
    resetsAt: number | null;
}

/** The subscription's usage against its daily and weekly token quotas. */
export interface SubscriptionUsage {
    /** false: no active subscription (everything is pay-as-you-go). */
    active: boolean;
    daily: QuotaWindow;
    weekly: QuotaWindow;
    /** What NanoGPT advises right now: 'paygo' once a quota is used up, otherwise 'subscription'; null when it says nothing. */
    recommendedMode: 'subscription' | 'paygo' | null;
}

/** The browser's combined view of an account (it merges the balance and subscription routes). */
export interface AccountSnapshot extends AccountBalance {
    /** null: not fetched, or no subscription. */
    subscription: SubscriptionUsage | null;
}

/** What `GET /account/subscription` returns. */
export interface SubscriptionState {
    /** null: the account has no subscription, or the endpoint is unavailable for this key. */
    subscription: SubscriptionUsage | null;
    fetchedAt: number;
}

/* ------------------------------------------------------------------------------------------------ usage summary */

/** Sums over a set of usage records (defined in contracts.ts, re-exported here). */
export type { UsageTotals };

export interface DayUsage extends UsageTotals {
    /** Calendar day `YYYY-MM-DD` in the zone the caller's `dayOf` uses. */
    day: string;
}

export interface ConnectionUsage extends UsageTotals {
    /** null: requests that did not come through a Nanovia connection. */
    connectionId: string | null;
}

export interface ModelUsage extends UsageTotals {
    model: string;
}

/** Records with `from <= at < to`. byDay ascending by day; byConnection and byModel by real cost, then equivalent, then requests. */
export interface UsageSummary {
    from: number;
    to: number;
    total: UsageTotals;
    byDay: DayUsage[];
    byConnection: ConnectionUsage[];
    byModel: ModelUsage[];
}

/** What `POST /lookup/:requestId` returns: NanoGPT's per-request cost (`GET /api/v1/usage/requests/{id}`). */
export interface RequestCostLookup {
    requestId: string;
    /** false: NanoGPT answered 404, the cost is not ready yet. Ask again later; never read it as zero. */
    ready: boolean;
    /** USD, parsed from the decimal string NanoGPT returns; null while `ready` is false. */
    costUsd: number | null;
}

/*
 * Route table of stage 0.4 (all under PLUGIN_ADMIN_BASE; `keyId` is an id from GET /keys, default = the active key):
 *   GET  /account/balance?keyId                    -> AccountBalance
 *   GET  /account/subscription?keyId               -> SubscriptionState
 *   GET  /spend?from&to&connectionId               -> UsageSummary   (from/to ms since epoch, `from <= at < to`;
 *                                                     connectionId optional filter)
 *   POST /lookup/:requestId?keyId                  -> RequestCostLookup
 */
