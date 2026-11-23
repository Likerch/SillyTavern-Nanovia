// Typed calls of the stage 0.7 admin routes (src/shared/contracts-media.ts, "admin API"): the four media catalogs, image,
// speech and transcription calls, and the video jobs. Built on the plugin client's raw `request`, so the same rules hold:
// nothing throws, a dead plugin is an ordinary error value, and an answer that is not what the contract says becomes
// `invalid_response` instead of a half-filled object. On top of that the error codes of the route table are mapped to a
// small closed set of kinds the UI switches on.
//
// Media bodies are big (base64 images and audio), so the calls get generous time limits of their own. The one binary route
// (`GET /media/files/:id`, the saved video) is never read here: `mediaFileUrl` only builds its URL for a `<video src>`.
import { isRecord } from '../domain/usage';
import { PLUGIN_ADMIN_BASE } from '../shared/constants';
import { MEDIA_MEDIA } from '../shared/contracts-media';
import type {
    CostSource,
    ImageRequest,
    ImageResult,
    MediaCapabilities,
    MediaCatalogResponse,
    MediaCost,
    MediaModel,
    MediaOutput,
    MediaPrice,
    Medium,
    ParamSpec,
    ParamType,
    PriceUnit,
    SttRequest,
    SttResult,
    SttSegment,
    TtsRequest,
    TtsResult,
    VideoJob,
    VideoRequest,
    VideoStatus,
} from '../shared/contracts-media';
import type { PluginClient, PluginError } from './plugin-client';

/** Why a media call failed, as a closed set the UI switches on. `code` and `message` keep the plugin's own words. */
export type MediaErrorKind =
    /** The plugin does not answer (stopped, network down). */
    | 'plugin_down'
    /** ST answered 404 to the route: the plugin is not installed, not loaded, or too old to know the media routes. */
    | 'not_installed'
    /** ST's session or CSRF check refused the call. */
    | 'forbidden'
    /** The plugin has no NanoGPT key to call with (409 no_key). */
    | 'no_key'
    /** The plugin refused the input (400 invalid_request, an unknown model for the medium …). */
    | 'invalid_request'
    /** An input over the 4 MB NanoGPT accepts (413 payload_too_large). */
    | 'too_large'
    | 'rate_limited'
    /** The catalog cannot be had: no live data and no stored copy (502 media_unavailable). */
    | 'unavailable'
    /** NanoGPT refused or failed (502 upstream_error …); `message` is its own text. */
    | 'upstream'
    /** No answer in time (the browser's limit or the plugin's 504); a generation may still have been charged. */
    | 'timeout'
    /** NanoGPT said the balance is too low (402); `requiredUsd` has the amount when it gave one. */
    | 'insufficient_balance'
    /** NanoGPT blocked the prompt (400 content_policy_violation); not charged. */
    | 'content_policy'
    /** An unknown video job or file. */
    | 'not_found'
    /** The answer was not what the contract says. */
    | 'invalid_response'
    | 'other';

export interface MediaError {
    kind: MediaErrorKind;
    /** The plugin's error code (`insufficient_balance`, `no_key` …) or the client's (`unreachable`, `http_500`). */
    code: string;
    /** The plugin's English message; for logs and details, the UI words its own text per kind. */
    message: string;
    /** HTTP status, null when there was no answer. */
    status: number | null;
    /** `insufficient_balance` only: the amount NanoGPT named, USD. */
    requiredUsd?: number;
}

export type MediaResult<T> = { ok: true; data: T } | { ok: false; error: MediaError };

/** True for the errors that mean "the plugin itself is not there", as opposed to NanoGPT or the input being the problem. */
export function isMediaPluginDown(error: MediaError): boolean {
    return error.kind === 'plugin_down' || error.kind === 'not_installed' || error.kind === 'forbidden';
}

export interface PluginMedia {
    /** GET /media/catalog; `refresh` has the plugin fetch NanoGPT's list again instead of using its copy. */
    catalog(medium: Medium, options?: { refresh?: boolean }): Promise<MediaResult<MediaCatalogResponse>>;
    image(request: ImageRequest): Promise<MediaResult<ImageResult>>;
    tts(request: TtsRequest): Promise<MediaResult<TtsResult>>;
    stt(request: SttRequest): Promise<MediaResult<SttResult>>;
    /** POST /media/video: submits a job (NanoGPT answers at once; the video takes minutes). */
    startVideo(request: VideoRequest): Promise<MediaResult<VideoJob>>;
    /** GET /media/video: the plugin's jobs, newest first, as stored (no call to NanoGPT). */
    listVideo(): Promise<MediaResult<VideoJob[]>>;
    /** GET /media/video/:id: asks NanoGPT while the job is not finished. */
    videoStatus(id: string): Promise<MediaResult<VideoJob>>;
    /** DELETE /media/video/:id: forgets the job and its saved file (NanoGPT has no cancel). */
    deleteVideo(id: string): Promise<MediaResult<true>>;
}

export interface PluginMediaDeps {
    client: Pick<PluginClient, 'request'>;
}

/** Generation calls wait for NanoGPT on the plugin's side, which can take a minute or two for images and long speech. */
export const MEDIA_CALL_TIMEOUT_MS = 120_000;
/** A video submit answers at once with a job id. */
export const VIDEO_SUBMIT_TIMEOUT_MS = 30_000;
const CATALOG_TIMEOUT_MS = 40_000;
const STATUS_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------------------------------------ the file URL */

/**
 * The URL of a saved video for `<video src>`: the plugin's files route. `output.file` is the route path the plugin gives
 * (`/media/files/<id>`, relative to the admin base), which gets the base in front; a bare id works too, and a value that
 * already is a full path or an URL is used as it is. Same origin as ST, so the session cookie goes along.
 */
export function mediaFileUrl(file: string): string {
    if (/^(?:https?:)?\/\//i.test(file)) return file;
    if (file.startsWith('/media/')) return `${PLUGIN_ADMIN_BASE}${file}`;
    if (file.startsWith('/')) return file;
    return `${PLUGIN_ADMIN_BASE}/media/files/${encodeURIComponent(file)}`;
}

/* ------------------------------------------------------------------------------------------------ reading */

function numberOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOf(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function listOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    return typeof value === 'string' ? (allowed.find((item) => item === value) ?? null) : null;
}

function invalid(what: string): MediaResult<never> {
    return {
        ok: false,
        error: { kind: 'invalid_response', code: 'invalid_response', message: `unexpected ${what}`, status: null },
    };
}

const PRICE_UNITS: readonly PriceUnit[] = [
    'image',
    'megapixel',
    'second',
    'minute',
    'thousand_chars',
    'thousand_bytes',
    'million_tokens',
    'request',
    'unknown',
];
const PARAM_TYPES: readonly ParamType[] = ['enum', 'range', 'integer', 'number', 'boolean', 'text', 'unknown'];
const COST_SOURCES: readonly CostSource[] = ['response', 'lookup', 'estimate', 'unknown'];
const VIDEO_STATUSES: readonly VideoStatus[] = ['queued', 'running', 'completed', 'failed', 'expired'];
const OUTPUT_KINDS = ['image', 'video', 'audio'] as const;
const CAPABILITY_KEYS: readonly (keyof MediaCapabilities)[] = [
    'textToImage',
    'imageToImage',
    'inpainting',
    'textToVideo',
    'imageToVideo',
    'videoToVideo',
    'audioInput',
    'voiceCloning',
    'streaming',
    'diarization',
    'music',
    'nsfw',
];

export function parsePrice(raw: unknown): MediaPrice {
    const source = isRecord(raw) ? raw : {};
    const byKey: Record<string, number> = {};
    if (isRecord(source['byKey'])) {
        for (const [key, value] of Object.entries(source['byKey'])) {
            const figure = numberOf(value);
            if (figure !== null) byKey[key] = figure;
        }
    }
    const unit = pick(source['unit'], PRICE_UNITS) ?? 'unknown';
    return {
        unit,
        from: numberOf(source['from']),
        to: numberOf(source['to']),
        byKey,
        raw: unit === 'unknown' ? (source['raw'] ?? null) : null,
    };
}

export function parseParam(raw: unknown): ParamSpec | null {
    if (!isRecord(raw)) return null;
    const key = textOf(raw['key']);
    if (!key) return null;
    const spec: ParamSpec = { key, type: pick(raw['type'], PARAM_TYPES) ?? 'unknown' };
    if (Array.isArray(raw['values'])) spec.values = raw['values'].map((value) => String(value));
    for (const field of ['min', 'max', 'step'] as const) {
        const figure = numberOf(raw[field]);
        if (figure !== null) spec[field] = figure;
    }
    const fallback = raw['default'];
    if (typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean') {
        spec.default = fallback;
    } else if (fallback === null) spec.default = null;
    if (typeof raw['required'] === 'boolean') spec.required = raw['required'];
    return spec;
}

function parseCapabilities(raw: unknown): MediaCapabilities {
    const capabilities: MediaCapabilities = {};
    if (!isRecord(raw)) return capabilities;
    for (const key of CAPABILITY_KEYS) {
        if (typeof raw[key] === 'boolean') capabilities[key] = raw[key];
    }
    return capabilities;
}

/** One model of a catalog. null when it has no id (or names a medium that does not exist). */
export function parseMediaModel(raw: unknown, fallbackMedium?: Medium): MediaModel | null {
    if (!isRecord(raw)) return null;
    const id = textOf(raw['id'])?.trim();
    if (!id) return null;
    const medium = pick(raw['medium'], MEDIA_MEDIA) ?? fallbackMedium ?? null;
    if (medium === null) return null;
    const params: ParamSpec[] = [];
    if (Array.isArray(raw['params'])) {
        for (const item of raw['params']) {
            const spec = parseParam(item);
            if (spec) params.push(spec);
        }
    }
    const maxInput = numberOf(raw['maxInputImages']);
    return {
        id,
        medium,
        name: textOf(raw['name'])?.trim() || id,
        description: textOf(raw['description']) ?? '',
        owner: textOf(raw['owner']) ?? '',
        category: textOf(raw['category']) ?? '',
        tags: listOf(raw['tags']),
        price: parsePrice(raw['price']),
        capabilities: parseCapabilities(raw['capabilities']),
        params,
        voices: listOf(raw['voices']),
        formats: listOf(raw['formats']),
        maxInputImages: maxInput !== null && maxInput > 0 ? Math.floor(maxInput) : 0,
        subscriptionIncluded: typeof raw['subscriptionIncluded'] === 'boolean' ? raw['subscriptionIncluded'] : null,
        priceIsApproximate: raw['priceIsApproximate'] === true,
    };
}

export function parseCatalogResponse(raw: unknown, medium: Medium, now: number): MediaCatalogResponse | null {
    if (!isRecord(raw) || !Array.isArray(raw['models'])) return null;
    const seen = new Set<string>();
    const models: MediaModel[] = [];
    for (const item of raw['models']) {
        const model = parseMediaModel(item, medium);
        // A list that mixes media is not ours to show under this one.
        if (!model || model.medium !== medium || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
    }
    return {
        medium,
        models,
        fetchedAt: numberOf(raw['fetchedAt']) ?? now,
        source: pick(raw['source'], ['live', 'cache', 'stale'] as const) ?? 'live',
    };
}

export function parseCost(raw: unknown): MediaCost {
    const source = isRecord(raw) ? raw : {};
    return {
        usd: numberOf(source['usd']),
        source: pick(source['source'], COST_SOURCES) ?? 'unknown',
        estimateUsd: numberOf(source['estimateUsd']),
        paymentSource: textOf(source['paymentSource']),
        remainingUsd: numberOf(source['remainingUsd']),
    };
}

/** One piece of output; null when it carries neither bytes nor a URL (nothing to show). */
export function parseOutput(raw: unknown): MediaOutput | null {
    if (!isRecord(raw)) return null;
    const kind = pick(raw['kind'], OUTPUT_KINDS);
    if (kind === null) return null;
    const dataBase64 = textOf(raw['dataBase64']);
    const url = textOf(raw['url']);
    const file = textOf(raw['file']);
    if (!dataBase64 && !url && !file) return null;
    const output: MediaOutput = { kind, mime: textOf(raw['mime']) || 'application/octet-stream' };
    if (dataBase64) output.dataBase64 = dataBase64;
    else if (url) output.url = url;
    const bytes = numberOf(raw['bytes']);
    if (bytes !== null && bytes >= 0) output.bytes = bytes;
    if (file) output.file = file;
    return output;
}

export function parseImageResult(raw: unknown): ImageResult | null {
    if (!isRecord(raw) || !Array.isArray(raw['outputs'])) return null;
    const outputs = raw['outputs'].map(parseOutput).filter((item): item is MediaOutput => item !== null);
    if (outputs.length === 0) return null;
    return {
        model: textOf(raw['model']) ?? '',
        outputs,
        requestId: textOf(raw['requestId']) || null,
        cost: parseCost(raw['cost']),
        latencyMs: numberOf(raw['latencyMs']) ?? 0,
    };
}

export function parseTtsResult(raw: unknown): TtsResult | null {
    if (!isRecord(raw)) return null;
    const audio = parseOutput(raw['audio']);
    if (!audio || audio.kind !== 'audio' || (!audio.dataBase64 && !audio.url)) return null;
    return {
        model: textOf(raw['model']) ?? '',
        audio,
        cost: parseCost(raw['cost']),
        chars: Math.max(0, numberOf(raw['chars']) ?? 0),
        latencyMs: numberOf(raw['latencyMs']) ?? 0,
    };
}

function parseSegment(raw: unknown): SttSegment | null {
    if (!isRecord(raw)) return null;
    const text = textOf(raw['text']);
    if (text === null) return null;
    return {
        start: numberOf(raw['start']),
        end: numberOf(raw['end']),
        text,
        speaker: textOf(raw['speaker']) || null,
    };
}

export function parseSttResult(raw: unknown): SttResult | null {
    if (!isRecord(raw)) return null;
    const text = textOf(raw['text']);
    if (text === null) return null;
    const segments: SttSegment[] = [];
    if (Array.isArray(raw['segments'])) {
        for (const item of raw['segments']) {
            const segment = parseSegment(item);
            if (segment) segments.push(segment);
        }
    }
    return {
        model: textOf(raw['model']) ?? '',
        text,
        language: textOf(raw['language']) ?? '',
        durationSec: numberOf(raw['durationSec']),
        segments,
        cost: parseCost(raw['cost']),
        latencyMs: numberOf(raw['latencyMs']) ?? 0,
    };
}

export function parseVideoJob(raw: unknown): VideoJob | null {
    if (!isRecord(raw)) return null;
    const id = textOf(raw['id'])?.trim();
    if (!id) return null;
    const progress = numberOf(raw['progress']);
    const createdAt = numberOf(raw['createdAt']) ?? 0;
    return {
        id,
        model: textOf(raw['model']) ?? '',
        prompt: textOf(raw['prompt']) ?? '',
        // An unknown word for the status is "not finished": the job keeps being polled instead of being written off.
        status: pick(raw['status'], VIDEO_STATUSES) ?? 'running',
        progress: progress === null ? null : Math.min(1, Math.max(0, progress)),
        createdAt,
        updatedAt: numberOf(raw['updatedAt']) ?? createdAt,
        cost: parseCost(raw['cost']),
        connectionId: textOf(raw['connectionId']) || null,
        output: raw['output'] === null || raw['output'] === undefined ? null : parseOutput(raw['output']),
        error: textOf(raw['error']) || null,
    };
}

/* ------------------------------------------------------------------------------------------------ errors */

/**
 * The amount an insufficient-balance message names ("required: 0.0035", "needs $0.12"), or null when it names none.
 * The plugin passes NanoGPT's figure along in its own words; only a number next to "required"/"need" or a `$` counts.
 */
export function requiredAmountOf(message: string): number | null {
    const match =
        /(?:requir\w*|need\w*)[^0-9$]{0,40}\$?\s*(\d+(?:\.\d+)?)/i.exec(message) ??
        /\$\s*(\d+(?:\.\d+)?)/.exec(message);
    if (!match) return null;
    const amount = Number(match[1]);
    return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Maps what the plugin client reports to a kind the UI switches on. */
export function mediaErrorOf(error: PluginError): MediaError {
    const base = { code: error.code, message: error.message, status: error.status };
    switch (error.code) {
        case 'unreachable':
            return { ...base, kind: 'plugin_down' };
        case 'timeout':
        case 'upstream_timeout':
            return { ...base, kind: 'timeout' };
        case 'not_installed':
            return { ...base, kind: 'not_installed' };
        case 'forbidden':
            return { ...base, kind: 'forbidden' };
        case 'invalid_response':
            return { ...base, kind: 'invalid_response' };
        case 'no_key':
            return { ...base, kind: 'no_key' };
        case 'invalid_request':
            return { ...base, kind: 'invalid_request' };
        case 'payload_too_large':
            return { ...base, kind: 'too_large' };
        case 'rate_limited':
            return { ...base, kind: 'rate_limited' };
        case 'media_unavailable':
            return { ...base, kind: 'unavailable' };
        case 'upstream_error':
        case 'upstream_unreachable':
        case 'bad_response':
            return { ...base, kind: 'upstream' };
        case 'insufficient_balance':
            return balanceError(base);
        case 'content_policy_violation':
            return { ...base, kind: 'content_policy' };
        case 'not_found':
            return { ...base, kind: 'not_found' };
        default:
            break;
    }
    // A code this client does not know: the status still says what kind of trouble it is.
    switch (error.status) {
        case 402:
            return balanceError(base);
        case 413:
            return { ...base, kind: 'too_large' };
        case 429:
            return { ...base, kind: 'rate_limited' };
        case 504:
            return { ...base, kind: 'timeout' };
        case 502:
            return { ...base, kind: 'upstream' };
        default:
            return { ...base, kind: 'other' };
    }
}

function balanceError(base: { code: string; message: string; status: number | null }): MediaError {
    const required = requiredAmountOf(base.message);
    return required === null
        ? { ...base, kind: 'insufficient_balance' }
        : { ...base, kind: 'insufficient_balance', requiredUsd: required };
}

/* ------------------------------------------------------------------------------------------------ client */

export function createPluginMedia(deps: PluginMediaDeps): PluginMedia {
    const { client } = deps;
    const now = (): number => Date.now();

    /** One call: the plugin client's result with its error mapped and its data read by `read` (null = not what we expect). */
    async function call<T>(
        method: string,
        path: string,
        options: { body?: unknown; timeoutMs: number },
        read: (data: unknown) => T | null,
        what: string,
    ): Promise<MediaResult<T>> {
        const result = await client.request(method, path, {
            ...(options.body !== undefined ? { body: options.body } : {}),
            timeoutMs: options.timeoutMs,
        });
        if (!result.ok) return { ok: false, error: mediaErrorOf(result.error) };
        const value = read(result.data);
        return value === null ? invalid(what) : { ok: true, data: value };
    }

    const jobOf = (data: unknown): VideoJob | null => parseVideoJob(data);
    const acknowledged = (data: unknown): true | null => (isRecord(data) && data['ok'] === true ? true : null);

    return {
        catalog(medium, options) {
            const path = `/media/catalog?medium=${encodeURIComponent(medium)}${options?.refresh ? '&refresh=1' : ''}`;
            return call(
                'GET',
                path,
                { timeoutMs: CATALOG_TIMEOUT_MS },
                (data) => parseCatalogResponse(data, medium, now()),
                'catalog',
            );
        },

        image(request) {
            return call(
                'POST',
                '/media/image',
                { body: request, timeoutMs: MEDIA_CALL_TIMEOUT_MS },
                parseImageResult,
                'image result',
            );
        },

        tts(request) {
            return call(
                'POST',
                '/media/tts',
                { body: request, timeoutMs: MEDIA_CALL_TIMEOUT_MS },
                parseTtsResult,
                'speech result',
            );
        },

        stt(request) {
            return call(
                'POST',
                '/media/stt',
                { body: request, timeoutMs: MEDIA_CALL_TIMEOUT_MS },
                parseSttResult,
                'transcription',
            );
        },

        startVideo(request) {
            return call(
                'POST',
                '/media/video',
                { body: request, timeoutMs: VIDEO_SUBMIT_TIMEOUT_MS },
                jobOf,
                'video job',
            );
        },

        listVideo() {
            return call(
                'GET',
                '/media/video',
                { timeoutMs: LIST_TIMEOUT_MS },
                (data) => {
                    if (!isRecord(data) || !Array.isArray(data['jobs'])) return null;
                    const jobs: VideoJob[] = [];
                    const seen = new Set<string>();
                    for (const item of data['jobs']) {
                        const job = parseVideoJob(item);
                        if (!job || seen.has(job.id)) continue;
                        seen.add(job.id);
                        jobs.push(job);
                    }
                    return jobs;
                },
                'video list',
            );
        },

        videoStatus(id) {
            return call(
                'GET',
                `/media/video/${encodeURIComponent(id)}`,
                { timeoutMs: STATUS_TIMEOUT_MS },
                jobOf,
                'video job',
            );
        },

        deleteVideo(id) {
            return call(
                'DELETE',
                `/media/video/${encodeURIComponent(id)}`,
                { timeoutMs: LIST_TIMEOUT_MS },
                acknowledged,
                'acknowledgement',
            );
        },
    };
}
