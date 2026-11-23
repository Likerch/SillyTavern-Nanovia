// Routing hints (stage 3): short, machine-readable remarks about a model and its hosts that the panel shows next to the
// routing settings. The rules are a table (HINT_RULES) so a new one is one entry; each looks at the catalog entry and,
// when the host list has been loaded, at the hosts. Pure: no network, no clock.
//
// Rules (code: fires when -> severity, suggested routing):
//   quant.glmFp8               GLM family (id has "glm"). Official hosts serve fp8; fp4/nvfp4 hosts are below the original.
//                              With the host list: fires when some host is below fp8 -> warn, min quantization fp8 (not
//                              suggested when no host would be left). Without it: only when the entry names hosts -> info.
//   quant.deepseekNative       DeepSeek V4.x (id has "deepseek-v4"). Its experts are natively MXFP4, so fp4 labelled mxfp4
//                              is the original; a host that serves int4 or fp4 under any other label is suspicious
//                              -> warn, ignore those hosts. Needs the host list.
//   hosts.few                  one or two hosts (an availability risk) -> warn.
//   routing.fixedRoute         NanoGPT says the model has no provider selection (soft routing does nothing) -> info.
//   cache.lowRate              under automatic routing less than 60% of the prompt is read from cache -> info.
//   reasoning.alwaysOn         the model lists reasoning efforts and none is "none" -> info.
//   shelf.uncensoredUnmeasured Uncensored shelf, or uncensored/abliterated/heretic in the id -> info.
//   billing.bypass             (added after the rules) a suggested routing would take a subscription-included model off
//                              the subscription: explicit provider routing is billed with a markup -> info.
import { PROVIDER_MARKUP_PERCENT } from '../shared/constants';
import type { CatalogModel, ModelProviders, ProviderEndpoint, RoutingConfig } from '../shared/contracts';
import type { HintSeverity, RoutingHint } from '../shared/contracts-catalog';
import { meetsMinQuantization } from './catalog';

type HintParams = RoutingHint['params'];

interface HintContext {
    model: CatalogModel;
    /** null: the host list has not been loaded (or failed to load). */
    mp: ModelProviders | null;
}

/** What a rule found. `severity` overrides the table's default; `suggestedRouting` is a one-click patch. */
interface HintOutcome {
    params: HintParams;
    severity?: HintSeverity;
    suggestedRouting?: Partial<RoutingConfig>;
}

interface HintRule {
    code: string;
    severity: HintSeverity;
    /** The outcome when the rule fires, otherwise null. */
    evaluate(ctx: HintContext): HintOutcome | null;
}

/* ------------------------------------------------------------------------------------------------ rule data */

/** Lower-cased fragments of the model id that put a model in a family. */
const GLM_ID_MARKERS = ['glm'];
const DEEPSEEK_V4_ID_MARKERS = ['deepseek-v4'];
const UNCENSORED_ID_MARKERS = ['uncensored', 'abliterated', 'heretic'];
const UNCENSORED_CATEGORY = 'uncensored';

/** The precision GLM's own (official) hosts serve; hosts below it are re-quantised copies. */
const GLM_REFERENCE_QUANTIZATION = 'fp8';
/** DeepSeek V4 experts are natively MXFP4: that label is the original, any other 4-bit label is a re-quantisation. */
const DEEPSEEK_NATIVE_LABEL = 'mxfp4';
/** `hosts.few` fires at this many hosts or fewer (but at least one). */
const FEW_HOSTS_MAX = 2;
/** `cache.lowRate` fires below this share of the prompt read from cache under automatic routing. */
const LOW_CACHE_RATE = 0.6;
/** The reasoning ladder, lowest first. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function idHas(model: CatalogModel, markers: readonly string[]): boolean {
    const id = model.id.toLowerCase();
    return markers.some((m) => id.includes(m));
}

function names(hosts: readonly ProviderEndpoint[]): string {
    return hosts.map((h) => h.id).join(', ');
}

/** The number of hosts the model has: the loaded list when there is one, else what the catalog entry names. */
function hostCount(ctx: HintContext): number {
    return ctx.mp ? ctx.mp.providers.length : ctx.model.providerIds.length;
}

/* ------------------------------------------------------------------------------------------------ rules */

const glmFp8: HintRule = {
    code: 'quant.glmFp8',
    severity: 'warn',
    evaluate({ model, mp }) {
        if (!idHas(model, GLM_ID_MARKERS)) return null;
        const suggestion: Partial<RoutingConfig> = { enabled: true, minQuantization: GLM_REFERENCE_QUANTIZATION };
        if (!mp) {
            // Until the host list is loaded the catalog entry decides: no hosts named means nothing to route.
            if (model.providerIds.length === 0) return null;
            return { severity: 'info', params: { model: model.id, hostsKnown: false }, suggestedRouting: suggestion };
        }
        const low = mp.providers.filter(
            (h) => meetsMinQuantization(h.quantization, GLM_REFERENCE_QUANTIZATION) === false,
        );
        if (low.length === 0) return null;
        const unknown = mp.providers.filter(
            (h) => meetsMinQuantization(h.quantization, GLM_REFERENCE_QUANTIZATION) === null,
        );
        const ok = mp.providers.length - low.length - unknown.length;
        const params: HintParams = {
            model: model.id,
            hostsKnown: true,
            lowHosts: low.length,
            low: names(low),
            unknownHosts: unknown.length,
            okHosts: ok,
        };
        // With no host at fp8 or better the floor would leave nothing to route to: warn, but do not suggest it.
        return ok > 0 ? { params, suggestedRouting: suggestion } : { params };
    },
};

const deepseekNative: HintRule = {
    code: 'quant.deepseekNative',
    severity: 'warn',
    evaluate({ model, mp }) {
        if (!mp || !idHas(model, DEEPSEEK_V4_ID_MARKERS)) return null;
        const fourBit = mp.providers.filter((h) => h.quantization === 'fp4' || h.quantization === 'int4');
        const suspicious = fourBit.filter((h) => (h.rawQuantization ?? '').toLowerCase() !== DEEPSEEK_NATIVE_LABEL);
        if (suspicious.length === 0) return null;
        return {
            params: {
                model: model.id,
                suspiciousHosts: suspicious.length,
                suspicious: names(suspicious),
                nativeHosts: fourBit.length - suspicious.length,
            },
            suggestedRouting: { enabled: true, ignore: suspicious.map((h) => h.id) },
        };
    },
};

const hostsFew: HintRule = {
    code: 'hosts.few',
    severity: 'warn',
    evaluate(ctx) {
        const count = hostCount(ctx);
        return count >= 1 && count <= FEW_HOSTS_MAX ? { params: { hosts: count } } : null;
    },
};

const fixedRoute: HintRule = {
    code: 'routing.fixedRoute',
    severity: 'info',
    evaluate({ model, mp }) {
        return mp?.supportsProviderSelection === false ? { params: { model: model.id } } : null;
    },
};

const cacheLowRate: HintRule = {
    code: 'cache.lowRate',
    severity: 'info',
    evaluate({ mp }) {
        const rate = mp?.autoCacheReadRate;
        return rate !== null && rate !== undefined && rate < LOW_CACHE_RATE
            ? { params: { percent: Math.round(rate * 100), threshold: Math.round(LOW_CACHE_RATE * 100) } }
            : null;
    },
};

const reasoningAlwaysOn: HintRule = {
    code: 'reasoning.alwaysOn',
    severity: 'info',
    evaluate({ model }) {
        const efforts = model.reasoningEfforts;
        if (efforts.length === 0 || efforts.includes('none')) return null;
        const rank = (e: string): number => {
            const i = EFFORT_ORDER.indexOf(e);
            return i < 0 ? EFFORT_ORDER.length : i;
        };
        const lowest = [...efforts].sort((a, b) => rank(a) - rank(b))[0] ?? '';
        return { params: { efforts: efforts.join(', '), lowest } };
    },
};

const uncensoredUnmeasured: HintRule = {
    code: 'shelf.uncensoredUnmeasured',
    severity: 'info',
    evaluate({ model }) {
        const byShelf = (model.category ?? '').toLowerCase() === UNCENSORED_CATEGORY;
        if (!byShelf && !idHas(model, UNCENSORED_ID_MARKERS)) return null;
        return { params: { model: model.id, byShelf } };
    },
};

/** The rule table, in the order the hints are listed (warnings are moved to the front, the order inside is kept). */
export const HINT_RULES: readonly HintRule[] = [
    glmFp8,
    deepseekNative,
    hostsFew,
    fixedRoute,
    cacheLowRate,
    reasoningAlwaysOn,
    uncensoredUnmeasured,
];

/** Added after the rules when a suggestion would leave the subscription (explicit routing is billed with a markup). */
export const BILLING_BYPASS_CODE = 'billing.bypass';

/** Every code `routingHints` can return, for i18n completeness checks. */
export const HINT_CODES: readonly string[] = [...HINT_RULES.map((r) => r.code), BILLING_BYPASS_CODE];

/**
 * Hints for one model. `mp` is the loaded host list or null; rules that need hosts stay quiet without it. Warnings come
 * first, then infos, each group in table order; `billing.bypass` closes the list when a subscription-included model gets
 * a suggested routing.
 */
export function routingHints(model: CatalogModel, mp: ModelProviders | null): RoutingHint[] {
    const hints: RoutingHint[] = [];
    for (const rule of HINT_RULES) {
        const outcome = rule.evaluate({ model, mp });
        if (!outcome) continue;
        const hint: RoutingHint = {
            code: rule.code,
            severity: outcome.severity ?? rule.severity,
            params: outcome.params,
        };
        if (outcome.suggestedRouting) hint.suggestedRouting = outcome.suggestedRouting;
        hints.push(hint);
    }
    if (model.subscription.included && hints.some((h) => h.suggestedRouting)) {
        const source = hints.find((h) => h.suggestedRouting);
        hints.push({
            code: BILLING_BYPASS_CODE,
            severity: 'info',
            params: { markupPercent: PROVIDER_MARKUP_PERCENT, because: source?.code ?? '' },
        });
    }
    const rank = (h: RoutingHint): number => (h.severity === 'warn' ? 0 : 1);
    return hints.sort((a, b) => rank(a) - rank(b));
}
