// `globalThis.NANOVIA_API` (src/shared/contracts.ts `NanoviaApi`): what Maestro and the other extensions feature-detect.
// `version` stays 1 and members are only ever added. The object is installed once the app is up, announced with the
// `nanovia-api-ready` event on `window`, and removed again when Nanovia is disabled.
import type { AccountStore } from '../core/account';
import { backgroundAdvice, canDisableReasoning, qvinkInstalled as detectQvink } from '../core/advice';
import type { CatalogStore } from '../core/catalog';
import type { ConnectionEntry, ConnectionsService } from '../core/connections';
import type { Logger, SettingsService } from '../core/types';
import type { UsageStore } from '../core/usage';
import { parseProxyUrl } from '../host';
import type { ProfilesHost } from '../host';
import { NANOVIA_API_GLOBAL, NANOVIA_API_READY_EVENT } from '../shared/constants';
import type { BackgroundAdvice, CatalogModel, NanoviaApi, ProfileDescription } from '../shared/contracts';

export interface ApiDeps {
    version: string;
    /** Ids of the features that are running (`NANOVIA_API.features` starts with them). */
    features: () => string[];
    connections: ConnectionsService;
    profiles: ProfilesHost;
    settings: SettingsService;
    log: Logger;
    /** Without a catalog every model is "unknown" (capabilities null). */
    catalog?: CatalogStore;
    /** Installed: `api.usage` and the feature 'usage'. */
    usage?: UsageStore;
    /** Installed: `api.account` and the feature 'account'. */
    account?: AccountStore;
    /** Installed: `api.openPanel` and the feature 'panel'. */
    panel?: { open(tab?: string): void };
    /** Replaced in tests; defaults to looking for Qvink's global interceptor. */
    qvinkInstalled?: () => boolean;
}

export interface ApiPublisher {
    readonly api: NanoviaApi;
    publish(): void;
    dispose(): void;
}

function capabilitiesOf(model: CatalogModel | null): ProfileDescription['capabilities'] {
    if (!model) return null;
    return {
        reasoning: model.capabilities.reasoning,
        reasoningEfforts: [...model.reasoningEfforts],
        canDisableReasoning: canDisableReasoning(model),
        structuredOutput: model.capabilities.structuredOutput,
        toolCalling: model.capabilities.toolCalling,
        vision: model.capabilities.vision,
    };
}

export function createApiPublisher(deps: ApiDeps): ApiPublisher {
    const { connections, profiles, settings, catalog, usage, account, panel, log } = deps;
    const qvinkInstalled = deps.qvinkInstalled ?? detectQvink;

    /** The connection a Connection Manager profile belongs to: by the id we stored, then by a proxy URL it carries. */
    function connectionIdOf(profileId: string): string | null {
        for (const [connectionId, linked] of Object.entries(settings.get().profiles)) {
            if (linked === profileId) return connectionId;
        }
        const profile = profiles.get(profileId);
        return profile ? profiles.connectionIdOf(profile) : null;
    }

    function entryOfProfile(profileId: unknown): ConnectionEntry | null {
        if (typeof profileId !== 'string' || !profileId) return null;
        const id = connectionIdOf(profileId);
        return id ? connections.get(id) : null;
    }

    function describe(entry: ConnectionEntry): ProfileDescription {
        const { config } = entry;
        return {
            connectionId: config.id,
            name: config.name,
            modelId: config.modelId,
            reasoning: { ...config.reasoning },
            billing: config.billing,
            capabilities: capabilitiesOf(catalog?.model(config.modelId) ?? null),
        };
    }

    function describeProfile(profileId: string): ProfileDescription | null {
        const entry = entryOfProfile(profileId);
        return entry ? describe(entry) : null;
    }

    function describeUrl(apiUrl: string): ProfileDescription | null {
        const target = parseProxyUrl(apiUrl);
        const entry = target ? connections.get(target.connectionId) : null;
        return entry ? describe(entry) : null;
    }

    function backgroundProfile(profileId: string): BackgroundAdvice | null {
        const entry = entryOfProfile(profileId);
        if (!entry) return null;
        const modelId = entry.config.modelId;
        return backgroundAdvice({
            connection: entry.config,
            model: catalog?.model(modelId) ?? null,
            catalog: catalog?.models() ?? [],
            catalogLoaded: catalog?.status().loaded ?? false,
            pluginDown: connections.checked() && !connections.pluginUp(),
            providerSelection: catalog?.providers(modelId)?.supportsProviderSelection ?? null,
            qvinkInstalled: qvinkInstalled(),
        });
    }

    /** What is really installed, for feature detection: the running panel features plus the API's own members. */
    function featureList(): string[] {
        const list = [...deps.features(), 'describeProfile', 'describeUrl'];
        if (usage) list.push('usage');
        if (account) list.push('account');
        list.push('advice');
        if (panel) list.push('panel');
        return [...new Set(list)];
    }

    const api: NanoviaApi = {
        version: 1,
        nanoviaVersion: deps.version,
        features: featureList(),
        connections: () => connections.summaries(),
        describeProfile,
        describeUrl,
        advice: { backgroundProfile },
    };
    if (usage) {
        api.usage = {
            today: () => usage.today(),
            recent: (limit) => usage.recent(limit),
            onRecord: (listener) => usage.onRecord(listener),
        };
    }
    if (account) {
        api.account = { snapshot: () => account.snapshot(), refresh: () => account.refresh() };
    }
    if (panel) {
        api.openPanel = (tab) => {
            try {
                panel.open(typeof tab === 'string' && tab ? tab : undefined);
            } catch (error) {
                log.warn('could not open the panel', error);
            }
        };
    }

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
