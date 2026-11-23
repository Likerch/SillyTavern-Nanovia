import { describe, expect, it } from 'vitest';
import { KEY_LIMIT_KINDS, KEY_LIMIT_PERIODS } from '../../src/domain/mgmt';
import {
    buildKeyCreate,
    buildKeyPatch,
    emptyKeyForm,
    keyFormFromKey,
    limitField,
    limitMax,
} from '../../src/features/mgmt/key-form-model';
import type { KeyFormState } from '../../src/features/mgmt/key-form-model';
import type { ManagedKey } from '../../src/shared/contracts-mgmt';
import { emptyKeyLimits } from '../helpers/mgmt-fake';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

function key(patch: Partial<ManagedKey> = {}): ManagedKey {
    return {
        id: '7',
        name: 'Roleplay',
        status: 'active',
        createdAt: Date.UTC(2026, 9, 1),
        expiresAt: Date.UTC(2027, 0, 1, 8, 30),
        limits: emptyKeyLimits(),
        zdrPolicy: 'off',
        ...patch,
    };
}

function edited(base: ManagedKey, change: (form: KeyFormState) => void): KeyFormState {
    const form = keyFormFromKey(base);
    change(form);
    return form;
}

describe('keyFormFromKey', () => {
    it('shows every limit as text, empty for unlimited, and the expiry as a UTC date', () => {
        const limits = emptyKeyLimits();
        limits.usd = { daily: 0.0001, weekly: null, monthly: 50 };
        limits.requests.weekly = 1500000;
        const form = keyFormFromKey(key({ limits }));
        expect(form.name).toBe('Roleplay');
        expect(form.expiry).toBe('2027-01-01');
        expect(form.zdr).toBe('off');
        expect(form.limits.usd).toEqual({ daily: '0.0001', weekly: '', monthly: '50' });
        expect(form.limits.requests).toEqual({ daily: '', weekly: '1500000', monthly: '' });
        expect(form.limits.inputTokens).toEqual({ daily: '', weekly: '', monthly: '' });
    });

    it('a key without expiry and with an unknown policy', () => {
        const form = keyFormFromKey(key({ expiresAt: null, zdrPolicy: null }));
        expect(form.expiry).toBe('');
        expect(form.zdr).toBe('keep');
    });

    it('an empty form starts without expiry and lets NanoGPT choose the policy', () => {
        const form = emptyKeyForm();
        expect(form).toMatchObject({ name: '', expiry: '', zdr: 'keep' });
        for (const kind of KEY_LIMIT_KINDS)
            for (const period of KEY_LIMIT_PERIODS) expect(form.limits[kind][period]).toBe('');
    });
});

describe('buildKeyPatch: only what changed', () => {
    it('an untouched form changes nothing', () => {
        const original = key();
        expect(buildKeyPatch(original, keyFormFromKey(original), NOW)).toEqual({
            ok: false,
            unchanged: true,
            issues: [],
        });
    });

    it('an untouched expiry stays out of the patch even when it was not at the end of its day', () => {
        const original = key({ expiresAt: Date.UTC(2027, 0, 1, 8, 30) });
        const result = buildKeyPatch(
            original,
            edited(original, (form) => (form.name = 'Renamed')),
            NOW,
        );
        expect(result).toEqual({ ok: true, patch: { name: 'Renamed' } });
    });

    it('sends one limit cell, and clears an emptied one with null', () => {
        const limits = emptyKeyLimits();
        limits.usd.monthly = 20;
        const original = key({ limits });
        const result = buildKeyPatch(
            original,
            edited(original, (form) => {
                form.limits.usd.monthly = '';
                form.limits.requests.daily = '100';
            }),
            NOW,
        );
        expect(result).toEqual({ ok: true, patch: { limits: { usd: { monthly: null }, requests: { daily: 100 } } } });
    });

    it('a limit retyped to the same value is not a change', () => {
        const limits = emptyKeyLimits();
        limits.usd.daily = 5;
        const original = key({ limits });
        const result = buildKeyPatch(
            original,
            edited(original, (form) => (form.limits.usd.daily = '5.0')),
            NOW,
        );
        expect(result).toMatchObject({ ok: false, unchanged: true });
    });

    it('sends a new expiry as the end of that UTC day, and null for none', () => {
        const original = key();
        const later = buildKeyPatch(
            original,
            edited(original, (form) => (form.expiry = '2027-06-30')),
            NOW,
        );
        expect(later).toEqual({ ok: true, patch: { expiresAt: Date.UTC(2027, 5, 30, 23, 59, 59, 999) } });
        const none = buildKeyPatch(
            original,
            edited(original, (form) => (form.expiry = '')),
            NOW,
        );
        expect(none).toEqual({ ok: true, patch: { expiresAt: null } });
    });

    it('refuses an expiry in the past or not a date, only when it was changed', () => {
        const original = key();
        const past = buildKeyPatch(
            original,
            edited(original, (form) => (form.expiry = '2026-11-22')),
            NOW,
        );
        expect(past).toEqual({ ok: false, unchanged: false, issues: [{ field: 'expiry', code: 'past' }] });
        const junk = buildKeyPatch(
            original,
            edited(original, (form) => (form.expiry = '2026-02-31')),
            NOW,
        );
        expect(junk).toMatchObject({ ok: false, issues: [{ field: 'expiry', code: 'date' }] });
        // An expired key edited for its limits keeps its old expiry without a complaint.
        const expired = key({ status: 'expired', expiresAt: Date.UTC(2026, 0, 1) });
        const result = buildKeyPatch(
            expired,
            edited(expired, (form) => (form.limits.usd.daily = '1')),
            NOW,
        );
        expect(result).toEqual({ ok: true, patch: { limits: { usd: { daily: 1 } } } });
    });

    it('changes the policy only when it differs, and `keep` leaves it', () => {
        const original = key({ zdrPolicy: 'off' });
        expect(
            buildKeyPatch(
                original,
                edited(original, (form) => (form.zdr = 'zdr')),
                NOW,
            ),
        ).toEqual({
            ok: true,
            patch: { zdrPolicy: 'zdr' },
        });
        expect(
            buildKeyPatch(
                original,
                edited(original, (form) => (form.zdr = 'keep')),
                NOW,
            ),
        ).toMatchObject({ unchanged: true });
        // A key whose policy NanoGPT did not report can be given one.
        const unknown = key({ zdrPolicy: null });
        expect(
            buildKeyPatch(
                unknown,
                edited(unknown, (form) => (form.zdr = 'off')),
                NOW,
            ),
        ).toEqual({
            ok: true,
            patch: { zdrPolicy: 'off' },
        });
    });

    it('renames, trimming, and refuses a blank name', () => {
        const original = key();
        const renamed = buildKeyPatch(
            original,
            edited(original, (form) => (form.name = '  New name  ')),
            NOW,
        );
        expect(renamed).toEqual({ ok: true, patch: { name: 'New name' } });
        const blank = buildKeyPatch(
            original,
            edited(original, (form) => (form.name = '   ')),
            NOW,
        );
        expect(blank).toMatchObject({ ok: false, issues: [{ field: 'name', code: 'length', params: { max: 120 } }] });
    });

    it('reports every unreadable number at its own cell', () => {
        const original = key();
        const result = buildKeyPatch(
            original,
            edited(original, (form) => {
                form.limits.usd.daily = 'five';
                form.limits.inputTokens.monthly = '1e6';
            }),
            NOW,
        );
        expect(result).toEqual({
            ok: false,
            unchanged: false,
            issues: [
                { field: 'limits.usd.daily', code: 'number' },
                { field: 'limits.inputTokens.monthly', code: 'number' },
            ],
        });
    });

    it('uses the plugin’s own ranges, steps and integers, with the cell and its largest value', () => {
        const original = key();
        const result = buildKeyPatch(
            original,
            edited(original, (form) => {
                form.limits.requests.daily = '10000001';
                form.limits.requests.weekly = '1.5';
                form.limits.usd.daily = '0.00001';
                form.limits.usd.weekly = '100001';
                form.limits.inputTokens.daily = '-1';
            }),
            NOW,
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const byField = Object.fromEntries(result.issues.map((issue) => [issue.field, issue]));
        expect(byField['limits.requests.daily']).toEqual({
            field: 'limits.requests.daily',
            code: 'range',
            params: { min: 0, max: 10_000_000 },
        });
        expect(byField['limits.requests.weekly']?.code).toBe('integer');
        expect(byField['limits.usd.daily']?.code).toBe('step');
        expect(byField['limits.usd.weekly']).toMatchObject({ code: 'range', params: { max: 100_000 } });
        expect(byField['limits.inputTokens.daily']?.code).toBe('range');
    });

    it('cleans float noise in a USD amount before it is sent', () => {
        const original = key();
        const result = buildKeyPatch(
            original,
            edited(original, (form) => (form.limits.usd.daily = '0.30000000000000004')),
            NOW,
        );
        expect(result).toEqual({ ok: true, patch: { limits: { usd: { daily: 0.3 } } } });
    });

    it('accepts a comma as the decimal mark and spaces as grouping', () => {
        const original = key();
        const result = buildKeyPatch(
            original,
            edited(original, (form) => {
                form.limits.usd.daily = '0,5';
                form.limits.requests.daily = '1 000';
            }),
            NOW,
        );
        expect(result).toEqual({ ok: true, patch: { limits: { usd: { daily: 0.5 }, requests: { daily: 1000 } } } });
    });

    it('a limit of 0 is a limit, not an empty field', () => {
        const original = key();
        const result = buildKeyPatch(
            original,
            edited(original, (form) => (form.limits.usd.daily = '0')),
            NOW,
        );
        expect(result).toEqual({ ok: true, patch: { limits: { usd: { daily: 0 } } } });
    });
});

describe('buildKeyCreate', () => {
    it('a name alone makes a key with nothing else set', () => {
        const form = emptyKeyForm();
        form.name = '  Roleplay  ';
        expect(buildKeyCreate(form, NOW)).toEqual({ ok: true, input: { name: 'Roleplay' } });
    });

    it('sends only the limits that were filled in, the expiry and the policy that was chosen', () => {
        const form = emptyKeyForm();
        form.name = 'Capped';
        form.expiry = '2027-03-01';
        form.zdr = 'zdr';
        form.limits.usd.monthly = '20';
        form.limits.requests.daily = '0';
        const result = buildKeyCreate(form, NOW);
        expect(result).toEqual({
            ok: true,
            input: {
                name: 'Capped',
                expiresAt: Date.UTC(2027, 2, 1, 23, 59, 59, 999),
                zdrPolicy: 'zdr',
                limits: { usd: { monthly: 20 }, requests: { daily: 0 } },
            },
        });
    });

    it('`keep` leaves the policy to NanoGPT; a legacy policy is not a choice for a new key', () => {
        const form = emptyKeyForm();
        form.name = 'A';
        expect(buildKeyCreate(form, NOW)).toEqual({ ok: true, input: { name: 'A' } });
        form.zdr = 'unset';
        expect(buildKeyCreate(form, NOW)).toEqual({ ok: true, input: { name: 'A' } });
    });

    it('refuses a blank name, a past expiry and a bad limit, all at once', () => {
        const form = emptyKeyForm();
        form.expiry = '2020-01-01';
        form.limits.usd.daily = '-3';
        const result = buildKeyCreate(form, NOW);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        // The form's own check (the date) and the plugin's (the name, the range) are listed together.
        expect(result.issues.map((issue) => issue.field).sort()).toEqual(['expiry', 'limits.usd.daily', 'name']);
        form.name = 'Fine';
        form.expiry = '';
        form.limits.usd.daily = '5';
        expect(buildKeyCreate(form, NOW).ok).toBe(true);
    });

    it('an unreadable number does not hide the plugin’s verdict on the other fields', () => {
        const original = key();
        const form = keyFormFromKey(original);
        form.limits.usd.daily = 'five';
        form.limits.requests.daily = '10000001';
        const result = buildKeyPatch(original, form, NOW);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.map((issue) => [issue.field, issue.code])).toEqual([
            ['limits.usd.daily', 'number'],
            ['limits.requests.daily', 'range'],
        ]);
    });

    it('names the cell of a field the form knows', () => {
        expect(limitField('usd', 'daily')).toBe('limits.usd.daily');
        expect(limitMax('requests', 'daily')).toBe(10_000_000);
        expect(limitMax('inputTokens', 'monthly')).toBe(2_147_483_647);
        expect(limitMax('usd', 'weekly')).toBe(100_000);
    });
});
