// @vitest-environment happy-dom
// NANOVIA_API.mgmt (stage 0.6): what other extensions may learn about the Management token, and nothing more.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiPublisher } from '../../src/app/api';
import type { ApiPublisher } from '../../src/app/api';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const globals = globalThis as unknown as Record<string, unknown>;

let h: Harness;
let tc: TestContext;
let publisher: ApiPublisher;

function publish(withMgmt: boolean): ApiPublisher {
    return createApiPublisher({
        version: '1.2.3',
        features: () => ['connections'],
        connections: h.connections,
        profiles: h.profiles,
        settings: h.settings,
        log: h.log,
        ...(withMgmt ? { mgmt: tc.mgmt } : {}),
    });
}

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
});

afterEach(() => {
    publisher.dispose();
    delete globals[NANOVIA_API_GLOBAL];
    h.restore();
});

describe('NANOVIA_API.mgmt', () => {
    it('is absent, and not listed, when the store is not installed', () => {
        publisher = publish(false);
        expect(publisher.api.mgmt).toBeUndefined();
        expect(publisher.api.features).not.toContain('mgmt');
    });

    it('is listed once installed', () => {
        publisher = publish(true);
        expect(publisher.api.features).toContain('mgmt');
        expect(typeof publisher.api.mgmt?.status).toBe('function');
    });

    it('says nothing is stored before the first answer, then what the plugin said', async () => {
        publisher = publish(true);
        tc.mgmtFake.storeToken('sk-nano-mgmt-TESTTOKEN', true);
        // Nothing was read yet: the honest sync answer, and a read starts in the background.
        expect(publisher.api.mgmt?.status()).toEqual({ present: false, valid: null });
        await flush();
        await flush();
        expect(publisher.api.mgmt?.status()).toEqual({ present: true, valid: true });
    });

    it('hands out only present and valid: no token, no checked time, no error, no keys', async () => {
        publisher = publish(true);
        tc.mgmtFake.storeToken('sk-nano-mgmt-TESTTOKEN', false);
        tc.mgmtFake.addKey({ name: 'Secret-ish' });
        await tc.mgmt.refresh();
        const brief = publisher.api.mgmt?.status();
        expect(brief).toEqual({ present: true, valid: false });
        expect(Object.keys(brief ?? {}).sort()).toEqual(['present', 'valid']);
        expect(JSON.stringify(brief)).not.toContain('TESTTOKEN');
    });
});
