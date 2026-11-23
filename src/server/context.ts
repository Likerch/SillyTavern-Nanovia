// Builds the ProxyContext of one chat-completions request (docs/ARCHITECTURE.md §4).
import type { BillingImpact, CatalogModel, ConnectionConfig, RequestHints, UpstreamPlan } from '../shared/contracts';
import { HINT_HEADERS } from '../shared/constants';
import type { SecretValue } from './secret-value';
import type { ProxyContext } from './types';

export function unknownBilling(): BillingImpact {
    return { outcome: 'unknown', markupPercent: 0, subscriptionSafe: false, reasons: [], stripped: [] };
}

/** `RequestHints` from the HINT_HEADERS of a request (header names lower case). */
export function parseHints(headers: Record<string, string | string[] | undefined>): RequestHints {
    const first = (name: string): string | null => {
        const raw = headers[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null;
    };
    const consumer = first(HINT_HEADERS.consumer);
    const thoughts = first(HINT_HEADERS.thoughts);
    return {
        effort: first(HINT_HEADERS.effort),
        consumer: consumer === 'main' || consumer === 'background' ? consumer : 'unknown',
        thoughts: thoughts === '1' || thoughts === 'true',
    };
}

export interface ContextInit {
    localId: string;
    now: number;
    user: string;
    connection: ConnectionConfig;
    key: SecretValue;
    model: CatalogModel | null;
    hints: RequestHints;
    body: Record<string, unknown>;
    signal: AbortSignal;
}

export function createProxyContext(init: ContextInit): ProxyContext {
    const { connection, body } = init;
    const requestedModel = typeof body['model'] === 'string' && body['model'] ? body['model'] : connection.modelId;
    const plan: UpstreamPlan = {
        model: requestedModel,
        body: { ...body },
        headers: {},
        billing: unknownBilling(),
        warnings: [],
    };
    return {
        localId: init.localId,
        startedAt: init.now,
        user: init.user,
        connection,
        key: init.key,
        model: init.model,
        hints: init.hints,
        body,
        stream: body['stream'] === true,
        signal: init.signal,
        plan,
        upstream: null,
        responseHeaders: {},
        usage: {
            at: init.now,
            connectionId: connection.id,
            requestId: null,
            model: requestedModel,
            billing: 'unknown',
            costUsd: null,
            equivalentUsd: null,
            promptTokens: null,
            completionTokens: null,
            cachedTokens: null,
            reasoningTokens: null,
            latencyMs: 0,
            status: 0,
            stream: body['stream'] === true,
            consumer: init.hints.consumer,
            error: null,
        },
    };
}
