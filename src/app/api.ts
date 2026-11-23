// `globalThis.NANOVIA_API` (src/shared/contracts.ts `NanoviaApi`): what Maestro and the other extensions feature-detect.
// `version` stays 1 and members are only ever added. The object is installed once the app is up, announced with the
// `nanovia-api-ready` event on `window`, and removed again when Nanovia is disabled.
import type { ConnectionsService } from '../core/connections';
import type { Logger, SettingsService } from '../core/types';
import type { ProfilesHost } from '../host';
import { NANOVIA_API_GLOBAL, NANOVIA_API_READY_EVENT } from '../shared/constants';
import type { NanoviaApi, ProfileDescription } from '../shared/contracts';

export interface ApiDeps {
    version: string;
    /** Ids of the features that are running (`NANOVIA_API.features`). */
    features: () => string[];
    connections: ConnectionsService;
    profiles: ProfilesHost;
    settings: SettingsService;
    log: Logger;
}

export interface ApiPublisher {
    readonly api: NanoviaApi;
    publish(): void;
    dispose(): void;
}

export function createApiPublisher(deps: ApiDeps): ApiPublisher {
    const { connections, profiles, settings, log } = deps;

    /** The connection a Connection Manager profile belongs to: by the id we stored, then by a proxy URL it carries. */
    function connectionIdOf(profileId: string): string | null {
        for (const [connectionId, linked] of Object.entries(settings.get().profiles)) {
            if (linked === profileId) return connectionId;
        }
        const profile = profiles.get(profileId);
        return profile ? profiles.connectionIdOf(profile) : null;
    }

    function describeProfile(profileId: string): ProfileDescription | null {
        if (typeof profileId !== 'string' || !profileId) return null;
        const id = connectionIdOf(profileId);
        const entry = id ? connections.get(id) : null;
        if (!entry) return null;
        const { config } = entry;
        return {
            connectionId: config.id,
            name: config.name,
            modelId: config.modelId,
            reasoning: { ...config.reasoning },
            billing: config.billing,
            // The catalog arrives with stage 0.3.
            capabilities: null,
        };
    }

    const api: NanoviaApi = {
        version: 1,
        nanoviaVersion: deps.version,
        features: deps.features(),
        connections: () => connections.summaries(),
        describeProfile,
    };

    const holder = globalThis as unknown as Record<string, unknown>;

    return {
        api,

        publish(): void {
            holder[NANOVIA_API_GLOBAL] = api;
            try {
                if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
                    window.dispatchEvent(new CustomEvent(NANOVIA_API_READY_EVENT, { detail: { version: 1 } }));
                }
            } catch (error) {
                log.warn('could not announce NANOVIA_API', error);
            }
        },

        dispose(): void {
            if (holder[NANOVIA_API_GLOBAL] === api) delete holder[NANOVIA_API_GLOBAL];
        },
    };
}
