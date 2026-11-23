import { describe, expect, it } from 'vitest';
import {
    KEY_LIMIT_FIELDS,
    KEY_LIMIT_KINDS,
    KEY_LIMIT_PERIODS,
    KEY_LIMIT_RANGES,
    PRESET_BODY_LIMIT_BYTES,
    PRESET_PROMPT_MAX_LENGTH,
    checkKeyId,
    checkMgmtToken,
    checkPresetName,
    describeIssues,
    describeTokenIssue,
    keyCreateToWire,
    keyPatchToWire,
    normalizeManagedKey,
    normalizeManagedKeys,
    normalizeModelPreset,
    normalizeModelPresets,
    presetToWire,
    sanitizeKeyCreateInput,
    sanitizeKeyLimitsPatch,
    sanitizePresetInput,
    type InputIssue,
    type MgmtTokenIssue,
} from '../../src/domain/mgmt';

const TOKEN = 'sk-nano-mgmt-TESTTOKEN';

/** A key as `GET /api-keys` returns it (every property of the documented ApiKey). */
const WIRE_KEY = {
    id: '12',
    object: 'api_key',
    name: 'Roleplay',
    status: 'active',
    created_at: '2026-10-01T10:00:00.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
    daily_rpd_limit: 300,
    daily_input_token_limit: 4_000_000,
    daily_usd_limit: 1.5,
    weekly_usd_limit: 8,
    monthly_usd_limit: 20,
    weekly_request_limit: 1500,
    monthly_request_limit: 6000,
    weekly_input_token_limit: 20_000_000,
    monthly_input_token_limit: 80_000_000,
    daily_subscription_input_token_limit: 800_000,
    weekly_subscription_input_token_limit: 4_000_000,
    monthly_subscription_input_token_limit: 16_000_000,
    zdr_policy: 'off',
};

function issuesOf(result: { ok: boolean; issues?: InputIssue[] }): InputIssue[] {
    if (result.ok) throw new Error('expected a failed check');
    return result.issues ?? [];
}

function valueOf<T>(result: { ok: boolean; value?: T }): T {
    if (!result.ok) throw new Error(`expected a passed check: ${JSON.stringify(result)}`);
    return result.value as T;
}

describe('checkMgmtToken', () => {
    it('accepts a Management token and drops surrounding whitespace', () => {
        expect(checkMgmtToken(TOKEN)).toEqual({ ok: true, token: TOKEN });
        expect(checkMgmtToken(`  ${TOKEN}\r\n`)).toEqual({ ok: true, token: TOKEN });
    });

    it('names what is wrong without echoing the value', () => {
        const cases: [unknown, MgmtTokenIssue][] = [
            [undefined, 'not_string'],
            [42, 'not_string'],
            ['   ', 'empty'],
            ['sk-nano-0123456789abcdef0123456789abcdef', 'inference_key'],
            ['bearer sk-nano-mgmt-TESTTOKEN', 'prefix'],
            ['sk-nano-mgmt-short', 'too_short'],
            [`sk-nano-mgmt-${'x'.repeat(600)}`, 'too_long'],
            ['sk-nano-mgmt-TEST TOKEN', 'characters'],
            ['sk-nano-mgmt-TESTTOKEN\u0007', 'characters'],
        ];
        for (const [input, issue] of cases) {
            expect(checkMgmtToken(input), String(input)).toEqual({ ok: false, issue });
            expect(describeTokenIssue(issue)).not.toContain('TESTTOKEN');
        }
        for (const issue of ['not_string', 'empty', 'inference_key', 'prefix', 'too_short', 'too_long', 'characters']) {
            expect(describeTokenIssue(issue as MgmtTokenIssue)).toMatch(/\w/);
        }
    });
});

describe('normalizeManagedKey', () => {
    it('maps the documented ApiKey into the grouped contract', () => {
        expect(normalizeManagedKey(WIRE_KEY)).toEqual({
            id: '12',
            name: 'Roleplay',
            status: 'active',
            createdAt: Date.parse('2026-10-01T10:00:00.000Z'),
            expiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
            limits: {
                requests: { daily: 300, weekly: 1500, monthly: 6000 },
                usd: { daily: 1.5, weekly: 8, monthly: 20 },
                inputTokens: { daily: 4_000_000, weekly: 20_000_000, monthly: 80_000_000 },
                subscriptionInputTokens: { daily: 800_000, weekly: 4_000_000, monthly: 16_000_000 },
            },
            zdrPolicy: 'off',
        });
    });

    it('covers every wire limit field exactly once', () => {
        const fields = KEY_LIMIT_KINDS.flatMap((kind) => KEY_LIMIT_PERIODS.map((p) => KEY_LIMIT_FIELDS[kind][p]));
        expect(new Set(fields).size).toBe(12);
        for (const field of fields) expect(WIRE_KEY).toHaveProperty(field);
    });

    it('is tolerant: missing fields are null, unknown ones are ignored, a number id becomes a string', () => {
        const key = normalizeManagedKey({ id: 7, extra: { deep: true }, status: 'something-new', expires_at: null });
        expect(key).toEqual({
            id: '7',
            name: '',
            status: 'active',
            createdAt: null,
            expiresAt: null,
            limits: {
                requests: { daily: null, weekly: null, monthly: null },
                usd: { daily: null, weekly: null, monthly: null },
                inputTokens: { daily: null, weekly: null, monthly: null },
                subscriptionInputTokens: { daily: null, weekly: null, monthly: null },
            },
            zdrPolicy: null,
        });
    });

    it('reads status, decimal strings, bad limits and odd dates', () => {
        const key = normalizeManagedKey({
            id: ' 3 ',
            status: 'expired',
            daily_usd_limit: '2.50',
            weekly_usd_limit: -1,
            monthly_usd_limit: 'lots',
            daily_rpd_limit: 0,
            created_at: 1_790_000_000, // seconds
            expires_at: 'not a date',
            zdr_policy: ' ZDR ',
        });
        expect(key).toMatchObject({
            id: '3',
            status: 'expired',
            createdAt: 1_790_000_000_000,
            expiresAt: null,
            zdrPolicy: 'zdr',
        });
        expect(key?.limits.usd).toEqual({ daily: 2.5, weekly: null, monthly: null });
        expect(key?.limits.requests.daily).toBe(0); // a real limit that blocks the key
        expect(normalizeManagedKey({ id: 1, created_at: 1_790_000_000_000 })?.createdAt).toBe(1_790_000_000_000);
        expect(normalizeManagedKey({ id: 1, created_at: -5 })?.createdAt).toBeNull();
    });

    it('rejects what has no id', () => {
        for (const raw of [null, undefined, 'x', [], {}, { id: '' }, { id: '  ' }, { id: Number.NaN }, { id: {} }]) {
            expect(normalizeManagedKey(raw)).toBeNull();
        }
    });

    it('never carries the secret of a freshly created key', () => {
        const key = normalizeManagedKey({ ...WIRE_KEY, key: 'sk-nano-SECRET-ON-CREATE' });
        expect(JSON.stringify(key)).not.toContain('SECRET');
    });
});

describe('normalizeManagedKeys', () => {
    it('reads { data }, a bare array, drops junk and repeated ids', () => {
        const wire = [WIRE_KEY, null, { name: 'no id' }, { ...WIRE_KEY, name: 'again' }, { ...WIRE_KEY, id: '13' }];
        expect(normalizeManagedKeys({ data: wire })?.map((k) => `${k.id}:${k.name}`)).toEqual([
            '12:Roleplay',
            '13:Roleplay',
        ]);
        expect(normalizeManagedKeys(wire)).toHaveLength(2);
        expect(normalizeManagedKeys({ data: [] })).toEqual([]);
    });

    it('answers null for something that is not a list', () => {
        for (const raw of [null, undefined, 'x', {}, { data: 'nope' }, { keys: [] }]) {
            expect(normalizeManagedKeys(raw)).toBeNull();
        }
    });
});

/** A preset as `GET /model-presets` returns it. */
const WIRE_PRESET = {
    name: 'rp-fast',
    model: 'deepseek/deepseek-v4.1-flash',
    system_prompt: 'You narrate.',
    max_tokens: 1200,
    top_k: 40,
    temperature: 0.9,
    top_p: 0.95,
    min_p: 0.05,
    top_a: null,
    frequency_penalty: 0.1,
    presence_penalty: -0.1,
    repetition_penalty: 1.05,
    response_format_type: 'json_object',
    structured_outputs: true,
    reasoning_effort: 'high',
    reasoning_summary: 'concise',
    verbosity: 'low',
    provider_routing_preference: 'speed',
    service_tier: 'default',
    thinking: { type: 'enabled', budget_tokens: 4000 },
    prompt_caching: { enabled: true, ttl: '1h' },
    created_at: '2026-10-02T08:00:00.000Z',
    updated_at: '2026-10-03T09:30:00.000Z',
};

describe('normalizeModelPreset', () => {
    it('maps every documented field', () => {
        expect(normalizeModelPreset(WIRE_PRESET)).toEqual({
            name: 'rp-fast',
            model: 'deepseek/deepseek-v4.1-flash',
            systemPrompt: 'You narrate.',
            maxTokens: 1200,
            topK: 40,
            temperature: 0.9,
            topP: 0.95,
            minP: 0.05,
            topA: null,
            frequencyPenalty: 0.1,
            presencePenalty: -0.1,
            repetitionPenalty: 1.05,
            responseFormat: 'json_object',
            structuredOutputs: true,
            reasoningEffort: 'high',
            reasoningSummary: 'concise',
            verbosity: 'low',
            routing: 'speed',
            serviceTier: 'default',
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '1h' },
            createdAt: Date.parse('2026-10-02T08:00:00.000Z'),
            updatedAt: Date.parse('2026-10-03T09:30:00.000Z'),
        });
    });

    it('is tolerant: lower-cases the name, nulls what is missing or unknown, ignores extras', () => {
        const preset = normalizeModelPreset({
            name: ' Mixed-Case ',
            reasoning_effort: 'sideways',
            verbosity: 7,
            thinking: 'yes',
            prompt_caching: { ttl: '5m' },
            temperature: 'warm',
            future_field: 1,
        });
        expect(preset).toMatchObject({
            name: 'mixed-case',
            model: '',
            reasoningEffort: null,
            verbosity: null,
            thinking: null,
            promptCaching: null,
            temperature: null,
            systemPrompt: null,
        });
    });

    it('reads the boolean forms of thinking and prompt_caching', () => {
        const a = normalizeModelPreset({ name: 'a', thinking: true, prompt_caching: false });
        expect(a?.thinking).toEqual({ enabled: true, budgetTokens: null });
        expect(a?.promptCaching).toEqual({ enabled: false, ttl: null });
        const b = normalizeModelPreset({
            name: 'b',
            thinking: { type: 'enabled' },
            prompt_caching: { enabled: true, ttl: '1d' },
        });
        expect(b?.thinking).toEqual({ enabled: true, budgetTokens: null });
        expect(b?.promptCaching).toEqual({ enabled: true, ttl: null });
        expect(normalizeModelPreset({ name: 'c', thinking: { type: 'enabled', budget_tokens: -3 } })?.thinking).toEqual(
            {
                enabled: true,
                budgetTokens: null,
            },
        );
        expect(normalizeModelPreset({ name: 'd', thinking: false })?.thinking).toEqual({
            enabled: false,
            budgetTokens: null,
        });
    });

    it('rejects what has no name', () => {
        for (const raw of [null, 'x', [], {}, { name: '  ' }, { name: 5 }])
            expect(normalizeModelPreset(raw)).toBeNull();
    });

    it('lists presets once per name and answers null for a non-list', () => {
        expect(
            normalizeModelPresets({ data: [WIRE_PRESET, { ...WIRE_PRESET, name: 'RP-FAST' }, 3, { name: 'other' }] }),
        ).toHaveLength(2);
        expect(normalizeModelPresets([WIRE_PRESET])).toHaveLength(1);
        expect(normalizeModelPresets({ presets: [] })).toBeNull();
    });
});

describe('sanitizeKeyLimitsPatch', () => {
    it('keeps what it is given: a name, an expiry, a policy and limits per kind and period', () => {
        const result = sanitizeKeyLimitsPatch({
            name: '  Renamed  ',
            expiresAt: 1_900_000_000_000,
            zdrPolicy: 'zdr',
            limits: { usd: { monthly: 20 }, requests: { daily: 300, weekly: null }, inputTokens: { daily: 0 } },
        });
        expect(valueOf(result)).toEqual({
            name: 'Renamed',
            expiresAt: 1_900_000_000_000,
            zdrPolicy: 'zdr',
            limits: { usd: { monthly: 20 }, requests: { daily: 300, weekly: null }, inputTokens: { daily: 0 } },
        });
    });

    it('accepts null to clear the expiry and the limits', () => {
        expect(valueOf(sanitizeKeyLimitsPatch({ expiresAt: null, limits: { usd: { daily: null } } }))).toEqual({
            expiresAt: null,
            limits: { usd: { daily: null } },
        });
    });

    it('cleans float noise out of USD amounts and refuses amounts finer than 0.0001', () => {
        const value = valueOf(sanitizeKeyLimitsPatch({ limits: { usd: { daily: 0.1 + 0.2, weekly: 1.2345 } } }));
        expect(value.limits?.usd).toEqual({ daily: 0.3, weekly: 1.2345 });
        const bad = issuesOf(sanitizeKeyLimitsPatch({ limits: { usd: { daily: 0.00004 } } }));
        expect(bad).toEqual([expect.objectContaining({ field: 'limits.usd.daily', code: 'step' })]);
    });

    it('enforces the API ranges per kind and period', () => {
        expect(KEY_LIMIT_RANGES.requests.max.daily).toBe(10_000_000);
        expect(valueOf(sanitizeKeyLimitsPatch({ limits: { requests: { daily: 10_000_000 } } }))).toBeTruthy();
        const cases: [Record<string, unknown>, string, string][] = [
            [{ requests: { daily: 10_000_001 } }, 'limits.requests.daily', 'range'],
            [{ requests: { weekly: 2_147_483_648 } }, 'limits.requests.weekly', 'range'],
            [{ usd: { monthly: 100_000.5 } }, 'limits.usd.monthly', 'range'],
            [{ inputTokens: { daily: -1 } }, 'limits.inputTokens.daily', 'range'],
            [{ inputTokens: { daily: 1.5 } }, 'limits.inputTokens.daily', 'integer'],
            [{ subscriptionInputTokens: { weekly: '5' } }, 'limits.subscriptionInputTokens.weekly', 'type'],
            [{ usd: { daily: Number.NaN } }, 'limits.usd.daily', 'type'],
            [{ usd: { yearly: 5 } }, 'limits.usd.yearly', 'unknown_field'],
            [{ tokens: { daily: 5 } }, 'limits.tokens', 'unknown_field'],
            [{ usd: 5 }, 'limits.usd', 'type'],
        ];
        for (const [limits, field, code] of cases) {
            expect(issuesOf(sanitizeKeyLimitsPatch({ limits })), field).toEqual([
                expect.objectContaining({ field, code }),
            ]);
        }
        expect(issuesOf(sanitizeKeyLimitsPatch({ limits: 'lots' }))).toEqual([
            expect.objectContaining({ field: 'limits', code: 'type' }),
        ]);
    });

    it('checks the name, the expiry and the policy', () => {
        const cases: [Record<string, unknown>, string, string][] = [
            [{ name: '   ' }, 'name', 'length'],
            [{ name: 'x'.repeat(121) }, 'name', 'length'],
            [{ name: 5 }, 'name', 'type'],
            [{ expiresAt: 'tomorrow' }, 'expiresAt', 'type'],
            [{ expiresAt: -1 }, 'expiresAt', 'type'],
            [{ expiresAt: 1e18 }, 'expiresAt', 'type'],
            [{ zdrPolicy: 'maybe' }, 'zdrPolicy', 'enum'],
        ];
        for (const [patch, field, code] of cases) {
            expect(issuesOf(sanitizeKeyLimitsPatch(patch)), field).toEqual([expect.objectContaining({ field, code })]);
        }
        expect(valueOf(sanitizeKeyLimitsPatch({ zdrPolicy: 'unset' }))).toEqual({ zdrPolicy: 'unset' });
    });

    it('refuses an empty change, unknown fields and a body that is not an object, but ignores a ManagedKey echoed back', () => {
        for (const raw of [{}, { limits: {} }, { limits: { usd: {} } }]) {
            expect(issuesOf(sanitizeKeyLimitsPatch(raw))).toEqual([
                expect.objectContaining({ field: 'body', code: 'empty' }),
            ]);
        }
        expect(issuesOf(sanitizeKeyLimitsPatch({ name: 'ok', nme: 'typo' }))).toEqual([
            expect.objectContaining({ field: 'nme', code: 'unknown_field' }),
        ]);
        for (const raw of [null, 'x', [], 5]) {
            expect(issuesOf(sanitizeKeyLimitsPatch(raw))).toEqual([
                expect.objectContaining({ field: 'body', code: 'type' }),
            ]);
        }
        expect(valueOf(sanitizeKeyLimitsPatch({ id: '1', status: 'active', createdAt: 5, name: 'Same' }))).toEqual({
            name: 'Same',
        });
    });

    it('converts a patch to the wire: snake_case, flat, ISO dates, null kept to clear', () => {
        const patch = valueOf(
            sanitizeKeyLimitsPatch({
                name: 'N',
                expiresAt: Date.parse('2027-05-05T00:00:00.000Z'),
                zdrPolicy: 'off',
                limits: {
                    usd: { monthly: 20, daily: null },
                    subscriptionInputTokens: { weekly: 5 },
                    requests: { daily: 3 },
                },
            }),
        );
        expect(keyPatchToWire(patch)).toEqual({
            name: 'N',
            expires_at: '2027-05-05T00:00:00.000Z',
            zdr_policy: 'off',
            monthly_usd_limit: 20,
            daily_usd_limit: null,
            weekly_subscription_input_token_limit: 5,
            daily_rpd_limit: 3,
        });
        expect(keyPatchToWire({ expiresAt: null })).toEqual({ expires_at: null });
        expect(keyPatchToWire({})).toEqual({});
    });
});

describe('sanitizeKeyCreateInput', () => {
    it('needs a name and takes the rest like the patch', () => {
        const input = valueOf(
            sanitizeKeyCreateInput({
                name: ' Capped ',
                zdrPolicy: 'zdr',
                expiresAt: null,
                limits: { usd: { daily: 2 } },
            }),
        );
        expect(input).toEqual({ name: 'Capped', zdrPolicy: 'zdr', expiresAt: null, limits: { usd: { daily: 2 } } });
        expect(keyCreateToWire(input)).toEqual({
            name: 'Capped',
            zdr_policy: 'zdr',
            expires_at: null,
            daily_usd_limit: 2,
        });
        expect(keyCreateToWire({ name: 'Plain', expiresAt: Date.parse('2027-01-01T00:00:00Z') })).toEqual({
            name: 'Plain',
            expires_at: '2027-01-01T00:00:00.000Z',
        });
        expect(keyCreateToWire({ name: 'Bare' })).toEqual({ name: 'Bare' });
    });

    it('refuses a missing name, `unset`, unknown fields, bad limits and a non-object', () => {
        expect(issuesOf(sanitizeKeyCreateInput({}))).toEqual([
            expect.objectContaining({ field: 'name', code: 'required' }),
        ]);
        expect(issuesOf(sanitizeKeyCreateInput({ name: 'a', zdrPolicy: 'unset' }))).toEqual([
            expect.objectContaining({ field: 'zdrPolicy', code: 'enum' }),
        ]);
        expect(issuesOf(sanitizeKeyCreateInput({ name: 'a', status: 'active' }))).toEqual([
            expect.objectContaining({ field: 'status', code: 'unknown_field' }),
        ]);
        expect(issuesOf(sanitizeKeyCreateInput({ name: 'a', limits: { usd: { daily: -1 } } }))).toHaveLength(1);
        expect(issuesOf(sanitizeKeyCreateInput({ name: 'a', expiresAt: 'x' }))).toHaveLength(1);
        expect(issuesOf(sanitizeKeyCreateInput('x'))).toEqual([
            expect.objectContaining({ field: 'body', code: 'type' }),
        ]);
    });
});

describe('ids and names', () => {
    it('accepts numeric key ids only', () => {
        expect(checkKeyId('12')).toBe('12');
        for (const raw of ['0', '01', '-1', '1.5', '', 'abc', '1 2', 12, null, '1'.repeat(19)])
            expect(checkKeyId(raw)).toBeNull();
    });

    it('accepts preset names of the API and lower-cases them', () => {
        expect(checkPresetName('RP-Fast_2')).toBe('rp-fast_2');
        expect(checkPresetName('a'.repeat(80))).toBe('a'.repeat(80));
        for (const raw of ['', '-start', '_start', 'has space', 'a/b', 'a\\b', 'dot.name', 'a'.repeat(81), 5, null]) {
            expect(checkPresetName(raw)).toBeNull();
        }
    });
});

describe('sanitizePresetInput', () => {
    it('fills every setting that was left out with null', () => {
        const preset = valueOf(sanitizePresetInput({ model: ' z-ai/glm-5.3 ' }));
        expect(preset.model).toBe('z-ai/glm-5.3');
        expect(Object.values({ ...preset, model: null }).every((v) => v === null)).toBe(true);
        expect(presetToWire(preset)).toEqual({ model: 'z-ai/glm-5.3' });
    });

    it('round-trips through the wire and the normaliser', () => {
        const input = {
            model: 'deepseek/deepseek-v4.1-flash',
            systemPrompt: 'You narrate.',
            maxTokens: 1200,
            topK: 40,
            temperature: 0.9,
            topP: 0.95,
            minP: 0.05,
            topA: 0,
            frequencyPenalty: 0.1,
            presencePenalty: -0.1,
            repetitionPenalty: 1.05,
            responseFormat: 'json_object',
            structuredOutputs: true,
            reasoningEffort: 'high',
            reasoningSummary: 'concise',
            verbosity: 'low',
            routing: 'speed',
            serviceTier: 'default',
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '1h' },
        };
        const checkedInput = valueOf(sanitizePresetInput(input));
        expect(checkedInput).toEqual(input);
        const wire = presetToWire(checkedInput);
        expect(wire).toMatchObject({
            system_prompt: 'You narrate.',
            provider_routing_preference: 'speed',
            thinking: { type: 'enabled', budget_tokens: 4000 },
            prompt_caching: { enabled: true, ttl: '1h' },
            top_a: 0,
        });
        expect(normalizeModelPreset({ name: 'x', ...wire })).toEqual({
            ...input,
            name: 'x',
            createdAt: null,
            updatedAt: null,
        });
    });

    it('writes thinking and prompt_caching in their shortest wire form', () => {
        const base = valueOf(sanitizePresetInput({ model: 'm' }));
        expect(presetToWire({ ...base, thinking: { enabled: true, budgetTokens: null } })['thinking']).toBe(true);
        expect(presetToWire({ ...base, thinking: { enabled: false, budgetTokens: null } })['thinking']).toBe(false);
        expect(presetToWire({ ...base, promptCaching: { enabled: false, ttl: null } })['prompt_caching']).toBe(false);
        expect(presetToWire({ ...base, promptCaching: { enabled: true, ttl: '5m' } })['prompt_caching']).toEqual({
            enabled: true,
            ttl: '5m',
        });
    });

    it('checks the model', () => {
        expect(issuesOf(sanitizePresetInput({}))).toEqual([
            expect.objectContaining({ field: 'model', code: 'required' }),
        ]);
        expect(issuesOf(sanitizePresetInput({ model: null }))).toEqual([expect.objectContaining({ code: 'required' })]);
        expect(issuesOf(sanitizePresetInput({ model: 5 }))).toEqual([expect.objectContaining({ code: 'type' })]);
        expect(issuesOf(sanitizePresetInput({ model: '  ' }))).toEqual([expect.objectContaining({ code: 'length' })]);
        expect(issuesOf(sanitizePresetInput({ model: 'm'.repeat(257) }))).toEqual([
            expect.objectContaining({ code: 'length' }),
        ]);
    });

    it('enforces the numeric ranges, whole numbers and enums of the API', () => {
        const cases: [Record<string, unknown>, string, string][] = [
            [{ maxTokens: 0 }, 'maxTokens', 'range'],
            [{ maxTokens: 1.5 }, 'maxTokens', 'integer'],
            [{ topK: -1 }, 'topK', 'range'],
            [{ temperature: 2.1 }, 'temperature', 'range'],
            [{ temperature: '0.5' }, 'temperature', 'type'],
            [{ topP: 1.1 }, 'topP', 'range'],
            [{ minP: -0.1 }, 'minP', 'range'],
            [{ topA: 2 }, 'topA', 'range'],
            [{ frequencyPenalty: -2.5 }, 'frequencyPenalty', 'range'],
            [{ presencePenalty: 3 }, 'presencePenalty', 'range'],
            [{ repetitionPenalty: Number.POSITIVE_INFINITY }, 'repetitionPenalty', 'type'],
            [{ responseFormat: 'xml' }, 'responseFormat', 'enum'],
            [{ reasoningEffort: 'ultra' }, 'reasoningEffort', 'enum'],
            [{ reasoningSummary: 5 }, 'reasoningSummary', 'enum'],
            [{ verbosity: 'LOW' }, 'verbosity', 'enum'],
            [{ routing: 'cheapest' }, 'routing', 'enum'],
            [{ serviceTier: 'turbo' }, 'serviceTier', 'enum'],
            [{ structuredOutputs: 'yes' }, 'structuredOutputs', 'type'],
            [{ systemPrompt: 5 }, 'systemPrompt', 'type'],
            [{ systemPrompt: 'x'.repeat(PRESET_PROMPT_MAX_LENGTH + 1) }, 'systemPrompt', 'length'],
            [{ thinking: 'on' }, 'thinking', 'type'],
            [{ thinking: { enabled: true, budgetTokens: 0 } }, 'thinking.budgetTokens', 'range'],
            [{ thinking: { enabled: true, budgetTokens: 1.5 } }, 'thinking.budgetTokens', 'range'],
            [{ thinking: { enabled: true, budgetTokens: 1_000_001 } }, 'thinking.budgetTokens', 'range'],
            [{ thinking: { enabled: false, budgetTokens: 500 } }, 'thinking.budgetTokens', 'conflict'],
            [{ promptCaching: true }, 'promptCaching', 'type'],
            [{ promptCaching: { enabled: true, ttl: '1d' } }, 'promptCaching.ttl', 'enum'],
            [{ promptCaching: { enabled: true, ttl: 5 } }, 'promptCaching.ttl', 'enum'],
        ];
        for (const [extra, field, code] of cases) {
            expect(issuesOf(sanitizePresetInput({ model: 'm', ...extra })), field).toEqual([
                expect.objectContaining({ field, code }),
            ]);
        }
        // the edges are fine
        const edges = valueOf(
            sanitizePresetInput({
                model: 'm',
                maxTokens: 1_000_000,
                topK: 0,
                temperature: 2,
                topP: 0,
                frequencyPenalty: -2,
                repetitionPenalty: 2,
                systemPrompt: 'x'.repeat(PRESET_PROMPT_MAX_LENGTH),
                thinking: { enabled: true, budgetTokens: 1_000_000 },
            }),
        );
        expect(edges.maxTokens).toBe(1_000_000);
    });

    it('treats null like "not set" for every setting', () => {
        const nulls = Object.fromEntries(
            Object.keys(valueOf(sanitizePresetInput({ model: 'm' })))
                .filter((key) => key !== 'model')
                .map((key) => [key, null]),
        );
        expect(valueOf(sanitizePresetInput({ model: 'm', ...nulls }))).toEqual(
            valueOf(sanitizePresetInput({ model: 'm' })),
        );
    });

    it('checks the rules that cross fields', () => {
        expect(issuesOf(sanitizePresetInput({ model: 'm', structuredOutputs: true }))).toEqual([
            expect.objectContaining({ field: 'structuredOutputs', code: 'conflict' }),
        ]);
        expect(
            valueOf(sanitizePresetInput({ model: 'm', structuredOutputs: true, responseFormat: 'json_object' })),
        ).toBeTruthy();
        expect(valueOf(sanitizePresetInput({ model: 'm', structuredOutputs: false }))).toBeTruthy();
        for (const routing of ['speed', 'throughput', 'latency', 'price']) {
            expect(issuesOf(sanitizePresetInput({ model: 'm', serviceTier: 'flex', routing }))).toEqual([
                expect.objectContaining({ field: 'serviceTier', code: 'conflict' }),
            ]);
            expect(issuesOf(sanitizePresetInput({ model: 'm', serviceTier: 'priority', routing }))).toHaveLength(1);
        }
        expect(valueOf(sanitizePresetInput({ model: 'm', serviceTier: 'flex', routing: 'auto' }))).toBeTruthy();
        expect(valueOf(sanitizePresetInput({ model: 'm', serviceTier: 'flex', routing: 'caching' }))).toBeTruthy();
        expect(valueOf(sanitizePresetInput({ model: 'm', serviceTier: 'default', routing: 'speed' }))).toBeTruthy();
    });

    it('refuses unknown fields but ignores the read-only ones of a ModelPreset', () => {
        expect(issuesOf(sanitizePresetInput({ model: 'm', provider: { only: ['a'] } }))).toEqual([
            expect.objectContaining({ field: 'provider', code: 'unknown_field' }),
        ]);
        expect(issuesOf(sanitizePresetInput({ model: 'm', temprature: 1 }))).toHaveLength(1);
        expect(
            valueOf(sanitizePresetInput({ model: 'm', name: 'x', createdAt: 1, updatedAt: 2, temperature: 1 }))
                .temperature,
        ).toBe(1);
        for (const raw of [null, 'x', [], 3]) {
            expect(issuesOf(sanitizePresetInput(raw))).toEqual([
                expect.objectContaining({ field: 'body', code: 'type' }),
            ]);
        }
    });

    it('refuses a body above the 16 KiB limit', () => {
        // 6,000 characters of 3-byte text are 18,000 bytes in the body: over the limit, though under the character cap.
        const heavy = issuesOf(sanitizePresetInput({ model: 'm', systemPrompt: '€'.repeat(6000) }));
        expect(heavy).toEqual([expect.objectContaining({ field: 'body', code: 'too_large' })]);
        const fits = valueOf(sanitizePresetInput({ model: 'm', systemPrompt: 'a'.repeat(PRESET_PROMPT_MAX_LENGTH) }));
        expect(new TextEncoder().encode(JSON.stringify(presetToWire(fits))).length).toBeLessThanOrEqual(
            PRESET_BODY_LIMIT_BYTES,
        );
    });
});

describe('describeIssues', () => {
    it('lists field and message, at most five', () => {
        const issue = (n: number): InputIssue => ({ field: `f${n}`, code: 'type', message: 'bad' });
        expect(describeIssues([issue(1), issue(2)])).toBe('f1: bad; f2: bad');
        expect(describeIssues([1, 2, 3, 4, 5, 6, 7].map(issue))).toBe(
            'f1: bad; f2: bad; f3: bad; f4: bad; f5: bad; and 2 more',
        );
    });
});
