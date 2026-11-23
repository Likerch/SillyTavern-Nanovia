// Usage capture and the OpenRouter-style response shim on the response path (docs/ARCHITECTURE.md §4, stage 0.4).
//
// Every reply that carries NanoGPT's `usage` leaves with real USD in `usage.cost` (0 for a subscription request) and a
// `nanovia` block; the same facts become the one UsageRecord of the request. Nothing else in the reply changes: a body
// that is not JSON, an error, or JSON without usage goes through byte for byte.
//
//   non-streamed: `usageStep` (a response step) parses the complete body once.
//   streamed:     `SseUsageShim` sits in the relay loop. Events without usage are forwarded the moment they are complete and
//                 unchanged; only an event that carries usage is parsed and rewritten. No timer, no batching.
import { buildUsageRecord } from '../domain/cost';
import { rewriteSseEvent, SseSplitter } from '../domain/sse';
import { shimResponse, type ResolvedUsage, type ShimContext } from '../domain/shim';
import { isRecord } from '../domain/usage';
import type { ProxyContext, ResponseStep } from './types';

/** What the shim needs to know about the request; the upstream request id is known once the upstream answered. */
export function shimContextOf(ctx: ProxyContext): ShimContext {
    return {
        model: ctx.model,
        billingModeForced: ctx.connection.billing === 'paygo',
        explicitRouting: ctx.plan.billing.reasons.some((reason) => reason.code === 'routing.explicit'),
        requestId: ctx.upstream?.requestId ?? null,
    };
}

export interface ShimmedBody {
    /** The very same buffer when nothing was rewritten. */
    body: Buffer;
    resolved: ResolvedUsage | null;
}

/** Rewrites the usage of a complete JSON reply. Anything that is not a JSON object, or is an error, is returned as is. */
export function shimJsonBody(raw: Buffer, shim: ShimContext): ShimmedBody {
    const untouched: ShimmedBody = { body: raw, resolved: null };
    let json: unknown;
    try {
        json = JSON.parse(raw.toString('utf8'));
    } catch {
        return untouched;
    }
    if (!isRecord(json) || (json['error'] !== undefined && json['error'] !== null)) return untouched;
    const result = shimResponse(json, shim);
    if (!result.resolved) return untouched;
    return { body: Buffer.from(JSON.stringify(result.body), 'utf8'), resolved: result.resolved };
}

/**
 * Passes an SSE stream through chunk by chunk. `push` returns the bytes to write for a chunk (null: only part of an
 * event arrived, it is held until its blank line); `end` returns what is left when the upstream finished. Events are
 * decoded and encoded as UTF-8, which is what SSE is, so an event without usage comes out byte-identical.
 */
export class SseUsageShim {
    private readonly splitter = new SseSplitter();
    private latest: ResolvedUsage | null = null;

    constructor(private readonly shim: ShimContext) {}

    /** The facts of the last event that carried usage; null while there was none. */
    get resolved(): ResolvedUsage | null {
        return this.latest;
    }

    push(chunk: Uint8Array): Buffer | null {
        return this.encode(this.splitter.feed(chunk));
    }

    end(): Buffer | null {
        return this.encode(this.splitter.flush());
    }

    private encode(events: string[]): Buffer | null {
        if (events.length === 0) return null;
        let text = '';
        for (const event of events) text += this.forward(event);
        return Buffer.from(text, 'utf8');
    }

    private forward(event: string): string {
        if (!event.includes('usage')) return event;
        try {
            const rewritten = rewriteSseEvent(event, this.shim);
            if (rewritten.resolved) this.latest = rewritten.resolved;
            return rewritten.text;
        } catch {
            return event; // a bug in the rewriting must never cost the client an event
        }
    }
}

/** Fills `ctx.usage` from what is known: the status and error the proxy set, the usage the response carried, the plan. */
export function applyUsageRecord(ctx: ProxyContext): void {
    const { requestId, ...costContext } = shimContextOf(ctx); // the header wins over the id inside the body
    Object.assign(
        ctx.usage,
        buildUsageRecord({
            ...costContext,
            requestId,
            at: ctx.startedAt,
            connectionId: ctx.connection.id,
            modelId: ctx.plan.model,
            usage: ctx.resolved?.usage ?? null,
            latencyMs: ctx.usage.latencyMs,
            status: ctx.usage.status,
            stream: ctx.stream,
            consumer: ctx.hints.consumer,
            error: ctx.usage.error,
        }),
    );
}

/**
 * Response step. A non-streamed 2xx body goes through the shim here (before the reply is written); then the usage record
 * is completed. A streamed reply was shimmed while it flowed (`ctx.resolved` is already set); an error reply is not touched.
 */
export const usageStep: ResponseStep = (ctx) => {
    const info = ctx.upstream;
    if (info && !info.stream && info.body !== null && info.status >= 200 && info.status < 300) {
        const result = shimJsonBody(info.body, shimContextOf(ctx));
        info.body = result.body;
        ctx.resolved = result.resolved;
    }
    applyUsageRecord(ctx);
};
