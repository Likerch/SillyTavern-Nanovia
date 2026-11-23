import { describe, expect, it } from 'vitest';
import {
    describePrice,
    estimateImageCost,
    estimateSttCost,
    estimateTtsCost,
    estimateVideoCost,
    normalizeMediaList,
} from '../../src/domain/media';
import type { MediaModel, MediaPrice, Medium } from '../../src/shared/contracts-media';
import images from '../../tools/fixtures/media/images_models.json';
import stt from '../../tools/fixtures/media/audio_models_stt.json';
import tts from '../../tools/fixtures/media/audio_models_tts.json';
import videos from '../../tools/fixtures/media/video_models.json';

// The fixtures are trimmed copies of the live lists of 2026-11-23 (tools/fixtures/trim-media.mjs).
const imageModels = normalizeMediaList('image', images);
const videoModels = normalizeMediaList('video', videos);
const ttsModels = normalizeMediaList('tts', tts);
const sttModels = normalizeMediaList('stt', stt);

function find(models: MediaModel[], id: string): MediaModel {
    const found = models.find((m) => m.id === id);
    if (!found) throw new Error(`fixture model ${id} is missing`);
    return found;
}

const param = (model: MediaModel, key: string) => model.params.find((p) => p.key === key);

describe('normalizeMediaList: image', () => {
    it('reads every entry of the real list', () => {
        expect(imageModels).toHaveLength(images.data.length);
        expect(new Set(imageModels.map((m) => m.id)).size).toBe(imageModels.length);
        for (const model of imageModels) {
            expect(model.medium).toBe('image');
            expect(model.name).not.toBe('');
            expect(model.voices).toEqual([]);
            expect(model.priceIsApproximate).toBe(false);
        }
    });

    it('prices per size from the per_image table', () => {
        const rev = find(imageModels, 'rev-animated');
        expect(rev.price).toMatchObject({ unit: 'image', from: 0.0017, to: 0.0017 });
        expect(rev.price.byKey['512x512']).toBe(0.0017);
        expect(rev.capabilities).toMatchObject({ textToImage: true, imageToImage: false, nsfw: false });
        expect(rev.maxInputImages).toBe(0);
        expect(rev.subscriptionIncluded).toBeNull();
        const pixel = find(imageModels, 'pixelwave');
        expect(pixel.price).toMatchObject({ unit: 'image', from: 0.0034, to: 0.0068 });
        expect(pixel.capabilities).toMatchObject({ nsfw: true, imageToImage: true });
        expect(pixel.maxInputImages).toBe(1);
        expect(describePrice(pixel.price)).toBe('0.0034-0.0068/image');
    });

    it('turns resolutions into the size setting, keeping the asterisk, ratio and preset tokens as listed', () => {
        expect(param(find(imageModels, 'rev-animated'), 'size')).toEqual({
            key: 'size',
            type: 'enum',
            values: [
                '512x512',
                '768x768',
                '512x768',
                '768x512',
                '1024x1024',
                '768x1024',
                '1024x768',
                '576x1024',
                '1024x576',
            ],
        });
        expect(param(find(imageModels, 'hidream-o1-image'), 'size')?.values).toContain('2048*2048');
        expect(find(imageModels, 'hidream-o1-image').price.byKey['auto']).toBe(0.04);
        expect(param(find(imageModels, 'speridlabs/iris-z'), 'size')?.values).toContain('square_hd');
    });

    it('turns max_images and fixed_image_count into the n setting', () => {
        expect(param(find(imageModels, 'rev-animated'), 'n')).toEqual({
            key: 'n',
            type: 'integer',
            min: 1,
            max: 20,
            default: 1,
        });
        expect(param(find(imageModels, 'speridlabs/iris-z'), 'n')).toEqual({
            key: 'n',
            type: 'integer',
            min: 1,
            max: 1,
            default: 1,
        });
    });

    it('treats a zero price as a price (a free utility) and an empty table as unknown', () => {
        expect(find(imageModels, 'Cropper').price).toMatchObject({ unit: 'image', from: 0, to: 0 });
        const topaz = find(imageModels, 'topaz-image-upscale');
        expect(topaz.price).toMatchObject({ unit: 'unknown', from: 0.08, to: 0.08, byKey: {} });
        expect(topaz.price.raw).toMatchObject({ billing: 'started_megapixel_blocks', starting_at: 0.08 });
        expect(topaz.capabilities.textToImage).toBe(false);
        expect(param(topaz, 'topaz_model')?.values).toContain('Standard V2');
        expect(param(topaz, 'upscale_factor')).toMatchObject({ type: 'integer', min: 1, max: 4, default: 2 });
        expect(param(topaz, 'target_enlargement_per_edge')).toMatchObject({ type: 'range', min: 1, max: 6 });
    });

    it('reads arrays, descriptor objects, bare flags and ad hoc objects of supported_parameters', () => {
        const gpt = find(imageModels, 'gpt-image-2.6-flare');
        expect(param(gpt, 'quality')?.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
        expect(param(gpt, 'complexity')).toMatchObject({ type: 'enum', default: 'high' });
        expect(param(gpt, 'output_compression')).toMatchObject({ type: 'range', min: 0, max: 100 });
        expect(param(gpt, 'gif')?.type).toBe('unknown');
        expect(param(gpt, 'markup')?.type).toBe('unknown');
        expect(param(gpt, 'aspect_ratio')?.type).toBe('enum');
        expect(gpt.maxInputImages).toBe(16);
        expect(gpt.price.from).toBeLessThan(gpt.price.to as number);

        const morgana = find(imageModels, 'kitani/morgana-v1.2');
        expect(param(morgana, 'quality')).toMatchObject({
            type: 'enum',
            values: ['low', 'medium', 'high'],
            default: 'medium',
        });
        expect(param(morgana, 'seed')).toMatchObject({ type: 'integer', min: 0, max: 2147483647, default: -1 });
        expect(param(morgana, 'negative_prompt')).toBeUndefined(); // `false`: not supported

        const moss = find(imageModels, 'moss-image');
        expect(param(moss, 'guidance_scale')).toEqual({
            key: 'guidance_scale',
            type: 'range',
            min: 0,
            max: 10,
            default: 3,
        });
        expect(param(moss, 'num_inference_steps')).toMatchObject({ type: 'range', min: 1, max: 100, default: 50 });
        expect(param(moss, 'negative_prompt')).toEqual({ key: 'negative_prompt', type: 'text' });
        expect(param(moss, 'seed')).toEqual({ key: 'seed', type: 'integer' });
        expect(param(moss, 'enable_prompt_expansion')).toMatchObject({ type: 'boolean', default: true });
    });

    it('keeps limit-like keys out of the settings', () => {
        for (const model of imageModels) {
            for (const key of [
                'max_prompt_characters',
                'prompt_length',
                'max_images',
                'input_image_constraints',
                'resolutions',
            ]) {
                expect(param(model, key), `${model.id}.${key}`).toBeUndefined();
            }
        }
    });

    it('tells text-to-image from edit-only models', () => {
        expect(find(imageModels, 'topaz-image-upscale').capabilities.textToImage).toBe(false);
        const edits = imageModels.filter((m) => m.capabilities.imageToImage && !m.capabilities.textToImage);
        expect(edits.length).toBeGreaterThan(0);
        expect(edits.every((m) => m.maxInputImages >= 1)).toBe(true);
    });

    it('reads handmade entries: decimal strings, megapixel and starting-at prices, odd modalities', () => {
        const one = (extra: Record<string, unknown>): MediaModel => {
            const [model] = normalizeMediaList('image', [{ id: 'm', pricing: {}, ...extra }]);
            return model as MediaModel;
        };
        expect(one({ pricing: { per_image: { '1024x1024': '0.05', bad: 'x', neg: -1 } } }).price).toMatchObject({
            unit: 'image',
            from: 0.05,
            byKey: { '1024x1024': 0.05 },
        });
        expect(one({ pricing: { per_megapixel: 0.05 } }).price).toMatchObject({
            unit: 'megapixel',
            from: 0.05,
            to: 0.05,
        });
        expect(one({ pricing: { starting_at: 0.2 } }).price).toMatchObject({ unit: 'unknown', from: 0.2, to: 0.2 });
        expect(one({}).price).toMatchObject({ unit: 'unknown', from: null, to: null });
        // No text input, from the modality string alone.
        expect(one({ architecture: { modality: 'image->image' } }).capabilities.textToImage).toBe(false);
        expect(one({ architecture: { modality: 'text->image' } }).capabilities.textToImage).toBe(true);
        expect(one({ capabilities: { image_generation: false } }).capabilities.textToImage).toBe(false);
        // image_to_image without max_input_images means one input; a stated 0 stays 0.
        expect(one({ capabilities: { image_to_image: true } }).maxInputImages).toBe(1);
        expect(
            one({ capabilities: { image_to_image: true }, supported_parameters: { max_input_images: 4 } })
                .maxInputImages,
        ).toBe(4);
        expect(one({ supported_parameters: { max_input_images: 0 } }).maxInputImages).toBe(0);
        expect(one({ subscription: { included: true } }).subscriptionIncluded).toBe(true);
        expect(one({ supported_parameters: { fixed_image_count: 2 } }).params).toContainEqual({
            key: 'n',
            type: 'integer',
            min: 2,
            max: 2,
            default: 2,
        });
    });
});

describe('normalizeMediaList: video', () => {
    it('reads every entry of the real list', () => {
        expect(videoModels).toHaveLength(videos.data.length);
        for (const model of videoModels) {
            expect(model.medium).toBe('video');
            expect(model.params.length).toBeGreaterThan(0);
        }
    });

    it('reduces the price shapes it can and says so when it cannot', () => {
        const vidu = find(videoModels, 'vidu-q4');
        expect(vidu.price).toMatchObject({ unit: 'second', from: 0.0495, to: 0.429 });
        expect(vidu.price.byKey['720p']).toBe(0.1045);
        expect(vidu.priceIsApproximate).toBe(false); // a minimum and a zero surcharge move nothing
        expect(find(videoModels, 'longstories/story-fast').price).toMatchObject({
            unit: 'second',
            from: 0.132,
            to: 0.144,
        });
        expect(find(videoModels, 'veed/dubbing')).toMatchObject({
            price: { unit: 'second', from: 0.11, to: 0.11 },
            priceIsApproximate: false,
        });
        expect(find(videoModels, 'wan-video-22-5b')).toMatchObject({
            price: { unit: 'request', from: 0.15 },
            priceIsApproximate: false,
        });
        const turbo = find(videoModels, 'kling-v25-turbo-std');
        expect(turbo.price).toMatchObject({ unit: 'request', byKey: { '5s': 0.21, '10s': 0.42 } });
        expect(turbo.priceIsApproximate).toBe(false);
        // An audio multiplier, audio on/off, duration overrides and a base-plus-extra-seconds price are only approximations.
        expect(find(videoModels, 'kling-v26-pro').priceIsApproximate).toBe(true);
        expect(find(videoModels, 'veo3-video')).toMatchObject({
            price: { unit: 'request', from: 3.2, to: 4.8, byKey: { with_audio: 4.8, without_audio: 3.2 } },
            priceIsApproximate: true,
        });
        expect(find(videoModels, 'veo2-video')).toMatchObject({
            price: { unit: 'request', from: 3.4, to: 20.4 },
            priceIsApproximate: true,
        });
        expect(find(videoModels, 'kling-4.0').priceIsApproximate).toBe(true);
    });

    it('keeps the raw price of shapes it does not understand', () => {
        const unknown = videoModels.filter((m) => m.price.unit === 'unknown');
        expect(unknown.length).toBeGreaterThan(0);
        for (const model of unknown) {
            expect(model.priceIsApproximate).toBe(true);
            expect(model.price.raw).toMatchObject({ currency: 'USD' });
        }
        const reframe = find(videoModels, 'lightricks/ltx-2.5/reframe');
        expect(reframe.price.from).toBeGreaterThan(0);
    });

    it('turns the parameter descriptors into settings', () => {
        const turbo = find(videoModels, 'kling-v25-turbo-std');
        expect(param(turbo, 'duration')).toMatchObject({ type: 'enum', values: ['5', '10'], default: '5' });
        const vidu = find(videoModels, 'vidu-q4');
        expect(param(vidu, 'seed')).toMatchObject({ type: 'number', min: -1, step: 1, default: -1 });
        const veo = find(videoModels, 'veo3-video');
        expect(param(veo, 'generateAudio')).toMatchObject({ type: 'boolean', default: true });
        const minimax = find(videoModels, 'minimax/h3-highspeed');
        expect(param(minimax, 'reference_images')?.type).toBe('text');
        expect(minimax.maxInputImages).toBe(9);
        expect(find(videoModels, 'veo3-video').capabilities).toMatchObject({
            textToVideo: true,
            imageToVideo: true,
            videoToVideo: false,
            audioInput: false,
        });
        expect(find(videoModels, 'veed/dubbing').maxInputImages).toBe(0);
        expect(find(videoModels, 'wan-video-22-5b').maxInputImages).toBe(1);
    });

    it('reads handmade descriptors and price shapes', () => {
        const one = (extra: Record<string, unknown>): MediaModel => {
            const [model] = normalizeMediaList('video', [{ id: 'v', pricing: {}, ...extra }]);
            return model as MediaModel;
        };
        const params = one({
            supported_parameters: {
                parameters: {
                    a: { type: 'select', label: 'no options' },
                    b: { type: 'array' },
                    c: { type: 'text', default: 'hi', required: true },
                    d: { type: 'integer', min: 1, max: 9, step: 2 },
                    e: { min: 1, max: 5, default: 2 },
                    f: { type: 'switch', default: false },
                    g: { default: true },
                    h: { default: 3 },
                    i: { default: 'x' },
                    j: {},
                    k: { type: 'number' },
                    l: { type: 'select', options: ['a', 2, { value: 'c' }, null], default: 'a' },
                    m: 'nope',
                    n: { min: 3 },
                },
                defaults: { j: 'fallback', k: 1.5 },
            },
        }).params;
        const byKey = Object.fromEntries(params.map((p) => [p.key, p]));
        expect(byKey['a']?.type).toBe('unknown');
        expect(byKey['b']?.type).toBe('unknown');
        expect(byKey['c']).toEqual({ key: 'c', type: 'text', required: true, default: 'hi' });
        expect(byKey['d']).toEqual({ key: 'd', type: 'integer', min: 1, max: 9, step: 2 });
        expect(byKey['e']).toEqual({ key: 'e', type: 'range', min: 1, max: 5, default: 2 });
        expect(byKey['f']).toEqual({ key: 'f', type: 'boolean', default: false });
        expect(byKey['g']?.type).toBe('boolean');
        expect(byKey['h']?.type).toBe('number');
        expect(byKey['i']?.type).toBe('text');
        expect(byKey['j']).toEqual({ key: 'j', type: 'text', default: 'fallback' });
        expect(byKey['k']).toEqual({ key: 'k', type: 'number', default: 1.5 });
        expect(byKey['l']).toEqual({ key: 'l', type: 'enum', values: ['a', '2', 'c'], default: 'a' });
        expect(byKey['m']).toBeUndefined();
        expect(byKey['n']).toEqual({ key: 'n', type: 'number', min: 3 });

        expect(one({ pricing: { per_second: 0.2 } }).price).toMatchObject({ unit: 'second', from: 0.2 });
        expect(one({ pricing: { pricePerMinute: 0.4 } }).price).toMatchObject({ unit: 'minute', from: 0.4 });
        expect(one({ pricing: { base_prices_by_resolution: { '720p': 1, '1080p': 2 } } })).toMatchObject({
            price: { unit: 'request', from: 1, to: 2 },
            priceIsApproximate: true,
        });
        expect(one({ pricing: { base_price: 2 } })).toMatchObject({ price: { unit: 'request', from: 2, to: 2 } });
        // An unreadable block: the cheapest and dearest figure under price-like keys, multipliers and limits ignored.
        const odd = one({
            pricing: {
                currency: 'USD',
                tiers: { per_second_hd: 0.5, per_second_sd: 0.25, high_fps_multiplier: 3 },
                max_duration: 9,
                note: 'x',
            },
        });
        expect(odd.price).toMatchObject({ unit: 'unknown', from: 0.25, to: 0.5 });
        expect(odd.priceIsApproximate).toBe(true);
        expect(one({ pricing: { weird: 'text' } }).price).toMatchObject({ unit: 'unknown', from: null, to: null });
        expect(one({ architecture: { input_modalities: ['text', 'image'] } }).maxInputImages).toBe(1);
        expect(one({ capabilities: { image_to_video: false } }).maxInputImages).toBe(0);
    });
});

describe('normalizeMediaList: tts', () => {
    it('keeps speech and prompt-driven music/sound entries and drops what no speech call can drive', () => {
        const ids = new Set(ttsModels.map((m) => m.id));
        for (const dropped of [
            'veed/clean-audio',
            'mureka-ai/vocal-clone',
            'mureka-ai/describe-song',
            'mureka-ai/stem-song',
            'mureka-ai/mureka-v7.6/recognize-song',
            'sonilo/video-to-music',
        ]) {
            expect(ids.has(dropped), dropped).toBe(false);
        }
        expect(ttsModels.length).toBeLessThan(tts.data.length);
        expect(ttsModels.length).toBeGreaterThan(20);
        const speech = ttsModels.filter((m) => !m.capabilities.music);
        expect(speech.map((m) => m.id)).toEqual(
            expect.arrayContaining([
                'Kokoro-82m',
                'tts-1',
                'gpt-4o-mini-tts',
                'microsoft/vibevoice',
                'mureka/api/generate/speech',
            ]),
        );
        for (const id of [
            'elevenlabs/music/v2',
            'google/lyria-3.5',
            'elevenlabs/sound-effects/v3',
            'ACE-Step-v1.5-XL-Turbo',
        ]) {
            expect(find(ttsModels, id).capabilities.music, id).toBe(true);
        }
    });

    it('reads the price shapes of the list', () => {
        expect(find(ttsModels, 'Kokoro-82m').price).toMatchObject({ unit: 'thousand_chars', from: 0.0017 });
        // `per_thousand_chars: 0` beside a per-generation figure is a placeholder.
        expect(find(ttsModels, 'microsoft/vibevoice').price).toMatchObject({ unit: 'request', from: 0.15 });
        expect(find(ttsModels, 'kotoba-technologies/kotoba-tts/v2/tts/ws').price).toMatchObject({
            unit: 'thousand_bytes',
            from: 0.0255,
        });
        const tokens = find(ttsModels, 'qwen-audio-3.1-tts-flash').price;
        expect(tokens).toMatchObject({ unit: 'million_tokens', byKey: { prompt: 0.391 } });
        expect(tokens.to).toBeGreaterThan(tokens.from as number);
        expect(find(ttsModels, 'elevenlabs/music/v2').price).toMatchObject({ unit: 'minute', from: 0.75 });
        expect(find(ttsModels, 'google/lyria-3.5').price).toMatchObject({ unit: 'request', from: 0.11 });
        expect(find(ttsModels, 'ACE-Step-v1.5-XL-Turbo').price).toMatchObject({ unit: 'unknown', from: null });
        expect(find(ttsModels, 'mureka/api/generate/speech')).toMatchObject({
            price: { unit: 'request' },
            capabilities: { music: false },
        });
    });

    it('reads voices, formats and settings, and never assumes a format', () => {
        const kokoro = find(ttsModels, 'Kokoro-82m');
        expect(kokoro.voices).toHaveLength(33);
        expect(kokoro.voices).toContain('af_bella');
        expect(kokoro.formats).toEqual([]);
        expect(param(kokoro, 'voice')).toMatchObject({ type: 'enum', values: kokoro.voices });
        const flash = find(ttsModels, 'qwen-audio-3.1-tts-flash');
        expect(flash.formats).toEqual(['mp3', 'wav', 'pcm']);
        expect(param(flash, 'response_format')).toMatchObject({
            type: 'enum',
            values: ['mp3', 'wav', 'pcm'],
            default: 'mp3',
        });
        expect(param(flash, 'speed')).toMatchObject({ type: 'range', min: 0.5, max: 2, default: 1 });
        expect(param(flash, 'language')?.type).toBe('enum');
        expect(param(flash, 'stream')).toBeUndefined();
        expect(find(ttsModels, 'ACE-Step-v1.5-XL-Turbo').formats).toEqual(['mp3', 'wav', 'flac', 'ogg']);
        expect(find(ttsModels, 'elevenlabs/music/v2').voices).toEqual([]);
        expect(param(find(ttsModels, 'elevenlabs/music/v2'), 'voice')).toBeUndefined();
        expect(find(ttsModels, 'kotoba-technologies/kotoba-tts/v2/tts/ws').formats).toEqual(['wav']);
        expect(param(find(ttsModels, 'google/gemini-3.8-flash-lite-tts'), 'turn_input')?.type).toBe('unknown');
    });

    it('reads handmade entries', () => {
        const one = (extra: Record<string, unknown>): MediaModel => {
            const [model] = normalizeMediaList('tts', [{ id: 't', capabilities: { text_to_speech: true }, ...extra }]);
            return model as MediaModel;
        };
        expect(one({ pricing: { per_second: 0.01 } }).price).toMatchObject({ unit: 'second', from: 0.01 });
        expect(one({ pricing: { per_billing_interval: 0.6, billing_interval_seconds: 30 } }).price).toMatchObject({
            unit: 'second',
            from: 0.02,
        });
        expect(one({ pricing: { per_billing_interval: 0.6, billing_interval_seconds: 60 } }).price).toMatchObject({
            unit: 'minute',
            from: 0.6,
        });
        expect(one({ pricing: { prompt: 1 } }).price).toMatchObject({ unit: 'million_tokens', byKey: { prompt: 1 } });
        expect(one({ pricing: { per_thousand_chars: 0 } }).price).toMatchObject({ unit: 'thousand_chars', from: 0 });
        expect(one({ pricing: { billing: 'compute' } }).price).toMatchObject({ unit: 'unknown', from: null });
        const configured = one({
            supported_parameters: {
                voices: ['a', 'b'],
                default_voice: 'b',
                output_format: { values: ['wav'] },
                required: ['voice'],
                max_chars: 10,
            },
        });
        expect(configured.params).toContainEqual({
            key: 'voice',
            type: 'enum',
            values: ['a', 'b'],
            default: 'b',
            required: true,
        });
        expect(configured.formats).toEqual(['wav']);
        expect(configured.params.some((p) => p.key === 'max_chars' || p.key === 'output_format')).toBe(false);
        expect(one({ supported_parameters: { output_formats: ['mp3'] } }).formats).toEqual(['mp3']);
        expect(one({ supported_parameters: { voices: ['a'], default_voice: 'zzz' } }).params[0]).toEqual({
            key: 'voice',
            type: 'enum',
            values: ['a'],
        });
        expect(
            one({ capabilities: { text_to_speech: true, voice_cloning: true, streaming: false } }).capabilities,
        ).toEqual({
            music: false,
            voiceCloning: true,
            streaming: false,
        });
        // Neither speech nor a text-driven audio generator: dropped.
        expect(normalizeMediaList('tts', [{ id: 'x', capabilities: { text_to_lyrics: true } }])).toEqual([]);
        expect(normalizeMediaList('tts', [{ id: 'x', architecture: { modality: 'audio->audio' } }])).toEqual([]);
        expect(
            normalizeMediaList('tts', [
                { id: 'x', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
            ])[0]?.capabilities.music,
        ).toBe(true);
    });
});

describe('normalizeMediaList: stt', () => {
    it('reads every entry and flags the voice-cloning ids that ride on the list', () => {
        expect(sttModels).toHaveLength(stt.data.length);
        for (const id of ['qwen-voice-clone', 'minimax-voice-clone', 'inworld-voice-clone']) {
            expect(find(sttModels, id).capabilities.voiceCloning, id).toBe(true);
        }
        expect(find(sttModels, 'Whisper-Large-V3').capabilities.voiceCloning).toBeUndefined();
        expect(find(sttModels, 'whisper-1').capabilities).toMatchObject({ audioInput: true });
    });

    it('reads prices and settings', () => {
        const qwen = find(sttModels, 'qwen/qwen3-asr-0.6b');
        expect(qwen.price).toMatchObject({ unit: 'minute', from: 0.0001998 });
        expect(param(qwen, 'language')).toMatchObject({ type: 'enum', default: 'auto' });
        expect(param(qwen, 'input_format')?.values).toEqual(['mp3', 'wav', 'flac', 'ogg']);
        expect(param(qwen, 'file_size_mb')).toMatchObject({ type: 'number', max: 4 });
        expect(param(qwen, 'diarize')).toBeUndefined();
        expect(qwen.subscriptionIncluded).toBe(false);
        const scribe = find(sttModels, 'elevenlabs/scribe-v3');
        expect(scribe.capabilities).toMatchObject({ diarization: true });
        expect(param(scribe, 'diarize')).toEqual({ key: 'diarize', type: 'boolean', default: false });
        expect(param(scribe, 'language')).toEqual({ key: 'language', type: 'text' });
        expect(param(find(sttModels, 'Whisper-Large-V3'), 'response_format')?.values).toContain('srt');
        expect(find(sttModels, 'omnivoice-voice-clone').price).toMatchObject({ unit: 'request', from: 1 });
    });

    it('reads handmade entries', () => {
        const one = (extra: Record<string, unknown>): MediaModel => {
            const [model] = normalizeMediaList('stt', [{ id: 's', ...extra }]);
            return model as MediaModel;
        };
        expect(one({ pricing: { per_second: 0.002 } }).price).toMatchObject({ unit: 'second', from: 0.002 });
        expect(one({ pricing: {} }).price).toMatchObject({ unit: 'unknown', from: null });
        expect(one({ capabilities: { diarization_beta: true, realtime: true } }).capabilities).toMatchObject({
            diarization: true,
            streaming: true,
        });
        expect(one({ supported_parameters: { features: ['Zero-shot Voice Cloning'] } }).capabilities.voiceCloning).toBe(
            true,
        );
        expect(one({ supported_parameters: { max_file_size_mb: 25, max_request_body_mb: 4 } }).params).toContainEqual({
            key: 'file_size_mb',
            type: 'number',
            min: 0,
            max: 4,
        });
    });
});

describe('normalizeMediaList: tolerance', () => {
    it('never throws and returns an empty list for junk', () => {
        for (const junk of [null, undefined, 5, 'x', {}, { data: 'x' }, { data: null }, [], [null, 1, 'a', [], {}]]) {
            for (const medium of ['image', 'video', 'tts', 'stt'] as const) {
                expect(normalizeMediaList(medium, junk)).toEqual([]);
            }
        }
        expect(normalizeMediaList('audio' as Medium, [{ id: 'a' }])).toEqual([]);
    });

    it('accepts a bare array, `data` or `models`, drops entries without an id and duplicates, and survives a throwing entry', () => {
        const list = [{ id: 'a' }, { id: ' ' }, { name: 'no id' }, { id: 'a', name: 'dup' }, { id: 'b', name: 'B' }];
        for (const raw of [list, { data: list }, { models: list }]) {
            expect(normalizeMediaList('stt', raw).map((m) => m.id)).toEqual(['a', 'b']);
        }
        const hostile = {
            get id(): string {
                throw new Error('boom');
            },
        };
        expect(normalizeMediaList('stt', [hostile, { id: 'ok' }]).map((m) => m.id)).toEqual(['ok']);
    });

    it('gives every field its neutral value', () => {
        expect(normalizeMediaList('image', [{ id: 'bare' }])[0]).toEqual({
            id: 'bare',
            medium: 'image',
            name: 'bare',
            description: '',
            owner: '',
            category: '',
            tags: [],
            price: { unit: 'unknown', from: null, to: null, byKey: {}, raw: {} },
            capabilities: { textToImage: true, imageToImage: false, inpainting: false },
            params: [],
            voices: [],
            formats: [],
            maxInputImages: 0,
            subscriptionIncluded: null,
            priceIsApproximate: false,
        });
    });
});

function priced(
    unit: MediaPrice['unit'],
    from: number | null,
    over: Partial<MediaModel> & { byKey?: Record<string, number>; to?: number | null } = {},
): MediaModel {
    const { byKey = {}, to = from, ...rest } = over;
    return {
        id: 'x',
        medium: 'image',
        name: 'x',
        description: '',
        owner: '',
        category: '',
        tags: [],
        price: { unit, from, to, byKey, raw: null },
        capabilities: {},
        params: [],
        voices: [],
        formats: [],
        maxInputImages: 0,
        subscriptionIncluded: null,
        priceIsApproximate: false,
        ...rest,
    };
}

describe('estimateImageCost', () => {
    const model = priced('image', 0.0034, {
        byKey: { '512x512': 0.0034, '1024x1024': 0.0051, '2048*2048': 0.0068 },
        to: 0.0068,
    });

    it('multiplies the price of the size by the number of images', () => {
        expect(estimateImageCost(model, { n: 3, size: '1024x1024' })).toBe(0.0153);
        expect(estimateImageCost(model, { size: '512x512' })).toBe(0.0034);
    });

    it('falls back to the cheapest known price', () => {
        expect(estimateImageCost(model, {})).toBe(0.0034);
        expect(estimateImageCost(model, { n: 2, size: '4000x4000' })).toBe(0.0068);
        expect(estimateImageCost(model, { size: '  ' })).toBe(0.0034);
    });

    it('treats x, X, the multiplication sign and the asterisk alike', () => {
        expect(estimateImageCost(model, { size: '2048x2048' })).toBe(0.0068);
        expect(estimateImageCost(model, { size: '2048X2048' })).toBe(0.0068);
        expect(estimateImageCost(model, { size: '2048×2048' })).toBe(0.0068);
        expect(estimateImageCost(model, { size: '1024*1024' })).toBe(0.0051);
    });

    it('counts a missing or invalid n as one image', () => {
        for (const n of [0, -2, 1.5, Number.NaN]) expect(estimateImageCost(model, { n, size: '512x512' })).toBe(0.0034);
    });

    it('prices a per-megapixel model from the size and gives up otherwise', () => {
        const mp = priced('megapixel', 0.05);
        expect(estimateImageCost(mp, { size: '1024x1024', n: 2 })).toBe(0.1048576);
        expect(estimateImageCost(mp, { size: 'square_hd' })).toBeNull();
        expect(estimateImageCost(mp, {})).toBeNull();
        expect(estimateImageCost(priced('unknown', 0.08), { size: '1024x1024' })).toBeNull();
        expect(estimateImageCost(priced('image', null), {})).toBeNull();
    });

    it('estimates the real fixtures', () => {
        expect(estimateImageCost(find(imageModels, 'rev-animated'), { n: 2, size: '512x512' })).toBe(0.0034);
        expect(estimateImageCost(find(imageModels, 'topaz-image-upscale'), {})).toBeNull();
        expect(estimateImageCost(find(imageModels, 'Cropper'), { n: 4 })).toBe(0);
    });
});

describe('estimateVideoCost', () => {
    const perSecond = priced('second', 0.1, { byKey: { '720p': 0.1, '1080p': 0.25 }, to: 0.25, medium: 'video' });

    it('multiplies seconds by the rate of the resolution, the cheapest when it is not named', () => {
        expect(estimateVideoCost(perSecond, { duration: 5, resolution: '1080p' })).toBe(1.25);
        expect(estimateVideoCost(perSecond, { duration: 5, resolution: '1080P' })).toBe(1.25);
        expect(estimateVideoCost(perSecond, { duration: 5 })).toBe(0.5);
        expect(estimateVideoCost(perSecond, { duration: 5, resolution: '4k' })).toBe(0.5);
    });

    it('is not computable without a duration, with approximate or missing prices, or for other units', () => {
        expect(estimateVideoCost(perSecond, {})).toBeNull();
        expect(estimateVideoCost(perSecond, { duration: 0 })).toBeNull();
        expect(estimateVideoCost(perSecond, { duration: -3 })).toBeNull();
        expect(estimateVideoCost({ ...perSecond, priceIsApproximate: true }, { duration: 5 })).toBeNull();
        expect(estimateVideoCost(priced('second', null, { medium: 'video' }), { duration: 5 })).toBeNull();
        expect(estimateVideoCost(priced('unknown', 1, { medium: 'video' }), { duration: 5 })).toBeNull();
    });

    it('prices per minute, per video and per duration', () => {
        expect(estimateVideoCost(priced('minute', 0.6, { medium: 'video' }), { duration: 30 })).toBe(0.3);
        expect(estimateVideoCost(priced('request', 0.15, { medium: 'video' }), { duration: 5 })).toBe(0.15);
        const perDuration = priced('request', 0.21, { byKey: { '5s': 0.21, '10s': 0.42 }, to: 0.42, medium: 'video' });
        expect(estimateVideoCost(perDuration, { duration: 10 })).toBe(0.42);
        expect(estimateVideoCost(perDuration, { duration: 7 })).toBeNull();
        expect(estimateVideoCost(perDuration, {})).toBe(0.21);
    });

    it('estimates the real fixtures it can and refuses the ones it cannot', () => {
        expect(estimateVideoCost(find(videoModels, 'vidu-q4'), { duration: 5, resolution: '720p' })).toBe(0.5225);
        expect(estimateVideoCost(find(videoModels, 'kling-v25-turbo-std'), { duration: 5 })).toBe(0.21);
        expect(estimateVideoCost(find(videoModels, 'kling-v26-pro'), { duration: 5 })).toBeNull();
        expect(estimateVideoCost(find(videoModels, 'lightricks/ltx-2.5/reframe'), { duration: 5 })).toBeNull();
    });
});

describe('estimateTtsCost', () => {
    it('prices per thousand characters and per generation', () => {
        expect(estimateTtsCost(priced('thousand_chars', 0.0017, { medium: 'tts' }), 20)).toBe(0.000034);
        expect(estimateTtsCost(priced('thousand_chars', 0.0255, { medium: 'tts' }), 0)).toBe(0);
        expect(estimateTtsCost(priced('request', 0.15, { medium: 'tts' }), 5000)).toBe(0.15);
    });

    it('is not computable for other units, missing prices and bad counts', () => {
        for (const unit of ['second', 'minute', 'million_tokens', 'thousand_bytes', 'unknown'] as const) {
            expect(estimateTtsCost(priced(unit, 1, { medium: 'tts' }), 100), unit).toBeNull();
        }
        expect(estimateTtsCost(priced('thousand_chars', null, { medium: 'tts' }), 100)).toBeNull();
        expect(estimateTtsCost(priced('thousand_chars', 1, { medium: 'tts' }), -1)).toBeNull();
        expect(estimateTtsCost(priced('thousand_chars', 1, { medium: 'tts' }), Number.NaN)).toBeNull();
        expect(estimateTtsCost(find(ttsModels, 'Kokoro-82m'), 20)).toBe(0.000034);
    });
});

describe('estimateSttCost', () => {
    it('prices per minute, per second and per run', () => {
        expect(estimateSttCost(priced('minute', 0.0001998, { medium: 'stt' }), 2)).toBe(0.00000666);
        expect(estimateSttCost(priced('minute', 0.6, { medium: 'stt' }), 90)).toBe(0.9);
        expect(estimateSttCost(priced('second', 0.01, { medium: 'stt' }), 30)).toBe(0.3);
        expect(estimateSttCost(priced('request', 1, { medium: 'stt' }), 3)).toBe(1);
        expect(estimateSttCost(find(sttModels, 'qwen/qwen3-asr-0.6b'), 2)).toBe(0.00000666);
    });

    it('is not computable for other units, missing prices and bad durations', () => {
        expect(estimateSttCost(priced('image', 1, { medium: 'stt' }), 10)).toBeNull();
        expect(estimateSttCost(priced('minute', null, { medium: 'stt' }), 10)).toBeNull();
        expect(estimateSttCost(priced('minute', 1, { medium: 'stt' }), -1)).toBeNull();
        expect(estimateSttCost(priced('minute', 1, { medium: 'stt' }), Number.POSITIVE_INFINITY)).toBeNull();
    });
});

describe('describePrice', () => {
    it('words a price without a locale', () => {
        expect(describePrice({ unit: 'image', from: 0.0017, to: 0.0017, byKey: {}, raw: null })).toBe('0.0017/image');
        expect(describePrice({ unit: 'image', from: 0.0017, to: 0.0051, byKey: {}, raw: null })).toBe(
            '0.0017-0.0051/image',
        );
        expect(describePrice({ unit: 'unknown', from: null, to: null, byKey: {}, raw: null })).toBe('?');
        expect(describePrice({ unit: 'second', from: 1, to: null, byKey: {}, raw: null })).toBe('1/second');
    });
});
