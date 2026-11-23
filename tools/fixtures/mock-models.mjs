// Hand-written models that exist only in the mock (ids start with `mock/`). Each one exercises a branch of the
// extension: subscription vs pay-as-you-go, reasoning that cannot be switched off, a model without provider
// selection, one that rejects `response_format`, one that is paused. Shapes copy the real `?detailed=true` catalog.

const MODEL_BASE = {
    object: 'model',
    created: 1795046400,
    owned_by: 'mock',
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
    supported_service_tiers: [],
    supported_batch_endpoints: [],
    category: 'More',
};

/** @param {Record<string, any>} spec */
function mockModel(spec) {
    const { id, name, description, efforts = [], reasoning = efforts.length > 0, structured = true, included } = spec;
    const { prompt, completion, cache, providers, category, extra = {} } = spec;
    const entry = {
        id,
        ...MODEL_BASE,
        name,
        description,
        context_length: spec.context ?? 131072,
        max_output_tokens: spec.maxOutput ?? 16384,
        capabilities: {
            vision: false,
            video_input: false,
            audio_input: false,
            reasoning,
            tool_calling: true,
            parallel_tool_calls: false,
            structured_output: structured,
            pdf_upload: false,
            batch_api: false,
        },
        open_weights: spec.openWeights ?? true,
        ...(efforts.length ? { reasoning_efforts: efforts } : {}),
        pricing: {
            prompt,
            completion,
            cacheReadInputPer1kTokens: cache,
            currency: 'USD',
            unit: 'per_million_tokens',
        },
        cost_estimate: Number(((prompt * 3 + completion * 1) / 1000).toFixed(6)),
        category: category ?? 'More',
        ...(providers ? { providers: providers.map((p) => p.provider) } : {}),
        subscription: included
            ? { included: true, inputTokenMultiplier: 1, note: 'Included in subscription' }
            : { included: false, inputTokenMultiplier: 1, note: 'Not included in subscription' },
        ...extra,
    };
    return entry;
}

function endpoint(provider, quantization, inputPer1k, outputPer1k, tps, ttftMs, uptimePct = 99.9) {
    return {
        provider,
        displayName: provider.toUpperCase(),
        pricing: { inputPer1kTokens: inputPer1k, outputPer1kTokens: outputPer1k, cacheReadInputPer1kTokens: inputPer1k / 10 },
        available: true,
        supportsPromptCaching: true,
        maxInputTokens: 131072,
        maxOutputTokens: 16384,
        ...(quantization ? { quantization } : {}),
        ...(tps ? { tps, ttftMs } : {}),
        cacheReadRate: 0.5,
        privacy: { classification: 'zdr', retainsPrompts: false, training: false },
        region: { code: 'US', label: 'United States' },
        features: { toolCalling: true, structuredOutput: true, promptCaching: true },
        uptime: { uptimePct, failures: { rateLimitedPct: 0, errorPct: 100 - uptimePct }, windowHours: 72 },
    };
}

const HOSTS = [
    endpoint('mock-fast', 'fp8', 0.0004, 0.0016, 180, 700),
    endpoint('mock-cheap', 'int4', 0.0002, 0.0008, 60, 2400, 98.5),
    endpoint('mock-precise', 'bf16', 0.0006, 0.0024, 95, 1500),
    endpoint('mock-silent', null, 0.0005, 0.002, null, null, 100),
];

const MODELS = [
    mockModel({
        id: 'mock/subscription-basic',
        name: 'Mock Subscription Basic',
        description: 'Included in the subscription, no reasoning, supports structured output.',
        included: true,
        prompt: 0.1,
        completion: 0.4,
        cache: 0.00001,
    }),
    mockModel({
        id: 'mock/subscription-reasoner',
        name: 'Mock Subscription Reasoner',
        description: 'Included in the subscription; reasoning can be switched off (none) and has three levels.',
        included: true,
        efforts: ['none', 'low', 'high'],
        prompt: 0.2,
        completion: 0.8,
        cache: 0.00002,
        providers: HOSTS,
    }),
    mockModel({
        id: 'mock/reasoning-always',
        name: 'Mock Reasoning Always',
        description: 'Always reasons: the lowest effort is low, `none` is not an option (like GLM 5.3 or Kimi).',
        included: false,
        efforts: ['low', 'high', 'max'],
        prompt: 1.2,
        completion: 4,
        cache: 0.00012,
        providers: HOSTS.slice(0, 3),
    }),
    mockModel({
        id: 'mock/paid-premium',
        name: 'Mock Paid Premium',
        description: 'Pay-as-you-go only, expensive, with vision.',
        included: false,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        prompt: 5,
        completion: 25,
        cache: 0.0005,
        providers: HOSTS.slice(1, 3),
        openWeights: false,
        extra: {
            architecture: {
                modality: 'text+image->text',
                input_modalities: ['text', 'image'],
                output_modalities: ['text'],
            },
        },
    }),
    mockModel({
        id: 'mock/structured-unsupported',
        name: 'Mock Structured Unsupported',
        description: 'Answers 400 model_response_format_unsupported when the request has response_format.',
        included: true,
        structured: false,
        prompt: 0.1,
        completion: 0.3,
        cache: 0.00001,
    }),
    mockModel({
        id: 'mock/no-selection',
        name: 'Mock No Provider Selection',
        description: 'Runs on a fixed route: provider selection is not supported.',
        included: true,
        prompt: 0.4,
        completion: 1.8,
        cache: 0.0004,
    }),
    mockModel({
        id: 'mock/uncensored-rp',
        name: 'Mock Uncensored RP',
        description: 'A roleplay finetune on three hosts with different precision.',
        included: true,
        category: 'Uncensored',
        efforts: ['none', 'high'],
        prompt: 0.3,
        completion: 1.1,
        cache: 0.00003,
        providers: HOSTS.slice(0, 3),
    }),
    mockModel({
        id: 'mock/paused',
        name: 'Mock Paused',
        description: 'Listed but unavailable (status paused): chat answers 503 model_not_available.',
        included: false,
        prompt: 0.5,
        completion: 1,
        cache: 0.00005,
        extra: { available: false, status: 'paused', unavailable_reason: 'maintenance' },
    }),
];

/** Providers responses (`GET /api/models/:id/providers`) of the mock models that have providers, plus the no-selection one. */
function providersResponse(model, hosts) {
    const input = model.pricing.prompt / 1000;
    const output = model.pricing.completion / 1000;
    const price = { inputPer1kTokens: input, outputPer1kTokens: output, cacheReadInputPer1kTokens: model.pricing.cacheReadInputPer1kTokens };
    return {
        canonicalId: model.id,
        displayName: model.name,
        supportsProviderSelection: true,
        defaultPrice: price,
        autoPricing: { zdr: price, anonymized: price },
        providers: hosts.map((h) => ({
            ...h,
            pricing: {
                inputPer1kTokens: Number((input * (h.pricing.inputPer1kTokens / 0.0004)).toFixed(8)),
                outputPer1kTokens: Number((output * (h.pricing.outputPer1kTokens / 0.0016)).toFixed(8)),
                cacheReadInputPer1kTokens: h.pricing.cacheReadInputPer1kTokens,
            },
        })),
        autoTps: 110,
        autoTtftMs: 1400,
        autoCacheReadRate: 0.5,
    };
}

const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));

export const MOCK_MODELS = MODELS;

export const MOCK_PROVIDERS = {
    'mock/subscription-reasoner': providersResponse(byId['mock/subscription-reasoner'], HOSTS),
    'mock/reasoning-always': providersResponse(byId['mock/reasoning-always'], HOSTS.slice(0, 3)),
    'mock/paid-premium': providersResponse(byId['mock/paid-premium'], HOSTS.slice(1, 3)),
    'mock/uncensored-rp': providersResponse(byId['mock/uncensored-rp'], HOSTS.slice(0, 3)),
    'mock/no-selection': {
        canonicalId: 'mock/no-selection',
        supportsProviderSelection: false,
        providerDetails: [],
        message: 'This model does not support provider selection',
        defaultPrice: {
            inputPer1kTokens: 0.0004,
            outputPer1kTokens: 0.0018,
            cacheReadInputPer1kTokens: 0.0004,
        },
    },
};
