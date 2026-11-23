// Readable text for what the pure domain says about billing and planning: the reasons of a BillingImpact (codes
// `billing.reason.<code>`) and the warnings of an UpstreamPlan (codes `plan.warning.<code>`). Shared by every view that
// shows a verdict (the routing tab, the connection cards, the catalog). The domain only emits codes and params; this file
// owns the words, in English and Russian.
import { PROVIDER_MARKUP_PERCENT } from '../shared/constants';
import type { BillingOutcome, BillingReason, PlanWarning } from '../shared/contracts';
import type { I18nParams, I18nParts } from './types';

type Translate = (key: string, params?: I18nParams) => string;

/** Every reason and warning code the domain can emit (tests check this list against `src/domain`). */
export const BILLING_REASON_CODES: readonly string[] = [
    'billing.forced',
    'model.notIncluded',
    'billing.modelNotCoverable',
    'routing.explicit',
    'routing.unsupportedByModel',
    'routing.zdrOnly',
    'search.billedSeparately',
    'memory.billedSeparately',
    'subscription.multiplier',
];

export const PLAN_WARNING_CODES: readonly string[] = [
    'reasoning.modelUnknown',
    'reasoning.cannotDisable',
    'reasoning.effortAdjusted',
    'routing.preferenceNeedsSort',
    'routing.onlyAndOrder',
];

/** Names of the routing settings (`routingFields()` of the domain) and the label each one has in a sentence. */
export const ROUTING_FIELD_NAMES: readonly string[] = [
    'order',
    'only',
    'ignore',
    'sort',
    'quantizations',
    'minQuantization',
    'maxPrice',
    'allowFallbacks',
    'requireParameters',
    'preferredMaxLatency',
    'preferredMinThroughput',
    'cachingRoute',
];

/** `order, sort` (the `fields` parameter of a reason) as a list of labels in the interface language. */
function fieldList(value: string, t: Translate): string {
    return value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((name) => labelOrName(`billing.field.${name}`, name, t))
        .join(', ');
}

function labelOrName(key: string, fallback: string, t: Translate): string {
    const text = t(key);
    return text === key ? fallback : text;
}

/** Label of one routing setting by its RoutingConfig name (`order` -> "Provider order"). */
export function routingFieldLabel(name: string, t: Translate): string {
    return labelOrName(`billing.field.${name}`, name, t);
}

function paramsOf(source: Record<string, string | number | boolean> | undefined, t: Translate): I18nParams {
    const params: I18nParams = { markup: PROVIDER_MARKUP_PERCENT };
    for (const [key, value] of Object.entries(source ?? {})) {
        params[key] = typeof value === 'boolean' ? String(value) : value;
    }
    if (typeof params['fields'] === 'string') params['fields'] = fieldList(params['fields'], t);
    for (const key of ['requested', 'applied']) {
        const effort = params[key];
        if (typeof effort === 'string') params[key] = labelOrName(`billing.effort.${effort}`, effort, t);
    }
    return params;
}

function textOf(
    prefix: string,
    item: { code: string; params?: Record<string, string | number | boolean> },
    t: Translate,
): string {
    const key = `${prefix}.${item.code}`;
    const text = t(key, paramsOf(item.params, t));
    // A code the dictionaries do not know yet is shown as itself rather than as a raw key.
    return text === key ? item.code : text;
}

/** One reason of `BillingImpact.reasons` as a sentence. */
export function billingReasonText(reason: BillingReason, t: Translate): string {
    return textOf('billing.reason', reason, t);
}

/** One warning of `UpstreamPlan.warnings` as a sentence. */
export function planWarningText(warning: PlanWarning, t: Translate): string {
    return textOf('plan.warning', warning, t);
}

/** "Subscription" / "Pay as you go" / "Unknown". */
export function billingOutcomeLabel(outcome: BillingOutcome, t: Translate): string {
    return t(`billing.outcome.${outcome}`);
}

/** Names of the settings the proxy strips in subscription-safe mode, as labels. */
export function strippedLabels(stripped: readonly string[], t: Translate): string[] {
    return stripped.map((name) => routingFieldLabel(name, t));
}

export const BILLING_STRINGS: I18nParts = {
    en: {
        'billing.outcome.subscription': 'Subscription',
        'billing.outcome.paygo': 'Pay as you go',
        'billing.outcome.unknown': 'Not known',

        'billing.reason.billing.forced': 'This connection is set to pay as you go: every request is billed per token.',
        'billing.reason.model.notIncluded': '{model} is not included in the subscription, so it is billed per token.',
        'billing.reason.billing.modelNotCoverable':
            'Subscription only cannot be kept: {model} is outside the subscription.',
        'billing.reason.routing.explicit':
            'Explicit routing ({fields}) is billed pay as you go with about {markup}% markup and leaves the subscription.',
        'billing.reason.routing.unsupportedByModel':
            'This model runs on a fixed route: the routing settings ({fields}) are ignored, so they change nothing.',
        'billing.reason.routing.zdrOnly':
            'Zero data retention only narrows the platform’s own routing; the billing stays as it is.',
        'billing.reason.search.billedSeparately': 'Web search (:online) is billed separately.',
        'billing.reason.memory.billedSeparately': 'Context Memory is billed separately.',
        'billing.reason.subscription.multiplier':
            'This model counts {value}× of the input tokens against the subscription quota.',

        'plan.warning.reasoning.modelUnknown':
            'The model is not in the catalog, so the reasoning effort is sent as asked, unchecked.',
        'plan.warning.reasoning.cannotDisable':
            '{model} always reasons (efforts: {efforts}). Nanovia sends the lowest effort and hides the thoughts.',
        'plan.warning.reasoning.effortAdjusted':
            'The model does not offer the effort "{requested}"; "{applied}" is sent instead.',
        'plan.warning.routing.preferenceNeedsSort':
            'A preferred latency or throughput does nothing without a sort. Pick a sort.',
        'plan.warning.routing.onlyAndOrder':
            '"Only these providers" already limits the candidates; the provider order is redundant.',

        'billing.effort.none': 'none',
        'billing.effort.minimal': 'minimal',
        'billing.effort.low': 'low',
        'billing.effort.medium': 'medium',
        'billing.effort.high': 'high',
        'billing.effort.xhigh': 'extra high',
        'billing.effort.max': 'max',

        'billing.field.order': 'provider order',
        'billing.field.only': 'only these providers',
        'billing.field.ignore': 'ignored providers',
        'billing.field.sort': 'sort',
        'billing.field.quantizations': 'precision allowlist',
        'billing.field.minQuantization': 'minimum precision',
        'billing.field.maxPrice': 'price cap',
        'billing.field.allowFallbacks': 'no fallbacks',
        'billing.field.requireParameters': 'require parameters',
        'billing.field.preferredMaxLatency': 'preferred latency',
        'billing.field.preferredMinThroughput': 'preferred throughput',
        'billing.field.cachingRoute': 'caching route',
    },
    ru: {
        'billing.outcome.subscription': 'Подписка',
        'billing.outcome.paygo': 'Оплата за токены',
        'billing.outcome.unknown': 'Неизвестно',

        'billing.reason.billing.forced':
            'Подключение настроено на оплату за токены: каждый запрос оплачивается отдельно.',
        'billing.reason.model.notIncluded': '{model} не входит в подписку, поэтому оплачивается за токены.',
        'billing.reason.billing.modelNotCoverable': 'Режим «только подписка» не удержать: {model} вне подписки.',
        'billing.reason.routing.explicit':
            'Явная маршрутизация ({fields}) оплачивается за токены с наценкой около {markup}% и уводит запрос из подписки.',
        'billing.reason.routing.unsupportedByModel':
            'Модель работает по фиксированному маршруту: настройки маршрутизации ({fields}) игнорируются и ни на что не влияют.',
        'billing.reason.routing.zdrOnly':
            'Нулевое хранение данных лишь сужает собственный выбор платформы; оплата не меняется.',
        'billing.reason.search.billedSeparately': 'Веб-поиск (:online) оплачивается отдельно.',
        'billing.reason.memory.billedSeparately': 'Context Memory оплачивается отдельно.',
        'billing.reason.subscription.multiplier': 'Эта модель списывает {value}× входных токенов с квоты подписки.',

        'plan.warning.reasoning.modelUnknown':
            'Модели нет в каталоге, поэтому уровень рассуждений отправляется как запрошен, без проверки.',
        'plan.warning.reasoning.cannotDisable':
            '{model} рассуждает всегда (уровни: {efforts}). Nanovia отправит самый низкий уровень и скроет мысли.',
        'plan.warning.reasoning.effortAdjusted':
            'Модель не поддерживает уровень «{requested}»; вместо него отправляется «{applied}».',
        'plan.warning.routing.preferenceNeedsSort':
            'Желаемая задержка или скорость ничего не делают без сортировки. Выберите сортировку.',
        'plan.warning.routing.onlyAndOrder':
            '«Только эти провайдеры» уже ограничивает выбор; порядок провайдеров лишний.',

        'billing.effort.none': 'нет',
        'billing.effort.minimal': 'минимальный',
        'billing.effort.low': 'низкий',
        'billing.effort.medium': 'средний',
        'billing.effort.high': 'высокий',
        'billing.effort.xhigh': 'очень высокий',
        'billing.effort.max': 'максимальный',

        'billing.field.order': 'порядок провайдеров',
        'billing.field.only': 'только эти провайдеры',
        'billing.field.ignore': 'исключённые провайдеры',
        'billing.field.sort': 'сортировка',
        'billing.field.quantizations': 'список точностей',
        'billing.field.minQuantization': 'минимальная точность',
        'billing.field.maxPrice': 'потолок цены',
        'billing.field.allowFallbacks': 'без запасных вариантов',
        'billing.field.requireParameters': 'требовать параметры',
        'billing.field.preferredMaxLatency': 'желаемая задержка',
        'billing.field.preferredMinThroughput': 'желаемая скорость',
        'billing.field.cachingRoute': 'маршрут с кешем',
    },
};
