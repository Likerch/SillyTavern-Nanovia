// ST's secret store from the browser, for direct mode only (docs/ARCHITECTURE.md §1): the NanoGPT key a user types
// once is written to `api_key_custom` and the browser keeps nothing but the id ST hands back. The client side of ST
// cannot read a secret back, and this module never tries to: no value is returned, kept or logged. (When ST runs with
// allowKeysExposure the state route sends values; they are dropped on arrival.)
//
// ST's /api/secrets/write makes the new secret the active one of its key. For `api_key_custom` that would silently
// switch the user's own Custom (OpenAI-compatible) key, so write() puts the previously active secret back.
import { SECRET_KEY_CUSTOM } from '../shared/constants';
import type { Logger } from './types';

export type SecretWriteResult = { ok: true; id: string } | { ok: false; error: string };

export interface SecretsHost {
    /** Writes `value` under `api_key_custom` with `label`; the secret that was active stays active. */
    write(value: string, label: string): Promise<SecretWriteResult>;
    /** Deletes one secret of `api_key_custom` by id. true when ST accepted it. */
    remove(id: string): Promise<boolean>;
    /** Whether a secret with this id still exists; null when ST could not be asked. */
    has(id: string): Promise<boolean | null>;
    /**
     * Makes ST's own (client-side) secret list match the server. The plugin writes proxy tokens into the secret store
     * behind the page's back; Connection Manager applies a profile's `secret-id` from that list, so a token the page
     * has not seen cannot be selected and the request goes out with whatever Custom key was active. Never throws.
     */
    sync(): Promise<void>;
}

export interface SecretsHostDeps {
    ctx: () => STContext;
    log: Logger;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** Called after a change so ST's own secret list (secrets.js `readSecretState`) catches up. Failures are ignored. */
    afterChange?: () => Promise<void>;
}

interface SecretState {
    id: string;
    label: string;
    active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSecretsHost(deps: SecretsHostDeps): SecretsHost {
    const { ctx, log } = deps;
    const doFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        (deps.fetchImpl ?? globalThis.fetch)(input, init);

    async function post(path: string, body?: Record<string, unknown>): Promise<Response> {
        const headers = ctx().getRequestHeaders({ omitContentType: body === undefined });
        return doFetch(path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    }

    /** The secrets of `api_key_custom` (ids, labels, activity); values are never read out of the answer. */
    async function readState(): Promise<SecretState[] | null> {
        try {
            const response = await post('/api/secrets/read');
            if (!response.ok) return null;
            const json: unknown = await response.json();
            const list = isRecord(json) ? json[SECRET_KEY_CUSTOM] : null;
            if (list === null || list === undefined) return [];
            if (!Array.isArray(list)) return null;
            const states: SecretState[] = [];
            for (const item of list) {
                if (!isRecord(item) || typeof item['id'] !== 'string') continue;
                states.push({
                    id: item['id'],
                    label: typeof item['label'] === 'string' ? item['label'] : '',
                    active: item['active'] === true,
                });
            }
            return states;
        } catch {
            return null;
        }
    }

    async function changed(): Promise<void> {
        try {
            await deps.afterChange?.();
        } catch (error) {
            log.debug('could not refresh ST secret list', error);
        }
    }

    return {
        async write(value, label) {
            const secret = value.trim();
            if (!secret) return { ok: false, error: 'empty' };
            const before = await readState();
            const previouslyActive = before?.find((item) => item.active)?.id ?? null;
            let id: string;
            try {
                const response = await post('/api/secrets/write', { key: SECRET_KEY_CUSTOM, value: secret, label });
                if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
                const json: unknown = await response.json();
                const written = isRecord(json) ? json['id'] : null;
                if (typeof written !== 'string' || !written) return { ok: false, error: 'no id in the answer' };
                id = written;
            } catch (error) {
                // The message of a network error never carries the request body.
                return { ok: false, error: error instanceof Error ? error.message : 'request failed' };
            }
            if (previouslyActive && previouslyActive !== id) {
                try {
                    const response = await post('/api/secrets/rotate', {
                        key: SECRET_KEY_CUSTOM,
                        id: previouslyActive,
                    });
                    if (!response.ok) log.warn(`could not put the previous Custom key back (HTTP ${response.status})`);
                } catch {
                    log.warn('could not put the previous Custom key back');
                }
            }
            await changed();
            return { ok: true, id };
        },

        async remove(id) {
            if (!id) return false;
            try {
                const response = await post('/api/secrets/delete', { key: SECRET_KEY_CUSTOM, id });
                if (!response.ok) return false;
            } catch {
                return false;
            }
            await changed();
            return true;
        },

        async has(id) {
            const state = await readState();
            return state === null ? null : state.some((item) => item.id === id);
        },

        sync: changed,
    };
}
