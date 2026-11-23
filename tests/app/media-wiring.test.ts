// @vitest-environment happy-dom
// Stage 0.7 wiring: the media store reaches the tabs through the context, the tab sits between «Management» and «Account»,
// and NANOVIA_API.media answers from the same store without leaving traces in the studios.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startNanovia } from '../../src/app/app';
import type { Runtime } from '../../src/app/app';
import { NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { NanoviaApi } from '../../src/shared/contracts';
import type { MediaApi } from '../../src/shared/contracts-media';
import { createFakeBackend } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { flush, memoryLogger } from '../helpers/fakes';
import type { Harness } from '../helpers/harness';
import { createMediaFake, mediaModel } from '../helpers/media-fake';
import type { MediaFake } from '../helpers/media-fake';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

const globals = globalThis as unknown as Record<string, unknown>;

let mock: StMock;
let backend: FakeBackend;
let fake: MediaFake;
let runtime: Runtime | null;

beforeEach(() => {
    mock = installStMock();
    backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    mock.fetchImpl = backend.fetch;
    seedConnectionManager(mock);
    fake = createMediaFake({ backend, mock, log: memoryLogger() } as unknown as Harness);
    mock.fetchImpl = fake.fetch;
    fake.catalogs.image = [mediaModel({ id: 'rev-animated', name: 'Rev Animated', medium: 'image' })];
    fake.catalogs.tts = [mediaModel({ id: 'Kokoro-82m', medium: 'tts', voices: ['af_bella'] })];
    fake.catalogs.stt = [mediaModel({ id: 'asr', medium: 'stt' })];
    fake.catalogs.video = [mediaModel({ id: 'veo3', medium: 'video' })];
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    runtime = null;
});

afterEach(async () => {
    await runtime?.stop();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

async function start(): Promise<MediaApi> {
    runtime = await startNanovia({ skipInitialRefresh: true });
    const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
    expect(api.media).toBeDefined();
    return api.media as MediaApi;
}

describe('media in the running app', () => {
    it('adds the tab between Management and Account, and the feature to the public API', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        const tabs = runtime.panel.tabIds();
        expect(tabs).toContain('media');
        expect(tabs.indexOf('mgmt')).toBeLessThan(tabs.indexOf('media'));
        expect(tabs.indexOf('media')).toBeLessThan(tabs.indexOf('account'));
        const api = globals[NANOVIA_API_GLOBAL] as NanoviaApi;
        expect(api.features).toContain('media');
        expect(api.version).toBe(1);
    });

    it('opening the tab draws it and loads the first catalog from the plugin', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        runtime.panel.select('media');
        for (let i = 0; i < 5; i++) await flush();
        const body = document.querySelector('#nanovia-settings .nanovia-tab-body');
        // The test ST reports a Russian UI: the tab speaks Russian.
        expect(body?.textContent).toContain('Медиа NanoGPT');
        expect(body?.textContent).toContain('Rev Animated');
        expect(fake.callsTo('GET /media/catalog').map((call) => call.path)).toEqual(['/media/catalog?medium=image']);
    });

    it('hands the store to the tabs through the context', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        expect(typeof runtime.ctx.media.ensure).toBe('function');
        await runtime.ctx.media.ensure('stt');
        expect(runtime.ctx.media.models('stt').map((model) => model.id)).toEqual(['asr']);
    });

    it('the ST integration is attempted at start and, without ST’s TTS module in the page, stays off without a fuss', async () => {
        runtime = await startNanovia({ skipInitialRefresh: true });
        await flush();
        expect(runtime.panel.tabIds()).toContain('media');
    });
});

describe('NANOVIA_API.media', () => {
    it('models(): what is loaded, without asking the network', async () => {
        const media = await start();
        expect(media.models('image')).toEqual([]);
        const asked = fake.calls.length;
        expect(media.models('image')).toEqual([]);
        expect(fake.calls).toHaveLength(asked);
        const loaded = await media.catalog('image');
        expect(loaded.ok && loaded.data.map((model) => model.id)).toEqual(['rev-animated']);
        expect(media.models('image').map((model) => model.id)).toEqual(['rev-animated']);
    });

    it('catalog(): loads or reuses, and `refresh` goes to the plugin again', async () => {
        const media = await start();
        await media.catalog('tts');
        await media.catalog('tts');
        expect(fake.callsTo('GET /media/catalog')).toHaveLength(1);
        await media.catalog('tts', { refresh: true });
        expect(fake.callsTo('GET /media/catalog').map((call) => call.path)).toEqual([
            '/media/catalog?medium=tts',
            '/media/catalog?medium=tts&refresh=1',
        ]);
    });

    it('generateImage(): a result with the cost, and the studio does not keep it', async () => {
        const media = await start();
        const result = await media.generateImage({ model: 'rev-animated', prompt: 'a cat' });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.outputs[0]).toMatchObject({ kind: 'image', mime: 'image/png' });
            expect(result.data.cost).toMatchObject({ source: 'response', paymentSource: 'USD' });
        }
        expect(runtime?.ctx.media.last().image).toBeNull();
    });

    it('speak(), transcribe(), startVideo() and videoStatus() answer with the contract’s results', async () => {
        const media = await start();
        const spoken = await media.speak({ model: 'Kokoro-82m', input: 'Hello there, friend.', voice: 'af_bella' });
        expect(spoken).toMatchObject({ ok: true, data: { chars: 20, audio: { mime: 'audio/x-wav' } } });
        const heard = await media.transcribe({
            model: 'asr',
            audioBase64: 'QUJD',
            filename: 'a.wav',
            mime: 'audio/wav',
        });
        expect(heard).toMatchObject({ ok: true, data: { text: 'Hello, there, friend.' } });
        const started = await media.startVideo({ model: 'veo3', prompt: 'a dragon' });
        expect(started).toMatchObject({ ok: true, data: { id: 'vid_1', status: 'queued' } });
        const status = await media.videoStatus('vid_1');
        expect(status).toMatchObject({ ok: true, data: { status: 'running' } });
        expect(runtime?.ctx.media.last()).toEqual({ image: null, tts: null, stt: null });
    });

    it('every failure is an { ok: false, error: { code, message } }: none throws', async () => {
        const media = await start();
        fake.fail.set('POST /media/image', { status: 402, code: 'insufficient_balance', message: 'required: 0.25' });
        expect(await media.generateImage({ model: 'rev-animated', prompt: 'p' })).toEqual({
            ok: false,
            error: { code: 'insufficient_balance', message: 'required: 0.25' },
        });
        expect(await media.videoStatus('vid_404')).toEqual({
            ok: false,
            error: { code: 'not_found', message: 'no such video job' },
        });
        backend.plugin.up = false;
        const down = await media.catalog('image', { refresh: true });
        expect(down).toMatchObject({ ok: false, error: { code: 'unreachable' } });
        expect(
            await media.transcribe({ model: 'asr', audioBase64: 'AA', filename: 'a', mime: 'audio/wav' }),
        ).toMatchObject({
            ok: false,
        });
    });

    it('is gone with the app', async () => {
        await start();
        await runtime?.stop();
        runtime = null;
        expect(globals[NANOVIA_API_GLOBAL]).toBeUndefined();
    });
});
