import { describe, expect, it, vi } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import {
    SETTINGS_KEY,
    SETTINGS_MIGRATIONS,
    SETTINGS_SCHEMA_VERSION,
    Settings,
    defaultSettings,
    migrateSettings,
} from '../../src/core/settings';
import { memoryLogger } from '../helpers/fakes';

const NOW = 1_700_000_000_000;

describe('migrateSettings', () => {
    it('gives defaults on the first run', () => {
        expect(migrateSettings(undefined, undefined, {}, 1, NOW)).toEqual(defaultSettings());
        expect(migrateSettings('junk', undefined, {}, 1, NOW)).toEqual(defaultSettings());
    });

    it('keeps valid stored values and replaces wrongly typed ones', () => {
        const mirror = createConnection({ name: 'Main', modelId: 'deepseek/deepseek-v4' }, 'abc12345', 5);
        const result = migrateSettings(
            {
                schemaVersion: 1,
                debug: 'yes',
                uiLanguage: 'ru',
                lastTab: 'connections',
                profiles: { abc12345: 'profile-1', 'not valid': 'x', def67890: 5 },
                directSecrets: { abc12345: 'secret-1' },
                mirror: [mirror, { id: 'bad id', name: 'x', modelId: 'y' }, mirror, 'junk'],
                pending: ['abc12345', 'abc12345', 'nope', 7],
            },
            undefined,
            {},
            1,
            NOW,
        );
        expect(result.debug).toBe(false);
        expect(result.uiLanguage).toBe('ru');
        expect(result.lastTab).toBe('connections');
        expect(result.profiles).toEqual({ abc12345: 'profile-1' });
        expect(result.directSecrets).toEqual({ abc12345: 'secret-1' });
        expect(result.mirror).toHaveLength(1);
        expect(result.mirror[0]).toMatchObject({ id: 'abc12345', name: 'Main', modelId: 'deepseek/deepseek-v4' });
        expect(result.pending).toEqual(['abc12345']);
    });

    it('drops unknown keys, so nothing foreign (a key pasted by hand, say) survives a load', () => {
        const result = migrateSettings(
            { schemaVersion: 1, apiKey: 'sk-nano-secret', token: 'x' },
            undefined,
            {},
            1,
            NOW,
        );
        expect(JSON.stringify(result)).not.toContain('sk-nano-secret');
        expect(Object.keys(result).sort()).toEqual(Object.keys(defaultSettings()).sort());
    });

    it('rejects an unknown language and keeps the language choices', () => {
        expect(migrateSettings({ uiLanguage: 'de' }, undefined, {}, 1, NOW).uiLanguage).toBe('auto');
        expect(migrateSettings({ uiLanguage: 'en' }, undefined, {}, 1, NOW).uiLanguage).toBe('en');
    });

    it('runs the steps from the stored schema up to the target, in order', () => {
        const order: number[] = [];
        const migrations = {
            1: (raw: Record<string, unknown>) => {
                order.push(1);
                raw['lastTab'] = 'moved-from-1';
            },
            2: (raw: Record<string, unknown>) => {
                order.push(2);
                raw['debug'] = true;
            },
        };
        const result = migrateSettings({ schemaVersion: 1 }, undefined, migrations, 3, NOW);
        expect(order).toEqual([1, 2]);
        expect(result.lastTab).toBe('moved-from-1');
        expect(result.debug).toBe(true);
        expect(result.schemaVersion).toBe(3);
    });

    it('logs a failing step and goes on', () => {
        const log = memoryLogger();
        const migrations = {
            1: () => {
                throw new Error('boom');
            },
        };
        const result = migrateSettings({ schemaVersion: 1, lastTab: 'kept' }, log, migrations, 2, NOW);
        expect(result.lastTab).toBe('kept');
        expect(result.schemaVersion).toBe(2);
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('does not lower a schema newer than the code knows', () => {
        expect(
            migrateSettings({ schemaVersion: 9 }, undefined, SETTINGS_MIGRATIONS, SETTINGS_SCHEMA_VERSION, NOW)
                .schemaVersion,
        ).toBe(9);
    });
});

describe('Settings', () => {
    function make(initial: Record<string, unknown> = {}) {
        const store: Record<string, unknown> = { ...initial };
        const persist = vi.fn();
        const settings = new Settings(() => store, persist, memoryLogger());
        return { store, persist, settings };
    }

    it('writes the migrated object back under extension_settings.nanovia and keeps one reference', () => {
        const { store, settings } = make();
        expect(store[SETTINGS_KEY]).toBe(settings.get());
        settings.set('lastTab', 'x');
        expect(store[SETTINGS_KEY]).toBe(settings.get());
        expect((store[SETTINGS_KEY] as { lastTab: string }).lastTab).toBe('x');
    });

    it('saves and notifies on set and update', () => {
        const { persist, settings } = make();
        const seen: string[] = [];
        const off = settings.onChange((key) => seen.push(key));
        settings.set('debug', true);
        settings.update((s) => {
            s.profiles['abc12345'] = 'p';
        }, 'profiles');
        expect(persist).toHaveBeenCalledTimes(2);
        expect(seen).toEqual(['debug', 'profiles']);
        off();
        settings.set('debug', false);
        expect(seen).toHaveLength(2);
    });

    it('survives a failing persist and a failing listener', () => {
        const log = memoryLogger();
        const settings = new Settings(
            () => ({}),
            () => {
                throw new Error('disk');
            },
            log,
        );
        settings.onChange(() => {
            throw new Error('listener');
        });
        expect(() => settings.set('debug', true)).not.toThrow();
        expect(log.lines.filter((line) => line.level === 'error')).toHaveLength(2);
    });

    it('reset drops the stored object and starts again from defaults', () => {
        const { store, settings } = make({ [SETTINGS_KEY]: { schemaVersion: 1, lastTab: 'old' } });
        expect(settings.get().lastTab).toBe('old');
        settings.reset();
        expect(settings.get()).toEqual(defaultSettings());
        expect(store[SETTINGS_KEY]).toBe(settings.get());
    });

    it('reload picks up a replaced settings object', () => {
        const { store, settings } = make();
        store[SETTINGS_KEY] = { schemaVersion: 1, lastTab: 'from-st' };
        settings.reload();
        expect(settings.get().lastTab).toBe('from-st');
    });
});
