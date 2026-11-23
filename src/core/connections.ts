// The live list of connections and everything that changes it (docs/ARCHITECTURE.md §1, §5).
//
// Source of truth: the plugin's store when it answers. The browser keeps a mirror of the configs in its settings (so the
// panel and the Connection Manager profiles still make sense when the plugin is down) and is the only home of
// direct-mode connections, which the plugin never sees. Rules:
//   - plugin answers: its list wins; the mirror is overwritten with it;
//   - a connection edited while the plugin was down is `pending`: on the next refresh it is sent to the plugin first
//     (the one exception to "plugin wins", so an offline edit is not silently lost);
//   - a Connection Manager profile follows its connection (created on save, repaired when it drifts) but is never
//     recreated behind the user's back after they deleted it, and never repointed while the plugin is down;
//   - there is no silent fallback to direct mode: only an explicit save or "switch to direct" writes a direct profile.
// Keys never pass through here except once, from the form to ST's secret store; only the secret id is remembered.
import { createConnection, mergeConnection } from '../domain/connection';
import { isPluginDown, profileName } from '../host';
import type { PluginClient, PluginError, ProfilesHost, SecretsHost } from '../host';
import { NANOGPT_API_BASE, SECRET_LABEL_PREFIX } from '../shared/constants';
import type { ApiStatus, ConnectionConfig, ConnectionSummary, ConnectionView } from '../shared/contracts';
import type { Bus, Logger, SettingsService, Unsubscribe } from './types';

export type EffectiveMode = 'plugin' | 'direct';

/** auto = the plugin when it answers, otherwise direct. */
export function effectiveMode(mode: ConnectionConfig['mode'], pluginUp: boolean): EffectiveMode {
    if (mode === 'plugin') return 'plugin';
    if (mode === 'direct') return 'direct';
    return pluginUp ? 'plugin' : 'direct';
}

export type ProfileState =
    /** The profile exists and matches the connection. */
    | 'linked'
    /** The profile exists but differs (renamed, repointed by hand …). */
    | 'drifted'
    /** A profile was linked once and is gone. */
    | 'missing'
    /** No profile yet, and one can be created. */
    | 'none'
    /** No profile yet, and one cannot be created: the connection has no token (plugin) or no key (direct). */
    | 'blocked'
    /** Connection Manager is not installed or disabled. */
    | 'unavailable';

export interface ConnectionEntry {
    config: ConnectionConfig;
    /** What the plugin last said about it (proxy URL, token secret); null when it never did in this session. */
    view: ConnectionView | null;
    effectiveMode: EffectiveMode;
    profileId: string | null;
    profileState: ProfileState;
    /** A direct-mode key is on file (its secret id is remembered). */
    hasDirectKey: boolean;
    /** Edited while the plugin was down; will be sent on the next refresh. */
    pending: boolean;
    /** Not on the plugin although its mode needs it there (the plugin lost it, or it was made while the plugin was down). */
    orphan: boolean;
}

export interface OpIssue {
    /** Mapped to text by the UI (`connections.error.<code>` / `connections.warning.<code>`). */
    code: string;
    params?: Record<string, string | number>;
}

export type OpResult<T = null> = { ok: true; data: T; warnings: OpIssue[] } | { ok: false; error: OpIssue };

export interface SaveInput {
    /** Set when editing; a new connection otherwise (then `name` and `modelId` are required). */
    id?: string;
    patch: Partial<ConnectionConfig>;
    /** The NanoGPT key, typed once for a direct connection. Written to ST's secret store and forgotten. */
    directKey?: string;
}

export interface ConnectionsService {
    list(): readonly ConnectionEntry[];
    get(id: string): ConnectionEntry | null;
    /** Whether `/status` answered the last time we asked. */
    pluginUp(): boolean;
    pluginStatus(): ApiStatus | null;
    /** Why the plugin is down, null when it is up (or never asked). */
    pluginError(): PluginError | null;
    /** Asks the plugin again and rebuilds the list; never throws. */
    refresh(): Promise<void>;
    save(input: SaveInput): Promise<OpResult<{ id: string }>>;
    remove(id: string): Promise<OpResult>;
    rotateToken(id: string): Promise<OpResult>;
    /** Sets the connection to direct mode (asking for the key when none is on file). */
    switchToDirect(id: string, directKey?: string): Promise<OpResult>;
    /** Puts a connection that is not on the plugin onto it. */
    sendToPlugin(id: string): Promise<OpResult>;
    /** Creates or repairs the Connection Manager profile of the connection. */
    repairProfile(id: string): Promise<OpResult>;
    summaries(): ConnectionSummary[];
    onChange(listener: () => void): Unsubscribe;
}

export interface ConnectionsDeps {
    settings: SettingsService;
    plugin: PluginClient;
    profiles: ProfilesHost;
    secrets: SecretsHost;
    bus: Bus;
    log: Logger;
    now?: () => number;
    newId?: () => string;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh connection id, [a-z0-9]{10}. */
export function randomConnectionId(length = 10): string {
    const bytes = new Uint8Array(length);
    if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    let id = '';
    for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    return id;
}

/** The ConnectionConfig inside a plugin view. */
export function configOf(view: ConnectionView): ConnectionConfig {
    const { proxyUrl: _proxyUrl, directUrl: _directUrl, tokenSecretId: _tokenSecretId, ...config } = view;
    return config;
}

/** A config as a patch for the plugin: everything it lets the browser set. */
function patchOf(config: ConnectionConfig): Partial<ConnectionConfig> {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...patch } = config;
    return patch;
}

function fail(code: string, params?: Record<string, string | number>): { ok: false; error: OpIssue } {
    return { ok: false, error: params ? { code, params } : { code } };
}

function pluginFailure(error: PluginError): { ok: false; error: OpIssue } {
    return isPluginDown(error)
        ? fail('plugin_down')
        : fail('plugin_error', { message: error.message, status: error.status ?? 0 });
}

export function createConnectionsService(deps: ConnectionsDeps): ConnectionsService {
    const { settings, plugin, profiles, secrets, bus, log } = deps;
    const now = deps.now ?? Date.now;
    const newId = deps.newId ?? (() => randomConnectionId());

    let up = false;
    let status: ApiStatus | null = null;
    let error: PluginError | null = null;
    /** Views the plugin sent, by connection id. Survives a failed refresh, so a short outage keeps the proxy URLs. */
    const views = new Map<string, ConnectionView>();
    let entries: ConnectionEntry[] = [];
    const listeners = new Set<() => void>();

    // Operations run one after another: a refresh must not interleave with a save.
    let queue: Promise<unknown> = Promise.resolve();
    let refreshing: Promise<void> | null = null;

    function run<T>(task: () => Promise<T>): Promise<T> {
        // Profiles and secrets change behind our back (Connection Manager's own UI); look at them fresh each time.
        const fresh = (): Promise<T> => {
            rebuild();
            return task();
        };
        const result = queue.then(fresh, fresh);
        queue = result.catch(() => undefined);
        return result;
    }

    /* ------------------------------------------------------------------------------- profile specs and state */

    function specFor(config: ConnectionConfig, mode: EffectiveMode) {
        const view = views.get(config.id) ?? null;
        if (mode === 'plugin') {
            if (!view?.tokenSecretId) return null;
            return {
                name: profileName(config.name),
                model: config.modelId,
                apiUrl: view.proxyUrl,
                secretId: view.tokenSecretId,
            };
        }
        const secretId = settings.get().directSecrets[config.id];
        if (!secretId) return null;
        return {
            name: profileName(config.name),
            model: config.modelId,
            apiUrl: view?.directUrl ?? NANOGPT_API_BASE,
            secretId,
        };
    }

    function profileStateOf(config: ConnectionConfig, mode: EffectiveMode): ProfileState {
        if (!profiles.available()) return 'unavailable';
        const spec = specFor(config, mode);
        const profileId = settings.get().profiles[config.id];
        if (!profileId) return spec ? 'none' : 'blocked';
        if (!profiles.get(profileId)) return 'missing';
        if (!spec) return 'linked';
        return (profiles.drift(profileId, spec)?.length ?? 0) > 0 ? 'drifted' : 'linked';
    }

    /** Rebuilds `entries` from the mirror and what the plugin said. */
    function rebuild(): void {
        const s = settings.get();
        const byId = new Map<string, ConnectionConfig>();
        for (const config of s.mirror) byId.set(config.id, config);
        const next: ConnectionEntry[] = [];
        for (const config of byId.values()) {
            const view = views.get(config.id) ?? null;
            const mode = effectiveMode(config.mode, up);
            const profileId = s.profiles[config.id] ?? null;
            next.push({
                config,
                view,
                effectiveMode: mode,
                profileId: profileId && profiles.get(profileId) ? profileId : null,
                profileState: profileStateOf(config, mode),
                hasDirectKey: Boolean(s.directSecrets[config.id]),
                pending: s.pending.includes(config.id),
                orphan: up && view === null && config.mode !== 'direct' && !s.pending.includes(config.id),
            });
        }
        next.sort((a, b) => a.config.name.localeCompare(b.config.name) || a.config.id.localeCompare(b.config.id));
        entries = next;
    }

    function changed(): void {
        rebuild();
        void bus.emit('connections:changed', { count: entries.length });
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (err) {
                log.error('connections listener failed', err);
            }
        }
    }

    /* ------------------------------------------------------------------------------------------- bookkeeping */

    /** Replaces (or adds) the mirror entry of `config`. */
    function putMirror(config: ConnectionConfig): void {
        settings.update((s) => {
            const index = s.mirror.findIndex((item) => item.id === config.id);
            if (index >= 0) s.mirror[index] = config;
            else s.mirror.push(config);
        }, 'mirror');
    }

    function rekey(from: string, to: string): void {
        if (from === to) return;
        settings.update((s) => {
            s.mirror = s.mirror.filter((item) => item.id !== from);
            for (const map of [s.profiles, s.directSecrets]) {
                const value = map[from];
                if (value !== undefined) {
                    map[to] = value;
                    delete map[from];
                }
            }
            s.pending = s.pending.map((id) => (id === from ? to : id));
        });
        const view = views.get(from);
        if (view) views.delete(from);
    }

    function setPending(id: string, pending: boolean): void {
        const s = settings.get();
        if (s.pending.includes(id) === pending) return;
        settings.update((draft) => {
            draft.pending = pending ? [...draft.pending, id] : draft.pending.filter((item) => item !== id);
        }, 'pending');
    }

    /** Writes the Connection Manager profile of a connection and remembers its id. */
    async function syncProfile(config: ConnectionConfig, mode: EffectiveMode): Promise<OpIssue | null> {
        if (!profiles.available()) return { code: 'profile_unavailable' };
        const spec = specFor(config, mode);
        if (!spec) return { code: mode === 'plugin' ? 'profile_needs_token' : 'profile_needs_key' };
        const result = await profiles.upsert(settings.get().profiles[config.id] ?? null, spec);
        if (!result.ok) return { code: result.reason === 'unavailable' ? 'profile_unavailable' : 'profile_failed' };
        if (settings.get().profiles[config.id] !== result.profileId) {
            settings.update((s) => {
                s.profiles[config.id] = result.profileId;
            }, 'profiles');
        }
        return null;
    }

    /* ----------------------------------------------------------------------------------------------- refresh */

    /** Sends the connections edited while the plugin was down. */
    async function pushPending(): Promise<void> {
        for (const id of [...settings.get().pending]) {
            const local = settings.get().mirror.find((item) => item.id === id);
            if (!local) {
                setPending(id, false);
                continue;
            }
            const known = views.get(id);
            if (known) {
                const result = await plugin.updateConnection(id, patchOf(local));
                if (result.ok) {
                    views.set(id, result.data);
                    setPending(id, false);
                } else log.warn(`could not send the edit of connection ${id} to the plugin: ${result.error.code}`);
            } else if (local.mode !== 'direct') {
                const result = await plugin.createConnection({ ...local });
                if (result.ok) {
                    rekey(id, result.data.id);
                    views.set(result.data.id, result.data);
                    setPending(result.data.id, false);
                } else log.warn(`could not create connection ${id} on the plugin: ${result.error.code}`);
            } else {
                setPending(id, false);
            }
        }
    }

    /** Makes the mirror equal to the plugin's list plus the connections only the browser has. */
    function syncMirror(): void {
        const next: ConnectionConfig[] = [];
        const seen = new Set<string>();
        const { pending, mirror } = settings.get();
        for (const view of views.values()) {
            // An edit that could not be sent yet stays as the user made it.
            const local = pending.includes(view.id) ? mirror.find((item) => item.id === view.id) : undefined;
            next.push(local ?? configOf(view));
            seen.add(view.id);
        }
        for (const config of settings.get().mirror) if (!seen.has(config.id)) next.push(config);
        if (JSON.stringify(next) === JSON.stringify(settings.get().mirror)) return;
        settings.update((s) => {
            s.mirror = next;
        }, 'mirror');
    }

    /** Brings profiles that drifted back in line (name, model, URL, secret). Never creates one. */
    async function reconcileProfiles(): Promise<void> {
        if (!profiles.available()) return;
        for (const config of settings.get().mirror) {
            const profileId = settings.get().profiles[config.id];
            if (!profileId || !profiles.get(profileId)) continue;
            const spec = specFor(config, effectiveMode(config.mode, true));
            if (!spec) continue;
            if ((profiles.drift(profileId, spec)?.length ?? 0) === 0) continue;
            const result = await profiles.upsert(profileId, spec);
            if (!result.ok) log.warn(`could not repair the profile of connection ${config.id}: ${result.reason}`);
        }
    }

    async function doRefresh(): Promise<void> {
        const state = await plugin.status();
        if (!state.ok) {
            up = false;
            status = null;
            error = state.error;
        } else {
            const list = await plugin.listConnections();
            if (list.ok) {
                up = true;
                status = state.data;
                error = null;
                views.clear();
                for (const view of list.data) views.set(view.id, view);
                await pushPending();
                syncMirror();
                await reconcileProfiles();
            } else {
                up = false;
                status = state.data;
                error = list.error;
            }
        }
        void bus.emit('plugin:status', { up, status });
        changed();
    }

    /* ------------------------------------------------------------------------------------------- operations */

    async function doSave(input: SaveInput): Promise<OpResult<{ id: string }>> {
        const existing = input.id ? (entries.find((entry) => entry.config.id === input.id) ?? null) : null;
        if (input.id && !existing) return fail('not_found');
        const patch = input.patch;

        const name = typeof patch.name === 'string' ? patch.name.trim() : (existing?.config.name ?? '');
        const modelId = typeof patch.modelId === 'string' ? patch.modelId.trim() : (existing?.config.modelId ?? '');
        if (!name) return fail('invalid', { field: 'name' });
        if (!modelId) return fail('invalid', { field: 'modelId' });

        const pluginUp = await plugin.available({ fresh: true });
        up = pluginUp;
        const modeAfter = patch.mode ?? existing?.config.mode ?? 'auto';
        if (modeAfter === 'plugin' && !pluginUp) return fail('plugin_down');

        const typedKey = input.directKey?.trim() ?? '';
        const knownSecret = existing ? settings.get().directSecrets[existing.config.id] : undefined;
        const needsKey = modeAfter === 'direct' || (!existing && modeAfter === 'auto' && !pluginUp);
        if (needsKey && !typedKey && !knownSecret) return fail('direct_key_required');

        const draft = existing
            ? mergeConnection(existing.config, { ...patch, name, modelId }, now())
            : createConnection({ ...patch, name, modelId }, newId(), now());
        const warnings: OpIssue[] = [];

        // 1. The key first: it is the step that is easiest to undo.
        let newSecret: string | null = null;
        if (typedKey) {
            const written = await secrets.write(typedKey, `${SECRET_LABEL_PREFIX}${draft.name} (direct)`);
            if (!written.ok) return fail('key_write_failed', { message: written.error });
            newSecret = written.id;
        }
        const undoKey = async (): Promise<void> => {
            if (newSecret) await secrets.remove(newSecret);
        };

        // 2. The plugin, when the connection belongs there.
        let config = draft;
        const onPlugin = existing?.view != null;
        // The plugin may know it (or should): a direct connection that never had another mode lives in the browser only.
        const mayBeOnPlugin = modeAfter !== 'direct' || (existing !== null && existing.config.mode !== 'direct');
        if (pluginUp && (modeAfter !== 'direct' || onPlugin)) {
            const result = onPlugin
                ? await plugin.updateConnection(draft.id, patchOf(draft))
                : await plugin.createConnection({ ...draft });
            if (!result.ok) {
                await undoKey();
                return pluginFailure(result.error);
            }
            views.set(result.data.id, result.data);
            config = configOf(result.data);
            if (result.data.id !== draft.id) {
                if (existing) rekey(draft.id, result.data.id);
                views.delete(draft.id);
            }
        } else if (!pluginUp && mayBeOnPlugin) {
            // Send it when the plugin is back.
            warnings.push({ code: 'saved_locally' });
        }

        // 3. Remember it.
        putMirror(config);
        setPending(config.id, !pluginUp && mayBeOnPlugin);
        if (newSecret) {
            const old = settings.get().directSecrets[config.id];
            settings.update((s) => {
                s.directSecrets[config.id] = newSecret as string;
            }, 'directSecrets');
            if (old && old !== newSecret) await secrets.remove(old);
        }

        // 4. The profile. A connection that already has one and merely cannot rewrite it now (the plugin is down and no
        // direct key is on file) keeps the profile it has; that is not worth a warning.
        const issue = await syncProfile(config, effectiveMode(config.mode, pluginUp));
        const keepsProfile = Boolean(settings.get().profiles[config.id]);
        if (issue && !(keepsProfile && (issue.code === 'profile_needs_key' || issue.code === 'profile_needs_token'))) {
            warnings.push(issue);
        }

        changed();
        return { ok: true, data: { id: config.id }, warnings };
    }

    async function doRemove(id: string): Promise<OpResult> {
        const entry = entries.find((item) => item.config.id === id);
        if (!entry) return fail('not_found');
        if (entry.config.mode !== 'direct') {
            const answering = await plugin.available({ fresh: true });
            up = answering;
            if (!answering) return fail('plugin_down');
            // Asked even when this session never saw the connection on the plugin: it may be there all the same.
            const result = await plugin.deleteConnection(id);
            if (!result.ok && result.error.code !== 'not_found') return pluginFailure(result.error);
        }
        const warnings: OpIssue[] = [];
        views.delete(id);
        const s = settings.get();
        const profileId = s.profiles[id];
        const secretId = s.directSecrets[id];
        if (profileId) await profiles.remove(profileId);
        if (secretId && !(await secrets.remove(secretId))) warnings.push({ code: 'key_not_removed' });
        settings.update((draft) => {
            draft.mirror = draft.mirror.filter((item) => item.id !== id);
            draft.pending = draft.pending.filter((item) => item !== id);
            delete draft.profiles[id];
            delete draft.directSecrets[id];
        });
        changed();
        return { ok: true, data: null, warnings };
    }

    async function doRotate(id: string): Promise<OpResult> {
        const entry = entries.find((item) => item.config.id === id);
        if (!entry) return fail('not_found');
        if (!entry.view) return fail('not_on_plugin');
        const result = await plugin.rotateToken(id);
        if (!result.ok) return pluginFailure(result.error);
        views.set(id, result.data);
        const warnings: OpIssue[] = [];
        const config = configOf(result.data);
        putMirror(config);
        // The profile must carry the new token only if it points at the proxy.
        if (settings.get().profiles[id] && effectiveMode(config.mode, true) === 'plugin') {
            const issue = await syncProfile(config, 'plugin');
            if (issue) warnings.push(issue);
        }
        changed();
        return { ok: true, data: null, warnings };
    }

    async function doRepair(id: string): Promise<OpResult> {
        const entry = entries.find((item) => item.config.id === id);
        if (!entry) return fail('not_found');
        const issue = await syncProfile(entry.config, entry.effectiveMode);
        changed();
        return issue ? fail(issue.code, issue.params) : { ok: true, data: null, warnings: [] };
    }

    /* ------------------------------------------------------------------------------------------------ service */

    function summaryOf(entry: ConnectionEntry): ConnectionSummary {
        return {
            id: entry.config.id,
            name: entry.config.name,
            modelId: entry.config.modelId,
            mode: entry.config.mode,
            effectiveMode: entry.effectiveMode,
            billing: entry.config.billing,
            profileId: entry.profileId,
        };
    }

    rebuild();

    return {
        list() {
            rebuild();
            return entries;
        },
        get(id) {
            rebuild();
            return entries.find((entry) => entry.config.id === id) ?? null;
        },
        pluginUp: () => up,
        pluginStatus: () => status,
        pluginError: () => error,

        refresh(): Promise<void> {
            if (refreshing) return refreshing;
            refreshing = run(doRefresh)
                .catch((err: unknown) => {
                    log.error('refresh failed', err);
                })
                .finally(() => {
                    refreshing = null;
                });
            return refreshing;
        },

        save: (input) => run(() => doSave(input)),
        remove: (id) => run(() => doRemove(id)),
        rotateToken: (id) => run(() => doRotate(id)),
        repairProfile: (id) => run(() => doRepair(id)),
        switchToDirect: (id, directKey) =>
            run(async () => {
                const result = await doSave({ id, patch: { mode: 'direct' }, directKey });
                return result.ok ? { ok: true as const, data: null, warnings: result.warnings } : result;
            }),
        sendToPlugin: (id) =>
            run(async () => {
                const result = await doSave({ id, patch: {} });
                return result.ok ? { ok: true as const, data: null, warnings: result.warnings } : result;
            }),

        summaries() {
            rebuild();
            return entries.map(summaryOf);
        },

        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
