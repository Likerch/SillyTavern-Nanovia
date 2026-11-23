// @vitest-environment happy-dom
// NANOVIA_API.doctor: the checks of the Diagnostics tab for other extensions (stage 0.6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiPublisher } from '../../src/app/api';
import type { ApiPublisher } from '../../src/app/api';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const globals = globalThis as unknown as Record<string, unknown>;

let h: Harness;
let tc: TestContext;
let publisher: ApiPublisher | undefined;

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
});

afterEach(() => {
    publisher?.dispose();
    publisher = undefined;
    delete globals[NANOVIA_API_GLOBAL];
    h.restore();
});

function publish(withDoctor: boolean): NanoviaApi {
    publisher = createApiPublisher({
        version: '1.2.3',
        features: () => ['connections'],
        connections: h.connections,
        profiles: h.profiles,
        settings: h.settings,
        log: h.log,
        ...(withDoctor ? { doctor: tc.ctx.doctor } : {}),
    });
    publisher.publish();
    return publisher.api;
}

describe('NANOVIA_API.doctor', () => {
    it('is listed and present only when the Doctor is installed', () => {
        const without = publish(false);
        expect(without.features).not.toContain('doctor');
        expect(without.doctor).toBeUndefined();
        publisher?.dispose();

        const api = publish(true);
        expect(api.features).toContain('doctor');
        expect(typeof api.doctor).toBe('function');
    });

    it('answers at once with the errors, the warnings and the checks (codes only)', async () => {
        const saved = await h.connections.save({
            patch: { name: 'Chat', modelId: 'vendor/model', mode: 'plugin' },
        });
        expect(saved.ok).toBe(true);
        const api = publish(true);
        const brief = api.doctor?.();
        // The plugin answered, there is a connection and no key was loaded: nothing about keys is said yet.
        expect(brief?.errors).toBe(0);
        expect(brief?.warnings).toBe(0);
        expect(brief?.checks).toContainEqual({ id: 'plugin_ok', level: 'ok', code: 'plugin_ok' });
        expect(brief?.checks.map((item) => item.code)).not.toContain('keys_ok');
        expect(brief?.checks.map((item) => item.code)).not.toContain('no_keys');
        for (const item of brief?.checks ?? []) expect(Object.keys(item).sort()).toEqual(['code', 'id', 'level']);
    });

    it('follows what the Diagnostics tab has learned', async () => {
        await h.connections.save({ patch: { name: 'Chat', modelId: 'vendor/model', mode: 'plugin' } });
        const api = publish(true);
        expect(api.doctor?.().checks.map((item) => item.code)).not.toContain('no_keys');
        await tc.ctx.doctor.run();
        expect(api.doctor?.().errors).toBe(1);
        expect(api.doctor?.().checks.map((item) => item.code)).toContain('no_keys');
    });

    it('is a plain function: no network, so it can be called from anywhere', () => {
        const api = publish(true);
        const before = h.backend.calls.length;
        api.doctor?.();
        expect(h.backend.calls.length).toBe(before);
    });
});
