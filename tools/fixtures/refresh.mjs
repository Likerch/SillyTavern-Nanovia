#!/usr/bin/env node
// Rebuilds the mock's fixtures: tools/fixtures/catalog.json and tools/fixtures/providers/<safe-id>.json.
//
//   node tools/fixtures/refresh.mjs             fetch the public catalog and providers (no key needed), keep a roleplay-relevant subset
//   node tools/fixtures/refresh.mjs --offline   keep the real entries already in catalog.json, rewrite only the mock/ models
//
// Only public endpoints are called (`GET /api/v1/models?detailed=true`, `GET /api/models/<id>/providers`). No key is
// read or written. The providers snapshots drop what the extension does not use (hourly uptime series, legal texts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_MODELS, MOCK_PROVIDERS } from './mock-models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'https://nano-gpt.com';
const MAX_PROVIDERS = 20;

/** Real models kept in the snapshot: what matters for roleplay, plus a few that exercise odd shapes. */
export const WANTED = `
deepseek/deepseek-v4.1-flash deepseek/deepseek-v4.1-flash:thinking deepseek/deepseek-v4.1-flash-1017
deepseek/deepseek-v4.1-flash-1017:thinking deepseek/deepseek-v4-pro-0813 deepseek/deepseek-v4-pro-20260423
deepseek/deepseek-v4-pro-20260423:thinking deepseek/deepseek-v4.1-flash-abliterated
deepseek/deepseek-v4.1-flash-1017-uncensored
z-ai/glm-5 z-ai/glm-5.1 z-ai/glm-5.2 z-ai/glm-5.2:thinking z-ai/glm-5.3 z-ai/glm-5.3:thinking z-ai/glm-5.3-flash
z-ai/glm-5.3-uncensored z-ai/glm-5.3-abliterated z-ai/glm-5.3-flash-uncensored TEE/glm-5.3
xiaomi/mimo-v2.6-flash xiaomi/mimo-v2.6-pro xiaomi/mimo-v2.6-flash-uncensored
moonshotai/kimi-k3 moonshotai/kimi-k3.1-pro lyber/kimi-k3.1-pro-abliterated TEE/kimi-k3.1-pro
google/gemini-4-neon google/gemini-4-hydrogen google/gemini-3.8-flash google/gemini-3.7-flash
anthropic/claude-sonnet-5.5 anthropic/claude-sonnet-5.5:thinking anthropic/claude-sonnet-5 anthropic/claude-opus-5.5
anthropic/claude-opus-5
x-ai/grok-4.7 x-ai/grok-4.6
qwen/qwen3.8-flash qwen/qwen3.8-27b qwen/qwen3.8-27b:thinking qwen/qwen3.8-27b-uncensored qwen/qwen3.8-max-0902
tencent/hy4 tencent/hy4-flash
minimax/minimax-m3 minimax/minimax-m3:thinking minimax/minimax-m3.1-flash
aion-labs/aion-3.5 aion-labs/aion-3.5-mini
thedrummer/artemis-31b-v1.2 qwen/qwen3.8-27b-kimiko Gemma-4-31B-SDFT-Heretic-RP Gemma-4-31B-MeroMero-v2 kitani/clover-2
GLM-4.6-Derestricted-v5
venice-uncensored pqhaz/DeepSeek-V4.1-Flash-1017-heretic pqhaz/DeepSeek-V4.1-Flash-1017-heretic:thinking
abliteration-ai/abliterated-model-large-v2
TEE/qwen3.6-27b
`
    .split(/\s+/)
    .filter(Boolean);

/** Models whose providers response is snapshotted. venice-uncensored answers "no provider selection". */
export const WANTED_PROVIDERS = [
    'deepseek/deepseek-v4.1-flash-1017',
    'deepseek/deepseek-v4.1-flash',
    'deepseek/deepseek-v4-pro-20260423',
    'z-ai/glm-5.3',
    'z-ai/glm-5.2',
    'z-ai/glm-5.3-flash',
    'moonshotai/kimi-k3.1-pro',
    'xiaomi/mimo-v2.6-flash',
    'minimax/minimax-m3',
    'qwen/qwen3.8-27b',
    'tencent/hy4',
    'anthropic/claude-sonnet-5.5',
    'venice-uncensored',
];

/** File name of a model id: every character outside [A-Za-z0-9._-] becomes `__`. */
export const safeId = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '__');

const PROVIDER_KEYS = [
    'provider',
    'displayName',
    'pricing',
    'available',
    'supportsPromptCaching',
    'maxInputTokens',
    'maxOutputTokens',
    'quantization',
    'tps',
    'ttftMs',
    'cacheReadRate',
    'privacy',
    'region',
    'features',
    'supportedReasoningEfforts',
];

function trimProviders(response) {
    const pick = (source, keys) => Object.fromEntries(keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]));
    const providers = (response.providers ?? [])
        .map((p) => {
            const entry = pick(p, PROVIDER_KEYS);
            if (p.uptime) entry.uptime = pick(p.uptime, ['uptimePct', 'failures', 'windowHours']);
            return entry;
        })
        .sort((a, b) => (b.tps ? 1 : 0) - (a.tps ? 1 : 0))
        .slice(0, MAX_PROVIDERS);
    const top = pick(response, [
        'canonicalId',
        'displayName',
        'supportsProviderSelection',
        'message',
        'defaultPrice',
        'autoPricing',
        'autoTps',
        'autoTtftMs',
        'autoCacheReadRate',
    ]);
    if (response.providerDetails) top.providerDetails = response.providerDetails;
    if (response.providers) top.providers = providers;
    return top;
}

async function getJson(url) {
    const response = await fetch(url, { headers: { 'user-agent': 'nanovia-fixtures' } });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return response.json();
}

function write(file, value, indent) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, indent) + '\n', 'utf8');
}

async function main() {
    const offline = process.argv.includes('--offline');
    const catalogFile = path.join(HERE, 'catalog.json');
    const providersDir = path.join(HERE, 'providers');

    let real;
    if (offline) {
        real = JSON.parse(fs.readFileSync(catalogFile, 'utf8')).data.filter((m) => !m.id.startsWith('mock/'));
    } else {
        const live = await getJson(`${SITE}/api/v1/models?detailed=true`);
        const byId = new Map(live.data.map((m) => [m.id, m]));
        const missing = WANTED.filter((id) => !byId.has(id));
        if (missing.length) console.warn(`refresh: not in the live catalog any more: ${missing.join(', ')}`);
        real = WANTED.filter((id) => byId.has(id)).map((id) => byId.get(id));
    }
    write(catalogFile, { object: 'list', data: [...real, ...MOCK_MODELS] }, 2);
    console.log(`catalog.json: ${real.length} real + ${MOCK_MODELS.length} mock models`);

    fs.mkdirSync(providersDir, { recursive: true });
    for (const [id, response] of Object.entries(MOCK_PROVIDERS)) write(path.join(providersDir, `${safeId(id)}.json`), response, 1);
    if (!offline) {
        for (const id of WANTED_PROVIDERS) {
            try {
                const response = await getJson(`${SITE}/api/models/${encodeURIComponent(id)}/providers`);
                write(path.join(providersDir, `${safeId(id)}.json`), trimProviders(response), 1);
                console.log(`providers/${safeId(id)}.json: ${response.providers?.length ?? 0} hosts`);
            } catch (error) {
                console.warn(`refresh: providers of ${id}: ${error.message}`);
            }
        }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
