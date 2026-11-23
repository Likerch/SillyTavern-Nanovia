// The plan step: planUpstream wired into the proxy context (the pure behaviour is covered in tests/domain/upstream.test.ts),
// and the catalog lookup that feeds it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeCatalog } from '../../src/domain/catalog';
import { createConnection } from '../../src/domain/connection';
import { createProxyContext, parseHints } from '../../src/server/context';
import { lookupCatalog, planStep, requestedModelId, stripServiceSuffixes } from '../../src/server/pipeline/steps/plan';
import { SecretValue } from '../../src/server/secret-value';
import type { CatalogModel } from '../../src/shared/contracts';

const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tools/fixtures/catalog.json'), 'utf8')) as {
    data: unknown[];
};
const CATALOG = new Map(normalizeCatalog(raw.data).map((m) => [m.id, m]));
const model = (id: string): CatalogModel => {
    const found = CATALOG.get(id);
    if (!found) throw new Error(`fixture model ${id} is missing`);
    return found;
};

/** A connection patch as the admin API takes it: partial nested objects are merged over the defaults. */
type Patch = Record<string, unknown>;

function contextFor(
    body: Record<string, unknown>,
    patch: Patch = { name: 'n', modelId: 'glm-5' },
    options: { model?: CatalogModel | null; providerSelection?: boolean | null; headers?: Record<string, string> } = {},
) {
    return createProxyContext({
        localId: 'l1',
        now: 5,
        user: 'default-user',
        connection: createConnection(patch as Parameters<typeof createConnection>[0], 'abcd1234', 1),
        key: new SecretValue('sk-x'),
        model: options.model ?? null,
        providerSelection: options.providerSelection ?? null,
        hints: parseHints(options.headers ?? {}),
        body,
        signal: new AbortController().signal,
    });
}

describe('plan step', () => {
    it('locked: always the connection model; unlocked: the request model, else the connection model', () => {
        const locked = contextFor({ model: 'other/model' }, { name: 'n', modelId: 'glm-5', modelLock: true });
        planStep(locked);
        expect(locked.plan.model).toBe('glm-5');
        expect(locked.plan.body['model']).toBe('glm-5');

        const follow = contextFor({ model: ' other/model ' });
        planStep(follow);
        expect(follow.plan.model).toBe('other/model');
        expect(follow.plan.body['model']).toBe('other/model');

        for (const body of [{}, { model: '' }, { model: '   ' }, { model: 5 }, { model: null }]) {
            const ctx = contextFor(body);
            planStep(ctx);
            expect(ctx.plan.model).toBe('glm-5');
        }
    });

    it('adds the model suffixes of the connection', () => {
        const ctx = contextFor(
            {},
            { name: 'n', modelId: 'glm-5', webSearch: true, memory: { enabled: true, expirationDays: 7 } },
        );
        planStep(ctx);
        expect(ctx.plan.model).toBe('glm-5:online:memory-7');
        expect(ctx.plan.body['model']).toBe('glm-5:online:memory-7');
    });

    it('strips the neutral samplers by default and only those, and keeps them when the connection says so', () => {
        const body = {
            top_k: 0,
            top_a: 0,
            min_p: 0,
            repetition_penalty: 1,
            logit_bias: {},
            top_p: 0.9,
            temperature: 0,
        };
        const on = contextFor(body);
        planStep(on);
        expect(on.plan.body).toMatchObject({ top_p: 0.9, temperature: 0 });
        for (const name of ['top_k', 'top_a', 'min_p', 'repetition_penalty', 'logit_bias']) {
            expect(on.plan.body).not.toHaveProperty(name);
        }
        const off = contextFor(body, { name: 'n', modelId: 'm', stripNeutralSamplers: false });
        planStep(off);
        expect(off.plan.body).toMatchObject({ top_k: 0, top_a: 0, min_p: 0, repetition_penalty: 1, logit_bias: {} });
    });

    it('never touches the incoming body and always asks for usage', () => {
        const ctx = contextFor({ top_k: 0, stream: true, messages: [{ role: 'user', content: 'hi' }] });
        const before = structuredClone(ctx.body);
        planStep(ctx);
        expect(ctx.body).toEqual(before);
        expect(ctx.plan.body).not.toBe(ctx.body);
        expect(ctx.plan.body['usage']).toEqual({ include: true });
        expect(ctx.plan.body['stream_options']).toEqual({ include_usage: true });
    });

    it('sets the pay-as-you-go header and body field for a paygo connection', () => {
        const ctx = contextFor({}, { name: 'n', modelId: 'glm-5', billing: 'paygo' });
        planStep(ctx);
        expect(ctx.plan.headers).toEqual({ 'X-Billing-Mode': 'paygo' });
        expect(ctx.plan.body['billing_mode']).toBe('paygo');
        expect(ctx.plan.billing).toMatchObject({ outcome: 'paygo' });
        expect(ctx.plan.billing.reasons).toContainEqual({ code: 'billing.forced' });
    });

    it('safe (subscription) mode strips the routing that would leave the subscription', () => {
        const routing = { enabled: true, order: ['deepinfra'], sort: 'price' as const, zdr: true };
        const flash = model('deepseek/deepseek-v4.1-flash');
        const safe = contextFor(
            { model: flash.id },
            { name: 'n', modelId: flash.id, billing: 'subscription', routing: routing },
            { model: flash },
        );
        planStep(safe);
        expect(safe.plan.body['provider']).toEqual({ zdr: true });
        expect(safe.plan.billing).toMatchObject({
            outcome: 'subscription',
            markupPercent: 0,
            stripped: ['order', 'sort'],
        });

        const auto = contextFor(
            { model: flash.id },
            { name: 'n', modelId: flash.id, billing: 'auto', routing: routing },
            { model: flash },
        );
        planStep(auto);
        expect(auto.plan.body['provider']).toMatchObject({ order: ['deepinfra'], sort: 'price', zdr: true });
        expect(auto.plan.billing).toMatchObject({ outcome: 'paygo', markupPercent: 5 });
    });

    it('sends only zdr to a model that has no provider selection', () => {
        const ctx = contextFor(
            { model: 'mock/no-selection' },
            { name: 'n', modelId: 'mock/no-selection', routing: { enabled: true, order: ['x'], zdr: true } },
            { model: model('mock/no-selection'), providerSelection: false },
        );
        planStep(ctx);
        expect(ctx.plan.body['provider']).toEqual({ zdr: true });
        expect(ctx.plan.billing.reasons.map((r) => r.code)).toContain('routing.unsupportedByModel');
    });

    it('turns the effort hint of the request into the connection policy (follow)', () => {
        const reasoner = model('deepseek/deepseek-v4.1-flash');
        const ctx = contextFor(
            { model: reasoner.id },
            { name: 'n', modelId: reasoner.id, reasoning: { policy: 'follow', effort: null, hideThoughts: false } },
            { model: reasoner, headers: { 'x-nanovia-effort': 'high' } },
        );
        planStep(ctx);
        expect(ctx.plan.body['reasoning']).toMatchObject({ effort: 'high' });
        expect(ctx.plan.body).not.toHaveProperty('reasoning_effort');
    });

    it('with the catalog unknown the outcome stays unknown, until the settings decide it', () => {
        const plain = contextFor({ model: 'unknown/model' }, { name: 'n', modelId: 'unknown/model' });
        planStep(plain);
        expect(plain.plan.billing).toMatchObject({ outcome: 'unknown', markupPercent: 0 });
        expect(plain.plan.warnings).toEqual([]);

        const routed = contextFor(
            { model: 'unknown/model' },
            { name: 'n', modelId: 'unknown/model', routing: { enabled: true, preferredMaxLatency: 3 } },
        );
        planStep(routed);
        expect(routed.plan.billing).toMatchObject({ outcome: 'paygo', markupPercent: 5 });
        expect(routed.plan.warnings.map((w) => w.code)).toContain('routing.preferenceNeedsSort');
    });
});

describe('catalog lookup for the plan', () => {
    it('picks the model the plan will use: the locked connection model beats the request', () => {
        const connection = createConnection({ name: 'n', modelId: 'a/locked', modelLock: true }, 'abcd1234', 1);
        expect(requestedModelId(connection, { model: 'b/other' })).toBe('a/locked');
        const free = createConnection({ name: 'n', modelId: 'a/default' }, 'abcd1234', 1);
        expect(requestedModelId(free, { model: ' b/other ' })).toBe('b/other');
        expect(requestedModelId(free, { model: '' })).toBe('a/default');
        expect(requestedModelId(free, {})).toBe('a/default');
    });

    it('strips the service suffixes but keeps catalog suffixes like :thinking', () => {
        expect(stripServiceSuffixes('z-ai/glm-5.3:online')).toBe('z-ai/glm-5.3');
        expect(stripServiceSuffixes('z-ai/glm-5.3:online/high:memory-7')).toBe('z-ai/glm-5.3');
        expect(stripServiceSuffixes('z-ai/glm-5.3:thinking:online')).toBe('z-ai/glm-5.3:thinking');
        expect(stripServiceSuffixes('z-ai/glm-5.3')).toBe('z-ai/glm-5.3');
    });

    it('finds the exact id first, then the id without service suffixes', () => {
        const seen: string[] = [];
        const lookupModel = (id: string) => {
            seen.push(id);
            return CATALOG.get(id) ?? null;
        };
        expect(lookupCatalog({ lookupModel }, 'z-ai/glm-5.3:thinking').model?.id).toBe('z-ai/glm-5.3:thinking');
        expect(seen).toEqual(['z-ai/glm-5.3:thinking']);
        seen.length = 0;
        expect(lookupCatalog({ lookupModel }, 'z-ai/glm-5.3:online:memory').model?.id).toBe('z-ai/glm-5.3');
        expect(seen).toEqual(['z-ai/glm-5.3:online:memory', 'z-ai/glm-5.3']);
        expect(lookupCatalog({ lookupModel }, 'no/such').model).toBeNull();
    });

    it('asks for provider selection with the catalog id and treats anything but a boolean as unknown', () => {
        const asked: string[] = [];
        const providerSelection = (id: string): boolean | null => {
            asked.push(id);
            return id === 'mock/no-selection' ? false : true;
        };
        const lookupModel = (id: string) => CATALOG.get(id) ?? null;
        expect(lookupCatalog({ lookupModel, providerSelection }, 'mock/no-selection:online')).toMatchObject({
            providerSelection: false,
        });
        expect(asked).toEqual(['mock/no-selection']);
        expect(lookupCatalog({ lookupModel }, 'z-ai/glm-5.3').providerSelection).toBeNull();
        expect(
            lookupCatalog({ lookupModel, providerSelection: () => null }, 'z-ai/glm-5.3').providerSelection,
        ).toBeNull();
    });

    it('never throws: a broken catalog means unknown', () => {
        const boom = (): never => {
            throw new Error('catalog exploded');
        };
        expect(lookupCatalog({ lookupModel: boom, providerSelection: boom }, 'z-ai/glm-5.3')).toEqual({
            model: null,
            providerSelection: null,
        });
    });
});
