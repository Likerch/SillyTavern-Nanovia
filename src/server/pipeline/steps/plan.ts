// The one request step: builds what goes to NanoGPT with the pure planUpstream (the same function the browser hook uses
// in direct mode): the model (lock, suffixes), the neutral-sampler strip, usage flags, reasoning, routing, the billing
// mode and the billing impact. It writes the result into `ctx.plan` and runs first, so later steps only refine it.
import { planUpstream } from '../../../domain/upstream';
import type { CatalogModel, ConnectionConfig } from '../../../shared/contracts';
import type { ProxyContext, ServerDeps } from '../../types';

/** The model the request is about before suffixes: the locked connection model, else the request's, else the connection's. */
export function requestedModelId(connection: ConnectionConfig, body: Readonly<Record<string, unknown>>): string {
    if (connection.modelLock) return connection.modelId;
    const requested = body['model'];
    return typeof requested === 'string' && requested.trim() ? requested.trim() : connection.modelId;
}

/** `:online`, `:online/<level>`, `:memory`, `:memory-<days>`: routing suffixes that are not part of the catalog id. */
const SERVICE_SUFFIX = /:(?:online(?:\/[^:]*)?|memory(?:-\d+)?)$/;

/** The model id without the service suffixes of NanoGPT (`:thinking` and friends are catalog ids of their own). */
export function stripServiceSuffixes(modelId: string): string {
    let id = modelId;
    for (let i = 0; i < 4 && SERVICE_SUFFIX.test(id); i++) id = id.replace(SERVICE_SUFFIX, '');
    return id;
}

export interface CatalogLookup {
    model: CatalogModel | null;
    /** `supportsProviderSelection` of the model; null when unknown (the planner treats that as true). */
    providerSelection: boolean | null;
}

/**
 * What the catalog says about a model, tolerant of every failure: a catalog that is missing, still loading or throwing
 * means "unknown" (null), never a failed request. The exact id wins over the id without service suffixes.
 */
export function lookupCatalog(
    deps: Pick<ServerDeps, 'lookupModel' | 'providerSelection'>,
    modelId: string,
): CatalogLookup {
    const bare = stripServiceSuffixes(modelId);
    const candidates = bare === modelId ? [modelId] : [modelId, bare];
    let model: CatalogModel | null = null;
    for (const id of candidates) {
        model = safely(() => deps.lookupModel(id));
        if (model) break;
    }
    const selectionId = model?.id ?? bare;
    const selection = deps.providerSelection ? safely(() => deps.providerSelection?.(selectionId) ?? null) : null;
    return { model, providerSelection: typeof selection === 'boolean' ? selection : null };
}

function safely<T>(read: () => T | null): T | null {
    try {
        return read() ?? null;
    } catch {
        return null;
    }
}

export function planStep(ctx: ProxyContext): void {
    const plan = planUpstream({
        connection: ctx.connection,
        model: ctx.model,
        body: ctx.body as Record<string, unknown>,
        hints: ctx.hints,
        providerSelection: ctx.providerSelection,
    });
    ctx.plan.model = plan.model;
    ctx.plan.body = plan.body;
    ctx.plan.headers = { ...ctx.plan.headers, ...plan.headers };
    ctx.plan.billing = plan.billing;
    ctx.plan.warnings = plan.warnings;
}
