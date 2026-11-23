// A real call to NanoGPT through the whole plugin (docs/DEPLOY.md "live check"). Skipped unless NANOVIA_LIVE_KEY is set;
// the key is read from the environment only, lives in memory, and is never printed. Spends a fraction of a cent.
//   PowerShell:  $env:NANOVIA_LIVE_KEY = '...'; npm run test:live
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of responses is inspected loosely */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, cleanTempDirs, waitFor, type Harness } from '../server/helpers';

const KEY = process.env['NANOVIA_LIVE_KEY']?.trim() ?? '';
const MODEL = process.env['NANOVIA_LIVE_MODEL']?.trim() || 'deepseek/deepseek-v4.1-flash-1017';

/** Asks `read` every second until it gives something, or null at the deadline (waitFor of the helpers is synchronous). */
async function until<T>(read: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

describe.skipIf(!KEY)('live NanoGPT through the plugin', () => {
    let h: Harness;
    let token = '';

    beforeAll(async () => {
        h = await boot({
            config: { upstreamFallbackBase: null },
            // Media: the plugin fetches the real lists itself; the cost correction is asked for sooner than in production.
            media: { catalog: { autoFetch: true }, reconcileDelaysMs: [12_000, 25_000, 45_000] },
        });
        h.st.addNanoKey('default-user', KEY, 'live');
        ({ token } = await h.connect({ name: 'Live', modelId: MODEL, mode: 'plugin' }));
    });

    afterAll(async () => {
        await h?.close();
        cleanTempDirs();
    });

    async function chat(body: Record<string, unknown>): Promise<Response> {
        const connections = (await h.api('GET', '/connections')).json['connections'] as any[];
        const base = (connections[0].proxyUrl as string).replace(/\/c\/.*$/, '');
        return fetch(`${base}/c/${connections[0].id}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    }

    it('answers a non-streaming request and reports a real cost', async () => {
        const response = await chat({
            model: MODEL,
            max_tokens: 24,
            messages: [{ role: 'user', content: 'Reply with one word: ok' }],
        });
        const text = await response.text();
        expect(response.status, text.replaceAll(KEY, '***')).toBe(200);
        const json = JSON.parse(text);
        expect(json.choices?.[0]?.message).toBeTruthy();
        expect(typeof json.usage?.cost).toBe('number');
        expect(text).not.toContain(KEY);
        const record = await waitFor(() => h.usage()[0]);
        expect(typeof record.costUsd).toBe('number');
        expect(record.promptTokens).toBeGreaterThan(0);
        expect(record.status).toBe(200);
    }, 60_000);

    it('streams and ends with usage', async () => {
        const response = await chat({
            model: MODEL,
            max_tokens: 24,
            stream: true,
            messages: [{ role: 'user', content: 'Reply with one word: ok' }],
        });
        const text = await response.text();
        expect(response.status, text.replaceAll(KEY, '***')).toBe(200);
        const tail = text.slice(-900).replaceAll(KEY, '***');
        expect(text, tail).toContain('[DONE]');
        expect(text, tail).toMatch(/"cost":\s*[0-9.e-]+/);
        expect(text).not.toContain(KEY);
    }, 60_000);

    it('reads the balance and the subscription state', async () => {
        const balance = await h.api('GET', '/account/balance');
        expect(balance.status, JSON.stringify(balance.json)).toBe(200);
        expect(typeof balance.json['usdBalance']).toBe('number');
        const subscription = await h.api('GET', '/account/subscription');
        expect(subscription.status, JSON.stringify(subscription.json)).toBe(200);
        expect(typeof subscription.json['subscription']?.active).toBe('boolean');
    }, 60_000);

    describe('media (a few thousandths of a cent per call)', () => {
        const IMAGE_MODEL = 'rev-animated';
        const TTS_MODEL = 'Kokoro-82m';
        const STT_MODEL = 'qwen/qwen3-asr-0.6b';
        let speech = '';

        it('loads the real lists and knows the cheap models', async () => {
            for (const [medium, id] of [
                ['image', IMAGE_MODEL],
                ['tts', TTS_MODEL],
                ['stt', STT_MODEL],
            ] as const) {
                const models = await until(async () => {
                    const answer = await h.api('GET', `/media/catalog?medium=${medium}`);
                    return answer.status === 200 ? (answer.json['models'] as any[]) : null;
                }, 60_000);
                expect(models, medium).toBeTruthy();
                const found = (models ?? []).find((m) => m.id === id);
                expect(found, `${medium}: ${id}`).toBeTruthy();
                expect(found.price.from, `${medium} price`).toBeGreaterThan(0);
            }
            const video = await h.api('GET', '/media/catalog?medium=video');
            expect(video.status).toBe(200);
            expect((video.json['models'] as any[]).length).toBeGreaterThan(20);
        }, 120_000);

        it('makes an image and later corrects its cost from the billing lookup', async () => {
            const made = await h.api('POST', '/media/image', {
                model: IMAGE_MODEL,
                prompt: 'a red apple on a table, simple flat illustration',
                size: '512x512',
            });
            expect(made.status, JSON.stringify(made.json).slice(0, 300).replaceAll(KEY, '***')).toBe(200);
            expect(made.json['outputs'][0].mime).toMatch(/^image\//);
            expect(made.json['outputs'][0].dataBase64 ?? made.json['outputs'][0].url).toBeTruthy();
            expect(typeof made.json['cost'].usd).toBe('number');
            expect(made.json['requestId']).toBeTruthy();
            // The body figure is a list price; the lookup corrects it.
            const corrected = await until(async () => {
                const recent = await h.api('GET', '/usage/recent?limit=20');
                return (recent.json['records'] as any[]).find((r) => r.medium === 'image' && r.costSource === 'lookup');
            }, 90_000);
            expect(corrected, 'the image cost was not reconciled from the lookup').toBeTruthy();
            expect(corrected.costUsd).toBeGreaterThanOrEqual(made.json['cost'].usd);
        }, 150_000);

        it('speaks (the real content type, not the requested one) and transcribes what it said', async () => {
            const spoke = await h.api('POST', '/media/tts', {
                model: TTS_MODEL,
                input: 'Hello there, friend.',
                voice: 'af_bella',
                format: 'mp3',
            });
            expect(spoke.status, JSON.stringify(spoke.json).slice(0, 300).replaceAll(KEY, '***')).toBe(200);
            expect(spoke.json['audio'].mime).toMatch(/^audio\//);
            expect(spoke.json['chars']).toBe(20);
            expect(spoke.json['cost'].usd).toBeGreaterThan(0);
            speech = spoke.json['audio'].dataBase64;
            expect(speech.length).toBeGreaterThan(1000);
            const heard = await h.api('POST', '/media/stt', {
                model: STT_MODEL,
                audioBase64: speech,
                filename: 'speech.wav',
                mime: spoke.json['audio'].mime,
            });
            expect(heard.status, JSON.stringify(heard.json).slice(0, 300).replaceAll(KEY, '***')).toBe(200);
            expect(String(heard.json['text']).toLowerCase()).toContain('hello');
            expect(heard.json['cost'].usd).toBeGreaterThanOrEqual(0);
        }, 120_000);

        it('answers the OpenAI-shaped speech route of the proxy with audio and a cost header', async () => {
            const connections = (await h.api('GET', '/connections')).json['connections'] as any[];
            const base = (connections[0].proxyUrl as string).replace(/\/c\/.*$/, '');
            const response = await fetch(`${base}/c/${connections[0].id}/v1/audio/speech`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ model: TTS_MODEL, input: 'Hi.', voice: 'af_bella' }),
            });
            const bytes = Buffer.from(await response.arrayBuffer());
            expect(response.status, bytes.subarray(0, 200).toString('utf8').replaceAll(KEY, '***')).toBe(200);
            expect(response.headers.get('content-type') ?? '').toMatch(/^audio\//);
            expect(bytes.length).toBeGreaterThan(500);
            expect(response.headers.get('x-nanovia-cost')).toBeTruthy();
            expect(bytes.toString('latin1')).not.toContain(KEY);
        }, 60_000);
    });

    it('leaves the key out of every log line and usage record', () => {
        expect(JSON.stringify(h.usage())).not.toContain(KEY);
        expect(h.logs.join('\n')).not.toContain(KEY);
    });
});
