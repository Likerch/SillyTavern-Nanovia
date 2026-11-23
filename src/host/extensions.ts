// What SillyTavern tells about the other extensions and about itself: whether Qvink Memory is on (the Doctor and the
// connection form both ask), and ST's own version. Never throws: whatever cannot be read is "unknown".

/** Qvink Memory is loaded and on, installed but switched off, not there, or "cannot tell". */
export type QvinkState = 'present' | 'disabled' | 'absent' | 'unknown';

/**
 * Qvink's generate interceptor: its only global, registered when its script is loaded, so it also tells "loaded and
 * enabled" (the marker Maestro and the advice of core/advice.ts use too).
 */
export const QVINK_INTERCEPTOR = 'memory_intercept_messages';

/** Names (ST's `third-party/<folder>`) of Qvink's repository and the folder it is usually cloned to. */
const QVINK_NAME = /qvink|messagesummarize/i;

/**
 * ST lists the extensions the user switched off in `extension_settings.disabledExtensions` (a switched-off extension's
 * script is not loaded after a reload, so its global is gone; until then both signs can disagree and "disabled" wins).
 * Without that list ST cannot be read: only a loaded interceptor is still a sure sign.
 */
export function qvinkState(ctx: () => STContext): QvinkState {
    let disabled: unknown;
    try {
        disabled = ctx().extensionSettings.disabledExtensions;
    } catch {
        disabled = undefined;
    }
    const loaded = typeof (globalThis as Record<string, unknown>)[QVINK_INTERCEPTOR] === 'function';
    if (!Array.isArray(disabled)) return loaded ? 'present' : 'unknown';
    if (disabled.some((name) => typeof name === 'string' && QVINK_NAME.test(name))) return 'disabled';
    return loaded ? 'present' : 'absent';
}

const VERSION_TIMEOUT_MS = 5_000;

/** ST's `pkgVersion` from `GET /version`; null when it cannot be read (an older ST, no answer, not JSON). */
export async function readStVersion(
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (input, init) =>
        globalThis.fetch(input, init),
    timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl('/version', { cache: 'no-cache', signal: controller.signal });
        if (!response.ok) return null;
        const data: unknown = await response.json();
        const version =
            typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['pkgVersion'] : null;
        return typeof version === 'string' && version.trim() ? version.trim() : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
