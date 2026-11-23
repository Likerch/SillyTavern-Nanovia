// Connection <-> Connection Manager profile sync (docs/ARCHITECTURE.md §5). A Nanovia connection shows up in ST as an
// ordinary Connection Manager profile `{ id, name: 'Nanovia · <name>', mode: 'cc', api: 'custom', model, 'api-url',
// 'secret-id' }` in `extension_settings.connectionManager.profiles`, followed by `saveSettingsDebounced()`.
//
// Only the fields Nanovia manages are written; anything else the user put in the profile (preset, proxy, prompt
// post-processing …) is left as it is. A profile is never written without a `secret-id`: a profile without one would
// send the user's other Custom key to whatever URL it points at.
//
// ST renders Connection Manager's own dropdown once and the extensions' profile pickers (handleDropdown) from the
// CONNECTION_PROFILE_* events, so after a change the CM dropdown is refreshed in place and the events are emitted.
import { PROFILE_NAME_PREFIX } from '../shared/constants';
import type { HostEvents } from './events';
import { isNanoGptUrl, parseProxyUrl } from './targets';
import type { Logger } from './types';

/** Name of a profile for a connection called `name`. */
export function profileName(name: string): string {
    return `${PROFILE_NAME_PREFIX}${name}`;
}

export const PROFILE_API = 'custom';
export const PROFILE_MODE = 'cc';
const CM_EXTENSION = 'connection-manager';

export interface ProfileSpec {
    /** The wanted name, prefix included (see profileName); a counter is appended when another profile has it. */
    name: string;
    model: string;
    /** The proxy URL (plugin mode) or the NanoGPT base (direct mode). */
    apiUrl: string;
    /** ST secret id under `api_key_custom`. Required. */
    secretId: string;
}

export type ProfileResult =
    | { ok: true; profileId: string; created: boolean; changed: boolean }
    | { ok: false; reason: 'unavailable' | 'invalid' };

export interface ProfilesHost {
    /** Connection Manager is installed and enabled. */
    available(): boolean;
    list(): STConnectionProfile[];
    get(profileId: string): STConnectionProfile | null;
    /** Created by Nanovia: its api-url is a Nanovia proxy URL, or it is a NanoGPT profile with our name prefix. */
    isOurs(profile: STConnectionProfile): boolean;
    /** The connection id inside a proxy-mode profile's api-url; null for other profiles. */
    connectionIdOf(profile: STConnectionProfile): string | null;
    /** The managed fields of the profile that differ from `spec` (empty when it matches); null when there is no such profile. */
    drift(profileId: string, spec: ProfileSpec): string[] | null;
    /** Updates the profile `profileId` (when it exists) or creates a new one; the result tells which id to remember. */
    upsert(profileId: string | null, spec: ProfileSpec): Promise<ProfileResult>;
    /** Removes the profile; false when there was none. */
    remove(profileId: string): Promise<boolean>;
}

export interface ProfilesHostDeps {
    ctx: () => STContext;
    events: Pick<HostEvents, 'emit' | 'name'>;
    log: Logger;
    newId?: () => string;
}

interface ManagerSettings {
    profiles: STConnectionProfile[];
    selectedProfile: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The managed fields of `profile` that differ from `spec`. Pure. */
export function profileDrift(profile: STConnectionProfile, spec: ProfileSpec): string[] {
    const out: string[] = [];
    const name = typeof profile.name === 'string' ? profile.name : '';
    if (name !== spec.name && !new RegExp(`^${escapeRegExp(spec.name)} \\(\\d+\\)$`).test(name)) out.push('name');
    if (profile.mode !== PROFILE_MODE) out.push('mode');
    if (profile.api !== PROFILE_API) out.push('api');
    if (profile.model !== spec.model) out.push('model');
    if (profile['api-url'] !== spec.apiUrl) out.push('api-url');
    if (profile['secret-id'] !== spec.secretId) out.push('secret-id');
    return out;
}

function uniqueName(wanted: string, taken: Set<string>): string {
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
        const candidate = `${wanted} (${n})`;
        if (!taken.has(candidate)) return candidate;
    }
}

export function createProfilesHost(deps: ProfilesHostDeps): ProfilesHost {
    const { ctx, events, log } = deps;
    const newId = deps.newId ?? (() => ctx().uuidv4());

    function available(): boolean {
        const disabled = ctx().extensionSettings?.['disabledExtensions'];
        return !(Array.isArray(disabled) && disabled.includes(CM_EXTENSION));
    }

    /** Connection Manager's settings; created when CM is enabled but has not initialised yet (its init keeps what is there). */
    function manager(create: boolean): ManagerSettings | null {
        if (!available()) return null;
        const store = ctx().extensionSettings;
        const value = store['connectionManager'];
        if (isRecord(value) && Array.isArray(value['profiles'])) return value as unknown as ManagerSettings;
        if (!create) return null;
        const fresh: ManagerSettings = { profiles: [], selectedProfile: null };
        store['connectionManager'] = fresh;
        return fresh;
    }

    function valid(profile: unknown): profile is STConnectionProfile {
        return isRecord(profile) && typeof profile['id'] === 'string';
    }

    /** CM renders its profile list once; rebuild it the way CM does so a new profile is selectable without a reload. */
    function syncDropdown(settings: ManagerSettings): void {
        try {
            const doc = globalThis.document as Document | undefined;
            if (!doc) return;
            const select = doc.getElementById('connection_profiles');
            if (!(select instanceof HTMLSelectElement)) return;
            if (select.options.length === 0 || select.options[0]?.value !== '') return;
            const selected = settings.selectedProfile ?? '';
            while (select.options.length > 1) select.remove(1);
            const sorted = settings.profiles
                .filter(valid)
                .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
            for (const profile of sorted) {
                const option = doc.createElement('option');
                option.value = profile.id;
                option.textContent = profile.name ?? profile.id;
                select.appendChild(option);
            }
            select.value = selected;
        } catch (error) {
            log.debug('could not refresh the Connection Manager dropdown', error);
        }
    }

    async function announce(key: string, ...args: unknown[]): Promise<void> {
        if (events.name(key) === undefined) return;
        try {
            await events.emit(key, ...args);
        } catch (error) {
            log.debug(`${key} listeners failed`, error);
        }
    }

    const host: ProfilesHost = {
        available,

        list: () => (manager(false)?.profiles ?? []).filter(valid),

        get: (profileId) =>
            manager(false)?.profiles.find((profile) => valid(profile) && profile.id === profileId) ?? null,

        isOurs(profile) {
            const url = profile['api-url'];
            if (parseProxyUrl(url)) return true;
            return (
                isNanoGptUrl(url) && typeof profile.name === 'string' && profile.name.startsWith(PROFILE_NAME_PREFIX)
            );
        },

        connectionIdOf: (profile) => parseProxyUrl(profile['api-url'])?.connectionId ?? null,

        drift(profileId, spec) {
            const profile = host.get(profileId);
            return profile ? profileDrift(profile, spec) : null;
        },

        async upsert(profileId, spec) {
            if (!spec.secretId || !spec.apiUrl || !spec.model.trim()) return { ok: false, reason: 'invalid' };
            const settings = manager(true);
            if (!settings) return { ok: false, reason: 'unavailable' };
            const existing = profileId
                ? settings.profiles.find((profile) => valid(profile) && profile.id === profileId)
                : undefined;
            const others = settings.profiles.filter((profile) => profile !== existing && valid(profile));
            const name = uniqueName(spec.name, new Set(others.map((profile) => String(profile.name ?? ''))));

            if (existing) {
                const before = structuredClone(existing);
                if (profileDrift(existing, { ...spec, name }).length === 0)
                    return { ok: true, profileId: existing.id, created: false, changed: false };
                existing.name = name;
                existing.mode = PROFILE_MODE;
                existing.api = PROFILE_API;
                existing.model = spec.model;
                existing['api-url'] = spec.apiUrl;
                existing['secret-id'] = spec.secretId;
                if (!Array.isArray(existing.exclude)) existing.exclude = [];
                ctx().saveSettingsDebounced();
                syncDropdown(settings);
                await announce('CONNECTION_PROFILE_UPDATED', before, existing);
                log.debug(`profile «${name}» updated`);
                return { ok: true, profileId: existing.id, created: false, changed: true };
            }

            const profile: STConnectionProfile = {
                id: newId(),
                mode: PROFILE_MODE,
                name,
                api: PROFILE_API,
                model: spec.model,
                'api-url': spec.apiUrl,
                'secret-id': spec.secretId,
                exclude: [],
            };
            settings.profiles.push(profile);
            ctx().saveSettingsDebounced();
            syncDropdown(settings);
            await announce('CONNECTION_PROFILE_CREATED', profile);
            log.debug(`profile «${name}» created`);
            return { ok: true, profileId: profile.id, created: true, changed: true };
        },

        async remove(profileId) {
            const settings = manager(false);
            if (!settings) return false;
            const index = settings.profiles.findIndex((profile) => valid(profile) && profile.id === profileId);
            if (index < 0) return false;
            const [profile] = settings.profiles.splice(index, 1);
            if (settings.selectedProfile === profileId) settings.selectedProfile = null;
            ctx().saveSettingsDebounced();
            syncDropdown(settings);
            if (profile) await announce('CONNECTION_PROFILE_DELETED', profile);
            log.debug(`profile ${profileId} removed`);
            return true;
        },
    };
    return host;
}
