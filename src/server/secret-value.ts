// An opaque holder for a secret (a NanoGPT key). It survives JSON.stringify, string interpolation and console.log
// without leaking: only an explicit reveal() returns the value, and only upstream.ts and the key check call it.

const REDACTED = '[redacted]';

export class SecretValue {
    readonly #value: string;

    constructor(value: string) {
        this.#value = value;
    }

    /** The secret itself. Call it only at the moment the value goes on the wire. */
    reveal(): string {
        return this.#value;
    }

    /** Replaces every occurrence of the secret in a text (an upstream error message, say). */
    redact(text: string): string {
        return this.#value && text.includes(this.#value) ? text.split(this.#value).join(REDACTED) : text;
    }

    toJSON(): string {
        return REDACTED;
    }

    toString(): string {
        return REDACTED;
    }

    [Symbol.for('nodejs.util.inspect.custom')](): string {
        return 'SecretValue [redacted]';
    }
}

/** Masks a secret for display: at most the first 8 and the last 4 characters, fewer for short values. */
export function maskSecret(value: string): string {
    if (!value) return '';
    const head = Math.min(8, Math.floor(value.length / 3));
    const tail = Math.min(4, Math.floor(value.length / 4));
    return `${value.slice(0, head)}…${tail > 0 ? value.slice(value.length - tail) : ''}`;
}
