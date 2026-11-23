// SillyTavern events behind one small door: subscriptions are tracked (so dispose() removes them all), handler failures
// are reported to our logger instead of vanishing inside ST's emitter, and event names may be given as eventTypes keys.
import type { Logger, Unsubscribe } from './types';

type Listener = (...args: unknown[]) => unknown;

export interface HostEvents {
    /** `event` is an `eventTypes` key (APP_READY) or a raw event name. */
    on(event: string, handler: (...args: unknown[]) => unknown): Unsubscribe;
    emit(event: string, ...args: unknown[]): Promise<void>;
    /** The raw name of an `eventTypes` key, undefined when this ST does not know it. */
    name(key: string): string | undefined;
}

export interface HostEventsImpl extends HostEvents {
    /** Removes every listener registered through this object. */
    dispose(): void;
}

interface Registration {
    event: string;
    listener: Listener;
}

export function createHostEvents(ctx: () => STContext, log: Logger): HostEventsImpl {
    const registrations = new Set<Registration>();

    function name(key: string): string | undefined {
        const types = ctx().eventTypes ?? {};
        if (!Object.prototype.hasOwnProperty.call(types, key)) return undefined;
        const value = types[key];
        return typeof value === 'string' ? value : undefined;
    }

    function resolve(event: string): string {
        return name(event) ?? event;
    }

    return {
        on(event, handler): Unsubscribe {
            const raw = resolve(event);
            let active = true;
            // A wrapper gives every subscription its own identity and reports failures under our logger.
            const listener: Listener = (...args) => {
                if (!active) return undefined;
                try {
                    const result = handler(...args);
                    if (result instanceof Promise) {
                        return result.catch((error: unknown) => log.error(`listener for ${raw} failed`, error));
                    }
                    return result;
                } catch (error) {
                    log.error(`listener for ${raw} failed`, error);
                    return undefined;
                }
            };
            const registration: Registration = { event: raw, listener };
            ctx().eventSource.on(raw, listener);
            registrations.add(registration);
            return () => {
                if (!active) return;
                active = false;
                registrations.delete(registration);
                ctx().eventSource.removeListener(raw, listener);
            };
        },

        emit(event, ...args): Promise<void> {
            return ctx().eventSource.emit(resolve(event), ...args);
        },

        name,

        dispose(): void {
            const source = ctx().eventSource;
            for (const registration of [...registrations]) {
                try {
                    source.removeListener(registration.event, registration.listener);
                } catch (error) {
                    log.warn(`could not remove ${registration.event} listener`, error);
                }
            }
            registrations.clear();
        },
    };
}
