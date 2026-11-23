import { describe, expect, it } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import { createProxyContext, parseHints } from '../../src/server/context';
import { REQUEST_STEPS, RESPONSE_STEPS } from '../../src/server/pipeline';
import { planStep } from '../../src/server/pipeline/steps/plan';
import { SecretValue } from '../../src/server/secret-value';
import { usageStep } from '../../src/server/usage-capture';

function contextFor(
    body: Record<string, unknown>,
    patch: Parameters<typeof createConnection>[0] = { name: 'n', modelId: 'glm-5' },
) {
    const connection = createConnection(patch, 'abcd1234', 1);
    return createProxyContext({
        localId: 'l1',
        now: 5,
        user: 'default-user',
        connection,
        key: new SecretValue('sk-x'),
        model: null,
        hints: parseHints({}),
        body,
        signal: new AbortController().signal,
    });
}

describe('context and hints', () => {
    it('copies the body into the plan and reads the stream flag', () => {
        const ctx = contextFor({ stream: true, messages: [1] });
        expect(ctx.stream).toBe(true);
        expect(ctx.plan.body).toEqual(ctx.body);
        expect(ctx.plan.body).not.toBe(ctx.body);
        expect(ctx.usage).toMatchObject({ connectionId: 'abcd1234', billing: 'unknown', costUsd: null, stream: true });
        expect(JSON.stringify(ctx)).not.toContain('sk-x');
    });

    it('parses the hint headers', () => {
        expect(
            parseHints({ 'x-nanovia-effort': ' high ', 'x-nanovia-consumer': 'background', 'x-nanovia-thoughts': '1' }),
        ).toEqual({ effort: 'high', consumer: 'background', thoughts: true });
        expect(parseHints({})).toEqual({ effort: null, consumer: 'unknown', thoughts: false });
        expect(parseHints({ 'x-nanovia-consumer': 'weird', 'x-nanovia-thoughts': '0' })).toMatchObject({
            consumer: 'unknown',
            thoughts: false,
        });
    });

    it('registers the plan step and the usage step', () => {
        expect(REQUEST_STEPS).toEqual([planStep]);
        expect(RESPONSE_STEPS).toEqual([usageStep]);
    });
});
