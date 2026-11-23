import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostEvents } from '../../src/host/events';
import { createHostModules } from '../../src/host/modules';
import { memoryLogger } from '../helpers/fakes';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;

beforeEach(() => {
    mock = installStMock();
});

afterEach(() => mock.restore());

describe('host events', () => {
    it('resolves eventTypes keys and raw names, and removes a listener on unsubscribe', async () => {
        const events = createHostEvents(() => mock.context, memoryLogger());
        const handler = vi.fn();
        const off = events.on('APP_READY', handler);
        events.on('raw_event', handler);
        await events.emit('APP_READY', 1);
        await events.emit('raw_event', 2);
        expect(handler.mock.calls).toEqual([[1], [2]]);
        off();
        off();
        await events.emit('APP_READY', 3);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(events.name('APP_READY')).toBe('app_ready');
        expect(events.name('NOPE')).toBeUndefined();
    });

    it('reports a failing handler (sync or async) to the logger and does not throw', async () => {
        const log = memoryLogger();
        const events = createHostEvents(() => mock.context, log);
        events.on('a', () => {
            throw new Error('sync');
        });
        events.on('b', async () => {
            throw new Error('async');
        });
        await expect(events.emit('a')).resolves.toBeUndefined();
        await expect(events.emit('b')).resolves.toBeUndefined();
        expect(log.lines.filter((line) => line.level === 'error')).toHaveLength(2);
    });

    it('dispose removes every listener', async () => {
        const events = createHostEvents(() => mock.context, memoryLogger());
        const handler = vi.fn();
        events.on('a', handler);
        events.on('b', handler);
        events.dispose();
        await events.emit('a');
        await events.emit('b');
        expect(handler).not.toHaveBeenCalled();
        expect(mock.eventSource.count('a')).toBe(0);
    });
});

describe('host modules', () => {
    it('imports an ST module once and shares it', async () => {
        const importer = vi.fn(async (url: string) => ({ url }));
        const modules = createHostModules(memoryLogger(), importer, () => 'http://st.local:8000');
        const [a, b] = await Promise.all([modules.secrets(), modules.secrets()]);
        expect(a).toBe(b);
        expect(importer).toHaveBeenCalledOnce();
        expect(importer).toHaveBeenCalledWith('http://st.local:8000/scripts/secrets.js');
    });

    it('forgets a failed import so a later call retries', async () => {
        const importer = vi.fn().mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ ok: true });
        const modules = createHostModules(memoryLogger(), importer, () => 'http://st.local:8000');
        await expect(modules.secrets()).rejects.toThrow('404');
        await expect(modules.secrets()).resolves.toEqual({ ok: true });
    });

    it('refuses a module of another origin', async () => {
        const modules = createHostModules(
            memoryLogger(),
            async () => ({}),
            () => 'http://st.local:8000',
        );
        await expect(modules.load('//evil.example/x.js')).rejects.toThrow('another origin');
    });
});
