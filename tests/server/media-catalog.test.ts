import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MEDIA_CATALOG_TTL_MS,
    createMediaCatalog,
    mediaCacheFile,
    mediaListUrl,
    type MediaCatalogOptions,
} from '../../src/server/media-catalog';
import type { FetchLike } from '../../src/server/types';
import images from '../../tools/fixtures/media/images_models.json';
import stt from '../../tools/fixtures/media/audio_models_stt.json';
import tts from '../../tools/fixtures/media/audio_models_tts.json';
import videos from '../../tools/fixtures/media/video_models.json';
import { cleanTempDirs, makeTempDir, recordingLogger } from './helpers';

afterEach(cleanTempDirs);

const LISTS: Record<string, unknown> = { image: images, video: videos, tts, stt };

/** Which medium a list URL asks for. */
function mediumOf(url: string): string {
    if (url.includes('/images/models')) return 'image';
    if (url.includes('/video-models')) return 'video';
    return url.includes('type=stt') ? 'stt' : 'tts';
}

interface Fake {
    fetch: FetchLike;
    calls: string[];
    headers: Record<string, string>[];
    mode: 'ok' | 'http500' | 'junk' | 'empty' | 'notjson' | 'hang' | 'throw';
    gate: Promise<void> | null;
}

function fakeFetch(): Fake {
    const fake: Fake = {
        calls: [],
        headers: [],
        mode: 'ok',
        gate: null,
        fetch: async (url, init) => {
            fake.calls.push(url);
            fake.headers.push(init.headers);
            if (fake.gate) await fake.gate;
            if (fake.mode === 'throw') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
            if (fake.mode === 'hang') await new Promise(() => {}); // ignores its signal, as a bad transport might
            const body =
                fake.mode === 'ok'
                    ? JSON.stringify(LISTS[mediumOf(url)])
                    : fake.mode === 'empty'
                      ? JSON.stringify({ object: 'list', data: [] })
                      : fake.mode === 'junk'
                        ? JSON.stringify({ hello: 'world' })
                        : fake.mode === 'notjson'
                          ? '<html>nope</html>'
                          : '';
            const status = fake.mode === 'http500' ? 500 : 200;
            return {
                status,
                headers: { get: () => null, forEach: () => {} },
                body: null,
                text: async () => body,
            };
        },
    };
    return fake;
}

function make(over: Partial<MediaCatalogOptions> = {}, fake = fakeFetch()) {
    const root = makeTempDir();
    const { log, lines } = recordingLogger();
    let clock = 1_000_000;
    const service = createMediaCatalog({
        mediaBase: 'http://nano.test/',
        dataRoot: () => root,
        fetch: fake.fetch,
        version: '1.2.3',
        now: () => clock,
        log,
        ...over,
    });
    return { service, fake, root, lines, advance: (ms: number) => void (clock += ms), clock: () => clock };
}

describe('mediaListUrl', () => {
    it('names the real list endpoints below the media host, whatever trailing slash the base has', () => {
        expect(mediaListUrl('https://api.nano-gpt.com', 'image')).toBe('https://api.nano-gpt.com/api/v1/images/models');
        expect(mediaListUrl('https://api.nano-gpt.com/', 'video')).toBe(
            'https://api.nano-gpt.com/api/v1/video-models?detailed=true',
        );
        expect(mediaListUrl('http://x', 'tts')).toBe('http://x/api/v1/audio-models?type=tts&detailed=true');
        expect(mediaListUrl('http://x///', 'stt')).toBe('http://x/api/v1/audio-models?type=stt&detailed=true');
        expect(mediaCacheFile('tts')).toBe('media-tts.json');
        expect(MEDIA_CATALOG_TTL_MS).toBe(3_600_000);
    });
});

describe('the media catalog service', () => {
    it('fetches live, then serves the fresh copy from memory, and refreshes on request', async () => {
        const { service, fake } = make();
        const first = await service.catalog('image');
        expect(first).toMatchObject({ medium: 'image', source: 'live' });
        expect(first?.models).toHaveLength(images.data.length);
        expect(first?.fetchedAt).toBe(1_000_000);
        expect((await service.catalog('image'))?.source).toBe('cache');
        expect((await service.catalog('image', { refresh: true }))?.source).toBe('live');
        expect(fake.calls).toEqual(['http://nano.test/api/v1/images/models', 'http://nano.test/api/v1/images/models']);
        // No key and no body: a public list, our own user agent.
        expect(fake.headers[0]).toEqual({ accept: 'application/json', 'user-agent': 'Nanovia/1.2.3' });
    });

    it('keeps the four media apart', async () => {
        const { service, fake } = make();
        for (const medium of ['image', 'video', 'tts', 'stt'] as const) {
            const result = await service.catalog(medium);
            expect(result?.models.every((m) => m.medium === medium)).toBe(true);
        }
        expect(fake.calls).toHaveLength(4);
        expect(service.models('tts').length).toBeGreaterThan(20);
        expect(service.models('tts').some((m) => m.id === 'Kokoro-82m')).toBe(true);
    });

    it('refetches after the one-hour TTL and not before', async () => {
        const { service, fake, advance } = make();
        await service.catalog('video');
        advance(MEDIA_CATALOG_TTL_MS - 1);
        expect((await service.catalog('video'))?.source).toBe('cache');
        advance(1);
        expect((await service.catalog('video'))?.source).toBe('live');
        expect(fake.calls).toHaveLength(2);
    });

    it('serves the old copy as stale when a fetch fails, without hammering NanoGPT while it is down', async () => {
        const { service, fake, advance, lines } = make({ failureBackoffMs: 60_000 });
        await service.catalog('tts');
        advance(MEDIA_CATALOG_TTL_MS);
        fake.mode = 'http500';
        const stale = await service.catalog('tts');
        expect(stale?.source).toBe('stale');
        expect(stale?.models.length).toBeGreaterThan(0);
        // Within the backoff: stale at once, no new call.
        expect((await service.catalog('tts'))?.source).toBe('stale');
        expect(fake.calls).toHaveLength(2);
        // After it: another try, and success.
        advance(60_000);
        fake.mode = 'ok';
        expect((await service.catalog('tts'))?.source).toBe('live');
        expect(lines.filter((l) => l.startsWith('warn') && l.includes('fetch failed'))).toHaveLength(1);
        expect(lines.some((l) => l.includes('the stored copy is used'))).toBe(true);
    });

    it('answers null when there is no copy and NanoGPT cannot be reached', async () => {
        for (const mode of ['http500', 'junk', 'empty', 'notjson', 'throw'] as const) {
            const { service, fake } = make();
            fake.mode = mode;
            expect(await service.catalog('image'), mode).toBeNull();
            expect(service.models('image')).toEqual([]);
            expect(service.lookup('image', 'rev-animated')).toBeNull();
        }
    });

    it('never lets an empty or junk answer replace a good copy', async () => {
        const { service, fake } = make();
        await service.catalog('stt');
        for (const mode of ['empty', 'junk', 'notjson'] as const) {
            fake.mode = mode;
            const result = await service.catalog('stt', { refresh: true });
            expect(result?.source, mode).toBe('stale');
            expect(result?.models.length, mode).toBe(stt.data.length);
        }
    });

    it('shares one fetch between simultaneous callers', async () => {
        const { service, fake } = make();
        let release!: () => void;
        fake.gate = new Promise<void>((resolve) => (release = resolve));
        const calls = [service.catalog('image'), service.catalog('image'), service.catalog('image')];
        await new Promise((r) => setTimeout(r, 20));
        release();
        const results = await Promise.all(calls);
        expect(results.every((r) => r?.source === 'live')).toBe(true);
        expect(fake.calls).toHaveLength(1);
        await service.settled();
    });

    it('gives up on a fetch that hangs, even when the transport ignores its signal', async () => {
        const { service, fake, lines } = make({ timeoutMs: 40 });
        fake.mode = 'hang';
        expect(await service.catalog('image')).toBeNull();
        expect(lines.some((l) => l.includes('(timeout)'))).toBe(true);
    });

    it('looks a model up by its exact id, from memory', async () => {
        const { service } = make();
        expect(service.lookup('image', 'rev-animated')).toBeNull(); // not loaded yet
        await service.catalog('image');
        expect(service.lookup('image', 'rev-animated')).toMatchObject({ id: 'rev-animated', medium: 'image' });
        expect(service.lookup('image', '  rev-animated ')?.id).toBe('rev-animated');
        expect(service.lookup('image', 'rev-animated:thinking')).toBeNull();
        expect(service.lookup('tts', 'rev-animated')).toBeNull();
        expect(service.lookup('image', 5 as unknown as string)).toBeNull();
    });
});

describe('persistence', () => {
    it('writes `<data root>/_nanovia/media-<medium>.json` after a fetch and reads it back at start while NanoGPT is down', async () => {
        const first = make();
        await first.service.catalog('video');
        const file = path.join(first.root, '_nanovia', 'media-video.json');
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(stored).toMatchObject({ version: 1, fetchedAt: 1_000_000 });
        expect(stored.models).toHaveLength(videos.data.length);

        const down = fakeFetch();
        down.mode = 'throw';
        const restarted = createMediaCatalog({
            mediaBase: 'http://nano.test',
            dataRoot: () => first.root,
            fetch: down.fetch,
            version: 't',
            now: () => 1_000_500,
            log: recordingLogger().log,
        });
        restarted.start();
        expect(restarted.lookup('video', 'veo3-video')).toMatchObject({ id: 'veo3-video' });
        expect(restarted.models('video')).toHaveLength(videos.data.length);
        const served = await restarted.catalog('video');
        expect(served).toMatchObject({ source: 'cache', fetchedAt: 1_000_000 });
        expect(down.calls).toHaveLength(0); // autoFetch is off: nothing fetched by itself
    });

    it('ignores a missing, damaged, outdated or wrongly shaped cache and says so only when it is damaged', () => {
        const { service, root, lines } = make();
        const dir = path.join(root, '_nanovia');
        fs.mkdirSync(dir, { recursive: true });
        service.start(); // no files at all
        expect(lines).toEqual([]);
        fs.writeFileSync(path.join(dir, 'media-image.json'), '{ nope');
        fs.writeFileSync(
            path.join(dir, 'media-video.json'),
            JSON.stringify({ version: 99, fetchedAt: 5, models: [{}] }),
        );
        fs.writeFileSync(
            path.join(dir, 'media-tts.json'),
            JSON.stringify({ version: 1, fetchedAt: 'x', models: [{}] }),
        );
        fs.writeFileSync(path.join(dir, 'media-stt.json'), JSON.stringify({ version: 1, fetchedAt: 5, models: 'x' }));
        const again = createMediaCatalog({
            mediaBase: 'http://x',
            dataRoot: () => root,
            fetch: fakeFetch().fetch,
            version: 't',
            now: () => 10,
            log: recordingLogger().log,
        });
        again.start();
        for (const medium of ['image', 'video', 'tts', 'stt'] as const)
            expect(again.models(medium), medium).toEqual([]);
        const { log, lines: warned } = recordingLogger();
        createMediaCatalog({
            mediaBase: 'http://x',
            dataRoot: () => root,
            fetch: fakeFetch().fetch,
            version: 't',
            now: () => 10,
            log,
        }).start();
        expect(warned.filter((l) => l.includes('unreadable'))).toEqual([
            'warn media catalog cache (image) is unreadable and is ignored',
        ]);
    });

    it('keeps only well-formed stored models of the right medium, and never lets a clock that went backwards make a copy look new', () => {
        const { root } = make();
        const dir = path.join(root, '_nanovia');
        fs.mkdirSync(dir, { recursive: true });
        const good = {
            id: 'a',
            medium: 'image',
            name: 'A',
            price: { unit: 'image', from: 1, to: 1, byKey: {}, raw: null },
            capabilities: {},
            params: [],
            tags: [],
            voices: [],
            formats: [],
        };
        fs.writeFileSync(
            path.join(dir, 'media-image.json'),
            JSON.stringify({
                version: 1,
                fetchedAt: 9_999_999_999,
                models: [
                    good,
                    good,
                    { ...good, id: 'b', medium: 'tts' },
                    { ...good, id: '' },
                    { ...good, id: 'c', price: 'x' },
                    { ...good, id: 'd', params: 'x' },
                    null,
                ],
            }),
        );
        const service = createMediaCatalog({
            mediaBase: 'http://x',
            dataRoot: () => root,
            fetch: fakeFetch().fetch,
            version: 't',
            now: () => 5000,
            log: recordingLogger().log,
        });
        service.start();
        expect(service.models('image').map((m) => m.id)).toEqual(['a']);
        expect(service.models('video')).toEqual([]);
        return service.catalog('image').then((result) => expect(result?.fetchedAt).toBe(5000));
    });

    it('survives a data root that cannot be written', async () => {
        const root = makeTempDir();
        fs.writeFileSync(path.join(root, '_nanovia'), 'a file where the directory should be');
        const { service, lines } = make({ dataRoot: () => root });
        expect((await service.catalog('image'))?.source).toBe('live');
        expect(lines.some((l) => l.includes('could not be written'))).toBe(true);
    });
});

describe('autoFetch and shutdown', () => {
    it('fetches at start and when a lookup finds the list missing or old, when switched on', async () => {
        const { service, fake, advance } = make({ autoFetch: true });
        service.start();
        await service.settled();
        expect(fake.calls).toHaveLength(4);
        expect(service.lookup('image', 'rev-animated')?.id).toBe('rev-animated');
        advance(MEDIA_CATALOG_TTL_MS);
        expect(service.lookup('image', 'rev-animated')?.id).toBe('rev-animated'); // the old copy answers, a fetch starts
        await service.settled();
        expect(fake.calls).toHaveLength(5);
        // Missing list: the lookup starts the fetch and answers null.
        const lone = make({ autoFetch: true });
        expect(lone.service.lookup('tts', 'Kokoro-82m')).toBeNull();
        await lone.service.settled();
        expect(lone.service.lookup('tts', 'Kokoro-82m')?.id).toBe('Kokoro-82m');
    });

    it('does not retry in the background while NanoGPT keeps failing', async () => {
        const { service, fake } = make({ autoFetch: true, failureBackoffMs: 60_000 });
        fake.mode = 'http500';
        service.lookup('image', 'x');
        await service.settled();
        service.lookup('image', 'x');
        service.lookup('image', 'x');
        await service.settled();
        expect(fake.calls).toHaveLength(1);
    });

    it('never fetches by itself when autoFetch is off', async () => {
        const { service, fake } = make();
        service.start();
        service.lookup('image', 'x');
        await service.settled();
        expect(fake.calls).toEqual([]);
    });

    it('aborts what is running on close and answers nothing afterwards', async () => {
        const { service, fake } = make();
        let release!: () => void;
        fake.gate = new Promise<void>((resolve) => (release = resolve));
        const pending = service.catalog('image');
        await new Promise((r) => setTimeout(r, 10));
        service.close();
        release();
        expect(await pending).toBeNull();
        expect(await service.catalog('tts')).toBeNull();
        service.start(); // a closed service stays closed
        expect(service.models('tts')).toEqual([]);
    });
});
