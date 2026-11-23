import { describe, expect, it } from 'vitest';
import {
    applyUsageAdjustments,
    base64ByteLength,
    buildMediaUsageRecord,
    cleanText,
    formatUsd,
    imageMimeFromName,
    isBase64,
    mapVideoStatus,
    mediaFailure,
    parseBillingLookup,
    parseImageBody,
    parseSttBody,
    parseUsageAdjustment,
    parseVideoStatus,
    parseVideoSubmit,
    sniffImageMime,
    splitDataUrl,
    type MediaUsageArgs,
    type UsageAdjustment,
} from '../../src/domain/media-wire';
import { summarizeUsage } from '../../src/domain/usage';
import type { UsageRecord } from '../../src/shared/contracts';

// 1x1 PNG, a tiny JPEG header, GIF and WebP headers (only the first bytes matter to the sniffer).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBD';
const GIF_B64 = 'R0lGODlhAQABAAAAACw=';
const WEBP_B64 = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA';

describe('base64 and file-type helpers', () => {
    it('strips a data URL prefix and reports its mime', () => {
        expect(splitDataUrl(`data:image/PNG;base64,${PNG_B64}`)).toEqual({ base64: PNG_B64, mime: 'image/png' });
        expect(splitDataUrl('data:;base64,AAAA')).toEqual({ base64: 'AAAA', mime: null });
        expect(splitDataUrl('data:text/plain;charset=utf-8;base64,QQ==')).toEqual({
            base64: 'QQ==',
            mime: 'text/plain',
        });
        expect(splitDataUrl('QUJD')).toEqual({ base64: 'QUJD', mime: null });
        expect(splitDataUrl('data:image/png,notbase64')).toEqual({ base64: 'data:image/png,notbase64', mime: null });
    });

    it('computes the decoded length without decoding', () => {
        expect(base64ByteLength('')).toBe(0);
        expect(base64ByteLength('QQ==')).toBe(1);
        expect(base64ByteLength('QUI=')).toBe(2);
        expect(base64ByteLength('QUJD')).toBe(3);
        expect(base64ByteLength('QUJD\n')).toBe(3);
        expect(base64ByteLength(PNG_B64)).toBe(Buffer.from(PNG_B64, 'base64').length);
    });

    it('recognises plain base64', () => {
        expect(isBase64('QUJD')).toBe(true);
        expect(isBase64('QQ==\n')).toBe(true);
        expect(isBase64('QU JD\n')).toBe(true);
        expect(isBase64('')).toBe(false);
        expect(isBase64('not base64!')).toBe(false);
        expect(isBase64('QQ=A')).toBe(false);
        expect(isBase64('data:x;base64,QQ==')).toBe(false);
    });

    it('sniffs the image type from the first bytes', () => {
        expect(sniffImageMime(PNG_B64)).toBe('image/png');
        expect(sniffImageMime(JPEG_B64)).toBe('image/jpeg');
        expect(sniffImageMime(GIF_B64)).toBe('image/gif');
        expect(sniffImageMime(WEBP_B64)).toBe('image/webp');
        expect(sniffImageMime('QUJDREVGR0hJSktM')).toBeNull();
        expect(sniffImageMime('')).toBeNull();
        expect(sniffImageMime('!!!')).toBeNull();
    });

    it('reads the image type from a name or URL', () => {
        expect(imageMimeFromName('https://x.test/a/b.PNG?sig=1')).toBe('image/png');
        expect(imageMimeFromName('pic.jpg')).toBe('image/jpeg');
        expect(imageMimeFromName('pic.jpeg#frag')).toBe('image/jpeg');
        expect(imageMimeFromName('a.webp')).toBe('image/webp');
        expect(imageMimeFromName('a.svg')).toBe('image/svg+xml');
        expect(imageMimeFromName('a.bin')).toBeNull();
        expect(imageMimeFromName('png')).toBeNull();
    });

    it('formats USD without exponents', () => {
        expect(formatUsd(0.00000666)).toBe('0.00000666');
        expect(formatUsd(0.0017)).toBe('0.0017');
        expect(formatUsd(5)).toBe('5');
        expect(formatUsd(0)).toBe('0');
        expect(formatUsd(0.1 + 0.2)).toBe('0.3');
        expect(formatUsd(1e-12)).toBe('0');
    });

    it('cleans text to one line without markup or control characters', () => {
        expect(cleanText('  a\n\tb <b>c</b>\u0007d  ')).toBe('a b c d');
        expect(cleanText('x'.repeat(500))).toHaveLength(300);
        expect(cleanText('abcdef', 3)).toBe('abc');
    });
});

describe('parseImageBody', () => {
    it('reads the live answer shape (b64_json, cost, paymentSource, remainingBalance, requestId)', () => {
        const parsed = parseImageBody({
            created: 1795000000,
            data: [{ b64_json: PNG_B64 }],
            cost: 0.0017,
            paymentSource: 'USD',
            remainingBalance: 4.98,
            requestId: 'media-image:abc:1795000000000:xyz',
        });
        expect(parsed).toEqual({
            outputs: [{ dataBase64: PNG_B64 }],
            usd: 0.0017,
            paymentSource: 'USD',
            remainingUsd: 4.98,
            requestId: 'media-image:abc:1795000000000:xyz',
            created: 1795000000,
        });
    });

    it('handles url outputs, mixed lists, data URLs and nested image_url', () => {
        const parsed = parseImageBody({
            data: [
                { url: 'https://cdn.test/a.png' },
                { b64_json: `data:image/jpeg;base64,${JPEG_B64}` },
                { image_url: { url: 'https://cdn.test/b.png' } },
                { image_url: 'https://cdn.test/c.png' },
                { b64: PNG_B64 },
                { base64: GIF_B64 },
                { nothing: true },
                'junk',
                { b64_json: 'data:image/png;base64,' },
            ],
        });
        expect(parsed.outputs).toEqual([
            { url: 'https://cdn.test/a.png' },
            { dataBase64: JPEG_B64, mime: 'image/jpeg' },
            { url: 'https://cdn.test/b.png' },
            { url: 'https://cdn.test/c.png' },
            { dataBase64: PNG_B64 },
            { dataBase64: GIF_B64 },
        ]);
    });

    it('takes decimal strings and snake_case aliases, and ignores a figure in another currency', () => {
        expect(
            parseImageBody({
                data: [],
                cost: '0.002',
                request_id: 'r',
                remaining_balance: '3.5',
                payment_source: 'USD',
            }),
        ).toMatchObject({
            usd: 0.002,
            requestId: 'r',
            remainingUsd: 3.5,
            paymentSource: 'USD',
        });
        expect(parseImageBody({ data: [], cost: 0.5, paymentSource: 'XNO', remainingBalance: 2 })).toMatchObject({
            usd: null,
            remainingUsd: null,
            paymentSource: 'XNO',
        });
        expect(parseImageBody({ data: [], cost: 0, paymentSource: 'XNO' }).usd).toBe(0);
        expect(parseImageBody({ data: [], cost: -1 }).usd).toBeNull();
    });

    it('gives an empty result for anything that is not an object', () => {
        for (const junk of [null, 'x', 3, [], undefined]) {
            expect(parseImageBody(junk)).toMatchObject({ outputs: [], usd: null, requestId: null, created: null });
        }
        expect(parseImageBody({ data: 'x' }).outputs).toEqual([]);
    });
});

describe('parseSttBody', () => {
    it('reads the live OpenAI-compatible answer', () => {
        expect(
            parseSttBody({
                text: 'Hello, there, friend.',
                language: 'auto-detect',
                duration: 2,
                usage: { seconds: 2, type: 'duration', cost: 0.00000666, currency: 'USD' },
            }),
        ).toEqual({
            text: 'Hello, there, friend.',
            language: 'auto-detect',
            durationSec: 2,
            segments: [],
            usd: 0.00000666,
            currency: 'USD',
        });
    });

    it('reads the native answer with metadata (minutes become seconds)', () => {
        expect(
            parseSttBody({
                transcription: ' Good evening. ',
                metadata: { cost: '0.0102', currency: 'usd', actualDuration: 1.5, chargedDuration: 2, language: 'en' },
            }),
        ).toMatchObject({ text: 'Good evening.', language: 'en', durationSec: 90, usd: 0.0102, currency: 'USD' });
        expect(parseSttBody({ transcript: 'x', metadata: { chargedDuration: 2 } })).toMatchObject({ durationSec: 120 });
    });

    it('prefers diarization segments, falls back to segments, and tolerates odd items', () => {
        const diarized = parseSttBody({
            text: 'a b',
            segments: [{ start: 0, end: 1, text: 'plain' }],
            diarization: {
                segments: [
                    { speaker: 'S1', text: 'a', start: 0, end: 1 },
                    { speaker_id: 'S2', text: 'b' },
                    { text: '' },
                    5,
                ],
            },
        });
        expect(diarized?.segments).toEqual([
            { start: 0, end: 1, text: 'a', speaker: 'S1' },
            { start: null, end: null, text: 'b', speaker: 'S2' },
        ]);
        expect(
            parseSttBody({ text: 'a', segments: [{ start: 0, end: 2.5, text: 'a', speaker: 'X' }, null] })?.segments,
        ).toEqual([{ start: 0, end: 2.5, text: 'a', speaker: 'X' }]);
        expect(parseSttBody({ text: 'a', segments: 'nope' })?.segments).toEqual([]);
    });

    it('treats a bare string as the transcript and anything without text as none', () => {
        expect(parseSttBody(' just text \n')).toMatchObject({ text: 'just text', usd: null, durationSec: null });
        expect(parseSttBody({ language: 'en' })).toBeNull();
        expect(parseSttBody(null)).toBeNull();
        expect(parseSttBody([])).toBeNull();
        expect(parseSttBody({ text: 'x', usage: { cost: 0.4, currency: 'XNO' } })?.usd).toBeNull();
        expect(parseSttBody({ text: 'x', cost: 0.5 })?.usd).toBe(0.5);
    });
});

describe('video submit and status', () => {
    it('reads the submit answer', () => {
        expect(
            parseVideoSubmit({
                runId: 'vid_abc',
                id: 'vid_abc',
                status: 'pending',
                cost: 0.35,
                paymentSource: 'USD',
                remainingBalance: 4.1,
                prechargeLabel: 'x',
            }),
        ).toEqual({ runId: 'vid_abc', usd: 0.35, paymentSource: 'USD', remainingUsd: 4.1 });
        expect(parseVideoSubmit({ id: 'vid_x' }).runId).toBe('vid_x');
        expect(parseVideoSubmit({ requestId: 'vid_y' }).runId).toBe('vid_y');
        expect(parseVideoSubmit({ runId: 'v', cost: 1, paymentSource: 'XNO' }).usd).toBeNull();
        expect(parseVideoSubmit('x')).toEqual({ runId: null, usd: null, paymentSource: null, remainingUsd: null });
    });

    it('maps the status words of both spellings', () => {
        const table: [string, ReturnType<typeof mapVideoStatus>][] = [
            ['IN_QUEUE', 'queued'],
            ['queued', 'queued'],
            ['pending', 'queued'],
            ['IN_PROGRESS', 'running'],
            ['processing', 'running'],
            ['generating', 'running'],
            ['delivering', 'running'],
            ['COMPLETED', 'completed'],
            ['completed', 'completed'],
            ['FAILED', 'failed'],
            ['CANCELED', 'failed'],
            ['cancelled', 'failed'],
            ['timed_out', 'failed'],
            ['expired', 'expired'],
            [' In-Progress ', 'running'],
            ['something new', null],
            ['', null],
        ];
        for (const [word, expected] of table) expect(mapVideoStatus(word), word).toBe(expected);
        expect(mapVideoStatus(undefined)).toBeNull();
        expect(mapVideoStatus(3)).toBeNull();
    });

    it('reads the guide shape (uppercase data.status, data.output.video.url, data.cost)', () => {
        expect(parseVideoStatus({ requestId: 'vid_a', model: 'm', data: { status: 'IN_QUEUE' } })).toEqual({
            status: 'queued',
            progress: null,
            url: null,
            error: null,
            usd: null,
        });
        expect(
            parseVideoStatus({
                requestId: 'vid_a',
                data: {
                    status: 'COMPLETED',
                    output: { video: { url: 'https://cdn.test/v.mp4' }, expiresAt: '2026-11-25T00:00:00Z' },
                    cost: 0.42,
                },
            }),
        ).toEqual({ status: 'completed', progress: null, url: 'https://cdn.test/v.mp4', error: null, usd: 0.42 });
        expect(
            parseVideoStatus({ data: { status: 'FAILED', error: 'Boom <b>bad</b>', isNSFWError: false } }),
        ).toMatchObject({
            status: 'failed',
            error: 'Boom bad',
        });
        expect(
            parseVideoStatus({ data: { status: 'FAILED', userFriendlyError: 'Try another prompt', error: 'raw' } })
                .error,
        ).toBe('Try another prompt');
        expect(parseVideoStatus({ data: { status: 'FAILED', error: { message: 'nested' } } }).error).toBe('nested');
    });

    it('reads the flat OpenAPI shape (lowercase status, progress 0-100, videoUrl)', () => {
        expect(parseVideoStatus({ requestId: 'vid_a', status: 'processing', progress: 40, videoUrl: null })).toEqual({
            status: 'running',
            progress: 0.4,
            url: null,
            error: null,
            usd: null,
        });
        expect(
            parseVideoStatus({ status: 'completed', progress: 100, videoUrl: 'https://cdn.test/v.mp4', cost: '0.5' }),
        ).toEqual({
            status: 'completed',
            progress: 1,
            url: 'https://cdn.test/v.mp4',
            error: null,
            usd: 0.5,
        });
        expect(parseVideoStatus({ status: 'cancelled' })).toMatchObject({
            status: 'failed',
            error: 'The job was canceled',
        });
        expect(parseVideoStatus({ status: 'timed_out' })).toMatchObject({
            status: 'failed',
            error: 'The job timed out',
        });
        expect(parseVideoStatus({ status: 'failed' })).toMatchObject({ status: 'failed', error: 'The job failed' });
        expect(parseVideoStatus({ status: 'failed', error: 'plain' }).error).toBe('plain');
    });

    it('reads progress as a percent or a fraction and ignores bad values', () => {
        const progress = (value: unknown) => parseVideoStatus({ status: 'processing', progress: value }).progress;
        expect(progress(0)).toBe(0);
        expect(progress(50)).toBe(0.5);
        expect(progress(0.5)).toBe(0.5);
        expect(progress(1)).toBe(0.01);
        expect(progress(250)).toBe(1);
        expect(progress(-3)).toBeNull();
        expect(progress('half')).toBeNull();
        expect(parseVideoStatus({ status: 'processing', data: { progress: 20 } }).progress).toBe(0.2);
    });

    it('finds the url in every spelling and ignores non-http values', () => {
        for (const body of [
            { status: 'completed', videoUrl: 'https://a.test/v.mp4' },
            { status: 'completed', video_url: 'https://a.test/v.mp4' },
            { status: 'completed', output: { url: 'https://a.test/v.mp4' } },
            { status: 'completed', video: { url: 'https://a.test/v.mp4' } },
            { data: { status: 'COMPLETED', output: { video: { url: 'https://a.test/v.mp4' } } } },
            { data: { status: 'COMPLETED', videoUrl: 'https://a.test/v.mp4' } },
            { data: { status: 'COMPLETED' }, videoUrl: 'https://a.test/v.mp4' },
        ]) {
            expect(parseVideoStatus(body).url, JSON.stringify(body)).toBe('https://a.test/v.mp4');
        }
        // A path on the media host is fine (the plugin resolves it); a scheme-relative URL or any other scheme is not.
        expect(parseVideoStatus({ status: 'completed', videoUrl: '/api/generate-video/content?runId=x' }).url).toBe(
            '/api/generate-video/content?runId=x',
        );
        expect(parseVideoStatus({ status: 'completed', videoUrl: '//evil.test/v.mp4' }).url).toBeNull();
        expect(parseVideoStatus({ status: 'completed', videoUrl: 'file:///etc/passwd' }).url).toBeNull();
        expect(parseVideoStatus({ status: 'completed', videoUrl: 'javascript:alert(1)' }).url).toBeNull();
    });

    it('calls a url without a recognised status completed, and leaves unknown words alone', () => {
        expect(parseVideoStatus({ videoUrl: 'https://a.test/v.mp4' }).status).toBe('completed');
        expect(parseVideoStatus({ status: 'mystery', videoUrl: 'https://a.test/v.mp4' }).status).toBe('completed');
        expect(parseVideoStatus({ status: 'mystery' }).status).toBeNull();
        expect(parseVideoStatus({}).status).toBeNull();
        expect(parseVideoStatus(null)).toEqual({ status: null, progress: null, url: null, error: null, usd: null });
        expect(parseVideoStatus('x').status).toBeNull();
        expect(parseVideoStatus({ status: 'completed', paymentSource: 'XNO', cost: 1 }).usd).toBeNull();
    });
});

describe('mediaFailure', () => {
    it('reads the OpenAI envelope', () => {
        expect(
            mediaFailure(
                400,
                JSON.stringify({ error: { message: 'Bad size', type: 'invalid_request_error', code: 'invalid_size' } }),
            ),
        ).toEqual({
            status: 502,
            code: 'upstream_error',
            message: 'NanoGPT answered HTTP 400: Bad size',
        });
        expect(mediaFailure(500, JSON.stringify({ error: { message: 'x', code: 42 } })).code).toBe('upstream_error');
    });

    it('reads the legacy error string, its required balance and its code', () => {
        expect(
            mediaFailure(402, JSON.stringify({ error: 'Insufficient balance', requiredBalance: 0.0035, status: 402 })),
        ).toEqual({
            status: 402,
            code: 'insufficient_balance',
            message: 'Insufficient balance (NanoGPT asks for 0.0035 USD): Insufficient balance',
        });
        expect(
            mediaFailure(402, JSON.stringify({ error: { message: 'Need funds', type: 'INSUFFICIENT_BALANCE' } }))
                .message,
        ).toBe('Insufficient balance: Need funds');
        expect(mediaFailure(404, JSON.stringify({ error: 'TTS run not found', code: 'TTS_RUN_NOT_FOUND' }))).toEqual({
            status: 502,
            code: 'upstream_error',
            message: 'NanoGPT answered HTTP 404: TTS run not found',
        });
        expect(mediaFailure(402, '{}').message).toBe('Insufficient balance');
        expect(mediaFailure(500, JSON.stringify({ message: 'top level' })).message).toBe(
            'NanoGPT answered HTTP 500: top level',
        );
    });

    it('reads plain text and HTML, never throwing on a body that is not JSON', () => {
        expect(mediaFailure(401, 'Invalid session')).toEqual({
            status: 502,
            code: 'upstream_error',
            message: 'NanoGPT rejected the key (HTTP 401): Invalid session',
        });
        expect(mediaFailure(403, '').message).toBe('NanoGPT rejected the key (HTTP 403)');
        expect(mediaFailure(502, '<html><body><h1>Bad Gateway</h1></body></html>').message).toBe(
            'NanoGPT answered HTTP 502: Bad Gateway',
        );
        expect(mediaFailure(500, '[1,2]').message).toBe('NanoGPT answered HTTP 500: [1,2]');
    });

    it('maps the contract codes', () => {
        expect(
            mediaFailure(400, JSON.stringify({ error: { message: 'Blocked', code: 'content_policy_violation' } })),
        ).toEqual({
            status: 400,
            code: 'content_policy_violation',
            message: 'NanoGPT refused the prompt (content policy): Blocked',
        });
        expect(
            mediaFailure(400, JSON.stringify({ error: { message: 'Your prompt violates our content policy.' } })).code,
        ).toBe('content_policy_violation');
        expect(mediaFailure(400, JSON.stringify({ error: { type: 'CONTENT_POLICY_VIOLATION' } })).message).toBe(
            'NanoGPT refused the prompt (content policy)',
        );
        expect(
            mediaFailure(429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Slow down' } })),
        ).toEqual({
            status: 429,
            code: 'rate_limited',
            message: 'NanoGPT is rate limiting this key: Slow down',
        });
        expect(mediaFailure(400, JSON.stringify({ error: { code: 'rate_limit_exceeded' } })).code).toBe('rate_limited');
        expect(mediaFailure(429, '').message).toBe('NanoGPT is rate limiting this key');
        expect(mediaFailure(413, 'too big')).toEqual({
            status: 413,
            code: 'payload_too_large',
            message: 'NanoGPT refused the size of the request: too big',
        });
        expect(mediaFailure(413, '').message).toBe('NanoGPT refused the size of the request');
        expect(mediaFailure(408, '')).toEqual({
            status: 504,
            code: 'upstream_timeout',
            message: 'NanoGPT did not answer in time',
        });
        expect(mediaFailure(504, 'gateway').message).toBe('NanoGPT did not answer in time: gateway');
        // A policy hit on another status stays an upstream error unless the label says policy.
        expect(mediaFailure(500, 'content policy').code).toBe('upstream_error');
    });
});

describe('parseBillingLookup', () => {
    it('reads the live lookup answer', () => {
        expect(
            parseBillingLookup({
                object: 'request_billing',
                request_id: 'media-image:x',
                cost: '0.00255',
                currency: 'USD',
                cost_scope: 'primary_charge',
                usage: { input_tokens: 0 },
            }),
        ).toEqual({ usd: 0.00255, currency: 'USD' });
        expect(parseBillingLookup({ cost: '0.5', currency: 'xno' })).toEqual({ usd: null, currency: 'XNO' });
        expect(parseBillingLookup({ cost: '0.5' })).toEqual({ usd: 0.5, currency: null });
        expect(parseBillingLookup({ cost: 'lots' })).toEqual({ usd: null, currency: null });
        expect(parseBillingLookup(null)).toEqual({ usd: null, currency: null });
    });
});

describe('buildMediaUsageRecord', () => {
    const base: MediaUsageArgs = {
        medium: 'image',
        model: 'rev-animated',
        at: 1000,
        connectionId: 'conn1234',
        requestId: 'media-image:1',
        units: 2,
        usd: 0.0034,
        costSource: 'response',
        paymentSource: 'USD',
        latencyMs: 4200,
        status: 200,
        error: null,
    };

    it('writes a paygo record with units, the cost source and no tokens', () => {
        expect(buildMediaUsageRecord(base)).toEqual({
            at: 1000,
            connectionId: 'conn1234',
            requestId: 'media-image:1',
            model: 'rev-animated',
            billing: 'paygo',
            costUsd: 0.0034,
            equivalentUsd: 0.0034,
            promptTokens: null,
            completionTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
            latencyMs: 4200,
            status: 200,
            stream: false,
            consumer: 'unknown',
            error: null,
            medium: 'image',
            units: 2,
            costSource: 'response',
        });
    });

    it('calls a zero cost under a subscription source a subscription request', () => {
        expect(buildMediaUsageRecord({ ...base, usd: 0, paymentSource: 'Subscription (daily)' })).toMatchObject({
            billing: 'subscription',
            costUsd: 0,
            equivalentUsd: null,
        });
        expect(buildMediaUsageRecord({ ...base, usd: 0, paymentSource: 'USD' })).toMatchObject({
            billing: 'unknown',
            costUsd: 0,
        });
        expect(buildMediaUsageRecord({ ...base, usd: 0, paymentSource: null }).billing).toBe('unknown');
    });

    it('keeps no cost for a failed call or an unknown figure', () => {
        expect(buildMediaUsageRecord({ ...base, status: 402, error: 'insufficient_balance' })).toMatchObject({
            costUsd: null,
            costSource: 'unknown',
            billing: 'unknown',
            equivalentUsd: null,
            error: 'insufficient_balance',
        });
        expect(buildMediaUsageRecord({ ...base, status: 500, error: null })).toMatchObject({ costUsd: null });
        expect(buildMediaUsageRecord({ ...base, usd: null, costSource: 'estimate' })).toMatchObject({
            costUsd: null,
            costSource: 'unknown',
        });
        expect(buildMediaUsageRecord({ ...base, latencyMs: -5 }).latencyMs).toBe(0);
    });
});

const record = (over: Partial<UsageRecord>): UsageRecord => ({
    at: 1000,
    connectionId: null,
    requestId: null,
    model: 'm',
    billing: 'paygo',
    costUsd: 0.0017,
    equivalentUsd: 0.0017,
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    latencyMs: 1,
    status: 200,
    stream: false,
    consumer: 'unknown',
    error: null,
    medium: 'image',
    units: 1,
    costSource: 'response',
    ...over,
});

const adjustment = (over: Partial<UsageAdjustment>): UsageAdjustment => ({
    adjust: true,
    requestId: 'r1',
    costUsd: 0.00255,
    costSource: 'lookup',
    at: 5000,
    ...over,
});

describe('usage adjustments', () => {
    it('parses an adjust line and rejects what is not one', () => {
        expect(
            parseUsageAdjustment({ adjust: true, requestId: 'r1', costUsd: 0.5, costSource: 'lookup', at: 9 }),
        ).toEqual({
            adjust: true,
            requestId: 'r1',
            costUsd: 0.5,
            costSource: 'lookup',
            at: 9,
        });
        expect(parseUsageAdjustment({ adjust: true, requestId: 'r1', costUsd: '0.25', at: 9 })).toMatchObject({
            costUsd: 0.25,
            costSource: 'lookup',
        });
        expect(
            parseUsageAdjustment({ adjust: true, requestId: 'r1', costUsd: 0.1, costSource: 'weird', at: 9 })
                ?.costSource,
        ).toBe('lookup');
        for (const bad of [
            null,
            'x',
            {},
            { requestId: 'r', costUsd: 1, at: 1 },
            { adjust: false, requestId: 'r', costUsd: 1, at: 1 },
            { adjust: true, costUsd: 1, at: 1 },
            { adjust: true, requestId: ' ', costUsd: 1, at: 1 },
            { adjust: true, requestId: 'r', costUsd: null, at: 1 },
            { adjust: true, requestId: 'r', costUsd: -1, at: 1 },
            { adjust: true, requestId: 'r', costUsd: 1 },
        ]) {
            expect(parseUsageAdjustment(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it('corrects the cost of the matching record only, without mutating anything', () => {
        const a = record({ requestId: 'r1' });
        const b = record({ requestId: 'r2' });
        const c = record({ requestId: null });
        const chat = record({
            requestId: 'r1',
            medium: undefined,
            units: undefined,
            costSource: undefined,
            equivalentUsd: 0.5,
        });
        const input = [a, b, c];
        const out = applyUsageAdjustments(input, [adjustment({})]);
        expect(out[0]).toMatchObject({ costUsd: 0.00255, equivalentUsd: 0.00255, costSource: 'lookup' });
        expect(out[1]).toBe(b);
        expect(out[2]).toBe(c);
        expect(a.costUsd).toBe(0.0017);
        expect(input).toHaveLength(3);
        // A record without a medium (chat) takes the figure but keeps its own equivalent.
        expect(applyUsageAdjustments([chat], [adjustment({})])[0]).toMatchObject({
            costUsd: 0.00255,
            equivalentUsd: 0.5,
        });
    });

    it('lets the latest adjustment win, in time order and then file order', () => {
        const out = applyUsageAdjustments(
            [record({ requestId: 'r1' })],
            [
                adjustment({ costUsd: 3, at: 9000 }),
                adjustment({ costUsd: 1, at: 7000 }),
                adjustment({ costUsd: 2, at: 9000 }),
            ],
        );
        expect(out[0]?.costUsd).toBe(2);
    });

    it('turns an unknown billing outcome into paygo for a positive figure and leaves the rest', () => {
        const unknown = record({ requestId: 'r1', billing: 'unknown', costUsd: null, equivalentUsd: null });
        expect(applyUsageAdjustments([unknown], [adjustment({})])[0]).toMatchObject({
            billing: 'paygo',
            equivalentUsd: 0.00255,
        });
        expect(applyUsageAdjustments([unknown], [adjustment({ costUsd: 0 })])[0]).toMatchObject({
            billing: 'unknown',
            equivalentUsd: null,
        });
        const subscription = record({ requestId: 'r1', billing: 'subscription', costUsd: 0, equivalentUsd: null });
        expect(applyUsageAdjustments([subscription], [adjustment({ costUsd: 0.2 })])[0]).toMatchObject({
            billing: 'subscription',
            equivalentUsd: null,
        });
    });

    it('returns a copy when there is nothing to apply', () => {
        const list = [record({})];
        const out = applyUsageAdjustments(list, []);
        expect(out).toEqual(list);
        expect(out).not.toBe(list);
    });
});

describe('summarizeUsage: byMedium', () => {
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    const range = { from: 0, to: 10_000 };

    it('is absent for a log without media records, so chat sums exactly as before', () => {
        const chat = record({ medium: undefined, units: undefined, costSource: undefined });
        const summary = summarizeUsage([chat, { ...chat, at: 2000 }], range, day);
        expect(summary.byMedium).toBeUndefined();
        expect('byMedium' in summary).toBe(false);
        const explicit = summarizeUsage([{ ...chat, medium: 'chat' }], range, day);
        expect(explicit.byMedium).toBeUndefined();
    });

    it('breaks down by medium, chat included, ordered by real cost', () => {
        const chat = record({
            medium: undefined,
            costUsd: 0.5,
            equivalentUsd: 0.5,
            promptTokens: 10,
            completionTokens: 5,
        });
        const image = record({ medium: 'image', costUsd: 0.2, equivalentUsd: 0.2 });
        const tts = record({ medium: 'tts', costUsd: 0.001, equivalentUsd: 0.001, at: 2000 });
        const image2 = record({ medium: 'image', costUsd: 0.1, equivalentUsd: 0.1, at: 3000 });
        const summary = summarizeUsage([image, chat, tts, image2], range, day);
        expect(summary.byMedium).toEqual([
            {
                medium: 'chat',
                requests: 1,
                costUsd: 0.5,
                equivalentUsd: 0.5,
                promptTokens: 10,
                completionTokens: 5,
                cachedTokens: 0,
            },
            {
                medium: 'image',
                requests: 2,
                costUsd: 0.3,
                equivalentUsd: 0.3,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
            },
            {
                medium: 'tts',
                requests: 1,
                costUsd: 0.001,
                equivalentUsd: 0.001,
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
            },
        ]);
        expect(summary.total.requests).toBe(4);
        expect(summary.total.costUsd).toBe(0.801);
    });

    it('breaks ties by name, honours the range and the connection filter', () => {
        const a = record({ medium: 'stt', costUsd: 0.1, connectionId: 'c1' });
        const b = record({ medium: 'video', costUsd: 0.1, connectionId: 'c2', at: 2000 });
        const late = record({ medium: 'image', costUsd: 9, at: 99_999 });
        const summary = summarizeUsage([b, a, late], range, day);
        expect(summary.byMedium?.map((m) => m.medium)).toEqual(['stt', 'video']);
        expect(summarizeUsage([a, b], range, day, { connectionId: 'c2' }).byMedium?.map((m) => m.medium)).toEqual([
            'video',
        ]);
    });
});
