// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiPublisher } from '../../src/app/api';
import type { ApiPublisher } from '../../src/app/api';
import { NANOVIA_API_GLOBAL, NANOVIA_API_READY_EVENT } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

const globals = globalThis as unknown as Record<string, unknown>;

let h: Harness;
let publisher: ApiPublisher;

beforeEach(() => {
    h = createHarness();
    publisher = createApiPublisher({
        version: '1.2.3',
        features: () => ['connections'],
        connections: h.connections,
        profiles: h.profiles,
        settings: h.settings,
        log: h.log,
    });
});

afterEach(() => {
    publisher.dispose();
    delete globals[NANOVIA_API_GLOBAL];
    h.restore();
});

describe('NANOVIA_API publication', () => {
    it('installs version 1 on globalThis and announces it', () => {
        const ready = vi.fn();
        window.addEventListener(NANOVIA_API_READY_EVENT, ready);
        expect(globals[NANOVIA_API_GLOBAL]).toBeUndefined();
        publisher.publish();
        window.removeEventListener(NANOVIA_API_READY_EVENT, ready);

        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api).toBe(publisher.api);
        expect(ready).toHaveBeenCalledOnce();
        expect((ready.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ version: 1 });
        expect(api.version).toBe(1);
        expect(api.nanoviaVersion).toBe('1.2.3');
        expect(api.features).toEqual(['connections']);
        expect(typeof api.connections).toBe('function');
        expect(typeof api.describeProfile).toBe('function');
        expect(Object.keys(api).sort()).toEqual([
            'connections',
            'describeProfile',
            'features',
            'nanoviaVersion',
            'version',
        ]);
    });

    it('is removed on dispose, but only when it is still ours', () => {
        publisher.publish();
        publisher.dispose();
        expect(globals[NANOVIA_API_GLOBAL]).toBeUndefined();
        publisher.publish();
        const other = { version: 1 };
        globals[NANOVIA_API_GLOBAL] = other;
        publisher.dispose();
        expect(globals[NANOVIA_API_GLOBAL]).toBe(other);
    });
});

describe('connections()', () => {
    it('lists the connections as summaries', async () => {
        expect(publisher.api.connections()).toEqual([]);
        const saved = await h.connections.save({
            patch: { name: 'Main', modelId: 'deepseek/deepseek-v4', mode: 'plugin', billing: 'subscription' },
        });
        if (!saved.ok) throw new Error('save failed');
        expect(publisher.api.connections()).toEqual([
            {
                id: saved.data.id,
                name: 'Main',
                modelId: 'deepseek/deepseek-v4',
                mode: 'plugin',
                effectiveMode: 'plugin',
                billing: 'subscription',
                profileId: h.manager.profiles[0]?.id,
            },
        ]);
    });
});

describe('describeProfile()', () => {
    async function connection(mode: 'plugin' | 'direct' = 'plugin') {
        const saved = await h.connections.save({
            patch: {
                name: 'Main',
                modelId: 'm',
                mode,
                billing: 'paygo',
                reasoning: { policy: 'fixed', effort: 'high', hideThoughts: true },
            },
            directKey: mode === 'direct' ? 'sk-nano-key-0001' : undefined,
        });
        if (!saved.ok) throw new Error('save failed');
        return { id: saved.data.id, profileId: h.manager.profiles[0]!.id };
    }

    it('describes the connection behind a profile Nanovia made', async () => {
        const { id, profileId } = await connection();
        expect(publisher.api.describeProfile(profileId)).toEqual({
            connectionId: id,
            name: 'Main',
            modelId: 'm',
            reasoning: { policy: 'fixed', effort: 'high', hideThoughts: true },
            billing: 'paygo',
            capabilities: null,
        });
    });

    it('works for a direct connection too', async () => {
        const { id, profileId } = await connection('direct');
        expect(publisher.api.describeProfile(profileId)?.connectionId).toBe(id);
    });

    it('finds the connection by the proxy URL when the stored link is missing', async () => {
        const { id, profileId } = await connection();
        h.settings.update((s) => {
            s.profiles = {};
        });
        expect(publisher.api.describeProfile(profileId)?.connectionId).toBe(id);
    });

    it('answers null for a profile that is not a Nanovia connection', async () => {
        await connection();
        h.manager.profiles.push({ id: 'foreign', name: 'My OpenAI', api: 'openai', model: 'gpt' });
        h.manager.profiles.push({ id: 'dangling', name: 'x', 'api-url': 'http://127.0.0.1:8787/c/zzzzzzzz/v1' });
        expect(publisher.api.describeProfile('foreign')).toBeNull();
        expect(publisher.api.describeProfile('dangling')).toBeNull();
        expect(publisher.api.describeProfile('nope')).toBeNull();
        expect(publisher.api.describeProfile('')).toBeNull();
        expect(publisher.api.describeProfile(undefined as unknown as string)).toBeNull();
    });

    it('hands out a copy of the reasoning config', async () => {
        const { profileId } = await connection();
        const description = publisher.api.describeProfile(profileId)!;
        description.reasoning.policy = 'off';
        expect(publisher.api.describeProfile(profileId)?.reasoning.policy).toBe('fixed');
    });
});
