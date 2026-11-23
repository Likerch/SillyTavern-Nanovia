// The Doctor service (stage 0.6): gathers a snapshot of the whole setup from the services the browser already has, runs
// the pure checks of domain/doctor.ts over it and applies the one-click fixes those checks offer. It never throws: a part
// that cannot be read is left out of the snapshot ("not known": its checks are skipped), a fix that fails is a result.
//
// `run()` asks for what needs the network (ST's version, the plugin's keys, a balance check of each key, the account, the
// catalog) and keeps it; `evaluate()` / `brief()` only look at what is known now, so the public API stays synchronous.
import {
    failedCheck,
    runChecks,
    summarizeChecks,
    type DoctorAccount,
    type DoctorCheck,
    type DoctorConnection,
    type DoctorFix,
    type DoctorInput,
    type DoctorKey,
    type DoctorQvink,
    type DoctorSummary,
} from '../domain/doctor';
import { qvinkState, readStVersion } from '../host';
import type { Host, PluginClient, ProfilesHost } from '../host';
import type { DoctorBrief, KeyCheck, KeyInfo } from '../shared/contracts';
import { backgroundAdvice } from './advice';
import { briefOf } from './account';
import type { AccountStore } from './account';
import type { CatalogStore } from './catalog';
import type { ConnectionsService } from './connections';
import type { Logger, PanelApi, Unsubscribe } from './types';

/** A balance check of a key is trusted for this long before a run asks again. */
export const KEY_CHECK_TTL_MS = 5 * 60_000;
/** ST's version is asked again after this long (a failed read is retried sooner). */
export const VERSION_TTL_MS = 10 * 60_000;
export const VERSION_RETRY_MS = 60_000;

export interface DoctorReport {
    /** ms since epoch. */
    at: number;
    checks: DoctorCheck[];
    summary: DoctorSummary;
}

export type DoctorFixResult =
    | { ok: true }
    /** `code` is the plugin's or the connections service's own (`direct_key_required` …), or one of ours. */
    | { ok: false; code: string; params?: Record<string, string | number> };

export interface DoctorRunOptions {
    /** Asks the plugin again before looking (and asks the account and every key again). */
    refresh?: boolean;
}

export interface DoctorService {
    /** The last report a run made; null before the first one. */
    report(): DoctorReport | null;
    running(): boolean;
    /** Gathers what needs the network, then evaluates. Several callers share one run. Never throws. */
    run(options?: DoctorRunOptions): Promise<DoctorReport>;
    /** The checks over what is known now: no network, nothing asked. Never throws. */
    evaluate(): DoctorReport;
    /** The public API's summary (`evaluate()` in short). */
    brief(): DoctorBrief;
    /** Does what a check's `fix` says; the checks are evaluated again right after (no run). Never throws. */
    applyFix(fix: DoctorFix): Promise<DoctorFixResult>;
    /** Called when a run starts or ends and after a fix. */
    onChange(listener: () => void): Unsubscribe;
}

export interface DoctorDeps {
    connections: ConnectionsService;
    plugin: Pick<PluginClient, 'listKeys' | 'checkKey'>;
    profiles: Pick<ProfilesHost, 'available'>;
    account: Pick<AccountStore, 'refresh' | 'detail'>;
    /** A getter: the catalog store is wired in after the context is built. */
    catalog: () => CatalogStore;
    /** The panel, for "open this tab"; null when there is none. */
    panel: () => Pick<PanelApi, 'open'> | null;
    host: Pick<Host, 'ctx'>;
    log: Logger;
    now?: () => number;
    /** ST's version; defaults to `GET /version`. */
    stVersion?: () => Promise<string | null>;
    /** Qvink Memory; defaults to what ST says (host/extensions.ts). */
    qvink?: () => DoctorQvink;
    /** The Management API token is on file (true), absent (false) or not known (null). Defaults to "not known". */
    mgmtToken?: () => boolean | null;
}

export function createDoctorService(deps: DoctorDeps): DoctorService {
    const { connections, plugin, profiles, account, log } = deps;
    const now = deps.now ?? Date.now;
    const readVersion = deps.stVersion ?? (() => readStVersion());
    const qvink = deps.qvink ?? (() => qvinkState(deps.host.ctx));
    const mgmtToken = deps.mgmtToken ?? (() => null);

    let keys: KeyInfo[] | null = null;
    const keyChecks = new Map<string, { check: KeyCheck; at: number }>();
    let version: { value: string | null; at: number } | null = null;
    let last: DoctorReport | null = null;
    let inflight: Promise<DoctorReport> | null = null;
    const listeners = new Set<() => void>();

    function changed(): void {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                log.error('doctor listener failed', error);
            }
        }
    }

    /* --------------------------------------------------------------------------------------------- snapshot */

    function accountInput(): DoctorAccount | null {
        const snapshot = account.detail().snapshot;
        if (snapshot === null) return null;
        const brief = briefOf(snapshot);
        return {
            usdBalance: snapshot.usdBalance,
            subscriptionActive: snapshot.subscription?.active === true,
            dailyUsed: brief.subscription?.dailyUsed ?? null,
            weeklyUsed: brief.subscription?.weeklyUsed ?? null,
        };
    }

    function snapshot(): DoctorInput {
        const catalog = deps.catalog();
        const catalogStatus = catalog.status();
        const state = qvink();
        const checked = connections.checked();
        const up = connections.pluginUp();
        const status = connections.pluginStatus();
        const pluginDown = checked && !up;

        const list: DoctorConnection[] = connections.list().map((entry) => {
            const modelId = entry.config.modelId;
            const model = catalog.model(modelId);
            const providerSelection = catalog.providers(modelId)?.supportsProviderSelection ?? null;
            return {
                config: entry.config,
                effectiveMode: entry.effectiveMode,
                profileState: entry.profileState,
                orphan: entry.orphan,
                pending: entry.pending,
                hasDirectKey: entry.hasDirectKey,
                model,
                providerSelection,
                advice: backgroundAdvice({
                    connection: entry.config,
                    model,
                    // The suggestions are not needed here; an empty list spares sorting the whole catalog per connection.
                    catalog: [],
                    catalogLoaded: catalogStatus.loaded,
                    pluginDown,
                    providerSelection,
                    qvinkInstalled: state === 'present',
                }).issues,
            };
        });

        const keyList: DoctorKey[] | null =
            keys === null
                ? null
                : keys.map((key) => {
                      const done = keyChecks.get(key.id);
                      return {
                          id: key.id,
                          label: key.label,
                          masked: key.masked,
                          check: done ? { ok: done.check.ok, error: done.check.error } : null,
                      };
                  });

        return {
            now: now(),
            plugin: {
                checked,
                up,
                errorCode: connections.pluginError()?.code ?? null,
                version: status?.version ?? null,
                proxy: up && status ? { up: status.proxy.up, port: status.proxy.port } : null,
                secrets: up && status ? status.secrets : null,
            },
            stVersion: version?.value ?? null,
            connectionManager: profiles.available(),
            connections: list,
            keys: keyList,
            catalog: {
                loaded: catalogStatus.loaded,
                count: catalog.models().length,
                fetchedAt: catalogStatus.fetchedAt,
                source: catalogStatus.source,
                error: catalogStatus.error,
            },
            qvink: state,
            mgmtToken: mgmtToken(),
            account: accountInput(),
        };
    }

    function evaluate(): DoctorReport {
        let checks: DoctorCheck[];
        try {
            checks = runChecks(snapshot());
        } catch (error) {
            log.error('the doctor failed', error);
            checks = [failedCheck(error instanceof Error ? error.message : String(error))];
        }
        return { at: now(), checks, summary: summarizeChecks(checks) };
    }

    /* ------------------------------------------------------------------------------------------ gathering */

    /** Runs a step; a failure is logged and the step's part stays "not known". */
    async function attempt(what: string, step: () => Promise<unknown>): Promise<void> {
        try {
            await step();
        } catch (error) {
            log.warn(`doctor: ${what} failed`, error);
        }
    }

    async function loadVersion(force: boolean): Promise<void> {
        const age = version === null ? Infinity : now() - version.at;
        const ttl = version?.value ? VERSION_TTL_MS : VERSION_RETRY_MS;
        if (!force && age < ttl) return;
        version = { value: await readVersion(), at: now() };
    }

    async function loadKeys(): Promise<void> {
        const result = await plugin.listKeys();
        keys = result.ok ? result.data : null;
        if (keys) {
            const ids = new Set(keys.map((key) => key.id));
            for (const id of keyChecks.keys()) if (!ids.has(id)) keyChecks.delete(id);
        }
    }

    async function checkKey(id: string): Promise<boolean> {
        const result = await plugin.checkKey(id);
        if (!result.ok) return false;
        keyChecks.set(id, { check: result.data, at: now() });
        return true;
    }

    async function checkKeys(force: boolean): Promise<void> {
        const stale = (keys ?? []).filter((key) => {
            const done = keyChecks.get(key.id);
            return force || !done || now() - done.at > KEY_CHECK_TTL_MS;
        });
        await Promise.all(stale.map((key) => attempt(`the check of key ${key.id}`, () => checkKey(key.id))));
    }

    async function doRun(options: DoctorRunOptions): Promise<DoctorReport> {
        const force = options.refresh === true;
        try {
            if (force || !connections.checked()) await attempt('the refresh', () => connections.refresh());
            const up = connections.pluginUp();
            await Promise.all([
                attempt('the version read', () => loadVersion(force)),
                attempt('the key list', async () => {
                    if (up) {
                        await loadKeys();
                        await checkKeys(force);
                    } else {
                        // Without the plugin the keys are not known; the checks of a key that is gone mean nothing.
                        keys = null;
                    }
                }),
                attempt('the account', () => account.refresh({ force })),
                attempt('the catalog', () => deps.catalog().refresh(false)),
            ]);
        } catch (error) {
            log.error('the doctor run failed', error);
        }
        last = evaluate();
        return last;
    }

    /* ---------------------------------------------------------------------------------------------- fixes */

    function fromOp(
        result: { ok: true } | { ok: false; error: { code: string; params?: Record<string, string | number> } },
    ): DoctorFixResult {
        if (result.ok) return { ok: true };
        return result.error.params
            ? { ok: false, code: result.error.code, params: result.error.params }
            : { ok: false, code: result.error.code };
    }

    async function applyFix(fix: DoctorFix): Promise<DoctorFixResult> {
        const target = fix.target ?? '';
        try {
            let result: DoctorFixResult;
            switch (fix.action) {
                case 'refresh':
                    if (fix.target === 'catalog') await deps.catalog().refresh(true);
                    else await connections.refresh();
                    result = { ok: true };
                    break;
                case 'repair-profile':
                    if (!target) return { ok: false, code: 'missing_target' };
                    result = fromOp(await connections.repairProfile(target));
                    break;
                case 'switch-direct':
                    if (!target) return { ok: false, code: 'missing_target' };
                    result = fromOp(await connections.switchToDirect(target));
                    break;
                case 'check-key': {
                    if (!target) return { ok: false, code: 'missing_target' };
                    const done = await plugin.checkKey(target);
                    if (!done.ok) {
                        return { ok: false, code: 'plugin_error', params: { message: done.error.message, status: 0 } };
                    }
                    keyChecks.set(target, { check: done.data, at: now() });
                    result = { ok: true };
                    break;
                }
                case 'open-tab': {
                    const panel = deps.panel();
                    if (!panel?.open) return { ok: false, code: 'no_panel' };
                    panel.open(target || undefined);
                    return { ok: true };
                }
            }
            // Whatever the fix changed shows in the checks at once.
            if (!inflight) {
                last = evaluate();
                changed();
            }
            return result;
        } catch (error) {
            log.error(`doctor: the fix ${fix.action} failed`, error);
            return { ok: false, code: 'unexpected', params: { message: error instanceof Error ? error.message : '' } };
        }
    }

    return {
        report: () => last,
        running: () => inflight !== null,

        run(options = {}) {
            if (inflight) return inflight;
            // Started from a microtask, so the run is registered before any of it can end.
            const task: Promise<DoctorReport> = Promise.resolve()
                .then(() => doRun(options))
                .finally(() => {
                    inflight = null;
                    changed();
                });
            inflight = task;
            changed();
            return task;
        },

        evaluate,

        brief(): DoctorBrief {
            const report = evaluate();
            return {
                errors: report.summary.error,
                warnings: report.summary.warn,
                checks: report.checks.map((item) => ({ id: item.id, level: item.level, code: item.code })),
            };
        },

        applyFix,

        onChange(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
}
