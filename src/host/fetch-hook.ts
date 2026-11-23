// The request hook (docs/ARCHITECTURE.md §5): a wrapper of `fetch` that lets Nanovia adjust ST's chat-completion
// requests just before they leave the browser. CM background requests (ChatCompletionService, used by Maestro, Dramatis,
// Localizer, Officina) skip CHAT_COMPLETION_SETTINGS_READY, so a fetch hook is the only place that sees all of them.
//
// - Installed once and idempotent: a second install reuses the wrapper that is already in place.
// - Only POSTs of a string body to `/api/backends/chat-completions/generate` are looked at; everything else passes
//   through untouched, and a failing hook never breaks a request.
// - Hooks mutate the parsed JSON body; the body is re-serialised only when a hook actually changed it.
import { HINT_HEADERS } from '../shared/constants';
import type { RequestHints } from '../shared/contracts';
import { isNanoGptUrl, parseProxyUrl } from './targets';
import type { Logger, Unsubscribe } from './types';
import { mergeYamlEntries } from './yaml-merge';

export const GENERATE_PATH = '/api/backends/chat-completions/generate';

export type RequestTarget =
    /** The Custom source points at one of our local proxy URLs. */
    | { kind: 'proxy'; connectionId: string; port: number }
    /** The Custom source points at NanoGPT itself (a direct-mode profile). */
    | { kind: 'direct' };

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
}

export type RequestHook = (request: GenerateRequest) => void | Promise<void>;

export interface RequestHooks {
    /** Hooks run in registration order. Returns the function that removes the hook. */
    register(hook: RequestHook): Unsubscribe;
}

export interface FetchHookHandle extends RequestHooks {
    /** Removes the wrapper (when it is still the outermost one) and every hook. */
    uninstall(): void;
    hookCount(): number;
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface HookState {
    original: FetchFn;
    wrapper: FetchFn;
    hooks: Set<RequestHook>;
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
): void {
    const current = request.body[field];
    const result = mergeYamlEntries(typeof current === 'string' ? current : '', entries, { ignoreCase });
    if (!result.ok) {
        request.log.debug(`${field} left alone: ${result.reason}`);
        return;
    }
    if (result.added.length > 0) request.body[field] = result.text;
}

/** Adds headers through `custom_include_headers`; entries the user already set (any case) stay as they are. */
export function addIncludeHeaders(request: GenerateRequest, headers: Record<string, string>): void {
    mergeInto(request, 'custom_include_headers', headers, true);
}

/** Adds body fields through `custom_include_body`; fields the user already set stay as they are. */
export function addIncludeBody(request: GenerateRequest, fields: Record<string, unknown>): void {
    mergeInto(request, 'custom_include_body', fields, false);
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

/** Direct mode: stage 0.2 fills this with the plan of `planUpstream()` (body and headers through the include fields). */
export const directModeHook: RequestHook = (request) => {
    if (request.target?.kind !== 'direct') return;
    request.log.debug('direct-mode request seen; planning arrives with stage 0.2');
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

async function patchInit(
    state: HookState,
    scope: Scope,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
    if (state.hooks.size === 0 || typeof init?.body !== 'string') return undefined;
    if (methodOf(input, init) !== 'POST' || !isGenerateUrl(urlOf(input), scope)) return undefined;
    let body: unknown;
    try {
        body = JSON.parse(init.body);
    } catch {
        return undefined;
    }
    if (!isRecord(body)) return undefined;
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
    return after === before ? undefined : { ...init, body: after };
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
            active: true,
            log,
            wrapper: undefined as unknown as FetchFn,
        };
        created.wrapper = async (input, init) => {
            let effective = init;
            if (created.active) {
                try {
                    effective = (await patchInit(created, holder, input, init)) ?? init;
                } catch (error) {
                    created.log.warn('request hooks failed; the request goes on as it was', error);
                }
            }
            return created.original(input, effective);
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
        hookCount: () => state.hooks.size,
        uninstall(): void {
            state.hooks.clear();
            state.active = false;
            if (holder.fetch === (state.wrapper as unknown)) holder.fetch = state.original as unknown as typeof fetch;
            if (holder[STATE_KEY] === state) delete holder[STATE_KEY];
        },
    };
}
