// SillyTavern always sends its neutral sampler values (top_k 0, top_a 0, min_p 0, repetition_penalty 1, an empty
// logit_bias); some NanoGPT routes reject them. With `stripNeutralSamplers` on they are removed, every other value stays.
import type { ProxyContext } from '../../types';

/** Removes the neutral values from `body` in place and returns the names it removed. */
export function stripNeutralSamplers(body: Record<string, unknown>): string[] {
    const removed: string[] = [];
    const neutral: [string, unknown][] = [
        ['top_k', 0],
        ['top_a', 0],
        ['min_p', 0],
        ['repetition_penalty', 1],
    ];
    for (const [name, value] of neutral) {
        if (body[name] === value) {
            delete body[name];
            removed.push(name);
        }
    }
    const bias = body['logit_bias'];
    if (typeof bias === 'object' && bias !== null && !Array.isArray(bias) && Object.keys(bias).length === 0) {
        delete body['logit_bias'];
        removed.push('logit_bias');
    }
    return removed;
}

export function stripSamplersStep(ctx: ProxyContext): void {
    if (ctx.connection.stripNeutralSamplers) stripNeutralSamplers(ctx.plan.body);
}
