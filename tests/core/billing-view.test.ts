import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    BILLING_REASON_CODES,
    BILLING_STRINGS,
    PLAN_WARNING_CODES,
    billingOutcomeLabel,
    billingReasonText,
    planWarningText,
    routingFieldLabel,
    strippedLabels,
} from '../../src/core/billing-view';
import { createI18n } from '../../src/core/i18n';
import type { Locale } from '../../src/core/types';

function translator(locale: Locale) {
    const i18n = createI18n(() => locale);
    i18n.register(BILLING_STRINGS);
    return i18n.t.bind(i18n);
}

/** The codes the domain source emits (`code: '…'`, also both branches of a conditional). */
function codesIn(file: string): string[] {
    const source = readFileSync(new URL(`../../src/domain/${file}`, import.meta.url), 'utf8');
    const found = new Set<string>();
    for (const match of source.matchAll(/\bcode:\s*([^,}]+)/g)) {
        for (const literal of (match[1] ?? '').matchAll(/'([a-zA-Z]+(?:\.[a-zA-Z]+)+)'/g)) found.add(literal[1] ?? '');
    }
    return [...found].sort();
}

describe('every code the domain can emit has a text, in both languages', () => {
    const reasonCodes = codesIn('billing.ts');
    const warningCodes = [...codesIn('reasoning.ts'), ...codesIn('routing.ts'), ...codesIn('upstream.ts')].sort();

    it('found the codes (the scan itself works)', () => {
        expect(reasonCodes.length).toBeGreaterThanOrEqual(9);
        expect(warningCodes.length).toBeGreaterThanOrEqual(5);
    });

    it('the exported code lists match the domain source', () => {
        expect([...BILLING_REASON_CODES].sort()).toEqual(reasonCodes);
        expect([...PLAN_WARNING_CODES].sort()).toEqual(warningCodes);
    });

    it.each(['en', 'ru'] as const)('has a billing.reason / plan.warning key for each code (%s)', (locale) => {
        const dict = BILLING_STRINGS[locale];
        for (const code of reasonCodes) expect(dict[`billing.reason.${code}`], code).toBeTruthy();
        for (const code of warningCodes) expect(dict[`plan.warning.${code}`], code).toBeTruthy();
    });

    it('has every English key in Russian and the other way round', () => {
        const i18n = createI18n(() => 'en');
        i18n.register(BILLING_STRINGS);
        expect(i18n.missingRussian()).toEqual([]);
        expect(i18n.missingEnglish()).toEqual([]);
    });

    it('keeps the placeholders of both languages the same', () => {
        const names = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
        for (const [key, en] of Object.entries(BILLING_STRINGS.en)) {
            expect(names(BILLING_STRINGS.ru[key] ?? ''), key).toEqual(names(en));
        }
    });
});

describe('texts', () => {
    const en = translator('en');
    const ru = translator('ru');

    it('fills params and names routing fields in words', () => {
        expect(billingReasonText({ code: 'routing.explicit', params: { fields: 'order, sort' } }, en)).toBe(
            'Explicit routing (provider order, sort) is billed pay as you go with about 5% markup and leaves the subscription.',
        );
        expect(billingReasonText({ code: 'model.notIncluded', params: { model: 'x/y' } }, en)).toContain('x/y');
        expect(billingReasonText({ code: 'subscription.multiplier', params: { value: 3 } }, en)).toContain('3×');
    });

    it('speaks Russian', () => {
        expect(billingReasonText({ code: 'routing.explicit', params: { fields: 'order' } }, ru)).toContain(
            'порядок провайдеров',
        );
        expect(planWarningText({ code: 'routing.preferenceNeedsSort' }, ru)).toContain('сортировк');
    });

    it('names efforts and models in plan warnings', () => {
        expect(
            planWarningText({ code: 'reasoning.effortAdjusted', params: { requested: 'xhigh', applied: 'high' } }, en),
        ).toBe('The model does not offer the effort "extra high"; "high" is sent instead.');
        expect(
            planWarningText(
                { code: 'reasoning.cannotDisable', params: { model: 'glm/5.3', efforts: 'low, high' } },
                en,
            ),
        ).toContain('glm/5.3 always reasons (efforts: low, high)');
    });

    it('shows a code the dictionaries do not know as itself', () => {
        expect(billingReasonText({ code: 'future.thing' }, en)).toBe('future.thing');
        expect(planWarningText({ code: 'future.warning', params: { a: 1 } }, en)).toBe('future.warning');
    });

    it('labels outcomes and stripped settings', () => {
        expect(billingOutcomeLabel('subscription', en)).toBe('Subscription');
        expect(billingOutcomeLabel('paygo', ru)).toBe('Оплата за токены');
        expect(strippedLabels(['order', 'maxPrice'], en)).toEqual(['provider order', 'price cap']);
        expect(routingFieldLabel('nonsense', en)).toBe('nonsense');
    });
});
