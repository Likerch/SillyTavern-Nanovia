// The call to NanoGPT: `POST <base>/chat/completions` with the key as a bearer token. Retries once on the fallback base
// after a connect-level failure (when one is configured), bounds the wait with a timeout that restarts on every chunk,
// and aborts the request when the caller's signal fires (the client went away). The key never leaves this file in any
// message: errors carry a code, not text from the transport.
import type { SecretValue } from './secret-value';
import type { FetchLike, FetchResponseLike } from './types';

export type UpstreamFailureKind = 'unreachable' | 'timeout' | 'aborted';

export class UpstreamError extends Error {
    constructor(
        readonly kind: UpstreamFailureKind,
        /** A transport error code (`ECONNREFUSED` …) when there is one. */
        readonly code: string | null,
    ) {
        super(kind === 'aborted' ? 'upstream request aborted' : `upstream ${kind}${code ? ` (${code})` : ''}`);
        this.name = 'UpstreamError';
    }
}

export interface UpstreamCallOptions {
    fetch: FetchLike;
    base: string;
    fallbackBase: string | null;
    /** Already serialised JSON body. */
    body: string;
    /** Extra headers (the plan's); Authorization and framing headers cannot be overridden. */
    headers: Record<string, string>;
    key: SecretValue;
    stream: boolean;
    timeoutMs: number;
    /** Fires when the client disconnects. */
    signal: AbortSignal;
    userAgent: string;
}

export interface UpstreamHandle {
    status: number;
    /** Lower-case names. */
    headers: Record<string, string>;
    /** The base that answered. */
    base: string;
    body: AsyncIterable<Uint8Array>;
    /** Restarts the idle timer; call after every chunk. */
    touch(): void;
    /** Stops the timer and, if the body was not read to the end, aborts the request. Idempotent. */
    close(): void;
}

/** Codes that mean "never connected": the only failures that are safe to retry on another base. */
const CONNECT_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
]);

const FORBIDDEN_HEADERS = new Set(['authorization', 'host', 'content-length', 'connection', 'transfer-encoding']);

export function errorCode(error: unknown): string | null {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current; depth++) {
        if (typeof current === 'object' && current !== null) {
            const rec = current as { code?: unknown; cause?: unknown; errno?: unknown };
            if (typeof rec.code === 'string' && rec.code) return rec.code;
            if (typeof rec.errno === 'string' && rec.errno) return rec.errno;
            current = rec.cause;
        } else break;
    }
    return null;
}

export function isConnectError(error: unknown): boolean {
    const code = errorCode(error);
    return code !== null && CONNECT_CODES.has(code);
}

export function chatCompletionsUrl(base: string): string {
    return `${base.replace(/\/+$/, '')}/chat/completions`;
}

export async function callUpstream(options: UpstreamCallOptions): Promise<UpstreamHandle> {
    const { signal, timeoutMs } = options;
    if (signal.aborted) throw new UpstreamError('aborted', null);

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
        }, timeoutMs);
        timer.unref?.();
    };
    const onClientAbort = (): void => controller.abort();
    signal.addEventListener('abort', onClientAbort, { once: true });
    const release = (): void => {
        clear();
        signal.removeEventListener('abort', onClientAbort);
    };

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: options.stream ? 'text/event-stream' : 'application/json',
        'accept-encoding': 'identity',
        'user-agent': options.userAgent,
    };
    for (const [name, value] of Object.entries(options.headers)) {
        if (!FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    headers['authorization'] = `Bearer ${options.key.reveal()}`;

    const attempt = (base: string): Promise<FetchResponseLike> =>
        options.fetch(chatCompletionsUrl(base), {
            method: 'POST',
            headers,
            body: options.body,
            signal: controller.signal,
        });

    arm();
    let response: FetchResponseLike;
    let usedBase = options.base;
    try {
        try {
            response = await attempt(options.base);
        } catch (error) {
            if (!options.fallbackBase || !isConnectError(error) || controller.signal.aborted) throw error;
            usedBase = options.fallbackBase;
            arm();
            response = await attempt(options.fallbackBase);
        }
    } catch (error) {
        release();
        if (signal.aborted) throw new UpstreamError('aborted', null);
        if (timedOut) throw new UpstreamError('timeout', null);
        throw new UpstreamError('unreachable', errorCode(error));
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        responseHeaders[name.toLowerCase()] = value;
    });
    arm();

    const source = response.body ?? emptyBody();
    async function* body(): AsyncGenerator<Uint8Array> {
        try {
            for await (const chunk of source) yield chunk;
            finished = true;
        } catch (error) {
            if (signal.aborted) throw new UpstreamError('aborted', null);
            if (timedOut) throw new UpstreamError('timeout', null);
            throw new UpstreamError('unreachable', errorCode(error));
        }
    }

    return {
        status: response.status,
        headers: responseHeaders,
        base: usedBase,
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

async function* emptyBody(): AsyncGenerator<Uint8Array> {
    // no body
}
