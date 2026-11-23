/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer } from '../../tools/mock-nanogpt/server.mjs';

const KEY = 'sk-nano-test0123456789wxyz';
const OTHER_KEY = 'sk-nano-someone-else-0000';

let mock: ReturnType<typeof createMockServer>;
let base: string;

beforeAll(async () => {
    mock = createMockServer();
    base = `http://127.0.0.1:${await mock.listen(0)}`;
});
afterAll(() => mock.close());
beforeEach(async () => {
    await fetch(`${base}/__mock/reset`, { method: 'POST' });
});

const auth = (key = KEY) => ({ Authorization: `Bearer ${key}` });
const post = (route: string, body: unknown, headers: Record<string, string> = auth()) =>
    fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
const get = (route: string, headers: Record<string, string> = {}) => fetch(base + route, { headers });
const json = (res: Response): Promise<any> => res.json();
const state = async (): Promise<any> => json(await get('/__mock/state'));
const patch = (media: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
    post('/__mock/state', { media, ...rest }, {});

describe('model lists', () => {
    it('serves the trimmed real lists, public', async () => {
        const images = await json(await get('/api/v1/images/models'));
        expect(images.object).toBe('list');
        expect(images.data.map((m: any) => m.id)).toContain('rev-animated');
        expect(images.meta.count).toBe(images.data.length);
        expect((await json(await get('/api/v1/image-models'))).data).toHaveLength(images.data.length);
        const video = await json(await get('/api/v1/video-models?detailed=true'));
        expect(video.data.map((m: any) => m.id)).toContain('veo3-video');
        const tts = await json(await get('/api/v1/audio-models?type=tts&detailed=true'));
        const stt = await json(await get('/api/v1/audio-models?type=stt'));
        expect(tts.data.map((m: any) => m.id)).toContain('Kokoro-82m');
        expect(stt.data.map((m: any) => m.id)).toContain('qwen/qwen3-asr-0.6b');
        expect((await json(await get('/api/v1/audio-models'))).data).toHaveLength(tts.data.length + stt.data.length);
        expect(mock.media.find('image', 'rev-animated')).not.toBeNull();
        expect(mock.media.find('image', 'nope')).toBeNull();
    });
});

describe('image generation', () => {
    it('answers the live shape on every route: b64_json, list price, X-Request-ID = requestId', async () => {
        for (const route of ['/v1/images/generations', '/api/v1/images/generations', '/api/v1/images']) {
            const res = await post(route, { model: 'rev-animated', prompt: 'a lighthouse', size: '512x512' });
            expect(res.status).toBe(200);
            const body = await json(res);
            expect(body.data).toHaveLength(1);
            expect(Buffer.from(body.data[0].b64_json, 'base64').subarray(0, 4).toString('hex')).toBe('89504e47');
            expect(body).toMatchObject({ cost: 0.0017, paymentSource: 'USD' });
            expect(body.requestId).toMatch(/^media-image:/);
            expect(res.headers.get('x-request-id')).toBe(body.requestId);
        }
    });

    it('bills 1.5x for the chosen model and the list price for the others, as the billing lookup shows', async () => {
        const rev = await json(
            await post('/v1/images/generations', { model: 'rev-animated', prompt: 'x', size: '512x512' }),
        );
        const lookup = await json(await get(`/api/v1/usage/requests/${encodeURIComponent(rev.requestId)}`, auth()));
        expect(lookup).toMatchObject({
            object: 'request_billing',
            cost: '0.00255000',
            currency: 'USD',
            cost_scope: 'primary_charge',
        });
        const pixel = await json(
            await post('/v1/images/generations', { model: 'pixelwave', prompt: 'x', size: '512x512', n: 2 }),
        );
        expect(pixel.cost).toBe(0.0068);
        const second = await json(await get(`/api/v1/usage/requests/${encodeURIComponent(pixel.requestId)}`, auth()));
        expect(second.cost).toBe('0.00680000');
        // Another key does not see it.
        expect((await get(`/api/v1/usage/requests/${encodeURIComponent(rev.requestId)}`, auth(OTHER_KEY))).status).toBe(
            404,
        );
        expect((await state()).balanceUsd as number).toBeCloseTo(25 - 0.00255 - 0.0068, 8);
    });

    it('can make a lookup say "not ready yet" a few times', async () => {
        const body = await json(await post('/v1/images/generations', { prompt: 'x' }));
        await post('/__mock/state', { billingMisses: 2 }, {});
        const lookup = () => get(`/api/v1/usage/requests/${encodeURIComponent(body.requestId)}`, auth());
        expect((await lookup()).status).toBe(404);
        expect((await lookup()).headers.get('retry-after')).toBe('30');
        expect((await lookup()).status).toBe(200);
        expect((await state()).billingMisses).toBe(0);
    });

    it('defaults the model, accepts n up to the model limit and serves url outputs', async () => {
        expect((await post('/api/v1/images', { prompt: 'a lighthouse' })).status).toBe(200);
        const many = await json(await post('/v1/images/generations', { model: 'rev-animated', prompt: 'x', n: 3 }));
        expect(many.data).toHaveLength(3);
        const linked = await json(await post('/v1/images/generations', { prompt: 'x', response_format: 'url' }));
        expect(linked.data[0].b64_json).toBeUndefined();
        const file = await get(new URL(linked.data[0].url).pathname + new URL(linked.data[0].url).search);
        expect(file.headers.get('content-type')).toBe('image/png');
        expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(50);
    });

    it('refuses what the real service refuses', async () => {
        expect((await post('/v1/images/generations', { prompt: 'x' }, {})).status).toBe(401);
        const unknown = await post('/v1/images/generations', { model: 'nope', prompt: 'x' });
        expect(unknown.status).toBe(404);
        expect((await json(unknown)).error.code).toBe('model_not_found');
        expect((await json(await post('/v1/images/generations', { model: 'rev-animated' }))).error.code).toBe(
            'invalid_prompt',
        );
        expect((await json(await post('/v1/images/generations', { prompt: 'x', n: 99 }))).error.code).toBe('invalid_n');
        const blocked = await post('/v1/images/generations', { prompt: 'something forbidden' });
        expect(blocked.status).toBe(400);
        expect((await json(blocked)).error.code).toBe('content_policy_violation');
        const broken = await fetch(`${base}/v1/images/generations`, {
            method: 'POST',
            headers: { ...auth(), 'content-type': 'application/json' },
            body: '{nope',
        });
        expect(broken.status).toBe(400);
        await post('/__mock/state', { balanceUsd: 0.0001 }, {});
        const poor = await post('/v1/images/generations', { prompt: 'x' });
        expect(poor.status).toBe(402);
        expect(await json(poor)).toEqual({ error: 'Insufficient balance', requiredBalance: 0.00255, status: 402 });
    });
});

describe('speech', () => {
    it('answers WAV bytes whatever format was asked, with no request id (LIVE)', async () => {
        const res = await post('/v1/audio/speech', {
            model: 'Kokoro-82m',
            input: 'Hello there, friend.',
            voice: 'af_bella',
            response_format: 'mp3',
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/x-wav');
        expect(res.headers.get('x-request-id')).toBeNull();
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
        expect(bytes.subarray(8, 12).toString('latin1')).toBe('WAVE');
        expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
        expect((await state()).balanceUsd as number).toBeCloseTo(25 - 0.000034, 9);
        expect((await post('/api/v1/audio/speech', { model: 'tts-1', input: 'x' })).status).toBe(200);
    });

    it('refuses an unknown model, a missing input and a voice the model lacks', async () => {
        expect((await json(await post('/v1/audio/speech', { model: 'nope', input: 'x' }))).error.code).toBe(
            'invalid_model',
        );
        expect((await json(await post('/v1/audio/speech', { model: 'Kokoro-82m', input: ' ' }))).error.code).toBe(
            'invalid_request',
        );
        expect(
            (await json(await post('/v1/audio/speech', { model: 'Kokoro-82m', input: 'x', voice: 'zzz' }))).error.code,
        ).toBe('invalid_voice');
        expect((await post('/v1/audio/speech', { model: 'Kokoro-82m', input: 'x' }, {})).status).toBe(401);
        expect((await post('/v1/audio/speech', [])).status).toBe(400);
        await post('/__mock/state', { balanceUsd: 0 }, {});
        expect((await post('/v1/audio/speech', { model: 'tts-1', input: 'x' })).status).toBe(402);
    });

    it('charges per generation for models that price that way', async () => {
        const res = await post('/v1/audio/speech', { model: 'microsoft/vibevoice', input: 'x' });
        expect(res.status).toBe(200);
        expect((await state()).balanceUsd as number).toBeCloseTo(25 - 0.15, 8);
    });
});

function recording(seconds: number): Buffer {
    // A WAV like the mock's speech makes: 8 kHz, 8-bit, mono.
    const data = Buffer.alloc(44 + seconds * 8000, 128);
    data.write('RIFF', 0, 'latin1');
    data.writeUInt32LE(36 + seconds * 8000, 4);
    data.write('WAVEfmt ', 8, 'latin1');
    data.writeUInt32LE(8000, 28);
    return data;
}

function upload(fields: Record<string, string>, file: Buffer | null, headers: Record<string, string> = auth()) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    if (file) form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), 'speech.wav');
    return fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body: form });
}

describe('transcription', () => {
    it('answers text, language, duration and usage with the cost (LIVE shape), and no request id', async () => {
        const res = await upload({ model: 'qwen/qwen3-asr-0.6b' }, recording(2));
        expect(res.status).toBe(200);
        expect(res.headers.get('x-request-id')).toBeNull();
        expect(await json(res)).toEqual({
            text: 'Hello, there, friend.',
            language: 'auto-detect',
            duration: 2,
            usage: { seconds: 2, type: 'duration', cost: 0.00000666, currency: 'USD' },
        });
        expect((await state()).balanceUsd as number).toBeCloseTo(25 - 0.00000666, 9);
    });

    it('takes the duration from a header, adds segments for verbose_json and plain text for text', async () => {
        const verbose = await json(
            await upload({ model: 'Whisper-Large-V3', response_format: 'verbose_json' }, recording(1), {
                ...auth(),
                'x-mock-duration': '90',
            }),
        );
        expect(verbose.duration).toBe(90);
        expect(verbose.segments).toEqual([{ id: 0, start: 0, end: 90, text: 'Hello, there, friend.' }]);
        const text = await upload({ model: 'Whisper-Large-V3', response_format: 'text' }, recording(1));
        expect(text.headers.get('content-type')).toContain('text/plain');
        expect(await text.text()).toBe('Hello, there, friend.');
        const opaque = await json(await upload({ model: 'qwen/qwen3-asr-0.6b' }, Buffer.alloc(40_000, 1)));
        expect(opaque.duration).toBe(3);
    });

    it('refuses what the real service refuses', async () => {
        expect((await upload({ model: 'qwen/qwen3-asr-0.6b' }, recording(1), {})).status).toBe(401);
        expect((await json(await upload({ model: 'qwen/qwen3-asr-0.6b' }, null))).error.code).toBe('invalid_request');
        expect((await json(await upload({ model: 'nope' }, recording(1)))).error.code).toBe('invalid_model');
        await post('/__mock/state', { balanceUsd: 0 }, {});
        expect((await upload({ model: 'elevenlabs/scribe-v3' }, recording(60))).status).toBe(402);
    });

    it('logs a multipart request as fields and file sizes only, with the key masked', async () => {
        await upload({ model: 'qwen/qwen3-asr-0.6b' }, recording(1));
        const entry = (mock.state.log as any[]).at(-1);
        expect(entry.body).toEqual({
            multipart: {
                fields: { model: 'qwen/qwen3-asr-0.6b' },
                files: [{ name: 'file', filename: 'speech.wav', mime: 'audio/wav', bytes: 8044 }],
            },
        });
        expect(JSON.stringify(entry)).not.toContain(KEY);
        expect(entry.headers.authorization).toContain('sk-nano-…');
    });
});

describe('video', () => {
    const submit = (body: Record<string, unknown> = {}, headers: Record<string, string> = auth()) =>
        post(
            '/api/generate-video',
            { model: 'kling-v25-turbo-std', prompt: 'a cat on a roof', duration: '5', ...body },
            headers,
        );
    const status = (id: string, headers: Record<string, string> = auth()) =>
        get(`/api/video/status?requestId=${id}`, headers);

    it('accepts a job with 202 and the documented fields, charging the estimate', async () => {
        const res = await submit();
        expect(res.status).toBe(202);
        const body = await json(res);
        expect(body).toMatchObject({
            status: 'pending',
            model: 'kling-v25-turbo-std',
            cost: 0.21,
            paymentSource: 'USD',
        });
        expect(body.runId).toMatch(/^vid_/);
        expect(body.id).toBe(body.runId);
        expect((await state()).balanceUsd as number).toBeCloseTo(25 - 0.21, 8);
    });

    it('goes queued, running, completed in the documented guide shape, with the final cost on completion', async () => {
        const { runId } = await json(await submit());
        const seen: string[] = [];
        let last: any;
        for (let i = 0; i < 3; i += 1) {
            last = await json(await status(runId));
            seen.push(last.data.status);
        }
        expect(seen).toEqual(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']);
        expect(last).toMatchObject({ requestId: runId, model: 'kling-v25-turbo-std' });
        expect(last.data.cost).toBe(0.231);
        expect(last.data.output.video.url).toContain(`/api/generate-video/content?runId=${runId}`);
        // The link works without a key and serves an mp4.
        const file = await get(
            new URL(last.data.output.video.url).pathname + new URL(last.data.output.video.url).search,
        );
        expect(file.headers.get('content-type')).toBe('video/mp4');
        const bytes = Buffer.from(await file.arrayBuffer());
        expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
        expect(bytes.length).toBe(4128);
    });

    it('answers the flat OpenAPI shape when switched, per request or for the whole mock', async () => {
        const { runId } = await json(await submit());
        const first = await json(await status(runId, { ...auth(), 'x-mock-video-shape': 'flat' }));
        expect(first).toMatchObject({ requestId: runId, status: 'queued', progress: null, videoUrl: null });
        await patch({ videoShape: 'flat' });
        const second = await json(await status(runId));
        expect(second).toMatchObject({ status: 'processing', progress: 67, videoUrl: null });
        const third = await json(await status(runId));
        expect(third).toMatchObject({ status: 'completed', progress: 100, error: null });
        expect(third.videoUrl).toContain('/api/generate-video/content');
        expect(third.cost).toBeUndefined();
        expect((await state()).media.videoShape).toBe('flat');
        // A bad value is ignored.
        await patch({ videoShape: 'weird' });
        expect((await state()).media.videoShape).toBe('flat');
    });

    it('can need more polls, hand out a relative link and lose the file', async () => {
        await patch({ videoPollsToComplete: 5, videoRelativeUrl: true });
        const { runId } = await json(await submit());
        let last: any;
        for (let i = 0; i < 5; i += 1) last = await json(await status(runId));
        expect(last.data.status).toBe('COMPLETED');
        expect(last.data.output.video.url).toMatch(/^\/api\/generate-video\/content\?/);
        await patch({ videoContentGone: true });
        expect((await get(last.data.output.video.url)).status).toBe(404);
        expect((await get('/api/generate-video/content?runId=vid_unknown')).status).toBe(404);
    });

    it('fails a job on request, refunding the charge, in both shapes', async () => {
        const { runId } = await json(await submit({ prompt: 'please failjob' }));
        await status(runId);
        await status(runId);
        const failed = await json(await status(runId));
        expect(failed.data).toMatchObject({
            status: 'FAILED',
            error: 'Generation failed upstream',
            userFriendlyError: 'The video could not be made',
        });
        expect((await state()).balanceUsd as number).toBeCloseTo(25, 8);
        const second = await json(await submit({}, { ...auth(), 'x-mock-video-fail': '1' }));
        await patch({ videoShape: 'flat' });
        await status(second.runId);
        await status(second.runId);
        expect(await json(await status(second.runId))).toMatchObject({
            status: 'failed',
            error: 'Generation failed upstream',
        });
    });

    it('refuses with the plain text 401, the legacy 402 and the policy error of the docs', async () => {
        const noKey = await submit({}, {});
        expect(noKey.status).toBe(401);
        expect(noKey.headers.get('content-type')).toContain('text/plain');
        expect(await noKey.text()).toBe('Invalid session');
        const noKeyStatus = await get('/api/video/status?requestId=x');
        expect(noKeyStatus.status).toBe(401);
        expect(await noKeyStatus.text()).toBe('Invalid session');
        expect((await json(await submit({ model: 'nope' }))).error.code).toBe('invalid_model');
        expect((await json(await post('/api/generate-video', { model: 'kling-v25-turbo-std' }))).error.code).toBe(
            'missing_prompt',
        );
        const blocked = await json(await submit({ prompt: 'forbidden things' }));
        expect(blocked).toMatchObject({
            error: { type: 'CONTENT_POLICY_VIOLATION' },
            refundMessage: 'You were not charged.',
        });
        expect(await json(await status('vid_unknown'))).toEqual({ error: 'Video generation request not found' });
        const { runId } = await json(await submit());
        expect((await status(runId, auth(OTHER_KEY))).status).toBe(404);
        await post('/__mock/state', { balanceUsd: 0.01 }, {});
        const poor = await submit();
        expect(poor.status).toBe(402);
        expect((await json(poor)).error).toBe('Insufficient balance');
    });

    it('prices per second, per duration and per video from the list', async () => {
        const cost = async (model: string, extra: Record<string, unknown> = {}) =>
            (await json(await submit({ model, ...extra }))).cost;
        expect(await cost('vidu-q4', { duration: '5', resolution: '720p' })).toBe(0.5225);
        expect(await cost('kling-v25-turbo-std', { duration: '10' })).toBe(0.42);
        expect(await cost('wan-video-22-5b')).toBe(0.15);
        expect(await cost('longstories/story-fast')).toBe(0.66);
        expect(await cost('lightricks/ltx-2.5/reframe')).toBe(0.5);
    });
});

describe('the error switches reach the media routes', () => {
    it('answers the three error shapes and the OpenAI envelope on request', async () => {
        const text = await post('/v1/images/generations', { prompt: 'x' }, { ...auth(), 'x-mock-error': '401-text' });
        expect(text.status).toBe(401);
        expect(await text.text()).toBe('Invalid session');
        const legacy = await post(
            '/v1/audio/speech',
            { model: 'tts-1', input: 'x' },
            { ...auth(), 'x-mock-error': '402-legacy' },
        );
        expect(await json(legacy)).toEqual({ error: 'Insufficient balance', requiredBalance: 0.0035, status: 402 });
        const policy = await post(
            '/api/generate-video',
            { model: 'veo3-video', prompt: 'x' },
            { ...auth(), 'x-mock-error': '400-policy' },
        );
        expect((await json(policy)).error.code).toBe('content_policy_violation');
        const envelope = await post('/v1/images/generations', { prompt: 'x' }, { ...auth(), 'x-mock-error': '429' });
        expect(envelope.status).toBe(429);
        expect(envelope.headers.get('retry-after')).toBe('1');
        expect(
            (await post('/v1/audio/speech', { model: 'tts-1', input: 'x' }, { ...auth(), 'x-mock-error': '503' }))
                .status,
        ).toBe(503);
    });

    it('delays the answer on request', async () => {
        const started = Date.now();
        await post('/v1/images/generations', { prompt: 'x' }, { ...auth(), 'x-mock-delay-ms': '120' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    it('keeps the key out of the request log of every media route', async () => {
        await post('/v1/images/generations', { prompt: 'x' });
        await post('/v1/audio/speech', { model: 'tts-1', input: 'x' });
        await post('/api/generate-video', { model: 'veo3-video', prompt: 'x' });
        expect(JSON.stringify(mock.state.log)).not.toContain(KEY);
    });
});
