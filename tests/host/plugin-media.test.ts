// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginError } from '../../src/host/plugin-client';
import {
    MEDIA_CALL_TIMEOUT_MS,
    VIDEO_SUBMIT_TIMEOUT_MS,
    createPluginMedia,
    isMediaPluginDown,
    mediaErrorOf,
    mediaFileUrl,
    parseCost,
    parseImageResult,
    parseMediaModel,
    parseOutput,
    parsePrice,
    parseSttResult,
    parseTtsResult,
    parseVideoJob,
    requiredAmountOf,
} from '../../src/host/plugin-media';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { PNG_BASE64, WAV_BASE64, costOf, createMediaFake, mediaModel } from '../helpers/media-fake';
import type { MediaFake } from '../helpers/media-fake';

let h: Harness;
let fake: MediaFake;

beforeEach(() => {
    h = createHarness();
    fake = createMediaFake(h);
    fake.catalogs.image = [mediaModel({ id: 'rev-animated', medium: 'image' })];
    fake.catalogs.tts = [mediaModel({ id: 'Kokoro-82m', medium: 'tts', voices: ['af_bella'] })];
    fake.catalogs.stt = [mediaModel({ id: 'qwen/qwen3-asr-0.6b', medium: 'stt' })];
    fake.catalogs.video = [mediaModel({ id: 'veo3-video', medium: 'video' })];
});

afterEach(() => h.restore());

const pluginError = (code: string, status: number | null = null, message = code): PluginError => ({
    code,
    status,
    message,
});

describe('catalog', () => {
    it('asks for one medium and reads the models', async () => {
        const result = await fake.media.catalog('image');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.medium).toBe('image');
        expect(result.data.models.map((model) => model.id)).toEqual(['rev-animated']);
        expect(result.data.source).toBe('live');
        expect(fake.calls.map((call) => call.path)).toEqual(['/media/catalog?medium=image']);
    });

    it('adds refresh=1 when asked to', async () => {
        await fake.media.catalog('tts', { refresh: true });
        expect(fake.calls.at(-1)?.path).toBe('/media/catalog?medium=tts&refresh=1');
    });

    it('drops models that are not readable, repeated, or of another medium', async () => {
        const good = mediaModel({ id: 'a', medium: 'image' });
        fake.fetch = async () =>
            new Response(
                JSON.stringify({
                    medium: 'image',
                    models: [good, good, { name: 'no id' }, 7, { ...good, id: 'b', medium: 'tts' }, { id: 'c' }],
                    source: 'weird',
                }),
            );
        const client = (await import('../../src/host/plugin-client')).createPluginClient({
            ctx: () => h.mock.context,
            log: h.log,
            fetchImpl: fake.fetch,
        });
        const result = await createPluginMedia({ client }).catalog('image');
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        // `c` has no medium of its own: it takes the one asked for.
        expect(result.data.models.map((model) => model.id)).toEqual(['a', 'c']);
        expect(result.data.source).toBe('live');
    });

    it('is invalid_response when there is no list at all', async () => {
        fake.catalogs.image = undefined as never;
        fake.fetch = async () => new Response(JSON.stringify({ models: 'no' }));
        const client = (await import('../../src/host/plugin-client')).createPluginClient({
            ctx: () => h.mock.context,
            log: h.log,
            fetchImpl: fake.fetch,
        });
        const result = await createPluginMedia({ client }).catalog('image');
        expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
    });

    it('rejects an unknown medium on the fake the way the plugin would (400)', async () => {
        const raw = await fake.client.request('GET', '/media/catalog?medium=nope');
        expect(raw).toMatchObject({ ok: false, error: { code: 'invalid_request', status: 400 } });
    });
});

describe('generation calls', () => {
    it('image: sends the request as it is and reads outputs, request id and cost', async () => {
        fake.cost = costOf({ usd: 0.0017, source: 'response', estimateUsd: 0.0017 });
        const result = await fake.media.image({ model: 'rev-animated', prompt: 'a cat', n: 2, size: '512x512' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.outputs).toHaveLength(2);
        expect(result.data.outputs[0]).toMatchObject({ kind: 'image', mime: 'image/png', dataBase64: PNG_BASE64 });
        expect(result.data.requestId).toMatch(/^media-image:/);
        expect(result.data.cost).toEqual({
            usd: 0.0017,
            source: 'response',
            estimateUsd: 0.0017,
            paymentSource: 'USD',
            remainingUsd: null,
        });
        expect(fake.calls.at(-1)?.body).toEqual({ model: 'rev-animated', prompt: 'a cat', n: 2, size: '512x512' });
    });

    it('tts: keeps the real content type of the audio', async () => {
        const result = await fake.media.tts({ model: 'Kokoro-82m', input: 'Hello there, friend.', voice: 'af_bella' });
        expect(result).toMatchObject({
            ok: true,
            data: {
                chars: 20,
                audio: { kind: 'audio', mime: 'audio/x-wav', dataBase64: WAV_BASE64 },
                cost: { source: 'estimate' },
            },
        });
    });

    it('stt: reads the text, language and duration', async () => {
        const result = await fake.media.stt({
            model: 'qwen/qwen3-asr-0.6b',
            audioBase64: WAV_BASE64,
            filename: 'a.wav',
            mime: 'audio/wav',
        });
        expect(result).toMatchObject({
            ok: true,
            data: { text: 'Hello, there, friend.', language: 'auto-detect', durationSec: 2, segments: [] },
        });
    });

    it('sends a megabytes-sized body in one call', async () => {
        const big = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
        const result = await fake.media.image({ model: 'rev-animated', prompt: 'x', inputImages: [big] });
        expect(result.ok).toBe(true);
        expect((fake.calls.at(-1)?.body as { inputImages: string[] }).inputImages[0]).toHaveLength(big.length);
    });

    it('gives each call the time limit the contract wants (image, speech, transcription 120 s, a video submit 30 s)', async () => {
        const request = vi.fn(async () => ({ ok: false as const, error: pluginError('x', 500) }));
        const media = createPluginMedia({ client: { request } });
        await media.image({ model: 'm', prompt: 'p' });
        await media.tts({ model: 'm', input: 'i' });
        await media.stt({ model: 'm', audioBase64: 'AA', filename: 'a.wav', mime: 'audio/wav' });
        await media.startVideo({ model: 'm', prompt: 'p' });
        const timeouts = request.mock.calls.map(
            (call) => (call as unknown as [string, string, { timeoutMs: number }])[2].timeoutMs,
        );
        expect(timeouts).toEqual([
            MEDIA_CALL_TIMEOUT_MS,
            MEDIA_CALL_TIMEOUT_MS,
            MEDIA_CALL_TIMEOUT_MS,
            VIDEO_SUBMIT_TIMEOUT_MS,
        ]);
        expect(MEDIA_CALL_TIMEOUT_MS).toBe(120_000);
        expect(VIDEO_SUBMIT_TIMEOUT_MS).toBe(30_000);
    });

    it('an answer without outputs or audio is invalid_response, not an empty result', async () => {
        fake.imageResult = () => ({ model: 'm', outputs: [], requestId: null, cost: costOf(), latencyMs: 1 });
        expect(await fake.media.image({ model: 'rev-animated', prompt: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'invalid_response' },
        });
        fake.ttsResult = () =>
            ({
                model: 'm',
                audio: { kind: 'audio', mime: 'audio/wav' },
                cost: costOf(),
                chars: 1,
                latencyMs: 1,
            }) as never;
        expect(await fake.media.tts({ model: 'Kokoro-82m', input: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'invalid_response' },
        });
    });
});

describe('errors', () => {
    it.each([
        ['unreachable', null, 'plugin_down'],
        ['timeout', null, 'timeout'],
        ['upstream_timeout', 504, 'timeout'],
        ['not_installed', 404, 'not_installed'],
        ['forbidden', 403, 'forbidden'],
        ['invalid_response', null, 'invalid_response'],
        ['no_key', 409, 'no_key'],
        ['invalid_request', 400, 'invalid_request'],
        ['payload_too_large', 413, 'too_large'],
        ['rate_limited', 429, 'rate_limited'],
        ['media_unavailable', 502, 'unavailable'],
        ['upstream_error', 502, 'upstream'],
        ['bad_response', 502, 'upstream'],
        ['insufficient_balance', 402, 'insufficient_balance'],
        ['content_policy_violation', 400, 'content_policy'],
        ['not_found', 404, 'not_found'],
        ['something_new', 402, 'insufficient_balance'],
        ['something_new', 413, 'too_large'],
        ['something_new', 429, 'rate_limited'],
        ['something_new', 504, 'timeout'],
        ['something_new', 502, 'upstream'],
        ['something_new', 500, 'other'],
    ])('maps %s (%s) to %s', (code, status, kind) => {
        expect(mediaErrorOf(pluginError(code, status)).kind).toBe(kind);
    });

    it('keeps the plugin’s code and message and reads the amount an insufficient balance names', () => {
        const error = mediaErrorOf(
            pluginError('insufficient_balance', 402, 'NanoGPT needs a balance of 0.0035 for this call'),
        );
        expect(error).toMatchObject({
            kind: 'insufficient_balance',
            code: 'insufficient_balance',
            requiredUsd: 0.0035,
        });
        expect(mediaErrorOf(pluginError('insufficient_balance', 402, 'too poor')).requiredUsd).toBeUndefined();
    });

    it('reads amounts only where a message names one', () => {
        expect(requiredAmountOf('required: 0.0035')).toBe(0.0035);
        expect(requiredAmountOf('Insufficient balance, requiredBalance 1.5')).toBe(1.5);
        expect(requiredAmountOf('you need $0.12 more')).toBe(0.12);
        expect(requiredAmountOf('costs $2')).toBe(2);
        expect(requiredAmountOf('HTTP 402 insufficient balance')).toBeNull();
        expect(requiredAmountOf('required: 0')).toBeNull();
    });

    it('tells a dead plugin from a refusal', () => {
        expect(isMediaPluginDown(mediaErrorOf(pluginError('unreachable')))).toBe(true);
        expect(isMediaPluginDown(mediaErrorOf(pluginError('not_installed', 404)))).toBe(true);
        expect(isMediaPluginDown(mediaErrorOf(pluginError('forbidden', 403)))).toBe(true);
        expect(isMediaPluginDown(mediaErrorOf(pluginError('no_key', 409)))).toBe(false);
        expect(isMediaPluginDown(mediaErrorOf(pluginError('upstream_error', 502)))).toBe(false);
    });

    it('a plugin that is down is an error value, never a throw', async () => {
        h.backend.plugin.up = false;
        expect(await fake.media.catalog('image')).toMatchObject({ ok: false, error: { kind: 'plugin_down' } });
        expect(await fake.media.image({ model: 'rev-animated', prompt: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'plugin_down' },
        });
    });

    it('an older plugin (ST’s own 404 on the media routes) is not_installed', async () => {
        fake.hasRoutes = false;
        expect(await fake.media.catalog('image')).toMatchObject({
            ok: false,
            error: { kind: 'not_installed', status: 404 },
        });
    });

    it('the plugin’s refusals come through with their kinds', async () => {
        fake.hasKey = false;
        expect(await fake.media.image({ model: 'rev-animated', prompt: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'no_key', status: 409 },
        });
        fake.hasKey = true;
        fake.fail.set('POST /media/image', { status: 402, code: 'insufficient_balance', message: 'required: 0.25' });
        expect(await fake.media.image({ model: 'rev-animated', prompt: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'insufficient_balance', requiredUsd: 0.25 },
        });
        fake.fail.set('POST /media/image', { status: 400, code: 'content_policy_violation', message: 'blocked' });
        expect(await fake.media.image({ model: 'rev-animated', prompt: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'content_policy' },
        });
        fake.fail.clear();
        expect(await fake.media.image({ model: 'unknown', prompt: 'p' })).toMatchObject({
            ok: false,
            error: { kind: 'invalid_request' },
        });
    });

    it('an input over 4 MB is too_large', async () => {
        const huge = `data:image/png;base64,${'A'.repeat(4 * 1024 * 1024 + 10)}`;
        expect(await fake.media.image({ model: 'rev-animated', prompt: 'p', inputImages: [huge] })).toMatchObject({
            ok: false,
            error: { kind: 'too_large' },
        });
    });
});

describe('video jobs', () => {
    it('submits, lists, polls and deletes', async () => {
        const started = await fake.media.startVideo({ model: 'veo3-video', prompt: 'a dragon', duration: 8 });
        expect(started).toMatchObject({
            ok: true,
            data: { id: 'vid_1', status: 'queued', cost: { source: 'estimate' } },
        });
        expect(fake.calls.at(-1)?.body).toEqual({ model: 'veo3-video', prompt: 'a dragon', duration: 8 });

        const listed = await fake.media.listVideo();
        expect(listed).toMatchObject({ ok: true });
        if (listed.ok) expect(listed.data.map((job) => job.id)).toEqual(['vid_1']);

        const running = await fake.media.videoStatus('vid_1');
        expect(running).toMatchObject({ ok: true, data: { status: 'running', progress: 0.5 } });
        const done = await fake.media.videoStatus('vid_1');
        expect(done).toMatchObject({
            ok: true,
            data: { status: 'completed', output: { kind: 'video', mime: 'video/mp4', file: '/media/files/vid_1' } },
        });

        expect(await fake.media.deleteVideo('vid_1')).toEqual({ ok: true, data: true });
        expect(await fake.media.videoStatus('vid_1')).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    });

    it('encodes ids in the path', async () => {
        await fake.media.videoStatus('a/b c');
        expect(fake.calls.at(-1)?.path).toBe('/media/video/a%2Fb%20c');
    });

    it('builds the URL of the saved file from the plugin base, and leaves a path or a link alone', () => {
        expect(mediaFileUrl('vid_1')).toBe('/api/plugins/nanovia/media/files/vid_1');
        expect(mediaFileUrl('a b')).toBe('/api/plugins/nanovia/media/files/a%20b');
        expect(mediaFileUrl('/api/plugins/nanovia/media/files/x')).toBe('/api/plugins/nanovia/media/files/x');
        // The route path exactly as the plugin sends it in `output.file`.
        expect(mediaFileUrl('/media/files/vid_1')).toBe('/api/plugins/nanovia/media/files/vid_1');
        expect(mediaFileUrl('https://cdn.example.test/v.mp4')).toBe('https://cdn.example.test/v.mp4');
    });
});

describe('tolerant readers', () => {
    it('reads a price of any shape without throwing', () => {
        expect(parsePrice({ unit: 'image', from: 0.1, to: 0.3, byKey: { '1k': 0.1, bad: 'x' }, raw: 5 })).toEqual({
            unit: 'image',
            from: 0.1,
            to: 0.3,
            byKey: { '1k': 0.1 },
            raw: null,
        });
        expect(parsePrice({ unit: 'weird', raw: { odd: 1 } })).toEqual({
            unit: 'unknown',
            from: null,
            to: null,
            byKey: {},
            raw: { odd: 1 },
        });
        expect(parsePrice(null)).toMatchObject({ unit: 'unknown', from: null });
    });

    it('fills a model with neutral values and refuses one without an id', () => {
        const model = parseMediaModel({
            id: ' m ',
            medium: 'tts',
            voices: ['a', 3],
            capabilities: { music: true, x: 1 },
        });
        expect(model).toMatchObject({
            id: 'm',
            medium: 'tts',
            name: 'm',
            voices: ['a'],
            capabilities: { music: true },
            maxInputImages: 0,
            subscriptionIncluded: null,
            priceIsApproximate: false,
            params: [],
        });
        expect(parseMediaModel({ medium: 'tts' })).toBeNull();
        expect(parseMediaModel('x')).toBeNull();
        expect(parseMediaModel({ id: 'a' })).toBeNull();
        expect(parseMediaModel({ id: 'a' }, 'image')?.medium).toBe('image');
    });

    it('reads params of every type and ignores the ones without a key', () => {
        const model = parseMediaModel({
            id: 'm',
            medium: 'image',
            params: [
                { key: 'size', type: 'enum', values: ['1024x1024', 512], default: '1024x1024' },
                { key: 'steps', type: 'range', min: 1, max: 50, step: 1, default: 20, required: true },
                { type: 'enum' },
                { key: 'x', type: 'strange' },
                { key: 'nsfw', type: 'boolean', default: null },
            ],
        });
        expect(model?.params).toEqual([
            { key: 'size', type: 'enum', values: ['1024x1024', '512'], default: '1024x1024' },
            { key: 'steps', type: 'range', min: 1, max: 50, step: 1, default: 20, required: true },
            { key: 'x', type: 'unknown' },
            { key: 'nsfw', type: 'boolean', default: null },
        ]);
    });

    it('reads costs, outputs, results and jobs', () => {
        expect(parseCost(undefined)).toEqual({
            usd: null,
            source: 'unknown',
            estimateUsd: null,
            paymentSource: null,
            remainingUsd: null,
        });
        expect(parseCost({ usd: 1, source: 'lookup', estimateUsd: 2, paymentSource: 'XNO', remainingUsd: 3 })).toEqual({
            usd: 1,
            source: 'lookup',
            estimateUsd: 2,
            paymentSource: 'XNO',
            remainingUsd: 3,
        });
        expect(parseOutput({ kind: 'image', mime: 'image/png' })).toBeNull();
        expect(parseOutput({ kind: 'image', url: 'https://x.test/a.png' })).toEqual({
            kind: 'image',
            mime: 'application/octet-stream',
            url: 'https://x.test/a.png',
        });
        expect(parseOutput({ kind: 'sound', dataBase64: 'AA' })).toBeNull();
        expect(parseImageResult({ outputs: 'no' })).toBeNull();
        expect(parseTtsResult({ audio: { kind: 'image', dataBase64: 'AA' } })).toBeNull();
        expect(parseSttResult({ text: 5 })).toBeNull();
        expect(
            parseSttResult({
                model: 'm',
                text: '',
                segments: [{ start: 0, end: 1.5, text: 'hi', speaker: 'S1' }, { text: 7 }, { text: 'x', speaker: '' }],
            }),
        ).toMatchObject({
            text: '',
            language: '',
            durationSec: null,
            segments: [
                { start: 0, end: 1.5, text: 'hi', speaker: 'S1' },
                { start: null, end: null, text: 'x', speaker: null },
            ],
        });
        const job = parseVideoJob({ id: 'vid_9', status: 'processing', progress: 7, createdAt: 5, output: null });
        // An unknown status word keeps the job polled; progress is clamped into 0..1.
        expect(job).toMatchObject({
            id: 'vid_9',
            status: 'running',
            progress: 1,
            createdAt: 5,
            updatedAt: 5,
            output: null,
        });
        expect(parseVideoJob({ status: 'queued' })).toBeNull();
    });
});
