// The media endpoints of the proxy listener (stage 0.7), OpenAI-shaped so ST's own "OpenAI Compatible" TTS provider and
// other clients work against a Nanovia URL. Behind the same connection-token check as chat (proxy.ts authenticates before
// calling in here); a dedicated handler rather than the chat pipeline, whose steps assume a JSON chat body:
//
//   POST /c/<id>/v1/audio/speech          JSON in; the upstream audio bytes come back as they arrive, with the upstream content
//                                         type (never assumed to be mp3) and `X-Nanovia-Cost` (the catalog estimate)
//   POST /c/<id>/v1/audio/transcriptions  multipart in (the body is forwarded as it is, boundary and all, up to the 4 MB NanoGPT
//                                         takes); the upstream JSON comes back with `X-Nanovia-Cost` from `usage.cost`
//   POST /c/<id>/v1/images/generations    JSON in; the upstream JSON (`b64_json` / `url`) comes back unchanged with
//                                         `X-Nanovia-Cost` (the list figure), and the cost is reconciled later
//
// The model comes from the request body (a connection's own `modelId` is a chat model). The request body is read with a cap
// (413 beyond it, nothing is buffered without bound); the answer is relayed with the upstream status, content type and bytes.
// Errors go back in the OpenAI envelope (a plain-text 401 from NanoGPT is wrapped). Every call writes one usage record.
// The key goes upstream in the Authorization header only; nothing here logs a body, a key or a token.
import type http from 'node:http';
import { estimateImageCost, estimateSttCost, estimateTtsCost } from '../domain/media';
import { countChars } from '../domain/media-request';
import {
    buildMediaUsageRecord,
    formatUsd,
    parseImageBody,
    parseSttBody,
    type MediaUsageArgs,
} from '../domain/media-wire';
import { isRecord } from '../domain/usage';
import { RESPONSE_HEADERS, SECRET_KEY_NANOGPT } from '../shared/constants';
import type { ConnectionConfig, UsageRecord } from '../shared/contracts';
import type { CostSource, MediaModel, Medium } from '../shared/contracts-media';
import { parseHints } from './context';
import { boundaryOf, MAX_ERROR_BYTES, MediaCallError, multipartField, openMedia } from './media-call';
import { errorBody, headerSafe, sendError, writeChunk } from './proxy-http';
import { SecretValue } from './secret-value';
import type { ServerDeps } from './types';

export const MEDIA_ENDPOINTS = ['audio/speech', 'audio/transcriptions', 'images/generations'] as const;
export type MediaEndpoint = (typeof MEDIA_ENDPOINTS)[number];

/** Request body caps: a speech request is text, an image request may carry input images as data URLs, a recording is 4 MB. */
export const SPEECH_BODY_LIMIT = 2 * 1024 * 1024;
export const IMAGE_BODY_LIMIT = 8 * 1024 * 1024;
export const STT_BODY_LIMIT = 4 * 1024 * 1024 + 256 * 1024;
/** Largest answer buffered for a JSON endpoint (a 4K image as base64). */
const IMAGE_ANSWER_LIMIT = 64 * 1024 * 1024;
const STT_ANSWER_LIMIT = 8 * 1024 * 1024;

export interface MediaProxyInput {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    endpoint: MediaEndpoint;
    user: string;
    userRoot: string;
    connection: ConnectionConfig;
}

interface EndpointMeta {
    medium: Medium;
    path: string;
    limit: number;
    answerLimit: number;
}

const META: Record<MediaEndpoint, EndpointMeta> = {
    'audio/speech': { medium: 'tts', path: '/v1/audio/speech', limit: SPEECH_BODY_LIMIT, answerLimit: 0 },
    'audio/transcriptions': {
        medium: 'stt',
        path: '/v1/audio/transcriptions',
        limit: STT_BODY_LIMIT,
        answerLimit: STT_ANSWER_LIMIT,
    },
    'images/generations': {
        medium: 'image',
        path: '/v1/images/generations',
        limit: IMAGE_BODY_LIMIT,
        answerLimit: IMAGE_ANSWER_LIMIT,
    },
};

type BodyResult = { ok: true; body: Buffer } | { ok: false; status: number; code: string; message: string };

/** The request body, at most `limit` bytes: a declared size over it is refused unread, one that grows past it is cut off. */
function readBounded(req: http.IncomingMessage, limit: number): Promise<BodyResult> {
    const refused = (): BodyResult => ({
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `The request body is larger than ${Math.round(limit / (1024 * 1024))} MB`,
    });
    return new Promise((resolve) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) return resolve(refused());
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const settle = (result: BodyResult): void => {
            if (done) return;
            done = true;
            resolve(result);
        };
        req.on('data', (chunk: Buffer) => {
            if (done) return; // the rest is read and thrown away
            size += chunk.length;
            if (size > limit) {
                chunks.length = 0;
                settle(refused());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (size === 0)
                settle({ ok: false, status: 400, code: 'invalid_request', message: 'The request body is empty' });
            else settle({ ok: true, body: Buffer.concat(chunks) });
        });
        req.on('error', () =>
            settle({ ok: false, status: 400, code: 'invalid_request', message: 'The request could not be read' }),
        );
        req.on('close', () =>
            settle({ ok: false, status: 400, code: 'invalid_request', message: 'The request was cut off' }),
        );
    });
}

/**
 * A non-2xx upstream body in the OpenAI envelope: an envelope passes through unchanged, the legacy `{ error: "text" }` and
 * plain text/HTML are wrapped so every client can read `error.message`.
 */
function openAiError(status: number, text: string): { body: Buffer; code: string } {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    if (isRecord(json) && isRecord(json['error'])) {
        const code = json['error']['code'];
        return {
            body: Buffer.from(text),
            code:
                typeof code === 'string' && code
                    ? code.slice(0, 80)
                    : typeof code === 'number'
                      ? String(code)
                      : `http_${status}`,
        };
    }
    const legacy = isRecord(json) && typeof json['error'] === 'string' ? json['error'] : null;
    const said = (legacy ?? text)
        .replace(/<[^>]*>/g, ' ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
    const legacyCode =
        isRecord(json) && typeof json['code'] === 'string' ? json['code'].toLowerCase().slice(0, 80) : null;
    const code = legacyCode && /^[a-z][a-z0-9_]*$/.test(legacyCode) ? legacyCode : 'upstream_error';
    const message = said ? `NanoGPT answered HTTP ${status}: ${said}` : `NanoGPT answered HTTP ${status}`;
    return { body: Buffer.from(JSON.stringify(errorBody('upstream_error', code, message))), code };
}

export function createMediaProxy(deps: ServerDeps): (input: MediaProxyInput) => Promise<void> {
    const { log } = deps;

    function resolveKey(user: string, keyId: string | null): SecretValue | null {
        if (!deps.st.available) return deps.config.nanogptKey ? new SecretValue(deps.config.nanogptKey) : null;
        const value = deps.st.readSecret(user, SECRET_KEY_NANOGPT, keyId);
        return value ? new SecretValue(value) : null;
    }

    return async function handle(input: MediaProxyInput): Promise<void> {
        const { req, res, endpoint, user, userRoot, connection } = input;
        const meta = META[endpoint];
        const started = deps.now();
        const clientAbort = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished) clientAbort.abort();
        });
        const connectionHeader = { [RESPONSE_HEADERS.connection]: connection.id };
        const hints = parseHints(req.headers);
        let modelId = connection.modelId;

        /** The one usage record of the call. Bookkeeping never fails a request. */
        const record = async (
            outcome: Pick<
                MediaUsageArgs,
                'requestId' | 'units' | 'usd' | 'costSource' | 'paymentSource' | 'status' | 'error'
            >,
        ): Promise<void> => {
            const entry: UsageRecord = {
                ...buildMediaUsageRecord({
                    medium: meta.medium,
                    model: modelId,
                    at: started,
                    connectionId: connection.id,
                    latencyMs: deps.now() - started,
                    ...outcome,
                }),
                consumer: hints.consumer,
            };
            try {
                await deps.usage.append(userRoot, entry);
            } catch (error) {
                log.warn(`usage record not written (${error instanceof Error ? error.message : 'unknown error'})`);
            }
        };
        const nothing = {
            requestId: null,
            units: null,
            usd: null,
            costSource: 'unknown',
            paymentSource: null,
        } as const;
        // The record goes first wherever the reply is not a stream: a client that has its answer can already find the entry.
        const early = async (status: number, type: string, code: string, message: string): Promise<void> => {
            await record({ ...nothing, status, error: code });
            sendError(res, status, type, code, message, connectionHeader);
        };

        /* ---- the request */
        let contentType = 'application/json';
        let boundary: string | null = null;
        if (endpoint === 'audio/transcriptions') {
            boundary = boundaryOf(req.headers['content-type']);
            if (!boundary) {
                return early(
                    400,
                    'invalid_request_error',
                    'invalid_request',
                    'A multipart/form-data body with a file is required',
                );
            }
            contentType = String(req.headers['content-type']);
        } else if (typeof req.headers['content-type'] === 'string' && req.headers['content-type'].trim()) {
            contentType = req.headers['content-type'];
        }
        const read = await readBounded(req, meta.limit);
        if (!read.ok) return early(read.status, 'invalid_request_error', read.code, read.message);
        const body = read.body;

        let wanted: string | null = null;
        let chars = 0;
        let imagesAsked = 1;
        let size: string | undefined;
        if (boundary) {
            wanted = multipartField(body, boundary, 'model')?.trim() || null;
        } else {
            let json: unknown;
            try {
                json = JSON.parse(body.toString('utf8'));
            } catch {
                return early(400, 'invalid_request_error', 'invalid_json', 'The request body is not valid JSON');
            }
            if (!isRecord(json)) {
                return early(400, 'invalid_request_error', 'invalid_request', 'The request body must be a JSON object');
            }
            wanted = typeof json['model'] === 'string' && json['model'].trim() ? json['model'].trim() : null;
            if (endpoint === 'audio/speech') {
                if (typeof json['input'] !== 'string' || json['input'] === '') {
                    return early(400, 'invalid_request_error', 'invalid_request', '"input" is required');
                }
                chars = countChars(json['input']);
            } else {
                const n = json['n'];
                imagesAsked = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 1;
                size = typeof json['size'] === 'string' ? json['size'] : undefined;
            }
        }
        if (!wanted) return early(400, 'invalid_request_error', 'missing_model', 'The request needs a "model"');
        modelId = wanted;

        let key: SecretValue | null;
        try {
            key = resolveKey(user, connection.keyId);
        } catch {
            return early(500, 'server_error', 'secrets_error', 'The secret store could not be read');
        }
        if (!key) {
            const message = connection.keyId
                ? 'The NanoGPT key chosen for this connection no longer exists'
                : 'No NanoGPT key is stored; add one in SillyTavern';
            return early(409, 'invalid_request_error', 'no_key', message);
        }
        // The catalog only prices the call (an estimate); a model it does not know is NanoGPT's to accept or refuse.
        const catalogModel: MediaModel | null = (() => {
            try {
                return deps.media.catalog.lookup(meta.medium, wanted);
            } catch {
                return null;
            }
        })();

        /* ---- the upstream call */
        const timeoutMs = {
            tts: deps.media.timeouts.ttsMs,
            stt: deps.media.timeouts.sttMs,
            image: deps.media.timeouts.imageMs,
            video: deps.media.timeouts.videoSubmitMs,
        }[meta.medium];
        let upstream;
        try {
            upstream = await openMedia(deps.media.env, key, {
                method: 'POST',
                path: meta.path,
                body,
                contentType,
                accept: '*/*',
                billing: connection.billing === 'paygo' ? 'paygo' : 'auto',
                timeoutMs,
                signal: clientAbort.signal,
            });
        } catch (error) {
            const kind = error instanceof MediaCallError ? error.kind : 'unreachable';
            if (kind === 'aborted') return record({ ...nothing, status: 499, error: 'client_aborted' });
            log.warn(`media upstream ${kind} for connection ${connection.id}`);
            const timeout = kind === 'timeout';
            return early(
                timeout ? 504 : 502,
                'upstream_error',
                timeout ? 'upstream_timeout' : 'upstream_unreachable',
                timeout ? 'NanoGPT did not answer in time' : 'NanoGPT could not be reached',
            );
        }

        try {
            const upstreamId = upstream.headers['x-request-id'] ?? null;
            const common: Record<string, string> = { ...connectionHeader };
            if (upstreamId) common[RESPONSE_HEADERS.requestId] = headerSafe(upstreamId);
            const ok = upstream.status >= 200 && upstream.status < 300;

            /** The answer, read whole up to `limit` bytes; null when it was cut off or too big (the reply is already sent). */
            const readAll = async (limit: number): Promise<Buffer | null> => {
                const chunks: Buffer[] = [];
                let total = 0;
                try {
                    for await (const chunk of upstream.body) {
                        upstream.touch();
                        total += chunk.length;
                        if (total > limit) throw new MediaCallError('too_large');
                        chunks.push(Buffer.from(chunk));
                    }
                } catch (error) {
                    const kind = error instanceof MediaCallError ? error.kind : 'unreachable';
                    if (kind === 'aborted') {
                        await record({ ...nothing, status: 499, error: 'client_aborted' });
                    } else {
                        const timeout = kind === 'timeout';
                        await early(
                            timeout ? 504 : 502,
                            'upstream_error',
                            kind === 'too_large'
                                ? 'upstream_error'
                                : timeout
                                  ? 'upstream_timeout'
                                  : 'upstream_unreachable',
                            kind === 'too_large'
                                ? 'NanoGPT answered with more data than the plugin accepts'
                                : timeout
                                  ? 'NanoGPT stopped sending data'
                                  : 'The NanoGPT connection broke',
                        );
                    }
                    return null;
                }
                return Buffer.concat(chunks);
            };

            /* ---- an error answer: the OpenAI envelope, the upstream status */
            if (!ok) {
                const raw = await readAll(MAX_ERROR_BYTES);
                if (raw === null) return;
                const failure = openAiError(upstream.status, key.redact(raw.toString('utf8')));
                const headers: Record<string, string> = {
                    ...common,
                    'content-type': 'application/json; charset=utf-8',
                    'content-length': String(failure.body.length),
                    'cache-control': 'no-store',
                };
                const retryAfter = upstream.headers['retry-after'];
                if (retryAfter) headers['retry-after'] = headerSafe(retryAfter);
                await record({ ...nothing, status: upstream.status, error: key.redact(failure.code) });
                if (!res.destroyed) {
                    res.writeHead(upstream.status, headers);
                    res.end(failure.body);
                }
                return;
            }

            /* ---- speech: the audio is relayed chunk by chunk, with the catalog's estimate as the cost */
            if (endpoint === 'audio/speech') {
                const estimate = catalogModel ? estimateTtsCost(catalogModel, chars) : null;
                const headers: Record<string, string> = {
                    ...common,
                    // Never assumed: a model that answers WAV for a requested mp3 says so here.
                    'content-type': upstream.headers['content-type'] ?? 'application/octet-stream',
                    'cache-control': 'no-store',
                };
                const length = upstream.headers['content-length'];
                if (length && /^\d+$/.test(length)) headers['content-length'] = length;
                if (estimate !== null) headers[RESPONSE_HEADERS.cost] = formatUsd(estimate);
                res.writeHead(upstream.status, headers);
                res.flushHeaders();
                res.socket?.setNoDelay(true);
                let failure: MediaCallError | null = null;
                try {
                    for await (const chunk of upstream.body) {
                        upstream.touch();
                        await writeChunk(res, chunk);
                        if (clientAbort.signal.aborted) break;
                    }
                } catch (error) {
                    failure = error instanceof MediaCallError ? error : new MediaCallError('unreachable');
                }
                const aborted = clientAbort.signal.aborted || failure?.kind === 'aborted';
                if (failure && !aborted)
                    res.destroy(); // bytes already left: the only honest answer is a broken connection
                else if (!res.writableEnded && !res.destroyed) res.end();
                const source: CostSource = estimate === null ? 'unknown' : 'estimate';
                await record({
                    requestId: null,
                    units: chars,
                    usd: aborted || failure ? null : estimate,
                    costSource: source,
                    paymentSource: null,
                    status: aborted ? 499 : failure ? (failure.kind === 'timeout' ? 504 : 502) : upstream.status,
                    error: aborted
                        ? 'client_aborted'
                        : failure
                          ? failure.kind === 'timeout'
                              ? 'upstream_timeout'
                              : 'upstream_unreachable'
                          : null,
                });
                return;
            }

            /* ---- JSON answers (images, transcription): read whole, parsed for cost, passed through unchanged */
            const answer = await readAll(meta.answerLimit);
            if (answer === null) return;
            const text = key.redact(answer.toString('utf8'));
            let json: unknown;
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
            let outcome: Pick<MediaUsageArgs, 'requestId' | 'units' | 'usd' | 'costSource' | 'paymentSource'>;
            if (endpoint === 'images/generations') {
                const parsed = parseImageBody(json);
                const requestId = upstreamId ?? parsed.requestId;
                const estimate = catalogModel
                    ? estimateImageCost(catalogModel, { n: imagesAsked, ...(size ? { size } : {}) })
                    : null;
                const usd = parsed.usd ?? estimate;
                outcome = {
                    requestId,
                    units: parsed.outputs.length > 0 ? parsed.outputs.length : null,
                    usd,
                    costSource: parsed.usd !== null ? 'response' : estimate !== null ? 'estimate' : 'unknown',
                    paymentSource: parsed.paymentSource,
                };
                if (usd !== null) common[RESPONSE_HEADERS.cost] = formatUsd(usd);
                if (requestId) {
                    common[RESPONSE_HEADERS.requestId] = headerSafe(requestId);
                    deps.media.reconciler.schedule({ userRoot, key, requestId, recordAt: started });
                }
            } else {
                const parsed = parseSttBody(json === undefined ? text : json);
                const estimate =
                    parsed?.durationSec != null && catalogModel
                        ? estimateSttCost(catalogModel, parsed.durationSec)
                        : null;
                const usd = parsed?.usd ?? estimate;
                outcome = {
                    requestId: null,
                    units: parsed?.durationSec ?? null,
                    usd,
                    costSource: parsed?.usd != null ? 'response' : estimate !== null ? 'estimate' : 'unknown',
                    paymentSource: null,
                };
                if (usd !== null) common[RESPONSE_HEADERS.cost] = formatUsd(usd);
            }
            await record({ ...outcome, status: upstream.status, error: null });
            if (!res.destroyed) {
                res.writeHead(upstream.status, {
                    ...common,
                    'content-type': upstream.headers['content-type'] ?? 'application/json',
                    'content-length': String(answer.length),
                    'cache-control': 'no-store',
                });
                res.end(answer);
            }
        } finally {
            upstream.close();
        }
    };
}
