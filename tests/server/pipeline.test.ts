import { describe, expect, it } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import { createProxyContext, parseHints } from '../../src/server/context';
import { REQUEST_STEPS, RESPONSE_STEPS } from '../../src/server/pipeline';
import { chooseModel, modelStep } from '../../src/server/pipeline/steps/model';
import { stripNeutralSamplers, stripSamplersStep } from '../../src/server/pipeline/steps/strip-samplers';
import { SecretValue } from '../../src/server/secret-value';

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

describe('stripNeutralSamplers', () => {
    it('removes exactly the neutral values', () => {
        const body: Record<string, unknown> = {
            top_k: 0,
            top_a: 0,
            min_p: 0,
            repetition_penalty: 1,
            logit_bias: {},
            temperature: 0,
            top_p: 1,
        };
        expect(stripNeutralSamplers(body)).toEqual(['top_k', 'top_a', 'min_p', 'repetition_penalty', 'logit_bias']);
        expect(body).toEqual({ temperature: 0, top_p: 1 });
    });

    it('keeps real values', () => {
        const body: Record<string, unknown> = {
            top_k: 40,
            top_a: 0.2,
            min_p: 0.05,
            repetition_penalty: 1.1,
            logit_bias: { '50256': -100 },
        };
        const copy = structuredClone(body);
        expect(stripNeutralSamplers(body)).toEqual([]);
        expect(body).toEqual(copy);
    });

    it('is switched by the connection and touches only the plan', () => {
        const on = contextFor({ top_k: 0, messages: [] });
        stripSamplersStep(on);
        expect(on.plan.body).toEqual({ messages: [] });
        expect(on.body).toEqual({ top_k: 0, messages: [] });

        const off = contextFor({ top_k: 0 }, { name: 'n', modelId: 'm', stripNeutralSamplers: false });
        stripSamplersStep(off);
        expect(off.plan.body).toEqual({ top_k: 0 });
    });
});

describe('model step', () => {
    it('locked: always the connection model', () => {
        const ctx = contextFor({ model: 'other/model' }, { name: 'n', modelId: 'glm-5', modelLock: true });
        modelStep(ctx);
        expect(ctx.plan.model).toBe('glm-5');
        expect(ctx.plan.body['model']).toBe('glm-5');
    });

    it('unlocked: the model of the request, else the connection model', () => {
        const follow = contextFor({ model: ' other/model ' });
        modelStep(follow);
        expect(follow.plan.model).toBe('other/model');
        expect(follow.plan.body['model']).toBe('other/model');
        for (const body of [{}, { model: '' }, { model: '   ' }, { model: 5 }, { model: null }]) {
            expect(chooseModel(contextFor(body))).toBe('glm-5');
        }
    });
});

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

    it('registers the stage 0.1 steps in order', () => {
        expect(REQUEST_STEPS).toEqual([modelStep, stripSamplersStep]);
        expect(RESPONSE_STEPS).toEqual([]);
    });
});
