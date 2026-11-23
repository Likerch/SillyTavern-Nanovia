// A real FeatureContext over the test harness (fake ST, fake plugin), for tests of tabs and features.
import { createAccountStore } from '../../src/core/account';
import type { AccountStore } from '../../src/core/account';
import { createEmptyCatalogStore } from '../../src/core/catalog';
import type { FeatureContext } from '../../src/core/context';
import { createDoctorService } from '../../src/core/doctor';
import type { DoctorDeps } from '../../src/core/doctor';
import { createI18n } from '../../src/core/i18n';
import { createMediaStore } from '../../src/core/media';
import type { MediaStore } from '../../src/core/media';
import { createMgmtStore } from '../../src/core/mgmt';
import type { MgmtStore } from '../../src/core/mgmt';
import type { Locale } from '../../src/core/types';
import { createUsageStore } from '../../src/core/usage';
import type { UsageStore } from '../../src/core/usage';
import { createHost } from '../../src/host';
import { ACCOUNT_STRINGS } from '../../src/features/account/strings';
import { CONNECTIONS_STRINGS } from '../../src/features/connections/strings';
import { UI_STRINGS } from '../../src/ui/strings';
import { createAccountFake } from './account-fake';
import type { AccountFake } from './account-fake';
import type { Harness } from './harness';
import { createMediaFake } from './media-fake';
import type { MediaFake } from './media-fake';
import { createMgmtFake } from './mgmt-fake';
import type { MgmtFake } from './mgmt-fake';

export interface TestContext {
    ctx: FeatureContext;
    setLocale(locale: Locale): void;
    /** The stage 0.4 routes of the fake plugin (balance, subscription, spend, lookup). */
    fake: AccountFake;
    usage: UsageStore;
    account: AccountStore;
    /** The stage 0.6 routes of the fake plugin (Management token, keys, presets). */
    mgmtFake: MgmtFake;
    mgmt: MgmtStore;
    /** The stage 0.7 routes of the fake plugin (media catalogs, image, speech, transcription, video jobs). */
    mediaFake: MediaFake;
    media: MediaStore;
}

/**
 * `doctor` overrides what the Doctor service reads from outside the harness (ST's version, Qvink, the Management token).
 * By default ST is new enough, Qvink is absent and the Management token is not known.
 */
export function createContext(
    h: Harness,
    initial: Locale = 'en',
    doctor: Partial<Pick<DoctorDeps, 'stVersion' | 'qvink' | 'mgmtToken' | 'now'>> = {},
): TestContext {
    let locale: Locale = initial;
    const i18n = createI18n(() => locale);
    i18n.register(UI_STRINGS);
    i18n.register(CONNECTIONS_STRINGS);
    i18n.register(ACCOUNT_STRINGS);
    const host = createHost(h.log);
    const fake = createAccountFake(h);
    const usage = createUsageStore({ bus: h.bus, account: fake.account, connections: h.connections, log: h.log });
    const account = createAccountStore({ account: fake.account, connections: h.connections, log: h.log });
    const doctorService = createDoctorService({
        connections: h.connections,
        plugin: h.plugin,
        profiles: h.profiles,
        account,
        catalog: () => ctx.catalog,
        panel: () => ctx.panel,
        host,
        log: h.log,
        stVersion: async () => '1.19.0',
        qvink: () => 'absent',
        ...doctor,
    });
    const mgmtFake = createMgmtFake(h);
    const mgmt = createMgmtStore({ mgmt: mgmtFake.mgmt, connections: h.connections, log: h.log });
    const mediaFake = createMediaFake(h);
    const media = createMediaStore({
        media: mediaFake.media,
        usage,
        account: fake.account,
        connections: h.connections,
        log: h.log,
    });
    const ctx: FeatureContext = {
        version: '0.0.0-test',
        host,
        settings: h.settings,
        plugin: h.plugin,
        connections: h.connections,
        catalog: createEmptyCatalogStore(),
        usage,
        account,
        doctor: doctorService,
        mgmt,
        media,
        profiles: h.profiles,
        secrets: h.secrets,
        registerRequestHook: () => () => {},
        panel: { registerTab: () => () => {} },
        i18n,
        t: i18n.t.bind(i18n),
        bus: h.bus,
        log: h.log,
    };
    return { ctx, setLocale: (value) => void (locale = value), fake, usage, account, mgmtFake, mgmt, mediaFake, media };
}
