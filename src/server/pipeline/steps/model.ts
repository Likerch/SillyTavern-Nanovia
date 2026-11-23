// Which model goes upstream: the connection's own when it is locked, otherwise the model of the request when it names
// one, otherwise the connection's.
import type { ProxyContext } from '../../types';

export function chooseModel(ctx: Pick<ProxyContext, 'connection' | 'body'>): string {
    if (ctx.connection.modelLock) return ctx.connection.modelId;
    const requested = ctx.body['model'];
    return typeof requested === 'string' && requested.trim() ? requested.trim() : ctx.connection.modelId;
}

export function modelStep(ctx: ProxyContext): void {
    const model = chooseModel(ctx);
    ctx.plan.model = model;
    ctx.plan.body['model'] = model;
}
