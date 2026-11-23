// Media routes (stage 0.7, contract: src/shared/contracts-media.ts): images, speech, transcription and video through the
// user's NanoGPT key, which never leaves the plugin.
//
//   GET    /media/catalog?medium=image|video|tts|stt[&refresh=1]  -> MediaCatalogResponse
//   POST   /media/image                                           -> ImageResult        (OpenAI-compatible `POST /v1/images/generations`)
//   POST   /media/tts                                             -> TtsResult          (`POST /v1/audio/speech`)
//   POST   /media/stt                                             -> SttResult          (`POST /v1/audio/transcriptions`, multipart built here)
//   POST   /media/video                                           -> VideoJob           (`POST /api/generate-video`, asynchronous)
//   GET    /media/video                                           -> { jobs: VideoJob[] }
//   GET    /media/video/:id                                       -> VideoJob           (polls NanoGPT while the job is not finished)
//   DELETE /media/video/:id                                       -> { ok: true }       (forgets the job and its file; NanoGPT has no cancel)
//   GET    /media/files/:id                                       -> the saved video bytes, `Range` supported
//
// Every call writes a usage record (medium, units, cost, cost source); an image's cost is corrected from the billing lookup
// a few seconds later (media-billing.ts). A request is checked first (domain/media-request.ts) and the model must be in the
// catalog of its medium.
import fs from 'node:fs';
import { estimateImageCost, estimateSttCost, estimateTtsCost } from '../../domain/media';
import {
    buildImageBody,
    buildSttFields,
    buildTtsBody,
    checkImageRequest,
    checkSttRequest,
    checkTtsRequest,
    checkVideoRequest,
    countChars,
} from '../../domain/media-request';
import { base64ByteLength, parseImageBody, parseSttBody } from '../../domain/media-wire';
import {
    MEDIA_MEDIA,
    type CostSource,
    type ImageResult,
    type MediaCost,
    type MediaOutput,
    type Medium,
    type SttResult,
    type TtsResult,
} from '../../shared/contracts-media';
import { buildMultipart, contentTypeOf } from '../media-call';
import { isJobId } from '../media-jobs';
import type { RouteModule, RouteRequest, RouteResponse } from '../types';
import { HttpError, route, sendJson, userOf } from './http';
import {
    answerJson,
    failedCall,
    imageOutputMime,
    imageUrlMime,
    isOk,
    mediaRequest,
    modelFor,
    parseByteRange,
    upstreamFailure,
    writeUsage,
    type CallRecord,
} from './media-api';
import { forgetVideo, getVideo, listVideos, submitVideo } from './media-video';
import { queryText, resolveKey } from './nanogpt';

const SERVED_CACHE = 'private, max-age=300';

function mediumOf(req: RouteRequest): Medium {
    const raw = queryText(req, 'medium');
    const medium = MEDIA_MEDIA.find((m) => m === raw);
    if (!medium) throw new HttpError(400, 'invalid_request', '"medium" must be image, video, tts or stt');
    return medium;
}

export const mediaRoutes: RouteModule = (router, deps) => {
    /* -------------------------------------------------------------------------------------------- catalog */

    router.get(
        '/media/catalog',
        route(deps.log, async (req, res) => {
            const medium = mediumOf(req);
            const refresh = queryText(req, 'refresh');
            const result = await deps.media.catalog.catalog(medium, { refresh: refresh === '1' || refresh === 'true' });
            if (!result) {
                throw new HttpError(
                    502,
                    'media_unavailable',
                    `The NanoGPT ${medium} model list could not be fetched and none is stored`,
                );
            }
            sendJson(res, 200, result);
        }),
    );

    /* -------------------------------------------------------------------------------------------- image */

    router.post(
        '/media/image',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const checked = checkImageRequest(req.body);
            if (!checked.ok) throw new HttpError(checked.status, checked.code, checked.message);
            const request = checked.value;
            if (request.inputImages?.some((image) => !image.startsWith('data:'))) {
                throw new HttpError(400, 'invalid_request', 'This route takes input images as data URLs, not as links');
            }
            const model = await modelFor(deps, 'image', request.model);
            const limit = model.params.find((p) => p.key === 'n')?.max;
            if (request.n !== undefined && limit !== undefined && request.n > limit) {
                throw new HttpError(400, 'invalid_request', `This model makes at most ${limit} image(s) per request`);
            }
            const key = resolveKey(deps, user, request.keyId ?? null);
            const call: CallRecord = {
                deps,
                user,
                medium: 'image',
                model: request.model,
                connectionId: request.connectionId ?? null,
                started: deps.now(),
            };

            let answer;
            try {
                answer = await mediaRequest(deps, key, {
                    method: 'POST',
                    path: '/v1/images/generations',
                    body: JSON.stringify(buildImageBody(model, request)),
                    billing: request.billing ?? 'auto',
                    timeoutMs: deps.media.timeouts.imageMs,
                });
            } catch (error) {
                throw await failedCall(call, error as HttpError);
            }
            if (!isOk(answer.status)) throw await failedCall(call, upstreamFailure(key, answer));
            const parsed = parseImageBody(answerJson(key, answer));
            if (parsed.outputs.length === 0) {
                throw await failedCall(call, new HttpError(502, 'upstream_error', 'NanoGPT answered without an image'));
            }

            const format = request.extra?.['output_format'];
            const outputs: MediaOutput[] = parsed.outputs.map((item) =>
                item.dataBase64 !== undefined
                    ? {
                          kind: 'image',
                          mime: imageOutputMime(item.dataBase64, item.mime, format),
                          dataBase64: item.dataBase64,
                          bytes: base64ByteLength(item.dataBase64),
                      }
                    : { kind: 'image', mime: imageUrlMime(item.url ?? '', format), url: item.url ?? '' },
            );
            // The id is the key of the billing lookup; the header wins over the body (live: they are the same string).
            const requestId = answer.headers['x-request-id'] ?? parsed.requestId ?? null;
            const estimate = estimateImageCost(model, {
                ...(request.n !== undefined ? { n: request.n } : {}),
                ...(request.size ? { size: request.size } : {}),
            });
            // The body's figure is the LIST price and can understate the charge: it is the first answer, not the last.
            const usd = parsed.usd ?? estimate;
            const source: CostSource = parsed.usd !== null ? 'response' : estimate !== null ? 'estimate' : 'unknown';
            const cost: MediaCost = {
                usd,
                source,
                estimateUsd: estimate,
                paymentSource: parsed.paymentSource,
                remainingUsd: parsed.remainingUsd,
            };
            await writeUsage(call, {
                requestId,
                units: outputs.length,
                usd,
                costSource: source,
                paymentSource: parsed.paymentSource,
                status: answer.status,
                error: null,
            });
            if (requestId)
                deps.media.reconciler.schedule({ userRoot: user.root, key, requestId, recordAt: call.started });

            const result: ImageResult = {
                model: request.model,
                outputs,
                requestId,
                cost,
                latencyMs: deps.now() - call.started,
            };
            sendJson(res, 200, result);
        }),
    );

    /* -------------------------------------------------------------------------------------------- tts */

    router.post(
        '/media/tts',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const checked = checkTtsRequest(req.body);
            if (!checked.ok) throw new HttpError(checked.status, checked.code, checked.message);
            const request = checked.value;
            const model = await modelFor(deps, 'tts', request.model);
            const key = resolveKey(deps, user, request.keyId ?? null);
            const chars = countChars(request.input);
            const call: CallRecord = {
                deps,
                user,
                medium: 'tts',
                model: request.model,
                connectionId: request.connectionId ?? null,
                started: deps.now(),
            };

            let answer;
            try {
                answer = await mediaRequest(deps, key, {
                    method: 'POST',
                    path: '/v1/audio/speech',
                    body: JSON.stringify(buildTtsBody(model, request)),
                    accept: '*/*',
                    billing: request.billing ?? 'auto',
                    timeoutMs: deps.media.timeouts.ttsMs,
                });
            } catch (error) {
                throw await failedCall(call, error as HttpError);
            }
            if (!isOk(answer.status)) throw await failedCall(call, upstreamFailure(key, answer));

            // The answer is audio in the model's own format (live: audio/x-wav for a requested mp3): its content type is
            // the truth. A JSON answer (the native route's `audioUrl`) is passed on as a link; anything else is a refusal.
            const type = contentTypeOf(answer.headers);
            let audio: MediaOutput;
            if (type === 'application/json') {
                const body = answerJson(key, answer);
                const link =
                    typeof body === 'object' &&
                    body !== null &&
                    typeof (body as Record<string, unknown>)['audioUrl'] === 'string'
                        ? ((body as Record<string, unknown>)['audioUrl'] as string)
                        : null;
                if (link === null || !/^https?:\/\//i.test(link)) {
                    throw await failedCall(
                        call,
                        new HttpError(502, 'upstream_error', 'NanoGPT did not answer with audio'),
                    );
                }
                audio = { kind: 'audio', mime: 'audio/mpeg', url: link };
            } else if (answer.body.length === 0) {
                throw await failedCall(call, new HttpError(502, 'upstream_error', 'NanoGPT answered with no audio'));
            } else {
                audio = {
                    kind: 'audio',
                    mime: type ?? 'application/octet-stream',
                    dataBase64: answer.body.toString('base64'),
                    bytes: answer.body.length,
                };
            }

            // There is no cost in a speech answer and no request id to look one up with: the catalog price is the figure.
            const estimate = estimateTtsCost(model, chars);
            const source: CostSource = estimate === null ? 'unknown' : 'estimate';
            await writeUsage(call, {
                requestId: null,
                units: chars,
                usd: estimate,
                costSource: source,
                paymentSource: null,
                status: answer.status,
                error: null,
            });
            const result: TtsResult = {
                model: request.model,
                audio,
                cost: { usd: estimate, source, estimateUsd: estimate, paymentSource: null, remainingUsd: null },
                chars,
                latencyMs: deps.now() - call.started,
            };
            sendJson(res, 200, result);
        }),
    );

    /* -------------------------------------------------------------------------------------------- stt */

    router.post(
        '/media/stt',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const checked = checkSttRequest(req.body);
            if (!checked.ok) throw new HttpError(checked.status, checked.code, checked.message);
            const request = checked.value;
            const model = await modelFor(deps, 'stt', request.model);
            const key = resolveKey(deps, user, request.keyId ?? null);
            const upload = buildMultipart(buildSttFields(model, request), {
                name: 'file',
                filename: request.filename,
                mime: request.mime,
                data: Buffer.from(request.audioBase64, 'base64'),
            });
            const call: CallRecord = {
                deps,
                user,
                medium: 'stt',
                model: request.model,
                connectionId: request.connectionId ?? null,
                started: deps.now(),
            };

            let answer;
            try {
                answer = await mediaRequest(deps, key, {
                    method: 'POST',
                    path: '/v1/audio/transcriptions',
                    body: upload.body,
                    contentType: upload.contentType,
                    billing: request.billing ?? 'auto',
                    timeoutMs: deps.media.timeouts.sttMs,
                });
            } catch (error) {
                throw await failedCall(call, error as HttpError);
            }
            if (!isOk(answer.status)) throw await failedCall(call, upstreamFailure(key, answer));
            const json = answerJson(key, answer);
            const parsed = parseSttBody(json === undefined ? key.redact(answer.body.toString('utf8')) : json);
            if (!parsed) {
                throw await failedCall(
                    call,
                    new HttpError(502, 'upstream_error', 'NanoGPT answered without a transcript'),
                );
            }

            // The cost is in the body (live: `usage.cost`); without it the catalog price for the reported length stands in.
            const estimate = parsed.durationSec !== null ? estimateSttCost(model, parsed.durationSec) : null;
            const usd = parsed.usd ?? estimate;
            const source: CostSource = parsed.usd !== null ? 'response' : estimate !== null ? 'estimate' : 'unknown';
            await writeUsage(call, {
                requestId: null,
                units: parsed.durationSec,
                usd,
                costSource: source,
                paymentSource: null,
                status: answer.status,
                error: null,
            });
            const result: SttResult = {
                model: request.model,
                text: parsed.text,
                language: parsed.language,
                durationSec: parsed.durationSec,
                segments: parsed.segments,
                cost: { usd, source, estimateUsd: estimate, paymentSource: null, remainingUsd: null },
                latencyMs: deps.now() - call.started,
            };
            sendJson(res, 200, result);
        }),
    );

    /* -------------------------------------------------------------------------------------------- video */

    router.post(
        '/media/video',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const checked = checkVideoRequest(req.body);
            if (!checked.ok) throw new HttpError(checked.status, checked.code, checked.message);
            sendJson(res, 200, await submitVideo(deps, user, checked.value));
        }),
    );

    router.get(
        '/media/video',
        route(deps.log, (req, res) => {
            sendJson(res, 200, { jobs: listVideos(deps, userOf(req, deps)) });
        }),
    );

    router.get(
        '/media/video/:id',
        route(deps.log, async (req, res) => {
            sendJson(res, 200, await getVideo(deps, userOf(req, deps), req.params['id'] ?? ''));
        }),
    );

    router.delete(
        '/media/video/:id',
        route(deps.log, (req, res) => {
            forgetVideo(deps, userOf(req, deps), req.params['id'] ?? '');
            sendJson(res, 200, { ok: true });
        }),
    );

    router.get(
        '/media/files/:id',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const id = req.params['id'] ?? '';
            // The id is looked up among this user's own jobs; only then does it become a path (media-jobs.ts filePath).
            const job = isJobId(id) ? deps.media.jobs.get(user.root, id) : null;
            if (!job || !deps.media.jobs.hasFile(user.root, id))
                throw new HttpError(404, 'not_found', 'No such saved video');
            await serveFile(res, req, deps.media.jobs.filePath(user.root, id), job.output?.mime ?? 'video/mp4');
        }),
    );
};

/** Streams a file with `Range` support (video elements seek with it). The headers go out with the first byte. */
async function serveFile(res: RouteResponse, req: RouteRequest, file: string, mime: string): Promise<void> {
    const { write, end } = res;
    if (typeof write !== 'function' || typeof end !== 'function') {
        throw new HttpError(500, 'internal_error', 'Internal error');
    }
    const size = (await fs.promises.stat(file)).size;
    const rangeHeader = req.headers?.['range'];
    const range = parseByteRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, size);
    res.set('Content-Type', mime);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', SERVED_CACHE);
    res.set('X-Content-Type-Options', 'nosniff');
    if (range.kind === 'unsatisfiable') {
        res.status(416);
        res.set('Content-Range', `bytes */${size}`);
        res.set('Content-Length', '0');
        end.call(res);
        return;
    }
    const start = range.kind === 'partial' ? range.start : 0;
    const last = range.kind === 'partial' ? range.end : size - 1;
    if (range.kind === 'partial') {
        res.status(206);
        res.set('Content-Range', `bytes ${start}-${last}/${size}`);
    } else res.status(200);
    res.set('Content-Length', String(size === 0 ? 0 : last - start + 1));
    if (size === 0) {
        end.call(res);
        return;
    }
    const stream = fs.createReadStream(file, { start, end: last });
    const stop = (): void => {
        stream.destroy();
    };
    res.once?.('close', stop);
    try {
        for await (const chunk of stream) {
            if (res.destroyed === true || res.writableEnded === true) break;
            const flushed = write.call(res, chunk as Uint8Array);
            if (!flushed)
                await new Promise<void>((resolve) => {
                    const done = (): void => {
                        res.off?.('drain', done);
                        res.off?.('close', done);
                        resolve();
                    };
                    res.once?.('drain', done);
                    res.once?.('close', done);
                });
        }
    } catch {
        // the file went away or the client did: nothing more to say
    } finally {
        res.off?.('close', stop);
        if (res.writableEnded !== true) end.call(res);
    }
}
