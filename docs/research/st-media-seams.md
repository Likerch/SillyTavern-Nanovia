# SillyTavern 1.19.0: seams for media (image, video, TTS, STT) and what Nanovia can plug into

Source read: `D:\Programming\AI\ST\ST\st-local-docker\src-1.19.0` (read only). Paths below are relative to it.
Abbreviations: SD = `public/scripts/extensions/stable-diffusion/index.js` (client, 5998 lines), SDS = `src/endpoints/stable-diffusion.js`
(server, 2215 lines), OAI = `src/endpoints/openai.js`, SPEECH = `src/endpoints/speech.js`, TTS = `public/scripts/extensions/tts/`.
Nanovia design context was taken from `D:\Programming\AI\ST\ST\SillyTavern-Nanovia\docs\ARCHITECTURE.md`
(proxy on its own listener, base `http://127.0.0.1:<port>/c/<id>/v1`, auth `Authorization: Bearer <token>` or `x-api-key`).

## 0. Findings in one screen

1. NanoGPT already exists in ST 1.19 as an **image** source (`nanogpt`), a chat source, an embeddings source and a caption (vision)
   source. It does **not** exist for TTS, STT or video. The image source has the upstream host hard-coded
   (`https://nano-gpt.com/api`, SDS:1400/1441) and uses ST's `api_key_nanogpt` secret (active secret only). It cannot be pointed at a Nanovia proxy by configuration.
2. The set of SD sources is a closed list (`const sources`, SD:73-98, not exported). An extension cannot add a source. The only
   sources that take a user URL are: `auto`, `vlad`, `drawthings` (root-only URL), `sdcpp`, `comfy`, `comfyrunpod`.
   Of those, **`sdcpp`** (path prefix kept, no auth header, simple JSON in/out) and **`comfyrunpod`** (path prefix kept, `Bearer` key from
   `api_key_comfy_runpod`, async job protocol, can return `.mp4`) are the usable seams.
3. TTS: ST has a real provider seam: `registerTtsProvider(name, Class)` is **exported** from `/scripts/extensions/tts/index.js` (TTS:104-122),
   and a built-in "OpenAI Compatible" provider takes a full endpoint URL plus a secret key (`api_key_custom_openai_tts`) and sends
   `Authorization: Bearer <key>`. This is the cleanest fit with the existing proxy auth.
4. STT: **ST 1.19.0 ships no speech-recognition client at all** (no `public/scripts/extensions/speech-recognition`, no `getUserMedia`/`MediaRecorder`
   anywhere in `public/scripts` outside libs). Only server routes remain (OAI:856-929, SPEECH:42, SPEECH:390) and all of them have hard-coded upstream hosts.
   There is nothing to point at the proxy; Nanovia needs its own mic UI.
5. Video: ST supports video output only through hard-coded sources (OpenAI Sora 2, Google Veo, Z.AI CogVideoX/Vidu, ComfyUI outputs). None takes a
   custom OpenAI-style URL. Display/storage of video in chat is fully supported (`MEDIA_TYPE.VIDEO`, `/api/images/upload` accepts mp4/webm).
6. Network: ST's server-side `fetch` to `http://127.0.0.1:<port>` works by default (private request filter is off by default; loopback is in the default
   allow list; proxy bypass includes 127.0.0.1). Browser-direct calls to the proxy are not an option when ST runs on the VPS.

## 1. Image generation

### 1.1 Client structure (SD)

- Extension: manifest `public/scripts/extensions/stable-diffusion/manifest.json` (`generate_interceptor: "SD_ProcessTriggers"`, hook `activate: init`).
- Exports: only `MODULE_NAME` (SD:67) and `init` (SD:5487). `generatePicture` (SD:2990), `sendGenerationRequest` (SD:3317), `sources` (SD:73) are module-private.
- Flow: `generatePicture` (2990-3095) builds the LLM prompt (`getPrompt`, 3165), emits `event_types.SD_PROMPT_PROCESSING` with
  `{ prompt, generationType, message, trigger }` and reads back `eventData.prompt` (3055-3057), then `sendGenerationRequest` (3317-3451) adds the prefix, negative prompt and
  calls one function from a closed `switch (extension_settings.sd.source)` (3339-3421; no `default`). Result must be `{ format, data(base64) }`; empty `data` -> toast
  "Endpoint did not return image data" (3423-3425). Then `saveBase64AsFile` -> `POST /api/images/upload` (SD:3446, `src/endpoints/images.js:41-73`: `format` must be in
  `MEDIA_EXTENSIONS`, `src/constants.js:528`, which includes mp4/webm/mp3/wav) -> `sendMessage` (SD:4966-4995) pushes a chat message with
  `extra.media=[{url,type,title,generation_type,negative,source:MEDIA_SOURCE.GENERATED}]`, `media_display: gallery`.
- Validity gate: `isValidState()` (SD:5076-5133): custom-URL sources only need the URL string; key-based sources need `secret_state[KEY]` truthy.
- All `fetch` calls go browser -> ST (`/api/sd/...`, `getRequestHeaders()` = JSON + `X-CSRF-Token`) and the ST server calls the upstream. No browser -> upstream calls for images (except legacy `extras`).

### 1.2 Server routes and upstreams (SDS, mounted at `/api/sd`, `src/server-startup.js:169`)

| source | route(s) | upstream | custom URL / path prefix | key (SECRET_KEYS) | what the server sends | response shape to client |
| --- | --- | --- | --- | --- | --- | --- |
| `auto`, `vlad` | `/ping /upscalers /vaes /samplers /schedulers /models /get-model /set-model /generate` (SDS:31-350) | A1111/SD.Next | URL taken from body; `url.pathname = '/sdapi/v1/...'` **replaces the whole path** (SDS:34, 301, 328), so no path prefix | none; `Authorization: Basic base64(body.auth)` (`util.js:126`, auth = "user:pass" field) | whole body incl. `url`,`auth` as JSON to `/sdapi/v1/txt2img` (SDS:327-337); extra GET `/sdapi/v1/options` first (299-313) | raw upstream JSON; client reads `images[0]`, format fixed `png` (SD:3855-3857) |
| `sdcpp` | `/sdcpp/ping`, `/sdcpp/models`, `/sdcpp/generate` (SDS:832-915) | stable-diffusion.cpp server | yes, `urlJoin(url, path)` (SDS:836, 852, 869) so a path prefix is **kept** | none; **no Authorization header at all** (SDS:896-902) | `OPTIONS <url>/v1/images/generations` (ping, must be 2xx); `GET <url>/v1/models`; `POST <url>/sdapi/v1/txt2img` with `{model,prompt,negative_prompt,width,height,steps,cfg_scale,seed,batch_size,sampler_name,scheduler,clip_skip(only if >1)}`, empty values removed (SDS:871-892) | models route returns upstream JSON, client reads `data.data[].id/name` (SD:1835-1837); generate returns upstream JSON, client reads `images[0]`, format `png` (SD:3905-3907) |
| `drawthings` | `/drawthings/*` (SDS:917-1009) | DrawThings app | root only (`url.pathname='/'` and `'/sdapi/v1/txt2img'`) | Basic from `auth` | body minus `url`,`auth` | upstream JSON, `images[0]` |
| `comfy` (standard) | `/comfy/*` (SDS:385-633) | ComfyUI | yes, `urlJoin` | none (the only header ever sent is a Basic on `/interrupt`, SDS:572) | `GET /system_stats`, `/object_info` (needs `CheckpointLoaderSimple`, `UNETLoader`, `KSampler`, `VAELoader` nodes), `POST /prompt` (raw string body, no Content-Type), poll `GET /history/<id>` every 100 ms, `GET /view?...` | `{format: ext of file, data: base64}`; picks first `images` item, else first `gifs` item (SDS:614-627), so a video file works |
| `comfyrunpod` | `/comfyrunpod/ping`, `/generate` (SDS:635-735) | RunPod serverless (ComfyUI worker) | yes, `urlJoin` | `api_key_comfy_runpod`, `Authorization: Bearer <key>` | `GET /health` (must return `{workers:{ready:n}}`, SDS:657), `POST /run` body `{input:{workflow}}` (string body, no Content-Type), poll `GET /status/<id>` every 500 ms until `status.output` exists, then `output.images[0]`; on client abort `POST /cancel/<id>` | `{format: ext of filename, data: item.data}` (SDS:728-729); an `.mp4` filename gives video |
| `nanogpt` | `/nanogpt/models`, `/nanogpt/generate` (SDS:1389-1469) | `https://nano-gpt.com/api/models` (x-api-key) and `https://nano-gpt.com/api/generate-image` | **no**, hard-coded | `api_key_nanogpt` (`SECRET_KEYS.NANOGPT`, `src/endpoints/secrets.js:50`), header `x-api-key`; active secret only, `secret_id` is not honored by any media route | `JSON.stringify(request.body)` **whole body forwarded, no whitelist** (SDS:1443). Client body (SD:4431-4445): `{model,prompt,negative_prompt,num_steps,scale,width,height,resolution:"WxH",showExplicitContent:true,nImages:1}` | only `data.data[0].b64_json` is read (SDS:1458); returns `{image}`; client format fixed `jpg` (SD:4452). Models list = `data.models.image` of `/api/models` as `{value:x.model,text:x.name}` (SDS:1415-1422); no video models |
| `openai` | `/api/openai/generate-image`, `/api/openai/generate-video` (OAI:619-752) | `api.openai.com/v1/images/generations`, `/v1/videos` | no | `api_key_openai` | image: whole body forwarded; video: `{prompt,model,size,seconds}` | image `data[0].b64_json`; video `{format:'mp4',data}` |
| others | `togetherai` 737, `pollinations` 1011 (key `api_key_pollinations`), `stability` 1083, `huggingface` 1143, `electronhub` 1182, `chutes` 1308, `bfl` 1471, `falai` 1591, `xai` 1736, `aimlapi` 1794, `zai` 1878 (image+`generate-video` 1957), `workersai` 2060, `horde` (`src/endpoints/horde.js`), `novel` (`src/endpoints/novelai.js`), `google` (`src/endpoints/google.js:432` image, `:498` video), `openrouter` (`src/endpoints/openrouter.js:138`) | fixed hosts | no (Google/Vertex "proxy mode" reads `body.reverse_proxy`, but the SD client never sends it, SD:4558-4575) | own secret each | various | all return base64 JSON |

There is **no** source that expects an OpenAI-style `POST /v1/images/generations` response from a user URL. `sdcpp` only pings that path with OPTIONS; generation uses the A1111-style `/sdapi/v1/txt2img`.

### 1.3 NanoGPT image source details

- Selecting it: `settings.html:55` option `nanogpt`; hint "save an API key in the NanoGPT (Chat Completion) API settings" (`settings.html:131-133`).
- Samplers/schedulers/VAEs are `['N/A']` for it (SD:1725, 2622, 2745). Steps/CFG/width/height/seed come from the SD UI.
- The `SECRET_*` event handler does not list `nanogpt` (SD:5935-5943), so the model list is not reloaded when the key changes.
- Failure handling is minimal: any upstream error becomes a bare `500` (SDS:1451-1453); the client toast shows only "Internal Server Error". No abort propagation (no `socket.on('close')`).
- The route does not send `Authorization`; NanoGPT is called with `x-api-key`.

### 1.4 Hooks for other extensions

| Seam | Where | Notes |
| --- | --- | --- |
| `event_types.SD_PROMPT_PROCESSING` | `public/scripts/events.js:26`, emitted SD:3056 | async handlers may mutate `eventData.prompt` (read back at SD:3057). Also carries `generationType`, `message`, `trigger`. No event before/after the HTTP request, no event with the final image (only generic `MESSAGE_RECEIVED` with type `'extension'` and `CHARACTER_MESSAGE_RENDERED` from `sendMessage`, SD:4989-4993). |
| `event_types.IMAGE_SWIPED`, `FORCE_SET_BACKGROUND` | `events.js:80`, SD:3020 | swipe over generated images; background mode. |
| `/imagine` (aliases `sd`, `img`, `image`) | SD:5492-5725 | returns the image URL (or empty string). Named args: `quiet, gallery, negative, extend, edit, multimodal, snap, processing, seed, width, height, steps, cfg, skip, model, sampler, scheduler, vae, upscaler, hires, scale, denoise, 2ndpass, faces`. Args are applied by temporarily overriding `extension_settings.sd.*` (`applyCommandArguments`, SD:5384-5450) and restored in `finally`. `model` is `forceEnum` against the `#sd_model` dropdown. `args._abortController` is honored (SD:3059-3061). Callable from an extension through `SillyTavern.getContext().executeSlashCommandsWithOptions('/imagine quiet=true ...')` (`public/scripts/st-context.js:171`). |
| `/imagine-source <name>` (`sd-source`, `img-source`) | SD:5727-5757 | accepts only keys of the closed `sources` object and requires the `<option>` to exist in `#sd_source`; flips the DOM option and calls `onSourceChange()` (which resets model/sampler/scheduler/vae to null, SD:1135-1144). `/imagine-style` SD:5759, `/imagine-comfy-workflow` SD:5787. |
| Function tool `GenerateImage` | SD:5452-5485 | registered through `ToolManager.registerFunctionTool` when "function tool" is enabled; returns `encodeURI(url)`. Other extensions can register their own tools the same way (`st-context.js:183`). |
| Macros `{{charPrefix}}`, `{{charNegativePrefix}}` | SD:5955-5997 | |
| Settings object | `extension_settings.sd` (global object; defaults SD:233-363) | An extension can read/write `source`, `sdcpp_url`, `comfy_runpod_url`, etc. and call `saveSettingsDebounced()`; but the UI reads values from DOM inputs in several handlers (e.g. `onSdcppUrlInput` reads `$('#sd_sdcpp_url').val()`, SD:1257-1259), so the safe way is to set the DOM value and trigger `input`/`change`/click on `#sd_sdcpp_validate`. |
| Interactive-mode interceptor | `globalThis.SD_ProcessTriggers` (SD:436) | manifest `generate_interceptor`; not an extension point for sources. |

How to add or override a source: **not possible through a supported API**. `sources`/the switch are private; an unknown `<option>` added to `#sd_source` hits no `case` and ends in the "did not return image data" error. Options: (a) reuse a custom-URL source (sdcpp/comfyrunpod) and emulate its upstream; (b) intercept the browser `fetch` to `/api/sd/*` (Nanovia already wraps `fetch` for chat, `docs/ARCHITECTURE.md` §5, `src/host/fetch-hook.ts`); (c) ship a separate generator (own button/slash command) and not use ST's SD at all. A server plugin cannot override `/api/sd/nanogpt/generate`: the plugin gets only a `router` mounted at `/api/plugins/<id>` (`src/plugin-loader.js:213-222`) and ST's own routes are registered earlier.

## 2. TTS

### 2.1 Providers (TTS:124-153)

AllTalk, Azure, Chatterbox, Chutes, Coqui, CosyVoice (Unofficial), Edge, ElevenLabs, Electron Hub, Google Translate, Google Gemini TTS, GSVI, GPT-SoVITS-Adapter,
GPT-SoVITS-V2 (Unofficial), Kokoro, MiniMax, Novel, OpenAI, **OpenAI Compatible**, Pollinations, SBVits2, Silero, SpeechT5, System, **TTS WebUI**, VITS, XTTSv2, Volcengine. No NanoGPT provider.

Extension seam: `export function registerTtsProvider(name, ProviderClass)` (TTS:104-122). Throws on duplicate name; appends an `<option>` to `#tts_provider`; if that name is `extension_settings.tts.currentProvider` it calls `loadTtsProvider` immediately.
`init()` also adds options for everything already in `ttsProviders` (TTS:1563-1565), so registering before or after `init` both work. A third-party extension imports it with
`import { registerTtsProvider } from '/scripts/extensions/tts/index.js'` (same URL as `addExtensionScript`, `public/scripts/extensions.js:813-841`, so the same module instance).
Provider contract: `tts/readme.md` (`generateTts`, `fetchTtsVoiceObjects`, `getVoice`, `onRefreshClick`, `checkReady`, `loadSettings`, `settings`, `settingsHtml`; optional `previewTtsVoice`, `separator`, `processText`, `dispose`).
`generateTts` may return a `Response` whose blob type starts with `audio/` (TTS:459-470), a string URL, or an **async generator** of chunks (TTS:524-528). Settings persist at `extension_settings.tts[<providerName>]` (TTS:1081-1085).
Events: `TTS_JOB_STARTED`, `TTS_AUDIO_READY` (with the blob), `TTS_JOB_COMPLETE` (`events.js:105-107`, emitted TTS:509, 518, 533).

### 2.2 "OpenAI Compatible" provider (the seam for an OpenAI-style `/v1/audio/speech`)

Client `TTS/openai-compatible.js` (181 lines):
- Settings (defaults 14-20): `voiceMap`, `model` ('tts-1', free text input `#openai_compatible_model`), `speed` (0.25-4), `available_voices` (typed by hand, comma-separated; voice objects are fabricated with `lang:'en-US'`, 136-140), **`provider_endpoint` = the full URL including the path**, default `http://127.0.0.1:8000/v1/audio/speech`, input `maxlength=500`.
- API key button: `data-key="api_key_custom_openai_tts"` (line 29) -> ST key manager (`public/scripts/secrets.js:1139-1146`, only keys present in `SECRET_KEYS` are accepted; supports several labelled secrets with rotate).
- Request (159-180): `POST /api/openai/custom/generate-voice` (browser -> **ST server**, with CSRF header), body `{provider_endpoint, model, input, voice, response_format:'mp3', speed}`.

Server `OAI:756-794`:
- `key = readSecret(user.directories, SECRET_KEYS.CUSTOM_OPENAI_TTS)`; if no key is stored the header is `Authorization: Bearer ` (empty, `key ?? ''`, line 770). The proxy must tolerate an empty Bearer.
- `fetch(provider_endpoint, { method:'POST', headers: { 'Content-Type':'application/json', Authorization }, body: {input, response_format: response_format ?? 'mp3', voice ?? 'alloy', speed ?? 1, model ?? 'tts-1'} })` (766-779). **Only these 5 fields are forwarded** (no `instructions`, no `temperature`, nothing provider-specific; compare the Electron Hub route, OAI:330-357, which forwards extras).
- No URL validation (any string, `isValidUrl` not used). Upstream failure -> `500` with upstream text (the client toast shows only the status text).
- Response: whole upstream body buffered (`arrayBuffer`) and sent with `Content-Type: audio/mpeg` forced (788-789). No streaming. The client rejects non-`audio/*` blobs (TTS:466-468).

Other providers that look similar:
- `OpenAI` (`TTS/openai.js`, route `OAI:273-318`): hard-coded `api.openai.com/v1/audio/speech`; supports `instructions` (gpt-4o-mini-tts) but not redirectable.
- `TTS WebUI` (`TTS/tts-webui.js`, default `http://127.0.0.1:7778/v1/audio/speech`): **browser -> upstream directly** (`fetch(settings.provider_endpoint)`, line 538), no key, no Authorization, CORS required, streaming PCM/WAV, voices from `<endpoint>/voices/<model>`. Not usable when ST is remote and no auth.
- `Electron Hub`, `Chutes`, `Pollinations`, `ElevenLabs`, `Google`, `MiniMax`, `Volcengine`, `Novel`, `Azure`: ST server routes with fixed hosts (OAI:321, 419; SPEECH:117, 234; etc.).
- AllTalk, Chatterbox, CosyVoice, GPT-SoVITS, GSVI, VITS, SBVits2, XTTS, Coqui: browser/ST -> local servers with their own non-OpenAI protocols.

## 3. STT (speech recognition)

- **No client in 1.19.0.** `public/scripts/extensions/` contains: assets, attachments, caption, connection-manager, expressions, gallery, memory, quick-reply, regex, shared.js, stable-diffusion, third-party, token-counter, translate, tts, vectors. There is no `speech-recognition`; `grep` finds no `getUserMedia`/`MediaRecorder` in `public/scripts` (outside bundled libs).
  Remnants: `extension_settings.speech_recognition: {}` (`public/scripts/extensions.js:201`), a `speech_recognition` block in `default/content/settings.json:362-369`, and an empty `<div id="stt_container" class="extension_container">` in `public/index.html:5780`.
- Server routes that still exist (probably meant for an externally installed STT extension; not verified):
  - `POST /api/openai/transcribe-audio`, `/groq/...`, `/mistral/...`, `/zai/...` (OAI:806-878, shared `createTranscribeHandler`): reads `request.file` (multer file), builds multipart `file` (always labelled `audio.wav`) + `model` + optional `language`, `Authorization: Bearer <secret>`, hard-coded URLs (`https://api.openai.com/v1/audio/transcriptions`, groq, mistral, `api.z.ai/.../audio/transcriptions`). Returns upstream JSON (`{text}`).
  - `POST /api/openai/chutes/transcribe-audio` (OAI:880-929): base64 JSON to `https://<model>.chutes.ai/transcribe`.
  - `POST /api/speech/recognize` (SPEECH:42-59): local transformers.js Whisper on a base64 WAV data URI.
  - `POST /api/speech/elevenlabs/recognize` (SPEECH:390-430): ElevenLabs STT.
- **None accepts a custom base URL.** No route reads a `url`/`provider_endpoint`.
- `request.file` exists only because of the global `multer({dest: uploads}).single('avatar')` (`src/server-main.js:269`): an audio upload must use the multipart field name **`avatar`**; any other file field name makes multer raise "Unexpected field" before the route. This global multer runs before plugin routes too (plugins mount at `server-main.js:313`).
- JSON body limit is 500 MB (`server-main.js:110-111`), so base64 audio in JSON works fine.

## 4. Video

- Chat can display and store video: `MEDIA_TYPE.VIDEO` (`public/scripts/constants.js:103+`), `VIDEO_EXTENSIONS` (constants.js:31), `isVideo(format)` in SD (SD:366), `sendMessage` picks type by format (SD:4971), `/api/images/upload` accepts `mp4, webm, mov, ...` (`src/constants.js:528-552`).
- Video sources in SD:
  - `openai` with model matching `/sora-2/` (SD:4081, 4112-4142): `POST /api/openai/generate-video` (OAI:653-752); hard-coded `api.openai.com/v1/videos`; **server-side polling inside the HTTP request**: up to 30 attempts with `delay(5000 + attempt*1000)` (about 9.75 minutes), aborts when the client closes the socket; returns `{format:'mp4', data: <base64 of whole file>}`.
  - `google` with model `/^veo-/` (SD:4559-4601): `/api/google/generate-video` (`src/endpoints/google.js:498-640`), same polling pattern, returns `{video: base64}`.
  - `zai` with `cogvideox|vidu` models (SD:4637-4667): `/api/sd/zai/generate-video` (SDS:1957-2058), same polling pattern, returns `{format:'mp4', video}`.
  - `comfy` / `comfyrunpod`: first output of `gifs` (standard) or `images[0]` (runpod) by file extension; mp4/webm render as video.
  - `nanogpt`: **no video** (models list = `models.image`, `format` fixed `jpg`).
- No source takes a custom URL for a native video API. Settings: `openai_duration` (default '8'), `google_duration` (6).

## 5. Keys, network reachability, CORS/CSRF

### 5.1 Secrets (SECRET_KEYS)

Server list: `src/endpoints/secrets.js:9-73`; client list: `public/scripts/secrets.js:19-82` (same values).
Relevant: `NANOGPT='api_key_nanogpt'`, `CUSTOM='api_key_custom'` (chat Custom source, what Nanovia's proxy token uses today), `CUSTOM_OPENAI_TTS='api_key_custom_openai_tts'` (OpenAI-Compatible TTS), `COMFY_RUNPOD='api_key_comfy_runpod'`, `OPENAI='api_key_openai'`, `ELEVENLABS`, `POLLINATIONS`, `ELECTRONHUB`, `CHUTES`, ...
- Storage: per-user `secrets.json`, each key is an array of `{id,value,label,active}`; `readSecret(dirs, key, id?)` returns the active one (`secrets.js:268-282`). Media routes never pass `id` (only chat-completions honors `request.body.secret_id`, `chat-completions.js:1789-1853`), so image/TTS/caption always use the **active** secret.
- `/api/secrets/write|delete|rotate|rename` accept **any key string** (`secrets.js:511-527, 588-639`), but `/api/secrets/read` (state) lists only keys in `SECRET_KEYS` (`getSecretState`, 343-368), the client key manager refuses unknown keys (`secrets.js:1141`), and `secret_state[unknownKey]` is undefined. So a custom key can be stored but is invisible/unmanageable in ST's UI. Using `api_key_custom_openai_tts` and `api_key_comfy_runpod` gives a normal ST key-manager UI for free.
- `/api/secrets/view|find` are blocked unless `allowKeysExposure` (`secrets.js:540-586`): the browser cannot read a token back.
- Client `writeSecret(key, value, label)` (`public/scripts/secrets.js:349-380`) emits `SECRET_WRITTEN`; `rotateSecret` (459) selects the active secret.

### 5.2 Can the ST server reach `http://127.0.0.1:<port>`?

- Private request filter: `privateAddressWhitelist.enabled` defaults to **false** (`default/config.yaml:157-170`; read at `src/server-main.js:339-348`), so nothing is blocked. If an admin turns it on, loopback stays allowed by default (`allowedRanges: 127.0.0.0/8, ::1/128`, both in config default and in code default at `server-main.js:341`); the filter works at connect time on the resolved IP (`src/private-request-filter.js:109-190` (`connect`), private ranges list 14-31) and it applies to `http.globalAgent`, i.e. to node-fetch used by every route above.
- Outbound request proxy (`requestProxy.enabled`, default false): bypass list defaults to `localhost`, `127.0.0.1` (`default/config.yaml:103-105`). If enabled with a custom bypass that drops them, the proxy would be used for loopback.
- Use the literal `127.0.0.1` (not `localhost`) in URLs: `localhost` may resolve to `::1` first while the listener binds IPv4 only.
- ST on the VPS runs in Docker (`/opt/sillytavern`); the plugin lives in the same process/container, so loopback is shared. The browser, however, is on another machine: any design where the **browser** calls `http://127.0.0.1:<port>` breaks for remote use (and has mixed-content/CORS/Private-Network-Access problems). TTS WebUI-style providers (browser -> upstream) are therefore out.
- Not verifiable from the local tree: the prod `config.yaml` (check `privateAddressWhitelist`, `requestProxy`, `enableServerPlugins`, over SSH).
- The local dev `config/config.yaml` has `enableServerPlugins: true` and `enableCorsProxy: true` (diff vs default). `/proxy/:url(*)` (CORS proxy, `server-main.js:256-266`, `middleware/corsProxy.js`) is a browser -> ST -> arbitrary URL relay (JSON.stringify of the body, drops cookies/CSRF) and would also reach loopback, but it is for browser-initiated fetches only and is not needed.

### 5.3 CORS and CSRF

- ST server -> proxy: plain server-side HTTP, no CORS, no cookies, no CSRF. The proxy needs no CORS headers for the `sdcpp`/`comfyrunpod`/custom-TTS paths.
- Browser -> ST: every POST needs `X-CSRF-Token` (`server-main.js:166-203`, header read at 177) and a session when login is required (`requireLoginMiddleware` 248). Plugin admin routes (`/api/plugins/nanovia/...`) sit behind both; use `getRequestHeaders()` (`public/script.js:647-658`).
- ST's own CORS config is `origin: "null", methods: [OPTIONS]` by default (`default/config.yaml:78-95`), irrelevant for these flows.
- The proxy listener has no ST session, so identity must come from the token/URL (registry maps token hash -> connectionId + userHandle, per `ARCHITECTURE.md` §3).

## 6. Conclusions: how Nanovia should plug in, per medium

### 6.1 Images

(a) Built-in ST UI working against a Nanovia URL with a per-connection token: use the **`stable-diffusion.cpp server` (`sdcpp`) source**.
- ST config: `extension_settings.sd.source='sdcpp'`, `sdcpp_url = http://127.0.0.1:<port>/c/<id>/sd` (any prefix works because of `urlJoin`).
- Proxy must implement (all relative to that prefix): `OPTIONS /v1/images/generations` -> 200 (ping; with a raw `http` server answer OPTIONS explicitly); `GET /v1/models` -> `{data:[{id,name}]}` with **image** models of the catalog; `POST /sdapi/v1/txt2img` with the body above -> `{images:[<base64 png/jpg>], parameters:{}, info:""}`. Map to NanoGPT `POST /api/generate-image` (same upstream the ST nanogpt source uses: `{model,prompt,negative_prompt,num_steps,scale,width,height,resolution,showExplicitContent,nImages}`) or the OpenAI-style images endpoint, download a URL result if NanoGPT returns a URL, and return base64.
- Do **not** reuse the chat route `/c/<id>/v1/models` for this: the existing proxy returns the connection's chat model there, ST's sdcpp UI would then list chat models. Use a sibling namespace (`/c/<id>/sd/v1/models`).
- Auth: sdcpp sends **no Authorization header** (SDS:896-902), so the token must be in the URL (e.g. `/m/<mediaToken>/sd` or the connection id treated as a capability on the loopback-only listener). The token will sit in plaintext `settings.json` (`extension_settings.sd.sdcpp_url`), not in `secrets.json`. Acceptable only because the listener is loopback and the token is media-scope only.
- ST gives for free: model dropdown, steps, CFG, width/height/seed, negative prompt, style prefixes, `/imagine` with all args, wand/swipe/regenerate buttons, function tool, character prompt prefixes, gallery, chat message rendering, background mode, SD_PROMPT_PROCESSING hook.
- Keep ST's own NanoGPT source as the zero-effort fallback (works today with `api_key_nanogpt`).
- Alternative for per-connection **Bearer** auth, async jobs and video: **`comfyrunpod` source** (`comfy_runpod_url = http://127.0.0.1:<port>/c/<id>/runpod`, secret `api_key_comfy_runpod` = connection token). Proxy implements `GET /health` -> `{workers:{ready:1}}`, `POST /run` (body is text, no Content-Type; may be `{input:{workflow:{...}}}`; if the user's workflow JSON already has `input.workflow` ST sends it as is, SDS:691), returns `{id}`, `GET /status/<id>` -> `{status, output:{images:[{filename:'x.png'|'x.mp4', data:<base64>}]}}`, `POST /cancel/<id>`. The "workflow" JSON file (editable in SD settings, placeholders `%prompt% %negative_prompt% %seed% %steps% %scale% %width% %height% %denoise% %clip_skip% %user_avatar% %char_avatar%` plus user-defined placeholders `comfy_placeholders`, SD:4233-4250) becomes Nanovia's request schema (model, aspect, duration...). The plugin may write such template workflows into the user's `comfyWorkflows` directory. Model dropdown is `N/A` in this mode (SD:2542-2547).
  Danger: the ST poll loop is `while(true)` with **no failure branch and no abort check** (SDS:710-727): if `status.output` never appears (failed job) ST polls forever at 2 Hz. The emulation must always return `output.images[0]` (a placeholder/error image) on failure and on cancel.

(b) What Nanovia's own panel/API must still provide for images:
- image model catalog with pricing, per-model parameter schema (aspect/resolution presets, quality, img2img/inpaint/reference images, `showExplicitContent`), billing impact and subscription daily image quota (ST already reads `limits.dailyImages` in `src/endpoints/nanogpt.js:70-90` for its credits popup), usage log per generation;
- a "use this connection for images in ST" button that sets `source`/URL through the DOM (set `#sd_source`, trigger `change`; fill `#sd_sdcpp_url`, trigger `input`, click `#sd_sdcpp_validate`) or runs `/imagine-source sdcpp` first;
- a Nanovia command (e.g. `/nanovia-imagine`) for what SD's fixed UI cannot express (reference images, model-specific params, n>1, video) that reuses `appendMediaToMessage`/message format of SD:4966-4995 and `/api/images/upload`;
- surface errors: ST turns every proxy failure into a bare 500 ("Image generation failed ... Internal Server Error"), so the real reason (insufficient balance, content filter, timeout) must be shown in the Nanovia panel/log.

### 6.2 TTS

(a) Built-in "OpenAI Compatible" provider:
- `extension_settings.tts.currentProvider='OpenAI Compatible'`, `provider_endpoint = http://127.0.0.1:<port>/c/<id>/v1/audio/speech`, `model` = a NanoGPT TTS model id, `available_voices` = list typed by Nanovia, key = the connection token written as secret **`api_key_custom_openai_tts`** (label like the chat token; `rotate` selects it). That token arrives as `Authorization: Bearer <token>`, exactly how the proxy already authenticates chat. Treat an empty Bearer as "no token" and fall back to path-only (or reject).
- Proxy implements `POST /v1/audio/speech`: accepts `{input,response_format,voice,speed,model}`, forwards to NanoGPT's OpenAI-compatible speech endpoint (check NanoGPT docs; not in ST source), returns raw audio bytes with an `audio/*` Content-Type (ST overrides it to `audio/mpeg` and always asks for `mp3`).
- ST gives: per-character voice map, narrate quotes/dialogue/paragraphs, auto-generation on new messages, playback queue, preview.
(b) Must still come from Nanovia:
- real voice catalog per model (ST's provider never fetches voices, `lang` forced `en-US`), model-specific options (`instructions` for gpt-4o-mini-tts, ElevenLabs-style settings, temperature) that this ST route drops;
- best: register an own provider `registerTtsProvider('Nanovia', NanoviaTtsProvider)` (import from `/scripts/extensions/tts/index.js`). It calls `/api/plugins/nanovia/tts` (session+CSRF, returns audio), can stream (async-generator return, TTS:524-528), fetches voices, previews, passes `instructions`, caches audio by hash of (text, voice, model) to save money, shows cost per character;
- connection selection: ST's endpoint is one global value per user; per-character connection choice is impossible in the built-in provider.

### 6.3 STT

(a) No built-in seam: ST 1.19.0 has no STT client, and all its server STT routes are hard-coded to other providers.
(b) Nanovia provides everything:
- mic capture with `MediaRecorder` (needs a secure context: https or localhost; on the VPS ST must be served over https), a button next to the send box and/or `/dictate`; insert the transcript into `#send_textarea` or send;
- upload to `/api/plugins/nanovia/stt` as **base64 JSON** (500 MB limit) or multipart with field name `avatar` (global multer; delete the temp file afterwards), then plugin -> proxy -> NanoGPT transcription endpoint;
- also expose `POST /c/<id>/v1/audio/transcriptions` (multipart pass-through, Bearer auth) on the proxy so any OpenAI-style client can use it, including a separately installed ST STT extension that supports a custom endpoint.
- language option, push-to-talk/auto-send, cost display per minute.

### 6.4 Video

(a) No built-in custom-URL video path. Possible hack only through `comfyrunpod` (return `.mp4`, see 6.1) or ComfyUI standard emulation (heavier: needs `/system_stats`, `/object_info` with specific nodes, `/prompt`, `/history`, `/view`; also an unbounded 100 ms poll loop, SDS:590-602). Fetch-hooking the hard-coded `/api/openai/generate-video` is not reasonable (the `openai` source also requires an OpenAI key and its own model list).
(b) Recommended: Nanovia-owned flow with **async jobs** (NanoGPT video is long-running):
- `POST /api/plugins/nanovia/video/jobs` -> job id immediately; `GET .../jobs/:id` polling by the browser (or SSE); on completion the plugin writes the mp4 into the user's images folder (same layout as `/api/images/upload`, `request.user.directories.userImages/<char>/<file>.mp4`, relative path via the same `clientRelativePath` form) or the browser posts base64 to `/api/images/upload` with `format:'mp4'`. Then add the chat message exactly like SD's `sendMessage`: `extra.media=[{url, type: MEDIA_TYPE.VIDEO, title: prompt, source: MEDIA_SOURCE.GENERATED}]`, `MESSAGE_RECEIVED` with `'extension'`, `addOneMessage`, `saveChat` (SD:4966-4995).
- Avoid ST's own pattern of one blocking HTTP request that polls server-side for up to ~10 minutes and returns the whole video as base64 JSON; reverse proxies (nginx, Cloudflare ~100 s) in front of the VPS ST would cut it.
- Image-to-video using the character avatar or last image can be sourced by the browser (`getCharacterAvatar`, SD:3269-3281 pattern) and sent to the plugin.

### 6.5 Risks and gotchas (checked in source)

1. **Hard-coded hosts.** SD `nanogpt`, `openai` image/video/TTS, native STT routes cannot be redirected by settings. Only a browser-side `fetch` hook can rewrite them, and it is fragile.
2. **sdcpp sends no auth.** Token must live in the URL; it is stored in plaintext `settings.json`.
3. **A1111 (`auto`/`vlad`/`drawthings`) drop the URL path** (`url.pathname = ...`), so they only work if the proxy is at the origin root; `auto` also requires GET `/sdapi/v1/options`, `/sd-models`, `/samplers`, ... and sends the whole body including `url`/`auth` upstream. Prefer sdcpp.
4. **Error loss.** sdcpp/nanogpt/auto routes end in `response.sendStatus(500)` (SDS:348, 913, 1452, 1466); the UI shows only "Internal Server Error". Custom TTS returns upstream text but the toast shows only `statusText`.
5. **Body whitelists.** Custom TTS forwards only `input, response_format, voice, speed, model`; sdcpp only the listed fields (and `clip_skip` only if >1; empty values stripped); `comfyrunpod` forwards only the workflow; Google/others whitelist too. The NanoGPT image route is the exception (whole body forwarded).
6. **Single-result, fixed format.** All image sources return one image; format is hard-coded (`png` for sdcpp/auto, `jpg` for nanogpt); the upload route stores the bytes unchanged, so a JPEG saved as `.png` still displays but is mislabelled.
7. **Unbounded loops.** `comfy` (100 ms) and `comfyrunpod` (500 ms) poll with `while(true)` and no abort check; a missing result means infinite polling. Z.AI/OpenAI/Google video loops are bounded (30 attempts) but block one HTTP request for ~10 minutes.
8. **No abort propagation** for sdcpp, nanogpt, custom TTS (no `socket.on('close')`), unlike `auto`, `comfy`, `comfyrunpod`, and the video routes. Stopping in the UI does not cancel upstream cost.
9. **Active-secret only** for all media routes (`secret_id` ignored); the per-connection `secret-id` trick used by CM chat profiles does not apply. Two connections cannot be used for media at the same time via the key; they must be distinguished by URL.
10. **Unknown secret keys are invisible** in `secret_state` and the key manager, so only the built-in keys `api_key_custom_openai_tts` and `api_key_comfy_runpod` get a UI.
11. **Global, not per-character, endpoint** for both SD source URL and TTS provider endpoint.
12. **Multer `single('avatar')`** runs globally before every route including plugin routes: multipart uploads with another field name fail with "Unexpected field"; leftovers land in `data/_uploads`.
13. **Models listing limits:** `/api/sd/nanogpt/models` lists only `models.image`; `sdcpp` samplers/schedulers are hard-coded lists (SD:1845, 2687-2690) and get sent to the proxy (ignore them: values like `euler`, `discrete`).
14. **No streaming** through the custom TTS route (full buffer); long text means latency before playback. Own provider with async generator is needed for chunked playback.
15. **Content-Type forced** to `audio/mpeg` by the custom TTS route regardless of upstream; client enforces `audio/*`.
16. **Browser-direct** providers (TTS WebUI etc.) are unusable remotely.
17. Unverified here: the prod ST `config.yaml` (private-address filter, request proxy, plugins), and NanoGPT's own endpoint specs for TTS/STT/video (take them from NanoGPT docs, not from ST).

### 6.6 Suggested order for stage 0.7 (media)

1. Proxy routes: `/c/<id>/sd/...` (sdcpp-compatible images) and `/c/<id>/v1/audio/speech`, `/c/<id>/v1/audio/transcriptions` (OpenAI-style, Bearer), all billed and logged through the existing pipeline.
2. Panel tab "Media": "use for images" and "use for TTS" buttons that configure ST's sdcpp source and OpenAI-Compatible TTS (write token to `api_key_custom_openai_tts`, rotate it), plus a connectivity check (`ping` equals OPTIONS on the sdcpp path).
3. Own TTS provider via `registerTtsProvider` (voices, instructions, caching).
4. Own STT UI + route; own async video job flow with chat message insertion.
5. Optional: `comfyrunpod` emulation if Bearer + async + video inside ST's SD UI is wanted.
