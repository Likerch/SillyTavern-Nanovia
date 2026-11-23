// The mock's model data: the catalog snapshot, per-model providers snapshots (or synthetic ones), model resolution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures');

/** File name of a model id in tools/fixtures/providers: every character outside [A-Za-z0-9._-] becomes `__`. */
export const safeId = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '__');

/** A stable number from a string, for synthetic hosts. */
function hash(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
}

export function loadCatalog(dir = FIXTURES_DIR) {
    const models = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')).data;
    const byId = new Map(models.map((m) => [m.id, m]));

    /**
     * Finds the catalog model of a requested id. A trailing `:suffix` that is not part of a catalog id (`:online`,
     * `:memory-7`, `:thinking:max`) is peeled off and reported in `suffixes`.
     */
    function resolveModel(requested) {
        const suffixes = [];
        let id = String(requested);
        for (;;) {
            const model = byId.get(id);
            if (model) return { model, suffixes: suffixes.reverse() };
            const cut = id.lastIndexOf(':');
            if (cut < 0) return null;
            suffixes.push(id.slice(cut + 1));
            id = id.slice(0, cut);
        }
    }

    /** Price per token (USD) of a model, from the catalog entry: [prompt, completion, cache read]. */
    function pricePerToken(model) {
        const p = model.pricing;
        return {
            prompt: p.prompt / 1e6,
            completion: p.completion / 1e6,
            cacheRead: (p.cacheReadInputPer1kTokens ?? p.prompt / 10000) / 1000,
        };
    }

    /** The `GET /api/models/:id/providers` response: the snapshot when there is one, otherwise a deterministic synthetic one. */
    function providersFor(requested) {
        const id = String(requested);
        const file = path.join(dir, 'providers', `${safeId(id)}.json`);
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
        const resolved = resolveModel(id);
        if (!resolved) return null;
        const { model } = resolved;
        const price = pricePerToken(model);
        const defaultPrice = {
            inputPer1kTokens: price.prompt * 1000,
            outputPer1kTokens: price.completion * 1000,
            cacheReadInputPer1kTokens: price.cacheRead * 1000,
        };
        const ids = Array.isArray(model.providers) ? model.providers : [];
        if (!ids.length) {
            return {
                canonicalId: model.id,
                supportsProviderSelection: false,
                providerDetails: [],
                message: 'This model does not support provider selection',
                defaultPrice,
            };
        }
        const quantizations = ['fp4', 'fp8', 'bf16', 'int8', undefined];
        return {
            canonicalId: model.id,
            displayName: model.name,
            supportsProviderSelection: true,
            defaultPrice,
            autoPricing: { zdr: defaultPrice, anonymized: defaultPrice },
            providers: ids.map((provider) => {
                const h = hash(provider);
                const markup = 1.05 + (h % 20) / 100;
                const quantization = quantizations[h % quantizations.length];
                return {
                    provider,
                    displayName: provider,
                    pricing: {
                        inputPer1kTokens: defaultPrice.inputPer1kTokens * markup,
                        outputPer1kTokens: defaultPrice.outputPer1kTokens * markup,
                        cacheReadInputPer1kTokens: defaultPrice.cacheReadInputPer1kTokens * markup,
                    },
                    available: true,
                    supportsPromptCaching: true,
                    maxOutputTokens: model.max_output_tokens ?? null,
                    ...(quantization ? { quantization } : {}),
                    ...(h % 3 ? { tps: 40 + (h % 160), ttftMs: 600 + (h % 3000) } : {}),
                    uptime: {
                        uptimePct: 97 + (h % 30) / 10,
                        failures: { rateLimitedPct: 0, errorPct: 0 },
                        windowHours: 72,
                    },
                    features: {
                        toolCalling: true,
                        structuredOutput: model.capabilities.structured_output,
                        promptCaching: true,
                    },
                };
            }),
            autoTps: 100,
            autoTtftMs: 1500,
            autoCacheReadRate: 0.5,
        };
    }

    return { models, byId, resolveModel, pricePerToken, providersFor };
}
