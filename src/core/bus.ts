import type { Bus, Logger, NanoviaEvents, Unsubscribe } from './types';

type Handler<K extends keyof NanoviaEvents> = (payload: NanoviaEvents[K]) => void | Promise<void>;

/**
 * Nanovia's internal event bus. Handlers run in registration order; one failing handler does not stop the others, and
 * one removed while an emit is under way is not called by it.
 */
export class EventBus implements Bus {
    private readonly handlers = new Map<keyof NanoviaEvents, Set<Handler<never>>>();

    constructor(private readonly log: Logger) {}

    on<K extends keyof NanoviaEvents>(event: K, handler: Handler<K>): Unsubscribe {
        let set = this.handlers.get(event);
        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }
        set.add(handler as Handler<never>);
        return () => {
            set.delete(handler as Handler<never>);
        };
    }

    async emit<K extends keyof NanoviaEvents>(event: K, payload: NanoviaEvents[K]): Promise<void> {
        const set = this.handlers.get(event);
        if (!set) return;
        for (const handler of [...set]) {
            if (!set.has(handler)) continue;
            try {
                await (handler as Handler<K>)(payload);
            } catch (error) {
                this.log.error(`bus handler for ${String(event)} failed`, error);
            }
        }
    }

    /** Drops every handler (app stop). */
    clear(): void {
        this.handlers.clear();
    }
}

export function createBus(log: Logger): EventBus {
    return new EventBus(log);
}
