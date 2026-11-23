// The catalog straight from NanoGPT, for when the plugin is not there. Both routes are public, take no key and allow
// cross-origin reads, so a plain browser GET works; the answers go through the same domain functions the plugin uses:
//
//   GET https://nano-gpt.com/api/v1/models?detailed=true            the whole catalog (~700 KB)
//   GET https://nano-gpt.com/api/models/<encodeURIComponent id>/providers   the hosts of one model
//
// No custom request headers (a header outside the CORS safelist would force a preflight the site may not answer) and no
// cookies. Nothing here throws: every call resolves to a SourceResult whose error is a short code, never a body.
import { normalizeCatalog, normalizeModelProviders } from '../domain/catalog';
import { NANOGPT_SITE } from '../shared/constants';
import type { CatalogModel, ModelProviders } from '../shared/contracts';
import type { Logger } from './types';

export type SourceFailure =
    | { ok: false; code: 'unreachable' | 'timeout' | 'invalid_response'; message: string; status: null }
    /** The site answered with this status (404: it does not know the model). */
    | { ok: false; code: 'not_found' | `http_${number}`; message: string; status: number };

export type SourceResult<T> = { ok: true; data: T } | SourceFailure;

export interface DirectCatalogSource {
    /** The whole catalog, normalised. An answer without a single model counts as invalid. */
    catalog(): Promise<SourceResult<CatalogModel[]>>;
    /** The hosts of one model (the id as the catalog spells it). 404 -> `not_found`. */
    providers(modelId: string): Promise<SourceResult<ModelProviders>>;
}

export interface DirectCatalogDeps {
    log: Logger;
    /** Replaced in tests; defaults to the global fetch at call time. */
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** NanoGPT's site without a trailing slash. */
    site?: string;
    catalogTimeoutMs?: number;
    providersTimeoutMs?: number;
}

const CATALOG_TIMEOUT_MS = 20_000;
const PROVIDERS_TIMEOUT_MS = 15_000;

export function createDirectCatalogSource(deps: DirectCatalogDeps): DirectCatalogSource {
    const { log } = deps;
    const site = (deps.site ?? NANOGPT_SITE).replace(/\/+$/, '');
    const doFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        (deps.fetchImpl ?? globalThis.fetch)(input, init);

    /** One public GET: 2xx -> parsed JSON; any other status -> a failure carrying it. */
    async function getJson(url: string, timeoutMs: number): Promise<SourceResult<unknown>> {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        // A fetch that ignores its signal must not hang the caller: the timeout wins the race on its own.
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => {
                resolve('timeout');
                controller.abort();
            }, timeoutMs);
        });
        const work = (async () => {
            const response = await doFetch(url, {
                method: 'GET',
                headers: { accept: 'application/json' },
                credentials: 'omit',
                cache: 'no-store',
                signal: controller.signal,
            });
            const ok = response.status >= 200 && response.status < 300;
            return { status: response.status, body: ok ? await response.text() : '' };
        })();
        work.catch(() => {}); // a failure that arrives after the timeout was already reported
        try {
            const outcome = await Promise.race([work, timeout]);
            if (outcome === 'timeout') return { ok: false, code: 'timeout', message: 'timeout', status: null };
            if (outcome.status === 404) return { ok: false, code: 'not_found', message: 'HTTP 404', status: 404 };
            if (outcome.status < 200 || outcome.status >= 300) {
                return {
                    ok: false,
                    code: `http_${outcome.status}`,
                    message: `HTTP ${outcome.status}`,
                    status: outcome.status,
                };
            }
            try {
                return { ok: true, data: JSON.parse(outcome.body) as unknown };
            } catch {
                return { ok: false, code: 'invalid_response', message: 'not JSON', status: null };
            }
        } catch (error) {
            return {
                ok: false,
                code: 'unreachable',
                message: error instanceof Error ? error.message : String(error),
                status: null,
            };
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    return {
        async catalog() {
            const result = await getJson(
                `${site}/api/v1/models?detailed=true`,
                deps.catalogTimeoutMs ?? CATALOG_TIMEOUT_MS,
            );
            if (!result.ok) {
                log.debug(`direct catalog fetch failed (${result.code})`);
                return result;
            }
            const models = normalizeCatalog(result.data);
            // An empty answer is junk: it must not replace a good copy.
            if (models.length === 0) {
                return { ok: false, code: 'invalid_response', message: 'no models in the answer', status: null };
            }
            return { ok: true, data: models };
        },

        async providers(modelId) {
            const url = `${site}/api/models/${encodeURIComponent(modelId)}/providers`;
            const result = await getJson(url, deps.providersTimeoutMs ?? PROVIDERS_TIMEOUT_MS);
            if (!result.ok) {
                log.debug(`direct providers fetch failed (${result.code})`);
                return result;
            }
            const value = normalizeModelProviders(modelId, result.data);
            if (!value) return { ok: false, code: 'invalid_response', message: 'unrecognised answer', status: null };
            return { ok: true, data: value };
        },
    };
}
