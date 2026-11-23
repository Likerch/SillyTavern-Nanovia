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
  log, and talks to NanoGPT's Management API (§8).
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
  `usage-YYYY-MM-DD.jsonl` (one `UsageRecord` per line), `mgmt.json` = `{ version: 1, token, check: { valid, checkedAt, error } }`
  (the Management token, mode 0600 where the OS has modes, never returned to the browser; §8).
- ST data root: `globalThis.DATA_ROOT`, falling back to `<cwd>/data`. User directories come from ST's `src/users.js`
  `getUserDirectories(handle)`, secrets from `src/endpoints/secrets.js` (`SecretManager`: `writeSecret(key, value, label)` returns
  the secret id; `readSecret(key, id)`; `getSecretState()` for ids and labels; `deleteSecret(key, id)`), both imported by a
  computed URL relative to the plugin folder (`../../src/...`), exactly like NAI Studio's plugin does. When ST internals are
  unavailable the plugin runs in a degraded mode (config file keys only) and `/status` reports `secrets: false`.
- Plugin config `server/config.json` (git-ignored): `{ port, upstreamBase, mgmtBase, mediaBase, timeoutMs }`; env overrides `NANOVIA_PORT`,
  `NANOVIA_UPSTREAM`, `NANOVIA_MGMT`, `NANOVIA_MEDIA` (`mediaBase` = `https://api.nano-gpt.com`, no path, no fallback; §9). Defaults: port 8787, upstream `NANOGPT_API_BASE`, fallback `NANOGPT_API_BASE_FALLBACK` on connect errors.
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
- `FeatureContext` gives: `version`, `host`, `settings` (UI prefs, versioned, stored under `extension_settings.nanovia`),
  `plugin` (typed admin-API client: `status()`, `available()`, raw `request(method, path, { body, timeoutMs })`, the typed
  connection and key calls), `connections` (the live list and `refresh()`), `catalog` (the model catalog store: plugin,
  NanoGPT directly, IndexedDB copy), `usage` and `account` (stage 0.4 stores), `doctor` (checks of the whole setup),
  `mgmt` (Management API store; never holds the token), `profiles` (CM profile host), `secrets` (write-only ST secret
  writer; `sync()` refreshes ST's own list after the plugin writes a token), `registerRequestHook`, `panel`, `i18n`, `t`,
  `bus`, `log`.
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
| 1 | 0.1.0 | skeleton, plugin + proxy, connections <-> profiles, modes, mock |
| 2 | 0.2.0 | routing (all provider fields), billing impact + subscription-safe mode, reasoning policy, several keys; `domain/upstream.ts` |
| 3 | 0.3.0 | catalog, host statistics, routing hints (`contracts-catalog.ts`) |
| 4 | 0.4.0 | balance, subscription, usage and cost, cache, OpenRouter-style response shim (`contracts-account.ts`) |
| 5 | 0.5.0 | `NANOVIA_API` full, Maestro and neighbour integrations |
| 6 | 0.6.0 | Management API, web search, Context Memory, Doctor (`contracts-mgmt.ts`) |
| 7 | 0.7.0 | media |
| 8 | 0.8.0 | NAI Studio image provider |

Stages 0.1–0.6 were built as parallel branches and released together as 0.6.0 (one tag, `v0.6.0`).

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

## 8. Management API (stage 0.6, server part)

NanoGPT's Management API is a second, separate API: base `https://nano-gpt.com/api/management/v1`, `Authorization: Bearer
sk-nano-mgmt-…`, no CORS, so only the plugin can call it. The token is made by hand (Settings > Security; 90 days by
default, 365 at most) and is not an inference key: the two do not work on each other's endpoints. Contract:
`src/shared/contracts-mgmt.ts` (types and the admin route table), pure logic `src/domain/mgmt.ts`, routes
`src/server/routes/mgmt.ts` (+ `mgmt-api.ts`: the call, the token check, the error mapping), token file in `store.ts`.

### What NanoGPT offers

Docs: https://docs.nano-gpt.com/api-reference/management-api, https://docs.nano-gpt.com/api-reference/miscellaneous/model-presets,
https://docs.nano-gpt.com/api-reference/miscellaneous/rate-limits (limit semantics), OpenAPI https://nano-gpt.com/management-openapi.json.

| Scope | Endpoints |
| --- | --- |
| `usage:read` (stands alone) | `GET /subscription/usage` (not used by Nanovia: `/account/subscription` with the inference key does that) |
| `api_keys:read` / `api_keys:write` (includes read) | `GET /api-keys`, `GET /api-keys/{id}`; `POST /api-keys` (needs `Idempotency-Key`, returns the new key's secret once), `PATCH /api-keys/{id}`, `DELETE /api-keys/{id}` (revokes) |
| `model_presets:read` / `model_presets:write` (includes read) | `GET /model-presets`, `GET /model-presets/{name}`; `PUT /model-presets/{name}` (create or replace), `DELETE /model-presets/{name}` (204 even if gone) |

A key has no usage figure and no masked tail: the API never shows a secret after creation and reports no per-key spend, so
`ManagedKey` carries none (limits only: 12 caps as requests / USD / input tokens / subscription tokens per day, week, month in
UTC calendar windows, plus expiry and the zdr policy). A preset (`presets/<name>` as a model id in an inference request) holds
a model, a system prompt and sampling and reasoning settings.

### The plugin's side

- Routes (table and errors in `contracts-mgmt.ts`): `GET /mgmt/status[?verify=1]`, `PUT /mgmt/token[?force=1]`,
  `DELETE /mgmt/token`, `GET|POST /mgmt/keys`, `PATCH|DELETE /mgmt/keys/:id`, `GET|POST /mgmt/presets`,
  `PUT|DELETE /mgmt/presets/:name`. `POST /mgmt/keys` puts the new key's secret straight into ST's secret store
  (`api_key_nanogpt`, label `Nanovia: <name>`, not made the active key) and answers with its secret id; the secret is not in
  the answer. Every write is validated in `domain/mgmt.ts` first (the API's own ranges, steps and enums), so a bad request
  never reaches NanoGPT. A create is retried once with the same `Idempotency-Key` when the answer is lost (NanoGPT replays the
  identical request, secret included).
- The token is **write-only**. Stored per ST user in `<user root>/nanovia/mgmt.json` (temp file + rename, mode 0600 where the OS
  has modes). No route returns it, not even masked; no log line, error text or reply contains it (every text that comes back
  from NanoGPT is scrubbed of it before use; the plugin's own messages never take a value from a request). It goes on the wire
  only in the `Authorization` header, only to `config.mgmtBase`. `mgmtBase` has no fallback host: the only Management host is
  `nano-gpt.com`, a custom base (a mock, a proxy) is the only place the token ever goes, and the other bases do not carry over
  (a stand sets `mgmtBase` itself, as `tools/stand` does).
- `PUT /mgmt/token` checks the shape (`sk-nano-mgmt-` prefix, no spaces, sane length), then proves the token with one read call
  (`GET /api-keys`): NanoGPT recognising it (200, or 403 `insufficient_scope`: a known token without that scope, a usage-only
  token say) is "valid". It is stored only then, unless `?force=1`; a refused token leaves the earlier one in place. Other routes
  never ask first: they call, and a 401 turns the stored status to `valid: false` (error `mgmt_token_invalid`), a success to
  `valid: true`. A transport failure says nothing about the token and changes nothing.
- Errors keep clear of 401/403 (ST's front end reads those as "log in again"): no token `409 mgmt_token_missing`, rejected
  token `502 mgmt_token_invalid`, token without the scope `409 mgmt_scope_missing` (the message names the scope).
- Mock: `tools/mock-nanogpt/lib/management.mjs` follows the published contract (fields, ranges, codes the docs name), starts with
  keys 1-3 and presets `rp-fast`, `analyst`, and has scoped fake tokens (`sk-nano-mgmt-usage…`, `…keysread…`, `…presetsread…`,
  `…expired…`, `…revoked…`). Tests and fixtures use only fakes such as `sk-nano-mgmt-TESTTOKEN`.

### The browser's side

`src/host/plugin-mgmt.ts` is the typed, tolerant client over `plugin.request` (never throws; the `mgmt_*` codes and the other codes of
the route table become a closed `MgmtErrorKind` the UI switches on), `src/core/mgmt.ts` the `MgmtStore` on `FeatureContext.mgmt`
(status, keys, presets, a 30 s cache, a reload of the list after every write), `src/features/mgmt/` the «Management» tab (order 350,
between «Keys» and «Account»: token card, managed keys, model presets). The token is write-only in the browser too: the password
field is the only place the value lives, `saveToken(token)` hands it to the plugin and the store keeps nothing but the status. The
field is cleared when the plugin took the token or NanoGPT refused it, and kept (never shown) only when the call could not decide
(NanoGPT unreachable, a rate limit, the plugin not answering), so «save anyway» (`PUT /mgmt/token?force=1`) needs no second paste;
«save anyway» is never offered for a token NanoGPT rejected. The forms validate with the plugin's own `domain/mgmt.ts` checks, so a
refusal in the form is what the plugin would answer, and a key edit sends only the fields that changed. `NANOVIA_API.mgmt.status()`
returns `{ present, valid }` and nothing else.

### Not verified against NanoGPT (assumptions, listed on purpose)

No NanoGPT key or Management token was available, so nothing here was exercised against the live service; everything follows
the published docs and the OpenAPI document (version `2026-09-09-beta`, a beta contract that may change), read through a
summarising page fetcher.

1. Token length and characters: the docs give only the prefix. The shape check wants the prefix plus at least 8 printable
   characters and at most 512 in all (a guess that only turns away fragments).
2. Error `code` values: the docs name `invalid_management_token` (401), `insufficient_scope` (403), and for presets
   `model_preset_not_found`, `invalid_preset_name`, `invalid_preset`, `preset_name_conflict`, `preset_limit_reached`. The codes of
   the key endpoints' 400/404/409/413 are not documented; the plugin therefore decides by HTTP status and reads NanoGPT's code
   only for `insufficient_scope` (403) and to pass a 409's code through. The mock's own codes for the undocumented ones are guesses.
3. The probe `GET /api-keys` needs `api_keys:read`; "403 means the token is known" rests on the docs' wording (401 = missing,
   invalid, expired or revoked token, 403 = scope), not on a live call.
4. Lists are not documented as paged; the plugin reads `{ data: [...] }` (or a bare array) whole.
5. What `PATCH` does with an `expires_at` in the past, and whether USD and subscription limits interact, is not documented; the
   plugin passes such values through. The docs also state no maximum number of keys.
6. The two documentation pages disagree on which service tiers cannot go with ranked routing (`flex`, `priority` in the OpenAPI
   text; also `ultrafast` in the preset guide). The plugin blocks only `flex` and `priority`; NanoGPT's own 400 decides the rest.
7. `Retry-After` on 429/503 is in the prose, not in the OpenAPI response headers; the plugin does not forward it.
8. The Management host is `nano-gpt.com` (the docs never mention `api.nano-gpt.com` for it).

## 9. Media, server side (stage 0.7, part a)

Images, video, speech and transcription through the user's NanoGPT key. Contract: `src/shared/contracts-media.ts` (types, the
route table and the error codes); research: `docs/research/media-api.md` (the API), `media-live-probe.md` (what a real key
showed on 2026-11-23: trust it over the docs). The browser side is built against the same contract and is not described here.

### Pieces

| File | What it is |
| --- | --- |
| `src/domain/media.ts` | pure: `normalizeMediaList` (the four heterogeneous lists -> `MediaModel`), the four `estimate*` functions, `describePrice` |
| `src/domain/media-wire.ts` | pure: tolerant parsers of every upstream answer (image body, transcription, video submit and status in BOTH documented shapes, billing lookup), error mapping to the contract codes, the media usage record, `applyUsageAdjustments` |
| `src/domain/media-request.ts` | pure: validation of the four request bodies (4 MB input ceiling) and the builders of what goes upstream |
| `src/server/media-catalog.ts` | the four lists, TTL 1 h, `<data root>/_nanovia/media-<medium>.json`, `autoFetch` on in `index.ts` like the chat catalog |
| `src/server/media-call.ts` | one careful way to call the media host (key in `Authorization` only, idle timeout, size cap, abort), multipart build/read, the anonymous opener for signed links |
| `src/server/media-jobs.ts` | video jobs per user: `<user root>/nanovia/media-jobs.json` (atomic, at most 100) and `<user root>/nanovia/media/<id>.mp4` |
| `src/server/media-billing.ts` | the billing reconciler (injectable timers) |
| `src/server/media-proxy.ts` | the three OpenAI-shaped endpoints of the proxy port |
| `src/server/routes/media.ts`, `media-api.ts`, `media-video.ts` | the admin routes, their shared helpers, the video job logic |
| `src/server/media.ts` | builds the services into `deps.media` (`MediaTuning` shrinks timeouts and delays in tests) |

### Hosts and key

`config.mediaBase` (`NANOVIA_MEDIA`, default `https://api.nano-gpt.com`, no path) is the only host a media call goes to, and the
key goes there in the `Authorization` header and nowhere else. The chat upstream (`upstreamBase`, which carries `/api/v1`) is a
different base and does not carry over; there is no fallback host (the website host rejects bodies over about 4.5 MB). The model
lists are fetched from the same base without a key. A video file is downloaded from the signed link NanoGPT hands out WITHOUT the
key (the link is public for its day, and a URL from an answer never receives credentials). Paths used: `GET /api/v1/images/models`,
`/api/v1/video-models?detailed=true`, `/api/v1/audio-models?type=tts|stt&detailed=true`, `POST /v1/images/generations`,
`POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /api/generate-video`, `GET /api/video/status?requestId=`,
`GET /api/v1/usage/requests/{id}`.

### Admin routes (all under `/api/plugins/nanovia`)

`GET /media/catalog?medium=&refresh=`, `POST /media/image|tts|stt|video`, `GET /media/video`, `GET|DELETE /media/video/:id`,
`GET /media/files/:id`. A request is validated first (`domain/media-request.ts`: bad body `400 invalid_request`, inputs over 4 MB
in total `413 payload_too_large`, a model that is not in the catalog of its medium `400 invalid_request`, no catalog data at all
`502 media_unavailable`), then called with the key of `keyId` or the active one (`409 no_key`). `X-Billing-Mode: paygo` is sent
when `billing` is `paygo` (whether NanoGPT honours it on media is unverified). Timeouts are idle timeouts (restarted by every
chunk): images 180 s, speech 120 s, transcription 180 s, video submit 30 s, status 20 s, file download 60 s; a miss is `504
upstream_timeout`, an unreachable NanoGPT `502 upstream_unreachable`.

Upstream errors keep NanoGPT's own words under a contract code: 400 content policy `400 content_policy_violation` (not charged),
402 `402 insufficient_balance` (the amount NanoGPT asked for is in the message when it gave one), 429 `429 rate_limited`, 413 `413
payload_too_large`, 408/504 `504 upstream_timeout`, everything else `502 upstream_error` (including 401/403: ST's front end reads
those statuses as "log in again"). All three error shapes are read (OpenAI envelope, legacy `{ error: "text", requiredBalance }`,
plain text such as the video route's `Invalid session`); the text is cleaned of markup and of the key.

The image route uses the OpenAI-compatible endpoint, always asks for `b64_json` and handles `url` too (the answer is never fetched).
The speech answer's own content type is what the result carries (live: `audio/x-wav` for a requested mp3; never assumed). The
transcription route builds the multipart body itself and asks for `verbose_json` (segments) only where the model's list offers it.

### Cost model

Every media call writes a usage record (`medium`, `units`, `costUsd`, `costSource`; no tokens). `byMedium` in `GET /spend` is
present only when the range holds a media record, so a chat-only log sums exactly as before.

| medium | units | first figure | corrected by |
| --- | --- | --- | --- |
| image | images made | the body's `cost` (`costSource: 'response'`): the LIST price, which can understate the charge (live: 0.0017 in the body, 0.00255 billed) | the billing lookup (below), `costSource: 'lookup'` |
| speech | characters (code points) | catalog price x characters (`'estimate'`): the answer has neither a cost nor a request id (live: exact list price) | nothing to look up |
| transcription | seconds of audio | the body's `usage.cost` (`'response'`, live: exact) | nothing |
| video | seconds requested | the submit answer's `cost` (the estimate / pre-charge) | the final `cost` of the completed status (`'response'`); a failed job is adjusted to 0, assuming the documented automatic refund |

**Reconciliation** (`media-billing.ts`): after an image call with a request id (the `X-Request-ID` header, else the body's
`requestId`) the plugin looks up `GET <mediaBase>/api/v1/usage/requests/{id}` with the same key: first try about 15 s later, then
after 30 s, 60 s, 120 s and 240 s while NanoGPT answers 404 ("not ready", which never means zero), 408/425/429/5xx or cannot be
reached; it stops at 401/403/409, a figure in another currency, or after the fifth try. A figure is appended as an `adjust` line
`{ adjust: true, requestId, costUsd, costSource: 'lookup', at }` to the usage file of the DAY OF THE RECORD; `usage-log.ts`
`read()` applies adjustments (`domain/media-wire.ts applyUsageAdjustments`: the latest wins, a paygo media record's
`equivalentUsd` follows), so `GET /spend` and `GET /usage/recent` already see the corrected figure. The schedule lives in memory
and is gone with the process: best effort; a call nobody could reconcile keeps the body's figure. The key waits in memory (as the
opaque `SecretValue`) until the lookup is done or given up and is never written.

### Video

`POST /media/video` submits (`202` with a `runId`), stores the job and answers a `VideoJob`. NanoGPT is asked about a job that
is not finished only when the browser asks the plugin (`GET /media/video/:id`) and the last poll is at least 3 s old (simultaneous
polls share one call); the status is read in both documented shapes (uppercase `data.status` + `data.output.video.url` +
`data.cost`, or flat lowercase `status` + `progress` + `videoUrl`); an unknown status word changes nothing. On completion the
plugin downloads the file (200 MB cap, streamed to a `.part` file and renamed, never through a path made of client input) and
serves it as `GET /media/files/:id` with `Range` support, to the same user only (the link is fetched as NanoGPT gave it, http(s)
only, and a path on the media host is resolved against `mediaBase`). Failures are tolerated: an unreachable NanoGPT leaves the job as it was,
a download that fails is retried on later polls (three tries, then the error is reported once), a link that is gone ends the job
as `expired`, a job NanoGPT no longer knows (five 404s after the first minute) or one nobody finished within a day ends too.
A job that nobody polls advances no further: if the browser stays closed past NanoGPT's retention (about a day) the file can be
lost (`expired`). Jobs are per ST user and survive a plugin restart (the jobs file is reloaded, unfinished ones are polled again;
the poll timestamps are not kept). **There is no cancel upstream: `DELETE /media/video/:id` only forgets the job and its file
here, it never calls NanoGPT.**

### Proxy endpoints (the connection token, on the proxy port)

`POST /c/<id>/v1/audio/speech` (JSON, the audio bytes come back as they arrive with the upstream content type), `/v1/audio/transcriptions`
(multipart, forwarded unchanged, upstream JSON back) and `/v1/images/generations` (JSON, the upstream JSON back unchanged), behind
the same token check as chat. A dedicated handler (`media-proxy.ts`), not the chat pipeline, whose steps assume a JSON chat body.
The model comes from the request body. The request body is read with a cap and answered `413` beyond it (speech 2 MB, images
8 MB, a recording 4 MB + 256 KB), by its declared length before anything is read or while it streams in; no body is buffered without
bound (a streamed speech answer is relayed chunk by chunk, JSON answers are held up to 64 MB / 8 MB to read the cost). The reply
carries the upstream status, content type and bytes, `X-Nanovia-Connection`, `X-Nanovia-Cost` when a cost is known (speech: the
catalog estimate; images: the body figure; transcription: `usage.cost`) and `X-Nanovia-Request-Id` when there is one; errors are in
the OpenAI envelope (a legacy or plain-text answer is wrapped, retry-after passes). A client that hangs up aborts the upstream
call (the record says `client_aborted`, status 499). A connection with `billing: paygo` sends `X-Billing-Mode: paygo`.

### Verified live, and not

Verified with a real key (the probe of 2026-11-23, about half a cent): the image body shape and `X-Request-ID` on both image
routes, the body cost being the list price while the lookup and the balance show the charge (1.5x for `rev-animated`), the
billing lookup for media request ids about 15 s later, speech answering raw bytes with the model's own content type and no
request id, transcription answering `{ text, language, duration, usage }` with no request id, the plain-text 401 of the video
submit. **NOT verified, all taken from the docs: everything about video** (submit and status shapes, `progress`, final cost,
the download link, refunds, any model), whether `X-Billing-Mode` is honoured on media, whether other image models also bill
1.5x, whether `verbose_json` and `diarize` are accepted on the OpenAI-compatible transcription route (they are sent only where
the model's list offers them), whether `duration` may be an integer (it is sent as a string, like the docs show), `url` image
outputs, an async speech answer. This code was developed and tested against `tools/mock-nanogpt` only (see its README).

### Normalising the lists (decisions the browser should know)

- `ParamSpec.key` is the upstream request field. Image `resolutions` become `size`, `max_images` / `fixed_image_count` become
  `n`; limit-like keys (prompt length, input constraints …) are not settings. For transcription the extra keys `input_format`
  (accepted file types, lower case) and `file_size_mb` (the smallest size limit) describe the recording.
- The `type=tts` list carries speech, music/sound generation and audio processing: speech keeps `capabilities.music: false`,
  prompt-driven music and sound generation `music: true`, and entries that take no text or answer no audio (processing, lyrics,
  analysis) are DROPPED (nothing a speech call can drive). The `type=stt` list has four voice-cloning ids: they are kept and flagged
  `capabilities.voiceCloning: true`, the browser should hide them from a transcription picker.
- `MediaPrice.unit: 'unknown'` keeps the list's own block in `raw`; video prices reduce to per-second (by resolution), per-video or
  per-duration where the shape allows, and `priceIsApproximate` is true when another price-moving key exists (multipliers, audio on or
  off, per-mode tables); `estimateVideoCost` then answers null (the submit answer's cost is shown instead). An image estimate falls
  back to the cheapest listed price when the size is not named.

### Mock

`tools/mock-nanogpt` serves the four lists (the trimmed live entries in `tools/fixtures/media`), image generation on all three paths
with the list price in the body and a billing lookup that answers 1.5x for `rev-animated`, speech as WAV with `audio/x-wav` and no
request id, transcription, and video with both status shapes selectable (`POST /__mock/state { media: { videoShape } }`). It models
the live probe where there is one and the docs where there is not; it is not evidence about NanoGPT.
