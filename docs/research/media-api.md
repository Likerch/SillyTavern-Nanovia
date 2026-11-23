# NanoGPT media API: engineering spec for Nanovia media stage

Research date: 2026-11-23. Method: read the official docs (llms.txt index plus every media, billing, limits and error page, downloaded as raw .md and read in full), the docs OpenAPI file, and called only PUBLIC UNAUTHENTICATED endpoints (model lists, per-model endpoint metadata, and a handful of empty-body POSTs/GETs without any key that returned 401/404). No key was used, nothing was paid, the `x-x402` quote header was never sent.

## 0. Conventions

Every statement carries one of these tags:

- **DOC[Sn]**: stated in the official docs page Sn (table below). Full URL = `https://docs.nano-gpt.com/` + path + `.md`.
- **LIVE**: observed first-hand on 2026-11-23 from public endpoints (no key). Snapshots saved in `...\scratchpad\live\` (see section 9).
- **INFERRED**: deduced from docs/live data, not stated anywhere.
- **UNVERIFIED**: not documented and not observable without a key; must be tested with a real key.

Doc sources:

| id | path |
|---|---|
| S1 | api-reference/image-generation (Image API guide) |
| S2 | api-reference/endpoint/image-api-generate |
| S3 | api-reference/endpoint/image-api-models |
| S4 | api-reference/endpoint/image-api-model-endpoints |
| S5 | api-reference/endpoint/image-models (legacy list) |
| S6 | api-reference/endpoint/image-generation-openai |
| S7 | api-reference/endpoint/image-edits |
| S8 | api-reference/video-generation (guide) |
| S9 | api-reference/endpoint/video-generation (submit + OpenAPI) |
| S10 | api-reference/endpoint/video-status-unified |
| S11 | api-reference/endpoint/video-recover |
| S12 | api-reference/endpoint/video-content |
| S13 | api-reference/endpoint/video-models |
| S14 | api-reference/text-to-speech (guide) |
| S15 | api-reference/endpoint/speech (v1/audio/speech) |
| S16 | api-reference/endpoint/tts (native /tts + OpenAPI) |
| S17 | api-reference/endpoint/tts-status |
| S18 | api-reference/endpoint/audio-models |
| S19 | api-reference/speech-to-text (guide) |
| S20 | api-reference/endpoint/audio-transcriptions (v1/audio/transcriptions) |
| S21 | api-reference/endpoint/transcribe (native + OpenAPI) |
| S22 | api-reference/endpoint/transcribe-status |
| S23 | api-reference/endpoint/request-billing |
| S24 | api-reference/miscellaneous/rate-limits |
| S25 | api-reference/miscellaneous/error-handling |
| S26 | api-reference/miscellaneous/api-hosts |
| S27 | api-reference/miscellaneous/webhooks |
| S28 | api-reference/miscellaneous/billing-override |
| S29 | api-reference/endpoint/subscription-usage and api-reference/management-api |
| S30 | integrations/sillytavern |
| S31 | authentication |
| S32 | api-reference/music-generation |
| S33 | api-reference/miscellaneous/inline-moderation |
| S34 | api-reference/miscellaneous/pricing |
| S35 | api-reference/endpoint/usage |

Live catalog sizes at 2026-11-23T17:08Z (LIVE): image models 264, video models 222, audio models 125 (101 returned by `type=tts`, of which only 39 have `capabilities.text_to_speech`; 36 are music; 24 returned by `type=stt`). Doc examples show other counts (169, 201); never trust them.

## 1. Cross-cutting

### 1.1 Hosts and paths
- Use `https://api.nano-gpt.com` for API-key calls. It has the higher request-size limit and longer runtime. The website host `https://nano-gpt.com` rejects request bodies over ~4.5 MB with HTTP 413 and is only needed for IPv6-only clients. DOC[S26]
- The two hosts can have different model catalogs during rollouts. DOC[S26]
- SillyTavern's built-in NanoGPT sources always call `https://nano-gpt.com/api/v1` (website host, lower limits). DOC[S30]
- Path spellings: OpenAI-compatible routes are documented both as `/api/v1/...` and `/v1/...` (e.g. `POST https://api.nano-gpt.com/v1/images/generations`). DOC[S1,S6]. Native routes live under `/api/...` (`/api/generate-video`, `/api/tts`, `/api/transcribe`). DOC[S8,S16,S21]
- Model-list endpoints are served with `Cache-Control: public, s-maxage=3600` and `Access-Control-Allow-Origin: *`. LIVE. Docs call them cacheable and say not to hardcode capabilities. DOC[S5,S13,S18]

### 1.2 Auth
- `Authorization: Bearer <key>` (recommended) or `x-api-key: <key>`. Key format `sk-nano-<uuid>`, legacy plain UUID also accepted. DOC[S31]
- Model-list endpoints work with no key. DOC[S3,S5,S13,S18], LIVE (all returned 200 without credentials).
- `GET /api/v1/images/models/{id}/endpoints` also works with no key. DOC[S4], LIVE.
- Video submit also accepts a cookie session; the OpenAPI declares only `x-api-key` for native routes. DOC[S8,S9]
- A key rejected repeatedly gets 429 `authentication_rate_limited` with `Retry-After`. DOC[S25]

### 1.3 Error shapes (three coexist)
1. OpenAI envelope `{ "error": { "message", "type", "code", "param" } }` on most `/api/v1/*`. DOC[S25]. LIVE: `/api/v1/images`, `/api/v1/images/generations`, `/api/v1/audio/speech`, `/api/v1/audio/transcriptions` all returned 401 with `code: "missing_api_key"` in this envelope (note `type` is `invalid_request_error` on the image routes but `authentication_error` on audio routes).
2. Legacy `{ "error": "string", ... }`, e.g. 402 `{ "error": "Insufficient balance", "requiredBalance": 0.0035, "status": 402 }`. DOC[S25]. LIVE: `GET /api/video/status?requestId=bad` returned 404 `{"error":"Video generation request not found"}`; `GET /api/tts/status?runId=x&model=y` returned 404 `{"error":"TTS run not found","code":"TTS_RUN_NOT_FOUND"}`.
3. **Non-JSON**: LIVE `POST /api/generate-video` without a key returned 401 `text/plain` body `Invalid session`. The proxy must not blindly `res.json()` on error.
- The OpenAPI "Error" schema in the docs says `{ error: integer, message: string }`. That does not match anything observed. DOC[S6,S9,S16,S21] vs LIVE.
- Status codes: 400 validation, 401, 402, 403, 404, 408/504, 409, 413, 429 (honor `Retry-After`), 500, 503. Retry only 408/429/500/503. DOC[S25]
- Blocked content: `content_policy_violation` returns 400 and is "intended" not to be charged. DOC[S25]. Video: refunds issued automatically on failure/policy violation/submit failure. DOC[S8]

### 1.4 Request ids and per-request billing lookup
- `X-Request-ID` is a response header on inference responses (documented for chat). `Access-Control-Expose-Headers` on the model lists includes `X-Request-ID`. LIVE. DOC[S23,S25]
- `GET /api/v1/usage/requests/{request_id}` (same key, 24 h rolling window, 60/min per key and 300/min per IP, first lookup ~2 s after completion, 404 carries `Retry-After: 30`): returns `{ object: "request_billing", request_id, created_at, expires_at, as_of, cost (decimal STRING), currency ("USD"|"XNO"), cost_scope: "primary_charge", usage: { input_tokens, output_tokens, reasoning_tokens } (nullable ints) }`. Excludes refunds and separately billed extras. 404 never means zero cost; 409 `ambiguous_request_id` if the id was reused. DOC[S23]
- The doc says other endpoints are covered "only when they persist that identity and key attribution". **Whether image/video/TTS/STT responses carry `X-Request-ID` and are covered by this lookup is not documented. UNVERIFIED.** Token fields would presumably be null for media (INFERRED).
- `x_nanogpt_pricing.requestId` appears only in the chat fallback context. DOC[S23]. Not documented for media.
- Media job ids are separate: video `runId` format `vid_...` DOC[S9]; TTS `runId` UUID-shaped DOC[S16 example]; STT `runId` opaque (`abc123def456` example) DOC[S21].
- Aggregate alternative that is documented: `GET /api/v1/usage?from=YYYY-MM-DD&to=...&group_by=day|model|day,model` returns `costUsd`, `refundedUsd`, `netCostUsd`, `requests`, token totals per day/model for the calling key (60/min per key). DOC[S35]. Whether media spend shows up there is INFERRED yes ("billable usage requests"), not stated.
- You may send your own `X-Request-ID` (must be unique per execution, charset `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`); it is a correlation id, not an idempotency key. DOC[S23]. For chat the docs advise omitting it. Media behaviour UNVERIFIED.

### 1.5 Cost reporting summary (details per medium below)
| medium | where cost appears | DOC/LIVE |
|---|---|---|
| image (OpenAI route) | body: `cost` (number), `paymentSource` (string), `remainingBalance` (number) | DOC[S6 OpenAPI] |
| image (`/api/v1/images`) | response shape not documented | UNVERIFIED (INFERRED same as above) |
| video | submit 202 body `cost` (estimate/pre-charge), `paymentSource`, `remainingBalance`, `prechargeLabel`; status `data.cost` when COMPLETED (final) | DOC[S8,S9] |
| TTS `/api/tts` | JSON body `cost`, `currency`; async ticket `cost`, `paymentSource`; binary replies carry no cost | DOC[S16,S17] |
| TTS `/v1/audio/speech` | binary audio, no cost in body; billing = input characters x price | DOC[S15]; headers UNVERIFIED |
| STT `/api/transcribe` | `metadata.cost`, `metadata.currency`, `chargedDuration` (minutes) | DOC[S21] |
| STT `/v1/audio/transcriptions` | body only `text`, `language`, `duration` | DOC[S20] |

- `currency`/`paymentSource`: values `USD` or `XNO` (video OpenAPI: "USD or XNO"); the unit of the image `cost` number is not stated (INFERRED: same currency as `paymentSource`). Request-billing returns the exact amount as a decimal string; the media bodies return JSON numbers.
- Public list prices are USD (`pricing.currency`). LIVE
- Forcing pay-as-you-go: header `X-Billing-Mode: paygo` (also `x-billing-mode`) or body `billing_mode` / `billingMode` = `paygo|pay-as-you-go|pay_as_you_go|paid|payg`; body wins; documented as applying to "all endpoints". DOC[S28]. Effect on media UNVERIFIED. CORS allow-list also names `x-nanogpt-billing-mode`. LIVE
- A key set to "Subscription only" cannot spend balance. DOC[S28]

### 1.6 Subscription vs pay-as-you-go for media
- Subscription usage endpoint reports `dailyImages` (an image quota, "counts images"), `dailyInputTokens`, `weeklyInputTokens`, `routing.recommendedMode` (`subscription|paygo|unavailable`). DOC[S29]. It does not mention video, TTS or STT quotas.
- Model-list `subscription` object (`{ "included": false }`) appears on only 11 of 222 video models and 6 of 125 audio models, never on image models (all `included:false`). LIVE. Meaning of absence: UNVERIFIED. Which image models consume the `dailyImages` quota: UNVERIFIED. Some audio models list `payment_modes: ["account_balance"]` (balance only). LIVE
- Zero Data Retention does not cover image generation/editing, video, or 3D: those requests still run when ZDR-only routing is on, and providers may store prompts, inputs and outputs. DOC[S1,S2,S6,S7,S8,S9]. Video/audio model entries carry `zero_data_retention` (false on all that have it). LIVE

### 1.7 Rate limits (media)
- No global RPS limit; limits depend on endpoint/billing/account; always honor `Retry-After`. DOC[S24]
- Documented numbers relevant to media: `POST /api/generate-video` 50/min per IP; `GET /api/generate-video/recover` 20/min per IP; `GET /api/video/status` no explicit limit (cached); billing lookup 60/min per key. DOC[S8,S11,S23]
- No numbers are documented for image, TTS or STT generation (only the error code `rate_limit_exceeded`). The subscription burst limits "16 at once, 60 a minute" are stated in a general paragraph and read as text-oriented. DOC[S24]. Media applicability UNVERIFIED.
- Per-key caps (requests/USD/input-token units, daily/weekly/monthly UTC windows) return 429 with codes like `api_key_rpd_limit`, `api_key_usd_limit`, `api_account_monthly_usd_limit` and `type: "rate_limit_error"`. DOC[S24]
- Request-body size: website host ~4.5 MB; direct host application limit is stated (32 MiB) only for chat/responses/messages JSON; media-route limits are per endpoint (below). DOC[S26]

### 1.8 Webhooks (video only)
- `callback_url` (https, <=2048 chars, public host) on `POST /api/generate-video`, API key only, requires a signing secret created in the web Settings (browser session only, `whsec_...`). Events `video.generation.completed|failed|cancelled|expired` with `data.id` = runId, `data.status` = `completed|failed|canceled|timed_out`. Standard Webhooks signing. Delivery can fail or repeat; polling remains authoritative. Jobs untracked after ~8 days. DOC[S27]
- Not usable from a local-only plugin (needs a public HTTPS endpoint and a browser-created secret). INFERRED. Plan on polling.

### 1.9 Optional: inline moderation
- Opt-in paid input preflight via request header `moderation: true|1|yes|on` (or a model id), supported on `/api/v1/images/generations`, `/api/v1/images/edits`, video, chat. Flagged input: only the moderation check is charged, generation skipped. Response headers `x-nanogpt-inline-moderation-model`, `-flagged`, `-cost-usd`. API key only. Default off. DOC[S33]

## 2. Image generation

### 2.1 Endpoints
| # | method + path | body | status |
|---|---|---|---|
| I1 | `POST /api/v1/images` | JSON only (`invalid_content_type` otherwise) | "normalized" Image API, docs say new integrations should prefer it. DOC[S1,S2] |
| I2 | `POST /api/v1/images/generations` (also `/v1/images/generations`) | JSON | OpenAI-compatible, remains supported. DOC[S1,S6] |
| I3 | `POST /api/v1/images/edits` and `/api/v1/images/edit` | multipart/form-data or JSON | OpenAI-compatible edits, both aliases. DOC[S7] |
| I4 | `GET /api/v1/images/models` | none | new catalog. DOC[S3], LIVE |
| I5 | `GET /api/v1/images/models/{modelId}/endpoints` | none | per-model public pricing/limits; ids contain slashes, use the `endpoints` path from I4. DOC[S4], LIVE (200 without key for ids with and without slashes) |
| I6 | `GET /api/v1/image-models[?detailed=true\|false]` | none | legacy catalog; `detailed` default true. DOC[S5], LIVE |
| I7 | `POST /api/nsfw/image` | | out of scope (binary NSFW classification of up to 10 images). DOC[llms.txt, api-reference/endpoint/nsfw-image] |

Auth for I1-I3: bearer or `x-api-key`. DOC[S2,S7]. LIVE: I1 and I2 without key -> 401 `missing_api_key`.

### 2.2 I1 request body (`POST /api/v1/images`) DOC[S1,S2]
| field | type | notes |
|---|---|---|
| `model` | string, required | id from I4; missing -> 400 `missing_model` |
| `prompt` | string, "usually" required | model dependent; 19 live models have `prompt_length.status="not_applicable"` (INFERRED: upscalers/utility) |
| `n` | integer | output count; normalized to `nImages`; if both sent, `nImages` wins |
| `resolution` | string | model-specific token (see 2.6) |
| `aspect_ratio` | string | only on models listing it |
| `quality` | string | e.g. `low|medium|high|xhigh|max` on GPT Image 2.5/2.6 |
| `output_format` | string | `png|jpeg|webp` (2.6 also `gif`) |
| `background` | string | GPT Image 1/1.5/2.5/2.6: `auto|opaque|transparent`; transparent needs png/webp |
| `seed` | integer | model-specific hint, no determinism guarantee |
| `input_references` | array | image-to-image; each entry is an https URL string, a `data:` URL string, or `{ "type": "image_url", "image_url": { "url": "..." } }` |
| model-specific | | e.g. `complexity`, `markup`, `frame_count`, `frame_duration_ms` for GPT Image 2.6; discover via `supported_parameters` |

Rejections (all 400, body `{ error: { message, type: "invalid_request_error", code, parameter }, code }`; note the key is `parameter` here, `param` elsewhere): `missing_model`, `invalid_content_type`, `invalid_input_references`, `conflicting_image_inputs` (mixing `input_references` with legacy `imageDataUrl`, `imageDataUrls`, `image_url`, `images`), `unsupported_stream` (`stream:true`), `unsupported_provider_options` (non-empty `provider`). DOC[S1,S2]

- **Response body of I1 is not documented** (neither S1 nor S2 has a response section). UNVERIFIED; INFERRED to resemble I2.
- Limits for I1 input refs come from model metadata: `input_image_constraints.route` = min 8x8, max 16384x16384, `max_bytes` 31457280 (30 MiB), formats png/jpeg/webp (LIVE, 29 variants differing only by `max_items`). DOC[S1] shows the same numbers for the 2.5 Flare example.

### 2.3 I2 request body (OpenAI-compatible) DOC[S6]
| field | type / range | notes |
|---|---|---|
| `prompt` | string, required | |
| `model` | string, optional | "set it explicitly"; default model unspecified |
| `n` | int, default 1 | cap per model = `supported_parameters.max_images` |
| `size` | string | model-specific; use a token from `supported_parameters.resolutions` (`1024x1024`, `1376x768`, `auto`, `1k`, aspect ratios, etc.) |
| `response_format` | `b64_json` (default) \| `url` | `url` = signed URL, 24 h; may silently fall back to `b64_json` if upload fails |
| `user` | string | end-user id |
| `imageDataUrl` | string | single input image, must be a base64 data URL; remote URLs "not supported" on this route |
| `imageDataUrls` | string[] | multi input (flux-kontext, gpt-4o-image, gpt-image-1 named) |
| `maskDataUrl` | string | inpainting mask data URL; white = region to edit (OpenAPI text) |
| `strength` | number 0-1, default 0.8 | img2img |
| `guidance_scale` | number 0-20, default 7.5 | |
| `num_inference_steps` | int 1-100, default 30 | |
| `seed` | int | |
| `kontext_max_mode` | bool | flux-kontext |
| `quality`, `output_format`, `output_compression` (int 0-100, jpeg/webp only), `background` | | GPT Image family (`gpt-image-1`, `-1.5`, `-2`, 2.5/2.6 Flare+Sunburst); `background` not supported by `gpt-image-2` |

- Also GPT Image 2.6: `complexity` `low|medium|high` (default high), plus `size`/`image_size`/`resolution` accepting explicit pixel sizes like `1536x1024`, `width`+`height`, `auto`. DOC[S1]
- Upload limit: uploads should be <= 4 MB after encoding. DOC[S6]. (Contradicts 30 MiB route preflight on I1; see section 7.)
- **Response 200**: `{ created: int, data: [ { b64_json: string } | { url: string } ], cost: number, paymentSource: string, remainingBalance: number }`; each `data[i]` has exactly one of the two keys. Signed URLs expire after 24 h, stored image deleted ~1 day. DOC[S6]
- SillyTavern docs state outputs over roughly 3.5 MB (e.g. 4K PNG) come back as `url` even when inline base64 is expected. DOC[S30]. So the proxy must handle `url` and `b64_json` on every response.
- 402 for insufficient balance. DOC[S6 OpenAPI]; accountless Lightning quote only when header `x-x402: true` is sent without a key (not relevant for a keyed plugin). DOC[S6,S25]

### 2.4 I3 edits DOC[S7]
- Multipart fields: `prompt` (required), `image` (file | URL | data URL) or repeated `image[]`, `mask` (file, "inpainting-capable models"), `model` (default: an edit-capable model), `size`, `n`; other generation params may pass through.
- JSON variant: `model`, `prompt`, `imageDataUrl`, `imageDataUrls`, `maskDataUrl`.
- Response follows generation conventions: `{ created, data: [ { url | b64_json } ] }`.
- Errors: `missing_image_input`, `image_input_too_large`, `invalid_multipart_body`, `rate_limit_exceeded` ("too many image edit uploads"). "Strict" multipart size limits, number not given.
- Doc recommendation: `openai/gpt-image-2.5/flare/edit` for unmasked natural-language edits; `gpt-image-2` is "the compatibility choice" when a mask is sent.
- Accountless quote works for JSON only; multipart needs auth. DOC[S7]

### 2.5 Image-to-image / references / inpainting / masks (summary)
- I1: `input_references` (URL, data URL, image_url object). GPT Image 2.5/2.6 (flare, sunburst): up to 16 refs, same model id as text-only; refs auto-select edit mode; **masks not supported**; regional edits use a transparent-PNG `markup` annotation applied to the first input image (`max_pixels` 16777216). DOC[S1], LIVE
- I2/I3: `imageDataUrl(s)` (+ `maskDataUrl` / `mask`). DOC[S6,S7]
- Capability flags per model: `capabilities.image_to_image` (LIVE true on 178/264), `capabilities.inpainting` (LIVE true on exactly 1: `flux-lora/inpainting`, described as "Requires an image and mask"), `supported_parameters.max_input_images` (present on 155; values 1,2,3,4,5,6,7,9,10,14,16), `input_image_constraints`. The inpainting flag does not cover `gpt-image-2` although S7 says it accepts masks (see section 7).
- `architecture.modality` LIVE: `text+image->image` 159, `text->image` 86, `image->image` 19.

### 2.6 Parameter tokens and the shape of `supported_parameters` (image) LIVE
`supported_parameters` is NOT one uniform schema. LIVE observed key set, with presence out of 264:
`max_prompt_characters` 264 (int on 73, else null), `prompt_length` 264, `resolutions` 264 (string[]), `max_images` 264, `max_output_images` 264, `max_input_images` 155, `input_image_constraints` 155, `aspect_ratio` 48 (string[]), `fixed_image_count` 20, `output_format` 9, `min_prompt_characters` 5, `topaz_model` 4, `max_output_pixels` 4, `quote_source_dimensions` 4, `quality` 3 (array on 2, object with `values/default/steps` on 1), `seed` 3 (object on 2, `true` on 1), `rendering_speed` 3, `negative_prompt` 2 (boolean), `complexity` 2, `gif` 2, `output_compression` 2, `background` 2, `markup` 2, `loras` 2, and one-offs (`upscale_factor`, `image_size`, `num_inference_steps`, `guidance_scale`, `enable_prompt_expansion`, `thinking_level`, `enable_web_search`, `system_prompt`, `bloom_creativity`, ...).
- `resolutions` token forms LIVE: `WxH` (782 occurrences), `W*H` with an asterisk (189, e.g. `2048*2048` on `hidream-o1-image`), `auto` (70), `1k`/`1.5k`/`2k`/`4k`/`8k`, bare aspect ratios (`16:9`, `20:9`, `19.5:9`), presets (`square_hd`, `portrait_4_3`, `landscape_16_9`, `scale`). Pass the token exactly as listed. Whether the asterisk form is accepted in `size` as written: UNVERIFIED.
- `per_image` price keys do not always equal `resolutions` (e.g. `pixelwave` prices 14 sizes, lists 9). LIVE
- **The documented "enum/range" parameter shape (`{type:"enum", values, default}`, `{type:"range", min, max}`, `input_references` entry) in S1/S3/S4 was NOT observed on the live `/api/v1/images/models`**; live entries use the legacy shape above (see section 7).
- Community SDXL/Pony/Illustrious models (e.g. `cyberrealistic-pony-v9`, `wai-illustrious-sdxl`, `pixelwave`; `capabilities.nsfw: true`) advertise only `resolutions`, `max_images` (20), `max_input_images` (1), `max_prompt_characters` (3000, unit `utf16_code_units`). No negative prompt, steps, CFG or sampler are advertised. Whether I2/I1 accept `negative_prompt`, `num_inference_steps`, `guidance_scale`, `seed` on these models: UNVERIFIED (S6 lists steps/guidance/seed as "model-specific"; `negative_prompt` is not in any documented request schema).

### 2.7 Image pricing representation LIVE (+DOC[S1,S4])
- Catalog: `pricing: { per_image: { <resolutionToken>: usd, ... }, currency: "USD" }` on all 264. Extra keys on a few: `billing` (`actual_usage` on 3: `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`, `nano-banana-2.1`; `started_megapixel_blocks` on 4 Topaz upscalers), `token_rates_per_million`, `estimate_note`, `per_megapixel`, `per_image_with_references`, `included_reference_images`, `extra_reference_image_per_output`, `lora`, `tariffs`, `starting_at`, `by_rendering_speed`.
- For `actual_usage` models the catalog figure is an estimate (square, high quality, the most expensive aspect ratio); real charge settles from returned token usage; quotes add conservative allowances. DOC[S1]
- Per-model endpoint metadata (I5) LIVE: `{ id, endpoints: [ { provider_name, provider_slug, provider_tag (null), supported_parameters, allowed_passthrough_parameters ([]), supports_streaming (false), pricing: [ { billable: "output_image", unit: "image", cost_usd, currency, resolution } ], public_pricing: {...same as catalog pricing}, input_reference_constraints, capabilities } ] }`. One endpoint per model. DOC[S4] states pricing is public NanoGPT pricing, not at-cost.
- No cost-quote endpoint without paying exists for images. (`pricing.quote_endpoint` appears on 4 Topaz entries; its target was not documented. UNVERIFIED)

### 2.8 Image limits, timeouts, retention
- Prompt length: `supported_parameters.max_prompt_characters` plus `prompt_length { status: known|unknown|not_applicable (counts LIVE: 73/172/19), unit: unicode_code_points|utf16_code_units|null, trim_whitespace }`.
- Outputs per request: `max_images` (LIVE distribution: 4 on 118 models, 1 on 71, 20 on 34, 8 on 23, 10 on 8 ...); `fixed_image_count` on 20 means `n` is not variable.
- GIF (GPT Image 2.6): docs say `frame_count` 2-64 (default 9) DOC[S1]; live metadata says min 2, max 16, default 9. LIVE. Trust the live metadata.
- No server-side timeout is documented for image generation. `streaming` unsupported (always false). DOC[S1,S3]
- Output URL: signed, 24 h, file deleted ~1 day. DOC[S6]. Prompt metadata embedding is a web-app download feature only; API images come back as the model made them. DOC[S35 image-prompt-metadata]

## 3. Video generation

### 3.1 Endpoints
| # | method + path | purpose |
|---|---|---|
| V1 | `POST /api/generate-video` | submit job (JSON), asynchronous. DOC[S8,S9] |
| V2 | `GET /api/video/status?requestId=<runId>` (alias `runId=`) | unified status; no `model` param. DOC[S8,S10] |
| V3 | `GET /api/generate-video/status` | deprecated legacy status. DOC[S8,S9] |
| V4 | `GET /api/generate-video/recover?model&limit&conversationUUID` | list recent runs (limit default 10, max 50). DOC[S11] |
| V5 | `GET /api/generate-video/content?runId&model&variant&expires&sig` | serves stored video; `variant` = `video` (default); Sora 2 also `thumbnail`, `spritesheet`. DOC[S12] |
| V6 | `GET /api/v1/video-models[?detailed=]` | catalog. DOC[S13], LIVE |
| - | **cancel** | **No cancel endpoint is documented.** Statuses `CANCELED` / event `video.generation.cancelled` exist, so jobs can end cancelled, but there is no documented way to request it. UNVERIFIED. |

### 3.2 V1 request (JSON; unknown keys ignored but some models fail with extra media fields) DOC[S8,S9]
Core: `model` (required), `prompt` (conditional), `negative_prompt`, `duration` (seconds as STRING `"5"`, `"8"`; Veo2 uses `"5s"` in the guide), `seconds` (Sora: `"4"|"8"|"12"`), `aspect_ratio` (`16:9`, `9:16`, `1:1`, `3:4`, `4:3`, `21:9`, `auto`), `orientation` (`landscape|portrait`), `resolution` (`480p|580p|720p|1080p|1792x1024|2k|4k`), `size`, `mode` (`text-to-video|image-to-video|reference-to-video|video-edit`, some models also `auto`, `video-extend`), `generateAudio` (bool, Veo 3 / Lightricks), `enhancePrompt`, `pro_mode`/`pro`, `enable_prompt_expansion`, `enable_safety_checker`, `camera_fixed|camera_fix|cameraFixed`, `seed` (number|string; send omitted/blank/`-1` for random on "returned seed" models), `cfg_scale` 0-1 (Kling) / OpenAPI 0-20, `num_frames`, `frames_per_second` 5-24, `num_inference_steps`, `conversationUUID`, `callback_url`.
Media inputs: `imageDataUrl` (base64 data URL) or `imageUrl` (public HTTPS), `image`/`image_data_url` aliases, `referenceImages[]`, `referenceVideos[]`, `reference_image`, `videoUrl` / `videoDataUrl` / `video`, `audioUrl` / `audioDataUrl` / `audio`, `audioDuration`, `voiceId`, face-swap `swapImage`/`targetVideo`/`targetFaceIndex`.
- **Uploads via the API must be <= 4 MB**; larger assets must be hosted externally and passed as URLs. DOC[S8,S9]. A local plugin has no public URL for ST-local images, so base64 <= 4 MB is the practical path. INFERRED
- `imageAttachmentId` / `videoAttachmentId` are web-app only; API refuses with 400 `attachment_id_not_supported` before any charge. DOC[S8,S9]
- Extend models need prompt + source video, max source length 120 s. DOC[S8]
- Seedance 1.5 Pro Extend retired: HTTP 410 `model_unavailable`, no auto-substitution. DOC[S8]
- LongStories models (`longstories-*`) use a very different structured payload (`script`, `storyConfig`, `scriptConfig`, `imageConfig`, `videoConfig`, `voiceoverConfig`, ...). DOC[S9]. Out of scope for a first pass.
- The authoritative per-model parameter list is the catalog's `supported_parameters.parameters` (section 6.2). The keys there are the literal request keys, including inconsistent casing (`generateAudio` vs `generate_audio`, `imageUrl`, `lastImageUrl`, `reference_images`). INFERRED from key names matching the doc tables; `aliases` arrays on descriptors list accepted alternates (e.g. `videoUrl` -> `video`, `video_url`, `videoDataUrl`). LIVE

### 3.3 V1 response (HTTP 202) DOC[S8,S9]
```
{ runId: "vid_...", id: "vid_..." (same), status: "pending", model, cost, paymentSource: "USD"|"XNO",
  remainingBalance, prechargeLabel, seed? (only "returned seed" models) }
```
Errors: 400 invalid params / safety, 401, 500; 402 insufficient balance; 410 retired model; guide error shape `{ error: { message, type }, refundMessage }` with types `CONTENT_POLICY_VIOLATION`, `PRO_REQUIRED`, `INSUFFICIENT_BALANCE`, `RATE_LIMITED`; webhooks page documents `{ error: "...", code, param }` for video callback errors (`invalid_callback_url`, `webhook_signing_secret_required`, `callback_url_requires_api_key`, `webhook_limit_exceeded` 429, `webhooks_unavailable` 503). DOC[S8,S27]. LIVE: unauthenticated -> 401 `text/plain`.

### 3.4 Polling V2
- Docs example: poll every 5 s, up to 120 attempts (~10 min); send the same key that submitted the job; another account's job or no key -> 404. DOC[S8,S10]
- Exceptions where the job id alone suffices: x402-paid jobs, jobs with no job record, and the `statusUrl`/`eventsUrl` returned for some private models (24 h). DOC[S10]
- **Two incompatible response shapes are documented:**
  - Guide/examples (S8, S10 examples): `{ requestId, model, data: { status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED"|"FAILED"|"CANCELED", requestId, details?, output: { video: { url }, expiresAt? }, cost, error, isNSFWError, userFriendlyError } }`.
  - OpenAPI schema (S10): flat `{ requestId, seed?, status: "queued"|"processing"|"completed"|"failed"|"cancelled"|"unknown", progress (0-100|null), estimatedTimeRemaining (s|null), videoUrl, error, createdAt, completedAt }`.
  - Neither could be checked live without a key. UNVERIFIED which is real; robust client: read `status` from `data.status ?? status`, normalize case, accept `cancelled|canceled`, read URL from `data.output.video.url ?? videoUrl`. Guide also lists intermediate states `queued|processing|generating|delivering` (persist, do not treat as terminal). DOC[S9]
- Terminal states: completed, failed, canceled. Timed-out jobs surface as `timed_out` in webhooks. DOC[S27]
- URL form: either NanoGPT content route `/api/generate-video/content?...` with `expires` + `sig` (works without key for 24 h; re-poll for a fresh one; or fetch with the creating account's key), or a provider-hosted URL that can expire sooner. NanoGPT keeps stored videos about a day (`output.expiresAt` for most). **The proxy must download and persist the file itself.** DOC[S10,S12]
- V4 recover response: `{ data: [ { runId, id, model, status, createdAt, conversationUUID } ] }`; useful to rebuild state after a plugin restart. DOC[S11]. Auth: key (20/min per IP).

### 3.5 Video cost reporting, pricing models
- Cost at submit is "estimated/pre-charged"; final `cost` arrives in the status payload when completed ("Duration-based billing is assessed after completion"). Failures and policy rejections are refunded automatically. DOC[S8,S9]
- Some models reserve a ceiling and refund the difference before delivery (e.g. Gemini Omni 1.2 reserves $15; catalog `billing` strings "Reserved up front, unused refunded"). DOC[S8], LIVE
- Catalog `pricing` is heterogeneous, no single price field. LIVE counts of 222: `per_second_by_resolution` 82, `per_second` 28, `per_duration` 13, `per_video` 7, `base_prices_by_resolution` 7, and dozens of one-off keys; `unit` on 34 (`per_video`, `job`, `input_video_second`, ...); about 86 models have none of {`per_second_by_resolution`, `per_second`, `per_video`, `per_duration`, `with_audio`, `fixed_price`, `base_price`}. Do not build a universal estimator; show an estimate only for recognised shapes and always display the returned `cost`.
- Examples LIVE: `kling-v26-pro` `per_duration {"5":0.35,"10":0.7}` with `audio_multiplier: 2`; `veo3-video` `with_audio 4.8`, `without_audio 3.2`, `fixed_duration_seconds 8`; `bytedance/seedance-2.5` `per_second_by_resolution` {480p 0.18, 720p 0.36, 1080p 0.9, 4k 1.8}, `min_duration 4`, `max_duration 30`.

### 3.6 Video limits
- Submit 50/min per IP; recover 20/min per IP. DOC[S8,S11]
- Per-model duration/resolution/aspect options are in the catalog descriptors (`options[]`, `min`, `max`, `step`). LIVE
- Prompt length per model: `max_prompt_characters` (int on 57 of 222, else null) + `prompt_length`. LIVE
- Poll budget recommended by docs: 5 s x 120. DOC[S8]. Hard server timeout: not documented.

## 4. Text-to-speech (and music)

### 4.1 Endpoints
| # | method + path | style |
|---|---|---|
| T1 | `POST /api/v1/audio/speech` (OpenAI-compatible) | synchronous, returns audio bytes; optional `stream:true`. DOC[S15] |
| T2 | `POST /api/tts` (native) | 200 JSON with `audioUrl`, or 200 binary, or 202 async ticket. DOC[S14,S16] |
| T3 | `GET /api/tts/status?runId&model[&cost&paymentSource&isApiRequest]` | poll T2 tickets. DOC[S17] |
| T4 | `GET /api/v1/audio-models?type=tts|stt|all&detailed=` | catalog. DOC[S18], LIVE |
| - | voice cloning: `POST /api/voice-clone/minimax\|qwen` (+ `/status`), also `qwen-voice-clone`/`minimax-voice-clone` model ids on the STT route | out of scope here. DOC[S19,S20] |

Auth T1: bearer or `x-api-key` ("Authorization" shown). LIVE: 401 `missing_api_key` (OpenAI envelope). T2/T3 declare `x-api-key`. DOC[S16,S17]. LIVE: T3 without key returned 404 `TTS_RUN_NOT_FOUND`, so the lookup apparently precedes auth (INFERRED, do not rely on it).

### 4.2 T1 `POST /api/v1/audio/speech` DOC[S15]
Body JSON: `model` (string), `input` (string; TTS text or music prompt), `voice` (string; ignored for music), `response_format` (default `mp3`), `speed` (default 1; e.g. 0.5-2.0), `instructions` (some models), `stream` (bool, default false). Accepted params vary by model.
- Formats: OpenAI models `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm`; ElevenLabs always MP3 (`response_format` ignored); Gemini 3.8 models WAV only (`response_format` if sent must be `wav`, `speed` must be `1`). DOC[S14,S15]
- `stream:true` only for `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `Elevenlabs-Turbo-V2.5`, `Elevenlabs-V3`; all other models ignore it and return buffered audio. Streaming response: `Transfer-Encoding: chunked`, no `Content-Length`; OpenAI models `Content-Type` matches format, ElevenLabs `audio/mpeg`. Failure after bytes started = connection terminated, partial audio. Streaming billing is recorded after the first chunk; client disconnect mid-stream still charges. DOC[S15]
- Gemini 3.8 dialogue: `input` may be an array of turns `[ { text, voice, instructions? } ]`, exactly 2 distinct voices on `google/gemini-3.8-flash-tts` (Flash-Lite is single-speaker), max 100 turns, 8192 bytes after normalization, whole input 8192 tokens; inline tags like `<laugh>`, `<short pause>`; `instructions` are not spoken and not billed. DOC[S14]. Catalog `supported_parameters.turn_input { maxTurns, maxInputBytes, dialogueVoices, singleTurnNarration }`. LIVE
- Response 200: raw audio bytes (`Content-Type` indicates format). Errors OpenAI envelope with `code` values `invalid_model`, `invalid_voice`, `unsupported_format`, `input_too_long`, `rate_limit_exceeded`; 410 `TTS_MODEL_UNAVAILABLE` for retired models (not charged; message names replacements). DOC[S14,S15]
- Retirement date: `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview` stop on 2026-12-18. DOC[S14]. They are still in the live catalog. LIVE
- Max input: model dependent, characters or tokens; docs advise <1-2k characters for interactive use. DOC[S15]. Per-model `max_chars` is in the catalog (see 6.3).
- Billing: by input characters, not output size. DOC[S15]. Cost in the response: none (UNVERIFIED for headers).

### 4.3 T2 `POST /api/tts` DOC[S16 OpenAPI]
Body JSON: `text` (required), `model` (default `Kokoro-82m`; OpenAPI enum lists only Kokoro-82m, Elevenlabs-Turbo-V2.5, tts-1, tts-1-hd, gpt-4o-mini-tts, Minimax-Speech-02-HD/2.6-HD/2.6-Turbo/2.8-HD/2.8-Turbo, Qwen-3-TTS-1.7B, though live catalog has 39), `voice`, `speed` (0.1-5, not for gpt-4o-mini-tts), `response_format` (`mp3|opus|aac|flac|wav|pcm`, OpenAI models only), `instructions` (gpt-4o-mini-tts and tts-1-hd only), ElevenLabs Turbo: `stability` 0-1 (0.5), `similarity_boost` 0-1 (0.75), `style` 0-1 (0), Qwen: `speaker_voice_embedding_file_url`, `reference_text`, `language`, `prompt`.
Responses: 200 JSON `{ audioUrl, contentType, model, text, voice, speed, duration, cost, currency }`; or 200 binary (OpenAI models); or **202** ticket `{ status: "pending", runId, model, charged: true, cost, paymentSource, isApiRequest }` for async models (Elevenlabs family, `Elevenlabs-Music-V1`). Errors 400, 401, 402, 413 (text over model limit), 429, 500, 501 (model not implemented), 410 `TTS_MODEL_UNAVAILABLE` (+ `replacements` array). DOC[S16]
Native char limits in the guide: Kokoro/Elevenlabs 10,000, OpenAI 4,096. DOC[S14]. Live catalog differs (Elevenlabs-Turbo-V2.5 `max_chars` 3000). LIVE

### 4.4 T3 status DOC[S17,S16]
- Query: `runId`, `model` (both required), optional `cost`, `paymentSource`, `isApiRequest` copied from the ticket (helps automatic refunds on provider rejection).
- Responses: pending `{ status: "pending", runId, queuePosition }`; completed `{ status: "completed", audioUrl, contentType, model }`; failed `{ status: "error", error, code?: "CONTENT_POLICY_VIOLATION" }`. Note the failure literal is `error` (video uses `FAILED`, STT uses `failed`).
- Poll every 2-3 s, stop after 2-3 min. **Cancel is not supported** ("Not currently"). DOC[S16]
- Audio URL retention is not documented (UNVERIFIED); download immediately.

### 4.5 Voices
- Catalog gives voices as plain string arrays in `supported_parameters.voices` (39 TTS-capable models). No names, languages, genders or previews. LIVE. Docs: "`GET /api/v1/audio-models?type=tts` lists each model's voices under `supported_parameters.voices`". DOC[S15]
- Sample counts LIVE: Kokoro-82m 33 (docs say 44), tts-1 9, tts-1-hd 9, gpt-4o-mini-tts 13, Elevenlabs-Turbo-V2.5 22 (docs say 46), Gemini 3.8 Flash/Flash-Lite 30, `microsoft/mai-voice-2.1` 97, inworld 66.
- Cloned voices: MiniMax custom voice id used as `voice`; Qwen speaker embedding URL. DOC[S14,S16]

### 4.6 Music through the same route
`POST /api/v1/audio/speech` with a music model: `input` is the prompt, `voice` ignored (send any string for SDK compatibility), response is an audio file (typically MP3), duration set by the model (most ~10-30 s). DOC[S15,S32]. Catalog has 36 models with `capabilities.text_to_music` among the `type=tts` results, so **filter TTS by `capabilities.text_to_speech`, not by `type=tts`**. LIVE

## 5. Speech-to-text

### 5.1 Endpoints
| # | method + path | style |
|---|---|---|
| S-A | `POST /api/v1/audio/transcriptions` | OpenAI-compatible. DOC[S20] |
| S-B | `POST /api/transcribe` | native; sync for most models, async (202) for `Elevenlabs-STT` and voice-clone models. DOC[S21] |
| S-C | `POST /api/transcribe/status` | poll native async jobs (POST with JSON body, unlike TTS/video). DOC[S22] |
| S-D | `GET /api/v1/audio-models?type=stt` | catalog. DOC[S18], LIVE |
| - | `POST /api/youtube-transcribe` | out of scope. DOC[llms.txt] |

### 5.2 S-A `POST /api/v1/audio/transcriptions` DOC[S20]
- Multipart: `file` (required; audio, or video for supported models), `model` (required), `language` (optional; default auto-detect).
- JSON: `{ model, file_url | audio_url, language }`.
- Response documented as `{ text, language, duration }`. Which of OpenAI's `response_format` (`json|text|verbose_json|srt|vtt`), `timestamp_granularities`, `prompt`, `temperature` are honoured is NOT stated in S20; the catalog advertises `response_formats` and `timestamp_granularities` per model, which suggests they are accepted. INFERRED / UNVERIFIED.
- How async models (Elevenlabs-STT) behave on this route (no status endpoint is described for it) is UNVERIFIED.
- Formats: audio MP3, OGG, WAV, M4A, AAC; video (model-dependent) MP4, MOV, AVI, MKV, WEBM. DOC[S20]

### 5.3 S-B `POST /api/transcribe` DOC[S21]
- Multipart: `audio` (file; **field name is `audio`, not `file`**), or `audioUrl`; or JSON `{ audioUrl }`. `model` (default `Whisper-Large-V3`), `language` (ISO 639-1/3 or `auto`), `actualDuration` (minutes as string, for accurate billing), `diarize` (`"true"`/`"false"` strings in multipart, boolean in JSON; Elevenlabs-STT only), `tagAudioEvents` (same; Elevenlabs-STT only).
- Limits in the guide: direct upload <= 3 MB; URL upload up to 500 MB. DOC[S19,S21]. Live catalog: `max_request_body_mb` = 4 and `max_file_size_mb` 500/100/25/10 by model (see 6.4). LIVE
- Sync response 200: `{ transcription, metadata: { fileName, fileSize, chargedDuration (minutes), actualDuration (minutes), language, cost, currency, model } }`.
- Async 202: `{ runId, status: "pending", model, cost, paymentSource, isApiRequest, fileName, fileSize, chargedDuration, diarize }`.
- Errors 400, 401, 402, 413 (use URL upload), 500.

### 5.4 S-C `POST /api/transcribe/status` DOC[S22]
- JSON body: `runId` (required) plus the ticket's `cost`, `paymentSource`, `isApiRequest`, `fileName`, `fileSize`, `chargedDuration`, `diarize` (echoed back).
- Response: `status` = `pending|processing|completed|failed`; on completed: `transcription`, `metadata` (as above), `words[] { text, start, end, type: "word"|"punctuation", speaker_id }`, `diarization.segments[] { speaker, text, start, end }`; on failure `error`. 404 job not found. Poll 5 s, ~60 attempts in docs.
- Cancel: none documented.

### 5.5 STT cost
- `metadata.cost`/`chargedDuration` on S-B; S-A returns only `duration`. Billing is per minute of audio (`pricing.per_minute`), some per second with `billing_increment_seconds`, `rounding`, `minimum_billable_seconds`. LIVE. Voice-clone "STT" ids bill per run. DOC[S19]

## 6. Model-list endpoints: per-model capability fields

Common envelope on all list endpoints (LIVE): `{ object: "list", data: [...], meta: { count, generated_at, filter? } }`. `detailed=false` returns only `id`, `object` ("model"), `created`, `owned_by` per item (image 23 KB, video 20 KB, audio 12 KB vs 324-829 KB detailed); it carries no capabilities, so it is useless for building a UI.

### 6.1 Image (`/api/v1/images/models` is byte-identical per item to `/api/v1/image-models` plus two fields; verified for all 264)
| field | type | meaning |
|---|---|---|
| `id` | string | model id for `model` (may contain slashes) |
| `object` | "model" | |
| `created` | int | unix ts |
| `owned_by` | string | provider label (`flux` 48, `doubao` 20, `qwen` 20, `recraft` 15, `bria` 11, `openai` 11 ...) |
| `name`, `description` | string | |
| `architecture.modality` | string | `text->image` / `text+image->image` / `image->image` |
| `architecture.input_modalities`, `output_modalities` | string[] | |
| `pricing` | object | see 2.7; `per_image` always an object keyed by resolution token |
| `capabilities.image_generation` | bool | all true |
| `capabilities.image_to_image` | bool | 178 true |
| `capabilities.inpainting` | bool | 1 true |
| `capabilities.nsfw` | bool | 37 true ("uncensored / NSFW-capable" DOC[S5]) |
| `capabilities.reasoning` | bool | key on 1 model |
| `supported_parameters` | object | heterogeneous, see 2.6 |
| `icon_url` | string | 249 of 264 |
| `tags` | string[] | 182 of 264 (`text-to-image`, `image-edit`, `nsfw`, `lora`, `4k`, ...) |
| `category` | string | UI grouping, not modality (`image` 186, `More` 59, `Featured` 11, `New` 6, `Tools` 2) |
| `supports_streaming` | bool | only in `/images/models`; always false |
| `endpoints` | string | only in `/images/models`; relative URL of I5 |

### 6.2 Video (`/api/v1/video-models`, 222 items)
| field | type | meaning |
|---|---|---|
| `id`, `object`, `created`, `owned_by`, `name`, `description` | | |
| `architecture.modality` | string | e.g. `text+image->video` 59, `image->video` 35, `video->video` 32, `text+video->video` 24, `image+audio->video` 16, `text->video` only 7 |
| `architecture.input_modalities` / `output_modalities` | string[] | inputs may include `text, image, video, audio` |
| `pricing` | object | heterogeneous, see 3.5; always has `currency` |
| `capabilities.video_generation` | bool | 222 |
| `capabilities.text_to_video` | bool | 125 |
| `capabilities.image_to_video` | bool | 152 |
| `capabilities.video_to_video` | bool | 99 |
| `capabilities.audio_input` | bool | 40 (accepts uploaded audio) |
| `capabilities.audio_generation` | bool | 86 (creates soundtrack; separate from audio_input DOC[S8]) |
| `capabilities.nsfw` | bool | 83 true |
| `capabilities.fps_control` / `start_end_frames` / `deterministic_seed` | bool | keys on 7 / 2 / 2 models; `deterministic_seed` true on none |
| `supported_parameters.max_prompt_characters` | int/null | int on 57 |
| `supported_parameters.prompt_length` | object | same shape as image |
| `supported_parameters.parameters` | object map | UI descriptors keyed by request field name |
| `supported_parameters.defaults` | object | default per field (on 211) |
| `subscription` | `{included:boolean}` | on 11 models, all false |
| `zero_data_retention` | bool | on 11 models, all false |
| `icon_url`, `tags`, `category` (`video` 141, `More` 50, `Avatars` 19, `New` 10, `Video` 2), `label` (`NEW` 98, `Fast` 1, `Easy` 1) | | |

Descriptor (`parameters.<key>`) fields LIVE: `type` (`select` 558, `number` 122, `text` 114, `switch` 91, `string` 86, `boolean` 33, `integer` 9, `array` 7, `object` 1), `label`, `default`, `description`, `options[] { value, label }`, `min`, `max`, `step`, `aliases[]`, `required`, `showWhen` (conditional on another param), `max_items`, `placeholder`, `format`, `enum`, `maxLength`. Most frequent keys: `resolution` 156, `duration` 142, `aspect_ratio` 99, `seed` 74, `mode` 31, `enable_prompt_expansion` 30, `generateAudio` 24, `reference_images` 21, `reference_audios` 19, `imageUrl` 15, `reference_videos` 14, `last_image` 14, `enable_web_search` 13, `generate_audio` 12, `videoUrl` 11, `negative_prompt` 11. Image input for most image-to-video models is implied by `architecture.input_modalities` and is not a descriptor.

### 6.3 Audio TTS (`/api/v1/audio-models?type=tts`, 101 items; 39 real TTS)
| field | meaning |
|---|---|
| `architecture.modality` | `text->audio` 42, `text->music` 32, plus audio-processing shapes |
| `capabilities.text_to_speech` | true on 39 (use this to select TTS) |
| `capabilities.text_to_music` | 36 |
| other capability keys | `voice_cloning`, `turn_array_input`, `instructions`, `ssml`, `word_timestamps`, `preset_voices`, `streaming` (false on the 5 that carry it), `audio_to_audio`, `stem_separation`, ... |
| `pricing` | `per_thousand_chars` (36), `per_generation` (39), `per_second` (21), `minimum` (23), `multiplier_parameter`, billing-interval keys; always `currency` |
| `supported_parameters.voices` | string[] (39 models) |
| `supported_parameters.max_chars` | int (33 models) |
| `supported_parameters.response_format` | `{ values[], default }` only on 4 models (qwen-audio-3.1-*, heygen); absent for OpenAI models although they support 6 formats |
| other `supported_parameters` | `speed {min,max,default}`, `pitch`, `volume`, `sample_rate(s)`, `bit_rate`, `seed`, `language {values,default}`, `instructions {max_length}`, `enable_ssml`, `turn_input`, `stream {delivery}`, `payment_modes`, `min_duration`/`max_duration` (music, 25), `default_voice` |
| `category` | `audio_music` 39, `audio_tts` 38, `audio_processing` 12, `audio_generation` 5, `audio_lyrics` 3, `audio_analysis` 2, `voice_clone` 1, `text_to_speech` 1 |
| `subscription` / `zero_data_retention` | on 2 models |

### 6.4 Audio STT (`type=stt`, 24 items; includes 4 voice-clone ids)
All 24 carry `supported_parameters`: `response_formats` (string[]: `json` only on 15 models, `json,text,verbose_json` on 6, plus `srt,vtt` on 2 (Whisper-Large-V3, whisper-1), `json,text` on 1), `timestamp_granularities` (`segment`/`word`, often `[]`), `max_request_body_mb` (4 on all), `max_file_size_mb` (500 on 11, 25 on 11, 100 on 1, 10 on 1), `supports_remote_url` (true on all), `supported_formats` (uppercase strings, e.g. `MP3`, `OGG`, `WAV`, `M4A`, `AAC`; whisper-1 and gpt-4o-mini-transcribe also `MP4`, `MPEG`, `MPGA`, `WEBM`, `FLAC`), `features` (marketing strings). Optional: `supported_languages` (10 models, ISO 639-3 like `eng`), `max_duration_seconds` (7 models: 120, 600, 3600), `diarize_default`, `tag_audio_events_default`, `keyterms_max`, `language_required`. `capabilities`: `speech_to_text` (24), `diarization` (7), `word_timestamps` (8), `diarization_beta`, `realtime` (false), `language_detection` (false). `pricing.per_minute` (23), `per_second` (3), plus `rounding`, `billing_increment_seconds`, `minimum_billable_seconds`. Four LLM-style ASR models also carry `example {audioUrl, text}`, `context_length`, `max_output_length`. LIVE

## 7. Documentation-vs-reality surprises (build around these)

1. **Image catalog schema mismatch.** S1/S3/S4 show `/api/v1/images/models` with typed parameter specs (`{type:"enum", values, default}`, `{type:"range", min, max}`, `input_references`). LIVE the endpoint returns the same legacy `supported_parameters` as `/api/v1/image-models` (arrays and ad hoc objects) plus `supports_streaming` and `endpoints`. Write a tolerant normalizer; do not assume either schema.
2. **Video status schema conflict** (3.4): `data.status` uppercase + `data.output.video.url` (guide) vs flat lowercase `status` + `videoUrl` (OpenAPI). Accept both.
3. **Three async conventions**: video `GET` poll, success `COMPLETED`, failure `FAILED`; TTS `GET` poll, `completed`/`error`; STT `POST` poll, `completed`/`failed`. Different id params (`requestId|runId`; `runId`+`model`; `runId`+echoed ticket).
4. **Error bodies are not always JSON** (video 401 `text/plain`; legacy `{error:string}` on `/api/*`).
5. **Docs prices are stale for many legacy models.** LIVE list vs doc text: Kokoro-82m $0.0017/1k chars vs $0.001; tts-1 $0.0255 vs $0.015; tts-1-hd $0.051 vs $0.030; Elevenlabs-Turbo-V2.5 $0.102 vs $0.06; gpt-4o-mini-tts $0.01326 vs $0.0006; Elevenlabs-STT $0.051/min vs $0.03; Wizper $0.017 vs $0.01; gpt-4o-mini-transcribe $0.0051 vs $0.003; Gemini 3.8 Flash/Flash-Lite $0.05/$0.03 match. Voice counts also differ (Kokoro 33 vs 44, ElevenLabs 22 vs 46). Treat the live list and the returned `cost` as truth; whether the list price equals the account's billed price (e.g. subscriber or discount pricing) is UNVERIFIED.
6. **GIF frame count** 2-64 (docs) vs 2-16 (live metadata).
7. **Upload limits conflict**: legacy routes and video say <= 4 MB per image; I1 metadata says 30 MiB (31457280) route preflight; STT direct upload 3 MB (guide) vs `max_request_body_mb` 4 (catalog); website host 4.5 MB hard cap. Plan for 4 MB base64 as the safe ceiling and use `api.nano-gpt.com`.
8. **Inpainting flag vs docs**: only `flux-lora/inpainting` has `capabilities.inpainting: true`, but S7 names `gpt-image-2` as the masked-edit model (flag false), and GPT Image 2.5/2.6 explicitly do not support masks. Do not gate mask UI on the flag alone.
9. **Large image outputs come back as `url`** even without asking (SillyTavern doc, ~3.5 MB threshold); `response_format:"url"` can fall back to `b64_json`. Handle both always.
10. **TTS catalog mixes TTS with music/processing**; `type=tts` returns 101 models, 39 are speech. Selecting by `capabilities.text_to_speech` is required. OpenAI TTS models do not advertise their 6 formats in the catalog.
11. **Voice metadata is just names.** No language/gender/preview in any list.
12. Docs OpenAPI for `POST /api/v1/images` and `/api/v1/audio/*` is absent from the docs OpenAPI file (it lists `/v1/images/generations`, `/tts`, `/transcribe`, `/generate-video` only), so field-level schemas for I1, T1, S-A exist only as prose.
13. SillyTavern already ships a NanoGPT image source (ST 1.19.0) that lists models from NanoGPT's image catalog, reads `b64_json`, and defaults to 512x512 which some models reject (GPT Image 2.5 needs >= 1024x1024). DOC[S30]. Overlap with a Nanovia image feature.
14. Webhooks, `callback_url`, and accountless Lightning L402 flows exist but are not suitable for a local, keyed plugin.

## 8. UNVERIFIED / needs a key to confirm (suggested probe list for the first real-key session)
1. `POST /api/v1/images` response body shape; whether it includes `cost`/`paymentSource`/`remainingBalance`; whether it returns `url` or `b64_json` by default; which size field it expects for models whose `resolutions` use `W*H` tokens.
2. Whether `negative_prompt`, `num_inference_steps`, `guidance_scale`, `seed`, sampler are accepted by SDXL community models on I1/I2.
3. Whether image, video, TTS and STT responses carry `X-Request-ID`, and whether `GET /api/v1/usage/requests/{id}` resolves them (and what `cost`/`usage` look like for media).
4. Real video status response shape (guide vs OpenAPI), the `progress` field in practice, typical generation time per model, and whether `output.video.url` is the content route or a provider URL.
5. A way to cancel a video job (none documented).
6. Server-side timeouts for sync image generation on `api.nano-gpt.com`; behaviour when a long call exceeds the proxy timeout (is the charge still applied; recoverable via recover/usage?).
7. Whether `billing_mode`/`X-Billing-Mode` is honoured on media routes; which image/video/TTS/STT models draw from a subscription (`dailyImages` quota) vs balance; effect of `subscription.included` absence.
8. Rate limits for image/TTS/STT and subscription concurrency on media.
9. `POST /api/v1/audio/transcriptions`: honoured `response_format`, `timestamp_granularities`, `prompt`; behaviour for async-only models.
10. Whether list-endpoint prices change when called with a key (subscriber/discount pricing) and which one is billed.
11. `GET /api/tts/status` auth requirement and how long `audioUrl` stays valid.
12. Response headers on `/api/v1/audio/speech` (cost, request id, content-type for music).
13. Exact accepted `duration` type (string vs integer) for models whose descriptor says `integer`.

## 9. Fixtures saved locally (LIVE snapshots, 2026-11-23, no key)
Directory `C:\Users\Liriker\AppData\Local\Temp\claude\b1426a1fc2123d9d\456ce127-973e-42fe-913a-fa3272027c2b\scratchpad\live\` : `images_models.json` (264), `image_models_default.json`, `video_models_default.json` (222), `audio_models_default.json` (125), `audio_models_tts.json` (101), `audio_models_stt.json` (24), `*_nodetail.json`, `ep_*.json` (endpoint metadata samples), `probe_*.body/.hdr` (unauthenticated error probes). Raw docs pages: `...\scratchpad\docs\*.md` and `docs\openapi.json`. These are scratch files and may be cleared; copy anything the build needs into the repo.

## 10. Practical recommendations for the proxy (INFERRED from the above)
- Single upstream base `https://api.nano-gpt.com`; key injected server-side only; forward bearer.
- Catalog: fetch the three lists unauthenticated (or authenticated for subscriber visibility), cache ~1 h (server `s-maxage=3600`), normalize the heterogeneous `supported_parameters`/`pricing` into your own capability model with a "raw" passthrough; select TTS by `capabilities.text_to_speech`, image I2I by `capabilities.image_to_image`/`max_input_images`, uncensored by `capabilities.nsfw`.
- Image: prefer I2 (documented response with `cost`) unless a model needs I1 features (references with URLs, GPT Image 2.6 markup, GIF); always accept `url` or `b64_json`.
- Video: submit, store `runId`, poll V2 every ~5 s with a 10 min budget, tolerate both status shapes, download and persist the file at completion (signed URL 24 h, storage ~1 day), use V4 to resume after restart; show submit `cost` as estimate and final `cost` from the status payload.
- TTS: use T1 for ST playback (bytes in, bytes out; handle `stream` only for the 5 listed models); use T2/T3 only for async ElevenLabs-type flows; remember Gemini 3.8 = WAV only, speed 1.
- STT: use S-A for OpenAI-compatible clients with `file` multipart <= 4 MB; native S-B/S-C for cost metadata and diarization (field name `audio`).
- Cost UI: show list-price estimates per medium from the catalog; record the authoritative cost from each response (`cost` body fields) and optionally reconcile with `/api/v1/usage` daily aggregates; do not depend on the request-billing lookup for media until verified.
