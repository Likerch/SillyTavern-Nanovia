import { describe, expect, it } from 'vitest';
import type { ParamSpec } from '../../src/shared/contracts-media';
import {
    MAX_UPLOAD_BYTES,
    buildImageRequest,
    buildSttRequest,
    buildTtsRequest,
    buildVideoRequest,
    checkAudioBytes,
    checkImageDataUrl,
    choiceValue,
    dataUrlBytes,
    downloadName,
    emptyImageDraft,
    emptySttDraft,
    emptyTtsDraft,
    emptyVideoDraft,
    extensionOf,
    findParam,
    imageForm,
    parseDuration,
    parseNumber,
    parseSize,
    stripDataUrl,
    sttForm,
    ttsForm,
    videoForm,
} from '../../src/features/media/param-form';
import type { AudioInput, ImageDraft } from '../../src/features/media/param-form';
import { mediaModel } from '../helpers/media-fake';

const enumSpec = (key: string, values: string[], fallback?: string): ParamSpec => ({
    key,
    type: 'enum',
    values,
    ...(fallback !== undefined ? { default: fallback } : {}),
});
const rangeSpec = (key: string, min: number, max: number, extra: Partial<ParamSpec> = {}): ParamSpec => ({
    key,
    type: 'range',
    min,
    max,
    ...extra,
});

const PNG = 'data:image/png;base64,AAAA';

describe('parsing what a user types', () => {
    it('numbers: empty is "no value", a comma is a decimal mark, junk is not a number', () => {
        expect(parseNumber('')).toBeNull();
        expect(parseNumber('   ')).toBeNull();
        expect(parseNumber('12')).toBe(12);
        expect(parseNumber('0,5')).toBe(0.5);
        expect(parseNumber(' -3.25 ')).toBe(-3.25);
        expect(parseNumber('1 000')).toBe(1000);
        expect(parseNumber('abc')).toBeUndefined();
        expect(parseNumber('1e5')).toBeUndefined();
        expect(parseNumber('1.')).toBeUndefined();
    });

    it('sizes: WxH in the forms people type, nothing else', () => {
        expect(parseSize('1024x1024')).toEqual({ width: 1024, height: 1024 });
        expect(parseSize(' 1376 X 768 ')).toEqual({ width: 1376, height: 768 });
        expect(parseSize('512*768')).toEqual({ width: 512, height: 768 });
        expect(parseSize('512×512')).toEqual({ width: 512, height: 512 });
        expect(parseSize('1024')).toBeNull();
        expect(parseSize('16:9')).toBeNull();
        expect(parseSize('0x0')).toBeNull();
        expect(parseSize('1x1')).toBeNull();
        expect(parseSize('100000x100')).toBeNull();
        expect(parseSize('auto')).toBeNull();
    });

    it('durations: the leading number of a word', () => {
        expect(parseDuration('5')).toBe(5);
        expect(parseDuration('8s')).toBe(8);
        expect(parseDuration('12 s')).toBe(12);
        expect(parseDuration('2,5s')).toBe(2.5);
        expect(parseDuration('')).toBeNull();
        expect(parseDuration('long')).toBeNull();
        expect(parseDuration('0')).toBeNull();
    });
});

describe('the 4 MB ceiling', () => {
    it('measures a data URL after encoding and accepts only images', () => {
        expect(dataUrlBytes(PNG)).toBe(PNG.length);
        expect(checkImageDataUrl(PNG)).toBe('ok');
        expect(checkImageDataUrl('data:image/jpeg;base64,AAAA')).toBe('ok');
        expect(checkImageDataUrl('data:text/plain;base64,AAAA')).toBe('not_image');
        expect(checkImageDataUrl('https://x.test/a.png')).toBe('not_image');
        const edge = `data:image/png;base64,${'A'.repeat(MAX_UPLOAD_BYTES - 'data:image/png;base64,'.length)}`;
        expect(edge).toHaveLength(MAX_UPLOAD_BYTES);
        expect(checkImageDataUrl(edge)).toBe('ok');
        expect(checkImageDataUrl(`${edge}A`)).toBe('too_large');
    });

    it('audio: a file or recording of 4 MB at most, not empty', () => {
        expect(checkAudioBytes(0)).toBe('empty');
        expect(checkAudioBytes(-1)).toBe('empty');
        expect(checkAudioBytes(1)).toBe('ok');
        expect(checkAudioBytes(MAX_UPLOAD_BYTES)).toBe('ok');
        expect(checkAudioBytes(MAX_UPLOAD_BYTES + 1)).toBe('too_large');
        expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
    });

    it('strips the data URL prefix', () => {
        expect(stripDataUrl('data:audio/webm;base64,QUJD')).toBe('QUJD');
        expect(stripDataUrl('QUJD')).toBe('QUJD');
    });
});

describe('files', () => {
    it('extensions follow the content type the response had', () => {
        expect(extensionOf('audio/x-wav')).toBe('wav');
        expect(extensionOf('audio/mpeg')).toBe('mp3');
        expect(extensionOf('audio/webm;codecs=opus')).toBe('webm');
        expect(extensionOf('image/jpeg')).toBe('jpg');
        expect(extensionOf('video/mp4')).toBe('mp4');
        expect(extensionOf('audio/aiff')).toBe('aiff');
        expect(extensionOf('application/octet-stream')).toBe('bin');
        expect(extensionOf('')).toBe('bin');
    });

    it('download names are safe', () => {
        expect(downloadName('black-forest-labs/flux 1', 0, 'image/png')).toBe('nanovia-black-forest-labs-flux-1-1.png');
        expect(downloadName('Kokoro-82m', 2, 'audio/x-wav')).toBe('nanovia-Kokoro-82m-3.wav');
        expect(downloadName('///', 0, 'image/webp')).toBe('nanovia-media-1.webp');
    });
});

describe('param lookup', () => {
    it('finds the first listed alias, in any case', () => {
        const model = mediaModel({ id: 'm', medium: 'image', params: [rangeSpec('Num_Inference_Steps', 1, 50)] });
        expect(findParam(model, ['steps', 'num_inference_steps'])?.key).toBe('Num_Inference_Steps');
        expect(findParam(model, ['seed'])).toBeNull();
    });
});

describe('image form', () => {
    it('a model that lists nothing gets only prompt and count', () => {
        const spec = imageForm(mediaModel({ id: 'm', medium: 'image' }));
        expect(spec).toEqual({
            size: null,
            aspect: null,
            negative: false,
            count: { max: 4 },
            seed: null,
            steps: null,
            guidance: null,
            references: null,
        });
    });

    it('turns what the model lists into fields', () => {
        const model = mediaModel({
            id: 'm',
            medium: 'image',
            maxInputImages: 3,
            params: [
                enumSpec('size', ['512x512', '1024x1024'], '1024x1024'),
                enumSpec('aspect_ratio', ['1:1', '16:9']),
                { key: 'negative_prompt', type: 'boolean' },
                { key: 'max_images', type: 'integer', max: 8 },
                { key: 'seed', type: 'integer', min: 0, max: 99 },
                rangeSpec('num_inference_steps', 1, 50, { default: 30 }),
                rangeSpec('guidance_scale', 0, 20, { default: 7.5 }),
            ],
        });
        const spec = imageForm(model);
        expect(spec.size).toEqual({
            kind: 'enum',
            key: 'size',
            values: ['512x512', '1024x1024'],
            default: '1024x1024',
        });
        expect(spec.aspect).toEqual({ kind: 'enum', key: 'aspect_ratio', values: ['1:1', '16:9'], default: '1:1' });
        expect(spec.negative).toBe(true);
        expect(spec.count).toEqual({ max: 8 });
        expect(spec.seed).toMatchObject({ min: 0, max: 99, integer: true });
        expect(spec.steps).toMatchObject({ key: 'num_inference_steps', min: 1, max: 50, default: 30 });
        expect(spec.guidance).toMatchObject({ min: 0, max: 20, default: 7.5, integer: false });
        expect(spec.references).toEqual({ max: 3 });
    });

    it('a size the list gives as free text is a free field; an aspect never is', () => {
        const model = mediaModel({
            id: 'm',
            medium: 'image',
            params: [
                { key: 'size', type: 'text' },
                { key: 'aspect_ratio', type: 'text' },
            ],
        });
        expect(imageForm(model).size).toEqual({ kind: 'free', key: 'size', default: '' });
        expect(imageForm(model).aspect).toBeNull();
    });

    it('references need a model that takes input images', () => {
        expect(
            imageForm(mediaModel({ id: 'm', medium: 'image', capabilities: { imageToImage: true } })).references,
        ).toEqual({
            max: 1,
        });
        expect(imageForm(mediaModel({ id: 'm', medium: 'image', maxInputImages: 2 })).references).toEqual({ max: 2 });
        expect(imageForm(mediaModel({ id: 'm', medium: 'image' })).references).toBeNull();
    });

    it('choiceValue keeps a value the model still offers and falls back to its default', () => {
        const field = imageForm(
            mediaModel({ id: 'm', medium: 'image', params: [enumSpec('size', ['512x512', '1024x1024'], '1024x1024')] }),
        ).size;
        expect(choiceValue(field, '512x512')).toBe('512x512');
        expect(choiceValue(field, '9x9')).toBe('1024x1024');
        expect(choiceValue(null, 'x')).toBe('');
        expect(choiceValue({ kind: 'free', key: 'size', default: '' }, '640x480')).toBe('640x480');
    });
});

describe('building an image request', () => {
    const model = mediaModel({
        id: 'flux',
        medium: 'image',
        maxInputImages: 2,
        params: [
            enumSpec('size', ['512x512', '1024x1024'], '1024x1024'),
            enumSpec('aspect_ratio', ['1:1', '16:9']),
            { key: 'negative_prompt', type: 'boolean' },
            { key: 'seed', type: 'integer', min: 0, max: 99 },
            rangeSpec('steps', 1, 50),
            rangeSpec('guidance', 0, 20),
        ],
    });
    const draft = (patch: Partial<ImageDraft> = {}): ImageDraft => ({
        ...emptyImageDraft(),
        prompt: 'a cat',
        ...patch,
    });

    it('the minimum: the model, the prompt and the defaults the model lists', () => {
        const built = buildImageRequest(model, draft());
        expect(built).toEqual({
            ok: true,
            request: { model: 'flux', prompt: 'a cat', size: '1024x1024', aspectRatio: '1:1' },
        });
    });

    it('sends what the form holds, trimmed, as the right fields', () => {
        const built = buildImageRequest(
            model,
            draft({
                prompt: '  a cat  ',
                negative: ' blurry ',
                size: '512x512',
                aspect: '16:9',
                count: '3',
                seed: '42',
                steps: '25',
                guidance: '7,5',
                references: [{ name: 'a.png', dataUrl: PNG, bytes: PNG.length }],
            }),
        );
        expect(built).toEqual({
            ok: true,
            request: {
                model: 'flux',
                prompt: 'a cat',
                negativePrompt: 'blurry',
                n: 3,
                size: '512x512',
                aspectRatio: '16:9',
                seed: 42,
                steps: 25,
                guidance: 7.5,
                inputImages: [PNG],
            },
        });
    });

    it('never sends a field the model does not list', () => {
        const bare = mediaModel({ id: 'bare', medium: 'image' });
        const built = buildImageRequest(
            bare,
            draft({
                negative: 'blurry',
                size: '512x512',
                aspect: '16:9',
                seed: '5',
                steps: '9',
                guidance: '3',
                references: [{ name: 'a.png', dataUrl: PNG, bytes: 1 }],
            }),
        );
        expect(built).toEqual({ ok: true, request: { model: 'bare', prompt: 'a cat' } });
    });

    it('a count of 1 is not sent', () => {
        expect(buildImageRequest(model, draft({ count: '1' }))).toMatchObject({ ok: true });
        const built = buildImageRequest(model, draft({ count: '' }));
        expect(built.ok && built.request.n).toBeUndefined();
    });

    it('says what is wrong, field by field', () => {
        const issues = (patch: Partial<ImageDraft>) => {
            const built = buildImageRequest(model, draft(patch));
            return built.ok ? [] : built.issues;
        };
        expect(issues({ prompt: '   ' })).toEqual([{ code: 'prompt_empty', field: 'prompt' }]);
        expect(issues({ count: '0' })).toEqual([{ code: 'count_range', field: 'count', detail: 4 }]);
        expect(issues({ count: '5' })).toEqual([{ code: 'count_range', field: 'count', detail: 4 }]);
        expect(issues({ count: '2.5' })).toEqual([{ code: 'count_range', field: 'count', detail: 4 }]);
        expect(issues({ count: 'two' })).toEqual([{ code: 'count_range', field: 'count', detail: 4 }]);
        expect(issues({ seed: 'abc' })).toEqual([{ code: 'number_invalid', field: 'seed' }]);
        expect(issues({ seed: '1.5' })).toEqual([{ code: 'number_invalid', field: 'seed' }]);
        expect(issues({ seed: '100' })).toEqual([{ code: 'number_range', field: 'seed', detail: 0 }]);
        expect(issues({ steps: '0' })).toEqual([{ code: 'number_range', field: 'steps', detail: 1 }]);
        expect(issues({ guidance: '21' })).toEqual([{ code: 'number_range', field: 'guidance', detail: 0 }]);
        expect(issues({ prompt: '', seed: 'x' }).map((issue) => issue.code)).toEqual([
            'prompt_empty',
            'number_invalid',
        ]);
    });

    it('checks free sizes as WxH', () => {
        const free = mediaModel({ id: 'free', medium: 'image', params: [{ key: 'size', type: 'text' }] });
        expect(buildImageRequest(free, draft({ size: '800x600' }))).toMatchObject({
            ok: true,
            request: { size: '800x600' },
        });
        expect(buildImageRequest(free, draft({ size: 'big' }))).toEqual({
            ok: false,
            issues: [{ code: 'size_invalid', field: 'size' }],
        });
        const empty = buildImageRequest(free, draft({ size: '' }));
        expect(empty.ok && empty.request.size).toBeUndefined();
    });

    it('checks the references: how many, whether they are images, how large', () => {
        const reference = (dataUrl: string) => ({ name: 'r', dataUrl, bytes: dataUrl.length });
        const issues = (references: ReturnType<typeof reference>[]) => {
            const built = buildImageRequest(model, draft({ references }));
            return built.ok ? [] : built.issues;
        };
        expect(issues([reference(PNG), reference(PNG), reference(PNG)])).toEqual([
            { code: 'too_many_references', field: 'references', detail: 2 },
        ]);
        expect(issues([reference(PNG), reference('data:text/plain;base64,AAAA')])).toEqual([
            { code: 'reference_not_image', field: 'references', detail: 2 },
        ]);
        const huge = `data:image/png;base64,${'A'.repeat(MAX_UPLOAD_BYTES)}`;
        expect(issues([reference(huge)])).toEqual([{ code: 'reference_too_large', field: 'references', detail: 1 }]);
    });
});

describe('video form and request', () => {
    const model = mediaModel({
        id: 'veo3',
        medium: 'video',
        capabilities: { imageToVideo: true },
        params: [
            enumSpec('duration', ['5s', '8s'], '8s'),
            enumSpec('aspect_ratio', ['16:9', '9:16']),
            enumSpec('resolution', ['720p', '1080p'], '720p'),
            { key: 'seed', type: 'integer' },
        ],
    });

    it('lists what the model lists', () => {
        const spec = videoForm(model);
        expect(spec.duration).toEqual({ kind: 'enum', values: ['5s', '8s'], default: '8s' });
        expect(spec.aspect).toMatchObject({ kind: 'enum', default: '16:9' });
        expect(spec.resolution).toMatchObject({ kind: 'enum', default: '720p' });
        expect(spec.seed).not.toBeNull();
        expect(spec.startImage).toBe(true);
        expect(videoForm(mediaModel({ id: 'x', medium: 'video' }))).toEqual({
            duration: null,
            aspect: null,
            resolution: null,
            seed: null,
            startImage: false,
        });
        expect(videoForm(mediaModel({ id: 'x', medium: 'video', maxInputImages: 1 })).startImage).toBe(true);
    });

    it('a numeric duration is a bounded field', () => {
        const ranged = mediaModel({ id: 'r', medium: 'video', params: [rangeSpec('duration', 4, 30, { default: 8 })] });
        const spec = videoForm(ranged);
        expect(spec.duration).toMatchObject({ kind: 'number', field: { min: 4, max: 30, default: 8 } });
        const ok = buildVideoRequest(ranged, { ...emptyVideoDraft(), prompt: 'p', duration: '12' });
        expect(ok).toMatchObject({ ok: true, request: { duration: 12 } });
        expect(buildVideoRequest(ranged, { ...emptyVideoDraft(), prompt: 'p', duration: '99' })).toEqual({
            ok: false,
            issues: [{ code: 'number_range', field: 'duration', detail: 4 }],
        });
        const none = buildVideoRequest(ranged, { ...emptyVideoDraft(), prompt: 'p' });
        expect(none.ok && none.request.duration).toBeUndefined();
    });

    it('builds the request: the duration is seconds as a number', () => {
        const built = buildVideoRequest(model, {
            ...emptyVideoDraft(),
            prompt: ' a dragon ',
            duration: '5s',
            aspect: '9:16',
            resolution: '1080p',
            seed: '7',
            startImage: { name: 's.png', dataUrl: PNG, bytes: 1 },
        });
        expect(built).toEqual({
            ok: true,
            request: {
                model: 'veo3',
                prompt: 'a dragon',
                duration: 5,
                aspectRatio: '9:16',
                resolution: '1080p',
                seed: 7,
                imageUrl: PNG,
            },
        });
    });

    it('falls back to the model’s defaults and drops what the model does not list', () => {
        const built = buildVideoRequest(model, { ...emptyVideoDraft(), prompt: 'p', duration: '99s' });
        expect(built).toMatchObject({ ok: true, request: { duration: 8, aspectRatio: '16:9', resolution: '720p' } });
        const bare = mediaModel({ id: 'b', medium: 'video' });
        expect(
            buildVideoRequest(bare, {
                ...emptyVideoDraft(),
                prompt: 'p',
                duration: '5',
                startImage: { name: 's.png', dataUrl: PNG, bytes: 1 },
            }),
        ).toEqual({ ok: true, request: { model: 'b', prompt: 'p' } });
    });

    it('wants a prompt, and a start image within the ceiling', () => {
        expect(buildVideoRequest(model, emptyVideoDraft())).toEqual({
            ok: false,
            issues: [{ code: 'prompt_empty', field: 'prompt' }],
        });
        const huge = `data:image/png;base64,${'A'.repeat(MAX_UPLOAD_BYTES)}`;
        expect(
            buildVideoRequest(model, {
                ...emptyVideoDraft(),
                prompt: 'p',
                startImage: { name: 's.png', dataUrl: huge, bytes: huge.length },
            }),
        ).toEqual({ ok: false, issues: [{ code: 'reference_too_large', field: 'startImage', detail: 1 }] });
    });
});

describe('speech form and request', () => {
    const model = mediaModel({
        id: 'tts',
        medium: 'tts',
        voices: ['af_bella', 'am_adam'],
        params: [rangeSpec('speed', 0.5, 2, { step: 0.1 }), { key: 'instructions', type: 'text' }],
    });

    it('reads voices, speed bounds and the instructions flag from the model', () => {
        expect(ttsForm(model)).toEqual({
            voices: ['af_bella', 'am_adam'],
            speed: { min: 0.5, max: 2, step: 0.1, listed: true },
            instructions: true,
        });
        expect(ttsForm(mediaModel({ id: 'x', medium: 'tts' }))).toEqual({
            voices: [],
            speed: { min: 0.25, max: 4, step: 0.05, listed: false },
            instructions: false,
        });
    });

    it('builds the request with the first voice as the default, and speed 1 as "no change"', () => {
        expect(buildTtsRequest(model, { ...emptyTtsDraft(), text: ' Hello ' })).toEqual({
            ok: true,
            request: { model: 'tts', input: 'Hello', voice: 'af_bella' },
        });
        expect(
            buildTtsRequest(model, {
                model: 'tts',
                voice: 'am_adam',
                text: 'Hi',
                speed: '1,5',
                instructions: ' calm ',
            }),
        ).toEqual({
            ok: true,
            request: { model: 'tts', input: 'Hi', voice: 'am_adam', speed: 1.5, instructions: 'calm' },
        });
    });

    it('sends no instructions for a model that does not list them, and a typed voice when the list has none', () => {
        const plain = mediaModel({ id: 'p', medium: 'tts' });
        expect(
            buildTtsRequest(plain, { model: 'p', voice: ' nova ', text: 'Hi', speed: '1', instructions: 'calm' }),
        ).toEqual({
            ok: true,
            request: { model: 'p', input: 'Hi', voice: 'nova' },
        });
        expect(buildTtsRequest(plain, { ...emptyTtsDraft(), text: 'Hi' })).toEqual({
            ok: true,
            request: { model: 'p', input: 'Hi' },
        });
    });

    it('wants text and a speed in range', () => {
        expect(buildTtsRequest(model, emptyTtsDraft())).toEqual({
            ok: false,
            issues: [{ code: 'text_empty', field: 'text' }],
        });
        expect(buildTtsRequest(model, { ...emptyTtsDraft(), text: 'x', speed: '3' })).toEqual({
            ok: false,
            issues: [{ code: 'number_range', field: 'speed', detail: 0.5 }],
        });
        expect(buildTtsRequest(model, { ...emptyTtsDraft(), text: 'x', speed: 'fast' })).toEqual({
            ok: false,
            issues: [{ code: 'number_invalid', field: 'speed', detail: 0.5 }],
        });
    });
});

describe('transcription form and request', () => {
    const audio = (patch: Partial<AudioInput> = {}): AudioInput => ({
        base64: 'QUJD',
        mime: 'audio/webm',
        filename: 'recording.webm',
        bytes: 1000,
        durationSec: 3,
        ...patch,
    });

    it('offers speaker labels only to models that give them', () => {
        expect(sttForm(mediaModel({ id: 'a', medium: 'stt' }))).toEqual({ diarize: false });
        expect(sttForm(mediaModel({ id: 'a', medium: 'stt', capabilities: { diarization: true } }))).toEqual({
            diarize: true,
        });
        expect(sttForm(mediaModel({ id: 'a', medium: 'stt', params: [{ key: 'diarize', type: 'boolean' }] }))).toEqual({
            diarize: true,
        });
    });

    it('builds the request from the audio as plain base64 with its own name and type', () => {
        const model = mediaModel({ id: 'asr', medium: 'stt' });
        expect(buildSttRequest(model, { model: 'asr', language: ' ru ', diarize: true }, audio())).toEqual({
            ok: true,
            request: {
                model: 'asr',
                audioBase64: 'QUJD',
                filename: 'recording.webm',
                mime: 'audio/webm',
                language: 'ru',
            },
        });
        const diarizing = mediaModel({ id: 'd', medium: 'stt', capabilities: { diarization: true } });
        expect(buildSttRequest(diarizing, { ...emptySttDraft(), diarize: true }, audio())).toMatchObject({
            ok: true,
            request: { diarize: true },
        });
    });

    it('needs audio, within 4 MB', () => {
        const model = mediaModel({ id: 'asr', medium: 'stt' });
        expect(buildSttRequest(model, emptySttDraft(), null)).toEqual({
            ok: false,
            issues: [{ code: 'audio_missing', field: 'audio' }],
        });
        expect(buildSttRequest(model, emptySttDraft(), audio({ bytes: 0 }))).toEqual({
            ok: false,
            issues: [{ code: 'audio_missing', field: 'audio' }],
        });
        expect(buildSttRequest(model, emptySttDraft(), audio({ bytes: MAX_UPLOAD_BYTES + 1 }))).toEqual({
            ok: false,
            issues: [{ code: 'audio_too_large', field: 'audio' }],
        });
    });
});
