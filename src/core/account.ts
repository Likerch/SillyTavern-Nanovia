// The NanoGPT account as the browser knows it (stage 0.4): the balance and the subscription quota, read through the
// plugin (the browser cannot read the stored keys, so without the plugin the honest answer is "needs the plugin").
// `refresh()` keeps a 60 s cache per key, never throws, and when the plugin does not answer it keeps the last good
// numbers and says they are stale. The brief (`AccountBrief`) is what `NANOVIA_API.account` hands to other extensions;
// `detail()` is the richer view the Account tab draws.
import { isPluginDown } from '../host';
import type { PluginAccount, PluginError, PluginResult } from '../host';
import type { AccountBrief } from '../shared/contracts';
import type {
    AccountBalance,
    AccountSnapshot,
    RequestCostLookup,
    SubscriptionUsage,
} from '../shared/contracts-account';
import type { ConnectionsService } from './connections';
import type { Logger, Unsubscribe } from './types';

export const ACCOUNT_TTL_MS = 60_000;
/** After a failed attempt a non-forced `refresh()` waits this long before asking again. */
export const ACCOUNT_RETRY_MS = 10_000;

export type AccountState =
    /** Nothing asked yet. */
    | 'idle'
    | 'ok'
    /** The plugin is installed but does not answer (or refused the session). */
    | 'plugin_down'
    /** The plugin is not installed: balance and subscription are read by it only. */
    | 'needs_plugin'
    /** The plugin has no NanoGPT key to ask with. */
    | 'no_key'
    /** NanoGPT or the plugin said no (key rejected, rate limit, upstream error …): see `error`. */
    | 'error';

export interface AccountDetail {
    state: AccountState;
    /** The last good numbers; null before the first answer (and after another key was chosen). */
    snapshot: AccountSnapshot | null;
    brief: AccountBrief | null;
    /** The last attempt failed: the numbers (if any) are older than they should be. */
    stale: boolean;
    /** Why the last attempt failed (the balance call's error when both did). */
    error: PluginError | null;
    /** The subscription call failed on its own (the balance is fine). */
    subscriptionError: PluginError | null;
    /** Chosen key id (from GET /keys); null = the active key. */
    keyId: string | null;
    fetching: boolean;
}

export interface AccountStore {
    /** The last known balance and subscription state; null before the first answer. */
    snapshot(): AccountBrief | null;
    detail(): AccountDetail;
    /** Reads the account again (served from the 60 s cache unless `force`); resolves to the brief; never throws. */
    refresh(options?: { force?: boolean }): Promise<AccountBrief | null>;
    /** NanoGPT's own figure for one request, asked with the chosen key. `ready: false` means "ask again later". */
    lookup(requestId: string): Promise<PluginResult<RequestCostLookup>>;
    keyId(): string | null;
    /** Chooses the key the account is read for (null = the active one). Forgets the numbers of the previous key. */
    selectKey(keyId: string | null): void;
    onChange(listener: () => void): Unsubscribe;
}

export interface AccountStoreDeps {
    account: Pick<PluginAccount, 'balance' | 'subscription' | 'lookup'>;
    connections: Pick<ConnectionsService, 'pluginUp' | 'checked' | 'pluginError'>;
    log: Logger;
    now?: () => number;
    ttlMs?: number;
    retryMs?: number;
}

/** A balance as a decimal string: at most 8 decimals, trailing zeros trimmed down to two. */
export function decimalString(value: number): string {
    const fixed = value.toFixed(8).replace(/0+$/, '');
    const [whole = '0', fraction = ''] = fixed.split('.');
    return `${whole}.${fraction.padEnd(2, '0')}`;
}

function fraction(window: { used: number | null; limit: number | null }): number | null {
    if (window.used === null || window.limit === null || !(window.limit > 0)) return null;
    return Math.min(1, Math.max(0, window.used / window.limit));
}

/** The short view for cards and meters: balance as text, quota windows as used/limit fractions. */
export function briefOf(snapshot: AccountSnapshot): AccountBrief {
    const sub = snapshot.subscription;
    const daily = sub?.active ? fraction(sub.daily) : null;
    const weekly = sub?.active ? fraction(sub.weekly) : null;
    return {
        usdBalance: snapshot.usdBalance === null ? null : decimalString(snapshot.usdBalance),
        subscription: daily === null && weekly === null ? null : { dailyUsed: daily, weeklyUsed: weekly },
        fetchedAt: snapshot.fetchedAt,
    };
}

export function stateOfError(error: PluginError): AccountState {
    if (error.code === 'not_installed') return 'needs_plugin';
    if (isPluginDown(error) || error.code === 'forbidden') return 'plugin_down';
    if (error.code === 'no_key') return 'no_key';
    return 'error';
}

export function createAccountStore(deps: AccountStoreDeps): AccountStore {
    const { account, connections, log } = deps;
    const now = deps.now ?? Date.now;
    const ttl = deps.ttlMs ?? ACCOUNT_TTL_MS;
    const retry = deps.retryMs ?? ACCOUNT_RETRY_MS;

    let keyId: string | null = null;
    /** Bumped when the key changes, so an answer for the previous key is dropped. */
    let generation = 0;
    let balance: AccountBalance | null = null;
    let subscription: SubscriptionUsage | null = null;
    let subscriptionKnown = false;
    let state: AccountState = 'idle';
    let error: PluginError | null = null;
    let subscriptionError: PluginError | null = null;
    let stale = false;
    let freshAt: number | null = null;
    let failedAt: number | null = null;
    let inflight: Promise<void> | null = null;
    const listeners = new Set<() => void>();

    function snapshotOf(): AccountSnapshot | null {
        if (balance === null && !subscriptionKnown) return null;
        return {
            usdBalance: balance?.usdBalance ?? null,
            nanoBalance: balance?.nanoBalance ?? null,
            fetchedAt: balance?.fetchedAt ?? freshAt ?? now(),
            subscription,
        };
    }

    function briefNow(): AccountBrief | null {
        const snap = snapshotOf();
        return snap ? briefOf(snap) : null;
    }

    function changed(): void {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (err) {
                log.error('account listener failed', err);
            }
        }
    }

    function pluginKnownDown(): boolean {
        return connections.checked() && !connections.pluginUp();
    }

    async function load(): Promise<void> {
        const mine = generation;
        const asked = keyId;
        const [bal, sub] = await Promise.all([account.balance(asked), account.subscription(asked)]);
        if (mine !== generation) return;
        if (bal.ok) {
            balance = bal.data;
        }
        if (sub.ok) {
            subscription = sub.data.subscription;
            subscriptionKnown = true;
            subscriptionError = null;
        } else {
            subscriptionError = sub.error;
        }
        if (bal.ok) {
            state = 'ok';
            error = null;
            stale = false;
            freshAt = now();
            failedAt = null;
        } else {
            // A failed balance call is the account failing; the subscription call usually fails for the same reason.
            error = bal.error;
            state = stateOfError(bal.error);
            stale = snapshotOf() !== null;
            failedAt = now();
            log.debug(`account refresh failed: ${bal.error.code}`);
        }
    }

    function refresh(options?: { force?: boolean }): Promise<AccountBrief | null> {
        const force = options?.force === true;
        if (inflight) return inflight.then(briefNow);
        if (!force) {
            if (freshAt !== null && !stale && now() - freshAt < ttl) return Promise.resolve(briefNow());
            if (failedAt !== null && now() - failedAt < retry) return Promise.resolve(briefNow());
            if (pluginKnownDown()) {
                const down = connections.pluginError();
                error = down ?? { code: 'unreachable', message: 'the plugin is not answering', status: null };
                state = stateOfError(error);
                stale = snapshotOf() !== null;
                changed();
                return Promise.resolve(briefNow());
            }
        }
        const mine = generation;
        const run: Promise<void> = load()
            .catch((err: unknown) => {
                log.error('account refresh failed', err);
                if (mine !== generation) return;
                error = { code: 'unreachable', message: 'the account could not be read', status: null };
                state = 'error';
                stale = snapshotOf() !== null;
                failedAt = now();
            })
            .finally(() => {
                // Another key may have been chosen (and asked) while this one was under way.
                if (inflight === run) inflight = null;
                changed();
            });
        inflight = run;
        changed();
        return run.then(briefNow);
    }

    return {
        snapshot: briefNow,

        detail() {
            const snap = snapshotOf();
            return {
                state,
                snapshot: snap,
                brief: snap ? briefOf(snap) : null,
                stale,
                error,
                subscriptionError,
                keyId,
                fetching: inflight !== null,
            };
        },

        refresh,

        lookup: (requestId) => account.lookup(requestId, keyId),

        keyId: () => keyId,

        selectKey(next) {
            const wanted = next || null;
            if (wanted === keyId) return;
            keyId = wanted;
            generation++;
            balance = null;
            subscription = null;
            subscriptionKnown = false;
            state = 'idle';
            error = null;
            subscriptionError = null;
            stale = false;
            freshAt = null;
            failedAt = null;
            inflight = null;
            changed();
        },

        onChange(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
}
