// The request side of the media stage: checking what the browser (or another extension) sends to POST /media/image, /tts,
// /stt and /video, and building what goes to NanoGPT from it. Pure: untrusted JSON in, a typed request or a one-line
// refusal out; nothing here touches the network or a file.
//
// Limits (docs/research/media-api.md §7 item 7): uploads are safe up to 4 MB; `api.nano-gpt.com` takes more but the
// documented per-route ceilings are 4 MB, so every inline input (images, mask, recording) is held to that, in total.
import type {
    ImageRequest,
    MediaCallOptions,
    MediaModel,
    SttRequest,
    TtsRequest,
    VideoRequest,
} from '../shared/contracts-media';
import { base64ByteLength, isBase64, splitDataUrl } from './media-wire';
import { isRecord } from './usage';

/** The most inline input (decoded bytes of every image, the mask or the recording together) a call may carry. */
export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_CHARS = 50_000;
export const MAX_TTS_CHARS = 100_000;
export const MAX_INPUT_IMAGES = 16;

export type Checked<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; code: string; message: string };

const invalid = (message: string): Checked<never> => ({ ok: false, status: 400, code: 'invalid_request', message });
const tooLarge = (message: string): Checked<never> => ({ ok: false, status: 413, code: 'payload_too_large', message });

/* ------------------------------------------------------------------------------------------------ field readers */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A short single-line string; undefined when absent, null when present but unusable. */
function line(value: unknown, max: number): string | undefined | null {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (s === '') return undefined;
    return s.length > max || CONTROL.test(s) ? null : s;
}

function integer(value: unknown, min: number, max: number): number | undefined | null {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function decimal(value: unknown, min: number, max: number): number | undefined | null {
    if (value === undefined || value === null) return undefined;
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Body text of any length up to `max` (a prompt may hold line breaks); undefined when absent. */
function textField(value: unknown, max: number): string | undefined | null {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return null;
    return value.length > max ? null : value;
}

/** The options every media call shares. */
function callOptions(body: Record<string, unknown>): Checked<MediaCallOptions & { model: string }> {
    const model = line(body['model'], 300);
    if (model === undefined || model === null) return invalid('"model" is required');
    const keyId = line(body['keyId'], 200);
    if (keyId === null) return invalid('"keyId" is not a key id');
    const connectionId = line(body['connectionId'], 64);
    if (connectionId === null) return invalid('"connectionId" is not a connection id');
    const billing = body['billing'];
    if (billing !== undefined && billing !== null && billing !== 'auto' && billing !== 'paygo') {
        return invalid('"billing" must be "auto" or "paygo"');
    }
    return {
        ok: true,
        value: {
            model,
            ...(keyId ? { keyId } : {}),
            ...(connectionId ? { connectionId } : {}),
            ...(billing === 'auto' || billing === 'paygo' ? { billing } : {}),
        },
    };
}

const EXTRA_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_EXTRA_KEYS = 40;
const MAX_EXTRA_JSON = 16_000;

function extraField(value: unknown): Checked<Record<string, unknown> | undefined> {
    if (value === undefined || value === null) return { ok: true, value: undefined };
    if (!isRecord(value)) return invalid('"extra" must be an object');
    const entries = Object.entries(value);
    if (entries.length > MAX_EXTRA_KEYS) return invalid('"extra" has too many fields');
    for (const [key] of entries) {
        if (!EXTRA_KEY.test(key) || key === '__proto__') return invalid('"extra" has a field name that is not allowed');
    }
    let size: number;
    try {
        size = JSON.stringify(value).length;
    } catch {
        return invalid('"extra" is not JSON');
    }
    if (size > MAX_EXTRA_JSON) return invalid('"extra" is too large');
    return { ok: true, value: { ...value } };
}

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const HTTPS_URL = /^https:\/\/[^\s]{1,2040}$/i;

/** A data URL of an image, decoded size in bytes; null when it is not one. */
function imageDataUrl(value: unknown): number | null {
    if (typeof value !== 'string' || !DATA_IMAGE.test(value)) return null;
    const { base64 } = splitDataUrl(value);
    return isBase64(base64) ? base64ByteLength(base64) : null;
}

/* ------------------------------------------------------------------------------------------------ image */

export function checkImageRequest(raw: unknown): Checked<ImageRequest> {
    if (!isRecord(raw)) return invalid('The request body must be a JSON object');
    const options = callOptions(raw);
    if (!options.ok) return options;
    const prompt = textField(raw['prompt'], MAX_PROMPT_CHARS);
    if (typeof prompt !== 'string' || prompt.trim() === '')
        return invalid('"prompt" is required (at most 50000 characters)');
    const negative = textField(raw['negativePrompt'], MAX_PROMPT_CHARS);
    const n = integer(raw['n'], 1, 100);
    const size = line(raw['size'], 40);
    const aspect = line(raw['aspectRatio'], 20);
    const seed = integer(raw['seed'], -2_147_483_648, 4_294_967_295);
    const steps = integer(raw['steps'], 1, 1000);
    const guidance = decimal(raw['guidance'], 0, 100);
    if (negative === null) return invalid('"negativePrompt" must be text');
    if (n === null) return invalid('"n" must be an integer 1..100');
    if (size === null) return invalid('"size" is not a size');
    if (aspect === null) return invalid('"aspectRatio" is not an aspect ratio');
    if (seed === null) return invalid('"seed" must be an integer');
    if (steps === null) return invalid('"steps" must be an integer 1..1000');
    if (guidance === null) return invalid('"guidance" must be a number 0..100');
    const extra = extraField(raw['extra']);
    if (!extra.ok) return extra;

    let inputBytes = 0;
    let inputImages: string[] | undefined;
    const inputs = raw['inputImages'];
    if (inputs !== undefined && inputs !== null) {
        if (!Array.isArray(inputs) || inputs.length > MAX_INPUT_IMAGES) {
            return invalid(`"inputImages" must be a list of at most ${MAX_INPUT_IMAGES} images`);
        }
        for (const item of inputs) {
            const bytes = imageDataUrl(item);
            if (bytes !== null) inputBytes += bytes;
            else if (!(typeof item === 'string' && HTTPS_URL.test(item))) {
                return invalid('"inputImages" holds data URLs of images or https URLs');
            }
        }
        inputImages = inputs as string[];
    }
    const mask = raw['mask'];
    if (mask !== undefined && mask !== null) {
        const bytes = imageDataUrl(mask);
        if (bytes === null) return invalid('"mask" must be a data URL of an image');
        inputBytes += bytes;
    }
    if (inputBytes > MAX_INPUT_BYTES) return tooLarge('The input images together are larger than 4 MB');

    return {
        ok: true,
        value: {
            ...options.value,
            prompt,
            ...(negative ? { negativePrompt: negative } : {}),
            ...(n !== undefined ? { n } : {}),
            ...(size ? { size } : {}),
            ...(aspect ? { aspectRatio: aspect } : {}),
            ...(seed !== undefined ? { seed } : {}),
            ...(steps !== undefined ? { steps } : {}),
            ...(guidance !== undefined ? { guidance } : {}),
            ...(inputImages ? { inputImages } : {}),
            ...(typeof mask === 'string' ? { mask } : {}),
            ...(extra.value ? { extra: extra.value } : {}),
        },
    };
}

/* ------------------------------------------------------------------------------------------------ speech */

export function checkTtsRequest(raw: unknown): Checked<TtsRequest> {
    if (!isRecord(raw)) return invalid('The request body must be a JSON object');
    const options = callOptions(raw);
    if (!options.ok) return options;
    const input = textField(raw['input'], MAX_TTS_CHARS);
    if (typeof input !== 'string' || input.trim() === '')
        return invalid('"input" is required (at most 100000 characters)');
    const voice = line(raw['voice'], 200);
    const format = line(raw['format'], 10);
    const speed = decimal(raw['speed'], 0.1, 5);
    const instructions = textField(raw['instructions'], 5000);
    if (voice === null) return invalid('"voice" is not a voice name');
    if (format === null || (format !== undefined && !/^[a-z0-9]{2,10}$/i.test(format)))
        return invalid('"format" is not an audio format');
    if (speed === null) return invalid('"speed" must be a number 0.1..5');
    if (instructions === null) return invalid('"instructions" must be text of at most 5000 characters');
    const extra = extraField(raw['extra']);
    if (!extra.ok) return extra;
    return {
        ok: true,
        value: {
            ...options.value,
            input,
            ...(voice ? { voice } : {}),
            ...(format ? { format: format.toLowerCase() } : {}),
            ...(speed !== undefined ? { speed } : {}),
            ...(instructions ? { instructions } : {}),
            ...(extra.value ? { extra: extra.value } : {}),
        },
    };
}

/** What counts as a character of speech for billing and the usage record: a Unicode code point. */
export function countChars(text: string): number {
    let count = 0;
    for (const _ of text) count += 1;
    return count;
}

/* ------------------------------------------------------------------------------------------------ transcription */

const MIME = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,60}$/i;

/** A file name with no path, quotes or control characters, safe inside a multipart header. */
export function safeFileName(value: string | undefined): string {
    const base = (value ?? '').split(/[\\/]/).pop() ?? '';
    const clean = base
        .replace(/[^A-Za-z0-9._ -]+/g, '_')
        .replace(/^\.+/, '')
        .trim()
        .slice(0, 120);
    return clean === '' ? 'audio' : clean;
}

export function checkSttRequest(raw: unknown): Checked<SttRequest> {
    if (!isRecord(raw)) return invalid('The request body must be a JSON object');
    const options = callOptions(raw);
    if (!options.ok) return options;
    const audio = raw['audioBase64'];
    if (typeof audio !== 'string' || audio === '') return invalid('"audioBase64" is required');
    const { base64 } = splitDataUrl(audio);
    if (!isBase64(base64)) return invalid('"audioBase64" must be base64 (without a data URL prefix)');
    const bytes = base64ByteLength(base64);
    if (bytes === 0) return invalid('"audioBase64" is empty');
    if (bytes > MAX_INPUT_BYTES) return tooLarge('The recording is larger than 4 MB');
    const filename = line(raw['filename'], 255);
    const mime = line(raw['mime'], 120);
    const language = line(raw['language'], 20);
    const prompt = textField(raw['prompt'], 2000);
    if (filename === null) return invalid('"filename" is not a file name');
    if (mime === null || (mime !== undefined && !MIME.test(mime))) return invalid('"mime" is not a content type');
    if (language === null) return invalid('"language" is not a language code');
    if (prompt === null) return invalid('"prompt" must be text of at most 2000 characters');
    const diarize = raw['diarize'];
    if (diarize !== undefined && diarize !== null && typeof diarize !== 'boolean')
        return invalid('"diarize" must be true or false');
    const extra = extraField(raw['extra']);
    if (!extra.ok) return extra;
    return {
        ok: true,
        value: {
            ...options.value,
            audioBase64: base64.replace(/\s+/g, ''),
            filename: safeFileName(filename),
            mime: (mime ?? 'application/octet-stream').toLowerCase(),
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
            ...(typeof diarize === 'boolean' ? { diarize } : {}),
            ...(extra.value ? { extra: extra.value } : {}),
        },
    };
}

/* ------------------------------------------------------------------------------------------------ video */

export function checkVideoRequest(raw: unknown): Checked<VideoRequest> {
    if (!isRecord(raw)) return invalid('The request body must be a JSON object');
    const options = callOptions(raw);
    if (!options.ok) return options;
    const prompt = textField(raw['prompt'], MAX_PROMPT_CHARS);
    if (prompt === null) return invalid('"prompt" must be text of at most 50000 characters');
    const imageUrl = raw['imageUrl'];
    let hasImage = false;
    if (imageUrl !== undefined && imageUrl !== null && imageUrl !== '') {
        if (typeof imageUrl !== 'string') return invalid('"imageUrl" must be a data URL or an https URL');
        const bytes = imageDataUrl(imageUrl);
        if (bytes !== null) {
            if (bytes > MAX_INPUT_BYTES) return tooLarge('The start image is larger than 4 MB');
        } else if (!HTTPS_URL.test(imageUrl)) return invalid('"imageUrl" must be a data URL or an https URL');
        hasImage = true;
    }
    if ((prompt ?? '').trim() === '' && !hasImage) return invalid('"prompt" is required (or an image to animate)');
    const duration = decimal(raw['duration'], 0.001, 3600);
    const aspect = line(raw['aspectRatio'], 20);
    const resolution = line(raw['resolution'], 20);
    const seed = integer(raw['seed'], -2_147_483_648, 4_294_967_295);
    if (duration === null) return invalid('"duration" must be a number of seconds');
    if (aspect === null) return invalid('"aspectRatio" is not an aspect ratio');
    if (resolution === null) return invalid('"resolution" is not a resolution');
    if (seed === null) return invalid('"seed" must be an integer');
    const extra = extraField(raw['extra']);
    if (!extra.ok) return extra;
    return {
        ok: true,
        value: {
            ...options.value,
            prompt: prompt ?? '',
            ...(hasImage ? { imageUrl: imageUrl as string } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(aspect ? { aspectRatio: aspect } : {}),
            ...(resolution ? { resolution } : {}),
            ...(seed !== undefined ? { seed } : {}),
            ...(extra.value ? { extra: extra.value } : {}),
        },
    };
}

/* ------------------------------------------------------------------------------------------------ upstream bodies */

/** Request fields a client's `extra` may never set: the plugin owns them. */
const PROTECTED = new Set([
    'model',
    'prompt',
    'input',
    'n',
    'size',
    'stream',
    'response_format',
    'billing_mode',
    'billingMode',
    'callback_url',
    'user',
]);

/**
 * `extra` reduced to what the model's list names (so a typo or a field of another model never reaches NanoGPT and costs
 * a refusal), without the fields the plugin sets itself.
 */
export function filterExtra(
    model: MediaModel | null,
    extra: Record<string, unknown> | undefined,
    alsoProtected: readonly string[] = [],
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!extra || !model) return out;
    const known = new Set(model.params.map((p) => p.key));
    for (const [key, value] of Object.entries(extra)) {
        if (!known.has(key) || PROTECTED.has(key) || alsoProtected.includes(key)) continue;
        out[key] = value;
    }
    return out;
}

/** The body of `POST /v1/images/generations` (OpenAI-compatible). Both `b64_json` and `url` are handled on the way back. */
export function buildImageBody(model: MediaModel | null, request: ImageRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...filterExtra(model, request.extra),
        model: request.model,
        prompt: request.prompt,
        n: request.n ?? 1,
        response_format: 'b64_json',
    };
    if (request.size) body['size'] = request.size;
    if (request.negativePrompt) body['negative_prompt'] = request.negativePrompt;
    if (request.aspectRatio) body['aspect_ratio'] = request.aspectRatio;
    if (request.seed !== undefined) body['seed'] = request.seed;
    if (request.steps !== undefined) body['num_inference_steps'] = request.steps;
    if (request.guidance !== undefined) body['guidance_scale'] = request.guidance;
    const inputs = request.inputImages ?? [];
    if (inputs.length === 1) body['imageDataUrl'] = inputs[0];
    else if (inputs.length > 1) body['imageDataUrls'] = inputs;
    if (request.mask) body['maskDataUrl'] = request.mask;
    return body;
}

/** The body of `POST /v1/audio/speech`. With no voice named, the model's default (else its first) voice is sent. */
export function buildTtsBody(model: MediaModel | null, request: TtsRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...filterExtra(model, request.extra, ['voice', 'speed', 'instructions']),
        model: request.model,
        input: request.input,
    };
    const spec = model?.params.find((p) => p.key === 'voice');
    const fallback = typeof spec?.default === 'string' ? spec.default : model?.voices[0];
    const voice = request.voice ?? fallback;
    if (voice) body['voice'] = voice;
    if (request.format) body['response_format'] = request.format;
    if (request.speed !== undefined) body['speed'] = request.speed;
    if (request.instructions) body['instructions'] = request.instructions;
    return body;
}

/** The body of `POST /api/generate-video`: `duration` goes as a string like the docs show (whether an integer is accepted is unverified). */
export function buildVideoBody(model: MediaModel | null, request: VideoRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...filterExtra(model, request.extra, [
            'duration',
            'aspect_ratio',
            'resolution',
            'seed',
            'imageUrl',
            'imageDataUrl',
        ]),
        model: request.model,
        prompt: request.prompt,
    };
    if (request.duration !== undefined) body['duration'] = String(request.duration);
    if (request.aspectRatio) body['aspect_ratio'] = request.aspectRatio;
    if (request.resolution) body['resolution'] = request.resolution;
    if (request.seed !== undefined) body['seed'] = request.seed;
    if (request.imageUrl) body[DATA_IMAGE.test(request.imageUrl) ? 'imageDataUrl' : 'imageUrl'] = request.imageUrl;
    return body;
}

/**
 * The text fields of the multipart body of `POST /v1/audio/transcriptions` (the recording itself is the `file` part).
 * `verbose_json` is asked for only where the model's list offers it (it brings the segments); `diarize` only for models
 * that diarize.
 */
export function buildSttFields(model: MediaModel | null, request: SttRequest): [string, string][] {
    const fields: [string, string][] = [['model', request.model]];
    if (request.language) fields.push(['language', request.language]);
    if (request.prompt) fields.push(['prompt', request.prompt]);
    const formats = model?.params.find((p) => p.key === 'response_format')?.values ?? [];
    if (formats.includes('verbose_json')) fields.push(['response_format', 'verbose_json']);
    if (request.diarize === true && model?.capabilities.diarization === true) fields.push(['diarize', 'true']);
    const taken = new Set(fields.map(([name]) => name));
    for (const [key, value] of Object.entries(filterExtra(model, request.extra, ['language', 'prompt', 'diarize']))) {
        if (taken.has(key) || value === null || typeof value === 'object') continue;
        fields.push([key, String(value)]);
    }
    return fields;
}

/** The seconds a video request asks for, when it says (for the usage record's `units`). */
export function requestedSeconds(request: Pick<VideoRequest, 'duration'>): number | null {
    return typeof request.duration === 'number' && request.duration > 0 ? request.duration : null;
}
