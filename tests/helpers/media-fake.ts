// The stage 0.7 routes of the plugin's admin API for browser-side tests (/media/*): the four catalogs, image, speech and
// transcription calls, and the video jobs. It wraps a harness's FakeBackend (everything else is delegated to it, and
// `backend.plugin.up / installed` apply here too) and hands out a plugin client and the typed PluginMedia over the wrapped
// fetch. It speaks the route table's error codes and answers in the shapes of contracts-media.ts, so the browser code is
// exercised against what the plugin really answers; it never touches src/domain/media.ts (whose estimators belong to the
// server side of the stage): prices come from the models a test seeds.
import { createPluginClient } from '../../src/host/plugin-client';
import type { PluginClient } from '../../src/host/plugin-client';
import { createPluginMedia } from '../../src/host/plugin-media';
import type { PluginMedia } from '../../src/host/plugin-media';
import { MEDIA_MEDIA } from '../../src/shared/contracts-media';
import type {
    ImageResult,
    MediaCost,
    MediaModel,
    Medium,
    SttResult,
    TtsResult,
    VideoJob,
} from '../../src/shared/contracts-media';
import type { Harness } from './harness';

const PREFIX = '/api/plugins/nanovia';

/** A 1x1 transparent PNG: a real image for `<img>` and download tests. */
export const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** A few bytes that are not really audio but are valid base64. */
export const WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEA';

export interface MediaCall {
    method: string;
    /** Path and query, without the plugin prefix. */
    path: string;
    body: unknown;
}

export interface MediaFake {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    client: PluginClient;
    media: PluginMedia;
    /** What GET /media/catalog answers per medium. */
    catalogs: Record<Medium, MediaModel[]>;
    /** Where the plugin says the catalog came from. */
    source: 'live' | 'cache' | 'stale';
    /** false: the plugin answers its other routes but not /media/* (an older plugin): ST's own 404. */
    hasRoutes: boolean;
    /** false: every generation call answers 409 no_key. */
    hasKey: boolean;
    /** Fixed failures by route ('GET /media/catalog', 'POST /media/image', 'DELETE /media/video'): they answer until removed. */
    fail: Map<string, { status: number; code: string; message?: string }>;
    /** The cost every call reports. */
    cost: MediaCost;
    /** Overrides of what the generation routes answer (null = the default result). */
    imageResult: ((body: Record<string, unknown>) => ImageResult) | null;
    ttsResult: ((body: Record<string, unknown>) => TtsResult) | null;
    sttResult: ((body: Record<string, unknown>) => SttResult) | null;
    /** The plugin's video jobs, newest first. */
    jobs: VideoJob[];
    /** What GET /media/video/:id turns a job into on each call: the statuses in order, the last one repeats. */
    script: ('queued' | 'running' | 'completed' | 'failed' | 'expired')[];
    calls: MediaCall[];
    callsTo(route: string): MediaCall[];
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function failure(status: number, code: string, message = code): Response {
    return json({ error: { code, message } }, status);
}

/** A model with every field filled; a test overrides what it cares about. */
export function mediaModel(patch: Partial<MediaModel> & { id: string; medium: Medium }): MediaModel {
    return {
        name: patch.id,
        description: '',
        owner: '',
        category: '',
        tags: [],
        price: { unit: 'image', from: 0.0017, to: 0.0017, byKey: {}, raw: null },
        capabilities: {},
        params: [],
        voices: [],
        formats: [],
        maxInputImages: 0,
        subscriptionIncluded: null,
        priceIsApproximate: false,
        ...patch,
    };
}

export function costOf(patch: Partial<MediaCost> = {}): MediaCost {
    return { usd: 0.0017, source: 'response', estimateUsd: null, paymentSource: 'USD', remainingUsd: null, ...patch };
}

export function createMediaFake(h: Harness): MediaFake {
    let clock = 1_800_000_000_000;
    let nextJob = 1;
    const polled = new Map<string, number>();

    const fake: MediaFake = {
        fetch: async () => new Response('unset', { status: 500 }),
        client: undefined as unknown as PluginClient,
        media: undefined as unknown as PluginMedia,
        catalogs: { image: [], video: [], tts: [], stt: [] },
        source: 'live',
        hasRoutes: true,
        hasKey: true,
        fail: new Map(),
        cost: costOf(),
        imageResult: null,
        ttsResult: null,
        sttResult: null,
        jobs: [],
        script: ['running', 'completed'],
        calls: [],
        callsTo: (route) => fake.calls.filter((call) => `${call.method} ${call.path.split('?')[0]}`.startsWith(route)),
    };

    function modelOf(medium: Medium, id: unknown): MediaModel | null {
        return fake.catalogs[medium].find((model) => model.id === id) ?? null;
    }

    function tooLarge(value: unknown): boolean {
        return typeof value === 'string' && value.length > 4 * 1024 * 1024;
    }

    function route(method: string, full: string, body: Record<string, unknown>): Response | null {
        const [path = '', query = ''] = full.split('?');
        const params = new URLSearchParams(query);
        const failed = fake.fail.get(`${method} ${path.replace(/^(\/media\/video)\/[^/]+$/, '$1')}`);
        if (failed) return failure(failed.status, failed.code, failed.message);

        if (method === 'GET' && path === '/media/catalog') {
            const medium = MEDIA_MEDIA.find((item) => item === params.get('medium'));
            if (!medium) return failure(400, 'invalid_request', 'medium: unknown');
            return json({ medium, models: fake.catalogs[medium], fetchedAt: ++clock, source: fake.source });
        }

        const generating =
            method === 'POST' && ['/media/image', '/media/tts', '/media/stt', '/media/video'].includes(path);
        if (generating && !fake.hasKey) return failure(409, 'no_key', 'The plugin has no NanoGPT key');

        if (method === 'POST' && path === '/media/image') {
            const model = modelOf('image', body['model']);
            if (!model) return failure(400, 'invalid_request', 'model: unknown image model');
            if (typeof body['prompt'] !== 'string' || !body['prompt'].trim())
                return failure(400, 'invalid_request', 'prompt: required');
            const images = body['inputImages'];
            if (Array.isArray(images) && images.some(tooLarge))
                return failure(413, 'payload_too_large', 'inputs over 4 MB');
            if (fake.imageResult) return json(fake.imageResult(body));
            const n = typeof body['n'] === 'number' ? body['n'] : 1;
            const result: ImageResult = {
                model: model.id,
                outputs: Array.from({ length: n }, () => ({
                    kind: 'image',
                    mime: 'image/png',
                    dataBase64: PNG_BASE64,
                    bytes: 70,
                })),
                requestId: `media-image:${++clock}`,
                cost: fake.cost,
                latencyMs: 4200,
            };
            return json(result);
        }
        if (method === 'POST' && path === '/media/tts') {
            const model = modelOf('tts', body['model']);
            if (!model) return failure(400, 'invalid_request', 'model: unknown speech model');
            if (typeof body['input'] !== 'string' || !body['input'].trim())
                return failure(400, 'invalid_request', 'input: required');
            if (fake.ttsResult) return json(fake.ttsResult(body));
            const result: TtsResult = {
                model: model.id,
                audio: { kind: 'audio', mime: 'audio/x-wav', dataBase64: WAV_BASE64, bytes: 24 },
                cost: costOf({ source: 'estimate', usd: 0.000034 }),
                chars: String(body['input']).length,
                latencyMs: 1800,
            };
            return json(result);
        }
        if (method === 'POST' && path === '/media/stt') {
            const model = modelOf('stt', body['model']);
            if (!model) return failure(400, 'invalid_request', 'model: unknown transcription model');
            if (tooLarge(body['audioBase64'])) return failure(413, 'payload_too_large', 'audio over 4 MB');
            if (fake.sttResult) return json(fake.sttResult(body));
            const result: SttResult = {
                model: model.id,
                text: 'Hello, there, friend.',
                language: 'auto-detect',
                durationSec: 2,
                segments: [],
                cost: costOf({ usd: 0.00000666 }),
                latencyMs: 3300,
            };
            return json(result);
        }
        if (method === 'POST' && path === '/media/video') {
            const model = modelOf('video', body['model']);
            if (!model) return failure(400, 'invalid_request', 'model: unknown video model');
            if (typeof body['prompt'] !== 'string' || !body['prompt'].trim())
                return failure(400, 'invalid_request', 'prompt: required');
            if (tooLarge(body['imageUrl'])) return failure(413, 'payload_too_large', 'start image over 4 MB');
            const job: VideoJob = {
                id: `vid_${nextJob++}`,
                model: model.id,
                prompt: String(body['prompt']),
                status: 'queued',
                progress: null,
                createdAt: ++clock,
                updatedAt: clock,
                cost: costOf({ usd: 0.4, source: 'estimate' }),
                connectionId: null,
                output: null,
                error: null,
            };
            fake.jobs.unshift(job);
            return json(job, 202);
        }
        if (method === 'GET' && path === '/media/video') return json({ jobs: fake.jobs });

        const item = /^\/media\/video\/([^/]+)$/.exec(path);
        if (item) {
            const id = decodeURIComponent(item[1] ?? '');
            const index = fake.jobs.findIndex((job) => job.id === id);
            if (index < 0) return failure(404, 'not_found', 'no such video job');
            const job = fake.jobs[index] as VideoJob;
            if (method === 'DELETE') {
                fake.jobs.splice(index, 1);
                return json({ ok: true });
            }
            if (method === 'GET') {
                if (job.status === 'queued' || job.status === 'running') {
                    const step = polled.get(id) ?? 0;
                    polled.set(id, step + 1);
                    const next = fake.script[Math.min(step, fake.script.length - 1)] ?? 'completed';
                    const updated: VideoJob = {
                        ...job,
                        status: next,
                        updatedAt: ++clock,
                        progress: next === 'running' ? 0.5 : next === 'completed' ? 1 : job.progress,
                        output:
                            next === 'completed'
                                ? { kind: 'video', mime: 'video/mp4', url: 'https://cdn.example.test/v.mp4', file: id }
                                : null,
                        error: next === 'failed' ? 'NanoGPT could not render the video' : null,
                        cost: next === 'completed' ? costOf({ usd: 0.41, source: 'response' }) : job.cost,
                    };
                    fake.jobs[index] = updated;
                    return json(updated);
                }
                return json(job);
            }
        }
        return null;
    }

    fake.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(`${PREFIX}/media/`)) return h.backend.fetch(input, init);
        const method = (init?.method ?? 'GET').toUpperCase();
        const full = url.slice(PREFIX.length);
        let body: unknown = undefined;
        if (typeof init?.body === 'string') {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }
        fake.calls.push({ method, path: full, body });
        if (!h.backend.plugin.up) throw new TypeError('Failed to fetch');
        if (!h.backend.plugin.installed || !fake.hasRoutes) {
            return new Response('<html>Cannot GET</html>', { status: 404 });
        }
        const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        return route(method, full, record) ?? failure(404, 'not_found', 'no such route');
    };
    fake.client = createPluginClient({
        ctx: () => h.mock.context,
        log: h.log,
        fetchImpl: fake.fetch,
        ttlMs: 0,
        timeoutMs: 200,
    });
    fake.media = createPluginMedia({ client: fake.client });
    return fake;
}
