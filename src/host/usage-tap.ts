// The response tap of direct mode: watches the answer to a generate request of a direct connection and turns its
// `usage` into one UsageRecord, without touching what ST receives.
//
// ST gets the original Response untouched. The tap reads `response.clone()` in the background: a non-streamed answer is
// parsed as JSON, a streamed one goes through the SseSplitter chunk by chunk and only the events that carry usage are
// parsed. Nothing here throws into the caller: every failure is logged at debug level and the record is just not written.
import { buildUsageRecord } from '../domain/cost';
import type { BuildUsageRecordArgs } from '../domain/cost';
import { SseSplitter, rewriteSseEvent } from '../domain/sse';
import type { ShimContext } from '../domain/shim';
import { resolveUsage } from '../domain/shim';
import type { NormalizedUsage } from '../domain/usage';
import type { CatalogModel, RequestHints, UsageRecord } from '../shared/contracts';
import type { DirectRequestInfo } from './fetch-hook';
import type { Logger } from './types';

/** The longest error text kept in a record. */
const MAX_ERROR_LENGTH = 300;

export interface UsageTapArgs {
    /** The response ST receives. Only `clone()`d here, never read. */
    response: Response;
    info: DirectRequestInfo;
    consumer: RequestHints['consumer'];
    /** The request asked for a stream. */
    stream: boolean;
    startedAt: number;
    now: () => number;
    /** The catalog entry of the model that was sent; null when unknown. */
    model: CatalogModel | null;
    emit(record: UsageRecord): void;
    log: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_ERROR_LENGTH ? `${flat.slice(0, MAX_ERROR_LENGTH)}…` : flat;
}

/** The message of an OpenAI-style error body (`{ error: { message } }` or `{ error: "…" }`); null when it is none. */
export function errorOf(json: unknown): string | null {
    if (!isRecord(json)) return null;
    const error = json['error'];
    if (typeof error === 'string' && error) return clip(error);
    if (isRecord(error)) {
        for (const key of ['message', 'code', 'type']) {
            const value = error[key];
            if (typeof value === 'string' && value) return clip(value);
        }
        return 'error';
    }
    return null;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** The `data:` lines of one raw SSE event are handled by rewriteSseEvent; this only asks whether it can carry usage. */
function mayCarryUsage(event: string): boolean {
    return event.includes('usage') || event.includes('x_nanogpt_pricing');
}

function headerOf(response: Response, name: string): string | null {
    try {
        const value = response.headers.get(name);
        return value && value.trim() ? value.trim() : null;
    } catch {
        return null;
    }
}

interface Outcome {
    usage: NormalizedUsage | null;
    error: string | null;
}

async function readJson(clone: Response, ctx: ShimContext): Promise<Outcome> {
    const json = parseJson(await clone.text());
    return { usage: resolveUsage(json, ctx)?.usage ?? null, error: errorOf(json) };
}

async function readStream(clone: Response, ctx: ShimContext): Promise<Outcome> {
    const reader = clone.body?.getReader();
    if (!reader) return { usage: null, error: null };
    const splitter = new SseSplitter();
    let latest: NormalizedUsage | null = null;
    let error: string | null = null;
    const take = (events: string[]): void => {
        for (const event of events) {
            if (!mayCarryUsage(event)) continue;
            // rewriteSseEvent only reads here: its output text is thrown away, the stream ST reads is another object.
            const resolved = rewriteSseEvent(event, ctx).resolved;
            if (resolved) latest = resolved.usage;
        }
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            take(splitter.feed(value));
        }
        take(splitter.flush());
    } catch (cause) {
        // The reader failed in the middle: ST stopped the request (an abort) or the connection broke. Keep what was seen.
        take(splitter.flush());
        error = cause instanceof Error && cause.name === 'AbortError' ? 'client_aborted' : 'stream_error';
    }
    return { usage: latest, error };
}

/** The Response of a stream: server-sent events. */
function isEventStream(contentType: string): boolean {
    return contentType.toLowerCase().includes('text/event-stream');
}

/**
 * Observes one response and emits its UsageRecord. Resolves when the whole body has been read (a stream: when it ended);
 * never rejects. The `clone()` happens before the first `await`, so it is taken before ST can start reading.
 */
export async function tapUsage(args: UsageTapArgs): Promise<void> {
    try {
        const { response, info } = args;
        const clone = response.clone();
        const status = response.status;
        const requestId = headerOf(response, 'x-request-id');
        const contentType = headerOf(response, 'content-type') ?? '';
        const shim: ShimContext = {
            model: args.model,
            billingModeForced: info.billingModeForced,
            explicitRouting: info.explicitRouting,
            requestId,
        };

        let outcome: Outcome;
        let stream = args.stream;
        if (!response.ok) {
            const text = await clone.text();
            const json = parseJson(text);
            outcome = { usage: null, error: errorOf(json) ?? (clip(text) || `http_${status}`) };
        } else if (isEventStream(contentType) || (args.stream && !contentType.toLowerCase().includes('json'))) {
            stream = true;
            outcome = await readStream(clone, shim);
        } else {
            stream = false;
            outcome = await readJson(clone, shim);
        }

        const record = buildUsageRecord({
            at: args.startedAt,
            connectionId: info.connectionId,
            modelId: info.modelId,
            model: args.model,
            billingModeForced: info.billingModeForced,
            explicitRouting: info.explicitRouting,
            usage: outcome.usage,
            requestId,
            latencyMs: Math.max(0, args.now() - args.startedAt),
            status,
            stream,
            consumer: args.consumer,
            error: outcome.error,
        } satisfies BuildUsageRecordArgs);
        args.emit(record);
    } catch (error) {
        args.log.debug('the usage tap failed; no record was written', error);
    }
}
