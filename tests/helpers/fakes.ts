// Small fakes for browser-side tests: a silent logger that records its lines.
import type { Logger } from '../../src/core/types';

export interface MemoryLogger extends Logger {
    lines: { level: string; args: unknown[] }[];
}

export function memoryLogger(): MemoryLogger {
    const lines: { level: string; args: unknown[] }[] = [];
    const logger: MemoryLogger = {
        lines,
        debug: (...args) => lines.push({ level: 'debug', args }),
        info: (...args) => lines.push({ level: 'info', args }),
        warn: (...args) => lines.push({ level: 'warn', args }),
        error: (...args) => lines.push({ level: 'error', args }),
        scope: () => logger,
    };
    return logger;
}

/** Waits for pending timers and microtasks. */
export function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
