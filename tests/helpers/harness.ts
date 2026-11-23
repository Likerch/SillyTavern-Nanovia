// The browser-side stack over fakes: ST mock, a fake plugin + secret store, and the real services on top.
import { createBus } from '../../src/core/bus';
import { createConnectionsService } from '../../src/core/connections';
import type { ConnectionsService } from '../../src/core/connections';
import { Settings } from '../../src/core/settings';
import { createHostEvents } from '../../src/host/events';
import { createPluginClient } from '../../src/host/plugin-client';
import type { PluginClient } from '../../src/host/plugin-client';
import { createProfilesHost } from '../../src/host/profiles';
import type { ProfilesHost } from '../../src/host/profiles';
import { createSecretsHost } from '../../src/host/secrets';
import type { SecretsHost } from '../../src/host/secrets';
import { createFakeBackend } from './fake-backend';
import type { FakeBackend } from './fake-backend';
import { memoryLogger } from './fakes';
import type { MemoryLogger } from './fakes';
import { installStMock, seedConnectionManager } from './st-mock';
import type { StMock } from './st-mock';

export interface Harness {
    mock: StMock;
    backend: FakeBackend;
    log: MemoryLogger;
    settings: Settings;
    plugin: PluginClient;
    profiles: ProfilesHost;
    secrets: SecretsHost;
    connections: ConnectionsService;
    bus: ReturnType<typeof createBus>;
    /** Connection Manager's settings object. */
    manager: { profiles: STConnectionProfile[]; selectedProfile: string | null };
    changes: number;
    restore(): void;
}

export function createHarness(options: { connectionManager?: boolean } = {}): Harness {
    const mock = installStMock();
    const backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    mock.fetchImpl = backend.fetch;
    const manager = seedConnectionManager(mock);
    if (options.connectionManager === false) mock.extensionSettings['disabledExtensions'] = ['connection-manager'];
    const log = memoryLogger();
    const settings = new Settings(
        () => mock.extensionSettings,
        () => mock.context.saveSettingsDebounced(),
        log,
    );
    const plugin = createPluginClient({
        ctx: () => mock.context,
        log,
        fetchImpl: backend.fetch,
        ttlMs: 0,
        timeoutMs: 200,
    });
    const profiles = createProfilesHost({
        ctx: () => mock.context,
        events: createHostEvents(() => mock.context, log),
        log,
    });
    const secrets = createSecretsHost({ ctx: () => mock.context, log, fetchImpl: backend.fetch });
    const bus = createBus(log);
    let next = 0;
    let clock = 1_800_000_000_000;
    const connections = createConnectionsService({
        settings,
        plugin,
        profiles,
        secrets,
        bus,
        log,
        now: () => ++clock,
        newId: () => `loc${String(++next).padStart(5, '0')}`,
    });
    const harness: Harness = {
        mock,
        backend,
        log,
        settings,
        plugin,
        profiles,
        secrets,
        connections,
        bus,
        manager,
        changes: 0,
        restore: () => mock.restore(),
    };
    connections.onChange(() => void harness.changes++);
    return harness;
}
