import { describe, expect, it } from 'vitest';
import { normalizeMediaList } from '../../src/domain/media';
import {
    buildImageBody,
    buildSttFields,
    buildTtsBody,
    buildVideoBody,
    checkImageRequest,
    checkSttRequest,
    checkTtsRequest,
    checkVideoRequest,
    countChars,
    filterExtra,
    MAX_INPUT_BYTES,
    requestedSeconds,
    safeFileName,
} from '../../src/domain/media-request';
import type { MediaModel } from '../../src/shared/contracts-media';
import images from '../../tools/fixtures/media/images_models.json';
import stt from '../../tools/fixtures/media/audio_models_stt.json';
import tts from '../../tools/fixtures/media/audio_models_tts.json';
import videos from '../../tools/fixtures/media/video_models.json';

const find = (models: MediaModel[], id: string): MediaModel => {
    const found = models.find((m) => m.id === id);
    if (!found) throw new Error(`missing ${id}`);
    return found;
};
const imageModels = normalizeMediaList('image', images);
const ttsModels = normalizeMediaList('tts', tts);
const sttModels = normalizeMediaList('stt', stt);
const videoModels = normalizeMediaList('video', videos);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_URL = `data:image/png;base64,${PNG}`;
const big = (bytes: number): string => Buffer.alloc(bytes, 1).toString('base64');

describe('checkImageRequest', () => {
    it('accepts the minimum and keeps only what was set', () => {
        expect(checkImageRequest({ model: 'rev-animated', prompt: 'a lighthouse' })).toEqual({
            ok: true,
            value: { model: 'rev-animated', prompt: 'a lighthouse' },
        });
    });

    it('carries every field through, trimming the single-line ones', () => {
        const result = checkImageRequest({
            model: ' rev-animated ',
            prompt: 'a\nlighthouse',
            negativePrompt: 'blur',
            n: 2,
            size: ' 512x512 ',
            aspectRatio: '16:9',
            seed: 7,
            steps: 20,
            guidance: 7.5,
            inputImages: [PNG_URL, 'https://example.test/a.png'],
            mask: PNG_URL,
            extra: { quality: 'high' },
            keyId: 'secret-1',
            connectionId: 'abc12345',
            billing: 'paygo',
        });
        expect(result).toEqual({
            ok: true,
            value: {
                model: 'rev-animated',
                prompt: 'a\nlighthouse',
                negativePrompt: 'blur',
                n: 2,
                size: '512x512',
                aspectRatio: '16:9',
                seed: 7,
                steps: 20,
                guidance: 7.5,
                inputImages: [PNG_URL, 'https://example.test/a.png'],
                mask: PNG_URL,
                extra: { quality: 'high' },
                keyId: 'secret-1',
                connectionId: 'abc12345',
                billing: 'paygo',
            },
        });
    });

    it('refuses bad bodies with a one-line message', () => {
        const bad = (body: unknown) => {
            const result = checkImageRequest(body);
            expect(result.ok).toBe(false);
            return result.ok ? null : result;
        };
        expect(bad(null)?.code).toBe('invalid_request');
        expect(bad([])?.status).toBe(400);
        expect(bad({ prompt: 'x' })?.message).toContain('"model"');
        expect(bad({ model: 'm' })?.message).toContain('"prompt"');
        expect(bad({ model: 'm', prompt: '   ' })?.message).toContain('"prompt"');
        expect(bad({ model: 'm', prompt: 5 })?.message).toContain('"prompt"');
        expect(bad({ model: 'm', prompt: 'x'.repeat(50_001) })?.message).toContain('"prompt"');
        expect(bad({ model: 'bad\nmodel', prompt: 'x' })?.message).toContain('"model"');
        expect(bad({ model: 'm'.repeat(301), prompt: 'x' })?.message).toContain('"model"');
        expect(bad({ model: 'm', prompt: 'x', n: 0 })?.message).toContain('"n"');
        expect(bad({ model: 'm', prompt: 'x', n: 1.5 })?.message).toContain('"n"');
        expect(bad({ model: 'm', prompt: 'x', n: '2' })?.message).toContain('"n"');
        expect(bad({ model: 'm', prompt: 'x', size: 5 })?.message).toContain('"size"');
        expect(bad({ model: 'm', prompt: 'x', size: 'a'.repeat(41) })?.message).toContain('"size"');
        expect(bad({ model: 'm', prompt: 'x', aspectRatio: [] })?.message).toContain('"aspectRatio"');
        expect(bad({ model: 'm', prompt: 'x', seed: 1.5 })?.message).toContain('"seed"');
        expect(bad({ model: 'm', prompt: 'x', steps: 0 })?.message).toContain('"steps"');
        expect(bad({ model: 'm', prompt: 'x', guidance: 'high' })?.message).toContain('"guidance"');
        expect(bad({ model: 'm', prompt: 'x', negativePrompt: 3 })?.message).toContain('"negativePrompt"');
        expect(bad({ model: 'm', prompt: 'x', keyId: 5 })?.message).toContain('"keyId"');
        expect(bad({ model: 'm', prompt: 'x', connectionId: 'c'.repeat(65) })?.message).toContain('"connectionId"');
        expect(bad({ model: 'm', prompt: 'x', billing: 'free' })?.message).toContain('"billing"');
        expect(bad({ model: 'm', prompt: 'x', extra: [] })?.message).toContain('"extra"');
        expect(bad({ model: 'm', prompt: 'x', extra: { 'bad key': 1 } })?.message).toContain('"extra"');
        expect(bad({ model: 'm', prompt: 'x', extra: JSON.parse('{"__proto__": {"a": 1}}') })?.message).toContain(
            '"extra"',
        );
        expect(bad({ model: 'm', prompt: 'x', extra: { a: 'x'.repeat(17_000) } })?.message).toContain('"extra"');
        expect(
            bad({
                model: 'm',
                prompt: 'x',
                extra: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, 1])),
            })?.message,
        ).toContain('"extra"');
        expect(bad({ model: 'm', prompt: 'x', inputImages: 'x' })?.message).toContain('"inputImages"');
        expect(bad({ model: 'm', prompt: 'x', inputImages: Array(17).fill(PNG_URL) })?.message).toContain(
            '"inputImages"',
        );
        expect(bad({ model: 'm', prompt: 'x', inputImages: ['http://insecure.test/a.png'] })?.message).toContain(
            '"inputImages"',
        );
        expect(bad({ model: 'm', prompt: 'x', inputImages: ['data:text/plain;base64,QQ=='] })?.message).toContain(
            '"inputImages"',
        );
        expect(bad({ model: 'm', prompt: 'x', inputImages: ['data:image/png;base64,not base64!'] })?.message).toContain(
            '"inputImages"',
        );
        expect(bad({ model: 'm', prompt: 'x', mask: 'https://example.test/m.png' })?.message).toContain('"mask"');
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        expect(bad({ model: 'm', prompt: 'x', extra: circular })?.message).toContain('"extra"');
    });

    it('refuses inputs over 4 MB in total with payload_too_large', () => {
        const half = `data:image/png;base64,${big(MAX_INPUT_BYTES / 2 + 10)}`;
        const result = checkImageRequest({ model: 'm', prompt: 'x', inputImages: [half, half] });
        expect(result).toMatchObject({ ok: false, status: 413, code: 'payload_too_large' });
        const withMask = checkImageRequest({ model: 'm', prompt: 'x', inputImages: [half], mask: half });
        expect(withMask).toMatchObject({ ok: false, status: 413 });
        expect(checkImageRequest({ model: 'm', prompt: 'x', inputImages: [half] }).ok).toBe(true);
    });
});

describe('checkTtsRequest', () => {
    it('accepts a request and lower-cases the format', () => {
        expect(
            checkTtsRequest({
                model: 'Kokoro-82m',
                input: 'Hello there',
                voice: 'af_bella',
                format: 'MP3',
                speed: 1.2,
                instructions: 'calm',
            }),
        ).toEqual({
            ok: true,
            value: {
                model: 'Kokoro-82m',
                input: 'Hello there',
                voice: 'af_bella',
                format: 'mp3',
                speed: 1.2,
                instructions: 'calm',
            },
        });
        expect(checkTtsRequest({ model: 'm', input: 'x' })).toEqual({ ok: true, value: { model: 'm', input: 'x' } });
    });

    it('refuses bad bodies', () => {
        const message = (body: unknown): string => {
            const result = checkTtsRequest(body);
            return result.ok ? 'ACCEPTED' : result.message;
        };
        expect(message(null)).toContain('JSON object');
        expect(message({ input: 'x' })).toContain('"model"');
        expect(message({ model: 'm' })).toContain('"input"');
        expect(message({ model: 'm', input: '  ' })).toContain('"input"');
        expect(message({ model: 'm', input: 'x'.repeat(100_001) })).toContain('"input"');
        expect(message({ model: 'm', input: 'x', voice: 5 })).toContain('"voice"');
        expect(message({ model: 'm', input: 'x', format: 'mp3!' })).toContain('"format"');
        expect(message({ model: 'm', input: 'x', format: 4 })).toContain('"format"');
        expect(message({ model: 'm', input: 'x', speed: 9 })).toContain('"speed"');
        expect(message({ model: 'm', input: 'x', instructions: 5 })).toContain('"instructions"');
        expect(message({ model: 'm', input: 'x', extra: 'x' })).toContain('"extra"');
    });

    it('counts characters as code points', () => {
        expect(countChars('Hello')).toBe(5);
        expect(countChars('Привет')).toBe(6);
        expect(countChars('a😀b')).toBe(3);
        expect(countChars('')).toBe(0);
    });
});

describe('checkSttRequest', () => {
    const wav = Buffer.from('RIFFxxxxWAVEfmt ').toString('base64');

    it('accepts a recording and sanitises its name, mime and base64', () => {
        const result = checkSttRequest({
            model: 'qwen/qwen3-asr-0.6b',
            audioBase64: `data:audio/wav;base64,${wav.slice(0, 8)}\n${wav.slice(8)}`,
            filename: '../../etc/pass wd.wav',
            mime: 'Audio/WAV',
            language: 'en',
            prompt: 'names',
            diarize: true,
        });
        expect(result).toEqual({
            ok: true,
            value: {
                model: 'qwen/qwen3-asr-0.6b',
                audioBase64: wav,
                filename: 'pass wd.wav',
                mime: 'audio/wav',
                language: 'en',
                prompt: 'names',
                diarize: true,
            },
        });
        expect(checkSttRequest({ model: 'm', audioBase64: wav })).toMatchObject({
            ok: true,
            value: { filename: 'audio', mime: 'application/octet-stream' },
        });
    });

    it('refuses bad bodies and recordings over 4 MB', () => {
        const message = (body: unknown): string => {
            const result = checkSttRequest(body);
            return result.ok ? 'ACCEPTED' : `${result.status} ${result.code} ${result.message}`;
        };
        expect(message(null)).toContain('JSON object');
        expect(message({ model: 'm' })).toContain('"audioBase64" is required');
        expect(message({ model: 'm', audioBase64: 'not base64!' })).toContain('must be base64');
        expect(message({ model: 'm', audioBase64: 'data:audio/wav;base64,' })).toContain('"audioBase64"');
        expect(message({ model: 'm', audioBase64: ' ' })).toContain('"audioBase64"');
        expect(message({ model: 'm', audioBase64: wav, filename: 5 })).toContain('"filename"');
        expect(message({ model: 'm', audioBase64: wav, mime: 'nonsense' })).toContain('"mime"');
        expect(message({ model: 'm', audioBase64: wav, mime: 4 })).toContain('"mime"');
        expect(message({ model: 'm', audioBase64: wav, language: 'x'.repeat(21) })).toContain('"language"');
        expect(message({ model: 'm', audioBase64: wav, prompt: 5 })).toContain('"prompt"');
        expect(message({ model: 'm', audioBase64: wav, diarize: 'yes' })).toContain('"diarize"');
        expect(message({ model: 'm', audioBase64: wav, extra: 5 })).toContain('"extra"');
        expect(message({ model: 'm', audioBase64: big(MAX_INPUT_BYTES + 1) })).toBe(
            '413 payload_too_large The recording is larger than 4 MB',
        );
        expect(message({ model: 'm', audioBase64: big(MAX_INPUT_BYTES) })).toBe('ACCEPTED');
    });

    it('makes a safe file name', () => {
        expect(safeFileName('a/b\\c.mp3')).toBe('c.mp3');
        expect(safeFileName('"quoted".wav')).toBe('_quoted_.wav');
        expect(safeFileName('..hidden')).toBe('hidden');
        expect(safeFileName('')).toBe('audio');
        expect(safeFileName(undefined)).toBe('audio');
        expect(safeFileName('\n\r')).toBe('_');
        expect(safeFileName('x'.repeat(300))).toHaveLength(120);
    });
});

describe('checkVideoRequest', () => {
    it('accepts a prompt, or just an image to animate', () => {
        expect(
            checkVideoRequest({
                model: 'kling-v25-turbo-std',
                prompt: 'a cat',
                duration: 5,
                aspectRatio: '16:9',
                resolution: '720p',
                seed: 3,
                imageUrl: 'https://example.test/a.png',
                extra: { camera_fixed: true },
            }),
        ).toEqual({
            ok: true,
            value: {
                model: 'kling-v25-turbo-std',
                prompt: 'a cat',
                duration: 5,
                aspectRatio: '16:9',
                resolution: '720p',
                seed: 3,
                imageUrl: 'https://example.test/a.png',
                extra: { camera_fixed: true },
            },
        });
        expect(checkVideoRequest({ model: 'm', imageUrl: PNG_URL })).toMatchObject({
            ok: true,
            value: { prompt: '', imageUrl: PNG_URL },
        });
    });

    it('refuses bad bodies', () => {
        const message = (body: unknown): string => {
            const result = checkVideoRequest(body);
            return result.ok ? 'ACCEPTED' : `${result.status} ${result.message}`;
        };
        expect(message(null)).toContain('JSON object');
        expect(message({ prompt: 'x' })).toContain('"model"');
        expect(message({ model: 'm' })).toContain('"prompt" is required');
        expect(message({ model: 'm', prompt: ' ', imageUrl: '' })).toContain('"prompt" is required');
        expect(message({ model: 'm', prompt: 5 })).toContain('"prompt"');
        expect(message({ model: 'm', prompt: 'x', imageUrl: 5 })).toContain('"imageUrl"');
        expect(message({ model: 'm', prompt: 'x', imageUrl: 'ftp://x' })).toContain('"imageUrl"');
        expect(message({ model: 'm', prompt: 'x', imageUrl: 'http://insecure.test/a.png' })).toContain('"imageUrl"');
        expect(message({ model: 'm', prompt: 'x', duration: 0 })).toContain('"duration"');
        expect(message({ model: 'm', prompt: 'x', duration: 'five' })).toContain('"duration"');
        expect(message({ model: 'm', prompt: 'x', aspectRatio: 5 })).toContain('"aspectRatio"');
        expect(message({ model: 'm', prompt: 'x', resolution: 5 })).toContain('"resolution"');
        expect(message({ model: 'm', prompt: 'x', seed: 1.2 })).toContain('"seed"');
        expect(message({ model: 'm', prompt: 'x', extra: [] })).toContain('"extra"');
        expect(
            message({ model: 'm', prompt: 'x', imageUrl: `data:image/png;base64,${big(MAX_INPUT_BYTES + 1)}` }),
        ).toBe('413 The start image is larger than 4 MB');
    });

    it('reads the seconds a request names', () => {
        expect(requestedSeconds({ duration: 5 })).toBe(5);
        expect(requestedSeconds({ duration: 0 })).toBeNull();
        expect(requestedSeconds({})).toBeNull();
    });
});

describe('upstream bodies', () => {
    it('filters extra to what the model lists and never lets it override what the plugin sets', () => {
        const rev = find(imageModels, 'gpt-image-2.6-flare');
        expect(
            filterExtra(rev, { quality: 'high', bogus: 1, model: 'evil', size: 'x', stream: true, complexity: 'low' }),
        ).toEqual({
            quality: 'high',
            complexity: 'low',
        });
        expect(filterExtra(rev, undefined)).toEqual({});
        expect(filterExtra(null, { quality: 'high' })).toEqual({});
        expect(filterExtra(rev, { quality: 'high', seed: 1 }, ['quality'])).toEqual({});
    });

    it('builds the OpenAI image body with b64_json, the model-specific fields and input images', () => {
        const flare = find(imageModels, 'gpt-image-2.6-flare');
        expect(
            buildImageBody(flare, {
                model: flare.id,
                prompt: 'a lighthouse',
                n: 2,
                size: '1024x1024',
                negativePrompt: 'blur',
                aspectRatio: '1:1',
                seed: 9,
                steps: 20,
                guidance: 6,
                inputImages: [PNG_URL],
                mask: PNG_URL,
                extra: { quality: 'high', nope: 1 },
            }),
        ).toEqual({
            quality: 'high',
            model: flare.id,
            prompt: 'a lighthouse',
            n: 2,
            response_format: 'b64_json',
            size: '1024x1024',
            negative_prompt: 'blur',
            aspect_ratio: '1:1',
            seed: 9,
            num_inference_steps: 20,
            guidance_scale: 6,
            imageDataUrl: PNG_URL,
            maskDataUrl: PNG_URL,
        });
        expect(buildImageBody(null, { model: 'm', prompt: 'p' })).toEqual({
            model: 'm',
            prompt: 'p',
            n: 1,
            response_format: 'b64_json',
        });
        expect(buildImageBody(null, { model: 'm', prompt: 'p', inputImages: [PNG_URL, PNG_URL] })).toMatchObject({
            imageDataUrls: [PNG_URL, PNG_URL],
        });
    });

    it('builds the speech body with the default voice, never a format of its own', () => {
        const kokoro = find(ttsModels, 'Kokoro-82m');
        expect(buildTtsBody(kokoro, { model: kokoro.id, input: 'Hi' })).toEqual({
            model: kokoro.id,
            input: 'Hi',
            voice: kokoro.voices[0],
        });
        expect(
            buildTtsBody(kokoro, {
                model: kokoro.id,
                input: 'Hi',
                voice: 'af_bella',
                format: 'mp3',
                speed: 1.1,
                instructions: 'calm',
            }),
        ).toEqual({
            model: kokoro.id,
            input: 'Hi',
            voice: 'af_bella',
            response_format: 'mp3',
            speed: 1.1,
            instructions: 'calm',
        });
        // The model's own default voice wins over the first one; extra cannot set the voice behind the client's back.
        const withDefault = normalizeMediaList('tts', [
            {
                id: 'v',
                capabilities: { text_to_speech: true },
                supported_parameters: { voices: ['a', 'b'], default_voice: 'b', pitch: { min: 0.5, max: 2 } },
            },
        ])[0] as MediaModel;
        expect(buildTtsBody(withDefault, { model: 'v', input: 'x', extra: { pitch: 1.5, voice: 'a' } })).toEqual({
            model: 'v',
            input: 'x',
            pitch: 1.5,
            voice: 'b',
        });
        expect(buildTtsBody(null, { model: 'm', input: 'x' })).toEqual({ model: 'm', input: 'x' });
    });

    it('builds the video body with the duration as a string and the right image field', () => {
        const turbo = find(videoModels, 'kling-v25-turbo-std');
        expect(buildVideoBody(turbo, { model: turbo.id, prompt: 'a cat', duration: 5 })).toEqual({
            model: turbo.id,
            prompt: 'a cat',
            duration: '5',
        });
        expect(
            buildVideoBody(null, {
                model: 'm',
                prompt: 'p',
                aspectRatio: '16:9',
                resolution: '720p',
                seed: 4,
                imageUrl: 'https://example.test/a.png',
            }),
        ).toEqual({
            model: 'm',
            prompt: 'p',
            aspect_ratio: '16:9',
            resolution: '720p',
            seed: 4,
            imageUrl: 'https://example.test/a.png',
        });
        expect(buildVideoBody(null, { model: 'm', prompt: 'p', imageUrl: PNG_URL })).toMatchObject({
            imageDataUrl: PNG_URL,
        });
    });

    it('builds the transcription fields, asking for verbose_json and diarization only where offered', () => {
        const whisper = find(sttModels, 'Whisper-Large-V3');
        expect(
            buildSttFields(whisper, {
                model: whisper.id,
                audioBase64: 'QQ==',
                filename: 'a',
                mime: 'audio/wav',
                language: 'en',
                prompt: 'p',
            }),
        ).toEqual([
            ['model', whisper.id],
            ['language', 'en'],
            ['prompt', 'p'],
            ['response_format', 'verbose_json'],
        ]);
        const scribe = find(sttModels, 'elevenlabs/scribe-v3');
        expect(
            buildSttFields(scribe, {
                model: scribe.id,
                audioBase64: 'QQ==',
                filename: 'a',
                mime: 'audio/wav',
                diarize: true,
            }),
        ).toContainEqual(['diarize', 'true']);
        const qwen = find(sttModels, 'qwen/qwen3-asr-0.6b');
        expect(
            buildSttFields(qwen, {
                model: qwen.id,
                audioBase64: 'QQ==',
                filename: 'a',
                mime: 'audio/wav',
                diarize: true,
            }),
        ).toEqual([['model', qwen.id]]);
        expect(
            buildSttFields(whisper, {
                model: whisper.id,
                audioBase64: 'QQ==',
                filename: 'a',
                mime: 'audio/wav',
                extra: { response_format: 'text', language: 'x', unknown: 1 },
            }),
        ).toEqual([
            ['model', whisper.id],
            ['response_format', 'verbose_json'],
        ]);
        expect(buildSttFields(null, { model: 'm', audioBase64: 'QQ==', filename: 'a', mime: 'audio/wav' })).toEqual([
            ['model', 'm'],
        ]);
        const withExtra = normalizeMediaList('stt', [
            { id: 's', supported_parameters: { features: [] } },
        ])[0] as MediaModel;
        withExtra.params.push(
            { key: 'temperature', type: 'number' },
            { key: 'obj', type: 'unknown' },
            { key: 'nothing', type: 'unknown' },
        );
        expect(
            buildSttFields(withExtra, {
                model: 's',
                audioBase64: 'QQ==',
                filename: 'a',
                mime: 'audio/wav',
                extra: { temperature: 0.2, obj: { a: 1 }, nothing: null },
            }),
        ).toEqual([
            ['model', 's'],
            ['temperature', '0.2'],
        ]);
    });
});
