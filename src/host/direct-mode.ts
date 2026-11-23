// Direct mode (docs/ARCHITECTURE.md §1, §5): a connection whose Connection Manager profile points straight at NanoGPT.
// There is no proxy to build the upstream request, so the browser does it: the pure `planUpstream()` (the very function
// the proxy runs) plans the request, and what differs from the body ST built goes out through ST's `custom_include_body`
// and `custom_include_headers`. The answer is watched by the usage tap (usage-tap.ts) without being altered.
//
// This file knows nothing about the layers above host: it gets what it needs through `DirectModeDeps`.
import { planUpstream } from '../domain/upstream';
import { NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK } from '../shared/constants';
import type {
    CatalogModel,
    ConnectionConfig,
    ModelProviders,
    RequestHints,
    UpstreamPlan,
    UsageRecord,
} from '../shared/contracts';
import { addIncludeBody, addIncludeHeaders, hintsOf } from './fetch-hook';
import type { GenerateRequest, RequestHook, ResponseObserver } from './fetch-hook';
import type { Logger } from './types';
import { tapUsage } from './usage-tap';

export interface DirectConnectionRef {
    config: ConnectionConfig;
    /** The mode the connection runs in now (an `auto` connection is direct while the plugin is down). */
    effectiveMode: 'plugin' | 'direct';
}

export interface DirectModeDeps {
    /** Every connection the browser knows. */
    connections(): readonly DirectConnectionRef[];
    /** connectionId -> id of the ST secret that holds the NanoGPT key of its direct profile. */
    directSecrets(): Readonly<Record<string, string>>;
    /** The catalog entry of a model id (suffixes are the catalog's business); null when unknown. */
    model(id: string): CatalogModel | null;
    /** The cached hosts of a model; null when not fetched. */
    providers(id: string): ModelProviders | null;
    /** Where finished usage records go (the bus `usage:record`). */
    emit(record: UsageRecord): void;
    log: Logger;
    now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, '').toLowerCase();
}

const NANOGPT_BASES: readonly string[] = [NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK].map(trimSlash);

/**
 * The connection a request to NanoGPT belongs to, or null (the request is somebody else's and stays as it is).
 * 1. The `secret_id` of the request is the direct key of exactly one connection.
 * 2. No secret id came along, `custom_url` is the NanoGPT base itself, and exactly one connection that runs direct has the
 *    requested model as its model. A secret id that is not ours always means "not ours": a user's own NanoGPT profile.
 */
export function matchDirectConnection(
    request: Pick<GenerateRequest, 'body' | 'secretId'>,
    connections: readonly DirectConnectionRef[],
    directSecrets: Readonly<Record<string, string>>,
): ConnectionConfig | null {
    if (request.secretId) {
        for (const [connectionId, secretId] of Object.entries(directSecrets)) {
            if (secretId !== request.secretId) continue;
            const found = connections.find((ref) => ref.config.id === connectionId);
            if (found) return found.config;
        }
        return null;
    }
    const url = request.body['custom_url'];
    if (typeof url !== 'string' || !NANOGPT_BASES.includes(trimSlash(url.trim()))) return null;
    const model = request.body['model'];
    if (typeof model !== 'string' || !model.trim()) return null;
    const matches = connections.filter((ref) => ref.effectiveMode === 'direct' && ref.config.modelId === model.trim());
    return matches.length === 1 ? (matches[0]?.config ?? null) : null;
}

/** Same JSON value (key order does not matter). */
function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) {
        return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
    }
    if (isRecord(a) && isRecord(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
    }
    return false;
}

export interface PlanDifference {
    /** Fields the plan added or changed: they go out through `custom_include_body`. */
    set: Record<string, unknown>;
    /** Fields of the original body the plan dropped (neutral samplers, `reasoning_effort` …). */
    remove: string[];
}

/** What separates the planned body from the body ST built. Pure. */
export function planDifference(original: Record<string, unknown>, planned: Record<string, unknown>): PlanDifference {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(planned)) {
        if (!(key in original) || !sameValue(original[key], value)) set[key] = value;
    }
    const remove = Object.keys(original).filter((key) => !(key in planned));
    return { set, remove };
}

export interface DirectPlan {
    plan: UpstreamPlan;
    hints: RequestHints;
    /** The catalog entry of the model that is sent; null when unknown. */
    model: CatalogModel | null;
}

/** Runs planUpstream for a request of a connection, with what the catalog knows. */
export function planDirectRequest(
    deps: Pick<DirectModeDeps, 'model' | 'providers'>,
    connection: ConnectionConfig,
    request: Pick<GenerateRequest, 'body' | 'consumer'>,
): DirectPlan {
    const hints = hintsOf(request);
    // The planner decides which model is sent (lock, the request's model, suffixes); ask it with a body that is only the
    // model, so the catalog lookup below can use the final id without copying the planner's rule.
    const sent = planUpstream({
        connection,
        model: null,
        body: { model: request.body['model'] },
        hints,
        providerSelection: null,
    }).model;
    const model = deps.model(sent);
    const selection = deps.providers(model?.id ?? sent)?.supportsProviderSelection ?? null;
    const plan = planUpstream({ connection, model, body: request.body, hints, providerSelection: selection });
    return { plan, hints, model };
}

/** Writes a plan into the request: the difference through the include fields, the dropped fields removed. */
export function applyPlan(request: GenerateRequest, plan: UpstreamPlan): void {
    const { set, remove } = planDifference(request.body, plan.body);
    for (const key of remove) delete request.body[key];
    if (Object.keys(set).length > 0) {
        const result = addIncludeBody(request, set);
        if (result.ok && result.kept.length > 0) {
            request.log.debug(`custom_include_body already sets ${result.kept.join(', ')}; the user's value stays`);
        }
    }
    if (Object.keys(plan.headers).length > 0) addIncludeHeaders(request, plan.headers);
}

export interface DirectMode {
    hook: RequestHook;
    observer: ResponseObserver;
}

/** The two halves of direct mode: the request hook (plan) and the response observer (usage tap). */
export function createDirectMode(deps: DirectModeDeps): DirectMode {
    const now = deps.now ?? Date.now;

    const hook: RequestHook = (request) => {
        if (request.target?.kind !== 'direct') return;
        const connection = matchDirectConnection(request, deps.connections(), deps.directSecrets());
        if (!connection) {
            request.log.debug('a request to NanoGPT that is not a Nanovia direct connection; left alone');
            return;
        }
        const { plan, model } = planDirectRequest(deps, connection, request);
        applyPlan(request, plan);
        request.direct = {
            connectionId: connection.id,
            modelId: plan.model,
            billingModeForced: connection.billing === 'paygo',
            explicitRouting: plan.billing.reasons.some((reason) => reason.code === 'routing.explicit'),
        };
        const warnings = plan.warnings.map((warning) => warning.code);
        request.log.debug(
            `direct plan for ${connection.id}: ${plan.model}, ${plan.billing.outcome}` +
                (model ? '' : ', model not in the catalog') +
                (warnings.length > 0 ? `, warnings: ${warnings.join(', ')}` : ''),
        );
    };

    const observer: ResponseObserver = ({ request, response, startedAt }) => {
        const info = request.direct;
        if (!info) return;
        // Not awaited: the tap reads its clone in the background and never throws.
        void tapUsage({
            response,
            info,
            consumer: request.consumer,
            stream: request.body['stream'] === true,
            startedAt,
            now,
            model: deps.model(info.modelId),
            emit: deps.emit,
            log: deps.log,
        });
    };

    return { hook, observer };
}
