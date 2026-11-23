// NanoGPT's Management API as the browser knows it (stage 0.6): whether a Management token is stored and accepted, the
// inference keys it manages (with their limits) and the model presets. Everything goes through the plugin (the API has no
// CORS), so without the plugin the honest state is "needs the plugin".
//
// The token is write-only here too: `saveToken(token)` hands the value to the plugin and forgets it; nothing in this store
// holds a token, and `detail()` / `brief()` carry only the status (present, valid, when it was checked).
// Reads are cached for 30 s; a write is followed by a reload of the list it changed (mutate-then-reload), so the view
// always shows what NanoGPT says, not what we hoped. Nothing here throws: an operation resolves to a MgmtResult.
import { isMgmtPluginDown } from '../host';
import type { MgmtError, MgmtResult, PluginMgmt } from '../host';
import type { MgmtBrief } from '../shared/contracts';
import type {
    KeyCreateInput,
    KeyLimitsPatch,
    ManagedKey,
    ManagedKeyCreated,
    MgmtStatus,
    ModelPreset,
    PresetCreateInput,
    PresetInput,
} from '../shared/contracts-mgmt';
import type { ConnectionsService } from './connections';
import type { Logger, Unsubscribe } from './types';

export const MGMT_TTL_MS = 30_000;
/** After a failed refresh a non-forced `refresh()` waits this long before asking again. */
export const MGMT_RETRY_MS = 10_000;

export type MgmtState =
    /** Nothing asked yet. */
    | 'idle'
    /** The plugin is not installed (or not loaded): Management is reached by it only. */
    | 'needs_plugin'
    /** The plugin answers but does not know the Management routes: an older plugin version. */
    | 'plugin_outdated'
    /** The plugin is installed but does not answer (or ST refused the session). */
    | 'plugin_down'
    /** The plugin is fine and holds no Management token. */
    | 'no_token'
    /** NanoGPT rejected the stored token (revoked, expired, mistyped). */
    | 'token_invalid'
    /** A token is stored and NanoGPT has not rejected it (valid, or not verified yet). */
    | 'ready'
    /** The status could not be read for another reason: see `error`. */
    | 'error';

export interface MgmtListView<T> {
    /** The last good list; null before the first answer (and after the token changed). */
    items: T[] | null;
    fetchedAt: number | null;
    loading: boolean;
    /** Why the last load failed (the items, if any, are older than they should be). */
    error: MgmtError | null;
}

export interface MgmtDetail {
    state: MgmtState;
    /** What the plugin last said about the token; null before the first answer. */
    status: MgmtStatus | null;
    /** Why the status could not be read (plugin trouble); null when it could. */
    error: MgmtError | null;
    /** The status is being read. */
    fetching: boolean;
    keys: MgmtListView<ManagedKey>;
    presets: MgmtListView<ModelPreset>;
}

export interface MgmtStore {
    detail(): MgmtDetail;
    /** What `NANOVIA_API.mgmt.status()` hands out. Never asks. */
    brief(): MgmtBrief;
    /** Reads the status once when nothing is known yet (throttled); for callers that only peek at `brief()`. Never throws. */
    warm(): void;
    /**
     * Reads the status and, when a token is there, both lists. Served from the 30 s cache unless `force`. Never throws.
     */
    refresh(options?: { force?: boolean }): Promise<MgmtDetail>;
    /** Reads only the status; `verify` has the plugin ask NanoGPT once and store the verdict. */
    refreshStatus(options?: { verify?: boolean }): Promise<void>;
    refreshKeys(): Promise<void>;
    refreshPresets(): Promise<void>;
    /**
     * Sends the token to the plugin once; it is not kept. On success the status is the new one and both lists are read
     * again (in the background). `force` stores a token NanoGPT could not confirm (never one it rejected).
     */
    saveToken(token: string, options?: { force?: boolean }): Promise<MgmtResult<MgmtStatus>>;
    deleteToken(): Promise<MgmtResult<true>>;
    createKey(input: KeyCreateInput): Promise<MgmtResult<ManagedKeyCreated>>;
    updateKey(id: string, patch: KeyLimitsPatch): Promise<MgmtResult<ManagedKey>>;
    revokeKey(id: string): Promise<MgmtResult<true>>;
    createPreset(input: PresetCreateInput): Promise<MgmtResult<ModelPreset>>;
    replacePreset(name: string, input: PresetInput): Promise<MgmtResult<ModelPreset>>;
    deletePreset(name: string): Promise<MgmtResult<true>>;
    onChange(listener: () => void): Unsubscribe;
}

export interface MgmtStoreDeps {
    mgmt: PluginMgmt;
    /** Tells "not installed" from "installed but too old" (the plugin answers, the Management routes do not). */
    connections: Pick<ConnectionsService, 'pluginUp' | 'checked'>;
    log: Logger;
    now?: () => number;
    ttlMs?: number;
    retryMs?: number;
}

interface Slot<T> {
    items: T[] | null;
    fetchedAt: number | null;
    loading: boolean;
    error: MgmtError | null;
    /** Bumped by every load; an answer of an older load is dropped. */
    generation: number;
}

function emptySlot<T>(): Slot<T> {
    return { items: null, fetchedAt: null, loading: false, error: null, generation: 0 };
}

function viewOf<T>(slot: Slot<T>): MgmtListView<T> {
    return {
        items: slot.items ? [...slot.items] : null,
        fetchedAt: slot.fetchedAt,
        loading: slot.loading,
        error: slot.error,
    };
}

export function createMgmtStore(deps: MgmtStoreDeps): MgmtStore {
    const { mgmt, connections, log } = deps;
    const now = deps.now ?? Date.now;
    const ttl = deps.ttlMs ?? MGMT_TTL_MS;
    const retry = deps.retryMs ?? MGMT_RETRY_MS;

    let status: MgmtStatus | null = null;
    let statusError: MgmtError | null = null;
    let statusGeneration = 0;
    let fetching = 0;
    const keys = emptySlot<ManagedKey>();
    const presets = emptySlot<ModelPreset>();
    let freshAt: number | null = null;
    let failedAt: number | null = null;
    let warmedAt: number | null = null;
    let inflight: Promise<void> | null = null;
    const listeners = new Set<() => void>();

    function changed(): void {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                log.error('mgmt listener failed', error);
            }
        }
    }

    function stateNow(): MgmtState {
        if (statusError) {
            if (statusError.kind === 'not_installed') {
                return connections.checked() && connections.pluginUp() ? 'plugin_outdated' : 'needs_plugin';
            }
            if (statusError.kind === 'plugin_down' || statusError.kind === 'forbidden') return 'plugin_down';
            return 'error';
        }
        if (status === null) return 'idle';
        if (!status.present) return 'no_token';
        if (status.valid === false) return 'token_invalid';
        return 'ready';
    }

    function detail(): MgmtDetail {
        return {
            state: stateNow(),
            status,
            error: statusError,
            fetching: fetching > 0,
            keys: viewOf(keys),
            presets: viewOf(presets),
        };
    }

    function forgetLists(): void {
        for (const slot of [keys, presets]) {
            slot.generation++;
            slot.items = null;
            slot.fetchedAt = null;
            slot.loading = false;
            slot.error = null;
        }
        freshAt = null;
        failedAt = null;
    }

    /** A failed call may say something about the token or the plugin that the whole panel should know. */
    function noteFailure(error: MgmtError): void {
        if (isMgmtPluginDown(error)) {
            statusError = error;
            return;
        }
        // NanoGPT rejected the token or none is stored: the plugin has noted it; read the status it holds now.
        if (error.kind === 'token_invalid' || error.kind === 'token_missing') void refreshStatus();
    }

    /** A call got through: the plugin is there, and (if a token was used) NanoGPT knows it. */
    function noteSuccess(): void {
        let again = false;
        if (statusError) {
            statusError = null;
            again = true;
        }
        if (status === null || (status.present && status.valid !== true)) again = true;
        if (again) void refreshStatus();
    }

    async function refreshStatus(options?: { verify?: boolean }): Promise<void> {
        const mine = ++statusGeneration;
        fetching++;
        changed();
        try {
            const result = await mgmt.status(options?.verify ? { verify: true } : undefined);
            if (mine !== statusGeneration) return;
            if (result.ok) {
                status = result.data;
                statusError = null;
                if (!status.present) forgetLists();
            } else {
                statusError = result.error;
                log.debug(`mgmt status failed: ${result.error.kind}`);
            }
        } catch (error) {
            // The client never throws; a fake or a future change might.
            log.error('mgmt status failed', error);
            if (mine === statusGeneration) {
                statusError = {
                    kind: 'other',
                    code: 'unreachable',
                    message: 'the status could not be read',
                    status: null,
                };
            }
        } finally {
            fetching--;
            changed();
        }
    }

    async function load<T>(
        slot: Slot<T>,
        ask: () => Promise<MgmtResult<{ items: T[]; fetchedAt: number }>>,
        what: string,
    ): Promise<void> {
        const mine = ++slot.generation;
        slot.loading = true;
        changed();
        let result: MgmtResult<{ items: T[]; fetchedAt: number }>;
        try {
            result = await ask();
        } catch (error) {
            log.error(`mgmt ${what} failed`, error);
            result = {
                ok: false,
                error: { kind: 'other', code: 'unreachable', message: `the ${what} could not be read`, status: null },
            };
        }
        // A newer load (or a token change) owns the slot now.
        if (mine !== slot.generation) return;
        slot.loading = false;
        if (result.ok) {
            slot.items = result.data.items;
            slot.fetchedAt = result.data.fetchedAt;
            slot.error = null;
            noteSuccess();
        } else {
            slot.error = result.error;
            failedAt = now();
            log.debug(`mgmt ${what} failed: ${result.error.kind}`);
            noteFailure(result.error);
        }
        changed();
    }

    function refreshKeys(): Promise<void> {
        return load(
            keys,
            async () => {
                const result = await mgmt.listKeys();
                return result.ok
                    ? { ok: true, data: { items: result.data.keys, fetchedAt: result.data.fetchedAt } }
                    : result;
            },
            'key list',
        );
    }

    function refreshPresets(): Promise<void> {
        return load(
            presets,
            async () => {
                const result = await mgmt.listPresets();
                return result.ok
                    ? { ok: true, data: { items: result.data.presets, fetchedAt: result.data.fetchedAt } }
                    : result;
            },
            'preset list',
        );
    }

    function refresh(options?: { force?: boolean }): Promise<MgmtDetail> {
        const force = options?.force === true;
        if (inflight) return inflight.then(detail);
        if (!force) {
            if (freshAt !== null && now() - freshAt < ttl && stateNow() === 'ready') return Promise.resolve(detail());
            if (failedAt !== null && now() - failedAt < retry) return Promise.resolve(detail());
        }
        const run: Promise<void> = (async () => {
            await refreshStatus();
            // Lists are read only for a token NanoGPT has not rejected; before that, the calls could only fail.
            if (stateNow() === 'ready') await Promise.all([refreshKeys(), refreshPresets()]);
            const failed = stateNow() !== 'ready' || keys.error !== null || presets.error !== null;
            if (failed) failedAt = now();
            else {
                freshAt = now();
                failedAt = null;
            }
        })()
            .catch((error: unknown) => log.error('mgmt refresh failed', error))
            .finally(() => {
                if (inflight === run) inflight = null;
                changed();
            });
        inflight = run;
        return run.then(detail);
    }

    /** One write, then a reload of the list it changed (also after a failure that may have changed it). */
    async function mutate<T>(
        call: () => Promise<MgmtResult<T>>,
        reload: () => Promise<void>,
        reloadOnError?: (error: MgmtError) => boolean,
    ): Promise<MgmtResult<T>> {
        const result = await call();
        if (result.ok) {
            noteSuccess();
            await reload();
        } else {
            noteFailure(result.error);
            if (reloadOnError?.(result.error)) await reload();
            changed();
        }
        return result;
    }

    return {
        detail,

        brief: () => ({ present: status?.present ?? false, valid: status?.valid ?? null }),

        warm() {
            if (status !== null || fetching > 0) return;
            if (warmedAt !== null && now() - warmedAt < ttl) return;
            warmedAt = now();
            void refreshStatus();
        },

        refresh,
        refreshStatus,
        refreshKeys,
        refreshPresets,

        async saveToken(token, options) {
            const result = await mgmt.saveToken(token, options);
            // `token` goes out of scope with this call; only the status it produced stays.
            if (result.ok) {
                status = result.data;
                statusError = null;
                statusGeneration++;
                forgetLists();
                // A refresh that was already under way belongs to the old token.
                inflight = null;
                changed();
                void refresh({ force: true });
            } else {
                // The new token was refused; what NanoGPT said about it says nothing about the one stored.
                if (isMgmtPluginDown(result.error)) statusError = result.error;
                changed();
            }
            return result;
        },

        async deleteToken() {
            const result = await mgmt.deleteToken();
            if (result.ok) {
                status = { present: false, valid: null, checkedAt: null, error: null };
                statusError = null;
                statusGeneration++;
                forgetLists();
            } else {
                noteFailure(result.error);
            }
            changed();
            return result;
        },

        createKey: (input) =>
            // A key made but not stored (secrets_failed) exists at NanoGPT: the list must show it so it can be revoked.
            mutate(
                () => mgmt.createKey(input),
                refreshKeys,
                (error) => error.kind === 'secrets_failed',
            ),

        updateKey: (id, patch) => mutate(() => mgmt.updateKey(id, patch), refreshKeys),

        revokeKey: (id) =>
            // A key that is already gone (404) is the state the user wanted: show the list as it is.
            mutate(
                () => mgmt.revokeKey(id),
                refreshKeys,
                (error) => error.kind === 'not_found',
            ),

        createPreset: (input) => mutate(() => mgmt.createPreset(input), refreshPresets),

        replacePreset: (name, input) => mutate(() => mgmt.replacePreset(name, input), refreshPresets),

        deletePreset: (name) => mutate(() => mgmt.deletePreset(name), refreshPresets),

        onChange(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
}
