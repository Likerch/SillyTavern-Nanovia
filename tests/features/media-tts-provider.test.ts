// @vitest-environment happy-dom
// The «Nanovia» provider in ST's TTS extension: registration (with ST's module, without it), and the provider contract ST
// expects from the class it instantiates.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../src/features/media/session';
import type { MediaSession } from '../../src/features/media/session';
import { MEDIA_STRINGS } from '../../src/features/media/strings';
import {
    TTS_MODULE_PATH,
    TTS_PROVIDER_NAME,
    audioResponse,
    createNanoviaTtsProvider,
    registerNanoviaTts,
} from '../../src/features/media/tts-provider';
import type { ModuleNamespace } from '../../src/host';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { settle } from '../helpers/media-dom';
import { WAV_BASE64, mediaModel } from '../helpers/media-fake';

let h: Harness;
let tc: TestContext;
let session: MediaSession;
let registered: Record<string, new () => unknown>;
let stModule: ModuleNamespace & {
    registerTtsProvider: ReturnType<typeof vi.fn>;
    saveTtsProviderSettings: ReturnType<typeof vi.fn>;
};

/** A feature context whose `host.modules.load` serves a module (or fails). */
function withModule(loader: (path: string) => Promise<ModuleNamespace>): typeof tc.ctx {
    return { ...tc.ctx, host: { ...tc.ctx.host, modules: { ...tc.ctx.host.modules, load: loader } } } as typeof tc.ctx;
}

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(MEDIA_STRINGS);
    tc.mediaFake.catalogs.tts = [
        mediaModel({
            id: 'Kokoro-82m',
            name: 'Kokoro',
            medium: 'tts',
            price: { unit: 'thousand_chars', from: 0.0017, to: 0.0017, byKey: {}, raw: null },
            voices: ['af_bella', 'am_adam'],
        }),
        mediaModel({ id: 'eleven', name: 'Eleven', medium: 'tts', voices: ['rachel', 'adam'] }),
        mediaModel({ id: 'novoice', name: 'No voices', medium: 'tts' }),
        mediaModel({ id: 'suno', name: 'Suno', medium: 'tts', capabilities: { music: true }, voices: ['x'] }),
    ];
    registered = {};
    stModule = {
        registerTtsProvider: vi.fn((name: string, provider: new () => unknown) => {
            if (registered[name]) throw new Error(`TTS provider ${name} is already registered.`);
            registered[name] = provider;
        }),
        saveTtsProviderSettings: vi.fn(),
    };
    session = createSession();
    document.body.innerHTML = '';
});

afterEach(() => {
    tc.media.dispose();
    vi.unstubAllGlobals();
    h.restore();
    document.body.innerHTML = '';
});

describe('registration with ST’s TTS extension', () => {
    it('imports ST’s module by its own URL and registers the class as «Nanovia»', async () => {
        const load = vi.fn(async () => stModule);
        expect(await registerNanoviaTts(withModule(load), session)).toBe('active');
        expect(load).toHaveBeenCalledWith(TTS_MODULE_PATH);
        expect(TTS_MODULE_PATH).toBe('/scripts/extensions/tts/index.js');
        expect(stModule.registerTtsProvider).toHaveBeenCalledOnce();
        expect(stModule.registerTtsProvider.mock.calls[0]?.[0]).toBe(TTS_PROVIDER_NAME);
        expect(TTS_PROVIDER_NAME).toBe('Nanovia');
        expect(typeof registered['Nanovia']).toBe('function');
        expect(session.integration()).toEqual({ status: 'active', message: null });
    });

    it('with the module missing (another ST, or the extension not there) the integration is simply off', async () => {
        const outcome = await registerNanoviaTts(
            withModule(async () => {
                throw new Error('Failed to fetch dynamically imported module');
            }),
            session,
        );
        expect(outcome).toBe('unavailable');
        expect(session.integration().status).toBe('unavailable');
        expect(session.integration().message).toContain('could not be loaded');
    });

    it('with a module that has no registration function it is off too', async () => {
        expect(
            await registerNanoviaTts(
                withModule(async () => ({})),
                session,
            ),
        ).toBe('unavailable');
        expect(session.integration().message).toContain('no provider registration');
    });

    it('does not even import the module when the TTS extension is switched off in ST', async () => {
        h.mock.extensionSettings['disabledExtensions'] = ['tts'];
        const load = vi.fn(async () => stModule);
        expect(await registerNanoviaTts(withModule(load), session)).toBe('unavailable');
        expect(load).not.toHaveBeenCalled();
        expect(session.integration().message).toContain('switched off');
    });

    it('a registration ST refuses is reported with its message', async () => {
        stModule.registerTtsProvider.mockImplementation(() => {
            throw new Error('TTS provider Nanovia is not a valid provider class.');
        });
        expect(
            await registerNanoviaTts(
                withModule(async () => stModule),
                session,
            ),
        ).toBe('failed');
        expect(session.integration()).toEqual({
            status: 'failed',
            message: 'TTS provider Nanovia is not a valid provider class.',
        });
    });

    it('a second registration in the same page says to reload, instead of piling up classes', async () => {
        const load = async () => stModule;
        await registerNanoviaTts(withModule(load), session);
        const again = createSession();
        expect(await registerNanoviaTts(withModule(load), again)).toBe('failed');
        expect(again.integration().message).toContain('already registered in this page');
    });

    it('tells the listeners of the session', async () => {
        const seen: string[] = [];
        session.onIntegration(() => seen.push(session.integration().status));
        await registerNanoviaTts(
            withModule(async () => stModule),
            session,
        );
        expect(seen).toEqual(['active']);
    });
});

describe('the provider class', () => {
    async function mount(): Promise<InstanceType<ReturnType<typeof createNanoviaTtsProvider>>> {
        const Provider = createNanoviaTtsProvider(tc.ctx, stModule);
        const provider = new Provider();
        // ST puts the settings HTML into its panel, then loads the settings.
        document.body.innerHTML = provider.settingsHtml;
        return provider;
    }

    const select = (id: string): HTMLSelectElement => document.getElementById(id) as HTMLSelectElement;

    it('has what ST’s readme requires of a provider', async () => {
        const provider = await mount();
        for (const name of [
            'generateTts',
            'fetchTtsVoiceObjects',
            'onRefreshClick',
            'checkReady',
            'loadSettings',
            'getVoice',
        ]) {
            expect(typeof (provider as unknown as Record<string, unknown>)[name], name).toBe('function');
        }
        expect(typeof provider.settings).toBe('object');
        expect(typeof provider.settingsHtml).toBe('string');
        expect(typeof provider.dispose).toBe('function');
        expect(typeof provider.previewTtsVoice).toBe('function');
    });

    it('its settings panel is made of ST’s own classes and the interface language', async () => {
        const provider = await mount();
        expect(provider.settingsHtml).toContain('class="text_pole"');
        expect(provider.settingsHtml).toContain('Default voice');
        tc.setLocale('ru');
        expect(provider.settingsHtml).toContain('Голос по умолчанию');
    });

    it('lists the speech models of the catalog (not the music ones), picks Kokoro first, and lists its voices', async () => {
        const provider = await mount();
        await provider.loadSettings({});
        expect([...select('nanovia_tts_model').options].map((option) => option.value).sort()).toEqual([
            'Kokoro-82m',
            'eleven',
            'novoice',
        ]);
        expect(select('nanovia_tts_model').value).toBe('Kokoro-82m');
        expect(provider.settings.model).toBe('Kokoro-82m');
        expect([...select('nanovia_tts_voice').options].map((option) => option.value)).toEqual(['af_bella', 'am_adam']);
        expect(provider.settings.defaultVoice).toBe('af_bella');
        expect(document.getElementById('nanovia_tts_price')?.textContent).toBe('$0.0017 / 1K characters');
    });

    it('keeps the settings ST had saved, including the voice map', async () => {
        const provider = await mount();
        await provider.loadSettings({
            voiceMap: { Alice: 'am_adam' },
            model: 'eleven',
            defaultVoice: 'adam',
            speed: 1.25,
        });
        expect(provider.settings).toEqual({
            voiceMap: { Alice: 'am_adam' },
            model: 'eleven',
            defaultVoice: 'adam',
            speed: 1.25,
        });
        expect(select('nanovia_tts_model').value).toBe('eleven');
        expect(select('nanovia_tts_voice').value).toBe('adam');
        expect((document.getElementById('nanovia_tts_speed') as HTMLInputElement).value).toBe('1.25');
        expect(document.getElementById('nanovia_tts_speed_output')?.textContent).toBe('1.25');
    });

    it('survives settings that are not what it wrote', async () => {
        const provider = await mount();
        await provider.loadSettings({ speed: 99, model: 5, voiceMap: 'old', defaultVoice: null } as never);
        expect(provider.settings).toMatchObject({ voiceMap: {}, speed: 1 });
        await provider.loadSettings(null);
        expect(provider.settings.model).toBe('Kokoro-82m');
    });

    it('a saved model that left the catalog is replaced by a default one', async () => {
        const provider = await mount();
        await provider.loadSettings({ model: 'retired', defaultVoice: 'ghost' });
        expect(provider.settings.model).toBe('Kokoro-82m');
        expect(provider.settings.defaultVoice).toBe('af_bella');
    });

    it('changing the model, the voice or the speed saves through ST’s own saver', async () => {
        const provider = await mount();
        await provider.loadSettings({});
        const model = select('nanovia_tts_model');
        model.value = 'eleven';
        model.dispatchEvent(new Event('change'));
        expect(provider.settings).toMatchObject({ model: 'eleven', defaultVoice: 'rachel' });
        expect([...select('nanovia_tts_voice').options].map((option) => option.value)).toEqual(['rachel', 'adam']);
        const voice = select('nanovia_tts_voice');
        voice.value = 'adam';
        voice.dispatchEvent(new Event('change'));
        expect(provider.settings.defaultVoice).toBe('adam');
        const speed = document.getElementById('nanovia_tts_speed') as HTMLInputElement;
        speed.value = '1.5';
        speed.dispatchEvent(new Event('input'));
        expect(provider.settings.speed).toBe(1.5);
        expect(stModule.saveTtsProviderSettings).toHaveBeenCalledTimes(3);
    });

    it('a model with no voice list gets a text box for the default voice', async () => {
        const provider = await mount();
        await provider.loadSettings({ model: 'novoice' });
        expect(select('nanovia_tts_voice').style.display).toBe('none');
        const free = document.getElementById('nanovia_tts_voice_free') as HTMLInputElement;
        expect(free.style.display).toBe('');
        free.value = ' nova ';
        free.dispatchEvent(new Event('input'));
        expect(provider.settings.defaultVoice).toBe('nova');
    });

    it('without ST’s saver it writes the settings itself', async () => {
        const Provider = createNanoviaTtsProvider(tc.ctx, {});
        const provider = new Provider();
        document.body.innerHTML = provider.settingsHtml;
        await provider.loadSettings({});
        const model = select('nanovia_tts_model');
        model.value = 'eleven';
        model.dispatchEvent(new Event('change'));
        const saved = h.mock.extensionSettings['tts'] as Record<string, unknown>;
        expect(saved['Nanovia']).toBe(provider.settings);
        expect(h.mock.saveSettingsCalls).toBeGreaterThan(0);
    });

    it('fills its panel again when the catalog arrives late', async () => {
        const provider = await mount();
        tc.mediaFake.fail.set('GET /media/catalog', { status: 502, code: 'media_unavailable' });
        await provider.loadSettings({});
        expect(select('nanovia_tts_model').options).toHaveLength(0);
        expect(document.getElementById('nanovia_tts_status')?.textContent).toContain('The model list cannot be had');
        tc.mediaFake.fail.clear();
        await tc.media.ensure('tts', { refresh: true });
        expect(select('nanovia_tts_model').options.length).toBe(3);
        expect(document.getElementById('nanovia_tts_status')?.textContent).toBe('');
    });

    it('lists voices as ST wants them and finds one by name', async () => {
        const provider = await mount();
        await provider.loadSettings({});
        expect(await provider.fetchTtsVoiceObjects()).toEqual([
            { name: 'af_bella', voice_id: 'af_bella' },
            { name: 'am_adam', voice_id: 'am_adam' },
        ]);
        expect(await provider.getVoice('am_adam')).toEqual({ name: 'am_adam', voice_id: 'am_adam' });
        await expect(provider.getVoice('nobody')).rejects.toThrow('not found');
    });

    it('a model with no voice list still gives ST one entry to put in the voice map', async () => {
        const provider = await mount();
        await provider.loadSettings({ model: 'novoice', defaultVoice: 'nova' });
        expect(await provider.fetchTtsVoiceObjects()).toEqual([{ name: 'nova', voice_id: 'nova' }]);
        await provider.loadSettings({ model: 'novoice', defaultVoice: '' });
        expect(await provider.fetchTtsVoiceObjects()).toEqual([{ name: 'default', voice_id: '' }]);
    });

    it('is ready when the catalog has speech models, and says why when it is not', async () => {
        const provider = await mount();
        await provider.loadSettings({});
        await expect(provider.checkReady()).resolves.toBeUndefined();
        h.backend.plugin.up = false;
        await tc.media.ensure('tts', { refresh: true });
        await expect(provider.checkReady()).rejects.toThrow('The Nanovia plugin is not answering.');
        h.backend.plugin.up = true;
        tc.mediaFake.catalogs.tts = [mediaModel({ id: 'suno', medium: 'tts', capabilities: { music: true } })];
        await tc.media.ensure('tts', { refresh: true });
        await expect(provider.checkReady()).rejects.toThrow('speech model list is empty');
    });

    it('«refresh» reads the catalog again and reports a failure', async () => {
        const provider = await mount();
        await provider.loadSettings({});
        tc.mediaFake.catalogs.tts = [mediaModel({ id: 'brand-new', medium: 'tts', voices: ['v'] })];
        await provider.onRefreshClick();
        expect(select('nanovia_tts_model').value).toBe('brand-new');
        h.backend.plugin.up = false;
        await expect(provider.onRefreshClick()).rejects.toThrow('not answering');
    });
});

describe('generating speech for ST', () => {
    async function ready(settings: object = {}): Promise<InstanceType<ReturnType<typeof createNanoviaTtsProvider>>> {
        const Provider = createNanoviaTtsProvider(tc.ctx, stModule);
        const provider = new Provider();
        document.body.innerHTML = provider.settingsHtml;
        await provider.loadSettings(settings);
        return provider;
    }
    const lastBody = (): Record<string, unknown> =>
        (tc.mediaFake.callsTo('POST /media/tts').at(-1)?.body ?? {}) as Record<string, unknown>;

    it('asks the plugin and hands back a Response whose blob has the real content type', async () => {
        const provider = await ready();
        const response = await provider.generateTts('Hello there, friend.', 'am_adam');
        expect(response).toBeInstanceOf(Response);
        const blob = await response.blob();
        // ST refuses anything that is not audio/*, and the model’s own type (wav, not the mp3 that was wished for) is kept.
        expect(blob.type).toBe('audio/x-wav');
        expect(blob.size).toBe(atob(WAV_BASE64).length);
        expect(lastBody()).toEqual({ model: 'Kokoro-82m', input: 'Hello there, friend.', voice: 'am_adam' });
    });

    it('sends the speed only when it is not 1, and the default voice when ST names none', async () => {
        const provider = await ready({ speed: 1.5, defaultVoice: 'am_adam' });
        await provider.generateTts('Hi');
        expect(lastBody()).toEqual({ model: 'Kokoro-82m', input: 'Hi', voice: 'am_adam', speed: 1.5 });
    });

    it('a voice of another model falls back to the default one', async () => {
        const provider = await ready({ defaultVoice: 'af_bella' });
        await provider.generateTts('Hi', 'rachel');
        expect(lastBody()['voice']).toBe('af_bella');
    });

    it('does not leave its result in the studio, and the call is counted by the plugin like any other', async () => {
        const provider = await ready();
        await provider.generateTts('Hi', 'af_bella');
        expect(tc.media.last().tts).toBeNull();
        expect(tc.fake.callsTo('GET /spend').length).toBeGreaterThan(0);
    });

    it('a failure becomes an Error with the words of the interface language', async () => {
        const provider = await ready();
        tc.mediaFake.fail.set('POST /media/tts', {
            status: 402,
            code: 'insufficient_balance',
            message: 'required: 0.01',
        });
        await expect(provider.generateTts('Hi')).rejects.toThrow('it needs $0.01');
        tc.mediaFake.fail.set('POST /media/tts', { status: 409, code: 'no_key' });
        await expect(provider.generateTts('Hi')).rejects.toThrow('no NanoGPT key');
    });

    it('without any speech model it says so', async () => {
        tc.mediaFake.catalogs.tts = [];
        const provider = await ready();
        await expect(provider.generateTts('Hi')).rejects.toThrow('speech model list is empty');
    });

    it('a preview speaks a short text and plays it; a failure is a toast, not an unhandled rejection', async () => {
        const play = vi.fn(async () => {});
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
        const provider = await ready();
        provider.audioElement = { pause: vi.fn(), play, src: '', onended: null } as unknown as HTMLAudioElement;
        await provider.previewTtsVoice('af_bella');
        expect(play).toHaveBeenCalledOnce();
        expect(lastBody()['input']).toBe('The quick brown fox jumps over the lazy dog.');
        tc.mediaFake.fail.set('POST /media/tts', { status: 429, code: 'rate_limited' });
        await provider.previewTtsVoice('af_bella');
        expect(h.mock.toasts.at(-1)).toMatchObject({
            kind: 'error',
            text: expect.stringContaining('Try again in a minute'),
        });
    });

    it('dispose stops it listening to the catalog', async () => {
        const provider = await ready();
        provider.dispose();
        const before = document.getElementById('nanovia_tts_model')?.innerHTML;
        tc.mediaFake.catalogs.tts = [mediaModel({ id: 'late', medium: 'tts' })];
        await tc.media.ensure('tts', { refresh: true });
        await settle();
        expect(document.getElementById('nanovia_tts_model')?.innerHTML).toBe(before);
    });
});

describe('audioResponse', () => {
    it('keeps an audio content type and falls back to audio/mpeg for one that is not audio', async () => {
        const wav = await audioResponse({ kind: 'audio', mime: 'audio/wav', dataBase64: WAV_BASE64 });
        expect((await wav.blob()).type).toBe('audio/wav');
        const odd = await audioResponse({ kind: 'audio', mime: 'application/octet-stream', dataBase64: WAV_BASE64 });
        expect((await odd.blob()).type).toBe('audio/mpeg');
        expect(odd.headers.get('Content-Type')).toBe('audio/mpeg');
    });

    it('fetches a link when there are no inline bytes, and refuses an output with neither', async () => {
        const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
        const fetched = await audioResponse(
            { kind: 'audio', mime: 'audio/mpeg', url: 'https://x.test/a.mp3' },
            fetchImpl as never,
        );
        expect(fetchImpl).toHaveBeenCalledWith('https://x.test/a.mp3');
        expect((await fetched.blob()).size).toBe(3);
        await expect(
            audioResponse(
                { kind: 'audio', mime: 'audio/mpeg', url: 'https://x.test/a.mp3' },
                (async () => new Response('x', { status: 404 })) as never,
            ),
        ).rejects.toThrow('HTTP 404');
        await expect(audioResponse({ kind: 'audio', mime: 'audio/mpeg' })).rejects.toThrow('no audio');
    });
});
