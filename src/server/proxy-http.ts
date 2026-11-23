// Reply helpers of the proxy listener, shared by the chat path (proxy.ts) and the media endpoints (media-proxy.ts):
// OpenAI-shaped errors, JSON replies, header hygiene and a write that waits for the socket to drain.
import type http from 'node:http';

export function errorBody(
    type: string,
    code: string,
    message: string,
): { error: { message: string; type: string; code: string } } {
    return { error: { message, type, code } };
}

export function sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): void {
    if (res.headersSent || res.destroyed) return;
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(payload.length),
        'cache-control': 'no-store',
        ...headers,
    });
    res.end(payload);
}

export function sendError(
    res: http.ServerResponse,
    status: number,
    type: string,
    code: string,
    message: string,
    headers: Record<string, string> = {},
): void {
    sendJson(res, status, errorBody(type, code, message), {
        ...headers,
        ...(status === 413 ? { connection: 'close' } : {}),
    });
}

export function sendMethodNotAllowed(res: http.ServerResponse, allow: string): void {
    sendError(res, 405, 'invalid_request_error', 'method_not_allowed', 'Method not allowed', { allow });
}

/** A header value that cannot break the response: printable ASCII, at most 500 characters. */
export function headerSafe(value: string): string {
    return value.replace(/[^\x20-\x7e]/g, '').slice(0, 500);
}

/** Writes a chunk and waits for the socket to drain, so a slow client slows the upstream read instead of buffering. */
export function writeChunk(res: http.ServerResponse, chunk: Uint8Array): Promise<void> {
    if (res.destroyed || res.writableEnded) return Promise.resolve();
    if (res.write(chunk)) return Promise.resolve();
    return new Promise((resolve) => {
        const done = (): void => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
        };
        res.once('drain', done);
        res.once('close', done);
    });
}
