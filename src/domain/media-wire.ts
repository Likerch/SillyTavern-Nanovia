// What NanoGPT's media endpoints answer, read tolerantly (docs/research/media-api.md, media-live-probe.md): image bodies,
// transcription bodies, the video submit answer and the video status in BOTH documented shapes, error bodies in all three
// shapes (OpenAI envelope, legacy `{ error: "text" }`, plain text), the billing lookup, and the usage-record helpers of the
// stage (building a media record, merging `adjust` lines). Pure: no network, no Node; untrusted values in, plain values out.
//
// What was seen live (2026-11-23) and what was only read in the docs is marked per function; everything about video is
// documentation only.
import type { BillingOutcome, UsageRecord } from '../shared/contracts';
import type { CostSource, Medium, SttSegment, VideoStatus } from '../shared/contracts-media';
import { isRecord, parseCost, roundUsd } from './usage';

const MAX_TEXT = 300;

/* ------------------------------------------------------------------------------------------------ small readers */

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One printable line of at most `MAX_TEXT` characters: no control characters, no markup, runs of blanks collapsed. */
export function cleanText(value: string, limit = MAX_TEXT): string {
    return (
        value
            // eslint-disable-next-line no-control-regex
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, limit)
    );
}

/** `paymentSource` / `currency` saying the figure is not dollars (NanoGPT also bills in XNO). */
function isOtherCurrency(label: string | null): boolean {
    return label !== null && /^(xno|nano)$/i.test(label);
}

/** A USD amount that came with its currency label: `null` for a figure in another currency. */
function dollars(value: unknown, label: string | null): number | null {
    const amount = parseCost(value);
    if (amount === null) return null;
    return isOtherCurrency(label) && amount !== 0 ? null : amount;
}

/** USD as a header/log value: at most 10 decimals, trailing zeros trimmed, never an exponent (`0.00000666`). */
export function formatUsd(value: number): string {
    const fixed = roundUsd(value).toFixed(10);
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/* ------------------------------------------------------------------------------------------------ base64 helpers */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Strips a `data:<mime>;base64,` prefix; returns the bare base64 and the mime the prefix named (or null). */
export function splitDataUrl(value: string): { base64: string; mime: string | null } {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(value);
    if (!m) return { base64: value, mime: null };
    return { base64: value.slice(m[0].length), mime: m[1] ? m[1].toLowerCase() : null };
}

/** How many bytes a base64 string decodes to, without decoding it. */
export function base64ByteLength(base64: string): number {
    const clean = base64.replace(/[\s=]+$/g, '');
    return Math.floor((clean.length * 3) / 4);
}

/** True when the text is plain base64 (standard alphabet, optional padding, whitespace allowed). */
export function isBase64(value: string): boolean {
    return value.length > 0 && /^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(value);
}

/** The first bytes of a base64 string (enough to recognise a file type). */
function base64Prefix(base64: string, bytes = 12): number[] {
    const out: number[] = [];
    let acc = 0;
    let bits = 0;
    for (const ch of base64) {
        const v = B64.indexOf(ch);
        if (v < 0) break;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
            if (out.length >= bytes) break;
        }
    }
    return out;
}

const ascii = (bytes: number[], from: number, to: number): string => String.fromCharCode(...bytes.slice(from, to));

/** The image type a base64 body starts with (PNG, JPEG, GIF, WebP); null when it is none of them. */
export function sniffImageMime(base64: string): string | null {
    const b = base64Prefix(base64);
    if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 4 && ascii(b, 0, 3) === 'GIF') return 'image/gif';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

/** The image type a file name or URL path ends with; null when unknown. */
export function imageMimeFromName(name: string): string | null {
    const m = /\.(png|jpe?g|webp|gif|avif|svg)(?:[?#].*)?$/i.exec(name);
    if (!m) return null;
    const ext = (m[1] ?? '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'svg') return 'image/svg+xml';
    return `image/${ext}`;
}

/* ------------------------------------------------------------------------------------------------ image */

export interface ParsedImageOutput {
    /** Bare base64 (a `data:` prefix is stripped). */
    dataBase64?: string;
    /** The mime a `data:` prefix named. */
    mime?: string;
    url?: string;
}

export interface ParsedImageBody {
    /** Every `data[]` item that carried an image, `b64_json` or `url` (live: `b64_json`; large outputs may come as `url`). */
    outputs: ParsedImageOutput[];
    /** `cost` in USD; null when absent or paid in another currency. LIVE: this is the LIST price, it can understate the charge. */
    usd: number | null;
    paymentSource: string | null;
    /** `remainingBalance`; unreliable (LIVE) and null for a non-USD payment source. */
    remainingUsd: number | null;
    /** The body's `requestId` (LIVE: the same string as the `X-Request-ID` header, `media-image:<uuid>:...`). */
    requestId: string | null;
    /** `created`, seconds since epoch. */
    created: number | null;
}

function imageOutput(item: unknown): ParsedImageOutput | null {
    if (!isRecord(item)) return null;
    const b64 = str(item['b64_json']) ?? str(item['b64']) ?? str(item['base64']);
    if (b64) {
        const { base64, mime } = splitDataUrl(b64);
        return base64 ? { dataBase64: base64, ...(mime ? { mime } : {}) } : null;
    }
    const direct = str(item['url']);
    const nested = isRecord(item['image_url']) ? str(item['image_url']['url']) : str(item['image_url']);
    const url = direct ?? nested;
    return url ? { url } : null;
}

/** `{ created, data: [{ b64_json | url }], cost, paymentSource, remainingBalance, requestId }` (LIVE on both image routes). */
export function parseImageBody(body: unknown): ParsedImageBody {
    const empty: ParsedImageBody = {
        outputs: [],
        usd: null,
        paymentSource: null,
        remainingUsd: null,
        requestId: null,
        created: null,
    };
    if (!isRecord(body)) return empty;
    const items = Array.isArray(body['data']) ? body['data'] : [];
    const outputs: ParsedImageOutput[] = [];
    for (const item of items) {
        const output = imageOutput(item);
        if (output) outputs.push(output);
    }
    const paymentSource = str(body['paymentSource']) ?? str(body['payment_source']);
    return {
        outputs,
        usd: dollars(body['cost'], paymentSource),
        paymentSource,
        remainingUsd: dollars(body['remainingBalance'] ?? body['remaining_balance'], paymentSource),
        requestId: str(body['requestId']) ?? str(body['request_id']),
        created: num(body['created']),
    };
}

/* ------------------------------------------------------------------------------------------------ transcription */

export interface ParsedSttBody {
    text: string;
    /** `auto-detect` or an ISO code as NanoGPT said; empty when absent. */
    language: string;
    durationSec: number | null;
    segments: SttSegment[];
    /** USD; from `usage.cost` (LIVE, OpenAI-compatible route) or `metadata.cost` (native route). */
    usd: number | null;
    currency: string | null;
}

function segmentOf(item: unknown): SttSegment | null {
    if (!isRecord(item)) return null;
    const words = str(item['text']);
    if (words === null) return null;
    return {
        start: num(item['start']),
        end: num(item['end']),
        text: words,
        speaker: str(item['speaker']) ?? str(item['speaker_id']),
    };
}

function segmentsOf(value: unknown): SttSegment[] {
    if (!Array.isArray(value)) return [];
    const out: SttSegment[] = [];
    for (const item of value) {
        const segment = segmentOf(item);
        if (segment) out.push(segment);
    }
    return out;
}

/**
 * A transcription answer in either shape: the OpenAI-compatible one (LIVE: `{ text, language, duration, usage: { seconds,
 * type, cost, currency } }`, `segments` with `verbose_json`) or the native one (DOC: `{ transcription, metadata: { cost,
 * currency, actualDuration (minutes), chargedDuration, language } , diarization: { segments } }`). A bare string (the `text`
 * response format) is a transcript with nothing else. null: no transcript in it.
 */
export function parseSttBody(body: unknown): ParsedSttBody | null {
    if (typeof body === 'string') {
        return { text: body.trim(), language: '', durationSec: null, segments: [], usd: null, currency: null };
    }
    if (!isRecord(body)) return null;
    const transcript = body['text'] ?? body['transcription'] ?? body['transcript'];
    if (typeof transcript !== 'string') return null;
    const usage = isRecord(body['usage']) ? body['usage'] : {};
    const metadata = isRecord(body['metadata']) ? body['metadata'] : {};
    const currency = str(usage['currency']) ?? str(metadata['currency']) ?? str(body['currency']);
    const minutes = num(metadata['actualDuration']) ?? num(metadata['chargedDuration']);
    const diarization = isRecord(body['diarization']) ? segmentsOf(body['diarization']['segments']) : [];
    return {
        text: transcript.trim(),
        language: str(body['language']) ?? str(metadata['language']) ?? '',
        durationSec:
            num(body['duration']) ?? num(usage['seconds']) ?? (minutes !== null ? roundUsd(minutes * 60) : null),
        segments: diarization.length > 0 ? diarization : segmentsOf(body['segments']),
        usd: dollars(usage['cost'] ?? metadata['cost'] ?? body['cost'], currency),
        currency: currency ? currency.toUpperCase() : null,
    };
}

/* ------------------------------------------------------------------------------------------------ video */

export interface ParsedVideoSubmit {
    /** `runId` (DOC: `vid_...`); the key of every later call. null when the answer carried none. */
    runId: string | null;
    /** The estimate / pre-charge in USD (`cost`); null when absent or in another currency. */
    usd: number | null;
    paymentSource: string | null;
    remainingUsd: number | null;
}

/** `POST /api/generate-video` answer, HTTP 202 (DOC): `{ runId, id, status: "pending", model, cost, paymentSource, remainingBalance, prechargeLabel }`. */
export function parseVideoSubmit(body: unknown): ParsedVideoSubmit {
    if (!isRecord(body)) return { runId: null, usd: null, paymentSource: null, remainingUsd: null };
    const paymentSource = str(body['paymentSource']) ?? str(body['payment_source']);
    return {
        runId: str(body['runId']) ?? str(body['id']) ?? str(body['requestId']),
        usd: dollars(body['cost'], paymentSource),
        paymentSource,
        remainingUsd: dollars(body['remainingBalance'], paymentSource),
    };
}

const QUEUED = new Set([
    'queued',
    'in_queue',
    'inqueue',
    'pending',
    'waiting',
    'submitted',
    'created',
    'accepted',
    'scheduled',
]);
const RUNNING = new Set([
    'running',
    'processing',
    'in_progress',
    'inprogress',
    'generating',
    'delivering',
    'started',
    'active',
    'rendering',
]);
const COMPLETED = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished', 'ready']);
const FAILED = new Set(['failed', 'failure', 'error', 'errored', 'rejected']);
const CANCELED = new Set(['canceled', 'cancelled']);
const TIMED_OUT = new Set(['timed_out', 'timedout', 'timeout']);

/** A status word of either documented spelling (`IN_QUEUE`, `processing`, `COMPLETED`, `cancelled` …); null = not recognised. */
export function mapVideoStatus(raw: unknown): VideoStatus | null {
    const word = str(raw)
        ?.toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (!word) return null;
    if (QUEUED.has(word)) return 'queued';
    if (RUNNING.has(word)) return 'running';
    if (COMPLETED.has(word)) return 'completed';
    if (FAILED.has(word) || CANCELED.has(word) || TIMED_OUT.has(word)) return 'failed';
    if (word === 'expired') return 'expired';
    return null;
}

export interface ParsedVideoStatus {
    /** null: absent or not recognised, the caller keeps what it had (NanoGPT may add intermediate states). */
    status: VideoStatus | null;
    /** 0..1; null when NanoGPT said nothing. */
    progress: number | null;
    /** The video file URL (the NanoGPT content route with `expires` and `sig`, or a provider URL); null until there is one. */
    url: string | null;
    /** A one-line message for failed jobs, free of markup; null when none. */
    error: string | null;
    /** The final cost (completed jobs, `data.cost`) in USD. */
    usd: number | null;
}

/** 0-100 (OpenAPI) or 0..1 (a fraction) -> 0..1. A whole number counts as a percent, so `1` is 1%. */
function progressOf(value: unknown): number | null {
    const n = num(value);
    if (n === null || n < 0) return null;
    const fraction = n > 1 || Number.isInteger(n) ? n / 100 : n;
    return Math.min(1, fraction);
}

function videoUrlOf(...sources: Record<string, unknown>[]): string | null {
    for (const source of sources) {
        const output = isRecord(source['output']) ? source['output'] : {};
        const video = isRecord(output['video']) ? output['video'] : isRecord(source['video']) ? source['video'] : {};
        const url = str(video['url']) ?? str(output['url']) ?? str(source['videoUrl']) ?? str(source['video_url']);
        if (url && /^https?:\/\//i.test(url)) return url;
    }
    return null;
}

function errorOf(...sources: Record<string, unknown>[]): string | null {
    for (const source of sources) {
        const error = source['error'];
        const text = typeof error === 'string' ? error : isRecord(error) ? str(error['message']) : null;
        const friendly = str(source['userFriendlyError']);
        const found = friendly ?? (text ? text : null);
        if (found) return cleanText(found);
    }
    return null;
}

/**
 * The status of a video job in BOTH documented shapes (neither was seen live):
 *   guide:    `{ requestId, model, data: { status: "IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED|CANCELED", output: { video: { url } }, cost, error } }`
 *   OpenAPI:  `{ requestId, status: "queued|processing|completed|failed|cancelled", progress (0-100|null), videoUrl, error }`
 * The status word is normalised, a URL with no recognised status means completed, an unknown word leaves `status` null.
 */
export function parseVideoStatus(body: unknown): ParsedVideoStatus {
    const none: ParsedVideoStatus = { status: null, progress: null, url: null, error: null, usd: null };
    if (!isRecord(body)) return none;
    const inner = isRecord(body['data']) ? body['data'] : {};
    const url = videoUrlOf(inner, body);
    let status = mapVideoStatus(inner['status'] ?? body['status']);
    if (status === null && url !== null) status = 'completed';
    const word = str(inner['status'] ?? body['status'])?.toLowerCase() ?? '';
    let error = errorOf(inner, body);
    if (status === 'failed' && error === null) {
        error = CANCELED.has(word)
            ? 'The job was canceled'
            : TIMED_OUT.has(word)
              ? 'The job timed out'
              : 'The job failed';
    }
    const paymentSource = str(inner['paymentSource']) ?? str(body['paymentSource']);
    return {
        status,
        progress: progressOf(inner['progress'] ?? body['progress']),
        url,
        error,
        usd: dollars(inner['cost'] ?? body['cost'], paymentSource),
    };
}

/* ------------------------------------------------------------------------------------------------ errors */

export interface MediaFailure {
    /** The status the admin API answers with. */
    status: number;
    /** A code of contracts-media.ts (`upstream_error`, `insufficient_balance`, `rate_limited` …). */
    code: string;
    /** NanoGPT's own words, one line, no markup; the caller scrubs secrets before it gets here. */
    message: string;
}

interface ReadError {
    text: string;
    code: string | null;
    type: string | null;
    required: number | null;
}

/** The three shapes: `{ error: { message, type, code } }`, `{ error: "text", code?, requiredBalance? }`, and anything else as text. */
function readErrorBody(bodyText: string): ReadError {
    let json: unknown = null;
    try {
        json = JSON.parse(bodyText);
    } catch {
        // not JSON: plain text, HTML from a gateway
    }
    if (isRecord(json)) {
        const error = json['error'];
        if (isRecord(error)) {
            const code = error['code'];
            return {
                text: cleanText(str(error['message']) ?? ''),
                code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
                type: str(error['type']),
                required: parseCost(json['requiredBalance'] ?? error['requiredBalance']),
            };
        }
        const code = json['code'];
        return {
            text: cleanText(str(error) ?? str(json['message']) ?? ''),
            code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
            type: str(json['type']),
            required: parseCost(json['requiredBalance']),
        };
    }
    return { text: cleanText(bodyText), code: null, type: null, required: null };
}

const POLICY = /content[_\s-]?policy|policy[_\s-]?violation/i;
const BALANCE = /insufficient[_\s-]?(balance|funds)/i;
const RATE = /rate[_\s-]?limit/i;

/**
 * An upstream error (status and body text, already scrubbed of the key) as the admin API's failure: NanoGPT's own text,
 * a contract code. 400 `content_policy_violation` (not charged), 402 `insufficient_balance` (with the amount NanoGPT
 * asked for when it said), 429 `rate_limited`, 413 `payload_too_large`, 408/504 `upstream_timeout`; everything else,
 * including a refused key (401/403, where ST would read the status as "log in again"), is 502 `upstream_error`.
 */
export function mediaFailure(upstreamStatus: number, bodyText: string): MediaFailure {
    const read = readErrorBody(bodyText);
    const label = `${read.code ?? ''} ${read.type ?? ''}`;
    const said = read.text;
    if (POLICY.test(label) || (upstreamStatus === 400 && POLICY.test(said))) {
        return {
            status: 400,
            code: 'content_policy_violation',
            message: said
                ? `NanoGPT refused the prompt (content policy): ${said}`
                : 'NanoGPT refused the prompt (content policy)',
        };
    }
    if (upstreamStatus === 402 || BALANCE.test(label)) {
        const need = read.required !== null ? ` (NanoGPT asks for ${formatUsd(read.required)} USD)` : '';
        return {
            status: 402,
            code: 'insufficient_balance',
            message: `Insufficient balance${need}${said ? `: ${said}` : ''}`,
        };
    }
    if (upstreamStatus === 429 || RATE.test(label)) {
        return {
            status: 429,
            code: 'rate_limited',
            message: said ? `NanoGPT is rate limiting this key: ${said}` : 'NanoGPT is rate limiting this key',
        };
    }
    if (upstreamStatus === 413) {
        return {
            status: 413,
            code: 'payload_too_large',
            message: said
                ? `NanoGPT refused the size of the request: ${said}`
                : 'NanoGPT refused the size of the request',
        };
    }
    if (upstreamStatus === 408 || upstreamStatus === 504) {
        return {
            status: 504,
            code: 'upstream_timeout',
            message: said ? `NanoGPT did not answer in time: ${said}` : 'NanoGPT did not answer in time',
        };
    }
    const lead =
        upstreamStatus === 401 || upstreamStatus === 403
            ? `NanoGPT rejected the key (HTTP ${upstreamStatus})`
            : `NanoGPT answered HTTP ${upstreamStatus}`;
    return { status: 502, code: 'upstream_error', message: said ? `${lead}: ${said}` : lead };
}

/* ------------------------------------------------------------------------------------------------ billing lookup */

export interface ParsedBillingLookup {
    /** USD charged for the request; null when the answer is unusable or in another currency. */
    usd: number | null;
    currency: string | null;
}

/**
 * `GET /api/v1/usage/requests/{id}` (LIVE for images): `{ object: "request_billing", request_id, cost: "0.00255" (decimal
 * string), currency: "USD", cost_scope: "primary_charge", usage: { ... null ... } }`. A currency other than USD gives null:
 * the amount is real but not dollars.
 */
export function parseBillingLookup(body: unknown): ParsedBillingLookup {
    if (!isRecord(body)) return { usd: null, currency: null };
    const currency = str(body['currency']);
    return {
        usd: dollars(body['cost'], currency),
        currency: currency ? currency.toUpperCase() : null,
    };
}

/* ------------------------------------------------------------------------------------------------ usage records */

export interface MediaUsageArgs {
    medium: Medium;
    model: string;
    at: number;
    connectionId: string | null;
    /** Images: the billing-lookup key; video: the `runId`; speech and transcription have none. */
    requestId: string | null;
    /** Images made, seconds of video, characters of speech, seconds of audio; null when not known. */
    units: number | null;
    /** The cost known now; null when nothing is known (and always null for a failed call). */
    usd: number | null;
    costSource: CostSource;
    paymentSource: string | null;
    latencyMs: number;
    status: number;
    error: string | null;
}

/**
 * The usage record of one media call. Real money in `costUsd`; `equivalentUsd` repeats it for pay-as-you-go (there is no
 * token price to recompute from); `billing` is paygo for a positive cost, subscription for a zero cost under a
 * subscription payment source, otherwise unknown. A failed call has no cost: nothing proves it was billed.
 */
export function buildMediaUsageRecord(args: MediaUsageArgs): UsageRecord {
    const failed = args.error !== null || args.status >= 400;
    const usd = failed ? null : args.usd;
    let billing: BillingOutcome = 'unknown';
    if (usd !== null && usd > 0) billing = 'paygo';
    else if (usd === 0 && args.paymentSource !== null && /subscription/i.test(args.paymentSource))
        billing = 'subscription';
    return {
        at: args.at,
        connectionId: args.connectionId,
        requestId: args.requestId,
        model: args.model,
        billing,
        costUsd: usd,
        equivalentUsd: billing === 'paygo' ? usd : null,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        latencyMs: Math.max(0, args.latencyMs),
        status: args.status,
        stream: false,
        consumer: 'unknown',
        error: args.error,
        medium: args.medium,
        units: args.units,
        costSource: usd === null ? 'unknown' : args.costSource,
    };
}

/**
 * A correction of one record's cost, appended to the usage file next to it (`{ adjust: true, requestId, costUsd, costSource,
 * at }`): a media call's real charge is known only after the call (the billing lookup, the video's final cost).
 */
export interface UsageAdjustment {
    adjust: true;
    requestId: string;
    costUsd: number;
    costSource: CostSource;
    /** When the correction was made (ms since epoch). */
    at: number;
}

const COST_SOURCES: readonly CostSource[] = ['response', 'lookup', 'estimate', 'unknown'];

/** One parsed line of a usage file as an adjustment; null when it is not a valid one. */
export function parseUsageAdjustment(raw: unknown): UsageAdjustment | null {
    if (!isRecord(raw) || raw['adjust'] !== true) return null;
    const requestId = str(raw['requestId']);
    const costUsd = parseCost(raw['costUsd']);
    const at = num(raw['at']);
    if (requestId === null || costUsd === null || at === null) return null;
    const costSource = COST_SOURCES.find((source) => source === raw['costSource']) ?? 'lookup';
    return { adjust: true, requestId, costUsd, costSource, at };
}

/**
 * The records with their corrections applied: a record whose `requestId` has an adjustment takes its `costUsd` and
 * `costSource` (the latest adjustment wins; a paygo media record's `equivalentUsd` follows, and an unknown billing outcome
 * becomes paygo for a positive figure). Neither input is mutated; untouched records are returned as they are.
 */
export function applyUsageAdjustments(
    records: readonly UsageRecord[],
    adjustments: readonly UsageAdjustment[],
): UsageRecord[] {
    if (adjustments.length === 0) return [...records];
    const latest = new Map<string, UsageAdjustment>();
    // Stable by time: a later correction replaces an earlier one, equal times keep file order.
    for (const adjustment of [...adjustments].sort((a, b) => a.at - b.at)) latest.set(adjustment.requestId, adjustment);
    return records.map((record) => {
        const adjustment = record.requestId === null ? undefined : latest.get(record.requestId);
        if (!adjustment) return record;
        const media = record.medium !== undefined && record.medium !== 'chat';
        const billing: BillingOutcome =
            record.billing === 'unknown' && adjustment.costUsd > 0 ? 'paygo' : record.billing;
        return {
            ...record,
            billing,
            costUsd: adjustment.costUsd,
            costSource: adjustment.costSource,
            equivalentUsd: media && billing === 'paygo' ? adjustment.costUsd : record.equivalentUsd,
        };
    });
}
