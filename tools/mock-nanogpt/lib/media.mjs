// Media routes of the mock (stage 7): the four model lists (from tools/fixtures/media, real entries), image generation, speech,
// transcription and video. Deterministic, and shaped after what the live probe of 2026-11-23 saw (docs/research/
// media-live-probe.md) where it saw something, and after the docs (docs/research/media-api.md) where it did not (video).
//
//   image    body cost = the LIST price; the billing lookup answers 1.5x for one chosen model (LIVE: rev-animated)
//   speech   answers WAV bytes as `audio/x-wav` whatever format was asked, and carries NO X-Request-ID
//   stt      `{ text, language, duration, usage: { seconds, type, cost, currency } }`, no X-Request-ID
//   video    submit 202 + `runId`; the status goes queued -> running -> completed over successive polls, in either documented
//            shape (`POST /__mock/state { videoShape: 'guide' | 'flat' }` or an `x-mock-video-shape` header); the 401 of the
//            video routes is the plain text `Invalid session`
import fs from 'node:fs';
import path from 'node:path';
import { TINY_PNG_BASE64 } from './account.mjs';
import { FIXTURES_DIR } from './catalog.mjs';
import { header, parseMultipart, randomId, sendError, sendJson } from './http.mjs';

const round = (value, digits = 8) => Number(value.toFixed(digits));

/** The four lists as the mock serves them, plus lookups. */
export function loadMedia(dir = FIXTURES_DIR) {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, 'media', file), 'utf8'));
    const lists = {
        image: read('images_models.json'),
        video: read('video_models.json'),
        tts: read('audio_models_tts.json'),
        stt: read('audio_models_stt.json'),
    };
    const byId = (medium) => new Map(lists[medium].data.map((m) => [m.id, m]));
    const maps = { image: byId('image'), video: byId('video'), tts: byId('tts'), stt: byId('stt') };
    return { lists, find: (medium, id) => maps[medium].get(id) ?? null };
}

/* ------------------------------------------------------------------------------------------------ lists */

export const imageModels = ({ res, media }) => sendJson(res, 200, media.lists.image);
export const videoModels = ({ res, media }) => sendJson(res, 200, media.lists.video);

/** GET /api/v1/audio-models?type=tts|stt|all */
export function audioModels({ res, url, media }) {
    const type = url.searchParams.get('type') ?? 'all';
    if (type === 'tts') return sendJson(res, 200, media.lists.tts);
    if (type === 'stt') return sendJson(res, 200, media.lists.stt);
    const data = [...media.lists.tts.data, ...media.lists.stt.data];
    return sendJson(res, 200, { object: 'list', data, meta: { count: data.length, filter: { type } } });
}

/* ------------------------------------------------------------------------------------------------ billing */

/** Takes `billed` USD from the balance; false when it is not there. */
function charge(state, billed) {
    if (state.balanceUsd < billed) return false;
    state.balanceUsd = round(state.balanceUsd - billed);
    return true;
}

/** The legacy error shape of `/api/*` routes: `{ error: "text", requiredBalance, status }`. */
function insufficient(res, required) {
    sendJson(res, 402, { error: 'Insufficient balance', requiredBalance: round(required), status: 402 });
}

function recordSpend(state, keyId, model, cost) {
    state.records.push({ keyId, at: Date.now(), model, cost, input: 0, output: 0, reasoning: 0 });
}

/* ------------------------------------------------------------------------------------------------ images */

/** The list price of `n` images at `size`: the exact size, else the cheapest one. */
function imagePrice(model, size, n) {
    const table = model.pricing?.per_image ?? {};
    const prices = Object.values(table).filter((p) => typeof p === 'number');
    const each = (size && table[size]) ?? (prices.length ? Math.min(...prices) : 0);
    return round(each * n);
}

/** POST /v1/images/generations, /api/v1/images/generations and /api/v1/images (same body shape on all three, LIVE). */
export function imageGenerations({ req, res, body, invalidJson, state, media, keyId }) {
    if (invalidJson || body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, 'invalid_json', 'The request body must be a JSON object');
    }
    const id = body.model ?? 'rev-animated';
    const model = media.find('image', id);
    if (!model) return sendError(res, 404, 'model_not_found', `Model '${id}' not found`);
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return sendError(res, 400, 'invalid_prompt', 'A prompt is required', { param: 'prompt' });
    }
    if (/forbidden/i.test(body.prompt)) {
        return sendError(res, 400, 'content_policy_violation', 'Your prompt was blocked by the content policy.', {
            type: 'invalid_request_error',
        });
    }
    const n = body.n ?? body.nImages ?? 1;
    const max = model.supported_parameters?.max_images ?? 1;
    if (!Number.isInteger(n) || n < 1 || n > max) {
        return sendError(res, 400, 'invalid_n', `n must be an integer from 1 to ${max}`, { param: 'n' });
    }
    const size = body.size ?? body.resolution;
    const listPrice = imagePrice(model, size, n);
    const factor = model.id === state.media.lookupFactorModel ? state.media.lookupFactor : 1;
    const billed = round(listPrice * factor);
    if (!charge(state, billed)) return insufficient(res, billed);

    // LIVE: `X-Request-ID: media-image:<uuid>:<epoch-ms>:<suffix>`, the same string as the body's `requestId`.
    const mediaId = `media-image:${randomId('', 8)}-${randomId('', 2)}:${Date.now()}:${randomId('', 3)}`;
    res.setHeader('X-Request-ID', mediaId);
    state.billing.set(mediaId, { keyId, at: Date.now(), cost: billed, input: null, output: null, reasoning: null });
    recordSpend(state, keyId, model.id, billed);
    const data = [];
    for (let i = 0; i < n; i += 1) {
        if (body.response_format === 'url') {
            const origin = `http://${header(req, 'host') ?? 'mock'}`;
            data.push({ url: `${origin}/__mock/image.png?id=${encodeURIComponent(mediaId)}&i=${i}` });
        } else data.push({ b64_json: TINY_PNG_BASE64 });
    }
    // LIVE: the body's cost is the list price, and `remainingBalance` is not reliable either.
    return sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data,
        cost: listPrice,
        paymentSource: 'USD',
        remainingBalance: round(state.balanceUsd),
        requestId: mediaId,
    });
}

/** GET /__mock/image.png: what a `response_format: "url"` answer points at (public). */
export function imageFile({ res }) {
    const png = Buffer.from(TINY_PNG_BASE64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
    res.end(png);
}

/* ------------------------------------------------------------------------------------------------ speech */

/** A deterministic mono 8-bit 8 kHz WAV of `seconds` seconds (silence). */
export function tinyWav(seconds) {
    const rate = 8000;
    const samples = Math.max(1, Math.round(seconds * rate));
    const wav = Buffer.alloc(44 + samples, 128);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(36 + samples, 4);
    wav.write('WAVEfmt ', 8, 'latin1');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); // PCM
    wav.writeUInt16LE(1, 22); // mono
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate, 28); // byte rate
    wav.writeUInt16LE(1, 32); // block align
    wav.writeUInt16LE(8, 34); // bits
    wav.write('data', 36, 'latin1');
    wav.writeUInt32LE(samples, 40);
    return wav;
}

/** USD per character of a speech model (per 1k chars, per generation, or 0). */
function speechCost(model, chars) {
    const p = model.pricing ?? {};
    if (typeof p.per_thousand_chars === 'number' && p.per_thousand_chars > 0)
        return round((chars / 1000) * p.per_thousand_chars);
    if (typeof p.per_generation === 'number') return round(p.per_generation);
    return 0;
}

/** POST /v1/audio/speech (and /api/v1/audio/speech): audio bytes, WAV whatever the requested format, no request id. */
export function speech({ res, body, invalidJson, state, media, keyId }) {
    if (invalidJson || body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, 'invalid_json', 'The request body must be a JSON object');
    }
    const model = media.find('tts', body.model);
    if (!model) return sendError(res, 400, 'invalid_model', `Model '${body.model}' is not a text-to-speech model`);
    if (typeof body.input !== 'string' || !body.input.trim()) {
        return sendError(res, 400, 'invalid_request', 'input is required', { param: 'input' });
    }
    const voices = model.supported_parameters?.voices ?? [];
    if (body.voice !== undefined && voices.length > 0 && !voices.includes(body.voice)) {
        return sendError(res, 400, 'invalid_voice', `Voice '${body.voice}' is not available for this model`, {
            param: 'voice',
        });
    }
    const chars = [...body.input].length;
    const cost = speechCost(model, chars);
    if (!charge(state, cost)) return insufficient(res, cost);
    recordSpend(state, keyId, model.id, cost);
    const wav = tinyWav(Math.min(5, Math.max(0.25, chars * 0.05)));
    // LIVE: no X-Request-ID on speech (the mock's blanket header is taken off), and the format asked for is not honoured.
    res.removeHeader('X-Request-ID');
    res.writeHead(200, { 'Content-Type': 'audio/x-wav', 'Content-Length': wav.length });
    return void res.end(wav);
}

/* ------------------------------------------------------------------------------------------------ transcription */

/** Seconds of a WAV from its header (a rough 1 s per 16 kB for anything else). */
function audioSeconds(data) {
    if (data.length > 44 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WAVE') {
        const byteRate = data.readUInt32LE(28);
        if (byteRate > 0) return Math.max(1, Math.ceil((data.length - 44) / byteRate));
    }
    return Math.max(1, Math.ceil(data.length / 16000));
}

/** POST /v1/audio/transcriptions (and /api/v1/audio/transcriptions): multipart `file` + `model`. */
export function transcriptions({ req, res, raw, state, media, keyId }) {
    const form = parseMultipart(raw, header(req, 'content-type'));
    const file = form.files.find((f) => f.name === 'file');
    if (!file || file.data.length === 0)
        return sendError(res, 400, 'invalid_request', 'file is required', { param: 'file' });
    const model = media.find('stt', form.fields.model);
    if (!model)
        return sendError(res, 400, 'invalid_model', `Model '${form.fields.model}' is not a transcription model`);
    const seconds = Number(header(req, 'x-mock-duration')) || audioSeconds(file.data);
    const p = model.pricing ?? {};
    const cost = round(
        typeof p.per_minute === 'number' ? (p.per_minute * seconds) / 60 : (p.per_second ?? 0) * seconds,
        10,
    );
    if (!charge(state, cost)) return insufficient(res, cost);
    recordSpend(state, keyId, model.id, cost);
    res.removeHeader('X-Request-ID'); // LIVE: none on transcription either
    const text = 'Hello, there, friend.';
    if (form.fields.response_format === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return void res.end(text);
    }
    return sendJson(res, 200, {
        text,
        language: 'auto-detect',
        duration: seconds,
        ...(form.fields.response_format === 'verbose_json'
            ? { segments: [{ id: 0, start: 0, end: seconds, text }] }
            : {}),
        usage: { seconds, type: 'duration', cost, currency: 'USD' },
    });
}

/* ------------------------------------------------------------------------------------------------ video */

/** What the mock charges at submit: per second by resolution, per duration, per video, else a flat figure. */
function videoCost(model, body) {
    const p = model.pricing ?? {};
    const seconds = Number(body.duration) || 5;
    const table = p.per_second_by_resolution ?? (typeof p.per_second === 'object' ? p.per_second : null);
    if (table) {
        const values = Object.values(table).filter((v) => typeof v === 'number');
        return round((table[body.resolution] ?? Math.min(...values)) * seconds);
    }
    if (p.per_duration)
        return round(p.per_duration[String(Math.round(seconds))] ?? Math.min(...Object.values(p.per_duration)));
    if (typeof p.per_video === 'number') return round(p.per_video);
    if (typeof p.per_second === 'number') return round(p.per_second * seconds);
    return 0.5;
}

/** POST /api/generate-video: 202 with a `runId` (DOC). The 401 is plain text (LIVE). */
export function videoSubmit({ req, res, body, invalidJson, state, media, keyId }) {
    if (invalidJson || body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, 'invalid_json', 'The request body must be a JSON object');
    }
    const model = media.find('video', body.model);
    if (!model) return sendError(res, 400, 'invalid_model', `Model '${body.model}' is not a video model`);
    if (!body.prompt && !body.imageUrl && !body.imageDataUrl) {
        return sendError(res, 400, 'missing_prompt', 'A prompt or an image is required', { param: 'prompt' });
    }
    if (/forbidden/i.test(String(body.prompt ?? ''))) {
        return sendJson(res, 400, {
            error: { message: 'Your prompt was blocked by the content policy.', type: 'CONTENT_POLICY_VIOLATION' },
            refundMessage: 'You were not charged.',
        });
    }
    const cost = videoCost(model, body);
    if (!charge(state, cost)) return insufficient(res, cost);
    recordSpend(state, keyId, model.id, cost);
    const runId = randomId('vid_', 8);
    const fail = header(req, 'x-mock-video-fail') !== undefined || /failjob/i.test(String(body.prompt ?? ''));
    state.videos.set(runId, { keyId, model: model.id, at: Date.now(), polls: 0, cost, fail });
    return sendJson(res, 202, {
        runId,
        id: runId,
        status: 'pending',
        model: model.id,
        cost,
        paymentSource: 'USD',
        remainingBalance: round(state.balanceUsd),
        prechargeLabel: 'Estimated charge',
    });
}

/** The tiny "video": an ftyp box and 4 kB of a counting pattern (so a byte range has something to slice). */
export function tinyMp4() {
    const ftyp = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
    const pattern = Buffer.alloc(4096);
    for (let i = 0; i < pattern.length; i += 1) pattern[i] = i % 251;
    const mdat = Buffer.alloc(8);
    mdat.writeUInt32BE(8 + pattern.length, 0);
    mdat.write('mdat', 4, 'latin1');
    return Buffer.concat([ftyp, mdat, pattern]);
}

/** GET /api/video/status?requestId=: queued, then running, then completed, in the shape the mock is switched to. */
export function videoStatus({ req, res, url, state, keyId }) {
    const id = url.searchParams.get('requestId') ?? url.searchParams.get('runId') ?? '';
    const job = state.videos.get(id);
    if (!job || job.keyId !== keyId) return sendJson(res, 404, { error: 'Video generation request not found' });
    job.polls += 1;
    const total = state.media.videoPollsToComplete;
    const done = job.polls >= total;
    const phase = done ? (job.fail ? 'failed' : 'completed') : job.polls === 1 ? 'queued' : 'running';
    if (done && job.fail && !job.refunded) {
        job.refunded = true;
        state.balanceUsd = round(state.balanceUsd + job.cost);
    }
    const shape = header(req, 'x-mock-video-shape') ?? state.media.videoShape;
    const origin = `http://${header(req, 'host') ?? 'mock'}`;
    const link = `/api/generate-video/content?runId=${id}&expires=${Date.now() + 86_400_000}&sig=mock`;
    const videoUrl = phase === 'completed' ? (state.media.videoRelativeUrl ? link : `${origin}${link}`) : null;
    const finalCost = round(job.cost * 1.1);
    const progress = phase === 'queued' ? 0 : phase === 'running' ? Math.round((100 * job.polls) / total) : 100;
    if (shape === 'flat') {
        return sendJson(res, 200, {
            requestId: id,
            status: { queued: 'queued', running: 'processing', completed: 'completed', failed: 'failed' }[phase],
            progress: phase === 'queued' ? null : progress,
            estimatedTimeRemaining: null,
            videoUrl,
            error: phase === 'failed' ? 'Generation failed upstream' : null,
            createdAt: new Date(job.at).toISOString(),
            completedAt: done ? new Date().toISOString() : null,
        });
    }
    return sendJson(res, 200, {
        requestId: id,
        model: job.model,
        data: {
            status: { queued: 'IN_QUEUE', running: 'IN_PROGRESS', completed: 'COMPLETED', failed: 'FAILED' }[phase],
            requestId: id,
            ...(videoUrl
                ? { output: { video: { url: videoUrl }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } }
                : {}),
            ...(phase === 'completed' ? { cost: finalCost } : {}),
            ...(phase === 'failed'
                ? { error: 'Generation failed upstream', userFriendlyError: 'The video could not be made' }
                : {}),
        },
    });
}

/** GET /api/generate-video/content: the file behind a signed link; public (works without a key, DOC). */
export function videoContent({ res, url, state }) {
    const id = url.searchParams.get('runId') ?? '';
    if (state.media.videoContentGone || !state.videos.has(id)) {
        return sendError(res, 404, 'not_found', 'This video is no longer available');
    }
    const mp4 = tinyMp4();
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length });
    return void res.end(mp4);
}
