// Stage 0.7 contracts (media: image, video, text-to-speech, speech-to-text). Types only; the only import is nothing.
// The pure logic (normalising NanoGPT's three model lists, estimating a price) lives in src/domain/media.ts.
//
// What the live probe of 2026-11-23 and the doc review (docs/research/media-api.md, docs/research/media-live-probe.md, docs/research/st-media-seams.md) established:
//   - NanoGPT's media model lists are heterogeneous: `pricing` and `supported_parameters` differ per model and per medium
//     (arrays, ranges, ad hoc objects). The domain layer turns them into MediaPrice / ParamSpec and never trusts a shape.
//   - Image routes `POST /v1/images/generations` and `POST /api/v1/images` both answered
//     `{ created, data:[{ b64_json | url }], cost, paymentSource, remainingBalance, requestId }` and an `X-Request-ID`
//     header (`media-image:…`). Large outputs may come back as `url` instead of `b64_json`: handle both.
//   - THE `cost` OF AN IMAGE RESPONSE IS THE LIST PRICE AND CAN UNDERSTATE THE CHARGE (live: 0.0017 in the body, 0.00255
//     billed, confirmed by `GET /api/v1/usage/requests/{id}` and by the balance). The authoritative figure is the per-request
//     billing lookup (a few seconds later); the body figure is an estimate until reconciled (MediaCost.source).
//   - TTS (`POST /v1/audio/speech`) answers raw audio bytes with the model's own content type (Kokoro: audio/x-wav even
//     for `response_format: mp3`) and no request id; STT (`POST /v1/audio/transcriptions`, multipart `file`) answers
//     `{ text, language, duration, usage:{ seconds, type, cost, currency } }`. Neither carries an `X-Request-ID`.
//   - Video: submit `POST /api/generate-video` (202, `runId`), poll `GET /api/video/status?requestId=`; the status is
//     documented in two incompatible shapes (uppercase `data.status` + `data.output.video.url` vs flat lowercase `status` +
//     `videoUrl`): accept both. There is no cancel. Error bodies may be plain text.
//   - Keys: media goes to https://api.nano-gpt.com (the website host rejects bodies over ~4.5 MB).
//
// Cost model of the whole stage: every media call writes a UsageRecord (contracts.ts) with `medium` and `units`; the cost
// is the response's own figure at first and is corrected from the billing lookup when one exists (an `adjust` line in the
// usage log). The pay-as-you-go equivalent rules of the chat stage apply unchanged and `equivalentUsd` never counts toward
// any cap.

/* ------------------------------------------------------------------------------------------------ models */

export type Medium = 'image' | 'video' | 'tts' | 'stt';

export const MEDIA_MEDIA: readonly Medium[] = ['image', 'video', 'tts', 'stt'];

/** What one unit of price is. `unknown`: the model list gave a price shape we do not understand (`MediaPrice.raw` has it). */
export type PriceUnit =
    | 'image'
    | 'megapixel'
    | 'second'
    | 'minute'
    | 'thousand_chars'
    | 'thousand_bytes'
    | 'million_tokens'
    | 'request'
    | 'unknown';

export interface MediaPrice {
    unit: PriceUnit;
    /** The cheapest figure the list gives (USD per `unit`); null when none could be read. */
    from: number | null;
    /** The dearest; equals `from` for a flat price. */
    to: number | null;
    /** Named prices when the list has several (`{ '1024x1024': 0.0034 }`, `{ '5s': 0.4 }`, `{ prompt, completion }`). */
    byKey: Record<string, number>;
    /** The price as the list sent it, only when `unit` is `unknown` (so the UI can show it as text). */
    raw: unknown;
}

export type ParamType = 'enum' | 'range' | 'integer' | 'number' | 'boolean' | 'text' | 'unknown';

/** One setting a model accepts, normalised from `supported_parameters`. */
export interface ParamSpec {
    /** The request field (`size`, `aspect_ratio`, `duration`, `seed`, `negative_prompt`, `voice`, `speed` …). */
    key: string;
    type: ParamType;
    /** For `enum`. */
    values?: string[];
    /** For `range`, `integer`, `number`. */
    min?: number;
    max?: number;
    step?: number;
    default?: string | number | boolean | null;
    required?: boolean;
}

export interface MediaCapabilities {
    textToImage?: boolean;
    imageToImage?: boolean;
    inpainting?: boolean;
    textToVideo?: boolean;
    imageToVideo?: boolean;
    videoToVideo?: boolean;
    audioInput?: boolean;
    voiceCloning?: boolean;
    streaming?: boolean;
    diarization?: boolean;
    /** The model makes music, not speech (the `type=tts` list mixes both). */
    music?: boolean;
    /** The list flags it as adult-capable (`capabilities.nsfw`). */
    nsfw?: boolean;
}

export interface MediaModel {
    id: string;
    medium: Medium;
    name: string;
    description: string;
    /** `owned_by`, empty when unknown. */
    owner: string;
    category: string;
    tags: string[];
    price: MediaPrice;
    capabilities: MediaCapabilities;
    params: ParamSpec[];
    /** TTS: the voice names the list offers (names only; there is no language/gender/preview metadata). */
    voices: string[];
    /** TTS: output formats the list names; empty = unknown (do not assume mp3). */
    formats: string[];
    /** Image/video: how many input images the model takes; 0 or absent = none. */
    maxInputImages: number;
    /** The list says the subscription includes it; null = not stated (do not read absence as "no"). */
    subscriptionIncluded: boolean | null;
    /** Video only: a duration/resolution in the list drives the price and could not be reduced to a flat figure. */
    priceIsApproximate: boolean;
}

/* ------------------------------------------------------------------------------------------------ requests, results */

/** Which key and billing a media call uses; both optional (the active key, automatic billing). */
export interface MediaCallOptions {
    /** An id from GET /keys; absent = the active key. */
    keyId?: string | null;
    /** The connection whose label the usage record carries (spend by connection); absent = none. */
    connectionId?: string | null;
    /** 'paygo' sends `X-Billing-Mode: paygo`; whether NanoGPT honours it on media is unverified. */
    billing?: 'auto' | 'paygo';
}

export interface MediaOutput {
    kind: 'image' | 'video' | 'audio';
    /** The real content type (never assumed from the requested format). */
    mime: string;
    /** Inline bytes. At most one of `dataBase64` and `url` is set; the plugin never fetches `url` for an image/audio call. */
    dataBase64?: string;
    url?: string;
    bytes?: number;
    /** Video: the plugin's copy of the file, `GET /media/files/:id` (set when the job completed and the file was saved). */
    file?: string;
}

export type CostSource =
    /** The figure the response body carried (images, STT, video submit): a list-price estimate for images. */
    | 'response'
    /** Corrected from GET /api/v1/usage/requests/{id}: what NanoGPT billed. */
    | 'lookup'
    /** Computed from the catalog price only. */
    | 'estimate'
    | 'unknown';

export interface MediaCost {
    /** USD; null when nothing is known. For `source: 'response'` on images this can be below the real charge. */
    usd: number | null;
    source: CostSource;
    /** The catalog-based estimate made before the call, for the "estimated vs billed" display; null when not computable. */
    estimateUsd: number | null;
    /** NanoGPT's `paymentSource` ('USD', 'XNO', subscription label …) when the body said; null otherwise. */
    paymentSource: string | null;
    /** Balance after the call when the body said. */
    remainingUsd: number | null;
}

export interface ImageRequest extends MediaCallOptions {
    model: string;
    prompt: string;
    negativePrompt?: string;
    /** Images wanted, default 1. */
    n?: number;
    /** `WxH` (`1024x1024`) or a size token the model's list names. */
    size?: string;
    aspectRatio?: string;
    seed?: number;
    steps?: number;
    guidance?: number;
    /** Data URLs (`data:image/png;base64,…`) or https URLs; image-to-image / references. */
    inputImages?: string[];
    /** Data URL of a mask for edits. */
    mask?: string;
    /** Anything else a model's ParamSpec names; passed through after the plugin drops keys the model does not list. */
    extra?: Record<string, unknown>;
}

export interface ImageResult {
    model: string;
    outputs: MediaOutput[];
    /** The `X-Request-ID` / body `requestId` (the key of the billing lookup); null when NanoGPT gave none. */
    requestId: string | null;
    cost: MediaCost;
    latencyMs: number;
}

export interface TtsRequest extends MediaCallOptions {
    model: string;
    input: string;
    voice?: string;
    /** Requested format; the answer's `mime` says what came back. */
    format?: string;
    speed?: number;
    /** Style instructions for models that take them (`gpt-4o-mini-tts` family). */
    instructions?: string;
    extra?: Record<string, unknown>;
}

export interface TtsResult {
    model: string;
    audio: MediaOutput;
    cost: MediaCost;
    /** Characters billed on (the request's input length), for the usage record's `units`. */
    chars: number;
    latencyMs: number;
}

export interface SttRequest extends MediaCallOptions {
    model: string;
    /** The recording, base64 (no data-URL prefix). */
    audioBase64: string;
    filename: string;
    mime: string;
    language?: string;
    prompt?: string;
    /** Models that return speaker labels. */
    diarize?: boolean;
    extra?: Record<string, unknown>;
}

export interface SttSegment {
    start: number | null;
    end: number | null;
    text: string;
    speaker: string | null;
}

export interface SttResult {
    model: string;
    text: string;
    /** `auto-detect` or an ISO code as NanoGPT said; empty when unknown. */
    language: string;
    durationSec: number | null;
    segments: SttSegment[];
    cost: MediaCost;
    latencyMs: number;
}

export interface VideoRequest extends MediaCallOptions {
    model: string;
    prompt: string;
    /** Data URL or https URL (image-to-video). */
    imageUrl?: string;
    /** Seconds, when the model's ParamSpec has `duration`. */
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    seed?: number;
    extra?: Record<string, unknown>;
}

export type VideoStatus = 'queued' | 'running' | 'completed' | 'failed' | 'expired';

/** A video job as the plugin tracks it (persisted in the user's data dir; survives a restart). */
export interface VideoJob {
    /** NanoGPT's `runId` (`vid_…`). */
    id: string;
    model: string;
    prompt: string;
    status: VideoStatus;
    /** 0..1 when NanoGPT said, else null. */
    progress: number | null;
    createdAt: number;
    updatedAt: number;
    /** The submit-time estimate / pre-charge and the final cost when completed (`MediaCost.source` says which). */
    cost: MediaCost;
    connectionId: string | null;
    /** Set when completed: the file URL and, once saved, the plugin's own copy. */
    output: MediaOutput | null;
    /** A message without secrets when failed/expired. */
    error: string | null;
}

/* ------------------------------------------------------------------------------------------------ admin API */
// Served by the plugin under PLUGIN_ADMIN_BASE (behind ST's session and CSRF check), JSON in and out unless noted.
// Errors as in contracts.ts (`{ error: { code, message } }`); codes added by this stage:
//   400 invalid_request (bad body, unknown model for the medium), 409 no_key, 413 payload_too_large (inputs over the
//   4 MB the upstream accepts), 429 rate_limited, 502 media_unavailable (catalog, no live data and no stored copy),
//   502 upstream_error (NanoGPT refused or failed: `message` carries its own text, no secrets), 504 upstream_timeout,
//   402 insufficient_balance (NanoGPT said so; `message` carries the required amount when it gave one),
//   400 content_policy_violation (NanoGPT blocked the prompt; not charged).
//
//   GET    /media/catalog?medium=image|video|tts|stt   -> MediaCatalogResponse        (`&refresh=1` forces a fetch)
//   POST   /media/image                                -> ImageResult                 (body ImageRequest)
//   POST   /media/tts                                  -> TtsResult                   (body TtsRequest)
//   POST   /media/stt                                  -> SttResult                   (body SttRequest, JSON with base64)
//   POST   /media/video                                -> VideoJob                    (body VideoRequest; submit)
//   GET    /media/video                                -> { jobs: VideoJob[] }        (newest first)
//   GET    /media/video/:id                            -> VideoJob                    (polls NanoGPT while not terminal)
//   DELETE /media/video/:id                            -> { ok: true }                (forgets the job and its saved file)
//   GET    /media/files/:id                            -> the saved video bytes (video/mp4), `Range` supported
//
// Proxy side (the connection token, on the proxy port, OpenAI-shaped so ST's own TTS "OpenAI Compatible" provider and
// other clients work against a Nanovia URL):
//   POST /c/<id>/v1/audio/speech          body as OpenAI (`model`, `input`, `voice`, `response_format`, `speed`); the answer is
//                                         the upstream audio bytes with the upstream content type, an `X-Nanovia-Cost` header
//                                         when a cost is known, and a usage record
//   POST /c/<id>/v1/audio/transcriptions  multipart `file` (+ `model`, `language`, `prompt`, `response_format`); upstream JSON
//   POST /c/<id>/v1/images/generations    body as OpenAI; upstream JSON (`b64_json` / `url`), usage record, cost reconciled later
// `model` must come from the request body here (a connection's own `modelId` is a chat model).

export interface MediaCatalogResponse {
    medium: Medium;
    models: MediaModel[];
    fetchedAt: number;
    source: 'live' | 'cache' | 'stale';
}

/* ------------------------------------------------------------------------------------------------ public API */

/** `NANOVIA_API.media` (feature 'media'): what other extensions (Maestro, NAI Studio …) call. Every call resolves to a result, none throws. */
export type MediaApiResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface MediaApi {
    /** The models of a medium as loaded now (no network); `[]` before the first load. */
    models(medium: Medium): MediaModel[];
    /** Loads (or reuses) the catalog of a medium. */
    catalog(medium: Medium, options?: { refresh?: boolean }): Promise<MediaApiResult<MediaModel[]>>;
    generateImage(request: ImageRequest): Promise<MediaApiResult<ImageResult>>;
    speak(request: TtsRequest): Promise<MediaApiResult<TtsResult>>;
    transcribe(request: SttRequest): Promise<MediaApiResult<SttResult>>;
    startVideo(request: VideoRequest): Promise<MediaApiResult<VideoJob>>;
    videoStatus(id: string): Promise<MediaApiResult<VideoJob>>;
}
