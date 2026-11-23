import { describe, expect, it } from 'vitest';
import { BILLING_STRINGS } from '../../src/core/billing-view';
import { createI18n } from '../../src/core/i18n';
import { ROUTING_STRINGS } from '../../src/features/routing/strings';
import {
    BYPASS_FIELDS,
    EFFORT_LADDER,
    addProviderIds,
    capabilityLine,
    configWith,
    connectionLabel,
    controlStates,
    describeReasoning,
    draftOf,
    effortChoices,
    hasBypassingSettings,
    isDirty,
    makeSubscriptionSafe,
    normalizeProviderIds,
    numberText,
    outcomeBadge,
    parseNumberInput,
    patchOf,
    preferenceNeedsSort,
    providerSuggestions,
    reasoningCaps,
    reasoningPreview,
    routingIgnored,
    verdictFor,
    verdictSummaryKey,
} from '../../src/features/routing/view-model';
import type { RoutingDraft } from '../../src/features/routing/view-model';
import { PROVIDER_MARKUP_PERCENT } from '../../src/shared/constants';
import { makeConnection, makeModel, makeProviders } from '../helpers/plan-fixtures';

const i18n = createI18n(() => 'en');
i18n.register(BILLING_STRINGS);
i18n.register(ROUTING_STRINGS);
const t = i18n.t.bind(i18n);

function draftWith(
    over: Partial<RoutingDraft['routing']> = {},
    billing: RoutingDraft['billing'] = 'auto',
): RoutingDraft {
    const draft = draftOf(makeConnection());
    draft.billing = billing;
    draft.routing = { ...draft.routing, enabled: true, ...over };
    return draft;
}

const codes = (list: { code: string }[]): string[] => list.map((item) => item.code);

describe('the draft', () => {
    it('is a deep copy: editing it never touches the connection', () => {
        const config = makeConnection({
            routing: { enabled: true, order: ['a'], maxPrice: { prompt: 1, completion: null } },
        });
        const draft = draftOf(config);
        draft.routing.order.push('b');
        draft.routing.maxPrice.prompt = 9;
        draft.routing.quantizations.push('fp8');
        draft.reasoning.hideThoughts = true;
        expect(config.routing.order).toEqual(['a']);
        expect(config.routing.maxPrice.prompt).toBe(1);
        expect(config.routing.quantizations).toEqual([]);
        expect(config.reasoning.hideThoughts).toBe(false);
    });

    it('configWith applies the draft over the connection without sharing objects', () => {
        const config = makeConnection({ name: 'Keep' });
        const draft = draftWith({ order: ['x'] }, 'paygo');
        const next = configWith(config, draft);
        expect(next).toMatchObject({ name: 'Keep', billing: 'paygo', routing: { order: ['x'] } });
        next.routing.order.push('y');
        expect(draft.routing.order).toEqual(['x']);
    });

    it('patchOf saves the effort only for the fixed policy (medium when none was picked)', () => {
        const draft = draftOf(makeConnection());
        draft.reasoning = { policy: 'follow', effort: 'high', hideThoughts: true };
        expect(patchOf(draft).reasoning).toEqual({ policy: 'follow', effort: null, hideThoughts: true });
        draft.reasoning = { policy: 'fixed', effort: null, hideThoughts: false };
        expect(patchOf(draft).reasoning.effort).toBe('medium');
        draft.reasoning.effort = 'low';
        expect(patchOf(draft).reasoning.effort).toBe('low');
    });

    it('isDirty tells a real change from none, also for the effort of a non-fixed policy', () => {
        const config = makeConnection();
        const draft = draftOf(config);
        expect(isDirty(config, draft)).toBe(false);
        draft.reasoning.effort = 'high'; // policy follow: not saved, so not a change
        expect(isDirty(config, draft)).toBe(false);
        draft.routing.sort = 'price';
        expect(isDirty(config, draft)).toBe(true);
        draft.routing.sort = 'default';
        draft.billing = 'paygo';
        expect(isDirty(config, draft)).toBe(true);
    });
});

describe('number fields', () => {
    it('empty is no limit, numbers parse, junk is refused', () => {
        expect(parseNumberInput('')).toEqual({ ok: true, value: null });
        expect(parseNumberInput('  ')).toEqual({ ok: true, value: null });
        expect(parseNumberInput('0.5')).toEqual({ ok: true, value: 0.5 });
        expect(parseNumberInput('0,25')).toEqual({ ok: true, value: 0.25 });
        expect(parseNumberInput('3')).toEqual({ ok: true, value: 3 });
        expect(parseNumberInput('1e2')).toEqual({ ok: true, value: 100 });
        expect(parseNumberInput('-1')).toEqual({ ok: false });
        expect(parseNumberInput('abc')).toEqual({ ok: false });
        expect(parseNumberInput('1.2.3')).toEqual({ ok: false });
        expect(parseNumberInput('Infinity')).toEqual({ ok: false });
    });

    it('numberText is the inverse for display', () => {
        expect(numberText(null)).toBe('');
        expect(numberText(0.5)).toBe('0.5');
        expect(numberText(0)).toBe('0');
    });
});

describe('provider ids', () => {
    it('are trimmed, lower-cased and unique', () => {
        expect(normalizeProviderIds([' Alpha ', 'alpha', '', 'Beta'])).toEqual(['alpha', 'beta']);
    });

    it('typed text may hold several ids separated by commas, spaces or lines', () => {
        expect(addProviderIds(['a'], 'B, c;d\ne a')).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(addProviderIds(['a'], '  ,  ')).toEqual(['a']);
    });

    it('suggestions are the known hosts that are not chosen yet', () => {
        const providers = makeProviders({ ids: ['alpha', 'Beta', 'gamma'] });
        expect(providerSuggestions(providers, ['BETA'])).toEqual(['alpha', 'gamma']);
        expect(providerSuggestions(null, [])).toEqual([]);
    });
});

describe('which controls are locked', () => {
    it('automatic and pay-as-you-go leave every control open', () => {
        for (const billing of ['auto', 'paygo'] as const) {
            const states = controlStates(draftWith({}, billing));
            for (const name of BYPASS_FIELDS)
                expect(states[name]).toEqual({ bypass: true, disabled: false, reason: null });
        }
    });

    it('subscription-only locks every bypassing control with the reason, but never zdr or the switch', () => {
        const states = controlStates(draftWith({}, 'subscription'));
        for (const name of BYPASS_FIELDS) {
            expect(states[name]).toEqual({ bypass: true, disabled: true, reason: 'routing.disabled.subscriptionSafe' });
        }
        expect(states.zdr).toEqual({ bypass: false, disabled: false, reason: null });
        expect(states.enabled.disabled).toBe(false);
    });

    it('the bypassing fields are exactly the ones the domain counts as explicit routing', () => {
        const all = draftWith({
            order: ['a'],
            only: ['a'],
            ignore: ['a'],
            sort: 'price',
            quantizations: ['fp8'],
            minQuantization: 'fp8',
            maxPrice: { prompt: 1, completion: 1 },
            allowFallbacks: false,
            requireParameters: true,
            preferredMaxLatency: 1,
            preferredMinThroughput: 1,
            cachingRoute: true,
        });
        const verdict = verdictFor(makeConnection(), all, makeModel(), null);
        const fields = verdict.reasons.find((reason) => reason.code === 'routing.explicit')?.params?.['fields'];
        expect(String(fields).split(', ').sort()).toEqual([...BYPASS_FIELDS].sort());
    });
});

describe('the verdict', () => {
    const config = makeConnection();

    it('default settings stay in the subscription', () => {
        const verdict = verdictFor(config, draftWith(), makeModel(), null);
        expect(verdict).toMatchObject({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            reasons: [],
            warnings: [],
            stripped: [],
            modelKnown: true,
        });
        expect(verdictSummaryKey(verdict)).toBe('routing.verdict.subscription');
    });

    it('explicit routing is pay as you go with the markup, naming the fields', () => {
        const verdict = verdictFor(config, draftWith({ order: ['alpha'], sort: 'price' }), makeModel(), null);
        expect(verdict.outcome).toBe('paygo');
        expect(verdict.markupPercent).toBe(PROVIDER_MARKUP_PERCENT);
        expect(verdict.subscriptionSafe).toBe(false);
        expect(verdict.reasons).toEqual([{ code: 'routing.explicit', params: { fields: 'order, sort' } }]);
        expect(outcomeBadge(verdict, t)).toEqual({ label: 'Pay as you go · +5%', kind: 'warn' });
    });

    it('routing that is switched off changes nothing, however much is set', () => {
        const verdict = verdictFor(config, draftWith({ enabled: false, order: ['alpha'] }), makeModel(), null);
        expect(verdict.outcome).toBe('subscription');
        expect(verdict.markupPercent).toBe(0);
    });

    it('zero data retention keeps the subscription', () => {
        const verdict = verdictFor(config, draftWith({ zdr: true }), makeModel(), null);
        expect(verdict.outcome).toBe('subscription');
        expect(codes(verdict.reasons)).toEqual(['routing.zdrOnly']);
    });

    it('subscription-only strips the bypassing settings, keeps the subscription and lists what it removed', () => {
        const verdict = verdictFor(
            config,
            draftWith({ order: ['alpha'], maxPrice: { prompt: 1, completion: null }, zdr: true }, 'subscription'),
            makeModel(),
            null,
        );
        expect(verdict).toMatchObject({
            outcome: 'subscription',
            markupPercent: 0,
            subscriptionSafe: true,
            stripped: ['order', 'maxPrice'],
        });
    });

    it('subscription-only cannot save a model outside the subscription', () => {
        const verdict = verdictFor(
            config,
            draftWith({}, 'subscription'),
            makeModel({ id: 'x/pricey', included: false }),
            null,
        );
        expect(verdict.outcome).toBe('paygo');
        expect(codes(verdict.reasons)).toEqual(['model.notIncluded', 'billing.modelNotCoverable']);
    });

    it('forced pay-as-you-go and the multiplier of a subscription model', () => {
        expect(codes(verdictFor(config, draftWith({}, 'paygo'), makeModel(), null).reasons)).toEqual([
            'billing.forced',
        ]);
        const verdict = verdictFor(config, draftWith(), makeModel({ multiplier: 3 }), null);
        expect(verdict.reasons).toEqual([{ code: 'subscription.multiplier', params: { value: 3 } }]);
    });

    it('a model the catalog does not know gives an unknown outcome and says so', () => {
        const verdict = verdictFor(config, draftWith(), null, null);
        expect(verdict).toMatchObject({ outcome: 'unknown', modelKnown: false });
        expect(verdictSummaryKey(verdict)).toBe('routing.verdict.modelUnknown');
        expect(outcomeBadge(verdict, t)).toEqual({ label: 'Not known', kind: 'muted' });
        // Forcing pay-as-you-go does not need the catalog.
        expect(verdictFor(config, draftWith({}, 'paygo'), null, null).outcome).toBe('paygo');
    });

    it('a model on a fixed route ignores routing: no markup, and the reason says so', () => {
        const verdict = verdictFor(config, draftWith({ order: ['alpha'] }), makeModel(), false);
        expect(verdict.outcome).toBe('subscription');
        expect(verdict.markupPercent).toBe(0);
        expect(codes(verdict.reasons)).toEqual(['routing.unsupportedByModel']);
        expect(routingIgnored(verdict)).toBe(true);
    });

    it('collects the plan warnings: routing and reasoning, each once', () => {
        const draft = draftWith({ only: ['a'], order: ['b'], preferredMaxLatency: 2 });
        draft.reasoning = { policy: 'fixed', effort: 'xhigh', hideThoughts: false };
        const verdict = verdictFor(config, draft, makeModel({ reasoningEfforts: ['low', 'high'] }), null);
        expect(codes(verdict.warnings).sort()).toEqual([
            'reasoning.effortAdjusted',
            'routing.onlyAndOrder',
            'routing.preferenceNeedsSort',
        ]);
        expect(verdict.warnings.filter((w) => w.code === 'reasoning.effortAdjusted')).toHaveLength(1);
    });

    it('does not warn about settings that subscription-only strips anyway', () => {
        const verdict = verdictFor(config, draftWith({ preferredMaxLatency: 2 }, 'subscription'), makeModel(), null);
        expect(codes(verdict.warnings)).toEqual([]);
    });

    it('warns that a model which always reasons cannot be switched off', () => {
        const draft = draftWith();
        draft.reasoning = { policy: 'off', effort: null, hideThoughts: false };
        const verdict = verdictFor(
            config,
            draft,
            makeModel({ id: 'glm/5.3', reasoningEfforts: ['low', 'high'] }),
            null,
        );
        expect(verdict.warnings).toContainEqual({
            code: 'reasoning.cannotDisable',
            params: { model: 'glm/5.3', efforts: 'low, high' },
        });
    });

    it('does not mutate the connection or the draft', () => {
        const draft = draftWith({ order: ['alpha'] }, 'subscription');
        const before = JSON.stringify([config, draft]);
        verdictFor(config, draft, makeModel(), null);
        expect(JSON.stringify([config, draft])).toBe(before);
    });
});

describe('subscription-safe helpers', () => {
    it('makeSubscriptionSafe resets what bypasses and keeps zdr, the switch and the rest of the draft', () => {
        const config = makeConnection();
        const draft = draftWith({ order: ['alpha'], sort: 'price', zdr: true, cachingRoute: true });
        draft.reasoning.hideThoughts = true;
        const safe = makeSubscriptionSafe(config, draft, makeModel());
        expect(safe.routing).toMatchObject({
            enabled: true,
            zdr: true,
            order: [],
            sort: 'default',
            cachingRoute: false,
        });
        expect(safe.reasoning.hideThoughts).toBe(true);
        expect(draft.routing.order).toEqual(['alpha']);
        expect(hasBypassingSettings(safe)).toBe(false);
    });

    it('hasBypassingSettings needs routing to be on and a bypassing field to be set', () => {
        expect(hasBypassingSettings(draftWith({ order: ['a'] }))).toBe(true);
        expect(hasBypassingSettings(draftWith({ enabled: false, order: ['a'] }))).toBe(false);
        expect(hasBypassingSettings(draftWith({ zdr: true }))).toBe(false);
    });

    it('preferenceNeedsSort follows the domain warning', () => {
        expect(preferenceNeedsSort(draftWith({ preferredMinThroughput: 20 }).routing)).toBe(true);
        expect(preferenceNeedsSort(draftWith({ preferredMinThroughput: 20, sort: 'throughput' }).routing)).toBe(false);
        expect(preferenceNeedsSort(draftWith().routing)).toBe(false);
    });
});

describe('what the catalog says about reasoning', () => {
    it('a model that can be switched off', () => {
        const caps = reasoningCaps(makeModel({ reasoningEfforts: ['none', 'low', 'high'] }));
        expect(caps).toEqual({
            known: true,
            reasons: true,
            efforts: ['none', 'low', 'high'],
            alwaysOn: false,
            canDisable: true,
        });
        expect(capabilityLine(caps, t)).toBe('The model can be switched off. Efforts: none, low, high.');
    });

    it('a model that always reasons', () => {
        const caps = reasoningCaps(makeModel({ reasoningEfforts: ['high', 'low'] }));
        expect(caps).toMatchObject({ alwaysOn: true, canDisable: false, efforts: ['low', 'high'] });
        expect(capabilityLine(caps, t)).toBe(
            'The model always reasons; it cannot be switched off. Efforts: low, high.',
        );
    });

    it('a reasoning model without an effort dial, a model that does not reason, and an unknown model', () => {
        const dial = reasoningCaps(makeModel({ reasoningEfforts: [] }));
        expect(dial).toMatchObject({ efforts: [], alwaysOn: false, canDisable: true });
        expect(capabilityLine(dial, t)).toContain('only on or off');
        const none = reasoningCaps(makeModel({ capabilities: { ...makeModel().capabilities, reasoning: false } }));
        expect(none.reasons).toBe(false);
        expect(capabilityLine(none, t)).toContain('does not reason');
        const unknown = reasoningCaps(null);
        expect(unknown.known).toBe(false);
        expect(capabilityLine(unknown, t)).toContain('does not know');
    });

    it('ignores efforts that are not on the ladder and reads them without case', () => {
        expect(reasoningCaps(makeModel({ reasoningEfforts: ['High', 'turbo', 'LOW'] })).efforts).toEqual([
            'low',
            'high',
        ]);
    });

    it('the effort choices are the model’s list (plus the chosen one), or the whole ladder', () => {
        const caps = reasoningCaps(makeModel({ reasoningEfforts: ['low', 'high'] }));
        expect(effortChoices(caps, 'high')).toEqual(['low', 'high']);
        expect(effortChoices(caps, 'medium')).toEqual(['low', 'medium', 'high']);
        expect(effortChoices(reasoningCaps(null), null)).toEqual([...EFFORT_LADDER]);
        expect(effortChoices(reasoningCaps(makeModel({ reasoningEfforts: [] })), 'low')).toEqual([...EFFORT_LADDER]);
    });
});

describe('the reasoning preview', () => {
    const model = makeModel({ reasoningEfforts: ['none', 'low', 'high'] });

    function rows(policy: 'follow' | 'fixed' | 'off' | 'default', over = {}) {
        return reasoningPreview(model, { policy, effort: null, hideThoughts: false, ...over });
    }
    const byId = (list: ReturnType<typeof rows>) => Object.fromEntries(list.map((row) => [row.id, row.params]));

    it('follow: the request decides; a background task without an effort reasons as little as possible', () => {
        expect(byId(rows('follow'))).toEqual({
            main: null,
            mainNone: { effort: 'none' },
            mainHigh: { effort: 'high' },
            background: { effort: 'none' },
        });
    });

    it('fixed sends its effort whatever the request says', () => {
        const preview = byId(rows('fixed', { effort: 'low' }));
        expect(Object.values(preview).every((params) => params?.effort === 'low')).toBe(true);
    });

    it('off and default', () => {
        expect(Object.values(byId(rows('off'))).every((params) => params?.effort === 'none')).toBe(true);
        expect(Object.values(byId(rows('default'))).every((params) => params === null)).toBe(true);
    });

    it('hiding the thoughts marks every sent reasoning', () => {
        const preview = byId(rows('follow', { hideThoughts: true }));
        expect(preview['mainHigh']).toEqual({ effort: 'high', exclude: true });
        expect(preview['main']).toBeNull();
    });

    it('carries the warnings of each case', () => {
        const stuck = reasoningPreview(makeModel({ reasoningEfforts: ['low', 'high'] }), {
            policy: 'follow',
            effort: null,
            hideThoughts: false,
        });
        expect(stuck.find((row) => row.id === 'mainNone')?.warnings.map((w) => w.code)).toEqual([
            'reasoning.effortAdjusted',
        ]);
        expect(stuck.find((row) => row.id === 'main')?.warnings).toEqual([]);
    });

    it('works without a catalog entry', () => {
        const unknown = reasoningPreview(null, { policy: 'fixed', effort: 'high', hideThoughts: false });
        expect(unknown[0]).toMatchObject({
            params: { effort: 'high' },
            warnings: [{ code: 'reasoning.modelUnknown' }],
        });
    });

    it('describes what would be sent in words', () => {
        expect(describeReasoning(null, t)).toBe('nothing, the model decides');
        expect(describeReasoning({ effort: 'high', exclude: true }, t)).toBe('effort high · text hidden');
        expect(describeReasoning({ enabled: false }, t)).toBe('reasoning off');
        expect(describeReasoning({ enabled: true }, t)).toBe('reasoning on');
    });
});

describe('labels', () => {
    it('connectionLabel', () => {
        expect(connectionLabel({ name: 'Main', modelId: 'a/b' })).toBe('Main · a/b');
    });
});
