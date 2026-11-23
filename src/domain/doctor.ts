// The Doctor: findings about the whole setup. Pure: a plain data snapshot in, a list of checks out (no DOM, network,
// clock or ST). The browser service (core/doctor.ts) gathers the snapshot; the tab turns `code` + `params` into text
// (`doctor.check.<code>.title` / `.detail`) and offers `fix` as a button.
//
// Rules of thumb:
//   - a part of the snapshot that is `null` (or `checked: false`) is "not known": its checks are skipped, never guessed;
//   - a problem has one code and one level; a thing that is fine can produce an `ok` check (`*_ok`), so the tab can show
//     what was looked at;
//   - billing and background advice are not analysed again here: `analyzeBilling` (billing.ts) gives the verdict and the
//     caller passes the issues of `backgroundAdvice` (core/advice.ts) in as data.
import type { AdviceIssue, CatalogModel, ConnectionConfig, DoctorLevel } from '../shared/contracts';
import { analyzeBilling } from './billing';

export type { DoctorLevel };

export type DoctorFixAction = 'refresh' | 'repair-profile' | 'open-tab' | 'switch-direct' | 'check-key';

/**
 * What a one-click fix does. `target`: refresh -> 'catalog' for the catalog (nothing: the connections and the plugin);
 * repair-profile and switch-direct -> a connection id; open-tab -> a panel tab id; check-key -> a key id.
 */
export interface DoctorFix {
    action: DoctorFixAction;
    target?: string;
}

export type DoctorParams = Record<string, string | number | boolean>;

export interface DoctorCheck {
    /** Unique within a run: the code, plus `:<connection or key id>` for a check about one of them. */
    id: string;
    level: DoctorLevel;
    /** Mapped to text by the UI: `doctor.check.<code>.title` and `.detail`. */
    code: string;
    params?: DoctorParams;
    fix?: DoctorFix;
}

export interface DoctorSummary {
    ok: number;
    info: number;
    warn: number;
    error: number;
}

/* ------------------------------------------------------------------------------------------------ the snapshot */

export type DoctorProfileState = 'linked' | 'drifted' | 'missing' | 'none' | 'blocked' | 'unavailable';

/** Qvink Memory: loaded and on, installed but switched off, not there, or "cannot tell". */
export type DoctorQvink = 'present' | 'disabled' | 'absent' | 'unknown';

export interface DoctorConnection {
    config: ConnectionConfig;
    effectiveMode: 'plugin' | 'direct';
    profileState: DoctorProfileState;
    /** Not on the plugin although its mode needs it there. */
    orphan: boolean;
    /** Edited while the plugin was down. */
    pending: boolean;
    /** A direct-mode key is on file. */
    hasDirectKey: boolean;
    /** The catalog's model of `config.modelId`; null when the catalog does not list it (or is not loaded). */
    model: CatalogModel | null;
    /** `ModelProviders.supportsProviderSelection` of the model; null when unknown. */
    providerSelection: boolean | null;
    /** The issues `backgroundAdvice` found for using this connection as a background one. */
    advice: readonly AdviceIssue[];
}

export interface DoctorKey {
    id: string;
    label: string;
    masked: string;
    /** The last balance check of this key, when one was made; `error` is what the plugin reported. */
    check: { ok: boolean; error: string | null } | null;
}

export interface DoctorAccount {
    usdBalance: number | null;
    subscriptionActive: boolean;
    /** Share of the quota used, 0..1; null when unknown. */
    dailyUsed: number | null;
    weeklyUsed: number | null;
}

export interface DoctorInput {
    /** ms since epoch. */
    now: number;
    plugin: {
        /** The plugin was asked at least once (before that "not up" means "not known"). */
        checked: boolean;
        up: boolean;
        /** Why it is down (the plugin client's error code); null when it is up or not asked. */
        errorCode: string | null;
        version: string | null;
        /** From `/status`; null while the plugin is down. */
        proxy: { up: boolean; port: number } | null;
        /** ST's secret store is reachable for the plugin; null while the plugin is down. */
        secrets: boolean | null;
    };
    /** ST's `pkgVersion`; null when it could not be read. */
    stVersion: string | null;
    connectionManager: boolean;
    connections: readonly DoctorConnection[];
    /** The plugin's keys; null when not known (the plugin is down, the list was never loaded). */
    keys: readonly DoctorKey[] | null;
    catalog: {
        loaded: boolean;
        count: number;
        fetchedAt: number | null;
        source: 'live' | 'cache' | 'stale' | null;
        error: string | null;
    };
    qvink: DoctorQvink;
    /** The Management API token is on file; null when not known (the Management tab does not exist or was not asked). */
    mgmtToken: boolean | null;
    /** null when not known. */
    account: DoctorAccount | null;
}

/* ------------------------------------------------------------------------------------------------ constants */

/** The oldest SillyTavern Nanovia is built for. */
export const MIN_ST_VERSION = '1.19.0';
/** Pay-as-you-go connections are warned about below this balance (USD). */
export const LOW_BALANCE_USD = 1;
/** A subscription quota window is warned about from this share on. */
export const QUOTA_HIGH_FRACTION = 0.9;
/** A catalog older than this is called stale. */
export const CATALOG_STALE_MS = 24 * 3_600_000;

/** Panel tab ids the fixes point at (the ids the features register). */
export const DOCTOR_TABS = {
    connections: 'connections',
    keys: 'keys',
    routing: 'routing',
    /** The Management API tab (stage 0.6); change here if it registers another id. */
    mgmt: 'mgmt',
} as const;

/** Every code `runChecks` and `failedCheck` can emit (the dictionaries must have `doctor.check.<code>.title|detail`). */
export const DOCTOR_CODES: readonly string[] = [
    'plugin_ok',
    'plugin_down',
    'proxy_down',
    'secrets_unavailable',
    'st_version_ok',
    'st_version_old',
    'connection_manager_missing',
    'keys_ok',
    'no_keys',
    'key_rejected',
    'catalog_ok',
    'catalog_empty',
    'catalog_stale',
    'connection_ok',
    'model_unknown_or_paused',
    'profile_missing',
    'profile_drifted',
    'profile_blocked',
    'profile_orphan',
    'profile_pending',
    'direct_without_key',
    'plugin_mode_but_down',
    'leaves_subscription',
    'memory_on',
    'memory_overlaps_qvink',
    'reasoning_always_on_for_background',
    'mgmt_token_missing',
    'low_balance',
    'subscription_quota_high',
    'doctor_failed',
];

/** Most serious first. */
export const DOCTOR_LEVELS: readonly DoctorLevel[] = ['error', 'warn', 'info', 'ok'];

/* ------------------------------------------------------------------------------------------------ helpers */

/** `1.19.2`, `v1.19`, `1.19.0-beta` -> [1, 19, 2]; null when it does not start with a number. */
export function parseVersion(text: string): [number, number, number] | null {
    const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
    if (!match) return null;
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i++) {
        const diff = (left[i] as number) - (right[i] as number);
        if (diff !== 0) return diff;
    }
    return 0;
}

export function summarizeChecks(checks: readonly DoctorCheck[]): DoctorSummary {
    const summary: DoctorSummary = { ok: 0, info: 0, warn: 0, error: 0 };
    for (const check of checks) summary[check.level]++;
    return summary;
}

/** The checks of one level, in the order they were made. */
export function checksOfLevel(checks: readonly DoctorCheck[], level: DoctorLevel): DoctorCheck[] {
    return checks.filter((check) => check.level === level);
}

/** What the service reports when the work itself failed: a check, not an exception. */
export function failedCheck(message: string): DoctorCheck {
    return { id: 'doctor_failed', level: 'error', code: 'doctor_failed', params: { message } };
}

function check(
    code: string,
    level: DoctorLevel,
    options: { scope?: string; params?: DoctorParams; fix?: DoctorFix } = {},
): DoctorCheck {
    const result: DoctorCheck = { id: options.scope ? `${code}:${options.scope}` : code, level, code };
    if (options.params) result.params = options.params;
    if (options.fix) result.fix = options.fix;
    return result;
}

/* ------------------------------------------------------------------------------------------------ the checks */

export function runChecks(input: DoctorInput): DoctorCheck[] {
    const checks: DoctorCheck[] = [];
    const needsPlugin = input.connections.some((c) => c.effectiveMode === 'plugin');
    environment(input, needsPlugin, checks);
    keys(input, needsPlugin, checks);
    catalog(input, checks);
    const catalogUsable = input.catalog.loaded && input.catalog.count > 0;
    const paygo: string[] = [];
    for (const connection of input.connections) {
        if (connectionChecks(input, connection, catalogUsable, checks)) paygo.push(connection.config.name);
    }
    account(input, paygo, checks);
    if (input.mgmtToken === false) {
        checks.push(check('mgmt_token_missing', 'info', { fix: { action: 'open-tab', target: DOCTOR_TABS.mgmt } }));
    }
    return checks;
}

/** The plugin, SillyTavern itself and Connection Manager. */
function environment(input: DoctorInput, needsPlugin: boolean, checks: DoctorCheck[]): void {
    const { plugin } = input;
    if (plugin.checked) {
        if (!plugin.up) {
            checks.push(
                check('plugin_down', 'warn', {
                    params: { reason: plugin.errorCode ?? 'unreachable' },
                    fix: { action: 'refresh' },
                }),
            );
        } else {
            let healthy = true;
            if (plugin.proxy && !plugin.proxy.up) {
                healthy = false;
                checks.push(
                    check('proxy_down', needsPlugin ? 'error' : 'warn', {
                        params: { port: plugin.proxy.port },
                        fix: { action: 'refresh' },
                    }),
                );
            }
            if (plugin.secrets === false) {
                healthy = false;
                checks.push(check('secrets_unavailable', 'warn'));
            }
            if (healthy) {
                checks.push(
                    check('plugin_ok', 'ok', {
                        params: { port: plugin.proxy?.port ?? 0, version: plugin.version ?? '' },
                    }),
                );
            }
        }
    }

    if (input.stVersion !== null) {
        const order = compareVersions(input.stVersion, MIN_ST_VERSION);
        if (order !== null) {
            checks.push(
                order < 0
                    ? check('st_version_old', 'warn', {
                          params: { version: input.stVersion, required: MIN_ST_VERSION },
                      })
                    : check('st_version_ok', 'ok', { params: { version: input.stVersion } }),
            );
        }
    }

    if (!input.connectionManager) checks.push(check('connection_manager_missing', 'error'));
}

/** The plugin's NanoGPT keys. */
function keys(input: DoctorInput, needsPlugin: boolean, checks: DoctorCheck[]): void {
    const list = input.keys;
    if (list === null) return;
    if (list.length === 0) {
        // With the secret store out of reach the list is empty whatever is stored; that is its own finding.
        if (input.plugin.secrets === false) return;
        checks.push(
            check('no_keys', needsPlugin ? 'error' : 'info', { fix: { action: 'open-tab', target: DOCTOR_TABS.keys } }),
        );
        return;
    }
    let rejected = 0;
    let passed = 0;
    for (const key of list) {
        if (key.check === null) continue;
        if (key.check.ok) {
            passed++;
            continue;
        }
        rejected++;
        checks.push(
            check('key_rejected', 'error', {
                scope: key.id,
                params: { label: key.label.trim() || key.masked, reason: key.check.error ?? '' },
                fix: { action: 'check-key', target: key.id },
            }),
        );
    }
    if (rejected === 0) checks.push(check('keys_ok', 'ok', { params: { count: list.length, passed } }));
}

/** The model catalog as a whole. */
function catalog(input: DoctorInput, checks: DoctorCheck[]): void {
    const { catalog: status, now } = input;
    const fix: DoctorFix = { action: 'refresh', target: 'catalog' };
    if (!status.loaded || status.count === 0) {
        // A failed load or a list that came back empty is a problem; one that was not asked for yet is only news.
        const level: DoctorLevel = status.error !== null || status.loaded ? 'warn' : 'info';
        checks.push(check('catalog_empty', level, { params: { reason: status.error ?? '' }, fix }));
        return;
    }
    const old = status.fetchedAt !== null && now - status.fetchedAt > CATALOG_STALE_MS;
    if (status.source === 'stale' || old) {
        checks.push(check('catalog_stale', 'warn', { fix }));
        return;
    }
    checks.push(check('catalog_ok', 'ok', { params: { count: status.count } }));
}

/**
 * Everything about one connection. Returns whether it is billed pay-as-you-go (for the balance warning).
 */
function connectionChecks(
    input: DoctorInput,
    entry: DoctorConnection,
    catalogUsable: boolean,
    checks: DoctorCheck[],
): boolean {
    const { config } = entry;
    const { plugin } = input;
    const scope = config.id;
    const base: DoctorParams = { name: config.name, model: config.modelId };
    const first = checks.length;
    const pluginDown = plugin.checked && !plugin.up;
    const openConnections: DoctorFix = { action: 'open-tab', target: DOCTOR_TABS.connections };

    if (catalogUsable && entry.model === null) {
        checks.push(check('model_unknown_or_paused', 'warn', { scope, params: base, fix: openConnections }));
    }

    const noDirectKey = entry.effectiveMode === 'direct' && !entry.hasDirectKey;
    const waitsForPlugin = config.mode === 'plugin' && pluginDown;
    if (noDirectKey) checks.push(check('direct_without_key', 'error', { scope, params: base, fix: openConnections }));
    if (waitsForPlugin) {
        checks.push(
            check('plugin_mode_but_down', 'error', {
                scope,
                params: base,
                fix: entry.hasDirectKey ? { action: 'switch-direct', target: scope } : openConnections,
            }),
        );
    }

    if (input.connectionManager) {
        const repair: DoctorFix = { action: 'repair-profile', target: scope };
        switch (entry.profileState) {
            case 'missing':
            case 'none':
                checks.push(
                    check('profile_missing', 'warn', {
                        scope,
                        params: { ...base, state: entry.profileState },
                        fix: repair,
                    }),
                );
                break;
            case 'drifted':
                checks.push(check('profile_drifted', 'warn', { scope, params: base, fix: repair }));
                break;
            case 'blocked':
                // No key or no token is already said above; this is for a profile that is blocked for no such reason.
                if (!noDirectKey && !waitsForPlugin) {
                    checks.push(
                        check('profile_blocked', 'warn', {
                            scope,
                            params: base,
                            fix: entry.effectiveMode === 'plugin' ? { action: 'refresh' } : openConnections,
                        }),
                    );
                }
                break;
            default:
                break;
        }
    }
    if (entry.orphan) checks.push(check('profile_orphan', 'warn', { scope, params: base, fix: openConnections }));
    if (entry.pending) {
        checks.push(
            check('profile_pending', plugin.checked && plugin.up ? 'warn' : 'info', {
                scope,
                params: base,
                fix: { action: 'refresh' },
            }),
        );
    }

    // Billing: the verdict of the existing analysis, nothing of our own.
    const impact = analyzeBilling(config, entry.model, entry.providerSelection);
    const subscribed = input.account?.subscriptionActive === true;
    if (subscribed && config.billing !== 'paygo' && impact.outcome === 'paygo') {
        const why =
            impact.reasons.find((reason) => reason.code === 'routing.explicit') ??
            impact.reasons.find((reason) => reason.code === 'model.notIncluded') ??
            impact.reasons.find((reason) => reason.code === 'billing.modelNotCoverable');
        checks.push(
            check('leaves_subscription', 'warn', {
                scope,
                params: {
                    ...base,
                    reason: why?.code ?? '',
                    fields: String(why?.params?.['fields'] ?? ''),
                },
                fix: { action: 'open-tab', target: DOCTOR_TABS.routing },
            }),
        );
    }

    if (config.memory.enabled) {
        checks.push(check('memory_on', 'info', { scope, params: base }));
        if (input.qvink === 'present') {
            checks.push(check('memory_overlaps_qvink', 'warn', { scope, params: base, fix: openConnections }));
        }
    }

    const always = entry.advice.find((issue) => issue.code === 'reasoning.alwaysOn');
    if (always) {
        checks.push(
            check('reasoning_always_on_for_background', 'info', {
                scope,
                params: { ...base, efforts: String(always.params?.['efforts'] ?? '') },
            }),
        );
    }

    const problems = checks.slice(first).some((item) => item.level === 'warn' || item.level === 'error');
    if (!problems) checks.push(check('connection_ok', 'ok', { scope, params: base }));

    const everythingPaygo = input.account !== null && !input.account.subscriptionActive;
    return config.billing === 'paygo' || impact.outcome === 'paygo' || everythingPaygo;
}

/** Balance and subscription quota. `paygoNames`: the connections that are billed per token. */
function account(input: DoctorInput, paygoNames: readonly string[], checks: DoctorCheck[]): void {
    const info = input.account;
    if (info === null) return;
    if (info.usdBalance !== null && info.usdBalance < LOW_BALANCE_USD && paygoNames.length > 0) {
        checks.push(
            check('low_balance', 'warn', {
                params: { balance: info.usdBalance.toFixed(2), names: paygoNames.join(', ') },
            }),
        );
    }
    if (!info.subscriptionActive) return;
    for (const window of ['daily', 'weekly'] as const) {
        const used = window === 'daily' ? info.dailyUsed : info.weeklyUsed;
        if (used !== null && used >= QUOTA_HIGH_FRACTION) {
            checks.push(
                check('subscription_quota_high', 'warn', {
                    scope: window,
                    params: { window, percent: Math.round(used * 100) },
                }),
            );
        }
    }
}
