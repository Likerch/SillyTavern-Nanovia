// What the media routes share (stage 0.7): checking a request against the catalog, one careful call to NanoGPT's media
// host with the user's key, the translation of its answers and failures into the admin API's errors (contracts-media.ts),
// the usage record of a call, and the byte-range logic of the saved-video route. The key never appears in an error, a log
// line, a usage record or a reply: it goes on the wire in the Authorization header only, and every text that came back from
// NanoGPT is scrubbed of it first.
import {
    buildMediaUsageRecord,
    imageMimeFromName,
    mediaFailure,
    sniffImageMime,
    type MediaUsageArgs,
} from '../../domain/media-wire';
import type { MediaModel, Medium } from '../../shared/contracts-media';
import { callMedia, MediaCallError, type MediaAnswer, type MediaCallInit } from '../media-call';
import type { SecretValue } from '../secret-value';
import type { ServerDeps } from '../types';
import { HttpError, type RequestUser } from './http';

/** The model of a request, checked against the catalog of the medium (waits for the first load when there is none yet). */
export async function modelFor(deps: ServerDeps, medium: Medium, id: string): Promise<MediaModel> {
    const held = deps.media.catalog.lookup(medium, id);
    if (held) return held;
    const loaded = await deps.media.catalog.catalog(medium);
    if (!loaded) {
        throw new HttpError(
            502,
            'media_unavailable',
            `The NanoGPT ${medium} model list could not be fetched and none is stored`,
        );
    }
    const model = loaded.models.find((m) => m.id === id);
    if (!model) throw new HttpError(400, 'invalid_request', `"${id}" is not a ${medium} model of the NanoGPT catalog`);
    return model;
}

/** A transport failure as the admin API's error. */
export function transportFailure(error: unknown): HttpError {
    const kind = error instanceof MediaCallError ? error.kind : 'unreachable';
    if (kind === 'timeout') return new HttpError(504, 'upstream_timeout', 'NanoGPT did not answer in time');
    if (kind === 'too_large') {
        return new HttpError(502, 'upstream_error', 'NanoGPT answered with more data than the plugin accepts');
    }
    return new HttpError(502, 'upstream_unreachable', 'NanoGPT could not be reached');
}

/** One call to the media host; resolves for any HTTP status, rejects with an HttpError for transport failures. */
export async function mediaRequest(
    deps: ServerDeps,
    key: SecretValue,
    init: MediaCallInit,
    maxBytes?: number,
): Promise<MediaAnswer> {
    try {
        return await callMedia(deps.media.env, key, init, maxBytes);
    } catch (error) {
        throw transportFailure(error);
    }
}

/** The answer's body as text, free of the key. */
export function answerText(key: SecretValue, answer: MediaAnswer): string {
    return key.redact(answer.body.toString('utf8'));
}

/** The answer's body as JSON; undefined when it is not JSON. */
export function answerJson(key: SecretValue, answer: MediaAnswer): unknown {
    try {
        return JSON.parse(answerText(key, answer));
    } catch {
        return undefined;
    }
}

/** The HttpError for an answer a route cannot use: NanoGPT's own text under a contract code, never the key. */
export function upstreamFailure(key: SecretValue, answer: MediaAnswer): HttpError {
    const failure = mediaFailure(answer.status, answerText(key, answer));
    return new HttpError(failure.status, failure.code, failure.message);
}

export const isOk = (status: number): boolean => status >= 200 && status < 300;

/** Everything a route knows about a call that is needed to write its usage record, failure or not. */
export interface CallRecord {
    deps: ServerDeps;
    user: RequestUser;
    medium: Medium;
    model: string;
    connectionId: string | null;
    started: number;
}

/** Appends the usage record of a call (bookkeeping never fails a request: the log swallows its own errors). */
export async function writeUsage(
    call: CallRecord,
    outcome: Pick<MediaUsageArgs, 'requestId' | 'units' | 'usd' | 'costSource' | 'paymentSource' | 'status' | 'error'>,
): Promise<void> {
    const { deps } = call;
    await deps.usage.append(
        call.user.root,
        buildMediaUsageRecord({
            medium: call.medium,
            model: call.model,
            at: call.started,
            connectionId: call.connectionId,
            latencyMs: deps.now() - call.started,
            ...outcome,
        }),
    );
}

/** Records a failed call (no cost, the contract's error code) and hands the error back to be thrown. */
export async function failedCall(call: CallRecord, error: HttpError): Promise<HttpError> {
    await writeUsage(call, {
        requestId: null,
        units: null,
        usd: null,
        costSource: 'unknown',
        paymentSource: null,
        status: error.status,
        error: error.code,
    });
    return error;
}

/* ------------------------------------------------------------------------------------------------ outputs */

/** The type of an image the answer carried inline: what the bytes are, else what was asked for, else PNG. */
export function imageOutputMime(base64: string, fromPrefix: string | undefined, format: unknown): string {
    if (fromPrefix) return fromPrefix;
    const sniffed = sniffImageMime(base64);
    if (sniffed) return sniffed;
    if (typeof format === 'string' && /^[a-z0-9]{2,5}$/i.test(format)) {
        const f = format.toLowerCase();
        return f === 'jpg' ? 'image/jpeg' : `image/${f}`;
    }
    return 'image/png';
}

export function imageUrlMime(url: string, format: unknown): string {
    const named = imageMimeFromName(url);
    if (named) return named;
    return imageOutputMime('', undefined, format);
}

/* ------------------------------------------------------------------------------------------------ byte ranges */

export type ByteRange = { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * A `Range` header against a file of `size` bytes (RFC 9110): `bytes=a-b`, `bytes=a-` and `bytes=-n` are honoured; a header
 * that is not understood, names another unit or asks for several ranges is ignored (the whole file); a range that starts
 * past the end is unsatisfiable (416).
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange {
    if (!header) return { kind: 'full' };
    const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
    if (!m) return { kind: 'full' };
    const first = m[1] ?? '';
    const last = m[2] ?? '';
    if (first === '' && last === '') return { kind: 'full' };
    if (first === '') {
        // The last n bytes.
        const n = Number(last);
        if (n === 0) return { kind: 'unsatisfiable' };
        if (size === 0) return { kind: 'unsatisfiable' };
        return { kind: 'partial', start: Math.max(0, size - n), end: size - 1 };
    }
    const start = Number(first);
    if (start >= size) return { kind: 'unsatisfiable' };
    const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    if (end < start) return { kind: 'full' };
    return { kind: 'partial', start, end };
}
