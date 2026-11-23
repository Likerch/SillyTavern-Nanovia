import { describe, expect, it } from 'vitest';
import { sanitizePresetInput } from '../../src/domain/mgmt';
import {
    PRESET_NUMBER_RULES,
    buildPreset,
    duplicatePresetForm,
    emptyPresetForm,
    numberRule,
    presetCreateInput,
    presetFormFromConnection,
    presetFormFromPreset,
    slugifyPresetName,
    uniquePresetName,
} from '../../src/features/mgmt/preset-form-model';
import type { PresetFormState } from '../../src/features/mgmt/preset-form-model';
import type { ModelPreset } from '../../src/shared/contracts-mgmt';
import { blankPreset } from '../helpers/mgmt-fake';
import { makeConnection } from '../helpers/plan-fixtures';

function filled(patch: Partial<PresetFormState> = {}): PresetFormState {
    return { ...emptyPresetForm(), name: 'rp-fast', model: 'vendor/model', ...patch };
}

describe('the numeric rules', () => {
    it('match what the plugin accepts: the ends are valid, one step outside is not', () => {
        for (const rule of PRESET_NUMBER_RULES) {
            const base = { model: 'vendor/model' };
            expect(sanitizePresetInput({ ...base, [rule.key]: rule.min }).ok, `${rule.key} min`).toBe(true);
            expect(sanitizePresetInput({ ...base, [rule.key]: rule.max }).ok, `${rule.key} max`).toBe(true);
            const step = rule.integer ? 1 : 0.5;
            expect(sanitizePresetInput({ ...base, [rule.key]: rule.min - step }).ok, `${rule.key} below`).toBe(false);
            expect(sanitizePresetInput({ ...base, [rule.key]: rule.max + step }).ok, `${rule.key} above`).toBe(false);
            if (rule.integer)
                expect(sanitizePresetInput({ ...base, [rule.key]: rule.min + 0.5 }).ok, `${rule.key} fraction`).toBe(
                    false,
                );
            else
                expect(sanitizePresetInput({ ...base, [rule.key]: rule.min + 0.25 }).ok, `${rule.key} fraction`).toBe(
                    true,
                );
        }
    });

    it('covers every numeric setting of a preset once', () => {
        const keys = PRESET_NUMBER_RULES.map((rule) => rule.key).sort();
        expect(keys).toEqual(
            [
                'frequencyPenalty',
                'maxTokens',
                'minP',
                'presencePenalty',
                'repetitionPenalty',
                'temperature',
                'topA',
                'topK',
                'topP',
            ].sort(),
        );
        expect(numberRule('temperature')).toMatchObject({ min: 0, max: 2, integer: false });
        expect(() => numberRule('nope' as never)).toThrow();
    });
});

describe('names', () => {
    it('slugifies free text into a valid name', () => {
        expect(slugifyPresetName('My RP · Chat!')).toBe('my-rp-chat');
        expect(slugifyPresetName('  --Hello__World  ')).toBe('hello__world');
        expect(slugifyPresetName('Привет')).toBe('preset');
        expect(slugifyPresetName('')).toBe('preset');
        expect(slugifyPresetName('a'.repeat(120))).toHaveLength(80);
        expect(slugifyPresetName('DeepSeek V4.1')).toBe('deepseek-v4-1');
    });

    it('finds a free name by numbering, within 80 characters', () => {
        expect(uniquePresetName('rp', [])).toBe('rp');
        expect(uniquePresetName('RP', ['rp'])).toBe('rp-2');
        expect(uniquePresetName('rp', ['rp', 'rp-2', 'rp-3'])).toBe('rp-4');
        expect(uniquePresetName('Chat', ['CHAT'])).toBe('chat-2');
        const long = 'a'.repeat(80);
        const next = uniquePresetName(long, [long]);
        expect(next).toHaveLength(80);
        expect(next.endsWith('-2')).toBe(true);
    });
});

describe('presetFormFromPreset', () => {
    it('keeps every setting, so a save cannot drop one', () => {
        const preset: ModelPreset = {
            ...blankPreset('rp-fast', 'vendor/model'),
            systemPrompt: 'Be brief.',
            maxTokens: 1500,
            topK: 40,
            temperature: 0.8,
            topP: 0.95,
            minP: 0.05,
            topA: 0.1,
            frequencyPenalty: -0.5,
            presencePenalty: 0.25,
            repetitionPenalty: 1.1,
            responseFormat: 'json_object',
            structuredOutputs: true,
            reasoningEffort: 'high',
            reasoningSummary: 'concise',
            verbosity: 'low',
            routing: 'price',
            serviceTier: 'default',
            thinking: { enabled: true, budgetTokens: 8000 },
            promptCaching: { enabled: true, ttl: '1h' },
        };
        const form = presetFormFromPreset(preset);
        const built = buildPreset(form, { checkName: false });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        // Everything but the name and the times (which are not settings) comes back out.
        const settings: Record<string, unknown> = { ...preset };
        for (const key of ['createdAt', 'updatedAt', 'name']) delete settings[key];
        expect(built.input).toEqual(settings);
    });

    it('an empty preset becomes an empty form, and back', () => {
        const form = presetFormFromPreset(blankPreset('a', 'm/x'));
        expect(form).toEqual({ ...emptyPresetForm(), name: 'a', model: 'm/x' });
        const built = buildPreset(form, { checkName: true });
        expect(built).toMatchObject({
            ok: true,
            name: 'a',
            input: { model: 'm/x', temperature: null, thinking: null },
        });
    });

    it('thinking that is off and caching that is off survive the round trip', () => {
        const preset: ModelPreset = {
            ...blankPreset('a'),
            thinking: { enabled: false, budgetTokens: null },
            promptCaching: { enabled: false, ttl: '5m' },
        };
        const built = buildPreset(presetFormFromPreset(preset), { checkName: false });
        expect(built.ok && built.input.thinking).toEqual({ enabled: false, budgetTokens: null });
        expect(built.ok && built.input.promptCaching).toEqual({ enabled: false, ttl: '5m' });
    });
});

describe('buildPreset', () => {
    it('turns a filled form into the input the plugin takes, empty fields as null', () => {
        const form = filled({
            systemPrompt: 'Be brief.',
            numbers: { ...emptyPresetForm().numbers, temperature: '0,7', maxTokens: '1 000' },
            routing: 'speed',
            thinking: 'on',
            thinkingBudget: '4000',
            promptCaching: 'on',
            cacheTtl: '5m',
        });
        const built = buildPreset(form, { checkName: true });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.name).toBe('rp-fast');
        expect(built.input).toMatchObject({
            model: 'vendor/model',
            systemPrompt: 'Be brief.',
            temperature: 0.7,
            maxTokens: 1000,
            topK: null,
            routing: 'speed',
            thinking: { enabled: true, budgetTokens: 4000 },
            promptCaching: { enabled: true, ttl: '5m' },
        });
        expect(presetCreateInput(built.name, built.input)).toMatchObject({ name: 'rp-fast', model: 'vendor/model' });
    });

    it('lower-cases the name as the API keeps it, and checks its pattern on create only', () => {
        expect(buildPreset(filled({ name: 'RP-Fast' }), { checkName: true })).toMatchObject({
            ok: true,
            name: 'rp-fast',
        });
        for (const bad of ['', '-x', 'a b', 'ä', 'x'.repeat(81)]) {
            const built = buildPreset(filled({ name: bad }), { checkName: true });
            expect(built, bad).toEqual({ ok: false, issues: [{ field: 'name', code: 'format' }] });
        }
        // An existing preset's name is not edited: it is not checked again.
        expect(buildPreset(filled({ name: 'whatever it was' }), { checkName: false }).ok).toBe(true);
    });

    it('an unreadable number is an issue at its field', () => {
        const form = filled({ numbers: { ...emptyPresetForm().numbers, temperature: 'warm', topK: '1e3' } });
        const built = buildPreset(form, { checkName: true });
        expect(built).toEqual({
            ok: false,
            issues: [
                { field: 'topK', code: 'number' },
                { field: 'temperature', code: 'number' },
            ],
        });
    });

    it('maps the plugin’s refusals to form fields, with ranges', () => {
        const form = filled({
            model: '',
            numbers: { ...emptyPresetForm().numbers, temperature: '5', maxTokens: '0', topK: '1.5' },
            thinking: 'on',
            thinkingBudget: '0',
        });
        const built = buildPreset(form, { checkName: true });
        expect(built.ok).toBe(false);
        if (built.ok) return;
        const byField = Object.fromEntries(built.issues.map((issue) => [issue.field, issue]));
        expect(byField['model']).toMatchObject({ code: 'length', params: { max: 256 } });
        expect(byField['temperature']).toEqual({ field: 'temperature', code: 'range', params: { min: 0, max: 2 } });
        expect(byField['maxTokens']).toMatchObject({ code: 'range', params: { min: 1, max: 1_000_000 } });
        expect(byField['topK']).toMatchObject({ code: 'integer' });
        expect(byField['thinkingBudget']).toMatchObject({ code: 'range', params: { min: 1, max: 1_000_000 } });
    });

    it('catches the combinations the API refuses', () => {
        const structured = buildPreset(filled({ structuredOutputs: 'on' }), { checkName: true });
        expect(structured).toMatchObject({ ok: false, issues: [{ field: 'structuredOutputs', code: 'conflict' }] });
        expect(
            buildPreset(filled({ structuredOutputs: 'on', responseFormat: 'json_object' }), { checkName: true }).ok,
        ).toBe(true);
        expect(buildPreset(filled({ structuredOutputs: 'off' }), { checkName: true }).ok).toBe(true);

        const tier = buildPreset(filled({ serviceTier: 'flex', routing: 'price' }), { checkName: true });
        expect(tier).toMatchObject({ ok: false, issues: [{ field: 'serviceTier', code: 'conflict' }] });
        expect(buildPreset(filled({ serviceTier: 'flex', routing: 'caching' }), { checkName: true }).ok).toBe(true);
        expect(buildPreset(filled({ serviceTier: 'ultrafast', routing: 'price' }), { checkName: true }).ok).toBe(true);
    });

    it('a budget left in the field of thinking that is not on is not sent', () => {
        const off = buildPreset(filled({ thinking: 'off', thinkingBudget: '999' }), { checkName: true });
        expect(off.ok && off.input.thinking).toEqual({ enabled: false, budgetTokens: null });
        const unset = buildPreset(filled({ thinking: '', thinkingBudget: '999' }), { checkName: true });
        expect(unset.ok && unset.input.thinking).toBeNull();
        const bad = buildPreset(filled({ thinking: 'on', thinkingBudget: 'lots' }), { checkName: true });
        expect(bad).toMatchObject({ ok: false, issues: [{ field: 'thinkingBudget', code: 'number' }] });
        const open = buildPreset(filled({ thinking: 'on', thinkingBudget: '' }), { checkName: true });
        expect(open.ok && open.input.thinking).toEqual({ enabled: true, budgetTokens: null });
    });

    it('refuses a system prompt that is too long, and a body that is too large', () => {
        const long = buildPreset(filled({ systemPrompt: 'x'.repeat(12_001) }), { checkName: true });
        expect(long).toMatchObject({
            ok: false,
            issues: [{ field: 'systemPrompt', code: 'length', params: { max: 12_000 } }],
        });
        // 12 000 characters fit; with a long model id and routing fields the 16 KiB body still holds.
        expect(buildPreset(filled({ systemPrompt: 'x'.repeat(12_000) }), { checkName: true }).ok).toBe(true);
        // Multi-byte text can push the body over 16 KiB while the character count is fine.
        const wide = buildPreset(filled({ systemPrompt: 'я'.repeat(12_000) }), { checkName: true });
        expect(wide).toMatchObject({ ok: false, issues: [{ field: 'body', code: 'too_large' }] });
    });
});

describe('presets from other things', () => {
    it('a duplicate is the same settings under a free name', () => {
        const preset: ModelPreset = { ...blankPreset('rp', 'm/x'), temperature: 0.4 };
        const copy = duplicatePresetForm(preset, ['rp']);
        expect(copy.name).toBe('rp-copy');
        expect(copy.model).toBe('m/x');
        expect(copy.numbers.temperature).toBe('0.4');
        expect(duplicatePresetForm(preset, ['rp', 'rp-copy']).name).toBe('rp-copy-2');
    });

    it('takes the model, the ranking sort and a fixed reasoning effort from a connection', () => {
        const connection = makeConnection({
            name: 'Main chat',
            modelId: 'deepseek/deepseek-v4',
            routing: { enabled: true, sort: 'price' },
            reasoning: { policy: 'fixed', effort: 'high', hideThoughts: false },
        });
        const { form, droppedRouting } = presetFormFromConnection(connection, ['other']);
        expect(form).toMatchObject({
            name: 'main-chat',
            model: 'deepseek/deepseek-v4',
            routing: 'price',
            reasoningEffort: 'high',
            systemPrompt: '',
        });
        expect(droppedRouting).toBe(false);
        // Nothing else of the connection leaks into the preset.
        expect(form.numbers).toEqual(emptyPresetForm().numbers);
        expect(form.thinking).toBe('');
    });

    it('the caching route stands in for a default sort, and routing that is off carries nothing', () => {
        const caching = makeConnection({ routing: { enabled: true, sort: 'default', cachingRoute: true } });
        expect(presetFormFromConnection(caching, []).form.routing).toBe('caching');
        const sorted = makeConnection({ routing: { enabled: true, sort: 'speed', cachingRoute: true } });
        expect(presetFormFromConnection(sorted, []).form.routing).toBe('speed');
        const plain = makeConnection({ routing: { enabled: true, sort: 'default', cachingRoute: false } });
        expect(presetFormFromConnection(plain, []).form.routing).toBe('');
        const off = makeConnection({ routing: { enabled: false, sort: 'price', cachingRoute: true } });
        expect(presetFormFromConnection(off, []).form.routing).toBe('');
    });

    it('reasoning: off becomes none; follow and default carry nothing', () => {
        const effort = (policy: 'off' | 'follow' | 'default' | 'fixed', e: 'low' | null = null): string =>
            presetFormFromConnection(makeConnection({ reasoning: { policy, effort: e, hideThoughts: false } }), []).form
                .reasoningEffort;
        expect(effort('off')).toBe('none');
        expect(effort('follow')).toBe('');
        expect(effort('default')).toBe('');
        expect(effort('fixed', 'low')).toBe('low');
        expect(effort('fixed', null)).toBe('');
    });

    it('says when the connection had routing a preset cannot hold, and picks a free name', () => {
        const heavy = makeConnection({
            name: 'Heavy',
            routing: {
                enabled: true,
                order: ['alpha'],
                quantizations: ['fp8'],
                maxPrice: { prompt: 1, completion: null },
            },
        });
        const result = presetFormFromConnection(heavy, ['heavy']);
        expect(result.droppedRouting).toBe(true);
        expect(result.form.name).toBe('heavy-2');
        // Routing that is switched off has nothing to drop.
        const off = makeConnection({ routing: { enabled: false, order: ['alpha'] } });
        expect(presetFormFromConnection(off, []).droppedRouting).toBe(false);
    });
});
