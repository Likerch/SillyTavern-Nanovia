// The request hook (docs/ARCHITECTURE.md §5): a wrapper of `fetch` that lets Nanovia adjust ST's chat-completion
// requests just before they leave the browser. CM background requests (ChatCompletionService, used by Maestro, Dramatis,
// Localizer, Officina) skip CHAT_COMPLETION_SETTINGS_READY, so a fetch hook is the only place that sees all of them.
//
// - Installed once and idempotent: a second install reuses the wrapper that is already in place.
// - Only POSTs of a string body to `/api/backends/chat-completions/generate` are looked at; everything else passes
//   through untouched, and a failing hook never breaks a request.
// - Hooks mutate the parsed JSON body; the body is re-serialised only when a hook actually changed it.
// - Response observers see the answer to such a request; they may only read a `clone()` (the response ST gets is the
//   original, untouched).
// - The original fetch is always called with the window as `this` (a property call throws "Illegal invocation").
import { HINT_HEADERS } from '../shared/constants';
import type { RequestHints } from '../shared/contracts';
import { isNanoGptUrl, parseProxyUrl } from './targets';
import type { Logger, Unsubscribe } from './types';
import { mergeYamlEntries } from './yaml-merge';
import type { YamlMergeResult } from './yaml-merge';

export const GENERATE_PATH = '/api/backends/chat-completions/generate';

export type RequestTarget =
    /** The Custom source points at one of our local proxy URLs. */
    | { kind: 'proxy'; connectionId: string; port: number }
    /** The Custom source points at NanoGPT itself (a direct-mode profile). */
    | { kind: 'direct' };

/** What the direct-mode hook decided about a request; the usage tap reads it when the answer comes back. */
export interface DirectRequestInfo {
    connectionId: string;
    /** The model id that was sent (suffixes included). */
    modelId: string;
    /** The connection forces pay-as-you-go (`X-Billing-Mode: paygo`). */
    billingModeForced: boolean;
    /** The request names providers explicitly (pay-as-you-go plus markup). */
    explicitRouting: boolean;
}

export interface GenerateRequest {
    /** The parsed JSON body of the request. Mutate it; the wrapper re-serialises it when it changed. */
    body: Record<string, unknown>;
    /** Where the request goes, when it goes to Nanovia's side of things; null for any other request. */
    target: RequestTarget | null;
    /** `secret_id` of the body: the ST secret the request will use. */
    secretId: string | null;
    /** 'main' for the chat generation, 'background' for extension requests. */
    consumer: RequestHints['consumer'];
    log: Logger;
    /** Set by the direct-mode hook when the request belongs to a direct Nanovia connection. */
    direct?: DirectRequestInfo;
}

export type RequestHook = (request: GenerateRequest) => void | Promise<void>;

/** What a response observer is told: the request as the hooks left it, and the answer of the backend. */
export interface ResponseInfo {
    request: GenerateRequest;
    /** The response ST receives. Observers must `clone()` it before reading and never read this one. */
    response: Response;
    /** `Date.now()` when the request was handed to the real fetch. */
    startedAt: number;
}

export type ResponseObserver = (info: ResponseInfo) => void | Promise<void>;

export interface RequestHooks {
    /** Hooks run in registration order. Returns the function that removes the hook. */
    register(hook: RequestHook): Unsubscribe;
}

export interface FetchHookHandle extends RequestHooks {
    /**
     * Observers run (in registration order) as soon as the response of a hooked generate request is there, before ST
     * gets it. They must be quick and read only a `clone()` of the response. Returns the remover.
     */
    observe(observer: ResponseObserver): Unsubscribe;
    /** Removes the wrapper (when it is still the outermost one) and every hook and observer. */
    uninstall(): void;
    hookCount(): number;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface HookState {
    original: FetchFn;
    wrapper: FetchFn;
    hooks: Set<RequestHook>;
    observers: Set<ResponseObserver>;
    active: boolean;
    log: Logger;
}

const STATE_KEY = Symbol.for('nanovia.fetchHook');

type Scope = typeof globalThis & { [STATE_KEY]?: HookState };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Where a generate body goes and who sends it. Pure. */
export function inspectGenerateBody(
    body: Record<string, unknown>,
): Pick<GenerateRequest, 'target' | 'secretId' | 'consumer'> {
    let target: RequestTarget | null = null;
    if (body['chat_completion_source'] === 'custom') {
        const proxy = parseProxyUrl(body['custom_url']);
        if (proxy) target = { kind: 'proxy', connectionId: proxy.connectionId, port: proxy.port };
        else if (isNanoGptUrl(body['custom_url'])) target = { kind: 'direct' };
    }
    const secretId = typeof body['secret_id'] === 'string' && body['secret_id'] ? body['secret_id'] : null;
    // The chat generation carries `type` (normal, swipe, continue, impersonate …); ST's quiet prompts and the
    // ChatCompletionService requests of extensions do not, or say 'quiet'.
    const type = body['type'];
    const consumer = typeof type === 'string' && type !== 'quiet' ? 'main' : 'background';
    return { target, secretId, consumer };
}

/** What ST itself knew about the request, in the vocabulary of the hint headers. Pure. */
export function hintsOf(request: Pick<GenerateRequest, 'body' | 'consumer'>): RequestHints {
    const effort = request.body['reasoning_effort'];
    return {
        effort: typeof effort === 'string' && effort ? effort : null,
        consumer: request.consumer,
        thoughts: request.body['include_reasoning'] === true,
    };
}

function mergeInto(
    request: GenerateRequest,
    field: string,
    entries: Record<string, unknown>,
    ignoreCase: boolean,
): YamlMergeResult {
    const current = request.body[field];
    const result = mergeYamlEntries(typeof current === 'string' ? current : '', entries, { ignoreCase });
    if (!result.ok) {
        request.log.debug(`${field} left alone: ${result.reason}`);
        return result;
    }
    if (result.added.length > 0) request.body[field] = result.text;
    return result;
}

/**
 * Adds headers through `custom_include_headers`; entries the user already set (any case) stay as they are. The result
 * says which entries were `added`, which `kept` (the user's own), or why nothing could be done.
 */
export function addIncludeHeaders(request: GenerateRequest, headers: Record<string, string>): YamlMergeResult {
    return mergeInto(request, 'custom_include_headers', headers, true);
}

/** Adds body fields through `custom_include_body`; fields the user already set stay as they are. Result as above. */
export function addIncludeBody(request: GenerateRequest, fields: Record<string, unknown>): YamlMergeResult {
    return mergeInto(request, 'custom_include_body', fields, false);
}

/** Proxy mode: tells the proxy what ST knew (effort, main/background, show-thoughts) through hint headers. */
export const proxyHintsHook: RequestHook = (request) => {
    if (request.target?.kind !== 'proxy') return;
    const hints = hintsOf(request);
    const headers: Record<string, string> = { [HINT_HEADERS.consumer]: hints.consumer };
    if (hints.effort) headers[HINT_HEADERS.effort] = hints.effort;
    if (hints.thoughts) headers[HINT_HEADERS.thoughts] = '1';
    addIncludeHeaders(request, headers);
};

function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
    if (init?.method) return init.method.toUpperCase();
    if (typeof input === 'object' && !(input instanceof URL) && typeof input.method === 'string') {
        return input.method.toUpperCase();
    }
    return 'GET';
}

function isGenerateUrl(raw: string, scope: Scope): boolean {
    try {
        const base = scope.location?.href ?? 'http://localhost/';
        return new URL(raw, base).pathname.endsWith(GENERATE_PATH);
    } catch {
        return false;
    }
}

interface Patched {
    /** The init to send; undefined = the caller's own. */
    init: RequestInit | undefined;
    /** The request the hooks saw; null when this was not a hooked generate request. */
    request: GenerateRequest | null;
}

const UNTOUCHED: Patched = { init: undefined, request: null };

async function patchInit(
    state: HookState,
    scope: Scope,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
): Promise<Patched> {
    if (state.hooks.size === 0 || typeof init?.body !== 'string') return UNTOUCHED;
    if (methodOf(input, init) !== 'POST' || !isGenerateUrl(urlOf(input), scope)) return UNTOUCHED;
    let body: unknown;
    try {
        body = JSON.parse(init.body);
    } catch {
        return UNTOUCHED;
    }
    if (!isRecord(body)) return UNTOUCHED;
    const before = JSON.stringify(body);
    const request: GenerateRequest = { body, ...inspectGenerateBody(body), log: state.log };
    for (const hook of [...state.hooks]) {
        if (!state.hooks.has(hook)) continue;
        try {
            await hook(request);
        } catch (error) {
            state.log.warn('a request hook failed; the request goes on as it was', error);
        }
    }
    const after = JSON.stringify(request.body);
    return { init: after === before ? undefined : { ...init, body: after }, request };
}

/** Tells the observers about a response. Nothing an observer does (or throws) reaches the caller of fetch. */
function notifyObservers(state: HookState, request: GenerateRequest, response: Response, startedAt: number): void {
    for (const observer of [...state.observers]) {
        if (!state.observers.has(observer)) continue;
        try {
            const result = observer({ request, response, startedAt });
            if (result instanceof Promise) {
                result.catch((error: unknown) => state.log.debug('a response observer failed', error));
            }
        } catch (error) {
            state.log.debug('a response observer failed', error);
        }
    }
}

/**
 * Wraps `scope.fetch` once. Calling it again while our wrapper is still in place returns a handle to the same wrapper
 * (and its hooks); if something replaced `fetch` in the meantime, a fresh wrapper goes around the current one.
 */
export function installFetchHook(log: Logger, scope: typeof globalThis = globalThis): FetchHookHandle {
    const holder = scope as Scope;
    const existing = holder[STATE_KEY];
    let state: HookState;
    if (existing && holder.fetch === (existing.wrapper as unknown)) {
        existing.active = true;
        existing.log = log;
        state = existing;
    } else {
        if (existing) existing.active = false;
        const original = holder.fetch as unknown as FetchFn;
        const created: HookState = {
            original,
            hooks: new Set(),
            observers: new Set(),
            active: true,
            log,
            wrapper: undefined as unknown as FetchFn,
        };
        created.wrapper = async (input, init) => {
            let effective = init;
            let hooked: GenerateRequest | null = null;
            if (created.active) {
                try {
                    const patched = await patchInit(created, holder, input, init);
                    effective = patched.init ?? init;
                    hooked = patched.request;
                } catch (error) {
                    created.log.warn('request hooks failed; the request goes on as it was', error);
                }
            }
            const startedAt = Date.now();
            // Called as a method of `created` the browser's fetch throws 'Illegal invocation': it must see the window as `this`.
            const response = await created.original.call(scope, input, effective);
            if (hooked && created.active && created.observers.size > 0) {
                notifyObservers(created, hooked, response, startedAt);
            }
            return response;
        };
        holder.fetch = created.wrapper as unknown as typeof fetch;
        holder[STATE_KEY] = created;
        state = created;
    }

    return {
        register(hook: RequestHook): Unsubscribe {
            state.hooks.add(hook);
            return () => {
                state.hooks.delete(hook);
            };
        },
        observe(observer: ResponseObserver): Unsubscribe {
            state.observers.add(observer);
            return () => {
                state.observers.delete(observer);
            };
        },
        hookCount: () => state.hooks.size,
        uninstall(): void {
            state.hooks.clear();
            state.observers.clear();
            state.active = false;
            if (holder.fetch === (state.wrapper as unknown)) holder.fetch = state.original as unknown as typeof fetch;
            if (holder[STATE_KEY] === state) delete holder[STATE_KEY];
        },
    };
}
