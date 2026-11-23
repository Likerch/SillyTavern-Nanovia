// POST /api/v1/chat/completions: stream and non-stream, reasoning, usage and NanoGPT's own pricing block.
import { header, randomId, sendError, sendJson, sleep } from './http.mjs';
import { subscriptionQuotaAvailable } from './state.mjs';

const PAYGO_VALUES = new Set(['paygo', 'pay-as-you-go', 'pay_as_you_go', 'paid', 'payg']);
const MARKUP = 1.05;

export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

/** The text of a message `content`: a string, or an array of parts. */
function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** Pieces of about three words that join back into the exact text. */
function pieces(text) {
    const words = String(text).match(/\s*\S+/g) ?? [];
    const out = [];
    for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3).join(''));
    return out;
}

const round = (n) => Math.round(n * 1e10) / 1e10;

/** Does this request pay as you go no matter what the subscription says? */
function payAsYouGo(req, body) {
    const value = body.billing_mode ?? body.billingMode ?? header(req, 'x-billing-mode');
    return typeof value === 'string' && PAYGO_VALUES.has(value.toLowerCase());
}

/** The provider the request picked explicitly (`X-Provider` or a `provider` object), or null. */
function explicitProvider(req, body) {
    const named = header(req, 'x-provider')?.split(',')[0].trim();
    const object = body.provider && typeof body.provider === 'object' ? body.provider : null;
    if (!named && !object) return null;
    return { name: named || object?.order?.[0] || object?.only?.[0] || null };
}

/**
 * Does the model reason on this request, and is its text returned? Models that always reason ignore `none`, and a
 * `:thinking` id or suffix always reasons.
 */
function reasoningPlan(body, model, requestedId, suffixes) {
    const thinking = requestedId.endsWith(':thinking') || suffixes.includes('thinking');
    if (!model.capabilities.reasoning && !thinking) return { on: false };
    const options = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : {};
    const effort = options.effort ?? body.reasoning_effort ?? null;
    const efforts = model.reasoning_efforts ?? [];
    const asksOff = effort === 'none' || options.enabled === false;
    const canDisable = (efforts.length === 0 || efforts.includes('none')) && !thinking;
    return {
        on: !(asksOff && canDisable),
        effort,
        hidden: options.exclude === true || body.include_reasoning === false,
    };
}

/**
 * Handles one chat request. `ctx`: { req, res, body, invalidJson, requestId, state, catalog }.
 * Billing is decided up front (the reply is known), so the stream can end with a complete usage block.
 */
export async function handleChat(ctx) {
    const { req, res, body, invalidJson, requestId, state, catalog, keyId } = ctx;
    if (invalidJson || !body || typeof body !== 'object') {
        return sendError(res, 400, 'invalid_json', 'The request body is not valid JSON.');
    }
    if (typeof body.model !== 'string' || !body.model) {
        return sendError(res, 400, 'missing_required_parameter', 'model is required', { param: 'model' });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return sendError(res, 400, 'missing_required_parameter', 'messages is required', { param: 'messages' });
    }
    const resolved = catalog.resolveModel(body.model);
    if (!resolved)
        return sendError(res, 404, 'model_not_found', `The model '${body.model}' does not exist`, { param: 'model' });
    const { model, suffixes } = resolved;
    if (model.available === false) {
        return sendError(
            res,
            503,
            'model_not_available',
            `The model '${model.id}' is ${model.status ?? 'unavailable'} right now.`,
            {
                headers: { 'Retry-After': '30' },
            },
        );
    }
    if (model.id === 'mock/structured-unsupported' && body.response_format !== undefined) {
        return sendError(
            res,
            400,
            'model_response_format_unsupported',
            `${model.id} does not support response_format`,
            {
                param: 'response_format',
            },
        );
    }
    if (body.provider?.data_collection === 'deny') {
        return sendError(res, 400, 'invalid_parameter_value', 'provider.data_collection "deny" is not supported', {
            param: 'provider.data_collection',
        });
    }

    // Billing: the subscription covers a request only when nothing in it asks for paid routing.
    const picked = explicitProvider(req, body);
    const covered =
        model.subscription?.included === true && !picked && !payAsYouGo(req, body) && subscriptionQuotaAvailable(state);
    if (!covered && state.balanceUsd <= 0) {
        return sendError(res, 402, 'insufficient_balance', 'Insufficient balance', {
            type: 'insufficient_quota',
            status: 402,
            requiredBalance: 0.01,
        });
    }

    // The reply.
    const lastUser = [...body.messages].reverse().find((m) => m?.role === 'user');
    const snippet = textOf(lastUser?.content).replace(/\s+/g, ' ').trim().slice(0, 60);
    let content = header(req, 'x-mock-reply')
        ? decodeURIComponent(header(req, 'x-mock-reply'))
        : `Mock reply from ${model.id}: ${snippet}`;
    const plan = reasoningPlan(body, model, body.model, suffixes);
    const reasoning = plan.on ? `Thinking at ${plan.effort ?? 'default'} effort about: ${snippet}` : '';
    const cap = Number(body.max_completion_tokens ?? body.max_tokens);
    let finish = 'stop';
    if (Number.isInteger(cap) && cap > 0 && estimateTokens(content) > cap) {
        content = content.slice(0, cap * 4);
        finish = 'length';
    }

    // Tokens, cost, usage.
    const promptTokens = body.messages.reduce((sum, m) => sum + estimateTokens(textOf(m?.content)) + 4, 0);
    const reasoningTokens = estimateTokens(reasoning);
    const completionTokens = estimateTokens(content) + reasoningTokens;
    const cachedHeader = Number.parseInt(header(req, 'x-mock-cached-tokens') ?? '', 10);
    const cachedTokens = Math.min(
        promptTokens,
        Number.isInteger(cachedHeader) ? cachedHeader : body.caching === true ? Math.floor(promptTokens / 2) : 0,
    );
    const price = priceFor(catalog, model, picked);
    const cacheCost = cachedTokens * price.cacheRead;
    const cost = covered
        ? 0
        : round((promptTokens - cachedTokens) * price.prompt + cacheCost + completionTokens * price.completion);
    if (covered) {
        const used = Math.round(promptTokens * (model.subscription.inputTokenMultiplier ?? 1));
        state.subscription.dailyUsed += used;
        state.subscription.weeklyUsed += used;
    } else {
        state.balanceUsd = Math.max(0, round(state.balanceUsd - cost));
    }
    const now = Date.now();
    state.billing.set(requestId, {
        keyId,
        at: now,
        cost,
        input: promptTokens,
        output: completionTokens,
        reasoning: reasoningTokens || null,
    });
    state.records.push({
        keyId,
        at: now,
        model: model.id,
        cost,
        input: promptTokens,
        output: completionTokens,
        reasoning: reasoningTokens,
    });

    const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: cachedTokens },
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
        cost,
        currency: 'USD',
    };
    const pricing = {
        cost,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        cacheCost: covered ? 0 : round(cacheCost),
        paymentSource: covered ? 'subscription' : 'USD',
        requestId,
        isEstimate: false,
    };
    const wantsUsage =
        body.usage?.include === true ||
        body.include_usage === true ||
        body.stream_options?.include_usage === true ||
        body.caching === true;
    const headers = suffixes.length ? { 'X-Mock-Applied-Suffixes': suffixes.join(',') } : {};
    const base = { id: randomId('chatcmpl-', 12), created: Math.floor(now / 1000), model: body.model };
    const shownReasoning = plan.on && !plan.hidden ? reasoning : '';

    if (body.stream !== true) {
        const message = { role: 'assistant', content, ...(shownReasoning ? { reasoning: shownReasoning } : {}) };
        return sendJson(
            res,
            200,
            {
                ...base,
                object: 'chat.completion',
                choices: [{ index: 0, message, finish_reason: finish }],
                ...(wantsUsage ? { usage, x_nanogpt_pricing: pricing } : {}),
            },
            headers,
        );
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...headers,
    });
    const delay = Math.min(Number(header(req, 'x-mock-chunk-delay-ms')) || 0, 5000);
    const chunk = (delta, finish_reason = null) => ({
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason }],
    });
    const frames = [chunk({ role: 'assistant' })];
    for (const piece of pieces(shownReasoning)) frames.push(chunk({ reasoning: piece }));
    for (const piece of pieces(content)) frames.push(chunk({ content: piece }));
    frames.push(chunk({}, finish));
    if (wantsUsage)
        frames.push({ ...base, object: 'chat.completion.chunk', choices: [], usage, x_nanogpt_pricing: pricing });
    for (const frame of frames) {
        if (res.destroyed) return undefined;
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
        if (delay) await sleep(delay);
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return undefined;
}

/** USD per token for a request: the catalog price, or what an explicitly chosen host charges (markup included). */
function priceFor(catalog, model, picked) {
    const base = catalog.pricePerToken(model);
    if (!picked) return base;
    const host = picked.name
        ? catalog.providersFor(model.id)?.providers?.find((p) => p.provider === picked.name)
        : null;
    if (host?.pricing) {
        const { inputPer1kTokens, outputPer1kTokens, cacheReadInputPer1kTokens } = host.pricing;
        return {
            prompt: inputPer1kTokens / 1000,
            completion: outputPer1kTokens / 1000,
            cacheRead: (cacheReadInputPer1kTokens ?? inputPer1kTokens / 10) / 1000,
        };
    }
    return { prompt: base.prompt * MARKUP, completion: base.completion * MARKUP, cacheRead: base.cacheRead * MARKUP };
}
