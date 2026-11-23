# Nanovia: architecture

Nanovia makes NanoGPT a first-class, OpenRouter-like provider inside SillyTavern (ST 1.19.x): per-connection routing,
billing awareness (subscription vs pay-as-you-go), a model catalog, usage and cost, and a bridge to Maestro and the other
extensions. A **connection** is a named bundle (model, routing, reasoning, billing, cache, search, memory, key) that
shows up in ST as an ordinary Connection Manager (CM) profile, so every consumer (the chat, Qvink, the background tasks
of Maestro/Dramatis/Localizer/Officina) can pick it like any other connection.

Source of truth for data shapes: `src/shared/contracts.ts` (+ constants in `src/shared/constants.ts`). This document
says how the parts fit together.

## 1. The hybrid

Two parts that work together, and the extension also works without the second:

- **Server plugin** (`server/index.js`, built from `src/server/**`): a local OpenAI-compatible proxy on its own
  listener `http://127.0.0.1:<port>` plus admin routes under `/api/plugins/nanovia`. It owns the NanoGPT key (read from
  ST's secret store), builds the upstream request (routing, reasoning, billing), reads usage and cost, keeps the usage
  log, and later talks to NanoGPT's Management API.
- **Browser extension** (`dist/index.js`, built from `src/**` except `src/server`): the panel, the connection <-> CM
  profile sync, a request hook on `/api/backends/chat-completions/generate`, the public API `NANOVIA_API`, and the bridges
  to Maestro and the neighbours.

Per-connection `mode`:

| mode | the CM profile points at | who builds the upstream request |
| --- | --- | --- |
| `plugin` | `proxyUrl` = `http://127.0.0.1:<port>/c/<id>/v1`, key slot = the connection's proxy token | the proxy |
| `direct` | `directUrl` = `https://api.nano-gpt.com/api/v1`, key slot = the NanoGPT key itself | the browser hook (through ST's `custom_include_body` / `custom_include_headers`) |
| `auto` | `plugin` when `/status` answers, otherwise `direct` | as above |

Both paths use the same pure function `planUpstream()` (`src/domain/upstream.ts`, stage 0.2). If the plugin dies in the
middle of a session the proxy URL stops answering: the panel shows "the Nanovia plugin is not answering" with a button that
switches the connection to direct mode. There is no silent fallback (price and quantisation could change unnoticed).

Why a separate listener: ST's server-side Custom-source fetch to `http://127.0.0.1:8000/api/plugins/nanovia/...` carries
no session cookie and no CSRF token and would be rejected. Why the Custom source and not ST's own NanoGPT source: ST's
server forwards only a fixed whitelist of fields to NanoGPT (no `provider` object, no `caching`), the Custom source
forwards any `custom_include_body`, and a Custom CM profile only needs `api-url`, `model` and `secret-id`.

## 2. Layout and layers

```
manifest.json, package.json, vite.config.ts (client), vite.server.config.ts (plugin)
dist/                 committed client bundle (index.js, style.css)
server/               plugin: package.json (type module), index.js = committed bundle of src/server
src/shared/           contracts + constants, imports nothing
src/domain/           pure logic shared by browser and server (no DOM, network, Node, ST, console)
src/server/           Node plugin source (sees shared + domain only)
src/host/             the only door to SillyTavern in the browser (context, events, secrets, profiles, fetch hook, plugin client)
src/core/             browser services (settings, i18n, logger, bus)
src/adapters/         readers of neighbours and bridges to Maestro (stage 0.5)
src/ui/               generic components (drawer, tabs, controls, dom helpers)
src/features/         panel tabs; each feature is a folder with index.ts, strings.ts, view files
src/app/              wiring: App object, feature registry, NANOVIA_API
tools/mock-nanogpt/   mock NanoGPT server (OpenAI-compatible + NanoGPT-specific routes)
scripts/              deploy-local.mjs, install-server.ps1/.sh
tests/                vitest (node env; happy-dom where DOM is needed)
docs/
```

ESLint (`eslint.config.js`) enforces the layer rules and bans hard-coded UI strings: all user-visible text goes through
`t()` with English and Russian dictionaries; Russian is the primary language, English is the fallback. Coverage threshold
90% lines on `src/domain`.

## 3. Data on the server

- Global dir `<ST data root>/_nanovia/`: `registry.json` = `{ version: 1, tokens: { [sha256(token)]: { connectionId, userHandle } } }`.
- Catalog cache `<ST data root>/_nanovia/catalog.json` = `{ version: 1, fetchedAt, models: CatalogModel[] }`: the normalised public
  NanoGPT catalog (`GET <siteBase>/api/v1/models?detailed=true`, no key), written after every fetch, read at start so the proxy
  knows the models at once and while NanoGPT is down. In memory: catalog TTL 10 min, per-model host lists TTL 5 min (200, LRU).
  `src/server/catalog.ts`; routes `GET /catalog[?refresh=1]`, `/catalog/:id/providers`, `/catalog/:id/hints` (+ `?id=` forms).
- Per-user dir `<user root>/nanovia/`: `connections.json` = `{ version: 1, connections: ConnectionConfig[] }`,
  `usage-YYYY-MM-DD.jsonl` (one `UsageRecord` per line), later `mgmt.json` (Management token, never returned to the browser).
- ST data root: `globalThis.DATA_ROOT`, falling back to `<cwd>/data`. User directories come from ST's `src/users.js`
  `getUserDirectories(handle)`, secrets from `src/endpoints/secrets.js` (`SecretManager`: `writeSecret(key, value, label)` returns
  the secret id; `readSecret(key, id)`; `getSecretState()` for ids and labels; `deleteSecret(key, id)`), both imported by a
  computed URL relative to the plugin folder (`../../src/...`), exactly like NAI Studio's plugin does. When ST internals are
  unavailable the plugin runs in a degraded mode (config file keys only) and `/status` reports `secrets: false`.
- Plugin config `server/config.json` (git-ignored): `{ port, upstreamBase, timeoutMs }`; env overrides `NANOVIA_PORT`,
  `NANOVIA_UPSTREAM`. Defaults: port 8787, upstream `NANOGPT_API_BASE`, fallback `NANOGPT_API_BASE_FALLBACK` on connect errors.
- Keys: NanoGPT keys live in ST's secret store under `api_key_nanogpt` (several, with labels). A connection's proxy token is
  a random value stored under `api_key_custom` with label `SECRET_LABEL_PREFIX + name`; the registry keeps only its hash.
  Keys and tokens are never logged, never written to our files, never returned by any route (`KeyInfo.masked` only).

## 4. Proxy protocol

Base `http://127.0.0.1:<port>/c/<connectionId>/v1`. Listener binds `PROXY_HOST` only.

- Auth: `Authorization: Bearer <token>` (ST sends the Custom key) or `x-api-key`; the token hash must resolve to the
  connection id in the URL. Otherwise 401 in OpenAI error shape `{ error: { message, type, code } }`.
- `GET /health`: no auth, `{ ok: true, version }`.
- `GET /models`: OpenAI list with the connection's model (ST's Custom "Connect" calls it).
- `POST /chat/completions`: stream and non-stream. Steps: parse JSON -> `RequestHints` from the `HINT_HEADERS` -> load
  connection, key and catalog model -> run `REQUEST_STEPS` -> call upstream (`POST <upstreamBase>/chat/completions`,
  `Authorization: Bearer <NanoGPT key>`) -> run `RESPONSE_STEPS` -> write the usage record. Upstream status and error
  bodies are passed through (OpenAI shape); transport failures become 502 `{ error: { code: 'upstream_unreachable' } }`.
- Streaming: SSE passes through chunk by chunk with no buffering delay; only events that carry `usage` are parsed and
  rewritten (stage 0.4). A client abort aborts the upstream request.
- Responses carry `RESPONSE_HEADERS` (connection id, billing outcome, upstream request id, warning codes).
- Pass-through rules (stage 0.1): every field of the body is forwarded; when `stripNeutralSamplers` is on, `top_k: 0`,
  `top_a: 0`, `min_p: 0`, `repetition_penalty: 1` and an empty `logit_bias` are removed first.

### Pipeline extension points

`src/server/pipeline/index.ts` exports `REQUEST_STEPS` and `RESPONSE_STEPS`, ordered arrays of
`(ctx: ProxyContext) => void | Promise<void>` (types in `src/server/types.ts`). A stage adds steps by appending one import
and one array entry. `ProxyContext` holds the connection, the key (opaque handle, never serialised), the catalog model,
the hints, the incoming body, the `UpstreamPlan` being built, the upstream response and the usage record being filled.

Route modules: `src/server/routes/index.ts` exports `ROUTE_MODULES`, an array of `(router, deps) => void`.

## 5. Browser

- `src/features/index.ts` exports `FEATURES: Feature[]`; stages append entries. A `Feature` is
  `{ id: string; init(ctx: FeatureContext): void | (() => void) }`; it registers panel tabs through
  `ctx.panel.registerTab({ id, titleKey, order, render(root, ctx) { ...; return dispose } })`.
- `FeatureContext` gives: `settings` (UI prefs, versioned, stored under `extension_settings.nanovia`), `plugin` (typed
  admin-API client with `status()` and `available()`), `connections` (the live list and `refresh()`), `profiles` (CM profile
  host), `secrets` (write-only ST secret writer for direct mode), `t`, `bus`, `log`.
- Strings: each feature owns `strings.ts` exporting `{ en: Record<string,string>, ru: Record<string,string> }`, registered
  on init; keys are namespaced `<feature>.<key>`.
- Profile sync (`src/host/profiles.ts`): connection -> CM profile `{ id, name: PROFILE_NAME_PREFIX + name, mode: 'cc',
  api: 'custom', model, 'api-url': proxyUrl|directUrl, 'secret-id': tokenSecretId|directSecretId }` written to
  `extension_settings.connectionManager.profiles` followed by `saveSettingsDebounced()`; a profile is recognised as ours by
  its `api-url` prefix. Updating a connection updates its profile; deleting removes it. The profile id is stored in
  `extension_settings.nanovia.profiles[connectionId]` (UI prefs file; no secrets).
- Request hook (`src/host/fetch-hook.ts`): wraps `fetch` for `/api/backends/chat-completions/generate`. For a body with
  `chat_completion_source: 'custom'` whose `custom_url` is a Nanovia proxy URL it adds hint headers through
  `custom_include_headers` (`HINT_HEADERS`: effort from `reasoning_effort`, consumer main/background, thoughts from
  `include_reasoning`); in direct mode it adds the planned body and headers through `custom_include_body` /
  `custom_include_headers`. Both fields are YAML strings in ST; merge with what the user already set, never overwrite.
  Hooks register through `registerRequestHook(fn)`; the wrapper is installed once and is idempotent across reloads.
- Quirks of ST 1.19 that the design depends on: the Custom source sends `reasoning_effort` only for OpenAI-named models
  (so in proxy mode the connection's reasoning policy does the work); CM background requests (ChatCompletionService,
  ConnectionManagerRequestService) bypass `CHAT_COMPLETION_SETTINGS_READY`, only a fetch hook sees them; ST's server drops
  upstream response headers; ST ignores `usage` in responses; the client cannot read secrets back.

## 6. Stages and ownership

| stage | version | content |
| --- | --- | --- |
| 1 | 0.1.0 | skeleton, plugin + proxy (pass-through), connections <-> profiles, modes, mock |
| 2 | 0.2.0 | routing (all provider fields), billing impact + subscription-safe mode, reasoning policy, several keys; `domain/upstream.ts` |
| 3 | 0.3.0 | catalog, host statistics, routing hints (`contracts-catalog.ts`) |
| 4 | 0.4.0 | balance, subscription, usage and cost, cache, OpenRouter-style response shim (`contracts-account.ts`) |
| 5 | 0.5.0 | `NANOVIA_API` full, Maestro and neighbour integrations |
| 6 | 0.6.0 | Management API, web search, Context Memory, Doctor (`contracts-mgmt.ts`) |
| 7 | 0.7.0 | media |
| 8 | 0.8.0 | NAI Studio image provider |

Parallel branches stay out of each other's way: a stage appends to `FEATURES`, `ROUTE_MODULES`, `REQUEST_STEPS`,
`RESPONSE_STEPS` and its own contract file, owns its folders (`src/features/<name>/`, `src/server/routes/<name>.ts`,
`src/server/pipeline/steps/<name>.ts`, `src/domain/<name>.ts`, `tests/<layer>/<name>*.test.ts`), and touches shared files
(`contracts.ts`, `constants.ts`, `package.json`, configs) only by adding, never rewriting.

## 7. Conventions

- Commits: authored by the owner, short English subject (`0.2.0: routing and subscription-safe mode`), no AI or
  Co-Authored-By trailer, one commit per logical step on a branch, tag `vX.Y.Z` per stage. CHANGELOG.md in Russian
  (Keep a Changelog). `dist/` and `server/index.js` are committed (rebuild before the stage commit).
- Tests: Vitest; pure logic in `tests/domain`, server in `tests/server` (real `http` servers on port 0), browser in
  `tests/host|core|ui|features` (happy-dom). `npm run check` (typecheck + lint + tests) must pass before a stage commit.
- Secrets: never in the repo, logs, test fixtures or error messages. Live checks use `NANOVIA_LIVE_KEY` from the environment.
- UI text through `t()` only; the ESLint rule enforces it.
