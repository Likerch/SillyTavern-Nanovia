// planUpstream: the one pure function that turns an incoming OpenAI-style request into what is sent to NanoGPT.
// Used by the proxy (server) and by the browser hook (direct mode). Deterministic, never mutates its input.
import type { PlanWarning, UpstreamInput, UpstreamPlan } from '../shared/contracts';
import { analyzeBilling, subscriptionSafeOverrides } from './billing';
import { planReasoning } from './reasoning';
import { buildProviderObject, routingWarnings } from './routing';

/** Fields ST sends with a neutral value that some NanoGPT routes reject. */
const NEUTRAL_SAMPLERS: ReadonlyArray<readonly [string, number]> = [
    ['top_k', 0],
    ['top_a', 0],
    ['min_p', 0],
    ['repetition_penalty', 1],
];

export function planUpstream(input: UpstreamInput): UpstreamPlan {
    const { connection, hints } = input;
    // A deep copy (the body is JSON): the caller's object, nested messages included, is never touched.
    const body = structuredClone(input.body);
    const safe = connection.billing === 'subscription';

    const model = withSuffixes(chooseModel(connection.modelLock, connection.modelId, body['model']), connection);
    body['model'] = model;

    if (connection.stripNeutralSamplers) stripNeutralSamplers(body);

    body['usage'] = { ...(isRecord(body['usage']) ? body['usage'] : {}), include: true };
    if (body['stream'] === true) {
        body['stream_options'] = {
            ...(isRecord(body['stream_options']) ? body['stream_options'] : {}),
            include_usage: true,
        };
    }

    const reasoning = planReasoning(input.model, connection.reasoning, hints);
    if (reasoning.reasoning !== null) {
        body['reasoning'] = { ...(isRecord(body['reasoning']) ? body['reasoning'] : {}), ...reasoning.reasoning };
        delete body['reasoning_effort'];
    }

    // In subscription mode only `zdr` may survive, whether it comes from the connection or from the request itself.
    const routing = safe ? subscriptionSafeOverrides(connection, input.model).routing : connection.routing;
    if (safe) {
        delete body['caching'];
        if (isRecord(body['provider'])) {
            const zdr = body['provider']['zdr'];
            if (zdr === undefined) delete body['provider'];
            else body['provider'] = { zdr };
        }
    }
    // A model on a fixed route ignores soft routing controls and answers 400 to hard ones it cannot meet: send only zdr.
    const fixedRoute = input.providerSelection === false;
    const provider = buildProviderObject(routing, { zdrOnly: fixedRoute });
    if (provider !== null) {
        body['provider'] = { ...(isRecord(body['provider']) ? body['provider'] : {}), ...provider };
    }
    if (!fixedRoute && routing.enabled && routing.cachingRoute) body['caching'] = true;

    const headers: Record<string, string> = {};
    if (connection.billing === 'paygo') {
        headers['X-Billing-Mode'] = 'paygo';
        body['billing_mode'] = 'paygo';
    }

    const warnings: PlanWarning[] = [...reasoning.warnings, ...routingWarnings(routing)];
    return {
        model,
        body,
        headers,
        billing: analyzeBilling(connection, input.model, input.providerSelection),
        warnings,
    };
}

/** The locked connection model, else the model of the request when it names one, else the connection's model. */
function chooseModel(locked: boolean, connectionModel: string, requested: unknown): string {
    if (locked) return connectionModel;
    if (typeof requested === 'string' && requested.trim()) return requested.trim();
    return connectionModel;
}

/** Appends `:online` and `:memory[-days]` unless the id already carries them. */
function withSuffixes(modelId: string, connection: UpstreamInput['connection']): string {
    const segments = modelId.split(':').slice(1);
    let id = modelId;
    if (connection.webSearch && !segments.some((s) => s === 'online' || s.startsWith('online/'))) id += ':online';
    if (connection.memory.enabled && !segments.some((s) => /^memory(-\d+)?$/.test(s))) {
        const days = connection.memory.expirationDays;
        id += days !== null && Number.isFinite(days) && days >= 1 ? `:memory-${Math.trunc(days)}` : ':memory';
    }
    return id;
}

function stripNeutralSamplers(body: Record<string, unknown>): void {
    for (const [key, neutral] of NEUTRAL_SAMPLERS) {
        if (body[key] === neutral) delete body[key];
    }
    const bias = body['logit_bias'];
    if (isRecord(bias) && Object.keys(bias).length === 0) delete body['logit_bias'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
