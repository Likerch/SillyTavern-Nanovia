// Types of the server plugin: the router subset it needs, the SillyTavern services it injects, the proxy pipeline
// (docs/ARCHITECTURE.md §4) and the dependencies handed to every route module. Contracts live in shared/.
import type {
    CatalogModel,
    ConnectionConfig,
    RequestHints,
    UpstreamPlan,
    UsageRecord,
} from '../shared/contracts';
import type { ServerConfig } from './config';
import type { SecretValue } from './secret-value';
import type { Store } from './store';
import type { TokenService } from './tokens';
import type { UsageLog } from './usage-log';

/* ------------------------------------------------------------------------------------------------ http */

/** The part of an Express request the admin routes read. */
export interface RouteRequest {
    body?: unknown;
    params: Record<string, string>;
    /** ST's auth middleware: the logged-in user. */
    user?: { profile?: { handle?: string }; directories?: { root?: string } };
}

export interface RouteResponse {
    status(code: number): RouteResponse;
    json(body: unknown): unknown;
    set(name: string, value: string): unknown;
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => void | Promise<void>;

/** An `express.Router` compatible subset. */
export interface RouterLike {
    get(path: string, handler: RouteHandler): unknown;
    post(path: string, handler: RouteHandler): unknown;
    put(path: string, handler: RouteHandler): unknown;
    delete(path: string, handler: RouteHandler): unknown;
}

export type FetchLike = (input: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface FetchInit {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}

/** What the plugin needs from a fetch response; satisfied by both Node's fetch and node-fetch. */
export interface FetchResponseLike {
    status: number;
    headers: { get(name: string): string | null; forEach(callback: (value: string, name: string) => void): void };
    body: AsyncIterable<Uint8Array> | null;
    text(): Promise<string>;
}

/* ------------------------------------------------------------------------------------------------ SillyTavern */

export interface SecretEntry {
    id: string;
    label: string;
    active: boolean;
    /** The raw value. Used inside the plugin (masking, upstream calls); no route ever returns it. */
    value?: string;
}

/**
 * SillyTavern's internals (secret store, user directories) behind one injectable interface. The real adapter is
 * `createStServices()` in st.ts; tests pass a fake. All methods are synchronous like ST's own.
 */
export interface StServices {
    /** ST's secrets module and users module were loaded. */
    readonly available: boolean;
    dataRoot(): string;
    /** The root directory of a user (`<data root>/<handle>`). */
    userRoot(handle: string): string;
    listSecrets(handle: string, key: string): SecretEntry[];
    /** The value of a secret by id, or of the active one when `id` is null. Empty string when there is none. */
    readSecret(handle: string, key: string, id: string | null): string;
    /**
     * Stores a value and returns the id of the new secret. Like ST's own writeSecret, the new secret becomes the
     * active one, unless `keepActive` says the previously active secret stays active.
     */
    writeSecret(handle: string, key: string, value: string, label: string, options?: { keepActive?: boolean }): string;
    renameSecret(handle: string, key: string, id: string, label: string): void;
    deleteSecret(handle: string, key: string, id: string): void;
}

/* ------------------------------------------------------------------------------------------------ proxy pipeline */

export interface ProxyStatus {
    up: boolean;
    host: string;
    /** The port actually bound; the configured port while the proxy is down. */
    port: number;
    /** Why the listener is down (`EADDRINUSE` …), null while up. */
    error: string | null;
}

/** What is known about the upstream answer once its headers arrived. */
export interface UpstreamInfo {
    status: number;
    /** Lower-case header names. */
    headers: Record<string, string>;
    /** The id NanoGPT gave the request, when it did. */
    requestId: string | null;
    /** The API base that answered (the primary or the fallback). */
    base: string;
    /** true: the body is relayed to the client as it arrives (SSE) and is not kept. */
    stream: boolean;
    /** The complete body of a non-streamed answer; response steps may replace it before it is written. */
    body: Buffer | null;
}

/**
 * Everything the pipeline steps share about one `POST /chat/completions` request. Steps read what they need and write
 * into `plan` (what goes upstream), `responseHeaders` and `usage`.
 */
export interface ProxyContext {
    /** Local id of the request, for logs only. */
    readonly localId: string;
    readonly startedAt: number;
    /** The ST user that owns the connection. */
    readonly user: string;
    readonly connection: ConnectionConfig;
    /** The NanoGPT key. Opaque: it never serialises; only the upstream call reveals it. */
    readonly key: SecretValue;
    /** The catalog entry of the model in use; null when the catalog does not know it (always null before stage 3). */
    readonly model: CatalogModel | null;
    readonly hints: RequestHints;
    /** The request body as it came in. Do not mutate: write to `plan.body`. */
    readonly body: Readonly<Record<string, unknown>>;
    /** The request asked for a streamed answer. */
    readonly stream: boolean;
    /** Aborted when the client goes away. */
    readonly signal: AbortSignal;
    /** The upstream request being built. `plan.body` starts as a shallow copy of `body`. */
    plan: UpstreamPlan;
    /** Set once the upstream answered; null while the request steps run. */
    upstream: UpstreamInfo | null;
    /** Extra headers for the client's response (added to RESPONSE_HEADERS, which the proxy always sets). */
    responseHeaders: Record<string, string>;
    /** Filled by the proxy and by steps; appended to the usage log at the very end. */
    usage: UsageRecord;
}

/**
 * Runs before the upstream call, in array order. Throwing aborts the request with a 500.
 */
export type RequestStep = (ctx: ProxyContext) => void | Promise<void>;

/**
 * Runs once the upstream answer is complete: for a non-streamed answer before the reply is written (`ctx.upstream.body`
 * may be replaced), for a streamed one after the last chunk (the client already has everything). A throwing step is
 * logged and skipped; it never fails the request.
 */
export type ResponseStep = (ctx: ProxyContext) => void | Promise<void>;

/* ------------------------------------------------------------------------------------------------ dependencies */

export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

/** Everything a route module or the proxy needs; built once in init() (tests build it with fakes). */
export interface ServerDeps {
    version: string;
    config: ServerConfig;
    st: StServices;
    store: Store;
    tokens: TokenService;
    usage: UsageLog;
    fetch: FetchLike;
    /** The live state of the proxy listener. */
    proxy: () => ProxyStatus;
    /** Catalog lookup (stage 3 replaces the default that knows nothing). */
    lookupModel: (modelId: string) => CatalogModel | null;
    now: () => number;
    log: Logger;
}

/** A module that adds admin routes: `routes/index.ts` lists them in ROUTE_MODULES. */
export type RouteModule = (router: RouterLike, deps: ServerDeps) => void;
