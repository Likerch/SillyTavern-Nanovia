/* eslint-disable @typescript-eslint/no-explicit-any */
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { NANO_KEY, boot, cleanTempDirs, sleep, waitFor, type Harness } from './helpers';
import {
    forcing,
    startMediaStack,
    transcriptionForm,
    usageLines,
    userFolderText,
    wav,
    type MediaStack,
} from './media-helpers';

const stacks: MediaStack[] = [];
const harnesses: Harness[] = [];
const servers: http.Server[] = [];
async function stack(options: Parameters<typeof startMediaStack>[0] = {}): Promise<MediaStack> {
    const s = await startMediaStack(options);
    stacks.push(s);
    return s;
}
afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.close();
    for (const s of stacks.splice(0)) await s.close();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    cleanTempDirs();
});

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

interface Connected {
    base: string;
    id: string;
    token: string;
}
async function connect(s: { h: Harness }, body: Record<string, unknown> = {}): Promise<Connected> {
    const { view, token } = await s.h.connect({ name: 'Media', modelId: 'glm-5', ...body });
    return { base: `${s.h.proxy}/c/${view.id}/v1`, id: view.id, token };
}
const bearer = (c: Connected) => ({ authorization: `Bearer ${c.token}` });
const speech = (c: Connected, body: unknown, headers: Record<string, string> = bearer(c)) =>
    fetch(`${c.base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
const images = (c: Connected, body: unknown, headers: Record<string, string> = bearer(c)) =>
    fetch(`${c.base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
const transcribe = (c: Connected, form: FormData, headers: Record<string, string> = bearer(c)) =>
    fetch(`${c.base}/audio/transcriptions`, { method: 'POST', headers, body: form });
const lastSeen = (s: MediaStack, route: string): any => s.seen(route).at(-1);
const jsonOf = (res: Response): Promise<any> => res.json();
/** The usage records once there are `count` of them (the record of a streamed reply is written when the stream ends). */
const records_ = (s: { h: Harness }, count = 1) =>
    waitFor(() => {
        const found = s.h.usage();
        return found.length >= count && found;
    });

describe('POST /v1/audio/speech', () => {
    it('passes the upstream status, content type and bytes through, with the cost and a usage record', async () => {
        const s = await stack();
        const c = await connect(s);
        await s.h.app.deps.media.catalog.catalog('tts'); // the estimate needs the model in memory
        const request = {
            model: 'Kokoro-82m',
            input: 'Hello there, friend.',
            voice: 'af_bella',
            response_format: 'mp3',
        };
        const res = await speech(c, request);
        expect(res.status).toBe(200);
        // The model's own content type, not the mp3 that was asked for.
        expect(res.headers.get('content-type')).toBe('audio/x-wav');
        expect(res.headers.get('x-nanovia-cost')).toBe('0.000034');
        expect(res.headers.get('x-nanovia-connection')).toBe(c.id);
        expect(res.headers.get('x-nanovia-request-id')).toBeNull();
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
        expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
        // The body went up as it came in; the key went up, not the proxy token.
        const seen = lastSeen(s, '/v1/audio/speech');
        expect(seen.body).toEqual(request);
        expect(seen.headers.authorization).toBe('Bearer sk-nano-…TAIL');
        expect(seen.headers['x-billing-mode']).toBeUndefined();
        expect((await records_(s))[0]).toMatchObject({
            medium: 'tts',
            model: 'Kokoro-82m',
            units: 20,
            requestId: null,
            costUsd: 0.000034,
            costSource: 'estimate',
            connectionId: c.id,
            status: 200,
            error: null,
            consumer: 'unknown',
        });
    });

    it('says nothing about the cost when the catalog does not know the model, and takes x-api-key and hints', async () => {
        const s = await stack();
        const c = await connect(s);
        const res = await speech(
            c,
            { model: 'Kokoro-82m', input: 'x' },
            { 'x-api-key': c.token, 'x-nanovia-consumer': 'background' },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('x-nanovia-cost')).toBeNull();
        expect((await records_(s))[0]).toMatchObject({
            costUsd: null,
            costSource: 'unknown',
            units: 1,
            consumer: 'background',
        });
    });

    it('forces pay-as-you-go upstream when the connection says so', async () => {
        const s = await stack();
        const paygo = await connect(s, { name: 'Paygo', billing: 'paygo' });
        await speech(paygo, { model: 'Kokoro-82m', input: 'x' });
        expect(lastSeen(s, '/v1/audio/speech').headers['x-billing-mode']).toBe('paygo');
        const auto = await connect(s, { name: 'Auto' });
        await speech(auto, { model: 'Kokoro-82m', input: 'x' });
        expect(lastSeen(s, '/v1/audio/speech').headers['x-billing-mode']).toBeUndefined();
    });

    it('answers upstream refusals in the OpenAI envelope, wrapping the other two shapes, and records the failure', async () => {
        const cases: [string, number, string, RegExp][] = [
            ['401-text', 401, 'upstream_error', /^NanoGPT answered HTTP 401: Invalid session$/],
            ['402-legacy', 402, 'upstream_error', /^NanoGPT answered HTTP 402: Insufficient balance$/],
            ['400-policy', 400, 'content_policy_violation', /content policy/],
            ['429', 429, 'rate_limit_exceeded', /Rate limit exceeded/],
            ['502-empty', 502, 'upstream_error', /^NanoGPT answered HTTP 502$/],
        ];
        for (const [mode, status, code, message] of cases) {
            const s = await stack({ fetch: forcing(() => ({ 'x-mock-error': mode })) });
            const c = await connect(s);
            const res = await speech(c, { model: 'Kokoro-82m', input: 'x' });
            expect(res.status, mode).toBe(status);
            const body = await jsonOf(res);
            expect(body.error.code, mode).toBe(code);
            expect(body.error.message, mode).toMatch(message);
            expect(body.error.type, mode).toEqual(expect.any(String));
            if (mode === '429') expect(res.headers.get('retry-after')).toBe('1');
            expect(s.h.usage()[0], mode).toMatchObject({ medium: 'tts', costUsd: null, status, error: code });
        }
    });

    it('answers 504 when NanoGPT is too slow and 502 when it cannot be reached', async () => {
        const real = globalThis.fetch as any;
        let mode: 'slow' | 'down' = 'slow';
        const s = await stack({
            media: { timeouts: { ttsMs: 150 } },
            fetch: ((url: string, init: any) =>
                mode === 'down'
                    ? Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
                    : real(url, { ...init, headers: { ...init.headers, 'x-mock-delay-ms': '1500' } })) as any,
        });
        const c = await connect(s);
        const slow = await speech(c, { model: 'Kokoro-82m', input: 'x' });
        expect(slow.status).toBe(504);
        expect((await jsonOf(slow)).error.code).toBe('upstream_timeout');
        mode = 'down';
        const down = await speech(c, { model: 'Kokoro-82m', input: 'x' });
        expect(down.status).toBe(502);
        expect((await jsonOf(down)).error.code).toBe('upstream_unreachable');
        expect(s.h.usage().map((u) => [u['status'], u['error']])).toEqual([
            [504, 'upstream_timeout'],
            [502, 'upstream_unreachable'],
        ]);
    });

    it('uses the key the connection chose, and needs one', async () => {
        const s = await stack();
        const second = s.h.st.addNanoKey('default-user', 'sk-nano-second-key-0000000000000000', 'second');
        const c = await connect(s, { name: 'Second', keyId: second });
        await speech(c, { model: 'Kokoro-82m', input: 'x' });
        expect(lastSeen(s, '/v1/audio/speech').headers.authorization).toBe('Bearer sk-nano-…0000');
        s.h.st.deleteSecret('default-user', 'api_key_nanogpt', second);
        const gone = await speech(c, { model: 'Kokoro-82m', input: 'x' });
        expect(gone.status).toBe(409);
        expect((await jsonOf(gone)).error).toMatchObject({
            code: 'no_key',
            message: expect.stringContaining('no longer exists'),
        });
        // No key here, and a media base nothing listens on, so no call can leave the machine even by mistake.
        const lonely = await boot({ config: { mediaBase: 'http://127.0.0.1:9' } });
        harnesses.push(lonely);
        const d = await connect({ h: lonely });
        const none = await speech(d, { model: 'Kokoro-82m', input: 'x' });
        expect(none.status).toBe(409);
        expect((await jsonOf(none)).error.message).toContain('No NanoGPT key is stored');
    });
});

describe('token check and request limits on the media endpoints', () => {
    it('demands the connection token, for each endpoint, before anything else', async () => {
        const s = await stack();
        const c = await connect(s);
        const other = await connect(s, { name: 'Other' });
        for (const [path, body] of [
            ['audio/speech', JSON.stringify({ model: 'Kokoro-82m', input: 'x' })],
            ['images/generations', JSON.stringify({ model: 'rev-animated', prompt: 'x' })],
            ['audio/transcriptions', transcriptionForm({ model: 'qwen/qwen3-asr-0.6b' })],
        ] as const) {
            const send = (headers: Record<string, string>) =>
                fetch(`${c.base}/${path}`, {
                    method: 'POST',
                    headers: typeof body === 'string' ? { 'content-type': 'application/json', ...headers } : headers,
                    body,
                });
            const none = await send({});
            expect(none.status, path).toBe(401);
            expect((await jsonOf(none)).error).toMatchObject({ type: 'authentication_error', code: 'missing_token' });
            const wrong = await send({ authorization: 'Bearer nope' });
            expect((await jsonOf(wrong)).error.code, path).toBe('invalid_token');
            // A valid token of ANOTHER connection does not open this URL.
            const crossed = await send({ authorization: `Bearer ${other.token}` });
            expect(crossed.status, path).toBe(401);
            // The real key is no token either.
            expect((await send({ authorization: `Bearer ${NANO_KEY}` })).status, path).toBe(401);
        }
        expect(s.mock.state.log.filter((e: any) => !String(e.path).startsWith('/api/v1/'))).toEqual([]);
        expect(s.seen('/v1/')).toHaveLength(0);
        expect(s.h.usage()).toEqual([]);
    });

    it('only takes POST, and an unknown media path is 404', async () => {
        const s = await stack();
        const c = await connect(s);
        for (const path of ['audio/speech', 'images/generations', 'audio/transcriptions']) {
            const res = await fetch(`${c.base}/${path}`, { headers: bearer(c) });
            expect(res.status, path).toBe(405);
            expect(res.headers.get('allow')).toBe('POST');
        }
        expect((await fetch(`${c.base}/audio/translations`, { method: 'POST', headers: bearer(c) })).status).toBe(404);
        expect((await fetch(`${c.base}/images/edits`, { method: 'POST', headers: bearer(c) })).status).toBe(404);
    });

    /** A request whose headers promise `length` bytes: the proxy answers before any of them is sent (raw socket, like a client that gives up). */
    function declared(c: Connected, route: string, length: number, contentType: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(Number(new URL(c.base).port), '127.0.0.1');
            let data = '';
            socket.on('data', (chunk) => (data += chunk.toString()));
            socket.on('close', () => resolve(data));
            socket.on('error', reject);
            socket.write(
                `POST /c/${c.id}/v1/${route} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${c.token}\r\n` +
                    `Content-Type: ${contentType}\r\nContent-Length: ${length}\r\n\r\n`,
            );
        });
    }

    it('refuses a body over the cap with 413 as soon as the declared size is known', async () => {
        const s = await stack();
        const c = await connect(s);
        const speechAnswer = await declared(c, 'audio/speech', 3 * 1024 * 1024, 'application/json');
        expect(speechAnswer.startsWith('HTTP/1.1 413')).toBe(true);
        expect(speechAnswer.toLowerCase()).toContain('connection: close');
        expect(speechAnswer).toContain('payload_too_large');
        expect(speechAnswer).toContain('2 MB');
        const imageAnswer = await declared(c, 'images/generations', 9 * 1024 * 1024, 'application/json');
        expect(imageAnswer.startsWith('HTTP/1.1 413')).toBe(true);
        expect(imageAnswer).toContain('8 MB');
        const sttAnswer = await declared(
            c,
            'audio/transcriptions',
            5 * 1024 * 1024,
            'multipart/form-data; boundary=abc',
        );
        expect(sttAnswer.startsWith('HTTP/1.1 413')).toBe(true);
        expect(s.seen('/v1/')).toHaveLength(0);
        const records = await records_(s, 3);
        expect(records.map((r) => [r['status'], r['error']])).toEqual(Array(3).fill([413, 'payload_too_large']));
    });

    it('cuts a body off that grows past the cap without announcing its size', async () => {
        const s = await stack();
        const c = await connect(s);
        const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            let reply: { status: number; body: string } | null = null;
            const req = http.request(
                `${c.base}/audio/speech`,
                {
                    method: 'POST',
                    headers: { ...bearer(c), 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
                },
                (res) => {
                    let text = '';
                    res.on('data', (d) => (text += d));
                    res.on('end', () => {
                        reply = { status: res.statusCode ?? 0, body: text };
                        resolve(reply);
                    });
                },
            );
            // The proxy may hang up while the rest is still being sent: that is the point.
            req.on('error', (error) => (reply ? undefined : reject(error)));
            const piece = Buffer.alloc(512 * 1024, 0x61);
            req.write('{"model":"Kokoro-82m","input":"');
            for (let i = 0; i < 6; i += 1) req.write(piece);
            req.end('"}');
        });
        expect(answer.status).toBe(413);
        expect(JSON.parse(answer.body).error.code).toBe('payload_too_large');
        expect(s.seen('/v1/')).toHaveLength(0);
    });

    it('lets a body just under the limits through', async () => {
        const s = await stack();
        const c = await connect(s);
        const near = await transcribe(
            c,
            transcriptionForm({ model: 'qwen/qwen3-asr-0.6b' }, Buffer.alloc(4 * 1024 * 1024, 1)),
        );
        expect(near.status).toBe(200);
        const text = 'x'.repeat(1024 * 1024);
        expect((await speech(c, { model: 'Kokoro-82m', input: text })).status).toBe(200);
    });

    it('refuses bad requests with a clear OpenAI-shaped error and a usage record', async () => {
        const s = await stack();
        const c = await connect(s);
        const code = async (res: Response) => (await jsonOf(res)).error.code;
        expect(await code(await speech(c, '{nope'))).toBe('invalid_json');
        expect(await code(await speech(c, '[]'))).toBe('invalid_request');
        expect(await code(await speech(c, { input: 'x' }))).toBe('missing_model');
        expect(await code(await speech(c, { model: 'Kokoro-82m' }))).toBe('invalid_request');
        expect(await code(await speech(c, { model: 'Kokoro-82m', input: '' }))).toBe('invalid_request');
        expect(await code(await images(c, { prompt: 'x' }))).toBe('missing_model');
        expect(await code(await transcribe(c, transcriptionForm({}, wav(1))))).toBe('missing_model');
        const noBoundary = await fetch(`${c.base}/audio/transcriptions`, {
            method: 'POST',
            headers: { ...bearer(c), 'content-type': 'application/json' },
            body: '{}',
        });
        expect(await code(noBoundary)).toBe('invalid_request');
        const empty = await fetch(`${c.base}/audio/speech`, {
            method: 'POST',
            headers: { ...bearer(c), 'content-type': 'application/json' },
        });
        expect(empty.status).toBe(400);
        expect(s.seen('/v1/')).toHaveLength(0);
        expect(s.h.usage().length).toBe(9);
        expect(s.h.usage().every((u) => u['costUsd'] === null && u['status'] === 400)).toBe(true);
    });
});

describe('POST /v1/images/generations', () => {
    it('passes the JSON through unchanged, adds the cost and request id, and reconciles the cost later', async () => {
        const s = await stack();
        const c = await connect(s);
        await s.h.app.deps.media.catalog.catalog('image');
        const res = await images(c, {
            model: 'rev-animated',
            prompt: 'a lighthouse',
            size: '512x512',
            n: 2,
            response_format: 'b64_json',
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await jsonOf(res);
        expect(body.data).toEqual([{ b64_json: TINY_PNG }, { b64_json: TINY_PNG }]);
        expect(body).toMatchObject({
            cost: 0.0034,
            paymentSource: 'USD',
            requestId: expect.stringMatching(/^media-image:/),
        });
        expect(res.headers.get('x-nanovia-cost')).toBe('0.0034');
        expect(res.headers.get('x-nanovia-request-id')).toBe(body.requestId);
        expect(res.headers.get('x-nanovia-connection')).toBe(c.id);
        expect(lastSeen(s, '/v1/images/generations').body).toEqual({
            model: 'rev-animated',
            prompt: 'a lighthouse',
            size: '512x512',
            n: 2,
            response_format: 'b64_json',
        });
        expect(s.h.usage()[0]).toMatchObject({
            medium: 'image',
            units: 2,
            requestId: body.requestId,
            costUsd: 0.0034,
            costSource: 'response',
            billing: 'paygo',
            connectionId: c.id,
        });
        // The body's figure is the list price: the lookup corrects it (billed 1.5x for this model).
        expect(s.clock.waiting()).toEqual([15_000]);
        s.clock.fire();
        await s.h.app.deps.media.reconciler.idle();
        expect(usageLines(s.h.root)[1]).toMatchObject({
            adjust: true,
            requestId: body.requestId,
            costUsd: 0.0051,
            costSource: 'lookup',
        });
        expect((await s.h.api('GET', '/spend')).json['total']['costUsd']).toBe(0.0051);
    });

    it('estimates from the catalog when the body has no cost, and relays an upstream error unchanged', async () => {
        const real = globalThis.fetch as any;
        let answer: Response | null = null;
        const s = await stack({
            fetch: ((url: string, init: any) =>
                init.method === 'POST' && answer ? Promise.resolve(answer) : real(url, init)) as any,
        });
        const c = await connect(s);
        await s.h.app.deps.media.catalog.catalog('image');
        answer = new Response(JSON.stringify({ data: [{ url: 'https://cdn.test/a.png' }] }), {
            headers: { 'content-type': 'application/json' },
        });
        const res = await images(c, { model: 'rev-animated', prompt: 'x', size: '512x512' });
        expect(res.headers.get('x-nanovia-cost')).toBe('0.0017');
        expect((await jsonOf(res)).data[0].url).toBe('https://cdn.test/a.png');
        expect(s.h.usage()[0]).toMatchObject({ costUsd: 0.0017, costSource: 'estimate', requestId: null, units: 1 });
        expect(s.clock.waiting()).toEqual([]);
        answer = null;
        const unknown = await images(c, { model: 'no-such-model', prompt: 'x' });
        expect(unknown.status).toBe(404);
        expect((await jsonOf(unknown)).error).toMatchObject({ code: 'model_not_found' });
        expect(s.h.usage().at(-1)).toMatchObject({ error: 'model_not_found', status: 404, costUsd: null });
    });

    it('relays an answer that is not JSON untouched', async () => {
        const real = globalThis.fetch as any;
        const s = await stack({
            fetch: ((url: string, init: any) =>
                init.method === 'POST'
                    ? Promise.resolve(
                          new Response('plain words', { status: 200, headers: { 'content-type': 'text/plain' } }),
                      )
                    : real(url, init)) as any,
        });
        const c = await connect(s);
        const res = await images(c, { model: 'rev-animated', prompt: 'x' });
        expect(res.headers.get('content-type')).toBe('text/plain');
        expect(await res.text()).toBe('plain words');
        expect(s.h.usage()[0]).toMatchObject({ costUsd: null, units: null });
    });
});

describe('POST /v1/audio/transcriptions', () => {
    it('forwards the multipart body as it came and returns the upstream JSON with the cost', async () => {
        const s = await stack();
        const c = await connect(s);
        const res = await transcribe(c, transcriptionForm({ model: 'qwen/qwen3-asr-0.6b', language: 'en' }, wav(2)));
        expect(res.status).toBe(200);
        expect(await jsonOf(res)).toEqual({
            text: 'Hello, there, friend.',
            language: 'auto-detect',
            duration: 2,
            usage: { seconds: 2, type: 'duration', cost: 0.00000666, currency: 'USD' },
        });
        expect(res.headers.get('x-nanovia-cost')).toBe('0.00000666');
        const seen = lastSeen(s, '/v1/audio/transcriptions');
        expect(seen.body.multipart).toEqual({
            fields: { model: 'qwen/qwen3-asr-0.6b', language: 'en' },
            files: [{ name: 'file', filename: 'speech.wav', mime: 'audio/wav', bytes: 16044 }],
        });
        expect(seen.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
        expect(seen.headers.authorization).toBe('Bearer sk-nano-…TAIL');
        expect(s.h.usage()[0]).toMatchObject({
            medium: 'stt',
            units: 2,
            requestId: null,
            costUsd: 0.00000666,
            costSource: 'response',
            connectionId: c.id,
        });
    });

    it('passes the text format and the segments of verbose_json through', async () => {
        const s = await stack();
        const c = await connect(s);
        const text = await transcribe(c, transcriptionForm({ model: 'Whisper-Large-V3', response_format: 'text' }));
        expect(text.headers.get('content-type')).toContain('text/plain');
        expect(await text.text()).toBe('Hello, there, friend.');
        expect(s.h.usage()[0]).toMatchObject({ units: null, costUsd: null });
        const verbose = await transcribe(
            c,
            transcriptionForm({ model: 'Whisper-Large-V3', response_format: 'verbose_json' }),
        );
        expect((await jsonOf(verbose)).segments).toHaveLength(1);
    });

    it('carries the bytes of a large recording intact', async () => {
        const s = await stack();
        const c = await connect(s);
        const file = Buffer.alloc(3 * 1024 * 1024 + 123);
        for (let i = 0; i < file.length; i += 1) file[i] = (i * 7) % 256;
        const res = await transcribe(c, transcriptionForm({ model: 'qwen/qwen3-asr-0.6b' }, file, 'big.wav'));
        expect(res.status).toBe(200);
        expect(lastSeen(s, '/v1/audio/transcriptions').body.multipart.files[0]).toMatchObject({
            filename: 'big.wav',
            bytes: file.length,
        });
    });

    it('wraps an upstream refusal in the OpenAI envelope', async () => {
        const s = await stack({ fetch: forcing(() => ({ 'x-mock-error': '402-legacy' })) });
        const c = await connect(s);
        const res = await transcribe(c, transcriptionForm({ model: 'qwen/qwen3-asr-0.6b' }));
        expect(res.status).toBe(402);
        expect((await jsonOf(res)).error.message).toBe('NanoGPT answered HTTP 402: Insufficient balance');
        expect(s.h.usage()[0]).toMatchObject({ medium: 'stt', status: 402, error: 'upstream_error' });
    });
});

/** A hand-made NanoGPT that streams audio slowly, to see the proxy relay it chunk by chunk and stop when the client does. */
async function slowAudioUpstream(chunks: number, pauseMs: number) {
    const state = { sent: 0, closedEarly: false, finished: false };
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', async () => {
            res.on('close', () => {
                if (!res.writableFinished) state.closedEarly = true;
            });
            res.writeHead(200, { 'content-type': 'audio/mpeg' });
            for (let i = 0; i < chunks && !res.destroyed; i += 1) {
                res.write(Buffer.alloc(1000, i));
                state.sent += 1;
                await sleep(pauseMs);
            }
            if (!res.destroyed) {
                res.end();
                state.finished = true;
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { state, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('streaming', () => {
    it('relays the audio as it arrives, with the upstream content type, without waiting for the end', async () => {
        const upstream = await slowAudioUpstream(6, 80);
        const h = await boot({ config: { mediaBase: upstream.origin } });
        harnesses.push(h);
        h.st.addNanoKey();
        const c = await connect({ h });
        const res = await speech(c, { model: 'Kokoro-82m', input: 'hello' });
        expect(res.headers.get('content-type')).toBe('audio/mpeg');
        expect(res.headers.get('content-length')).toBeNull();
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(first.value?.length).toBeGreaterThan(0);
        // The first bytes reached the client while the upstream was still sending.
        expect(upstream.state.finished).toBe(false);
        let total = first.value!.length;
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.length;
        }
        expect(total).toBe(6000);
        await waitFor(() => h.usage().length > 0);
        expect(h.usage()[0]).toMatchObject({ medium: 'tts', status: 200, units: 5, error: null });
    });

    it('stops the upstream when the client goes away and records it as aborted', async () => {
        const upstream = await slowAudioUpstream(200, 30);
        const h = await boot({ config: { mediaBase: upstream.origin } });
        harnesses.push(h);
        h.st.addNanoKey();
        const c = await connect({ h });
        const controller = new AbortController();
        const res = await fetch(`${c.base}/audio/speech`, {
            method: 'POST',
            headers: { ...bearer(c), 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'Kokoro-82m', input: 'hello' }),
            signal: controller.signal,
        });
        const reader = res.body!.getReader();
        await reader.read();
        controller.abort();
        await waitFor(() => upstream.state.closedEarly);
        await waitFor(() => h.usage().find((u) => u['error'] === 'client_aborted'));
        expect(h.usage()[0]).toMatchObject({ status: 499, error: 'client_aborted', costUsd: null });
        expect(upstream.state.sent).toBeLessThan(200);
    });

    it('breaks the connection when the upstream dies after the first bytes, as there is no honest status left', async () => {
        const server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'audio/mpeg' });
                res.write(Buffer.alloc(100, 1));
                setTimeout(() => res.destroy(), 40);
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers.push(server);
        const h = await boot({ config: { mediaBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } });
        harnesses.push(h);
        h.st.addNanoKey();
        const c = await connect({ h });
        const res = await speech(c, { model: 'Kokoro-82m', input: 'hello' });
        await expect(res.arrayBuffer()).rejects.toThrow();
        await waitFor(() => h.usage().length > 0);
        expect(h.usage()[0]).toMatchObject({
            medium: 'tts',
            status: 502,
            error: 'upstream_unreachable',
            costUsd: null,
        });
    });
});

describe('secrecy', () => {
    it('keeps the key and the proxy token out of every file, log line and (unmasked) mock log entry', async () => {
        const s = await stack();
        const c = await connect(s);
        await speech(c, { model: 'Kokoro-82m', input: 'x' });
        await images(c, { model: 'rev-animated', prompt: 'x' });
        await transcribe(c, transcriptionForm({ model: 'qwen/qwen3-asr-0.6b' }));
        await speech(c, { model: 'Kokoro-82m', input: 'x' }, {});
        const everything = [
            ...s.h.logs,
            userFolderText(s.h.root),
            JSON.stringify(s.mock.state.log),
            JSON.stringify(s.h.usage()),
        ].join('\n');
        expect(everything).not.toContain(NANO_KEY);
        expect(everything).not.toContain(c.token);
        expect(everything).not.toContain('0123456789abcdefghijklmnopqrstuv');
    });
});
