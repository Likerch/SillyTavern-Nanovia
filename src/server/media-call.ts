// The calls to NanoGPT's media endpoints (stage 0.7): one careful way to open a request on the media host, used by the
// admin routes (buffered, capped), the proxy endpoints (the body is relayed as it arrives) and the billing lookup. The key
// goes on the wire in the Authorization header only, and only to `config.mediaBase`; nothing here puts a key, a prompt or a
// recording into a message. Plus the two multipart helpers (build a body for NanoGPT, read one field of a body a client sent).
import { randomBytes } from 'node:crypto';
import type { SecretValue } from './secret-value';
import type { FetchLike, FetchResponseLike } from './types';
import { errorCode } from './upstream';

/** How long each kind of call may stay silent before it is given up on (restarted by every chunk of the answer). */
export interface MediaTimeouts {
    imageMs: number;
    ttsMs: number;
    sttMs: number;
    /** The video submit answers at once (the work is asynchronous). */
    videoSubmitMs: number;
    videoStatusMs: number;
    /** Between two chunks of the downloaded file. */
    videoDownloadMs: number;
    /** The billing lookup. */
    lookupMs: number;
}

export const DEFAULT_MEDIA_TIMEOUTS: MediaTimeouts = {
    imageMs: 180_000,
    ttsMs: 120_000,
    sttMs: 180_000,
    videoSubmitMs: 30_000,
    videoStatusMs: 20_000,
    videoDownloadMs: 60_000,
    lookupMs: 15_000,
};

/** Largest answer the admin routes buffer: a 4K image as base64, a long piece of music. */
export const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
/** Largest error body worth reading. */
export const MAX_ERROR_BYTES = 256 * 1024;

export type MediaFailureKind = 'timeout' | 'unreachable' | 'too_large' | 'aborted';

export class MediaCallError extends Error {
    constructor(
        readonly kind: MediaFailureKind,
        /** A transport error code (`ECONNREFUSED` …) when there is one. */
        readonly code: string | null = null,
    ) {
        super(`media call ${kind}${code ? ` (${code})` : ''}`);
        this.name = 'MediaCallError';
    }
}

export interface MediaCallInit {
    method: 'GET' | 'POST';
    /** Below the media host, starting with `/` (`/v1/images/generations`, `/api/video/status?requestId=…`). */
    path: string;
    body?: string | Uint8Array;
    /** Defaults to `application/json` when there is a body. */
    contentType?: string;
    accept?: string;
    /** `paygo` sends `X-Billing-Mode: paygo`. */
    billing?: 'auto' | 'paygo';
    /** Silence allowed before giving up; restarted by every chunk. */
    timeoutMs: number;
    /** Fires when the caller is gone (a proxy client that hung up). */
    signal?: AbortSignal;
}

export interface MediaHandle {
    status: number;
    /** Lower-case names. */
    headers: Record<string, string>;
    body: AsyncIterable<Uint8Array>;
    /** Restarts the idle timer; call after every chunk you handle slowly. */
    touch(): void;
    /** Stops the timer and, if the body was not read to the end, aborts the request. Idempotent. */
    close(): void;
}

export interface MediaCallEnv {
    fetch: FetchLike;
    mediaBase: string;
    version: string;
}

/**
 * Opens one request on the media host and resolves with the answer's head and a body to iterate. Rejects with a
 * MediaCallError: `timeout` (nothing arrived in `timeoutMs`), `unreachable`, `aborted` (the caller's signal fired).
 */
export function openMedia(env: MediaCallEnv, key: SecretValue, init: MediaCallInit): Promise<MediaHandle> {
    const headers: Record<string, string> = {
        authorization: `Bearer ${key.reveal()}`,
        accept: init.accept ?? 'application/json',
        'accept-encoding': 'identity',
        'user-agent': `Nanovia/${env.version}`,
    };
    if (init.body !== undefined) headers['content-type'] = init.contentType ?? 'application/json';
    if (init.billing === 'paygo') headers['x-billing-mode'] = 'paygo';
    return openRaw(env, `${env.mediaBase.replace(/\/+$/, '')}${init.path}`, headers, init);
}

/**
 * A GET of a URL NanoGPT handed out (the signed link of a finished video) WITHOUT the key: the link is public for its
 * lifetime, and a URL that came out of an answer must never receive the Authorization header. `url` may be relative to
 * the media host. Only http(s) is opened.
 */
export function openPublic(
    env: MediaCallEnv,
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<MediaHandle> {
    let target: URL;
    try {
        target = new URL(url, `${env.mediaBase.replace(/\/+$/, '')}/`);
    } catch {
        return Promise.reject(new MediaCallError('unreachable', 'EINVAL'));
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        return Promise.reject(new MediaCallError('unreachable', 'EINVAL'));
    }
    const headers = { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': `Nanovia/${env.version}` };
    return openRaw(env, target.toString(), headers, { timeoutMs, ...(signal ? { signal } : {}), method: 'GET' });
}

async function openRaw(
    env: MediaCallEnv,
    url: string,
    headers: Record<string, string>,
    init: Pick<MediaCallInit, 'method' | 'body' | 'timeoutMs' | 'signal'>,
): Promise<MediaHandle> {
    if (init.signal?.aborted) throw new MediaCallError('aborted');
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let finished = false;

    const clear = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };
    const arm = (): void => {
        clear();
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, init.timeoutMs);
        timer.unref?.();
    };
    const onAbort = (): void => controller.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    const release = (): void => {
        clear();
        init.signal?.removeEventListener('abort', onAbort);
    };

    arm();
    let response: FetchResponseLike;
    try {
        // A fetch that ignores its signal must not hang the call: the timer wins the race on its own.
        const timeout = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(new MediaCallError('timeout')), { once: true });
        });
        timeout.catch(() => {});
        const attempt = env.fetch(url, {
            method: init.method,
            headers,
            ...(init.body !== undefined ? { body: init.body } : {}),
            signal: controller.signal,
        });
        attempt.catch(() => {});
        response = await Promise.race([attempt, timeout]);
    } catch (error) {
        release();
        if (init.signal?.aborted) throw new MediaCallError('aborted');
        if (timedOut) throw new MediaCallError('timeout');
        throw new MediaCallError('unreachable', errorCode(error));
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
    });
    arm();

    const source = response.body;
    async function* body(): AsyncGenerator<Uint8Array> {
        try {
            if (source) for await (const chunk of source) yield chunk;
            finished = true;
        } catch (error) {
            if (init.signal?.aborted) throw new MediaCallError('aborted');
            if (timedOut) throw new MediaCallError('timeout');
            throw new MediaCallError('unreachable', errorCode(error));
        }
    }
    return {
        status: response.status,
        headers: responseHeaders,
        body: body(),
        touch() {
            if (!closed) arm();
        },
        close() {
            if (closed) return;
            closed = true;
            release();
            if (!finished) controller.abort();
        },
    };
}

export interface MediaAnswer {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
}

/**
 * One whole call: the answer's body is read to the end, at most `maxBytes` of it (more is a `too_large` failure and the
 * request is aborted). Rejects with a MediaCallError.
 */
export async function callMedia(
    env: MediaCallEnv,
    key: SecretValue,
    init: MediaCallInit,
    maxBytes = MAX_ANSWER_BYTES,
): Promise<MediaAnswer> {
    const handle = await openMedia(env, key, init);
    try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of handle.body) {
            handle.touch();
            size += chunk.length;
            if (size > maxBytes) throw new MediaCallError('too_large');
            chunks.push(Buffer.from(chunk));
        }
        return { status: handle.status, headers: handle.headers, body: Buffer.concat(chunks) };
    } finally {
        handle.close();
    }
}

/** The media type of an answer without its parameters (`audio/x-wav; charset=…` -> `audio/x-wav`); null when absent or odd. */
export function contentTypeOf(headers: Record<string, string>): string | null {
    const raw = headers['content-type'];
    if (!raw) return null;
    const type = raw.split(';')[0]?.trim().toLowerCase() ?? '';
    return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type) ? type : null;
}

/* ------------------------------------------------------------------------------------------------ multipart */

export interface MultipartFile {
    name: string;
    filename: string;
    mime: string;
    data: Buffer;
}

/** A `multipart/form-data` body for NanoGPT: text fields first, then the file. Header values never take a CR, LF or quote. */
export function buildMultipart(
    fields: readonly [string, string][],
    file: MultipartFile,
): { body: Buffer; contentType: string } {
    const boundary = `----nanovia${randomBytes(12).toString('hex')}`;
    const token = (value: string): string => value.replace(/[\r\n"\\]/g, '_');
    const parts: Buffer[] = [];
    for (const [name, value] of fields) {
        parts.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${token(name)}"\r\n\r\n${value}\r\n`,
                'utf8',
            ),
        );
    }
    parts.push(
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${token(file.name)}"; filename="${token(file.filename)}"\r\nContent-Type: ${token(file.mime)}\r\n\r\n`,
            'utf8',
        ),
        file.data,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    );
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** The boundary of a `multipart/form-data` content type; null when there is none. */
export function boundaryOf(contentType: string | undefined): string | null {
    if (!contentType || !/^multipart\/form-data/i.test(contentType)) return null;
    const m = /boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(contentType);
    return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * The text value of one non-file field of a multipart body (the proxy needs `model` without parsing the recording). Scans
 * the part headers only; the binary parts are skipped by searching for the next boundary. null: no such field.
 */
export function multipartField(body: Buffer, boundary: string, field: string): string | null {
    const delimiter = Buffer.from(`--${boundary}`, 'latin1');
    const wanted = `name="${field}"`;
    let at = body.indexOf(delimiter);
    while (at !== -1) {
        const headStart = at + delimiter.length;
        // `--` right after the boundary closes the body.
        if (body[headStart] === 0x2d && body[headStart + 1] === 0x2d) return null;
        const headEnd = body.indexOf('\r\n\r\n', headStart, 'latin1');
        if (headEnd === -1) return null;
        const head = body.subarray(headStart, headEnd).toString('latin1');
        const next = body.indexOf(delimiter, headEnd + 4);
        if (head.includes(wanted) && !/filename=/i.test(head)) {
            // The value ends at the CRLF that precedes the next boundary.
            const valueEnd = next === -1 ? body.length : Math.max(headEnd + 4, next - 2);
            return body.subarray(headEnd + 4, valueEnd).toString('utf8');
        }
        at = next;
    }
    return null;
}
