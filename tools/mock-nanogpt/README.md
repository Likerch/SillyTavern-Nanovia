# Mock NanoGPT

A dependency-free stand-in for `https://nano-gpt.com`, used by the tests and the local stand. Plain Node ESM.

```bash
npm run mock                   # http://127.0.0.1:5300/api/v1   (MOCK_PORT or --port to change)
node tools/mock-nanogpt/server.mjs --port 0 --quiet
```

In code: `const mock = createMockServer(); const port = await mock.listen(0); … await mock.close()`; `mock.state` is the live
state, `mock.catalog` the loaded fixtures, `mock.media` the media lists. Start the plugin with `upstreamBase:
http://127.0.0.1:5300/api/v1` and, for the media routes, `mediaBase: http://127.0.0.1:5300` (the media host has no path and no
fallback: `NANOVIA_MEDIA`, `tools/stand` sets it).

## Data

`tools/fixtures/catalog.json`: 61 real models (a snapshot of `GET /api/v1/models?detailed=true` kept for roleplay: DeepSeek
V4/V4.1, GLM 5.x, MiMo V2.6, Kimi K3/K3.1, Gemini 4/3.8, Claude 5.x, Grok 4.x, Qwen 3.8, Hy4, MiniMax M3, Aion 3.5, RP
finetunes, venice-uncensored, pqhaz heretic) plus 8 `mock/` models that exercise one branch each (subscription basic,
subscription reasoner with `none`, reasoning that cannot be switched off, paid premium, `structured-unsupported`,
`no-selection`, uncensored RP, `paused`). `tools/fixtures/providers/<safe-id>.json`: providers responses of 13 real and 5
mock models; any other catalog model gets a deterministic synthetic response, a model without a `providers` list answers
"no provider selection" (`supportsProviderSelection: false`, `providerDetails: []`, like the real service does for
Claude, venice-uncensored and some others). `node tools/fixtures/refresh.mjs` refetches the public endpoints (no key needed);
`--offline` rebuilds only the mock entries.

`tools/fixtures/media/*.json`: the four media lists as NanoGPT serves them (real entries, 24 image, 30 video, 30 TTS and 13
STT models, chosen by `node tools/fixtures/trim-media.mjs <snapshotDir>` to cover every price and parameter shape of the full
lists, 264/222/101/24 models on 2026-11-23). The domain tests read the same files.

## Routes

| Route                                                                                                                   | Notes                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/models[?detailed=true]`                                                                                    | public; ids only, or the full catalog entries                                                                                                         |
| `GET /api/models/<url-encoded id>/providers`                                                                            | public; snapshot, synthetic, or 404 for an unknown id                                                                                                 |
| `POST /api/v1/chat/completions`                                                                                         | key; stream and non-stream; see below                                                                                                                 |
| `POST /api/check-balance`                                                                                               | key; `usd_balance`, `nano_balance` as strings                                                                                                         |
| `GET /api/subscription/v1/usage` (alias `/api/v1/subscription/usage`)                                                   | key; quotas and `routing.recommendedMode`                                                                                                             |
| `GET /api/v1/usage`, `GET /api/v1/usage/requests/:id`                                                                   | key; aggregates and one recorded charge (404 for unknown id or another key)                                                                           |
| `GET /api/v1/images/models` (`/api/v1/image-models`), `/api/v1/video-models`, `/api/v1/audio-models?type=tts\|stt\|all` | public; the trimmed media lists (envelope `{ object: "list", data, meta }`)                                                                           |
| `POST /v1/images/generations`, `/api/v1/images/generations`, `/api/v1/images`                                           | key; tiny PNG as `b64_json` (or a `url` with `response_format: "url"`), cost = list price, `X-Request-ID` = body `requestId`                          |
| `POST /v1/audio/speech` (+ `/api/v1/...`), `POST /v1/audio/transcriptions` (+ `/api/v1/...`)                            | key; WAV bytes as `audio/x-wav`; multipart `file` + `model` in, `{ text, language, duration, usage }` out                                             |
| `POST /api/generate-video`, `GET /api/video/status?requestId=`, `GET /api/generate-video/content`                       | key (a refusal is the plain text `Invalid session`); submit 202 + `runId`, status over successive polls, the file link is public                      |
| `/api/management/v1/*`                                                                                                  | `Authorization: Bearer sk-nano-mgmt-…`; api-keys CRUD (create needs `Idempotency-Key`), model-presets CRUD, `subscription/usage`; **no CORS headers** |
| `GET /__mock/requests[?path=&limit=]`, `POST /__mock/reset`, `GET\|POST /__mock/state`, `GET /__mock/health`            | the mock's own helpers                                                                                                                                |

Everything outside `/api/management` answers with `Access-Control-Allow-Origin: *`, echoes `Access-Control-Request-Headers`
and exposes `X-Request-ID`. Every reply carries a fresh `X-Request-ID`.

Keys: `sk-nano-<8+ chars>` or `x-api-key`. Missing key: 401 `missing_api_key`; malformed: 401 `malformed_api_key`; a
Management token on an inference route: 401 `invalid_api_key`. Management tokens carry their scopes in the name:
`sk-nano-mgmt-usage…` reads usage only, `…keysread…` / `…presetsread…` read only, `…expired…` / `…revoked…` are rejected
(401 `invalid_management_token`), anything else holds all scopes (403 `insufficient_scope` otherwise). A `write` scope
includes its `read`; `usage:read` stands alone (a keys token does not read usage). Use fakes like `sk-nano-mgmt-TESTTOKEN`.

## Management API

`/api/management/v1` follows NanoGPT's published contract (`https://nano-gpt.com/management-openapi.json`, version
2026-09-09-beta): the same fields, ranges and status codes, and the `{ error: { code, message, request_id, details } }`
envelope. After every start and every `POST /__mock/reset` it holds fixed data:

- keys: `1` "Nanovia main" (USD caps 5/20/50), `2` "Roleplay capped" (request and subscription caps, expires 2099, zdr),
  `3` "Old test key" (expired, `daily_usd_limit: 0`, legacy `unset` policy); a created key gets id `4`;
- presets: `rp-fast` and `analyst` (with `thinking`, `prompt_caching` and structured outputs).

Rules it enforces: `Idempotency-Key` (8 to 200 characters) on key creation, a replay answers `Idempotent-Replayed: true`;
limits are `null` or inside the documented range (USD in steps of 0.0001); `PATCH` needs a field and `null` clears;
preset names match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$` and come back lower-case; `PUT` replaces a whole preset; at most 100
presets (409), bodies up to 16 KiB (413). Codes the docs name are used as named (`model_preset_not_found`,
`invalid_preset`, `invalid_preset_name`, `preset_limit_reached`); the others (`idempotency_key_required`,
`invalid_request`, `not_found`, `payload_too_large`) are guesses, the docs leave them open. `x-mock-error` (401, 429, 500, 503) answers in this envelope too, with `Retry-After` on 429 and 503.

## Chat behaviour

- Usage appears only when asked: `usage: { include: true }`, `stream_options.include_usage`, `include_usage`, or `caching: true`.
  `usage` holds `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`, `cost`, `currency`; `x_nanogpt_pricing` holds `cost`, `inputTokens`,
  `outputTokens`, `cacheCost`, `paymentSource`, `requestId`, `isEstimate`. Streams end with a usage-only chunk before `[DONE]`.
- Cost is 0 and `paymentSource: 'subscription'` for models whose catalog entry says `subscription.included`, unless the
  request has `X-Billing-Mode: paygo` (or body `billing_mode`), an `X-Provider` header or a `provider` object (those
  bill the host's price or the list price + 5%), or the subscription quota is used up. Paid requests are deducted from the
  balance; at 0 they answer 402 `insufficient_balance`.
- Reasoning models return `message.reasoning` / `delta.reasoning`; `reasoning.exclude` or `include_reasoning: false` hides
  the text. `reasoning.effort: 'none'` switches reasoning off only where the model lists `none`; a `:thinking` id or suffix always reasons.
- A trailing `:suffix` that is not a catalog id (`:online`, `:memory-7`) is echoed in `model` and listed in the
  `X-Mock-Applied-Suffixes` response header. Unknown model: 404 `model_not_found`.
- `mock/structured-unsupported` + `response_format`: 400 `model_response_format_unsupported`. `provider.data_collection: "deny"`: 400. `mock/paused`: 503 `model_not_available`. `max_tokens` below the reply: `finish_reason: "length"`.

## Media behaviour (stage 7)

Modelled on the live probe of 2026-11-23 (`docs/research/media-live-probe.md`) wherever it saw something; video follows the docs only.

- **Images**: the body's `cost` is the model's list price (the exact size, else the cheapest; times `n`), `paymentSource: "USD"`;
  the answer's `X-Request-ID` is `media-image:<uuid>:<epoch-ms>:<suffix>` and the same string is `requestId` in the body.
  `GET /api/v1/usage/requests/<that id>` answers what was BILLED: 1.5x the list price for one model (`rev-animated`, as seen live),
  the list price for every other. The balance is charged the billed amount. A prompt containing `forbidden` is refused
  (400 `content_policy_violation`), a model that is not in the list is 404 `model_not_found`, an empty balance is the legacy
  402 `{ error: "Insufficient balance", requiredBalance, status }`.
- **Speech**: always WAV (`audio/x-wav`, 8 kHz 8-bit mono, 0.25-5 s depending on the input length), whatever `response_format` was
  asked, and **no `X-Request-ID`**; cost = characters x the model's per-1k price (or its per-generation price).
- **Transcription**: multipart `file` (+ `model`, `language`, `response_format`); the length of a WAV comes from its header
  (else 1 s per 16 kB, or `x-mock-duration`), `usage.cost` = that length x the model's per-minute price; `verbose_json` adds
  `segments`, `text` answers plain text; **no `X-Request-ID`**. The request log keeps the text fields and the size of each file,
  never the recording.
- **Video**: submit answers 202 `{ runId, id, status: "pending", model, cost, paymentSource, remainingBalance, prechargeLabel }`
  and charges the estimate. Each `GET /api/video/status?requestId=` is one step: queued, running, then (after
  `videoPollsToComplete` polls, default 3) completed with the file link and the final cost (the estimate x 1.1) in the guide
  shape; `failed` (and a refund) for a prompt containing `failjob` or an `x-mock-video-fail` header on the submit. Another key
  gets the legacy 404 `{ error: "Video generation request not found" }`. The link (`/api/generate-video/content?runId=...`) needs
  no key and serves a 4 kB `video/mp4`-typed file with a counting pattern.
- **Switches** (`POST /__mock/state`, also read back by `GET`): `billingMisses: N` (the next N billing lookups answer 404 with
  `Retry-After: 30`), and under `media`: `videoShape: "guide" | "flat"` (the status in the guide's shape, uppercase
  `data.status` + `data.output.video.url` + `data.cost`, or the OpenAPI's flat lowercase `status` + `progress` + `videoUrl`; a
  request can override it with `x-mock-video-shape`), `videoPollsToComplete`, `videoRelativeUrl` (the link is a path on the
  mock), `videoContentGone` (the file answers 404, as after the retention day), `lookupFactorModel` / `lookupFactor`.

## Test headers

`x-mock-error: 401|402|429|500|502|502-empty` forces that error after authentication (also `401-text`: the plain text `Invalid
session`, `402-legacy`: `{ error: "Insufficient balance", requiredBalance, status }`, `400-policy`: a content-policy refusal in
the OpenAI envelope: the three error shapes of the real service); `x-mock-delay-ms` delays the reply;
`x-mock-chunk-delay-ms` slows a stream; `x-mock-reply` (URL-encoded) sets the reply text; `x-mock-cached-tokens` sets
`cached_tokens`. The request log marks a request the client dropped with `aborted: true`.
`POST /__mock/state` takes `{ balanceUsd, nanoBalance, paidSpendAllowed, subscription: { active, dailyLimit, weeklyLimit,
dailyUsed, weeklyUsed } }`.
