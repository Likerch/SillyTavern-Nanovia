/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NANO_KEY, cleanTempDirs } from './helpers';
import { forcing, startMediaStack, usageLines, userFolderText, wav, type MediaStack } from './media-helpers';

const stacks: MediaStack[] = [];
async function stack(options: Parameters<typeof startMediaStack>[0] = {}): Promise<MediaStack> {
    const s = await startMediaStack(options);
    stacks.push(s);
    return s;
}
afterEach(async () => {
    for (const s of stacks.splice(0)) await s.close();
    cleanTempDirs();
});

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** The most recent request the mock saw on a path. */
const lastSeen = (s: MediaStack, route: string): any => s.seen(route).at(-1);

describe('GET /media/catalog', () => {
    it('serves each medium: live first, then from the cache, and refreshes on request', async () => {
        const s = await stack();
        const first = await s.h.api('GET', '/media/catalog?medium=tts');
        expect(first.status).toBe(200);
        expect(first.json).toMatchObject({ medium: 'tts', source: 'live' });
        expect(first.json['models'].map((m: any) => m.id)).toContain('Kokoro-82m');
        expect(first.json['models'].every((m: any) => m.medium === 'tts')).toBe(true);
        expect(typeof first.json['fetchedAt']).toBe('number');
        expect((await s.h.api('GET', '/media/catalog?medium=tts')).json['source']).toBe('cache');
        expect((await s.h.api('GET', '/media/catalog?medium=tts&refresh=1')).json['source']).toBe('live');
        for (const medium of ['image', 'video', 'stt']) {
            const res = await s.h.api('GET', `/media/catalog?medium=${medium}`);
            expect(res.json['medium']).toBe(medium);
            expect(res.json['models'].length).toBeGreaterThan(5);
        }
        // The lists are fetched without a key.
        for (const route of ['/api/v1/images/models', '/api/v1/video-models', '/api/v1/audio-models']) {
            expect(s.seen(route).length).toBeGreaterThan(0);
            expect(s.seen(route).every((e: any) => e.headers.authorization === undefined)).toBe(true);
        }
        // The cache file of the medium is written under the global dir.
        const file = path.join(s.h.root, '_nanovia', 'media-tts.json');
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1, models: expect.any(Array) });
    });

    it('refuses a bad medium and says so when there is no data at all', async () => {
        const s = await stack({ fetch: forcing(() => ({ 'x-mock-error': '503' })) });
        expect((await s.h.api('GET', '/media/catalog')).json['error']['code']).toBe('invalid_request');
        expect((await s.h.api('GET', '/media/catalog?medium=audio')).status).toBe(400);
        const none = await s.h.api('GET', '/media/catalog?medium=image');
        expect(none.status).toBe(502);
        expect(none.json['error']['code']).toBe('media_unavailable');
    });
});

describe('POST /media/image', () => {
    it('generates through the OpenAI-compatible route and answers the contract shape', async () => {
        const s = await stack();
        const res = await s.h.api('POST', '/media/image', {
            model: 'rev-animated',
            prompt: 'a lighthouse',
            size: '512x512',
            connectionId: 'abc12345',
        });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            model: 'rev-animated',
            outputs: [{ kind: 'image', mime: 'image/png', dataBase64: TINY_PNG, bytes: 68 }],
            requestId: expect.stringMatching(/^media-image:/),
            cost: {
                usd: 0.0017,
                source: 'response',
                estimateUsd: 0.0017,
                paymentSource: 'USD',
                remainingUsd: expect.any(Number),
            },
        });
        expect(typeof res.json['latencyMs']).toBe('number');
        // What went upstream: the OpenAI route, b64_json asked for, the key as a bearer (masked in the mock's log).
        const seen = lastSeen(s, '/v1/images/generations');
        expect(seen.body).toEqual({
            model: 'rev-animated',
            prompt: 'a lighthouse',
            n: 1,
            response_format: 'b64_json',
            size: '512x512',
        });
        expect(seen.headers.authorization).toMatch(/^Bearer sk-nano-…/);
        expect(seen.headers['x-billing-mode']).toBeUndefined();
        // The usage record.
        expect(s.h.usage()[0]).toMatchObject({
            medium: 'image',
            units: 1,
            model: 'rev-animated',
            requestId: res.json['requestId'],
            costUsd: 0.0017,
            costSource: 'response',
            billing: 'paygo',
            connectionId: 'abc12345',
            status: 200,
            error: null,
            promptTokens: null,
        });
    });

    it('passes the fields a model lists, drops the ones it does not, and sends X-Billing-Mode: paygo on request', async () => {
        const s = await stack();
        const res = await s.h.api('POST', '/media/image', {
            model: 'moss-image',
            prompt: 'a castle',
            negativePrompt: 'blur',
            n: 2,
            size: '1024x1024',
            seed: 7,
            steps: 20,
            guidance: 4.5,
            billing: 'paygo',
            extra: { output_format: 'png', bogus: 'x', model: 'evil' },
        });
        expect(res.status).toBe(200);
        expect(res.json['outputs']).toHaveLength(2);
        const seen = lastSeen(s, '/v1/images/generations');
        expect(seen.body).toEqual({
            output_format: 'png',
            model: 'moss-image',
            prompt: 'a castle',
            n: 2,
            response_format: 'b64_json',
            size: '1024x1024',
            negative_prompt: 'blur',
            seed: 7,
            num_inference_steps: 20,
            guidance_scale: 4.5,
        });
        expect(seen.headers['x-billing-mode']).toBe('paygo');
        expect(res.json['cost']).toMatchObject({ usd: 0.104858, estimateUsd: 0.104858 });
        expect(s.h.usage()[0]).toMatchObject({ units: 2, costUsd: 0.104858 });
    });

    it('sends input images as data URLs and refuses links on this route', async () => {
        const s = await stack();
        const dataUrl = `data:image/png;base64,${TINY_PNG}`;
        const ok = await s.h.api('POST', '/media/image', {
            model: 'pixelwave',
            prompt: 'x',
            inputImages: [dataUrl],
            mask: dataUrl,
        });
        expect(ok.status).toBe(200);
        expect(lastSeen(s, '/v1/images/generations').body).toMatchObject({
            imageDataUrl: dataUrl,
            maskDataUrl: dataUrl,
        });
        const link = await s.h.api('POST', '/media/image', {
            model: 'pixelwave',
            prompt: 'x',
            inputImages: ['https://example.test/a.png'],
        });
        expect(link.status).toBe(400);
        expect(link.json['error']['code']).toBe('invalid_request');
    });

    it('handles a url output and sniffs the type of an inline one', async () => {
        const s = await stack();
        // The mock answers a url when asked; the route always asks for b64_json, so a custom fetch plays NanoGPT here.
        const real = globalThis.fetch as any;
        const urlStack = await stack({
            fetch: (async (url: string, init: any) => {
                if (init.method === 'POST' && url.endsWith('/v1/images/generations')) {
                    const body = JSON.parse(init.body);
                    return real(url, { ...init, body: JSON.stringify({ ...body, response_format: 'url' }) });
                }
                return real(url, init);
            }) as any,
        });
        const res = await urlStack.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' });
        expect(res.status).toBe(200);
        expect(res.json['outputs'][0]).toEqual({
            kind: 'image',
            mime: 'image/png',
            url: expect.stringContaining('/__mock/image.png'),
        });
        expect(res.json['outputs'][0].dataBase64).toBeUndefined();
        expect(s.h.usage()).toEqual([]);
    });

    it('checks the request and the model before calling NanoGPT', async () => {
        const s = await stack();
        const call = (body: unknown) => s.h.api('POST', '/media/image', body);
        expect((await call({ model: 'rev-animated' })).json['error']['code']).toBe('invalid_request');
        expect((await call({ model: 'rev-animated', prompt: 'x', n: 0 })).status).toBe(400);
        const unknown = await call({ model: 'no-such-model', prompt: 'x' });
        expect(unknown.status).toBe(400);
        expect(unknown.json['error']).toMatchObject({
            code: 'invalid_request',
            message: expect.stringContaining('no-such-model'),
        });
        // A model of another medium is unknown here.
        expect((await call({ model: 'Kokoro-82m', prompt: 'x' })).status).toBe(400);
        const tooMany = await call({ model: 'speridlabs/iris-z', prompt: 'x', n: 2 });
        expect(tooMany.status).toBe(400);
        expect(tooMany.json['error']['message']).toContain('at most 1');
        const huge = `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024, 1).toString('base64')}`;
        const big = await call({ model: 'pixelwave', prompt: 'x', inputImages: [huge] });
        expect(big.status).toBe(413);
        expect(big.json['error']['code']).toBe('payload_too_large');
        expect(s.seen('/v1/images/generations')).toHaveLength(0);
        expect(s.h.usage()).toEqual([]);
    });

    it('needs a key, and honours keyId', async () => {
        const s = await stack();
        const second = s.h.st.addNanoKey('default-user', 'sk-nano-second-key-0000000000000000', 'second');
        s.h.st.addNanoKey('carol', NANO_KEY, 'carols');
        const named = await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x', keyId: second });
        expect(named.status).toBe(200);
        expect(lastSeen(s, '/v1/images/generations').headers.authorization).toContain('sk-nano-…0000');
        expect(
            (await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x', keyId: 'missing' })).json[
                'error'
            ]['code'],
        ).toBe('not_found');
        // A user without a key.
        const nokey = await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' }, 'dave');
        expect(nokey.status).toBe(409);
        expect(nokey.json['error']['code']).toBe('no_key');
    });

    it('maps NanoGPT failures to the contract codes with its own words, and records the failed call without a cost', async () => {
        const cases: [string, number, string, RegExp][] = [
            ['401-text', 502, 'upstream_error', /rejected the key \(HTTP 401\): Invalid session/],
            ['402-legacy', 402, 'insufficient_balance', /0\.0035 USD/],
            ['400-policy', 400, 'content_policy_violation', /content policy/],
            ['429', 429, 'rate_limited', /rate limiting/],
            ['500', 502, 'upstream_error', /HTTP 500: Internal server error/],
            ['502-empty', 502, 'upstream_error', /HTTP 502/],
        ];
        for (const [mode, status, code, message] of cases) {
            // Only the call itself is made to fail: the model list (needed first) is fetched cleanly.
            let failing = false;
            const real = globalThis.fetch as any;
            const s = await stack({
                fetch: ((url: string, init: any) =>
                    real(url, {
                        ...init,
                        headers:
                            init.method === 'POST' && failing
                                ? { ...init.headers, 'x-mock-error': mode }
                                : init.headers,
                    })) as any,
            });
            await s.h.api('GET', '/media/catalog?medium=image');
            failing = true;
            const res = await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' });
            expect(res.status, mode).toBe(status);
            expect(res.json['error']['code'], mode).toBe(code);
            expect(res.json['error']['message'], mode).toMatch(message);
            expect(s.h.usage(), mode).toHaveLength(1);
            expect(s.h.usage()[0], mode).toMatchObject({
                medium: 'image',
                costUsd: null,
                costSource: 'unknown',
                billing: 'unknown',
                status,
                error: code,
            });
            expect(s.clock.waiting(), mode).toEqual([]); // nothing to reconcile for a failed call
        }
    });

    it('answers 504 when NanoGPT is too slow and 502 when it cannot be reached', async () => {
        let mode: 'slow' | 'down' | 'ok' = 'ok';
        const real = globalThis.fetch as any;
        const s = await stack({
            media: { timeouts: { imageMs: 150 } },
            fetch: ((url: string, init: any) => {
                if (init.method === 'POST' && mode === 'slow') {
                    return real(url, { ...init, headers: { ...init.headers, 'x-mock-delay-ms': '1500' } });
                }
                if (init.method === 'POST' && mode === 'down') {
                    return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
                }
                return real(url, init);
            }) as any,
        });
        await s.h.api('GET', '/media/catalog?medium=image');
        mode = 'slow';
        const slow = await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' });
        expect(slow.status).toBe(504);
        expect(slow.json['error']['code']).toBe('upstream_timeout');
        mode = 'down';
        const down = await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' });
        expect(down.status).toBe(502);
        expect(down.json['error']['code']).toBe('upstream_unreachable');
        expect(s.h.usage().map((u) => u['error'])).toEqual(['upstream_timeout', 'upstream_unreachable']);
    });

    it('refuses an answer without an image', async () => {
        const real = globalThis.fetch as any;
        const s = await stack({
            fetch: ((url: string, init: any) => {
                if (init.method === 'POST')
                    return Promise.resolve(new Response(JSON.stringify({ data: [], cost: 0.1 }), { status: 200 }));
                return real(url, init);
            }) as any,
        });
        const res = await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' });
        expect(res.status).toBe(502);
        expect(res.json['error']).toMatchObject({
            code: 'upstream_error',
            message: 'NanoGPT answered without an image',
        });
        expect(s.h.usage()[0]).toMatchObject({ costUsd: null, error: 'upstream_error' });
    });
});

describe('POST /media/tts', () => {
    it('answers the audio bytes with the upstream content type, never assuming mp3, and the catalog cost', async () => {
        const s = await stack();
        const res = await s.h.api('POST', '/media/tts', {
            model: 'Kokoro-82m',
            input: 'Hello there, friend.',
            voice: 'af_bella',
            format: 'mp3',
            speed: 1.1,
            connectionId: 'abc12345',
        });
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            model: 'Kokoro-82m',
            chars: 20,
            audio: { kind: 'audio', mime: 'audio/x-wav', bytes: expect.any(Number) },
            cost: { usd: 0.000034, source: 'estimate', estimateUsd: 0.000034, paymentSource: null, remainingUsd: null },
        });
        const bytes = Buffer.from(res.json['audio'].dataBase64, 'base64');
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
        expect(bytes.length).toBe(res.json['audio'].bytes);
        expect(lastSeen(s, '/v1/audio/speech').body).toEqual({
            model: 'Kokoro-82m',
            input: 'Hello there, friend.',
            voice: 'af_bella',
            response_format: 'mp3',
            speed: 1.1,
        });
        expect(s.h.usage()[0]).toMatchObject({
            medium: 'tts',
            units: 20,
            requestId: null,
            costUsd: 0.000034,
            costSource: 'estimate',
            connectionId: 'abc12345',
            status: 200,
        });
        // No request id came back, so there is nothing to reconcile.
        expect(s.clock.waiting()).toEqual([]);
    });

    it('sends the default voice when none is named and counts characters as code points', async () => {
        const s = await stack();
        const res = await s.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'Привет 😀' });
        expect(res.json['chars']).toBe(8);
        const kokoro = (await s.h.api('GET', '/media/catalog?medium=tts')).json['models'].find(
            (m: any) => m.id === 'Kokoro-82m',
        );
        expect(lastSeen(s, '/v1/audio/speech').body.voice).toBe(kokoro.voices[0]);
    });

    it('has no estimate for models priced per second or in tokens, and records an unknown cost', async () => {
        const s = await stack();
        const res = await s.h.api('POST', '/media/tts', { model: 'elevenlabs/music/v2', input: 'a calm piano melody' });
        expect(res.status).toBe(200);
        expect(res.json['cost']).toEqual({
            usd: null,
            source: 'unknown',
            estimateUsd: null,
            paymentSource: null,
            remainingUsd: null,
        });
        expect(s.h.usage()[0]).toMatchObject({ medium: 'tts', costUsd: null, costSource: 'unknown' });
    });

    it('checks the request, passes NanoGPT refusals on with its own words and handles a link answer', async () => {
        const s = await stack();
        expect((await s.h.api('POST', '/media/tts', { model: 'Kokoro-82m' })).status).toBe(400);
        expect((await s.h.api('POST', '/media/tts', { model: 'nope', input: 'x' })).json['error']['code']).toBe(
            'invalid_request',
        );
        expect((await s.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x', speed: 99 })).status).toBe(400);
        const badVoice = await s.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x', voice: 'zzz' });
        expect(badVoice.status).toBe(502);
        expect(badVoice.json['error']['message']).toContain("Voice 'zzz' is not available");
        expect(s.h.usage().at(-1)).toMatchObject({ costUsd: null, error: 'upstream_error' });

        const real = globalThis.fetch as any;
        let answer: Response | null = null;
        const linked = await stack({
            fetch: ((url: string, init: any) =>
                init.method === 'POST' && answer ? Promise.resolve(answer) : real(url, init)) as any,
        });
        await linked.h.api('GET', '/media/catalog?medium=tts');
        answer = new Response(JSON.stringify({ audioUrl: 'https://cdn.test/a.mp3' }), {
            headers: { 'content-type': 'application/json' },
        });
        const link = await linked.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x' });
        expect(link.json['audio']).toEqual({ kind: 'audio', mime: 'audio/mpeg', url: 'https://cdn.test/a.mp3' });
        answer = new Response(JSON.stringify({ nothing: true }), { headers: { 'content-type': 'application/json' } });
        expect(
            (await linked.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x' })).json['error']['message'],
        ).toBe('NanoGPT did not answer with audio');
        answer = new Response(new Uint8Array(0), { headers: { 'content-type': 'audio/mpeg' } });
        expect(
            (await linked.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x' })).json['error']['message'],
        ).toBe('NanoGPT answered with no audio');
        answer = new Response(new Uint8Array([1, 2, 3]));
        const untyped = await linked.h.api('POST', '/media/tts', { model: 'Kokoro-82m', input: 'x' });
        expect(untyped.json['audio'].mime).toBe('application/octet-stream');
    });
});

describe('POST /media/stt', () => {
    const request = (extra: Record<string, unknown> = {}) => ({
        model: 'qwen/qwen3-asr-0.6b',
        audioBase64: wav(2).toString('base64'),
        filename: 'speech.wav',
        mime: 'audio/wav',
        ...extra,
    });

    it('uploads the recording as multipart and answers text, language, duration and the cost from the body', async () => {
        const s = await stack();
        const res = await s.h.api('POST', '/media/stt', request({ connectionId: 'abc12345' }));
        expect(res.status).toBe(200);
        expect(res.json).toMatchObject({
            model: 'qwen/qwen3-asr-0.6b',
            text: 'Hello, there, friend.',
            language: 'auto-detect',
            durationSec: 2,
            segments: [],
            cost: { usd: 0.00000666, source: 'response', estimateUsd: 0.00000666 },
        });
        const seen = lastSeen(s, '/v1/audio/transcriptions');
        expect(seen.body.multipart).toEqual({
            fields: { model: 'qwen/qwen3-asr-0.6b' },
            files: [{ name: 'file', filename: 'speech.wav', mime: 'audio/wav', bytes: 16044 }],
        });
        expect(seen.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(s.h.usage()[0]).toMatchObject({
            medium: 'stt',
            units: 2,
            requestId: null,
            costUsd: 0.00000666,
            costSource: 'response',
            connectionId: 'abc12345',
        });
    });

    it('asks for verbose_json where the model offers it (segments) and for diarization where it diarizes', async () => {
        const s = await stack();
        const verbose = await s.h.api(
            'POST',
            '/media/stt',
            request({ model: 'Whisper-Large-V3', language: 'en', prompt: 'names' }),
        );
        expect(verbose.json['segments']).toEqual([{ start: 0, end: 2, text: 'Hello, there, friend.', speaker: null }]);
        expect(lastSeen(s, '/v1/audio/transcriptions').body.multipart.fields).toEqual({
            model: 'Whisper-Large-V3',
            language: 'en',
            prompt: 'names',
            response_format: 'verbose_json',
        });
        await s.h.api('POST', '/media/stt', request({ model: 'elevenlabs/scribe-v3', diarize: true }));
        expect(lastSeen(s, '/v1/audio/transcriptions').body.multipart.fields).toMatchObject({
            diarize: 'true',
            response_format: 'verbose_json',
        });
    });

    it('prices from the catalog when the body has no cost, and reads a plain-text answer', async () => {
        const real = globalThis.fetch as any;
        let answer: Response | null = null;
        const s = await stack({
            fetch: ((url: string, init: any) =>
                init.method === 'POST' && answer ? Promise.resolve(answer) : real(url, init)) as any,
        });
        await s.h.api('GET', '/media/catalog?medium=stt');
        answer = new Response(JSON.stringify({ text: 'No cost here', duration: 60 }), {
            headers: { 'content-type': 'application/json' },
        });
        const priced = await s.h.api('POST', '/media/stt', request({ model: 'Whisper-Large-V3' }));
        expect(priced.json['cost']).toMatchObject({ usd: 0.000495, source: 'estimate' });
        answer = new Response('Just the words\n', { headers: { 'content-type': 'text/plain' } });
        const text = await s.h.api('POST', '/media/stt', request({ model: 'Whisper-Large-V3' }));
        expect(text.json).toMatchObject({
            text: 'Just the words',
            durationSec: null,
            cost: { usd: null, source: 'unknown' },
        });
        answer = new Response(JSON.stringify({ language: 'en' }), { headers: { 'content-type': 'application/json' } });
        expect((await s.h.api('POST', '/media/stt', request())).json['error']['message']).toBe(
            'NanoGPT answered without a transcript',
        );
    });

    it('checks the request: size ceiling, base64, model', async () => {
        const s = await stack();
        const huge = await s.h.api(
            'POST',
            '/media/stt',
            request({ audioBase64: Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString('base64') }),
        );
        expect(huge.status).toBe(413);
        expect(huge.json['error']['code']).toBe('payload_too_large');
        expect(
            (await s.h.api('POST', '/media/stt', request({ audioBase64: 'not base64!' }))).json['error']['code'],
        ).toBe('invalid_request');
        expect((await s.h.api('POST', '/media/stt', request({ model: 'Kokoro-82m' }))).status).toBe(400);
        expect((await s.h.api('POST', '/media/stt', request({ model: 'nope' }))).json['error']['message']).toContain(
            '"nope"',
        );
        // The ceiling is checked after the catalog, but always before NanoGPT is called.
        expect(s.seen('/v1/audio/transcriptions')).toHaveLength(0);
        const exact = await s.h.api(
            'POST',
            '/media/stt',
            request({ audioBase64: Buffer.alloc(4 * 1024 * 1024, 1).toString('base64') }),
        );
        expect(exact.status).toBe(200);
    });

    it('maps NanoGPT refusals', async () => {
        const real = globalThis.fetch as any;
        let mode = '';
        const s = await stack({
            fetch: ((url: string, init: any) =>
                real(url, {
                    ...init,
                    headers: init.method === 'POST' && mode ? { ...init.headers, 'x-mock-error': mode } : init.headers,
                })) as any,
        });
        await s.h.api('GET', '/media/catalog?medium=stt');
        mode = '402-legacy';
        const poor = await s.h.api('POST', '/media/stt', request());
        expect(poor.status).toBe(402);
        expect(poor.json['error']['code']).toBe('insufficient_balance');
        expect(s.h.usage().at(-1)).toMatchObject({
            medium: 'stt',
            costUsd: null,
            error: 'insufficient_balance',
            status: 402,
        });
    });
});

describe('secrecy and isolation', () => {
    it('never puts the key into a reply, a log line, a usage file, a job file or the mock log (other than masked)', async () => {
        const s = await stack();
        const replies: string[] = [];
        for (const [route, body] of [
            ['/media/image', { model: 'rev-animated', prompt: 'x' }],
            ['/media/tts', { model: 'Kokoro-82m', input: 'x' }],
            [
                '/media/stt',
                {
                    model: 'qwen/qwen3-asr-0.6b',
                    audioBase64: wav(1).toString('base64'),
                    filename: 'a.wav',
                    mime: 'audio/wav',
                },
            ],
            ['/media/video', { model: 'kling-v25-turbo-std', prompt: 'x', duration: 5 }],
            ['/media/image', { model: 'no-such-model', prompt: 'x' }],
        ] as const) {
            replies.push((await s.h.api('POST', route, body)).text);
        }
        replies.push(
            (await s.h.api('GET', '/media/video')).text,
            (await s.h.api('GET', '/media/catalog?medium=image')).text,
        );
        const everything = [
            ...replies,
            ...s.h.logs,
            userFolderText(s.h.root),
            JSON.stringify(s.mock.state.log),
            JSON.stringify(s.h.usage()),
        ].join('\n');
        expect(everything).not.toContain(NANO_KEY);
        expect(everything).not.toContain('0123456789abcdefghijklmnopqrstuv');
        expect(JSON.stringify(s.mock.state.log)).toContain('sk-nano-…');
    });

    it('keeps users apart: their keys, their usage, their jobs', async () => {
        const s = await stack();
        s.h.st.addNanoKey('erin', 'sk-nano-erin-key-0000000000000000000', 'erin');
        await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' });
        await s.h.api('POST', '/media/image', { model: 'rev-animated', prompt: 'x' }, 'erin');
        expect(usageLines(s.h.root)).toHaveLength(1);
        expect(usageLines(s.h.root, 'erin')).toHaveLength(1);
        const auths = s.seen('/v1/images/generations').map((e: any) => e.headers.authorization as string);
        expect(auths[0]).toBe('Bearer sk-nano-…TAIL');
        expect(auths[1]).toContain('0000');
        const job = (await s.h.api('POST', '/media/video', { model: 'kling-v25-turbo-std', prompt: 'x', duration: 5 }))
            .json;
        expect((await s.h.api('GET', '/media/video', undefined, 'erin')).json['jobs']).toEqual([]);
        expect((await s.h.api('GET', `/media/video/${job['id']}`, undefined, 'erin')).status).toBe(404);
        expect((await s.h.api('DELETE', `/media/video/${job['id']}`, undefined, 'erin')).status).toBe(404);
        expect((await s.h.api('GET', '/media/video')).json['jobs']).toHaveLength(1);
    });
});
