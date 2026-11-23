import { describe, expect, it } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import type { MgmtDetail, MgmtState } from '../../src/core/mgmt';
import type { MgmtError } from '../../src/host';
import {
    agoText,
    endOfDayUtc,
    formatDate,
    formatLimit,
    groupDigits,
    numberText,
    parseNumberText,
} from '../../src/features/mgmt/format';
import { MGMT_STRINGS } from '../../src/features/mgmt/strings';
import {
    SCOPE_GUIDE,
    actionsEnabled,
    bannerFor,
    errorText,
    gateFor,
    isBlocked,
    isFutureDate,
    issueText,
    keyCard,
    limitLines,
    offersSaveAnyway,
    presetCard,
    presetChips,
    secretLabel,
    tokenView,
} from '../../src/features/mgmt/view-model';
import type { ManagedKey, ModelPreset, MgmtStatus } from '../../src/shared/contracts-mgmt';
import { blankPreset, emptyKeyLimits } from '../helpers/mgmt-fake';

const i18n = createI18n(() => 'en');
i18n.register(MGMT_STRINGS);
const t = i18n.t.bind(i18n);

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const NBSP = String.fromCharCode(0xa0);

function detail(state: MgmtState, patch: Partial<MgmtDetail> = {}): MgmtDetail {
    const list = { items: null, fetchedAt: null, loading: false, error: null };
    return { state, status: null, error: null, fetching: false, keys: list, presets: list, ...patch };
}

function error(kind: MgmtError['kind'], patch: Partial<MgmtError> = {}): MgmtError {
    return { kind, code: kind, message: 'message', status: null, ...patch };
}

describe('format', () => {
    it('writes UTC dates and finds the end of a day', () => {
        expect(formatDate(Date.UTC(2027, 0, 5, 23, 59))).toBe('2027-01-05');
        expect(endOfDayUtc('2027-01-05')).toBe(Date.UTC(2027, 0, 5, 23, 59, 59, 999));
        expect(endOfDayUtc(' 2027-01-05 ')).toBe(Date.UTC(2027, 0, 5, 23, 59, 59, 999));
        for (const bad of ['', 'soon', '2027-1-5', '2027-02-31', '2027-13-01', '2027-00-10']) {
            expect(endOfDayUtc(bad), bad).toBeNull();
        }
    });

    it('groups digits with non-breaking spaces and formats limits per kind', () => {
        expect(groupDigits(950)).toBe('950');
        expect(groupDigits(1500000)).toBe(`1${NBSP}500${NBSP}000`);
        expect(groupDigits(-2)).toBe('-2');
        expect(groupDigits(0.5)).toBe('0.5');
        expect(formatLimit('usd', 5)).toBe('$5');
        expect(formatLimit('usd', 0.0025)).toBe('$0.0025');
        expect(formatLimit('usd', 0)).toBe('$0');
        expect(formatLimit('requests', 10000000)).toBe(`10${NBSP}000${NBSP}000`);
    });

    it('reads what was typed into a number field', () => {
        expect(parseNumberText('')).toBeNull();
        expect(parseNumberText('   ')).toBeNull();
        expect(parseNumberText('12')).toBe(12);
        expect(parseNumberText(' 0,5 ')).toBe(0.5);
        expect(parseNumberText(`1${NBSP}500`)).toBe(1500);
        expect(parseNumberText('1 500')).toBe(1500);
        expect(parseNumberText('-2')).toBe(-2);
        for (const bad of ['abc', '1e3', '1.2.3', '5%', '--1', '.5', '5.']) {
            expect(parseNumberText(bad), bad).toBeUndefined();
        }
    });

    it('shows a number back without float noise', () => {
        expect(numberText(null)).toBe('');
        expect(numberText(1500000)).toBe('1500000');
        expect(numberText(0.0001)).toBe('0.0001');
        expect(numberText(0.30000000000000004)).toBe('0.3');
        expect(numberText(0)).toBe('0');
    });

    it('says how long ago', () => {
        expect(agoText(NOW - 5_000, NOW, t)).toBe('just now');
        expect(agoText(NOW - 5 * 60_000, NOW, t)).toBe('5 min ago');
        expect(agoText(NOW - 3 * 3_600_000, NOW, t)).toBe('3 h ago');
        expect(agoText(NOW - 2 * 86_400_000, NOW, t)).toBe('2 d ago');
        expect(agoText(NOW + 5_000, NOW, t)).toBe('just now');
    });
});

describe('tokenView', () => {
    const status = (patch: Partial<MgmtStatus>): MgmtStatus => ({
        present: true,
        valid: true,
        checkedAt: NOW - 120_000,
        error: null,
        ...patch,
    });

    it('absent', () => {
        for (const state of [null, { present: false, valid: null, checkedAt: null, error: null }] as const) {
            const view = tokenView(detail('no_token', { status: state }), NOW, t);
            expect(view).toMatchObject({ id: 'absent', checked: null, problem: null });
            expect(view.chip).toMatchObject({ label: 'No token', kind: 'muted' });
        }
    });

    it('valid, with the time of the check', () => {
        const view = tokenView(detail('ready', { status: status({}) }), NOW, t);
        expect(view).toMatchObject({ id: 'valid', checked: 'Checked 2 min ago', problem: null });
        expect(view.chip.kind).toBe('ok');
    });

    it('invalid explains itself', () => {
        const view = tokenView(
            detail('token_invalid', { status: status({ valid: false, error: 'mgmt_token_invalid' }) }),
            NOW,
            t,
        );
        expect(view.id).toBe('invalid');
        expect(view.chip.kind).toBe('error');
        expect(view.problem).toContain('revoked');
        expect(view.problem).toContain('90 days');
    });

    it('unknown says why NanoGPT could not confirm it', () => {
        const view = tokenView(
            detail('ready', { status: status({ valid: null, error: 'upstream_unreachable', checkedAt: null }) }),
            NOW,
            t,
        );
        expect(view).toMatchObject({ id: 'unknown', checked: null });
        expect(view.chip.kind).toBe('warn');
        expect(view.problem).toContain('could not reach NanoGPT');
        const quiet = tokenView(detail('ready', { status: status({ valid: null, error: null }) }), NOW, t);
        expect(quiet.problem).toBeNull();
    });
});

describe('save anyway', () => {
    it('is offered for trouble reaching NanoGPT or a rate limit, never for a refusal', () => {
        expect(offersSaveAnyway(error('upstream'))).toBe(true);
        expect(offersSaveAnyway(error('rate_limited'))).toBe(true);
        for (const kind of [
            'token_invalid',
            'token_malformed',
            'invalid_request',
            'plugin_down',
            'scope_missing',
        ] as const) {
            expect(offersSaveAnyway(error(kind)), kind).toBe(false);
        }
    });
});

describe('states', () => {
    it('actions work unless the plugin is out of reach', () => {
        for (const state of ['idle', 'no_token', 'token_invalid', 'ready'] as const)
            expect(actionsEnabled(state), state).toBe(true);
        for (const state of ['needs_plugin', 'plugin_outdated', 'plugin_down', 'error'] as const) {
            expect(actionsEnabled(state), state).toBe(false);
        }
    });

    it('banners for the states where the tab cannot work', () => {
        expect(bannerFor(detail('ready'), t)).toBeNull();
        expect(bannerFor(detail('no_token'), t)).toBeNull();
        expect(bannerFor(detail('needs_plugin'), t)?.text).toContain('Nanovia server plugin');
        expect(bannerFor(detail('plugin_outdated'), t)?.text).toContain('does not know the Management routes');
        const down = bannerFor(detail('plugin_down', { error: error('plugin_down') }), t);
        expect(down).toMatchObject({ kind: 'error' });
        expect(down?.text).toContain('not answering');
        const failed = bannerFor(detail('error', { error: error('other', { message: 'disk full' }) }), t);
        expect(failed?.text).toContain('disk full');
    });

    it('a section opens only for a token NanoGPT has not rejected', () => {
        expect(gateFor('ready', t)).toEqual({ open: true, text: null });
        expect(gateFor('no_token', t).text).toContain('Add a Management token');
        expect(gateFor('token_invalid', t).text).toContain('rejected');
        expect(gateFor('idle', t).open).toBe(false);
        for (const state of ['needs_plugin', 'plugin_outdated', 'plugin_down', 'error'] as const) {
            expect(gateFor(state, t)).toMatchObject({ open: false });
            expect(gateFor(state, t).text).toContain('plugin');
        }
    });
});

describe('errorText', () => {
    it('names the scope that is missing', () => {
        expect(errorText(error('scope_missing', { scope: 'api_keys:write' }), t)).toContain('api_keys:write');
        expect(errorText(error('scope_missing'), t)).toContain('lacks a scope');
    });

    it('says a rate limit, a taken name and the preset limit in words', () => {
        expect(errorText(error('rate_limited'), t)).toContain('limiting how often');
        expect(errorText(error('preset_exists'), t)).toContain('already exists');
        expect(errorText(error('conflict', { code: 'preset_limit_reached' }), t)).toContain('at most 100');
        expect(errorText(error('conflict', { code: 'idempotency_key_reused' }), t)).toContain('idempotency_key_reused');
    });

    it('keeps the detail of an invalid request, and only the detail', () => {
        const text = errorText(
            error('invalid_request', { message: 'NanoGPT refused the request: limits.usd.daily: must be a number' }),
            t,
        );
        expect(text).toContain('limits.usd.daily: must be a number');
        expect(text).not.toContain('NanoGPT refused the request');
    });

    it('has a text for every kind, none of them the bare key', () => {
        const kinds: MgmtError['kind'][] = [
            'plugin_down',
            'not_installed',
            'forbidden',
            'token_missing',
            'token_invalid',
            'scope_missing',
            'token_malformed',
            'rate_limited',
            'invalid_request',
            'not_found',
            'preset_exists',
            'conflict',
            'too_large',
            'secrets_unavailable',
            'secrets_failed',
            'upstream',
            'invalid_response',
            'other',
        ];
        for (const kind of kinds) {
            const text = errorText(error(kind), t);
            expect(text, kind).not.toMatch(/^mgmt\./);
            expect(text.length, kind).toBeGreaterThan(10);
        }
        expect(errorText(error('upstream', { code: 'upstream_timeout' }), t)).toContain('in time');
    });
});

describe('issueText', () => {
    it('words each code, with the range of a limit', () => {
        expect(issueText({ field: 'limits.usd.daily', code: 'range', params: { min: 0, max: 100000 } }, t)).toBe(
            `Must be between 0 and 100${NBSP}000.`,
        );
        expect(issueText({ field: 'maxTokens', code: 'integer' }, t)).toBe('Must be a whole number.');
        expect(issueText({ field: 'name', code: 'length', params: { max: 120 } }, t)).toBe(
            'Must be 1 to 120 characters.',
        );
        expect(issueText({ field: 'systemPrompt', code: 'length', params: { max: 12000 } }, t)).toContain(
            'Longer than',
        );
        expect(issueText({ field: 'expiry', code: 'past' }, t)).toContain('later day');
        expect(issueText({ field: 'structuredOutputs', code: 'conflict' }, t)).toContain('json_object');
        expect(issueText({ field: 'serviceTier', code: 'conflict' }, t)).toContain('flex and priority');
        expect(issueText({ field: 'thinkingBudget', code: 'conflict' }, t)).toContain('thinking');
        expect(issueText({ field: 'zdr', code: 'conflict' }, t)).toContain('do not go together');
    });

    it('has a text for every code', () => {
        const codes = [
            'required',
            'type',
            'length',
            'enum',
            'range',
            'integer',
            'step',
            'unknown_field',
            'empty',
            'conflict',
            'too_large',
            'number',
            'past',
            'date',
            'format',
        ] as const;
        for (const code of codes) expect(issueText({ field: 'x', code }, t), code).not.toMatch(/^mgmt\./);
    });
});

describe('key cards', () => {
    function key(patch: Partial<ManagedKey> = {}): ManagedKey {
        return {
            id: '12',
            name: 'Roleplay',
            status: 'active',
            createdAt: Date.UTC(2026, 9, 1),
            expiresAt: Date.UTC(2027, 0, 1),
            limits: emptyKeyLimits(),
            zdrPolicy: 'zdr',
            ...patch,
        };
    }

    it('summarises only the limits that are set', () => {
        const limits = emptyKeyLimits();
        limits.usd = { daily: 5, weekly: null, monthly: 50 };
        limits.requests = { daily: null, weekly: 1000, monthly: null };
        const lines = limitLines(limits, t);
        expect(lines.map((line) => [line.kind, line.label, line.text])).toEqual([
            ['requests', 'Requests', `1${NBSP}000 / week`],
            ['usd', 'USD', '$5 / day · $50 / month'],
        ]);
        expect(limitLines(emptyKeyLimits(), t)).toEqual([]);
    });

    it('describes an active key with a ZDR policy and an expiry', () => {
        const spec = keyCard(key(), NOW, t);
        expect(spec).toMatchObject({
            id: '12',
            name: 'Roleplay',
            expiry: 'Expires 2027-01-01 (UTC)',
            created: 'created 2026-10-01',
            blocked: false,
        });
        expect(spec.status).toEqual({ label: 'Active', kind: 'ok' });
        expect(spec.zdr).toMatchObject({ label: 'ZDR routes only', kind: 'info' });
        expect(spec.limits).toEqual([]);
    });

    it('describes an expired key, a key without expiry, a legacy policy and no created date', () => {
        const expired = keyCard(key({ status: 'expired', expiresAt: Date.UTC(2026, 1, 1) }), NOW, t);
        expect(expired.status).toEqual({ label: 'Expired', kind: 'error' });
        expect(expired.expiry).toBe('Expired 2026-02-01 (UTC)');
        // Expired by the clock even when the API still says active.
        expect(keyCard(key({ expiresAt: NOW - 1 }), NOW, t).status.label).toBe('Expired');

        const open = keyCard(key({ expiresAt: null, zdrPolicy: 'unset', createdAt: null, name: '' }), NOW, t);
        expect(open.expiry).toBe('No expiry');
        expect(open.zdr).toMatchObject({ label: 'Policy not set', kind: 'warn' });
        expect(open.created).toBeNull();
        expect(open.name).toBe('(unnamed)');
        expect(keyCard(key({ zdrPolicy: null }), NOW, t).zdr).toBeNull();
        expect(keyCard(key({ zdrPolicy: 'off' }), NOW, t).zdr).toMatchObject({ label: 'Any route' });
    });

    it('a limit of 0 blocks the key', () => {
        const limits = emptyKeyLimits();
        limits.usd.daily = 0;
        expect(isBlocked(limits)).toBe(true);
        expect(isBlocked(emptyKeyLimits())).toBe(false);
        const spec = keyCard(key({ limits }), NOW, t);
        expect(spec.blocked).toBe(true);
        expect(spec.limits[0]?.text).toBe('$0 / day');
    });

    it('labels the ST secret of a created key the way the plugin does', () => {
        expect(secretLabel('Nanovia: ', 'Roleplay')).toBe('Nanovia: Roleplay');
        expect(secretLabel('Nanovia: ', 'x'.repeat(200))).toHaveLength(100);
    });
});

describe('preset cards', () => {
    it('shows only what is set', () => {
        expect(presetChips(blankPreset('a'), t)).toEqual([]);
        const preset: ModelPreset = {
            ...blankPreset('rp-fast', 'vendor/model'),
            temperature: 0.8,
            maxTokens: 1500,
            topP: 0.9,
            routing: 'price',
            reasoningEffort: 'high',
            structuredOutputs: true,
            responseFormat: 'json_object',
            thinking: { enabled: true, budgetTokens: 8000 },
            promptCaching: { enabled: true, ttl: '1h' },
            systemPrompt: 'Be brief.',
            updatedAt: Date.UTC(2026, 10, 1),
        };
        const chips = presetChips(preset, t);
        expect(chips).toContain(`Max tokens 1${NBSP}500`);
        expect(chips).toContain('Temperature 0.8');
        expect(chips).toContain('Top P 0.9');
        expect(chips).toContain('Routing preference price');
        expect(chips).toContain('Reasoning effort high');
        expect(chips).toContain('Structured outputs on');
        expect(chips).toContain('Response format json_object');
        expect(chips).toContain(`Thinking budget (tokens) 8${NBSP}000`);
        expect(chips).toContain('Prompt caching 1h');
        expect(chips).toContain('System prompt 9 characters');
        const card = presetCard(preset, t);
        expect(card).toMatchObject({
            name: 'rp-fast',
            modelId: 'presets/rp-fast',
            model: 'vendor/model',
            updated: 'updated 2026-11-01',
        });
    });

    it('thinking and caching that are off or have no detail read as on/off', () => {
        const preset: ModelPreset = {
            ...blankPreset('a'),
            thinking: { enabled: false, budgetTokens: null },
            promptCaching: { enabled: true, ttl: null },
        };
        const chips = presetChips(preset, t);
        expect(chips).toContain('Thinking off');
        expect(chips).toContain('Prompt caching on');
        expect(presetChips({ ...blankPreset('a'), thinking: { enabled: true, budgetTokens: null } }, t)).toContain(
            'Thinking on',
        );
        expect(presetChips({ ...blankPreset('a'), promptCaching: { enabled: false, ttl: '5m' } }, t)).toContain(
            'Prompt caching off',
        );
    });
});

describe('guide and dates', () => {
    it('lists the scopes the tab needs, the write ones', () => {
        expect(SCOPE_GUIDE.map((item) => item.scope)).toEqual(['api_keys:write', 'model_presets:write']);
        for (const item of SCOPE_GUIDE) expect(t(item.purposeKey)).not.toMatch(/^mgmt\./);
    });

    it('a date is in the future until the end of its day', () => {
        expect(isFutureDate('2026-11-23', NOW)).toBe(true);
        expect(isFutureDate('2026-11-22', NOW)).toBe(false);
        expect(isFutureDate('nope', NOW)).toBe(false);
    });
});

describe('strings', () => {
    it('every English string has a Russian one and the other way round', () => {
        expect(i18n.missingRussian().filter((key) => key.startsWith('mgmt.'))).toEqual([]);
        expect(i18n.missingEnglish().filter((key) => key.startsWith('mgmt.'))).toEqual([]);
    });

    it('both languages keep the same {params}', () => {
        const params = (text: string): string[] =>
            [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
        for (const [key, en] of Object.entries(MGMT_STRINGS.en)) {
            expect(params(MGMT_STRINGS.ru[key] ?? ''), key).toEqual(params(en));
        }
    });
});
