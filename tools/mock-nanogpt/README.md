# Mock NanoGPT

A dependency-free stand-in for `https://nano-gpt.com`, used by the tests and the local stand. Plain Node ESM.

```bash
npm run mock                   # http://127.0.0.1:5300/api/v1   (MOCK_PORT or --port to change)
node tools/mock-nanogpt/server.mjs --port 0 --quiet
```

In code: `const mock = createMockServer(); const port = await mock.listen(0); … await mock.close()`; `mock.state` is the live
state, `mock.catalog` the loaded fixtures. Start the plugin with `upstreamBase: http://127.0.0.1:5300/api/v1`.

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

## Routes

| Route                                                                                                        | Notes                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/models[?detailed=true]`                                                                         | public; ids only, or the full catalog entries                                                                                                         |
| `GET /api/models/<url-encoded id>/providers`                                                                 | public; snapshot, synthetic, or 404 for an unknown id                                                                                                 |
| `POST /api/v1/chat/completions`                                                                              | key; stream and non-stream; see below                                                                                                                 |
| `POST /api/check-balance`                                                                                    | key; `usd_balance`, `nano_balance` as strings                                                                                                         |
| `GET /api/subscription/v1/usage` (alias `/api/v1/subscription/usage`)                                        | key; quotas and `routing.recommendedMode`                                                                                                             |
| `GET /api/v1/usage`, `GET /api/v1/usage/requests/:id`                                                        | key; aggregates and one recorded charge (404 for unknown id or another key)                                                                           |
| `POST /api/v1/images/generations`, `POST /api/v1/images`                                                     | key; stubs returning one tiny base64 PNG                                                                                                              |
| `/api/management/v1/*`                                                                                       | `Authorization: Bearer sk-nano-mgmt-…`; api-keys CRUD (create needs `Idempotency-Key`), model-presets CRUD, `subscription/usage`; **no CORS headers** |
| `GET /__mock/requests[?path=&limit=]`, `POST /__mock/reset`, `GET\|POST /__mock/state`, `GET /__mock/health` | the mock's own helpers                                                                                                                                |

Everything outside `/api/management` answers with `Access-Control-Allow-Origin: *`, echoes `Access-Control-Request-Headers`
and exposes `X-Request-ID`. Every reply carries a fresh `X-Request-ID`.

Keys: `sk-nano-<8+ chars>` or `x-api-key`. Missing key: 401 `missing_api_key`; malformed: 401 `malformed_api_key`; a
Management token on an inference route: 401 `invalid_api_key`. Management tokens carry their scopes in the name:
`sk-nano-mgmt-usage…` reads usage only, `…keysread…` / `…presetsread…` read only, `…expired…` / `…revoked…` are rejected
(401 `invalid_management_token`), anything else holds all scopes (403 `insufficient_scope` otherwise).

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
  the text. `reasoning.effort: 'none'` switches reasoning off only where the model lists `none` and is not a `:thinking` id.
- A trailing `:suffix` that is not a catalog id (`:online`, `:memory-7`) is echoed in `model` and listed in the
  `X-Mock-Applied-Suffixes` response header. Unknown model: 404 `model_not_found`.
- `mock/structured-unsupported` + `response_format`: 400 `model_response_format_unsupported`. `provider.data_collection: "deny"`: 400. `mock/paused`: 503 `model_not_available`. `max_tokens` below the reply: `finish_reason: "length"`.

## Test headers

`x-mock-error: 401|402|429|500|502|502-empty` forces that error after authentication; `x-mock-delay-ms` delays the reply;
`x-mock-chunk-delay-ms` slows a stream; `x-mock-reply` (URL-encoded) sets the reply text; `x-mock-cached-tokens` sets
`cached_tokens`. The request log marks a request the client dropped with `aborted: true`.
`POST /__mock/state` takes `{ balanceUsd, nanoBalance, paidSpendAllowed, subscription: { active, dailyLimit, weeklyLimit,
dailyUsed, weeklyUsed } }`.
