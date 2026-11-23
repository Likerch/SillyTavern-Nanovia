# Media: live probe with a real key (2026-11-23)

One session, about half a cent. DeepSeek-style cheap models only; video was NOT probed (expensive). Everything below was
observed first-hand; it settles items 1, 3, 12 of the "unverified" list in `media-api.md` §8 and corrects some of its
assumptions. No key or token appears here.

## Image: `POST https://api.nano-gpt.com/v1/images/generations` and `POST https://api.nano-gpt.com/api/v1/images`

- Both answered HTTP 200 with the same body shape:
  `{ created, data: [{ b64_json }], cost, paymentSource, remainingBalance, requestId }` (model `rev-animated`, 512x512,
  `n: 1`; the OpenAI route with `response_format: 'b64_json'`, the new route with no format given also returned
  `b64_json`). 512x512 came back at roughly 48-65 KB of base64.
- Response header `X-Request-ID: media-image:<uuid>:<epoch-ms>:<suffix>` on both. The body's `requestId` is the same string.
- Latency 3.6-7 s for a cheap model.
- **The body `cost` understates the charge.** List price 0.0017 USD; body `cost` 0.0017; billed 0.00255 (1.5x), shown by
  `GET /api/v1/usage/requests/{id}` (`cost: "0.00255"`, `currency: "USD"`, `cost_scope: "primary_charge"`, token fields
  null / `input_tokens: 0`) and confirmed by the account balance (before 4.99049012, after 4.98534946: two images at
  0.00255, one TTS call at its exact list price, one STT call at its exact list price). The body's `remainingBalance`
  moved by 0.0017 after the first image and by 0.00255 after the second, so it is also unreliable.
- The billing lookup works for media request ids, about 15 s after the call (`as_of` ~30 s after creation).

## TTS: `POST /v1/audio/speech` (model `Kokoro-82m`, voice `af_bella`, `response_format: mp3`)

- HTTP 200, `Content-Type: audio/x-wav`, 92 KB for "Hello there, friend." (the requested mp3 was NOT honoured: trust the
  response content type, never the requested format).
- No `X-Request-ID` and no cost header or field. The charge matched the list price exactly (20 characters x 0.0017 / 1000).
  The cost therefore has to be computed from the catalog price (`MediaCost.source: 'estimate'`) or read back from the
  per-key aggregate; there is no per-request lookup for TTS.

## STT: `POST /v1/audio/transcriptions` (multipart `file`, model `qwen/qwen3-asr-0.6b`)

- HTTP 200 JSON: `{ text, language: 'auto-detect', duration: 2, usage: { seconds: 2, type: 'duration', cost: 0.00000666, currency: 'USD' } }`.
  The cost is in the body (and equals the list price for 2 s). No `X-Request-ID`. Latency 3.3 s.
- The transcript was correct ("Hello, there, friend.") when fed the TTS output.

## Balance

- `POST https://nano-gpt.com/api/check-balance` with `x-api-key`: `usd_balance` (string), `usd_pending_usage`,
  `usd_pending_usage_status`, `usd_spendable_balance` (number), `nano_balance`, `nanoDepositAddress`.

## Consequences for the build

1. Image cost: record the body figure at once (`costSource: 'response'`), then reconcile from the billing lookup
   (retry after ~15 s, a few times) and write an `adjust` line to the usage log. Show both numbers in the UI.
2. TTS cost: estimate from the catalog price x characters; mark `source: 'estimate'`. STT: body `usage.cost`.
3. TTS/STT have no request id: the usage record's `requestId` is null for them.
4. Output content type comes from the response; the plugin must pass it through (ST's own OpenAI-compatible TTS provider
   forces `audio/mpeg`, which is a problem only for ST, not for Nanovia).
5. Still unverified: video (submit/status shapes, cost, cancel), whether `X-Billing-Mode` is honoured on media, whether
   models other than `rev-animated` have the same 1.5x factor (it may be the account's markup on that model or a
   per-model list-price lag; the lookup is authoritative either way).
