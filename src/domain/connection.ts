// Connection model: defaults, sanitising of untrusted JSON (files, requests, imported settings) and patching.
// Pure: no randomness and no clock; callers pass ids and timestamps.
import type {
    BillingMode,
    ConnectionConfig,
    ConnectionMode,
    Quantization,
    ReasoningConfig,
    ReasoningEffort,
    ReasoningPolicy,
    RoutingConfig,
    RoutingSort,
} from '../shared/contracts';

export const QUANTIZATIONS: readonly Quantization[] = [
    'int4',
    'fp4',
    'fp6',
    'int8',
    'fp8',
    'fp16',
    'bf16',
    'fp32',
    'unknown',
];
const SORTS: readonly RoutingSort[] = ['default', 'price', 'throughput', 'latency', 'speed'];
const MODES: readonly ConnectionMode[] = ['auto', 'plugin', 'direct'];
const BILLING: readonly BillingMode[] = ['auto', 'subscription', 'paygo'];
const POLICIES: readonly ReasoningPolicy[] = ['follow', 'fixed', 'off', 'default'];
const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const CONNECTION_ID_PATTERN = /^[a-z0-9]{6,16}$/;

export function isValidConnectionId(value: unknown): value is string {
    return typeof value === 'string' && CONNECTION_ID_PATTERN.test(value);
}

export function defaultRouting(): RoutingConfig {
    return {
        enabled: false,
        order: [],
        only: [],
        ignore: [],
        sort: 'default',
        quantizations: [],
        minQuantization: null,
        maxPrice: { prompt: null, completion: null },
        allowFallbacks: true,
        requireParameters: false,
        zdr: false,
        preferredMaxLatency: null,
        preferredMinThroughput: null,
        cachingRoute: false,
    };
}

export function defaultReasoning(): ReasoningConfig {
    return { policy: 'follow', effort: null, hideThoughts: false };
}

/** A new connection with every field at its default. `id` and `now` come from the caller. */
export function createConnection(
    input: Partial<ConnectionConfig> & { name: string; modelId: string },
    id: string,
    now: number,
): ConnectionConfig {
    const base: ConnectionConfig = {
        id,
        name: input.name,
        modelId: input.modelId,
        modelLock: false,
        mode: 'auto',
        keyId: null,
        billing: 'auto',
        routing: defaultRouting(),
        reasoning: defaultReasoning(),
        webSearch: false,
        memory: { enabled: false, expirationDays: null },
        stripNeutralSamplers: true,
        note: '',
        createdAt: now,
        updatedAt: now,
    };
    return mergeConnection(base, { ...input, id, createdAt: now }, now);
}

/** Applies a patch (already typed or raw) over a connection; unknown or invalid fields are ignored. */
export function mergeConnection(base: ConnectionConfig, patch: unknown, now: number): ConnectionConfig {
    const p = isRecord(patch) ? patch : {};
    const next: ConnectionConfig = {
        ...base,
        routing: { ...base.routing, maxPrice: { ...base.routing.maxPrice }, order: [...base.routing.order] },
        reasoning: { ...base.reasoning },
        memory: { ...base.memory },
    };
    if (typeof p['name'] === 'string' && p['name'].trim()) next.name = clip(p['name'].trim(), 80);
    if (typeof p['modelId'] === 'string' && p['modelId'].trim()) next.modelId = clip(p['modelId'].trim(), 200);
    if (typeof p['modelLock'] === 'boolean') next.modelLock = p['modelLock'];
    if (isOneOf(MODES, p['mode'])) next.mode = p['mode'];
    if (p['keyId'] === null) next.keyId = null;
    else if (typeof p['keyId'] === 'string' && p['keyId'].trim()) next.keyId = clip(p['keyId'].trim(), 100);
    if (isOneOf(BILLING, p['billing'])) next.billing = p['billing'];
    if (typeof p['webSearch'] === 'boolean') next.webSearch = p['webSearch'];
    if (typeof p['stripNeutralSamplers'] === 'boolean') next.stripNeutralSamplers = p['stripNeutralSamplers'];
    if (typeof p['note'] === 'string') next.note = clip(p['note'], 1000);
    if (isRecord(p['routing'])) next.routing = mergeRouting(next.routing, p['routing']);
    if (isRecord(p['reasoning'])) next.reasoning = mergeReasoning(next.reasoning, p['reasoning']);
    if (isRecord(p['memory'])) {
        const m = p['memory'];
        if (typeof m['enabled'] === 'boolean') next.memory.enabled = m['enabled'];
        if (m['expirationDays'] === null) next.memory.expirationDays = null;
        else if (isNumber(m['expirationDays']))
            next.memory.expirationDays = clamp(Math.round(m['expirationDays']), 1, 365);
    }
    if (isNumber(p['createdAt'])) next.createdAt = p['createdAt'];
    next.updatedAt = now;
    return next;
}

/**
 * Sanitises a connection read from disk or the wire. Returns null when it cannot be a connection (no valid id, name or
 * model). Everything else falls back to defaults, so a hand-edited file never crashes the plugin.
 */
export function normalizeConnection(raw: unknown, now: number): ConnectionConfig | null {
    if (!isRecord(raw)) return null;
    const id = raw['id'];
    const name = raw['name'];
    const modelId = raw['modelId'];
    if (!isValidConnectionId(id) || typeof name !== 'string' || !name.trim()) return null;
    if (typeof modelId !== 'string' || !modelId.trim()) return null;
    const created = isNumber(raw['createdAt']) ? raw['createdAt'] : now;
    const base = createConnection({ name: name.trim(), modelId: modelId.trim() }, id, created);
    const merged = mergeConnection(base, raw, isNumber(raw['updatedAt']) ? raw['updatedAt'] : now);
    return merged;
}

function mergeRouting(base: RoutingConfig, p: Record<string, unknown>): RoutingConfig {
    const next: RoutingConfig = { ...base, maxPrice: { ...base.maxPrice } };
    if (typeof p['enabled'] === 'boolean') next.enabled = p['enabled'];
    if (Array.isArray(p['order'])) next.order = ids(p['order']);
    if (Array.isArray(p['only'])) next.only = ids(p['only']);
    if (Array.isArray(p['ignore'])) next.ignore = ids(p['ignore']);
    if (isOneOf(SORTS, p['sort'])) next.sort = p['sort'];
    if (Array.isArray(p['quantizations'])) {
        next.quantizations = [
            ...new Set(p['quantizations'].filter((q): q is Quantization => isOneOf(QUANTIZATIONS, q))),
        ];
    }
    if (p['minQuantization'] === null) next.minQuantization = null;
    else if (isOneOf(QUANTIZATIONS, p['minQuantization'])) next.minQuantization = p['minQuantization'];
    if (isRecord(p['maxPrice'])) {
        const mp = p['maxPrice'];
        if (mp['prompt'] === null || isPrice(mp['prompt'])) next.maxPrice.prompt = mp['prompt'];
        if (mp['completion'] === null || isPrice(mp['completion'])) next.maxPrice.completion = mp['completion'];
    }
    if (typeof p['allowFallbacks'] === 'boolean') next.allowFallbacks = p['allowFallbacks'];
    if (typeof p['requireParameters'] === 'boolean') next.requireParameters = p['requireParameters'];
    if (typeof p['zdr'] === 'boolean') next.zdr = p['zdr'];
    if (p['preferredMaxLatency'] === null || isPrice(p['preferredMaxLatency'])) {
        if ('preferredMaxLatency' in p) next.preferredMaxLatency = p['preferredMaxLatency'] as number | null;
    }
    if (p['preferredMinThroughput'] === null || isPrice(p['preferredMinThroughput'])) {
        if ('preferredMinThroughput' in p) next.preferredMinThroughput = p['preferredMinThroughput'] as number | null;
    }
    if (typeof p['cachingRoute'] === 'boolean') next.cachingRoute = p['cachingRoute'];
    return next;
}

function mergeReasoning(base: ReasoningConfig, p: Record<string, unknown>): ReasoningConfig {
    const next = { ...base };
    if (isOneOf(POLICIES, p['policy'])) next.policy = p['policy'];
    if (p['effort'] === null) next.effort = null;
    else if (isOneOf(EFFORTS, p['effort'])) next.effort = p['effort'];
    if (typeof p['hideThoughts'] === 'boolean') next.hideThoughts = p['hideThoughts'];
    return next;
}

function ids(list: unknown[]): string[] {
    const out: string[] = [];
    for (const item of list) {
        if (typeof item !== 'string') continue;
        const v = item.trim().toLowerCase();
        if (v && v.length <= 100 && !out.includes(v)) out.push(v);
    }
    return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** A non-negative finite number (a price, a latency or a throughput). */
function isPrice(value: unknown): value is number {
    return isNumber(value) && value >= 0;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function clip(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
