import { describe, expect, it } from 'vitest';
import { nearestEffort, normalizeEffortHint, planReasoning } from '../../src/domain/reasoning';
import type { CatalogModel, ReasoningConfig, ReasoningEffort, RequestHints } from '../../src/shared/contracts';

function makeModel(over: { id?: string; reasoning?: boolean; efforts?: string[] } = {}): CatalogModel {
    return {
        id: over.id ?? 'vendor/model',
        name: 'Model',
        description: '',
        contextLength: 128000,
        maxOutputTokens: null,
        capabilities: { vision: false, reasoning: over.reasoning ?? true, toolCalling: true, structuredOutput: true },
        reasoningEfforts: over.efforts ?? ['low', 'medium', 'high'],
        openWeights: false,
        pricing: { prompt: 1, completion: 2, cacheRead: null },
        category: null,
        subscription: { included: true, inputTokenMultiplier: 1 },
        providerIds: [],
        created: null,
    };
}

const hints = (effort: string | null): RequestHints => ({ effort, consumer: 'main', thoughts: false });
const config = (
    policy: ReasoningConfig['policy'],
    effort: ReasoningEffort | null = null,
    hideThoughts = false,
): ReasoningConfig => ({ policy, effort, hideThoughts });

describe('normalizeEffortHint', () => {
    it.each([
        ['min', 'none'],
        ['off', 'none'],
        ['none', 'none'],
        ['  OFF ', 'none'],
        ['minimal', 'minimal'],
        ['low', 'low'],
        ['MEDIUM', 'medium'],
        ['high', 'high'],
        ['xhigh', 'xhigh'],
        ['x-high', 'xhigh'],
        ['extra-high', 'xhigh'],
        ['max', 'max'],
        ['auto', 'auto'],
        ['Auto', 'auto'],
        ['', null],
        ['   ', null],
        ['turbo', null],
        ['constructor', null],
        [null, null],
        [undefined, null],
    ])('maps %j to %j', (hint, expected) => {
        expect(normalizeEffortHint(hint)).toBe(expected);
    });
});

describe('nearestEffort', () => {
    it.each<[ReasoningEffort, string[], string | null]>([
        ['high', ['low', 'medium', 'high'], 'high'],
        ['none', ['none', 'low'], 'none'],
        ['medium', ['low', 'high'], 'low'], // tie goes lower
        ['xhigh', ['low', 'high', 'max'], 'high'], // tie goes lower
        ['minimal', ['none', 'low'], 'none'], // tie goes lower
        ['none', ['low', 'high', 'max'], 'low'], // the supported list may lack none
        ['none', ['minimal', 'high'], 'minimal'],
        ['max', ['low', 'medium'], 'medium'],
        ['low', ['max', 'none'], 'none'],
        ['medium', ['max', 'high', 'low'], 'low'], // input order does not matter
        ['medium', ['high', 'low'], 'low'],
        ['high', ['dynamic', 'low'], 'low'], // levels off the ladder are ignored
        ['high', ['HIGH'], 'high'],
        ['low', [' low '], 'low'],
        ['high', [], null],
        ['high', ['dynamic', 'auto'], null],
    ])('nearest to %s among %j is %j', (wanted, supported, expected) => {
        expect(nearestEffort(wanted, supported)).toBe(expected);
    });

    it('gives null for a wanted level that is not on the ladder', () => {
        expect(nearestEffort('turbo' as ReasoningEffort, ['low'])).toBeNull();
    });
});

describe('planReasoning: nothing to send', () => {
    it('sends nothing under the default policy, whatever the hint', () => {
        for (const model of [null, makeModel(), makeModel({ reasoning: false })]) {
            expect(planReasoning(model, config('default', 'high', true), hints('max'))).toEqual({
                reasoning: null,
                warnings: [],
            });
        }
    });

    it('sends nothing, without a warning, to a model that does not reason', () => {
        const model = makeModel({ reasoning: false, efforts: ['low', 'high'] });
        for (const c of [config('off'), config('fixed', 'high'), config('follow'), config('follow', null, true)]) {
            expect(planReasoning(model, c, hints('high'))).toEqual({ reasoning: null, warnings: [] });
        }
    });
});

describe("planReasoning: policy 'off'", () => {
    it.each<[string, string[], Record<string, unknown>, boolean]>([
        ['model lists none', ['none', 'low', 'high'], { effort: 'none' }, false],
        ['only none', ['none'], { effort: 'none' }, false],
        ['always reasons (low, high, max)', ['low', 'high', 'max'], { effort: 'low', exclude: true }, true],
        ['always reasons, unordered list', ['max', 'high', 'low'], { effort: 'low', exclude: true }, true],
        ['always reasons, only high', ['high'], { effort: 'high', exclude: true }, true],
        ['minimal is the floor', ['minimal', 'medium'], { effort: 'minimal', exclude: true }, true],
        ['no efforts at all', [], { enabled: false }, false],
        ['only levels off the ladder', ['dynamic'], { enabled: false }, false],
    ])('%s', (_name, efforts, expected, warns) => {
        const model = makeModel({ id: 'glm/glm-5.3', efforts });
        const plan = planReasoning(model, config('off'), hints('high'));
        expect(plan.reasoning).toEqual(expected);
        if (warns) {
            expect(plan.warnings).toEqual([
                { code: 'reasoning.cannotDisable', params: { model: 'glm/glm-5.3', efforts: efforts.join(', ') } },
            ]);
        } else {
            expect(plan.warnings).toEqual([]);
        }
    });

    it('ignores the hint and the fixed effort', () => {
        const model = makeModel({ efforts: ['none', 'high'] });
        expect(planReasoning(model, config('off', 'max'), hints('max')).reasoning).toEqual({ effort: 'none' });
    });

    it('adds exclude with hideThoughts', () => {
        const withNone = makeModel({ efforts: ['none', 'low'] });
        expect(planReasoning(withNone, config('off', null, true), hints(null)).reasoning).toEqual({
            effort: 'none',
            exclude: true,
        });
        const noEfforts = makeModel({ efforts: [] });
        expect(planReasoning(noEfforts, config('off', null, true), hints(null)).reasoning).toEqual({
            enabled: false,
            exclude: true,
        });
    });
});

describe("planReasoning: policy 'fixed'", () => {
    it('behaves like default without an effort', () => {
        expect(planReasoning(makeModel(), config('fixed', null), hints('high'))).toEqual({
            reasoning: null,
            warnings: [],
        });
        expect(planReasoning(null, config('fixed', null, true), hints('high'))).toEqual({
            reasoning: null,
            warnings: [],
        });
    });

    it.each<[ReasoningEffort, string[], string, boolean]>([
        ['high', ['low', 'medium', 'high'], 'high', false],
        ['none', ['none', 'low'], 'none', false],
        ['xhigh', ['low', 'high', 'max'], 'high', true],
        ['none', ['low', 'high', 'max'], 'low', true],
        ['max', ['low', 'medium', 'high'], 'high', true],
        ['medium', ['low', 'high'], 'low', true],
        ['minimal', ['none', 'low', 'high'], 'none', true],
    ])('effort %s on %j is sent as %s', (effort, efforts, applied, adjusted) => {
        const plan = planReasoning(makeModel({ efforts }), config('fixed', effort), hints('low'));
        expect(plan.reasoning).toEqual({ effort: applied });
        expect(plan.warnings).toEqual(
            adjusted ? [{ code: 'reasoning.effortAdjusted', params: { requested: effort, applied } }] : [],
        );
    });

    it('turns the effort into enabled when the model has no dial', () => {
        const model = makeModel({ efforts: [] });
        expect(planReasoning(model, config('fixed', 'high'), hints(null))).toEqual({
            reasoning: { enabled: true },
            warnings: [],
        });
        expect(planReasoning(model, config('fixed', 'none'), hints(null))).toEqual({
            reasoning: { enabled: false },
            warnings: [],
        });
    });

    it('adds exclude with hideThoughts', () => {
        expect(planReasoning(makeModel(), config('fixed', 'low', true), hints(null)).reasoning).toEqual({
            effort: 'low',
            exclude: true,
        });
    });
});

describe("planReasoning: policy 'follow'", () => {
    it.each([null, '', 'auto', 'AUTO', 'turbo'])('sends nothing for the hint %j', (hint) => {
        expect(planReasoning(makeModel(), config('follow'), hints(hint))).toEqual({ reasoning: null, warnings: [] });
    });

    it.each<[string, string[], string, boolean]>([
        ['low', ['low', 'medium', 'high'], 'low', false],
        ['MEDIUM', ['low', 'medium', 'high'], 'medium', false],
        ['min', ['none', 'low'], 'none', false], // ST's "min" means no reasoning
        ['off', ['none', 'low'], 'none', false],
        ['min', ['low', 'high', 'max'], 'low', true],
        ['max', ['low', 'medium', 'high'], 'high', true],
        ['xhigh', ['low', 'high', 'max'], 'high', true],
        ['minimal', ['low', 'high', 'max'], 'low', true],
    ])('hint %j on %j is sent as %s', (hint, efforts, applied, adjusted) => {
        const plan = planReasoning(makeModel({ efforts }), config('follow'), hints(hint));
        expect(plan.reasoning).toEqual({ effort: applied });
        const requested = normalizeEffortHint(hint);
        expect(plan.warnings).toEqual(
            adjusted ? [{ code: 'reasoning.effortAdjusted', params: { requested, applied } }] : [],
        );
    });

    it('ignores the fixed effort', () => {
        expect(planReasoning(makeModel(), config('follow', 'max'), hints('low')).reasoning).toEqual({ effort: 'low' });
    });

    it('adds exclude with hideThoughts, but only when something is sent', () => {
        expect(planReasoning(makeModel(), config('follow', null, true), hints('high')).reasoning).toEqual({
            effort: 'high',
            exclude: true,
        });
        expect(planReasoning(makeModel(), config('follow', null, true), hints(null)).reasoning).toBeNull();
    });

    it('maps the hint for a model without a dial to enabled', () => {
        const model = makeModel({ efforts: [] });
        expect(planReasoning(model, config('follow'), hints('medium')).reasoning).toEqual({ enabled: true });
        expect(planReasoning(model, config('follow'), hints('min')).reasoning).toEqual({ enabled: false });
    });
});

describe('planReasoning: unknown model', () => {
    const unknown = [{ code: 'reasoning.modelUnknown' }];

    it('passes the normalised effort through with a warning', () => {
        expect(planReasoning(null, config('fixed', 'xhigh'), hints(null))).toEqual({
            reasoning: { effort: 'xhigh' },
            warnings: unknown,
        });
        expect(planReasoning(null, config('follow'), hints('min'))).toEqual({
            reasoning: { effort: 'none' },
            warnings: unknown,
        });
        expect(planReasoning(null, config('follow'), hints('High'))).toEqual({
            reasoning: { effort: 'high' },
            warnings: unknown,
        });
    });

    it('sends effort none for off', () => {
        expect(planReasoning(null, config('off'), hints(null))).toEqual({
            reasoning: { effort: 'none' },
            warnings: unknown,
        });
    });

    it('does not warn when nothing is sent', () => {
        expect(planReasoning(null, config('follow'), hints(null))).toEqual({ reasoning: null, warnings: [] });
        expect(planReasoning(null, config('follow'), hints('auto'))).toEqual({ reasoning: null, warnings: [] });
    });

    it('adds exclude with hideThoughts', () => {
        expect(planReasoning(null, config('fixed', 'low', true), hints(null)).reasoning).toEqual({
            effort: 'low',
            exclude: true,
        });
    });
});

describe('planReasoning: results are independent', () => {
    it('returns a new object on every call', () => {
        const model = makeModel();
        const a = planReasoning(model, config('fixed', 'low'), hints(null));
        a.reasoning!.exclude = true;
        a.warnings.push({ code: 'x' });
        const b = planReasoning(model, config('fixed', 'low'), hints(null));
        expect(b).toEqual({ reasoning: { effort: 'low' }, warnings: [] });
    });
});
