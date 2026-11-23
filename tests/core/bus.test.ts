import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus';
import { memoryLogger } from '../helpers/fakes';

describe('EventBus', () => {
    it('calls handlers in registration order', async () => {
        const bus = createBus(memoryLogger());
        const order: number[] = [];
        bus.on('connections:changed', () => void order.push(1));
        bus.on('connections:changed', async () => void order.push(2));
        await bus.emit('connections:changed', { count: 3 });
        expect(order).toEqual([1, 2]);
    });

    it('keeps going after a failing handler and logs it', async () => {
        const log = memoryLogger();
        const bus = createBus(log);
        const after = vi.fn();
        bus.on('plugin:status', () => {
            throw new Error('boom');
        });
        bus.on('plugin:status', after);
        await bus.emit('plugin:status', { up: false, status: null });
        expect(after).toHaveBeenCalledOnce();
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
    });

    it('does not call a handler removed during the emit, and unsubscribes cleanly', async () => {
        const bus = createBus(memoryLogger());
        const second = vi.fn();
        let off2: () => void = () => {};
        bus.on('settings:changed', () => off2());
        off2 = bus.on('settings:changed', second);
        await bus.emit('settings:changed', { key: '*' });
        expect(second).not.toHaveBeenCalled();
    });

    it('clear drops everything', async () => {
        const bus = createBus(memoryLogger());
        const handler = vi.fn();
        bus.on('settings:changed', handler);
        bus.clear();
        await bus.emit('settings:changed', { key: 'x' });
        expect(handler).not.toHaveBeenCalled();
    });
});
