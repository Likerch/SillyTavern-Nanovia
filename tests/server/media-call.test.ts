/* eslint-disable @typescript-eslint/no-explicit-any */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MediaCallError,
    boundaryOf,
    buildMultipart,
    callMedia,
    contentTypeOf,
    multipartField,
    openMedia,
    openPublic,
    type MediaCallEnv,
} from '../../src/server/media-call';
import { parseByteRange } from '../../src/server/routes/media-api';
import { SecretValue } from '../../src/server/secret-value';
import { parseMultipart } from '../../tools/mock-nanogpt/lib/http.mjs';
import { cleanTempDirs, sleep } from './helpers';

const servers: http.Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    cleanTempDirs();
});

const KEY = new SecretValue('sk-nano-call-test-key-0000');

async function listen(handler: http.RequestListener): Promise<{ env: MediaCallEnv; seen: any[]; origin: string }> {
    const seen: any[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
            handler(req, res);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { env: { fetch: globalThis.fetch as any, mediaBase: `${origin}/`, version: '9.9.9' }, seen, origin };
}

describe('contentTypeOf', () => {
    it('reads the media type without parameters, and nothing odd', () => {
        expect(contentTypeOf({ 'content-type': 'audio/x-wav' })).toBe('audio/x-wav');
        expect(contentTypeOf({ 'content-type': 'Application/JSON; charset=utf-8' })).toBe('application/json');
        expect(contentTypeOf({ 'content-type': 'video/mp4 ;codecs=avc1' })).toBe('video/mp4');
        expect(contentTypeOf({})).toBeNull();
        expect(contentTypeOf({ 'content-type': 'nonsense' })).toBeNull();
        expect(contentTypeOf({ 'content-type': 'text/<script>' })).toBeNull();
    });
});

describe('multipart', () => {
    const fileBytes = Buffer.concat([
        Buffer.from([0, 1, 2, 255, 254, 13, 10, 13, 10]),
        Buffer.from('--not-the-boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\nsneaky\r\n'),
        Buffer.alloc(1000, 7),
    ]);

    it('builds a body NanoGPT can read: text fields first, the file last, bytes untouched', () => {
        const { body, contentType } = buildMultipart(
            [
                ['model', 'qwen/qwen3-asr-0.6b'],
                ['prompt', 'Привет, мир'],
            ],
            { name: 'file', filename: 'speech.wav', mime: 'audio/wav', data: fileBytes },
        );
        expect(contentType).toMatch(/^multipart\/form-data; boundary=----nanovia[0-9a-f]{24}$/);
        const parsed = parseMultipart(body, contentType) as {
            fields: Record<string, string>;
            files: { name: string; filename: string; mime: string; data: Buffer }[];
        };
        expect(parsed.fields).toEqual({ model: 'qwen/qwen3-asr-0.6b', prompt: 'Привет, мир' });
        expect(parsed.files).toHaveLength(1);
        expect(parsed.files[0]).toMatchObject({ name: 'file', filename: 'speech.wav', mime: 'audio/wav' });
        expect(parsed.files[0]?.data.equals(fileBytes)).toBe(true);
        expect(
            buildMultipart([], { name: 'f', filename: 'a', mime: 'x/y', data: Buffer.alloc(0) }).contentType,
        ).not.toBe(contentType);
    });

    it('keeps CR, LF, quotes and backslashes out of the header values', () => {
        const { body } = buildMultipart([['na"me\r\nX: y', 'v']], {
            name: 'fi\nle',
            filename: 'a"b\\c\r\n.wav',
            mime: 'audio/wav\r\nX-Evil: 1',
            data: Buffer.from('x'),
        });
        const text = body.toString('latin1');
        expect(text.split('\r\n').filter((line) => line.startsWith('X-Evil'))).toEqual([]);
        expect(text.split('\r\n').filter((line) => line.startsWith('X: y'))).toEqual([]);
        expect(text).toContain('filename="a_b_c__.wav"');
        expect(text).toContain('name="na_me__X: y"');
    });

    it('finds the boundary in a content type', () => {
        expect(boundaryOf('multipart/form-data; boundary=abc123')).toBe('abc123');
        expect(boundaryOf('multipart/form-data; boundary="a b-c"; charset=x')).toBe('a b-c');
        expect(boundaryOf('Multipart/Form-Data;boundary=----WebKitFormBoundaryX')).toBe('----WebKitFormBoundaryX');
        expect(boundaryOf('application/json; boundary=abc')).toBeNull();
        expect(boundaryOf('multipart/form-data')).toBeNull();
        expect(boundaryOf(undefined)).toBeNull();
    });

    it('reads one text field without parsing the recording, and never mistakes file content for a field', () => {
        const { body, contentType } = buildMultipart(
            [
                ['language', 'en'],
                ['model', ' qwen/qwen3-asr-0.6b '],
                ['empty', ''],
            ],
            { name: 'file', filename: 'a.wav', mime: 'audio/wav', data: fileBytes },
        );
        const boundary = boundaryOf(contentType) as string;
        expect(multipartField(body, boundary, 'model')).toBe(' qwen/qwen3-asr-0.6b ');
        expect(multipartField(body, boundary, 'language')).toBe('en');
        expect(multipartField(body, boundary, 'empty')).toBe('');
        expect(multipartField(body, boundary, 'file')).toBeNull(); // a file part is not a text field
        expect(multipartField(body, boundary, 'missing')).toBeNull();
        expect(multipartField(Buffer.from('nothing here'), boundary, 'model')).toBeNull();
        // Cut off in the middle of the headers, or of the value.
        const cut = body.subarray(0, body.indexOf('name="model"') + 5);
        expect(multipartField(cut, boundary, 'model')).toBeNull();
        const noEnd = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nabc`);
        expect(multipartField(noEnd, boundary, 'model')).toBe('abc');
        // The closing delimiter ends the search.
        const closed = Buffer.from(
            `--${boundary}--\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nx`,
        );
        expect(multipartField(closed, boundary, 'model')).toBeNull();
    });
});

describe('openMedia and callMedia', () => {
    it('joins the path to the media host, sends the key as a bearer and nothing else secret, and passes the body', async () => {
        const { env, seen } = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json', 'X-Request-ID': 'abc' });
            res.end('{"ok":true}');
        });
        const answer = await callMedia(env, KEY, {
            method: 'POST',
            path: '/v1/images/generations',
            body: '{"a":1}',
            billing: 'paygo',
            timeoutMs: 2000,
        });
        expect(answer.status).toBe(200);
        expect(answer.headers['x-request-id']).toBe('abc');
        expect(answer.body.toString()).toBe('{"ok":true}');
        expect(seen[0].url).toBe('/v1/images/generations');
        expect(seen[0].body.toString()).toBe('{"a":1}');
        expect(seen[0].headers).toMatchObject({
            authorization: 'Bearer sk-nano-call-test-key-0000',
            accept: 'application/json',
            'accept-encoding': 'identity',
            'user-agent': 'Nanovia/9.9.9',
            'content-type': 'application/json',
            'x-billing-mode': 'paygo',
        });
        await callMedia(env, KEY, {
            method: 'GET',
            path: '/api/v1/x',
            timeoutMs: 2000,
            accept: '*/*',
            billing: 'auto',
        });
        expect(seen[1].headers['content-type']).toBeUndefined();
        expect(seen[1].headers['x-billing-mode']).toBeUndefined();
        expect(seen[1].headers.accept).toBe('*/*');
        const bytes = await callMedia(env, KEY, {
            method: 'POST',
            path: '/up',
            body: new Uint8Array([1, 2, 3]),
            contentType: 'multipart/form-data; boundary=x',
            timeoutMs: 2000,
        });
        expect(bytes.status).toBe(200);
        expect([...seen[2].body]).toEqual([1, 2, 3]);
        expect(seen[2].headers['content-type']).toBe('multipart/form-data; boundary=x');
    });

    it('fails with `timeout` when nothing arrives in time, even if the transport ignores its signal', async () => {
        const { env } = await listen(() => {
            // never answers
        });
        await expect(callMedia(env, KEY, { method: 'GET', path: '/slow', timeoutMs: 80 })).rejects.toMatchObject({
            kind: 'timeout',
        });
        const stuck: MediaCallEnv = { ...env, fetch: (() => new Promise(() => {})) as any };
        await expect(callMedia(stuck, KEY, { method: 'GET', path: '/x', timeoutMs: 40 })).rejects.toMatchObject({
            kind: 'timeout',
        });
    });

    it('fails with `timeout` when the body stalls, and restarts the timer on every chunk', async () => {
        const { env } = await listen((_req, res) => {
            res.writeHead(200);
            res.write('a');
            setTimeout(() => res.write('b'), 60);
            setTimeout(() => res.end('c'), 120);
        });
        const steady = await callMedia(env, KEY, { method: 'GET', path: '/steady', timeoutMs: 100 });
        expect(steady.body.toString()).toBe('abc'); // 120 ms in all, but never 100 ms of silence
        const stall = await listen((_req, res) => {
            res.writeHead(200);
            res.write('a');
        });
        await expect(callMedia(stall.env, KEY, { method: 'GET', path: '/stall', timeoutMs: 80 })).rejects.toMatchObject(
            { kind: 'timeout' },
        );
    });

    it('fails with `unreachable` and the transport code, and `aborted` when the caller goes away', async () => {
        const down: MediaCallEnv = {
            fetch: (() =>
                Promise.reject(
                    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }),
                )) as any,
            mediaBase: 'http://127.0.0.1:9',
            version: 't',
        };
        const error = (await callMedia(down, KEY, { method: 'GET', path: '/x', timeoutMs: 500 }).catch(
            (e) => e,
        )) as MediaCallError;
        expect(error).toBeInstanceOf(MediaCallError);
        expect(error).toMatchObject({ kind: 'unreachable', code: 'ECONNREFUSED' });
        expect(error.message).not.toContain('127.0.0.1');
        const { env } = await listen(() => {});
        const controller = new AbortController();
        const pending = openMedia(env, KEY, { method: 'GET', path: '/x', timeoutMs: 5000, signal: controller.signal });
        setTimeout(() => controller.abort(), 30);
        await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
        await expect(
            openMedia(env, KEY, { method: 'GET', path: '/x', timeoutMs: 5000, signal: controller.signal }),
        ).rejects.toMatchObject({
            kind: 'aborted',
        });
    });

    it('turns a connection that breaks in the middle of the body into `unreachable`, and a client abort into `aborted`', async () => {
        const broken = await listen((_req, res) => {
            res.writeHead(200, { 'content-length': '100' });
            res.write('abc');
            setTimeout(() => res.destroy(), 20);
        });
        await expect(callMedia(broken.env, KEY, { method: 'GET', path: '/x', timeoutMs: 2000 })).rejects.toMatchObject({
            kind: 'unreachable',
        });
        const slow = await listen((_req, res) => {
            res.writeHead(200);
            res.write('abc');
        });
        const controller = new AbortController();
        const handle = await openMedia(slow.env, KEY, {
            method: 'GET',
            path: '/x',
            timeoutMs: 5000,
            signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 30);
        await expect(
            (async () => {
                for await (const chunk of handle.body) void chunk;
            })(),
        ).rejects.toMatchObject({ kind: 'aborted' });
        handle.close();
    });

    it('stops reading and fails with `too_large` past the cap', async () => {
        const { env } = await listen((_req, res) => {
            res.writeHead(200);
            res.end(Buffer.alloc(5000, 1));
        });
        await expect(callMedia(env, KEY, { method: 'GET', path: '/big', timeoutMs: 2000 }, 1000)).rejects.toMatchObject(
            { kind: 'too_large' },
        );
        expect((await callMedia(env, KEY, { method: 'GET', path: '/big', timeoutMs: 2000 }, 5000)).body.length).toBe(
            5000,
        );
    });

    it('close() aborts an unfinished body and is idempotent; touch() after close does nothing', async () => {
        const { env } = await listen((_req, res) => {
            res.writeHead(200);
            res.write('abc');
        });
        const handle = await openMedia(env, KEY, { method: 'GET', path: '/x', timeoutMs: 5000 });
        handle.close();
        handle.close();
        handle.touch();
        await sleep(10);
        await expect(
            (async () => {
                for await (const chunk of handle.body) void chunk;
            })(),
        ).rejects.toBeInstanceOf(MediaCallError);
    });
});

describe('openPublic', () => {
    it('opens a link NanoGPT gave WITHOUT the key, resolving a path against the media host', async () => {
        const { env, seen, origin } = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'video/mp4' });
            res.end('data');
        });
        const handle = await openPublic(env, '/api/generate-video/content?runId=x&sig=y', 2000);
        expect(handle.status).toBe(200);
        const chunks: Buffer[] = [];
        for await (const chunk of handle.body) chunks.push(Buffer.from(chunk));
        handle.close();
        expect(Buffer.concat(chunks).toString()).toBe('data');
        expect(seen[0].url).toBe('/api/generate-video/content?runId=x&sig=y');
        expect(seen[0].headers.authorization).toBeUndefined();
        expect(seen[0].headers['user-agent']).toBe('Nanovia/9.9.9');
        const absolute = await openPublic(env, `${origin}/abs`, 2000);
        absolute.close();
        expect(seen[1].url).toBe('/abs');
        expect(seen[1].headers.authorization).toBeUndefined();
    });

    it('refuses other schemes and links that are not links', async () => {
        const { env } = await listen(() => {});
        for (const url of ['file:///etc/passwd', 'ftp://x/y', 'javascript:alert(1)', 'http://']) {
            await expect(openPublic(env, url, 500), url).rejects.toMatchObject({ kind: 'unreachable', code: 'EINVAL' });
        }
        const aborted = new AbortController();
        aborted.abort();
        await expect(openPublic(env, '/x', 500, aborted.signal)).rejects.toMatchObject({ kind: 'aborted' });
    });
});

describe('parseByteRange', () => {
    const size = 1000;
    it('honours the three single-range forms and clamps the end', () => {
        expect(parseByteRange('bytes=0-99', size)).toEqual({ kind: 'partial', start: 0, end: 99 });
        expect(parseByteRange('bytes=900-', size)).toEqual({ kind: 'partial', start: 900, end: 999 });
        expect(parseByteRange('bytes=-100', size)).toEqual({ kind: 'partial', start: 900, end: 999 });
        expect(parseByteRange('bytes=-5000', size)).toEqual({ kind: 'partial', start: 0, end: 999 });
        expect(parseByteRange('bytes=990-5000', size)).toEqual({ kind: 'partial', start: 990, end: 999 });
        expect(parseByteRange('BYTES=5-5', size)).toEqual({ kind: 'partial', start: 5, end: 5 });
        expect(parseByteRange('  bytes=1-2  ', size)).toEqual({ kind: 'partial', start: 1, end: 2 });
    });

    it('says unsatisfiable when it starts past the end or asks for nothing at the end', () => {
        expect(parseByteRange('bytes=1000-', size)).toEqual({ kind: 'unsatisfiable' });
        expect(parseByteRange('bytes=2000-3000', size)).toEqual({ kind: 'unsatisfiable' });
        expect(parseByteRange('bytes=-0', size)).toEqual({ kind: 'unsatisfiable' });
        expect(parseByteRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
        expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    });

    it('ignores what it does not understand', () => {
        for (const header of [
            undefined,
            '',
            'bytes=-',
            'bytes=a-b',
            'items=0-5',
            'bytes=0-5,10-20',
            'bytes=9-3',
            'bytes 0-5',
        ]) {
            expect(parseByteRange(header, size), String(header)).toEqual({ kind: 'full' });
        }
    });
});
