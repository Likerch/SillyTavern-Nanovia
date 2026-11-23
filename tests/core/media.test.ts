// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaStore, isActiveJob } from '../../src/core/media';
import type { MediaStore, MediaStoreDeps } from '../../src/core/media';
import type { UsageStore } from '../../src/core/usage';
import type { PluginResult } from '../../src/host/plugin-client';
import type { UsageRecord } from '../../src/shared/contracts';
import { usageRecord } from '../helpers/account-fake';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { costOf, createMediaFake, mediaModel } from '../helpers/media-fake';
import type { MediaFake } from '../helpers/media-fake';

let h: Harness;
let fake: MediaFake;
let store: MediaStore;
let usage: {
    refresh: ReturnType<typeof vi.fn<UsageStore['refresh']>>;
    ingest: ReturnType<typeof vi.fn<UsageStore['ingest']>>;
};
let recent: ReturnType<typeof vi.fn<(options?: unknown) => Promise<PluginResult<UsageRecord[]>>>>;
let pluginUp = true;
let checked = true;

function make(overrides: Partial<MediaStoreDeps> = {}): MediaStore {
    return createMediaStore({
        media: fake.media,
        usage,
        account: { recent },
        connections: { pluginUp: () => pluginUp, checked: () => checked },
        log: h.log,
        ...overrides,
    });
}

beforeEach(() => {
    h = createHarness();
    fake = createMediaFake(h);
    fake.catalogs.image = [
        mediaModel({ id: 'pony', name: 'Pony', medium: 'image', capabilities: { nsfw: true } }),
        mediaModel({ id: 'flux', name: 'Flux', medium: 'image' }),
    ];
    fake.catalogs.tts = [
        mediaModel({ id: 'Kokoro-82m', name: 'Kokoro', medium: 'tts', voices: ['af_bella'] }),
        mediaModel({ id: 'suno', name: 'Suno', medium: 'tts', capabilities: { music: true } }),
    ];
    fake.catalogs.video = [mediaModel({ id: 'veo3', medium: 'video' })];
    fake.catalogs.stt = [mediaModel({ id: 'asr', medium: 'stt' })];
    usage = { refresh: vi.fn<UsageStore['refresh']>(async () => {}), ingest: vi.fn<UsageStore['ingest']>() };
    recent = vi.fn(async () => ({ ok: true as const, data: [] }));
    pluginUp = true;
    checked = true;
    store = make();
});

afterEach(() => {
    store.dispose();
    vi.useRealTimers();
    h.restore();
});

describe('catalogs', () => {
    it('are empty and idle before the first load', () => {
        expect(store.models('image')).toEqual([]);
        expect(store.model('image', 'pony')).toBeNull();
        expect(store.catalogView('image')).toMatchObject({
            status: 'idle',
            models: [],
            fetchedAt: null,
            source: null,
            error: null,
        });
        expect(store.state()).toBe('idle');
        expect(store.problem()).toBeNull();
    });

    it('load per medium, in memory', async () => {
        const result = await store.ensure('image');
        expect(result.ok && result.data.map((m) => m.id)).toEqual(['pony', 'flux']);
        expect(store.models('image').map((m) => m.id)).toEqual(['pony', 'flux']);
        expect(store.model('image', 'flux')).toMatchObject({ name: 'Flux' });
        expect(store.models('tts')).toEqual([]);
        expect(store.catalogView('image')).toMatchObject({ status: 'ready', source: 'live', error: null });
        expect(store.state()).toBe('ready');
    });

    it('serve a fresh copy from memory and ask again only when forced or expired', async () => {
        let clock = 1000;
        store = make({ now: () => clock, ttlMs: 60_000 });
        await store.ensure('image');
        await store.ensure('image');
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(1);
        clock += 59_000;
        await store.ensure('image');
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(1);
        clock += 2000;
        await store.ensure('image');
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(2);
        await store.ensure('image', { refresh: true });
        expect(fake.callsTo('GET /media/catalog').map((c) => c.path)).toEqual([
            '/media/catalog?medium=image',
            '/media/catalog?medium=image',
            '/media/catalog?medium=image&refresh=1',
        ]);
    });

    it('share one request between callers that ask at the same time', async () => {
        const [a, b] = await Promise.all([store.ensure('tts'), store.ensure('tts')]);
        expect(a).toEqual(b);
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(1);
    });

    it('say where the list came from', async () => {
        fake.source = 'stale';
        await store.ensure('image');
        expect(store.catalogView('image').source).toBe('stale');
    });

    it('notify listeners while loading and when done', async () => {
        const seen: string[] = [];
        store.onChange(() => seen.push(store.catalogView('image').status));
        await store.ensure('image');
        expect(seen[0]).toBe('loading');
        expect(seen.at(-1)).toBe('ready');
    });

    it('select with the shared helpers (speech apart from music)', async () => {
        await store.ensure('tts');
        await store.ensure('image');
        expect(store.select('tts').map((m) => m.id)).toEqual(['Kokoro-82m']);
        expect(store.select('tts', { ttsKind: 'music' }).map((m) => m.id)).toEqual(['suno']);
        expect(store.select('image', { uncensored: true }).map((m) => m.id)).toEqual(['pony']);
        expect(store.select('image', { sort: 'name' }).map((m) => m.id)).toEqual(['flux', 'pony']);
    });
});

describe('failures of a catalog', () => {
    it('keep the earlier models, say why, and do not hammer the plugin', async () => {
        let clock = 1000;
        store = make({ now: () => clock, ttlMs: 10, retryMs: 10_000 });
        await store.ensure('image');
        clock += 100;
        fake.fail.set('GET /media/catalog', { status: 502, code: 'media_unavailable', message: 'no list' });
        const failed = await store.ensure('image');
        expect(failed).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
        expect(store.catalogView('image')).toMatchObject({ status: 'failed', error: { kind: 'unavailable' } });
        expect(store.models('image')).toHaveLength(2);
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(2);
        // Within the retry window the failure is answered from memory.
        clock += 1000;
        await store.ensure('image');
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(2);
        // A forced reload (the retry button) goes out at once, and a good answer clears the failure.
        fake.fail.clear();
        const again = await store.ensure('image', { refresh: true });
        expect(again.ok).toBe(true);
        expect(store.catalogView('image')).toMatchObject({ status: 'ready', error: null });
    });

    it('a plugin that is down is the "plugin_down" state, and it comes back by itself', async () => {
        h.backend.plugin.up = false;
        const result = await store.ensure('image');
        expect(result).toMatchObject({ ok: false, error: { kind: 'plugin_down' } });
        expect(store.state()).toBe('plugin_down');
        expect(store.problem()).toMatchObject({ kind: 'plugin_down' });
        h.backend.plugin.up = true;
        await store.ensure('image', { refresh: true });
        expect(store.state()).toBe('ready');
        expect(store.problem()).toBeNull();
    });

    it('a 404 is "needs the plugin" while the plugin is not known to answer, and "outdated" when it does', async () => {
        fake.hasRoutes = false;
        pluginUp = false;
        await store.ensure('image');
        expect(store.state()).toBe('needs_plugin');
        pluginUp = true;
        expect(store.state()).toBe('plugin_outdated');
        checked = false;
        expect(store.state()).toBe('needs_plugin');
    });

    it('a refused session is "plugin_down" too', async () => {
        fake.fail.set('GET /media/catalog', { status: 403, code: 'forbidden' });
        await store.ensure('image');
        expect(store.state()).toBe('plugin_down');
    });

    it('a call that finds no key says so, and the next good call clears it', async () => {
        await store.ensure('image');
        fake.hasKey = false;
        const result = await store.generateImage({ model: 'pony', prompt: 'p' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'no_key' } });
        expect(store.state()).toBe('no_key');
        expect(store.problem()).toMatchObject({ kind: 'no_key' });
        fake.hasKey = true;
        expect((await store.generateImage({ model: 'pony', prompt: 'p' })).ok).toBe(true);
        expect(store.state()).toBe('ready');
    });

    it('a thrown error from a client never escapes', async () => {
        const broken = make({
            media: {
                ...fake.media,
                catalog: () => {
                    throw new Error('boom');
                },
            },
        });
        expect(await broken.ensure('image')).toMatchObject({ ok: false, error: { kind: 'other', message: 'boom' } });
        broken.dispose();
    });
});

describe('calls', () => {
    it('image: keeps the last result for the studio and asks the usage store to read again', async () => {
        const result = await store.generateImage({ model: 'pony', prompt: 'a cat' });
        expect(result.ok).toBe(true);
        expect(store.last().image).toMatchObject({ model: 'pony', outputs: [{ kind: 'image' }] });
        expect(usage.refresh).toHaveBeenCalledOnce();
        expect(store.last().tts).toBeNull();
    });

    it('does not keep what other callers ask for (the public API, ST’s provider)', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' }, { remember: false });
        await store.speak({ model: 'Kokoro-82m', input: 'Hi' }, { remember: false });
        await store.transcribe(
            { model: 'asr', audioBase64: 'AA', filename: 'a.wav', mime: 'audio/wav' },
            { remember: false },
        );
        expect(store.last()).toEqual({ image: null, tts: null, stt: null });
        expect(usage.refresh).toHaveBeenCalledTimes(3);
    });

    it('speech and transcription keep their results', async () => {
        const spoken = await store.speak({ model: 'Kokoro-82m', input: 'Hello there, friend.' });
        expect(spoken.ok).toBe(true);
        expect(store.last().tts).toMatchObject({ model: 'Kokoro-82m', chars: 20, audio: { mime: 'audio/x-wav' } });
        const heard = await store.transcribe({ model: 'asr', audioBase64: 'AA', filename: 'a.wav', mime: 'audio/wav' });
        expect(heard.ok).toBe(true);
        expect(store.last().stt).toMatchObject({ text: 'Hello, there, friend.' });
    });

    it('a failed call keeps the earlier result and still tells the usage store (the plugin logs most failures)', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        const before = store.last().image;
        fake.fail.set('POST /media/image', { status: 502, code: 'upstream_error', message: 'NanoGPT said no' });
        const result = await store.generateImage({ model: 'pony', prompt: 'b' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'upstream' } });
        expect(store.last().image).toBe(before);
        expect(usage.refresh).toHaveBeenCalledTimes(2);
        // A failure of the call is not a problem of the plugin.
        expect(store.state()).toBe('ready');
    });

    it('does not bother the usage store when the plugin could not be reached', async () => {
        h.backend.plugin.up = false;
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        expect(usage.refresh).not.toHaveBeenCalled();
    });

    it('clearLast forgets one result and tells the listeners', async () => {
        await store.speak({ model: 'Kokoro-82m', input: 'Hi' });
        const changed = vi.fn();
        store.onChange(changed);
        store.clearLast('tts');
        expect(store.last().tts).toBeNull();
        expect(changed).toHaveBeenCalled();
    });

    it('does not double count: the store never writes a usage record itself', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        expect(usage.ingest).not.toHaveBeenCalled();
    });
});

describe('the real cost of an image arrives later', () => {
    const imageCost = costOf({ usd: 0.0017, source: 'response' });

    function corrected(requestId: string): UsageRecord {
        return usageRecord({
            requestId,
            model: 'pony',
            medium: 'image',
            units: 1,
            costUsd: 0.00255,
            costSource: 'lookup',
        });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        fake.cost = imageCost;
        store = make({ reconcileDelaysMs: [20_000, 45_000] });
    });

    it('the figure of the response is a list price until the plugin’s records say otherwise', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        const requestId = store.last().image?.requestId ?? '';
        expect(store.last().image?.cost).toMatchObject({ usd: 0.0017, source: 'response' });

        recent.mockResolvedValue({ ok: true, data: [corrected(requestId)] });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(recent).toHaveBeenCalledWith({ limit: 50 });
        expect(store.last().image?.cost).toMatchObject({ usd: 0.00255, source: 'lookup', paymentSource: 'USD' });
        expect(usage.ingest).toHaveBeenCalledWith([expect.objectContaining({ requestId, costSource: 'lookup' })]);

        // Done: later checks leave it alone.
        recent.mockClear();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(recent).not.toHaveBeenCalled();
    });

    it('asks again later when the correction is not there yet', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        const requestId = store.last().image?.requestId ?? '';
        await vi.advanceTimersByTimeAsync(20_000);
        expect(store.last().image?.cost.source).toBe('response');
        recent.mockResolvedValue({ ok: true, data: [corrected(requestId)] });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(recent).toHaveBeenCalledTimes(2);
        expect(store.last().image?.cost.source).toBe('lookup');
    });

    it('ignores a record that has no correction, another request, and a failed read', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        const requestId = store.last().image?.requestId ?? '';
        recent.mockResolvedValueOnce({
            ok: true,
            data: [usageRecord({ requestId, costSource: 'response' }), corrected('someone-else')],
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(store.last().image?.cost.source).toBe('response');
        recent.mockResolvedValueOnce({ ok: false, error: { code: 'unreachable', message: 'x', status: null } });
        await vi.advanceTimersByTimeAsync(25_000);
        expect(store.last().image?.cost.source).toBe('response');
        expect(usage.ingest).not.toHaveBeenCalled();
    });

    it('stops when the result is cleared or replaced, and when the response already carried a confirmed cost', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        store.clearLast('image');
        await vi.advanceTimersByTimeAsync(100_000);
        expect(recent).not.toHaveBeenCalled();

        fake.cost = costOf({ usd: 0.00255, source: 'lookup' });
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        await vi.advanceTimersByTimeAsync(100_000);
        expect(recent).not.toHaveBeenCalled();
    });

    it('is not started for calls whose result is not kept', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' }, { remember: false });
        await vi.advanceTimersByTimeAsync(100_000);
        expect(recent).not.toHaveBeenCalled();
    });

    it('dispose cancels the checks', async () => {
        await store.generateImage({ model: 'pony', prompt: 'a cat' });
        store.dispose();
        await vi.advanceTimersByTimeAsync(100_000);
        expect(recent).not.toHaveBeenCalled();
    });
});

describe('video jobs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        store = make({ pollMs: 5000 });
    });

    const statusCalls = () => fake.callsTo('GET /media/video/');
    const states = () => store.videos().jobs.map((job) => job.status);

    it('knows an active job from a finished one', () => {
        const job = (status: 'queued' | 'running' | 'completed' | 'failed' | 'expired') =>
            ({ status }) as Parameters<typeof isActiveJob>[0];
        expect([job('queued'), job('running')].every(isActiveJob)).toBe(true);
        expect([job('completed'), job('failed'), job('expired')].some(isActiveJob)).toBe(false);
    });

    it('a submit puts the job first in the list and asks the usage store to read again', async () => {
        const result = await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        expect(result).toMatchObject({ ok: true, data: { id: 'vid_1', status: 'queued' } });
        expect(store.videos()).toMatchObject({ loaded: true, error: null });
        expect(states()).toEqual(['queued']);
        expect(usage.refresh).toHaveBeenCalledOnce();
        await store.startVideo({ model: 'veo3', prompt: 'a knight' });
        expect(store.videos().jobs.map((job) => job.id)).toEqual(['vid_2', 'vid_1']);
    });

    it('reads the plugin’s list', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        const other = createMediaStore({
            media: fake.media,
            usage,
            account: { recent },
            connections: { pluginUp: () => true, checked: () => true },
            log: h.log,
        });
        expect(other.videos()).toMatchObject({ jobs: [], loaded: false });
        await other.refreshVideos();
        expect(other.videos()).toMatchObject({ loaded: true });
        expect(other.videos().jobs.map((job) => job.id)).toEqual(['vid_1']);
        other.dispose();
    });

    it('polls every 5 s while someone watches and a job is unfinished, and stops when none is', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        const stop = store.watchVideos();
        await vi.advanceTimersByTimeAsync(0);
        expect(statusCalls()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(4_900);
        expect(statusCalls()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(statusCalls()).toHaveLength(1);
        expect(states()).toEqual(['running']);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(states()).toEqual(['completed']);
        expect(store.videos().jobs[0]?.output).toMatchObject({ file: 'vid_1' });
        // A finished job is not asked about any more: the timer is gone.
        const calls = statusCalls().length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(statusCalls()).toHaveLength(calls);
        // It was billed when it finished: the usage store is told.
        expect(usage.refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
        stop();
    });

    it('does not poll without a watcher, starts when one comes, and stops when the last one leaves', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(statusCalls()).toHaveLength(0);
        fake.script = ['running'];
        const first = store.watchVideos();
        const second = store.watchVideos();
        await vi.advanceTimersByTimeAsync(10_000);
        // Two watchers share one timer.
        expect(statusCalls()).toHaveLength(2);
        first();
        first();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(statusCalls()).toHaveLength(4);
        second();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(statusCalls()).toHaveLength(4);
    });

    it('survives a plugin that stops answering: the jobs stay, the error shows, polling carries on and recovers', async () => {
        fake.script = ['running'];
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        const stop = store.watchVideos();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(states()).toEqual(['running']);

        h.backend.plugin.up = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(states()).toEqual(['running']);
        expect(store.videos().error).toMatchObject({ kind: 'plugin_down' });
        expect(store.state()).toBe('plugin_down');
        const during = statusCalls().length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(statusCalls().length).toBeGreaterThan(during);

        h.backend.plugin.up = true;
        fake.script = ['completed'];
        await vi.advanceTimersByTimeAsync(5_000);
        expect(states()).toEqual(['completed']);
        expect(store.videos().error).toBeNull();
        expect(store.state()).toBe('ready');
        stop();
    });

    it('drops a job the plugin has forgotten', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        fake.jobs.length = 0;
        const stop = store.watchVideos();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(store.videos().jobs).toEqual([]);
        stop();
    });

    it('reads the list when the first watcher comes', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        const fresh = make({ pollMs: 5000 });
        const stop = fresh.watchVideos();
        await vi.advanceTimersByTimeAsync(0);
        expect(fresh.videos().jobs.map((job) => job.id)).toEqual(['vid_1']);
        stop();
        fresh.dispose();
    });

    it('asks about one job on demand', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'a dragon' });
        const result = await store.videoStatus('vid_1');
        expect(result).toMatchObject({ ok: true, data: { status: 'running' } });
        expect(states()).toEqual(['running']);
        expect(await store.videoStatus('vid_404')).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    });

    it('deleting forgets the job; a job that is already gone is forgotten too; a failure keeps it', async () => {
        await store.startVideo({ model: 'veo3', prompt: 'one' });
        await store.startVideo({ model: 'veo3', prompt: 'two' });
        expect(await store.deleteVideo('vid_1')).toEqual({ ok: true, data: true });
        expect(store.videos().jobs.map((job) => job.id)).toEqual(['vid_2']);
        fake.jobs.length = 0;
        expect(await store.deleteVideo('vid_2')).toMatchObject({ ok: false, error: { kind: 'not_found' } });
        expect(store.videos().jobs).toEqual([]);
        await store.startVideo({ model: 'veo3', prompt: 'three' });
        fake.fail.set('DELETE /media/video', { status: 500, code: 'boom' });
        expect(await store.deleteVideo('vid_3')).toMatchObject({ ok: false });
        expect(store.videos().jobs.map((job) => job.id)).toEqual(['vid_3']);
    });

    it('a failed submit adds no job', async () => {
        fake.fail.set('POST /media/video', { status: 402, code: 'insufficient_balance', message: 'required: 2.5' });
        const result = await store.startVideo({ model: 'veo3', prompt: 'x' });
        expect(result).toMatchObject({ ok: false, error: { kind: 'insufficient_balance', requiredUsd: 2.5 } });
        expect(store.videos().jobs).toEqual([]);
    });

    it('dispose stops the timer', async () => {
        fake.script = ['running'];
        await store.startVideo({ model: 'veo3', prompt: 'x' });
        store.watchVideos();
        await vi.advanceTimersByTimeAsync(5_000);
        store.dispose();
        const calls = statusCalls().length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(statusCalls()).toHaveLength(calls);
    });
});

describe('with real timers', () => {
    it('resolves the plugin down state through the harness without hanging', async () => {
        h.backend.plugin.up = false;
        await store.ensure('video');
        await flush();
        expect(store.catalogView('video').status).toBe('failed');
    });
});
