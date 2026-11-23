// Everything the mock remembers between requests: request log, balance, subscription counters, billing records,
// Management API keys and presets. `POST /__mock/reset` puts it all back.

const DAY_MS = 24 * 60 * 60 * 1000;

function initial() {
    return {
        log: [],
        counter: 0,
        balanceUsd: 25,
        nanoBalance: 4.8,
        /** The key's policy lets a request fall back to the balance when the subscription cannot cover it. */
        paidSpendAllowed: true,
        subscription: {
            active: true,
            dailyLimit: 1_000_000,
            weeklyLimit: 6_000_000,
            dailyUsed: 0,
            weeklyUsed: 0,
            imagesLimit: 10,
            imagesUsed: 0,
        },
        /** requestId -> primary charge, for `GET /api/v1/usage/requests/:id`. */
        billing: new Map(),
        /** One row per billed chat request, for `GET /api/v1/usage`. */
        records: [],
        keys: new Map(),
        nextKeyId: 1,
        idempotency: new Map(),
        presets: new Map(),
    };
}

export function createState() {
    const state = initial();
    state.reset = () => Object.assign(state, initial());
    return state;
}

export const nextMidnight = (now) => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;

/** Next Monday 00:00 UTC. */
export function nextWeekStart(now) {
    const day = new Date(now).getUTCDay();
    const daysAhead = (8 - day) % 7 || 7;
    return Math.floor(now / DAY_MS) * DAY_MS + daysAhead * DAY_MS;
}

function quota(used, limit, resetAt) {
    if (limit == null) return null;
    return { used, remaining: Math.max(0, limit - used), percentUsed: used / limit, resetAt };
}

/** True while neither subscription window is used up. */
export function subscriptionQuotaAvailable(state) {
    const s = state.subscription;
    if (!s.active) return false;
    return (
        (s.dailyLimit == null || s.dailyUsed < s.dailyLimit) && (s.weeklyLimit == null || s.weeklyUsed < s.weeklyLimit)
    );
}

/** The `/subscription/usage` document. `inference: true` adds what only an inference key gets (routing advice). */
export function subscriptionUsage(state, { inference, now = Date.now() }) {
    const s = state.subscription;
    const doc = {
        active: s.active,
        state: s.active ? 'active' : 'inactive',
        limits: { dailyInputTokens: s.dailyLimit, weeklyInputTokens: s.weeklyLimit, dailyImages: s.imagesLimit },
        dailyInputTokens: quota(s.dailyUsed, s.dailyLimit, nextMidnight(now)),
        weeklyInputTokens: quota(s.weeklyUsed, s.weeklyLimit, nextWeekStart(now)),
        dailyImages: quota(s.imagesUsed, s.imagesLimit, nextMidnight(now)),
        period: { currentPeriodEnd: s.active ? new Date(nextWeekStart(now) + 3 * DAY_MS).toISOString() : null },
    };
    if (!inference) return doc;
    const available = subscriptionQuotaAvailable(state);
    let recommendedMode = 'subscription';
    let reason = 'subscription_quota_available';
    if (!available) {
        recommendedMode = state.paidSpendAllowed ? 'paygo' : 'unavailable';
        reason = s.active ? 'subscription_quota_exhausted' : 'subscription_inactive';
    }
    return {
        ...doc,
        allowOverage: state.paidSpendAllowed,
        routing: {
            recommendedMode,
            reason,
            subscriptionQuotaAvailable: available,
            paidSpendPolicyAllowsBalance: state.paidSpendAllowed,
        },
    };
}
