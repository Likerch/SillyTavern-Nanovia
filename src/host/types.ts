// The two types every layer needs and host (the lowest browser layer) therefore owns; core/types re-exports them.

export type Unsubscribe = () => void;

export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    /** A logger whose lines carry `[Nanovia:<name>]`. */
    scope(name: string): Logger;
}
