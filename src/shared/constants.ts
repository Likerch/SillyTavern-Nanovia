// Constants shared by the browser extension, the pure domain and the server plugin. No imports: this layer is a leaf.

/** Global of the public API (docs/ARCHITECTURE.md §9). Members are only ever added; `version` stays 1. */
export const NANOVIA_API_GLOBAL = 'NANOVIA_API';
/** Dispatched on `window` (CustomEvent, detail `{ version: 1 }`) once the API object is installed. */
export const NANOVIA_API_READY_EVENT = 'nanovia-api-ready';
/** Key under `extension_settings`: interface preferences only, never a secret and never a connection. */
export const NANOVIA_SETTINGS_KEY = 'nanovia';

/** Server plugin id (ST mounts its router at `/api/plugins/<id>`). */
export const PLUGIN_ID = 'nanovia';
export const PLUGIN_ADMIN_BASE = '/api/plugins/nanovia';

/** The local proxy: its own HTTP listener, because ST's own router would demand a session cookie and a CSRF token. */
export const PROXY_HOST = '127.0.0.1';
export const DEFAULT_PROXY_PORT = 8787;

/** NanoGPT API bases. `api.nano-gpt.com` is IPv4-only and takes bodies up to 32 MiB; `nano-gpt.com` is the fallback. */
export const NANOGPT_API_BASE = 'https://api.nano-gpt.com/api/v1';
export const NANOGPT_API_BASE_FALLBACK = 'https://nano-gpt.com/api/v1';
export const NANOGPT_SITE = 'https://nano-gpt.com';
/** The Management API (API keys with limits, model presets). Its own host path, no CORS, no fallback host. */
export const NANOGPT_MGMT_BASE = 'https://nano-gpt.com/api/management/v1';
/** Every Management token starts with this; a normal inference key (`sk-nano-<uuid>`) does not work there. */
export const MGMT_TOKEN_PREFIX = 'sk-nano-mgmt-';

/** Names of ST secrets (src/endpoints/secrets.js SECRET_KEYS). Several values per key, each with an id and a label. */
export const SECRET_KEY_NANOGPT = 'api_key_nanogpt';
export const SECRET_KEY_CUSTOM = 'api_key_custom';

/** Prefix of the label of every secret Nanovia writes into ST's secret store. */
export const SECRET_LABEL_PREFIX = 'Nanovia: ';
/** Prefix of the name of every Connection Manager profile Nanovia creates. */
export const PROFILE_NAME_PREFIX = 'Nanovia · ';

/**
 * Hint headers the browser hook adds to a request through the proxy (via ST's `custom_include_headers`), so the
 * proxy can honour what ST itself knew about the request. All optional; names are lower case.
 */
export const HINT_HEADERS = {
    /** The reasoning effort ST/the caller asked for, in ST's vocabulary (min/low/medium/high/max/none/auto). */
    effort: 'x-nanovia-effort',
    /** 'main' for the chat generation, 'background' for extension requests, otherwise absent. */
    consumer: 'x-nanovia-consumer',
    /** '1' when the browser wants the reasoning text back (ST's show-thoughts). */
    thoughts: 'x-nanovia-thoughts',
} as const;

/** Headers the proxy adds to every response so a caller can see what happened to the request. */
export const RESPONSE_HEADERS = {
    connection: 'x-nanovia-connection',
    billing: 'x-nanovia-billing',
    requestId: 'x-nanovia-request-id',
    warnings: 'x-nanovia-warnings',
} as const;

/** Markup NanoGPT adds when a provider is chosen explicitly (docs: "normally 5%"). */
export const PROVIDER_MARKUP_PERCENT = 5;
