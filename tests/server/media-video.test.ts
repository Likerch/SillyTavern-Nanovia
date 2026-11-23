/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, cleanTempDirs, type Harness } from './helpers';
import { startMediaStack, usageLines, userFolderText, type MediaStack } from './media-helpers';

const stacks: MediaStack[] = [];
const extraHarnesses: Harness[] = [];
async function stack(options: Parameters<typeof startMediaStack>[0] = {}): Promise<MediaStack> {
    const s = await startMediaStack(options);
    stacks.push(s);
    return s;
}
afterEach(async () => {
    for (const h of extraHarnesses.splice(0)) await h.close();
    for (const s of stacks.splice(0)) await s.close();
    cleanTempDirs();
});

const USER = 'default-user';
const submit = (s: MediaStack, extra: Record<string, unknown> = {}, user?: string) =>
    s.h.api(
        'POST',
        '/media/video',
        { model: 'kling-v25-turbo-std', prompt: 'a cat on a roof', duration: 5, ...extra },
        user,
    );
const poll = (s: MediaStack, id: string, user?: string) => s.h.api('GET', `/media/video/${id}`, undefined, user);
const mockState = (s: MediaStack, media: Record<string, unknown>) =>
    fetch(`${s.origin}/__mock/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ media }),
    });
const statusCalls = (s: MediaStack): any[] => s.seen('/api/video/status');
const jobsFile = (s: MediaStack, user = USER): string => path.join(s.h.root, user, 'nanovia', 'media-jobs.json');
const videoFile = (s: MediaStack, id: string, user = USER): string =>
    path.join(s.h.root, user, 'nanovia', 'media', `${id}.mp4`);
/** Polls until the job is completed (the mock needs three polls by default). */
async function complete(s: MediaStack, id: string, user?: string): Promise<any> {
    let last: any;
    for (let i = 0; i < 6; i += 1) {
        last = (await poll(s, id, user)).json;
        if (last.status === 'completed' || last.status === 'failed' || last.status === 'expired') break;
    }
    return last;
}

describe('POST /media/video', () => {
    it('submits, stores the job and answers the contract shape with the estimate as the first cost', async () => {
        const s = await stack({ now: () => 1_700_000_000_000 });
        const res = await submit(s, { connectionId: 'abc12345' });
        expect(res.status).toBe(200);
        expect(res.json).toEqual({
            id: expect.stringMatching(/^vid_/),
            model: 'kling-v25-turbo-std',
            prompt: 'a cat on a roof',
            status: 'queued',
            progress: null,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            cost: {
                usd: 0.21,
                source: 'response',
                estimateUsd: 0.21,
                paymentSource: 'USD',
                remainingUsd: expect.any(Number),
            },
            connectionId: 'abc12345',
            output: null,
            error: null,
        });
        const seen = s.seen('/api/generate-video').at(-1);
        expect(seen.body).toEqual({ model: 'kling-v25-turbo-std', prompt: 'a cat on a roof', duration: '5' });
        expect(seen.headers.authorization).toMatch(/^Bearer sk-nano-…/);
        expect(s.h.usage()[0]).toMatchObject({
            medium: 'video',
            model: 'kling-v25-turbo-std',
            units: 5,
            requestId: res.json['id'],
            costUsd: 0.21,
            costSource: 'response',
            billing: 'paygo',
            status: 202,
            connectionId: 'abc12345',
        });
        // The job is on disk, with what the plugin needs to carry on after a restart and no key.
        const stored = JSON.parse(fs.readFileSync(jobsFile(s), 'utf8'));
        expect(stored.version).toBe(1);
        expect(stored.jobs[0]).toMatchObject({
            id: res.json['id'],
            keyId: null,
            adjusted: false,
            usageAt: 1_700_000_000_000,
        });
        expect(userFolderText(s.h.root)).not.toContain('KEYTAIL');
    });

    it('passes the options a model lists and sends the image the right way, and falls back to the catalog estimate', async () => {
        const s = await stack();
        const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        const res = await submit(s, {
            model: 'vidu-q4',
            duration: 5,
            resolution: '720p',
            aspectRatio: '16:9',
            seed: 3,
            imageUrl: dataUrl,
            billing: 'paygo',
            extra: { negative_prompt: 'blur', bogus: 1 },
        });
        expect(res.status).toBe(200);
        const seen = s.seen('/api/generate-video').at(-1);
        expect(seen.body).toEqual({
            model: 'vidu-q4',
            prompt: 'a cat on a roof',
            duration: '5',
            aspect_ratio: '16:9',
            resolution: '720p',
            seed: 3,
            imageDataUrl: dataUrl,
        });
        expect(seen.headers['x-billing-mode']).toBe('paygo');
        expect(res.json['cost']).toMatchObject({ usd: 0.5225, estimateUsd: 0.5225 });
        const link = await submit(s, { imageUrl: 'https://example.test/a.png', prompt: '' });
        expect(s.seen('/api/generate-video').at(-1).body).toMatchObject({ imageUrl: 'https://example.test/a.png' });
        expect(link.status).toBe(200);
    });

    it('checks the request and the model before calling NanoGPT', async () => {
        const s = await stack();
        expect((await submit(s, { prompt: '' })).json['error']['code']).toBe('invalid_request');
        expect((await submit(s, { duration: 'five' })).status).toBe(400);
        expect((await submit(s, { model: 'no-such-model' })).json['error']['message']).toContain('no-such-model');
        expect((await submit(s, { model: 'Kokoro-82m' })).status).toBe(400);
        const big = `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024, 1).toString('base64')}`;
        const huge = await submit(s, { imageUrl: big });
        expect(huge.status).toBe(413);
        expect(huge.json['error']['code']).toBe('payload_too_large');
        expect(s.seen('/api/generate-video')).toHaveLength(0);
    });

    it('maps NanoGPT refusals, whatever their shape, and records the failed submit', async () => {
        const cases: [Record<string, unknown>, Record<string, string>, number, string, RegExp][] = [
            [
                {},
                { 'x-mock-error': '401-text' },
                502,
                'upstream_error',
                /rejected the key \(HTTP 401\): Invalid session/,
            ],
            [{}, { 'x-mock-error': '402-legacy' }, 402, 'insufficient_balance', /0\.0035 USD/],
            [{ prompt: 'forbidden things' }, {}, 400, 'content_policy_violation', /content policy/],
            [{}, { 'x-mock-error': '429' }, 429, 'rate_limited', /rate limiting/],
            [{}, { 'x-mock-error': '500' }, 502, 'upstream_error', /HTTP 500/],
        ];
        for (const [body, headers, status, code, message] of cases) {
            let failing = false;
            const real = globalThis.fetch as any;
            const s = await stack({
                fetch: ((url: string, init: any) =>
                    real(url, {
                        ...init,
                        headers: init.method === 'POST' && failing ? { ...init.headers, ...headers } : init.headers,
                    })) as any,
            });
            await s.h.api('GET', '/media/catalog?medium=video');
            failing = true;
            const res = await submit(s, body);
            expect(res.status, code).toBe(status);
            expect(res.json['error']['code'], code).toBe(code);
            expect(res.json['error']['message'], code).toMatch(message);
            expect(s.h.usage()[0], code).toMatchObject({ medium: 'video', costUsd: null, error: code });
            expect(fs.existsSync(jobsFile(s)), code).toBe(false);
        }
    });

    it('refuses an answer without a usable job id, and times out a slow submit', async () => {
        const real = globalThis.fetch as any;
        let answer: Response | null = null;
        let slow = false;
        const s = await stack({
            media: { timeouts: { videoSubmitMs: 150 } },
            fetch: ((url: string, init: any) => {
                if (init.method === 'POST' && slow)
                    return real(url, { ...init, headers: { ...init.headers, 'x-mock-delay-ms': '1500' } });
                return init.method === 'POST' && answer ? Promise.resolve(answer) : real(url, init);
            }) as any,
        });
        await s.h.api('GET', '/media/catalog?medium=video');
        answer = new Response(JSON.stringify({ runId: '../../etc/passwd', cost: 1 }), { status: 202 });
        const bad = await submit(s);
        expect(bad.status).toBe(502);
        expect(bad.json['error']['message']).toContain('no usable job id');
        answer = new Response(JSON.stringify({ status: 'pending' }), { status: 202 });
        expect((await submit(s)).status).toBe(502);
        answer = null;
        slow = true;
        const late = await submit(s);
        expect(late.status).toBe(504);
        expect(late.json['error']['code']).toBe('upstream_timeout');
        expect(fs.existsSync(jobsFile(s))).toBe(false);
    });
});

describe('GET /media/video and GET /media/video/:id', () => {
    it('lists the jobs newest first and 404s unknown or malformed ids', async () => {
        let t = 1000;
        const s = await stack({ now: () => (t += 10) });
        const first = (await submit(s)).json['id'];
        const second = (await submit(s)).json['id'];
        expect((await s.h.api('GET', '/media/video')).json['jobs'].map((j: any) => j.id)).toEqual([second, first]);
        for (const id of ['vid_unknown', '..%2F..%2Fconnections', 'bad%20id', 'x'.repeat(200)]) {
            const res = await poll(s, id);
            expect(res.status, id).toBe(404);
            expect(res.json['error']['code']).toBe('not_found');
        }
    });

    it('follows a job through the documented guide shape, saves the file and corrects the cost', async () => {
        const s = await stack();
        const { id } = (await submit(s)).json;
        const first = (await poll(s, id)).json;
        expect(first).toMatchObject({ status: 'queued', progress: null, output: null });
        const second = (await poll(s, id)).json;
        expect(second).toMatchObject({ status: 'running', progress: null });
        const done = (await poll(s, id)).json;
        expect(done).toMatchObject({
            status: 'completed',
            progress: 1,
            error: null,
            cost: { usd: 0.231, source: 'response', estimateUsd: 0.21 },
            output: {
                kind: 'video',
                mime: 'video/mp4',
                url: expect.stringContaining(`/api/generate-video/content?runId=${id}`),
                bytes: 4128,
                file: `/media/files/${id}`,
            },
        });
        // The file is the user's own copy, outside anything the client named.
        const saved = fs.readFileSync(videoFile(s, id));
        expect(saved.length).toBe(4128);
        expect(saved.subarray(4, 8).toString('latin1')).toBe('ftyp');
        expect(fs.readdirSync(path.dirname(videoFile(s, id))).filter((n) => n.endsWith('.part'))).toEqual([]);
        // The download never carried the key (the link is public and signed).
        const download = s.seen('/api/generate-video/content').at(-1);
        expect(download.headers.authorization).toBeUndefined();
        // The final cost went to the usage log as an adjust line next to the submit record.
        const lines = usageLines(s.h.root);
        expect(lines).toHaveLength(2);
        expect(lines[1]).toEqual({
            adjust: true,
            requestId: id,
            costUsd: 0.231,
            costSource: 'response',
            at: expect.any(Number),
        });
        expect((await s.h.api('GET', '/spend')).json['total']['costUsd']).toBe(0.231);
        // Once finished and saved, nothing more is asked of NanoGPT.
        const calls = statusCalls(s).length;
        expect((await poll(s, id)).json['status']).toBe('completed');
        expect(statusCalls(s)).toHaveLength(calls);
        expect(s.h.app.deps.media.jobs.get(path.join(s.h.root, USER), id)?.adjusted).toBe(true);
    });

    it('reads the flat OpenAPI shape too (lowercase status, progress 0-100, videoUrl), without a final cost', async () => {
        const s = await stack();
        await mockState(s, { videoShape: 'flat' });
        const { id } = (await submit(s)).json;
        expect((await poll(s, id)).json).toMatchObject({ status: 'queued', progress: null });
        expect((await poll(s, id)).json).toMatchObject({ status: 'running', progress: 0.67 });
        const done = (await poll(s, id)).json;
        expect(done).toMatchObject({ status: 'completed', progress: 1, output: { file: `/media/files/${id}` } });
        // No cost in this shape: the submit figure stays and nothing is adjusted.
        expect(done['cost']).toMatchObject({ usd: 0.21, source: 'response' });
        expect(usageLines(s.h.root)).toHaveLength(1);
        expect(fs.existsSync(videoFile(s, id))).toBe(true);
    });

    it('resolves a link that is a path on the media host', async () => {
        const s = await stack();
        await mockState(s, { videoRelativeUrl: true });
        const { id } = (await submit(s)).json;
        const done = await complete(s, id);
        expect(done['output']['url']).toBe(
            `${s.origin}/api/generate-video/content?runId=${id}&expires=${new URL(done['output']['url']).searchParams.get('expires')}&sig=mock`,
        );
        expect(done['output']['file']).toBe(`/media/files/${id}`);
    });

    it('asks NanoGPT at most once per interval and shares one call between simultaneous polls', async () => {
        let t = 5_000_000;
        const s = await stack({ now: () => t, media: { pollIntervalMs: 3000 } });
        const { id } = (await submit(s)).json;
        await poll(s, id);
        await poll(s, id);
        expect(statusCalls(s)).toHaveLength(1);
        t += 2999;
        await poll(s, id);
        expect(statusCalls(s)).toHaveLength(1);
        t += 1;
        expect((await poll(s, id)).json['status']).toBe('running');
        expect(statusCalls(s)).toHaveLength(2);
        // Three simultaneous polls after the interval: one upstream call.
        t += 3000;
        await mockState(s, { videoPollsToComplete: 99 });
        const slow = await stack({
            now: () => t,
            media: { pollIntervalMs: 0 },
            fetch: ((url: string, init: any) =>
                (globalThis.fetch as any)(url, {
                    ...init,
                    headers: {
                        ...init.headers,
                        ...(url.includes('/api/video/status') ? { 'x-mock-delay-ms': '150' } : {}),
                    },
                })) as any,
        });
        const job = (await submit(slow)).json['id'];
        await Promise.all([poll(slow, job), poll(slow, job), poll(slow, job)]);
        expect(statusCalls(slow)).toHaveLength(1);
    });

    it("turns a failed job into failed, with NanoGPT's words, and assumes the refund the docs promise", async () => {
        const s = await stack();
        const { id } = (await submit(s, { prompt: 'please failjob' })).json;
        const failed = await complete(s, id);
        expect(failed).toMatchObject({
            status: 'failed',
            error: 'The video could not be made',
            output: null,
            cost: { usd: 0, source: 'estimate' },
        });
        expect(usageLines(s.h.root)[1]).toMatchObject({
            adjust: true,
            requestId: id,
            costUsd: 0,
            costSource: 'estimate',
        });
        expect((await s.h.api('GET', '/spend')).json['total']['costUsd']).toBe(0);
        // Flat shape: the message is the plain `error`.
        await mockState(s, { videoShape: 'flat' });
        const second = (await submit(s, { prompt: 'failjob again' })).json['id'];
        expect((await complete(s, second))['error']).toBe('Generation failed upstream');
        expect(statusCalls(s)).toHaveLength(6);
    });

    it('marks a link that is gone as expired, and keeps the cost', async () => {
        const s = await stack();
        const { id } = (await submit(s)).json;
        await poll(s, id);
        await poll(s, id);
        await mockState(s, { videoContentGone: true });
        const gone = (await poll(s, id)).json;
        expect(gone).toMatchObject({
            status: 'expired',
            error: expect.stringContaining('no longer available at NanoGPT'),
        });
        expect(fs.existsSync(videoFile(s, id))).toBe(false);
        expect(usageLines(s.h.root).at(-1)).toMatchObject({ adjust: true, costUsd: 0.231 });
    });

    it('keeps the link when the file is over the size cap, and does not retry for ever', async () => {
        const s = await stack({ media: { maxVideoBytes: 1000 } });
        const { id } = (await submit(s)).json;
        const done = await complete(s, id);
        expect(done['status']).toBe('completed');
        expect(done['output']).toMatchObject({ url: expect.any(String) });
        expect(done['output']['file']).toBeUndefined();
        expect(done['error']).toContain('larger than');
        expect(
            fs.readdirSync(path.join(s.h.root, USER, 'nanovia')).includes('media')
                ? fs.readdirSync(path.join(s.h.root, USER, 'nanovia', 'media'))
                : [],
        ).toEqual([]);
        const downloads = s.seen('/api/generate-video/content').length;
        await poll(s, id);
        await poll(s, id);
        expect(s.seen('/api/generate-video/content')).toHaveLength(downloads);
        expect((await s.h.api('GET', `/media/files/${id}`)).status).toBe(404);
    });

    it('retries a failing download on later polls, then reports it once and stops', async () => {
        const real = globalThis.fetch as any;
        let broken = 0;
        const s = await stack({
            fetch: ((url: string, init: any) => {
                if (url.includes('/api/generate-video/content') && broken > 0) {
                    broken -= 1;
                    return Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
                }
                return real(url, init);
            }) as any,
        });
        const first = (await submit(s)).json['id'];
        broken = 1;
        await poll(s, first);
        await poll(s, first);
        const pending = (await poll(s, first)).json;
        expect(pending).toMatchObject({ status: 'completed', error: null });
        expect(pending['output']['file']).toBeUndefined();
        const saved = (await poll(s, first)).json;
        expect(saved['output']['file']).toBe(`/media/files/${first}`);

        const second = (await submit(s)).json['id'];
        broken = 99;
        for (let i = 0; i < 5; i += 1) await poll(s, second);
        const final = (await poll(s, second)).json;
        expect(final['status']).toBe('completed');
        expect(final['error']).toContain('could not be saved');
        expect(
            s.seen('/api/generate-video/content').filter((e: any) => e.path.includes(second as string)),
        ).toHaveLength(0);
    });

    it('leaves a job alone when NanoGPT is unreachable, refuses the key or says it knows no such job', async () => {
        const real = globalThis.fetch as any;
        let t = 9_000_000;
        let mode: 'ok' | 'down' | 'unauthorized' | 'unknown' = 'ok';
        const s = await stack({
            now: () => t,
            fetch: ((url: string, init: any) => {
                if (url.includes('/api/video/status')) {
                    if (mode === 'down') return Promise.reject(new Error('socket hang up'));
                    if (mode === 'unauthorized')
                        return Promise.resolve(new Response('Invalid session', { status: 401 }));
                    if (mode === 'unknown')
                        return Promise.resolve(
                            new Response(JSON.stringify({ error: 'Video generation request not found' }), {
                                status: 404,
                            }),
                        );
                }
                return real(url, init);
            }) as any,
        });
        const { id } = (await submit(s)).json;
        mode = 'down';
        expect((await poll(s, id)).json).toMatchObject({ status: 'queued', error: null });
        mode = 'unauthorized';
        expect((await poll(s, id)).json).toMatchObject({ status: 'queued', error: null });
        // Right after the submit "unknown" is tolerated; a minute later five misses in a row end the job.
        mode = 'unknown';
        for (let i = 0; i < 6; i += 1) expect((await poll(s, id)).json['status']).toBe('queued');
        t += 61_000;
        const lost = (await poll(s, id)).json;
        expect(lost).toMatchObject({ status: 'failed', error: 'NanoGPT no longer knows this job' });
        expect(usageLines(s.h.root).at(-1)).toMatchObject({ adjust: true, costUsd: 0 });
    });

    it('gives up on a job nobody finished within a day', async () => {
        let t = 1_000_000_000_000;
        const s = await stack({ now: () => t });
        const { id } = (await submit(s)).json;
        await mockState(s, { videoPollsToComplete: 99 });
        t += 25 * 3_600_000;
        const stale = (await poll(s, id)).json;
        expect(stale).toMatchObject({ status: 'expired', error: 'NanoGPT stopped reporting this job' });
    });

    it('writes the correction to the file of the day the call was made', async () => {
        let t = Date.parse('2026-01-01T23:59:00Z');
        const s = await stack({ now: () => t });
        const { id } = (await submit(s)).json;
        t = Date.parse('2026-01-02T00:05:00Z');
        await complete(s, id);
        const dir = path.join(s.h.root, USER, 'nanovia');
        expect(fs.readFileSync(path.join(dir, 'usage-2026-01-01.jsonl'), 'utf8')).toContain(
            `"adjust":true,"requestId":"${id}"`,
        );
        expect(fs.existsSync(path.join(dir, 'usage-2026-01-02.jsonl'))).toBe(false);
        const spend = await s.h.api(
            'GET',
            `/spend?from=${Date.parse('2026-01-01T00:00:00Z')}&to=${Date.parse('2026-01-02T00:00:00Z')}`,
        );
        expect(spend.json['total']['costUsd']).toBe(0.231);
    });
});

describe('DELETE /media/video/:id', () => {
    it('forgets the job and deletes its file; NanoGPT has no cancel, so it is never called', async () => {
        const s = await stack();
        const { id } = (await submit(s)).json;
        await complete(s, id);
        expect(fs.existsSync(videoFile(s, id))).toBe(true);
        const before = s.mock.state.log.length;
        const res = await s.h.api('DELETE', `/media/video/${id}`);
        expect(res.json).toEqual({ ok: true });
        expect(fs.existsSync(videoFile(s, id))).toBe(false);
        expect((await s.h.api('GET', '/media/video')).json['jobs']).toEqual([]);
        expect((await poll(s, id)).status).toBe(404);
        expect((await s.h.api('GET', `/media/files/${id}`)).status).toBe(404);
        expect(s.mock.state.log.length).toBe(before); // no upstream call at all
        expect((await s.h.api('DELETE', `/media/video/${id}`)).status).toBe(404);
        expect((await s.h.api('DELETE', '/media/video/..%2Fx')).status).toBe(404);
    });
});

describe('GET /media/files/:id', () => {
    async function saved(s: MediaStack, user?: string): Promise<string> {
        const { id } = (await submit(s, {}, user)).json;
        await complete(s, id, user);
        return id;
    }
    const get = (s: MediaStack, id: string, headers: Record<string, string> = {}) =>
        fetch(`${s.h.admin}/media/files/${id}`, { headers });

    it('serves the saved bytes with the right headers', async () => {
        const s = await stack();
        const id = await saved(s);
        const res = await get(s, id);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('video/mp4');
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(res.headers.get('content-length')).toBe('4128');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toBe('private, max-age=300');
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.equals(fs.readFileSync(videoFile(s, id)))).toBe(true);
    });

    it('honours byte ranges, as a video element seeks', async () => {
        const s = await stack();
        const id = await saved(s);
        const whole = fs.readFileSync(videoFile(s, id));
        const range = async (header: string) => {
            const res = await get(s, id, { range: header });
            return { res, bytes: Buffer.from(await res.arrayBuffer()) };
        };
        const head = await range('bytes=0-9');
        expect(head.res.status).toBe(206);
        expect(head.res.headers.get('content-range')).toBe('bytes 0-9/4128');
        expect(head.res.headers.get('content-length')).toBe('10');
        expect(head.bytes.equals(whole.subarray(0, 10))).toBe(true);
        const tail = await range('bytes=4120-');
        expect(tail.res.headers.get('content-range')).toBe('bytes 4120-4127/4128');
        expect(tail.bytes.equals(whole.subarray(4120))).toBe(true);
        const suffix = await range('bytes=-16');
        expect(suffix.res.status).toBe(206);
        expect(suffix.bytes.equals(whole.subarray(4112))).toBe(true);
        const clamped = await range('bytes=4000-99999');
        expect(clamped.res.headers.get('content-range')).toBe('bytes 4000-4127/4128');
        const outside = await range('bytes=5000-');
        expect(outside.res.status).toBe(416);
        expect(outside.res.headers.get('content-range')).toBe('bytes */4128');
        // Ranges that are not understood or not single are ignored: the whole file.
        for (const header of ['bytes=0-9,20-30', 'items=0-9', 'bytes=abc', 'bytes=9-3']) {
            const answer = await range(header);
            expect(answer.res.status, header).toBe(200);
            expect(answer.bytes.length).toBe(4128);
        }
    });

    it("answers 404 for an unsaved or unknown job, a malformed id and another user's job", async () => {
        const s = await stack();
        s.h.st.addNanoKey('frank', 'sk-nano-frank-key-000000000000000000', 'f');
        const { id: pending } = (await submit(s)).json;
        expect((await get(s, pending)).status).toBe(404);
        const id = await saved(s);
        for (const bad of ['vid_unknown', '..%2F..%2Fconnections.json', '%2e%2e', 'x'.repeat(200)]) {
            expect((await get(s, bad)).status, bad).toBe(404);
        }
        expect((await get(s, id, { 'x-test-user': 'frank' })).status).toBe(404);
        expect((await get(s, id)).status).toBe(200);
        const other = await saved(s, 'frank');
        expect(other).not.toBe(id);
        expect((await get(s, other, { 'x-test-user': 'frank' })).status).toBe(200);
        expect((await get(s, other)).status).toBe(404);
        expect(fs.existsSync(videoFile(s, other, 'frank'))).toBe(true);
        expect(fs.existsSync(videoFile(s, other))).toBe(false);
        const body = await (await get(s, 'vid_unknown')).json();
        expect(body).toEqual({ error: { code: 'not_found', message: 'No such saved video' } });
    });
});

describe('the job store across a restart and under its cap', () => {
    it('reloads the jobs after a restart and polls the unfinished one again', async () => {
        const s = await stack();
        const { id } = (await submit(s)).json;
        await poll(s, id);
        await poll(s, id);
        const finished = (await submit(s)).json['id'];
        await mockState(s, { videoPollsToComplete: 1 });
        await complete(s, finished);
        expect(fs.existsSync(videoFile(s, finished))).toBe(true);

        // A new plugin process over the same data: same ST data root, same mock.
        await s.h.app.close();
        const h2 = await boot({
            st: s.h.st,
            config: {
                upstreamBase: `${s.origin}/api/v1`,
                upstreamFallbackBase: null,
                siteBase: s.origin,
                mediaBase: s.origin,
            },
            media: { pollIntervalMs: 0 },
        });
        extraHarnesses.push(h2);
        const jobs = (await h2.api('GET', '/media/video')).json['jobs'];
        expect(jobs.map((j: any) => [j.id, j.status])).toEqual([
            [finished, 'completed'],
            [id, 'running'],
        ]);
        const resumed = (await h2.api('GET', `/media/video/${id}`)).json;
        expect(resumed['status']).toBe('completed');
        expect(resumed['output']['file']).toBe(`/media/files/${id}`);
        const file = await fetch(`${h2.admin}/media/files/${finished}`);
        expect(file.status).toBe(200);
        expect((await file.arrayBuffer()).byteLength).toBe(4128);
    });

    it('keeps at most the cap, newest first, and deletes the files of the jobs it drops', async () => {
        let t = 1_000;
        const s = await stack({ now: () => (t += 1000), media: { maxJobs: 3 } });
        await mockState(s, { videoPollsToComplete: 1 });
        const first = (await submit(s)).json['id'];
        await complete(s, first);
        expect(fs.existsSync(videoFile(s, first))).toBe(true);
        const ids = [first];
        for (let i = 0; i < 3; i += 1) ids.push((await submit(s)).json['id']);
        const listed = (await s.h.api('GET', '/media/video')).json['jobs'].map((j: any) => j.id);
        expect(listed).toEqual([ids[3], ids[2], ids[1]]);
        expect(fs.existsSync(videoFile(s, first))).toBe(false);
        expect(JSON.parse(fs.readFileSync(jobsFile(s), 'utf8')).jobs).toHaveLength(3);
    });

    it('ignores a damaged jobs file and entries that are not jobs, and never turns a bad id into a path', async () => {
        const s = await stack();
        const file = jobsFile(s);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
            file,
            JSON.stringify({
                version: 1,
                jobs: [
                    { id: '../evil', model: 'm', status: 'queued', createdAt: 1 },
                    {
                        id: 'vid_ok',
                        model: 'm',
                        prompt: 'p',
                        status: 'running',
                        createdAt: 5,
                        progress: 2,
                        cost: { usd: -1 },
                        output: { kind: 'video', url: 'file:///etc/passwd' },
                    },
                    { id: 'vid_ok', model: 'dup', status: 'queued', createdAt: 6 },
                    { id: 'vid_bad_status', model: 'm', status: 'weird', createdAt: 1 },
                    'junk',
                    null,
                ],
            }),
        );
        const jobs = (await s.h.api('GET', '/media/video')).json['jobs'];
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
            id: 'vid_ok',
            model: 'm',
            progress: 1,
            cost: { usd: null, source: 'unknown' },
            output: { kind: 'video', mime: 'video/mp4' },
        });
        expect(jobs[0].output.url).toBeUndefined();
        fs.writeFileSync(file, '{ not json');
        const s2 = await stack();
        fs.mkdirSync(path.dirname(jobsFile(s2)), { recursive: true });
        fs.writeFileSync(jobsFile(s2), '{ not json');
        expect((await s2.h.api('GET', '/media/video')).json['jobs']).toEqual([]);
        expect(s2.h.logs.some((l) => l.includes('media-jobs.json is unreadable'))).toBe(true);
    });
});
