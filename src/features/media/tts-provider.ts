// «Nanovia» as a provider of ST's own TTS extension. ST exports `registerTtsProvider(name, Class)` from its TTS module; the
// class it receives is built with `new` and must offer the provider contract (docs/research/st-media-seams.md; ST's
// public/scripts/extensions/tts/readme.md): `generateTts`, `fetchTtsVoiceObjects`, `getVoice`, `onRefreshClick`,
// `checkReady`, `loadSettings`, `settings`, `settingsHtml` (+ optional `previewTtsVoice`, `dispose`). The provider asks the
// plugin through the media store (so the call is billed, logged and counted like the studio's), lists the voices of the
// chosen model from the catalog, and hands ST a Response whose blob carries the content type the audio really has.
//
// ST's module is imported at runtime through `host.modules`; a missing module, a missing export or an ST version that
// refuses the registration only switches the integration off (and the Media tab says so): nothing else depends on it.
import type { FeatureContext } from '../../core/context';
import { defaultModel } from '../../core/media-select';
import type { ModuleNamespace } from '../../host';
import type { MediaModel, MediaOutput, TtsRequest } from '../../shared/contracts-media';
import type { MediaSession } from './session';
import { errorText, modelLabel, priceText } from './view-model';

export const TTS_PROVIDER_NAME = 'Nanovia';
/** ST's TTS module, as ST itself loads it (the same URL gives the same module instance). */
export const TTS_MODULE_PATH = '/scripts/extensions/tts/index.js';
/** The id of the built-in extension in ST's `disabledExtensions` list. */
export const TTS_EXTENSION_NAME = 'tts';

export interface NanoviaTtsSettings {
    /** ST keeps the character -> voice map of every provider in its settings object. */
    voiceMap: Record<string, unknown>;
    model: string;
    defaultVoice: string;
    speed: number;
}

export interface TtsVoiceObject {
    name: string;
    voice_id: string;
    lang?: string;
}

const DEFAULT_SETTINGS: NanoviaTtsSettings = { voiceMap: {}, model: '', defaultVoice: '', speed: 1 };
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A Response ST can read: the audio bytes in a blob typed with the response's own content type (audio/* only). */
export async function audioResponse(
    audio: MediaOutput,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Response> {
    // ST refuses anything that is not audio/*. A response that says otherwise (octet-stream) is still audio from a speech call.
    const mime = /^audio\//i.test(audio.mime) ? audio.mime : 'audio/mpeg';
    let blob: Blob;
    if (audio.dataBase64) {
        const binary = atob(audio.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blob = new Blob([bytes], { type: mime });
    } else if (audio.url) {
        const fetched = await fetchImpl(audio.url);
        if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
        blob = new Blob([await fetched.arrayBuffer()], { type: mime });
    } else {
        throw new Error('the speech result has no audio');
    }
    return new Response(blob, { status: 200, headers: { 'Content-Type': mime } });
}

/** The provider class ST instantiates. Built per registration so it closes over the feature context. */
export function createNanoviaTtsProvider(ctx: FeatureContext, module: ModuleNamespace) {
    const t = ctx.t;

    return class NanoviaTtsProvider {
        settings: NanoviaTtsSettings = { ...DEFAULT_SETTINGS, voiceMap: {} };
        voices: TtsVoiceObject[] = [];
        audioElement: HTMLAudioElement = document.createElement('audio');
        private offStore: (() => void) | null = null;

        get settingsHtml(): string {
            return `
        <div id="nanovia_tts_settings">
            <label for="nanovia_tts_model">${escapeHtml(t('media.provider.model'))}</label>
            <select id="nanovia_tts_model" class="text_pole"></select>
            <div id="nanovia_tts_price" class="nanovia-muted"></div>
            <label for="nanovia_tts_voice">${escapeHtml(t('media.provider.voice'))}</label>
            <select id="nanovia_tts_voice" class="text_pole"></select>
            <input id="nanovia_tts_voice_free" type="text" class="text_pole" maxlength="120" style="display:none" placeholder="${escapeHtml(t('media.tts.voice.free'))}" />
            <label for="nanovia_tts_speed">${escapeHtml(t('media.provider.speed'))}: <span id="nanovia_tts_speed_output"></span></label>
            <input id="nanovia_tts_speed" type="range" min="${SPEED_MIN}" max="${SPEED_MAX}" step="0.05" value="1" />
            <div id="nanovia_tts_status" class="nanovia-muted"></div>
        </div>`;
        }

        /** The speech models of the catalog (music models are left out). */
        private models(): MediaModel[] {
            return ctx.media.select('tts', { sort: 'name', ttsKind: 'speech' });
        }

        private currentModel(): MediaModel | null {
            const found = ctx.media.model('tts', this.settings.model);
            return found ?? null;
        }

        private element<T extends HTMLElement>(id: string): T | null {
            return document.getElementById(id) as T | null;
        }

        /** Fills the model and voice controls from the catalog; picks a model when none is chosen yet. */
        private populate(): void {
            const select = this.element<HTMLSelectElement>('nanovia_tts_model');
            const status = this.element<HTMLElement>('nanovia_tts_status');
            const price = this.element<HTMLElement>('nanovia_tts_price');
            if (!select) return;
            const models = this.models();
            if (!models.some((model) => model.id === this.settings.model)) {
                const picked = defaultModel(models, { preferred: 'Kokoro-82m' });
                this.settings.model = picked?.id ?? '';
                if (picked)
                    this.settings.defaultVoice = picked.voices.includes(this.settings.defaultVoice)
                        ? this.settings.defaultVoice
                        : (picked.voices[0] ?? '');
            }
            select.textContent = '';
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = modelLabel(model, t);
                select.appendChild(option);
            }
            select.value = this.settings.model;

            const model = this.currentModel();
            if (price) price.textContent = model ? priceText(model.price, t) : '';
            if (status) {
                const view = ctx.media.catalogView('tts');
                status.textContent =
                    models.length > 0
                        ? ''
                        : view.status === 'failed' && view.error
                          ? errorText(view.error, t)
                          : view.status === 'ready'
                            ? t('media.provider.noModels')
                            : t('media.catalog.loading');
            }
            this.populateVoices(model);
        }

        private populateVoices(model: MediaModel | null): void {
            const voiceSelect = this.element<HTMLSelectElement>('nanovia_tts_voice');
            const voiceFree = this.element<HTMLInputElement>('nanovia_tts_voice_free');
            if (!voiceSelect || !voiceFree) return;
            const voices = model?.voices ?? [];
            const useList = voices.length > 0;
            voiceSelect.style.display = useList ? '' : 'none';
            voiceFree.style.display = useList ? 'none' : '';
            voiceSelect.textContent = '';
            for (const voice of voices) {
                const option = document.createElement('option');
                option.value = voice;
                option.textContent = voice;
                voiceSelect.appendChild(option);
            }
            if (useList) {
                if (!voices.includes(this.settings.defaultVoice)) this.settings.defaultVoice = voices[0] ?? '';
                voiceSelect.value = this.settings.defaultVoice;
            } else {
                voiceFree.value = this.settings.defaultVoice;
            }
        }

        async loadSettings(settings: Partial<NanoviaTtsSettings> | null | undefined): Promise<void> {
            const given = settings && typeof settings === 'object' ? settings : {};
            const speed = Number(given.speed);
            this.settings = {
                ...DEFAULT_SETTINGS,
                ...given,
                voiceMap: given.voiceMap && typeof given.voiceMap === 'object' ? given.voiceMap : {},
                model: typeof given.model === 'string' ? given.model : '',
                defaultVoice: typeof given.defaultVoice === 'string' ? given.defaultVoice : '',
                speed: Number.isFinite(speed) && speed >= SPEED_MIN && speed <= SPEED_MAX ? speed : 1,
            };
            await ctx.media.ensure('tts');
            this.populate();
            this.bind();
            this.offStore?.();
            this.offStore = ctx.media.onChange(() => this.populate());
        }

        private bind(): void {
            const model = this.element<HTMLSelectElement>('nanovia_tts_model');
            const voice = this.element<HTMLSelectElement>('nanovia_tts_voice');
            const free = this.element<HTMLInputElement>('nanovia_tts_voice_free');
            const speed = this.element<HTMLInputElement>('nanovia_tts_speed');
            const output = this.element<HTMLElement>('nanovia_tts_speed_output');
            const showSpeed = (): void => {
                if (output) output.textContent = String(this.settings.speed);
            };
            model?.addEventListener('change', () => {
                this.settings.model = model.value;
                this.settings.defaultVoice = '';
                this.populate();
                this.onSettingsChange();
            });
            voice?.addEventListener('change', () => {
                this.settings.defaultVoice = voice.value;
                this.onSettingsChange();
            });
            free?.addEventListener('input', () => {
                this.settings.defaultVoice = free.value.trim();
                this.onSettingsChange();
            });
            if (speed) {
                speed.value = String(this.settings.speed);
                speed.addEventListener('input', () => {
                    const value = Number(speed.value);
                    this.settings.speed = Number.isFinite(value) ? value : 1;
                    showSpeed();
                    this.onSettingsChange();
                });
            }
            showSpeed();
        }

        /** Persists the settings through ST's own saver (it also rebuilds the voice map), or through the settings object. */
        onSettingsChange(): void {
            const save = module['saveTtsProviderSettings'];
            try {
                if (typeof save === 'function') {
                    (save as () => void)();
                    return;
                }
                const host = ctx.host.ctx();
                const tts = (host.extensionSettings['tts'] ?? {}) as Record<string, unknown>;
                tts[TTS_PROVIDER_NAME] = this.settings;
                host.extensionSettings['tts'] = tts;
                host.saveSettingsDebounced();
            } catch (error) {
                ctx.log.warn('could not save the TTS provider settings', error);
            }
        }

        /** Voices of the chosen model; a model with no list gets one entry for the default voice. */
        async fetchTtsVoiceObjects(): Promise<TtsVoiceObject[]> {
            await ctx.media.ensure('tts');
            const model = this.currentModel() ?? this.models()[0] ?? null;
            const names = model?.voices ?? [];
            this.voices =
                names.length > 0
                    ? names.map((name) => ({ name, voice_id: name }))
                    : [
                          {
                              name: this.settings.defaultVoice || t('media.provider.defaultVoice'),
                              voice_id: this.settings.defaultVoice,
                          },
                      ];
            return this.voices;
        }

        async getVoice(voiceName: string): Promise<TtsVoiceObject> {
            if (this.voices.length === 0) await this.fetchTtsVoiceObjects();
            const match = this.voices.find((voice) => voice.name === voiceName);
            if (!match) throw new Error(`TTS voice ${voiceName} not found`);
            return match;
        }

        async onRefreshClick(): Promise<void> {
            const result = await ctx.media.ensure('tts', { refresh: true });
            if (!result.ok) throw new Error(errorText(result.error, t));
            this.populate();
        }

        /** Not ready = the plugin is not answering, has no key, or has no speech model: ST shows the reason in its panel. */
        async checkReady(): Promise<void> {
            const result = await ctx.media.ensure('tts');
            if (!result.ok) throw new Error(errorText(result.error, t));
            if (this.models().length === 0) throw new Error(t('media.provider.noModels'));
            this.voices = await this.fetchTtsVoiceObjects();
        }

        async generateTts(text: string, voiceId?: string): Promise<Response> {
            const model = this.currentModel() ?? defaultModel(this.models(), { preferred: 'Kokoro-82m' });
            if (!model) throw new Error(t('media.provider.noModels'));
            const voices = model.voices;
            // A voice of an earlier model (a voice map made before the model was changed) falls back to the default one.
            const wanted = voiceId && (voices.length === 0 || voices.includes(voiceId)) ? voiceId : '';
            const voice = wanted || this.settings.defaultVoice || voices[0] || '';
            const request: TtsRequest = { model: model.id, input: text };
            if (voice) request.voice = voice;
            if (this.settings.speed !== 1) request.speed = this.settings.speed;
            const result = await ctx.media.speak(request, { remember: false });
            if (!result.ok) throw new Error(errorText(result.error, t));
            return audioResponse(result.data.audio);
        }

        async previewTtsVoice(voiceId?: string): Promise<void> {
            try {
                this.audioElement.pause();
                const response = await this.generateTts(t('media.provider.previewText'), voiceId);
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                this.audioElement.src = url;
                this.audioElement.onended = () => URL.revokeObjectURL(url);
                await this.audioElement.play();
            } catch (error) {
                ctx.host.notify('error', error instanceof Error ? error.message : String(error));
            }
        }

        dispose(): void {
            this.offStore?.();
            this.offStore = null;
            this.audioElement.pause();
        }
    };
}

export type RegistrationOutcome = 'active' | 'unavailable' | 'failed';

/**
 * Registers the «Nanovia» provider with ST's TTS extension and tells the session how it went. Never throws: whatever goes
 * wrong (the extension switched off, another ST version, a module that cannot be imported) only leaves the integration
 * inactive, with the reason for the Media tab.
 */
export async function registerNanoviaTts(ctx: FeatureContext, session: MediaSession): Promise<RegistrationOutcome> {
    const t = ctx.t;
    let disabled: unknown;
    try {
        disabled = ctx.host.ctx().extensionSettings.disabledExtensions;
    } catch {
        disabled = undefined;
    }
    if (Array.isArray(disabled) && disabled.includes(TTS_EXTENSION_NAME)) {
        session.setIntegration('unavailable', t('media.integration.off'));
        return 'unavailable';
    }
    let module: ModuleNamespace;
    try {
        module = await ctx.host.modules.load(TTS_MODULE_PATH);
    } catch (error) {
        ctx.log.debug('ST TTS module not available', error);
        session.setIntegration('unavailable', t('media.integration.noModule'));
        return 'unavailable';
    }
    const register = module['registerTtsProvider'];
    if (typeof register !== 'function') {
        session.setIntegration('unavailable', t('media.integration.noExport'));
        return 'unavailable';
    }
    try {
        (register as (name: string, provider: unknown) => void)(
            TTS_PROVIDER_NAME,
            createNanoviaTtsProvider(ctx, module),
        );
        session.setIntegration('active');
        return 'active';
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log.warn('could not register the TTS provider', error);
        session.setIntegration(
            'failed',
            /already registered/i.test(message) ? t('media.integration.duplicate') : message,
        );
        return 'failed';
    }
}
