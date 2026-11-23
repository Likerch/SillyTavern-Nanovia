// The Management API's starting data: a few keys and presets with fixed ids, dates and limits, so a test or the stand
// finds the same thing after every `POST /__mock/reset`. Ids 1-3 and the names below are part of the mock's contract.

const KEY_LIMIT_NAMES = [
    'daily_rpd_limit',
    'daily_input_token_limit',
    'daily_usd_limit',
    'weekly_usd_limit',
    'monthly_usd_limit',
    'weekly_request_limit',
    'monthly_request_limit',
    'weekly_input_token_limit',
    'monthly_input_token_limit',
    'daily_subscription_input_token_limit',
    'weekly_subscription_input_token_limit',
    'monthly_subscription_input_token_limit',
];

/** A key document with every documented property: limits not given are null. */
function seedKey(fields) {
    return {
        object: 'api_key',
        status: 'active',
        expires_at: null,
        ...Object.fromEntries(KEY_LIMIT_NAMES.map((name) => [name, null])),
        zdr_policy: 'off',
        ...fields,
    };
}

export const SEED_KEYS = [
    seedKey({
        id: '1',
        name: 'Nanovia main',
        created_at: '2026-09-01T09:00:00.000Z',
        daily_usd_limit: 5,
        weekly_usd_limit: 20,
        monthly_usd_limit: 50,
    }),
    seedKey({
        id: '2',
        name: 'Roleplay capped',
        created_at: '2026-09-15T18:30:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        daily_rpd_limit: 300,
        weekly_request_limit: 1500,
        monthly_request_limit: 6000,
        daily_subscription_input_token_limit: 800_000,
        weekly_subscription_input_token_limit: 4_000_000,
        zdr_policy: 'zdr',
    }),
    // Expired long ago (the document's status says so) and a legacy zdr policy: a key the user would clean up.
    seedKey({
        id: '3',
        name: 'Old test key',
        created_at: '2026-01-10T12:00:00.000Z',
        expires_at: '2026-02-10T12:00:00.000Z',
        daily_usd_limit: 0,
        zdr_policy: 'unset',
    }),
];

export const SEED_NEXT_KEY_ID = 4;

export const PRESET_FIELD_NAMES = [
    'model',
    'system_prompt',
    'max_tokens',
    'top_k',
    'temperature',
    'top_p',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'min_p',
    'top_a',
    'response_format_type',
    'reasoning_effort',
    'reasoning_summary',
    'verbosity',
    'provider_routing_preference',
    'service_tier',
    'structured_outputs',
    'thinking',
    'prompt_caching',
];

/** A preset document with every documented property: settings not given are null. */
function seedPreset(fields) {
    return {
        ...Object.fromEntries(PRESET_FIELD_NAMES.map((name) => [name, null])),
        created_at: '2026-10-02T08:00:00.000Z',
        updated_at: '2026-10-02T08:00:00.000Z',
        ...fields,
    };
}

export const SEED_PRESETS = [
    seedPreset({
        name: 'rp-fast',
        model: 'deepseek/deepseek-v4.1-flash',
        system_prompt: 'You are a vivid roleplay narrator.',
        max_tokens: 1200,
        temperature: 0.9,
        top_p: 0.95,
        provider_routing_preference: 'speed',
    }),
    seedPreset({
        name: 'analyst',
        model: 'z-ai/glm-5.3',
        temperature: 0.2,
        reasoning_effort: 'high',
        response_format_type: 'json_object',
        structured_outputs: true,
        thinking: { type: 'enabled', budget_tokens: 4000 },
        prompt_caching: { enabled: true, ttl: '1h' },
        updated_at: '2026-10-03T09:30:00.000Z',
    }),
];

/** Fresh Map copies of the seeds (the live state is changed by tests; the seeds never are). */
export function seedManagement() {
    return {
        keys: new Map(SEED_KEYS.map((key) => [key.id, structuredClone(key)])),
        presets: new Map(SEED_PRESETS.map((preset) => [preset.name, structuredClone(preset)])),
        nextKeyId: SEED_NEXT_KEY_ID,
    };
}
