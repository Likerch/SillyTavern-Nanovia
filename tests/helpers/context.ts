// A real FeatureContext over the test harness (fake ST, fake plugin), for tests of tabs and features.
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { FeatureContext } from '../../src/core/context';
import { createI18n } from '../../src/core/i18n';
import type { Locale } from '../../src/core/types';
import { createHost } from '../../src/host';
import { CONNECTIONS_STRINGS } from '../../src/features/connections/strings';
import { UI_STRINGS } from '../../src/ui/strings';
import type { Harness } from './harness';

export interface TestContext {
    ctx: FeatureContext;
    setLocale(locale: Locale): void;
}

export function createContext(h: Harness, initial: Locale = 'en'): TestContext {
    let locale: Locale = initial;
    const i18n = createI18n(() => locale);
    i18n.register(UI_STRINGS);
    i18n.register(CONNECTIONS_STRINGS);
    const host = createHost(h.log);
    const ctx: FeatureContext = {
        version: '0.0.0-test',
        host,
        settings: h.settings,
        plugin: h.plugin,
        connections: h.connections,
        catalog: createEmptyCatalogStore(),
        profiles: h.profiles,
        secrets: h.secrets,
        registerRequestHook: () => () => {},
        panel: { registerTab: () => () => {} },
        i18n,
        t: i18n.t.bind(i18n),
        bus: h.bus,
        log: h.log,
    };
    return { ctx, setLocale: (value) => void (locale = value) };
}
