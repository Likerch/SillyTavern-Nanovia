# Nanovia

**English** | [Русский](README.md)

NanoGPT as a first-class, OpenRouter-like provider in SillyTavern: per-connection routing, subscription vs pay-as-you-go awareness, a model catalog, usage and cost, and a bridge to Maestro and the other extensions. Targets ST 1.19.x.

> Status: 0.7.0, stages 0.1–0.7 are done (plugin and proxy, connections, routing and billing, catalog, account and usage, Management API, diagnostics, media). Next: an image provider for NAI Studio (0.8). Checked against the mock and live against the real NanoGPT (requests, streaming, balance, subscription, images, speech, transcription).

## The panel

Tabs: **Connections** (the connection form, model picker over the catalog), **Catalog** (prices, context, capabilities, "in subscription", hosts and routing hints), **Routing** (every `provider` field and which of them move a request off the subscription), **Keys** (several NanoGPT keys), **Management** (Management API: keys with limits, model presets), **Media** (catalog and studios for images, speech, transcription and video), **Account** (balance, subscription quota, usage: real cost apart from the pay-as-you-go equivalent), **Diagnostics** (checks of the whole setup with one-click fixes), **General**.

## What it is

A **connection** is a named bundle: model, routing, reasoning, billing, cache, search, memory, key. In ST it shows up as an ordinary Connection Manager profile, so every consumer can pick it: the chat, Qvink, and the background tasks of Maestro, Dramatis, Localizer and Officina.

### The hybrid

Two parts; the extension also works without the second:

- **Server plugin** (`server/index.js`): a local OpenAI-compatible proxy on its own port (default `127.0.0.1:8787`) plus admin routes under `/api/plugins/nanovia`. It keeps the NanoGPT key in ST's secret store, builds the upstream request (routing, reasoning, billing), reads usage and cost, and keeps the usage log.
- **Browser extension** (`dist/index.js`): the panel, the connection <-> Connection Manager profile sync, a request hook, the public `NANOVIA_API`, and the bridges to Maestro and the neighbours.

Connection modes: `plugin` (the profile points at the proxy), `direct` (the profile points at NanoGPT and the browser hook builds the request), `auto` (the plugin when it answers, otherwise direct). There is no silent fallback: price and quantisation could change unnoticed.

## Install

Details, including a production server and Docker, in [`docs/DEPLOY.md`](docs/DEPLOY.md) (Russian).

1. **Extension:** SillyTavern -> Extensions -> Install extension -> `https://github.com/Likerch/SillyTavern-Nanovia`. The built `dist/` is in the repository.
2. **Plugin (optional, needed for `plugin` mode):** copy `server/index.js` and `server/package.json` into `<SillyTavern>/plugins/nanovia`; `scripts/install-server.ps1` (Windows) or `scripts/install-server.sh` (Linux/macOS/Docker host) does it.
3. Set `enableServerPlugins: true` in `config.yaml` (or env `SILLYTAVERN_ENABLESERVERPLUGINS=true`) and restart ST.
4. Add your NanoGPT key to ST's secrets (API Connections -> NanoGPT, or the Nanovia panel).

The proxy port is internal: do not publish it.

## Quick start

1. Open the Nanovia panel and add your NanoGPT key.
2. Create a connection: pick a model, routing and a reasoning policy. A `Nanovia · <name>` profile appears in Connection Manager.
3. Select that profile in the chat or in the background-task settings of the neighbouring extensions.

The panel and connections arrive with stage 1; until then steps 1-3 describe the target flow.

## Development

```bash
npm ci
npm run check          # types, lint, tests
npm run mock           # mock NanoGPT at http://127.0.0.1:5300/api/v1
npm run build          # dist/ and server/index.js
npm run stand          # local ST 1.19 without Docker + mock + extension + plugin (http://127.0.0.1:8130)
npm run stand:stop
npm run test:live      # live check against the real NanoGPT (needs NANOVIA_LIVE_KEY; the key is never stored)
npm run deploy:local   # copy the build into a local ST (st-local-docker)
```

- `tools/mock-nanogpt/`: the mock NanoGPT (streaming chat, usage and cost, catalog, providers, balance, subscription, Management API); see `tools/mock-nanogpt/README.md`.
- `tools/fixtures/`: a snapshot of the real catalog (61 roleplay-relevant models) and providers plus the `mock/*` models; `npm run fixtures:refresh` refetches it from the public endpoints.
- `tools/stand/`: the local stand; `scripts/`: deploy and plugin install.
- Architecture and layers: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Contracts: `src/shared/contracts.ts`.

## Stages

| Stage | Version | Content                                                                                                | Status  |
| ----- | ------- | ------------------------------------------------------------------------------------------------------ | ------- |
| 1     | 0.1.0   | skeleton, plugin + proxy, connections <-> profiles, modes, mock                                        | done    |
| 2     | 0.2.0   | routing (all provider fields), billing impact + subscription-safe mode, reasoning policy, several keys | done    |
| 3     | 0.3.0   | catalog, host statistics, routing hints                                                                | done    |
| 4     | 0.4.0   | balance, subscription, usage and cost, cache, OpenRouter-style response shim                           | done    |
| 5     | 0.5.0   | full `NANOVIA_API`, Maestro and neighbour integrations                                                 | done    |
| 6     | 0.6.0   | Management API, web search, Context Memory, Doctor                                                     | done    |
| 7     | 0.7.0   | media                                                                                                  | done    |
| 8     | 0.8.0   | NAI Studio image provider                                                                              | planned |

Changelog: [`CHANGELOG.md`](CHANGELOG.md) (Russian).

## License

AGPL-3.0-only, see [`LICENSE`](LICENSE). Author: Likerchik.
