import { describe, expect, it } from 'vitest';
import { backgroundAdvice, canDisableReasoning, qvinkInstalled, suggestBackgroundModels } from '../../src/core/advice';
import type { AdviceInput } from '../../src/core/advice';
import { createConnection } from '../../src/domain/connection';
import type { CatalogModel, ConnectionConfig } from '../../src/shared/contracts';

function model(id: string, patch: Partial<CatalogModel> = {}): CatalogModel {
    return {
        id,
        name: id,
        description: '',
        contextLength: 128_000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: ['none', 'low', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: true, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
        ...patch,
    };
}

function connection(patch: Partial<ConnectionConfig> = {}): ConnectionConfig {
    return createConnection({ name: 'Background', modelId: 'vendor/model', ...patch }, 'conn000001', 1_700_000_000_000);
}

function input(patch: Partial<AdviceInput> = {}): AdviceInput {
    return {
        connection: connection({ reasoning: { policy: 'off', effort: null, hideThoughts: false } }),
        model: model('vendor/model'),
        catalog: [],
        catalogLoaded: true,
        pluginDown: false,
        providerSelection: null,
        qvinkInstalled: false,
        ...patch,
    };
}

function codes(patch: Partial<AdviceInput>): string[] {
    return backgroundAdvice(input(patch)).issues.map((issue) => issue.code);
}

describe('a clean background connection', () => {
    it('has no findings and is ok', () => {
        expect(backgroundAdvice(input())).toEqual({ ok: true, issues: [], suggestedModels: [] });
    });
});

describe('reasoning.alwaysOn', () => {
    it('flags a model whose efforts lack "none"', () => {
        const advice = backgroundAdvice(
            input({ model: model('vendor/model', { reasoningEfforts: ['low', 'medium', 'high'] }) }),
        );
        expect(advice.issues).toEqual([
            {
                code: 'reasoning.alwaysOn',
                severity: 'warn',
                params: { model: 'vendor/model', efforts: 'low, medium, high', lowest: 'low' },
            },
        ]);
        expect(advice.ok).toBe(false);
    });

    it('is not raised when "none" is listed, when there are no efforts, or when the model does not reason', () => {
        expect(codes({ model: model('a', { reasoningEfforts: ['none', 'high'] }) })).toEqual([]);
        expect(codes({ model: model('a', { reasoningEfforts: [] }) })).toEqual([]);
        expect(
            codes({
                model: model('a', {
                    reasoningEfforts: [],
                    capabilities: { vision: false, reasoning: false, toolCalling: false, structuredOutput: false },
                }),
            }),
        ).toEqual([]);
    });

    it('reads efforts case-insensitively', () => {
        expect(codes({ model: model('a', { reasoningEfforts: ['None', ' LOW '] }) })).toEqual([]);
        expect(canDisableReasoning(model('a', { reasoningEfforts: ['HIGH'] }))).toBe(false);
    });
});

describe('reasoning.policyOn', () => {
    const policy = (p: ConnectionConfig['reasoning']): ConnectionConfig => connection({ reasoning: p });

    it('flags a fixed effort other than none', () => {
        expect(codes({ connection: policy({ policy: 'fixed', effort: 'high', hideThoughts: false }) })).toEqual([
            'reasoning.policyOn',
        ]);
        expect(codes({ connection: policy({ policy: 'fixed', effort: 'none', hideThoughts: false }) })).toEqual([]);
    });

    it('flags the model default on a model that reasons, and a fixed policy with no effort', () => {
        const advice = backgroundAdvice(
            input({ connection: policy({ policy: 'default', effort: null, hideThoughts: false }) }),
        );
        expect(advice.issues).toEqual([
            { code: 'reasoning.policyOn', severity: 'warn', params: { policy: 'default', effort: '' } },
        ]);
        expect(codes({ connection: policy({ policy: 'fixed', effort: null, hideThoughts: false }) })).toEqual([
            'reasoning.policyOn',
        ]);
    });

    it('leaves a model that does not reason alone, whatever the policy', () => {
        const plain = model('a', {
            reasoningEfforts: [],
            capabilities: { vision: false, reasoning: false, toolCalling: true, structuredOutput: true },
        });
        expect(
            codes({ model: plain, connection: policy({ policy: 'default', effort: null, hideThoughts: false }) }),
        ).toEqual([]);
        expect(
            codes({ model: plain, connection: policy({ policy: 'fixed', effort: 'high', hideThoughts: false }) }),
        ).toEqual([]);
    });

    it('is quiet for follow and off', () => {
        expect(codes({ connection: policy({ policy: 'follow', effort: null, hideThoughts: false }) })).toEqual([]);
        expect(codes({ connection: policy({ policy: 'off', effort: null, hideThoughts: false }) })).toEqual([]);
    });

    it('still flags a fixed effort on a model the catalog does not know (it is sent as it is)', () => {
        expect(
            codes({ model: null, connection: policy({ policy: 'fixed', effort: 'low', hideThoughts: false }) }),
        ).toEqual(['model.unknown', 'reasoning.policyOn']);
        // ...but cannot say anything about a default it does not know.
        expect(
            codes({ model: null, connection: policy({ policy: 'default', effort: null, hideThoughts: false }) }),
        ).toEqual(['model.unknown']);
    });
});

describe('billing.bypassesSubscription', () => {
    const routed = (patch: Partial<ConnectionConfig> = {}): ConnectionConfig =>
        connection({
            billing: 'auto',
            reasoning: { policy: 'off', effort: null, hideThoughts: false },
            routing: { ...connection().routing, enabled: true, only: ['some-host'], sort: 'price' },
            ...patch,
        });

    it('flags explicit routing on a subscription model when billing is auto', () => {
        const advice = backgroundAdvice(input({ connection: routed() }));
        expect(advice.issues).toHaveLength(1);
        expect(advice.issues[0]).toMatchObject({
            code: 'billing.bypassesSubscription',
            severity: 'warn',
            params: { model: 'vendor/model' },
        });
        expect(String(advice.issues[0]?.params?.['fields'])).toContain('only');
    });

    it('is not raised for the "safe" or pay-as-you-go billing modes', () => {
        expect(codes({ connection: routed({ billing: 'subscription' }) })).toEqual([]);
        expect(codes({ connection: routed({ billing: 'paygo' }) })).toEqual([]);
    });

    it('is not raised when the model is outside the subscription anyway, or ignores provider selection', () => {
        expect(
            codes({
                connection: routed(),
                model: model('vendor/model', { subscription: { included: false, inputTokenMultiplier: 1 } }),
            }),
        ).toEqual([]);
        expect(codes({ connection: routed(), providerSelection: false })).toEqual([]);
    });

    it('is not raised without explicit routing (a zdr-only setting does not bypass)', () => {
        expect(
            codes({ connection: routed({ routing: { ...connection().routing, enabled: true, zdr: true } }) }),
        ).toEqual([]);
        expect(
            codes({ connection: routed({ routing: { ...connection().routing, enabled: false, only: ['x'] } }) }),
        ).toEqual([]);
    });

    it('cannot say anything about an unknown model', () => {
        expect(codes({ connection: routed(), model: null })).toEqual(['model.unknown']);
    });
});

describe('memory.overlapsQvink', () => {
    const withMemory = connection({
        memory: { enabled: true, expirationDays: null },
        reasoning: { policy: 'off', effort: null, hideThoughts: false },
    });

    it('is an information note when Context Memory is on and Qvink is installed', () => {
        const advice = backgroundAdvice(input({ connection: withMemory, qvinkInstalled: true }));
        expect(advice.issues).toEqual([{ code: 'memory.overlapsQvink', severity: 'info' }]);
        expect(advice.ok).toBe(true);
    });

    it('is not raised without Qvink, or with memory off', () => {
        expect(codes({ connection: withMemory, qvinkInstalled: false })).toEqual([]);
        expect(codes({ qvinkInstalled: true })).toEqual([]);
    });
});

describe('route.pluginDown', () => {
    it('is raised for a plugin-mode connection while the plugin is down', () => {
        const advice = backgroundAdvice(
            input({
                connection: connection({
                    mode: 'plugin',
                    reasoning: { policy: 'off', effort: null, hideThoughts: false },
                }),
                pluginDown: true,
            }),
        );
        expect(advice.issues).toEqual([{ code: 'route.pluginDown', severity: 'warn' }]);
        expect(advice.ok).toBe(false);
    });

    it('is not raised for auto or direct connections, or while the plugin answers', () => {
        const quiet = { policy: 'off', effort: null, hideThoughts: false } as const;
        expect(codes({ connection: connection({ mode: 'auto', reasoning: quiet }), pluginDown: true })).toEqual([]);
        expect(codes({ connection: connection({ mode: 'direct', reasoning: quiet }), pluginDown: true })).toEqual([]);
        expect(codes({ connection: connection({ mode: 'plugin', reasoning: quiet }), pluginDown: false })).toEqual([]);
    });
});

describe('model.unknown', () => {
    it('is an information note that says whether the catalog was loaded at all', () => {
        const advice = backgroundAdvice(input({ model: null, catalogLoaded: false }));
        expect(advice.issues).toEqual([
            { code: 'model.unknown', severity: 'info', params: { model: 'vendor/model', catalogLoaded: false } },
        ]);
        expect(advice.ok).toBe(true);
    });
});

describe('several findings at once', () => {
    it('are reported in a stable order, and any warning makes it not ok', () => {
        const advice = backgroundAdvice(
            input({
                connection: connection({
                    mode: 'plugin',
                    memory: { enabled: true, expirationDays: null },
                    reasoning: { policy: 'fixed', effort: 'high', hideThoughts: false },
                }),
                model: model('vendor/model', { reasoningEfforts: ['low', 'high'] }),
                pluginDown: true,
                qvinkInstalled: true,
            }),
        );
        expect(advice.issues.map((issue) => issue.code)).toEqual([
            'route.pluginDown',
            'reasoning.alwaysOn',
            'reasoning.policyOn',
            'memory.overlapsQvink',
        ]);
        expect(advice.ok).toBe(false);
    });
});

describe('suggestedModels', () => {
    const catalog = [
        model('pricey', { pricing: { prompt: 3, completion: 9, cacheRead: null } }),
        model('cheap', { pricing: { prompt: 0.1, completion: 0.2, cacheRead: null } }),
        model('cheaper-no-dial', { reasoningEfforts: [], pricing: { prompt: 0.05, completion: 0.1, cacheRead: null } }),
        model('always-reasons', {
            reasoningEfforts: ['low', 'high'],
            pricing: { prompt: 0.01, completion: 0.01, cacheRead: null },
        }),
        model('no-json', {
            capabilities: { vision: false, reasoning: true, toolCalling: true, structuredOutput: false },
            pricing: { prompt: 0.01, completion: 0.01, cacheRead: null },
        }),
        model('tee/private', { category: 'Private/TEE', pricing: { prompt: 0.02, completion: 0.02, cacheRead: null } }),
        model('vendor/m:thinking', {
            reasoningEfforts: [],
            pricing: { prompt: 0.02, completion: 0.02, cacheRead: null },
        }),
        model('uncensored', { category: 'Uncensored', pricing: { prompt: 0.5, completion: 0.5, cacheRead: null } }),
    ];

    it('keeps the models that reason only when asked, answer in JSON and are not private/TEE, cheapest first', () => {
        expect(suggestBackgroundModels(catalog)).toEqual(['cheaper-no-dial', 'cheap', 'uncensored', 'pricey']);
    });

    it('is at most five, and empty for an empty catalog', () => {
        const many = Array.from({ length: 12 }, (_, i) =>
            model(`m${String(i).padStart(2, '0')}`, { pricing: { prompt: i, completion: 0, cacheRead: null } }),
        );
        expect(suggestBackgroundModels(many)).toEqual(['m00', 'm01', 'm02', 'm03', 'm04']);
        expect(suggestBackgroundModels(many, 2)).toEqual(['m00', 'm01']);
        expect(suggestBackgroundModels([])).toEqual([]);
    });

    it('breaks a price tie by the completion price, then the id', () => {
        const tie = [
            model('b', { pricing: { prompt: 1, completion: 1, cacheRead: null } }),
            model('a', { pricing: { prompt: 1, completion: 1, cacheRead: null } }),
            model('c', { pricing: { prompt: 0, completion: 2, cacheRead: null } }),
        ];
        expect(suggestBackgroundModels(tie)).toEqual(['a', 'b', 'c']);
    });

    it('is part of the advice', () => {
        expect(backgroundAdvice(input({ catalog })).suggestedModels).toEqual([
            'cheaper-no-dial',
            'cheap',
            'uncensored',
            'pricey',
        ]);
    });
});

describe('qvinkInstalled()', () => {
    it("looks for Qvink's global interceptor, the way Maestro does", () => {
        const globals = globalThis as unknown as Record<string, unknown>;
        expect(qvinkInstalled()).toBe(false);
        globals['memory_intercept_messages'] = () => {};
        try {
            expect(qvinkInstalled()).toBe(true);
        } finally {
            delete globals['memory_intercept_messages'];
        }
        expect(qvinkInstalled()).toBe(false);
    });
});
