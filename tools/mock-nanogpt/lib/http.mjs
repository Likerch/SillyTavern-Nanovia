// Small HTTP helpers shared by the mock's route modules.
import { randomBytes } from 'node:crypto';

export const MAX_BODY = 32 * 1024 * 1024;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const randomId = (prefix, bytes = 8) => `${prefix}${randomBytes(bytes).toString('hex')}`;

/** Reads the whole request body as bytes. */
export function readBuffer(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** Reads the whole request body as text. */
export async function readBody(req) {
    return (await readBuffer(req)).toString('utf8');
}

/**
 * A `multipart/form-data` body as `{ fields, files }`: text fields by name, and the file parts with their bytes. Enough for
 * the transcription route; not a general parser.
 */
export function parseMultipart(body, contentType) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
    const result = { fields: {}, files: [] };
    if (!boundary) return result;
    const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`, 'latin1');
    let at = body.indexOf(delimiter);
    while (at !== -1) {
        const headStart = at + delimiter.length;
        if (body[headStart] === 0x2d && body[headStart + 1] === 0x2d) break;
        const headEnd = body.indexOf('\r\n\r\n', headStart, 'latin1');
        if (headEnd === -1) break;
        const head = body.subarray(headStart, headEnd).toString('latin1');
        const next = body.indexOf(delimiter, headEnd + 4);
        const data = body.subarray(headEnd + 4, next === -1 ? body.length : Math.max(headEnd + 4, next - 2));
        const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
        const filename = /filename="([^"]*)"/i.exec(head)?.[1];
        if (filename !== undefined) {
            const mime = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream';
            result.files.push({ name, filename, mime, data });
        } else result.fields[name] = data.toString('utf8');
        at = next;
    }
    return result;
}

export function sendJson(res, status, value, headers = {}) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
    });
    res.end(body);
}

/** An OpenAI-shaped error, the envelope of most `/api/v1/*` routes. */
export function sendError(res, status, code, message, extra = {}) {
    const { type = typeForStatus(status), param, headers, ...rest } = extra;
    sendJson(res, status, { error: { message, type, code, ...(param ? { param } : {}), ...rest } }, headers);
}

function typeForStatus(status) {
    if (status === 401) return 'authentication_error';
    if (status === 403) return 'permission_error';
    if (status === 404) return 'not_found_error';
    if (status === 429) return 'rate_limit_error';
    if (status >= 500) return 'server_error';
    return 'invalid_request_error';
}

/** First value of a header (Node joins repeated headers for most names, but not all). */
export function header(req, name) {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * CORS as NanoGPT serves it on ordinary routes: any origin, the requested headers echoed back, and the
 * response headers a browser client needs exposed. The Management API does not call this on purpose.
 */
export function applyCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', header(req, 'access-control-request-headers') ?? '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-Mock-Applied-Suffixes, Retry-After');
    res.setHeader('Access-Control-Max-Age', '600');
}
