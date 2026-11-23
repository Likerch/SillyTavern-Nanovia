#!/usr/bin/env node
// Offline: reduces the live NanoGPT media model lists to a small representative set for the tests and the mock.
//
//   node tools/fixtures/trim-media.mjs <snapshotDir> [--per-medium 30]
//
// <snapshotDir> holds the four public lists as NanoGPT served them (saved by hand, no key needed):
//   images_models.json        GET /api/v1/images/models
//   video_models_default.json GET /api/v1/video-models
//   audio_models_tts.json     GET /api/v1/audio-models?type=tts
//   audio_models_stt.json     GET /api/v1/audio-models?type=stt
// The script never touches the network. For every medium it picks entries greedily: the one that brings the most
// not-yet-covered "shapes" (price keys, parameter keys, capability flags, size-token styles), rarest shapes first, until
// the limit is reached; a few entries the tests name are always kept. Entries are copied untouched (real data).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'media');

const SOURCES = {
    image: ['images_models.json', 'images_models.json'],
    video: ['video_models_default.json', 'video_models.json'],
    tts: ['audio_models_tts.json', 'audio_models_tts.json'],
    stt: ['audio_models_stt.json', 'audio_models_stt.json'],
};

/** Entries the tests refer to by name; kept whatever the greedy pass says. */
const MUST_KEEP = {
    image: [
        'rev-animated',
        'pixelwave',
        'cyberrealistic-pony-v9',
        'wai-illustrious-sdxl',
        'gpt-image-2.6-flare',
        'topaz-image-upscale',
        'hidream-o1-image',
        'speridlabs/iris-z',
        'auto-image-selection',
        'flux-2-turbo',
        'flux-kontext',
        'ideogram/v4/fast',
        'minimax-h3/text-to-image',
        'recraft-v3',
        'gpt-image-1',
    ],
    video: [
        'veo3-video',
        'veo2-video',
        'bytedance/seedance-2.5',
        'kling-v26-pro',
        'kling-v25-turbo-std',
        'kling-4.0',
        'veed/dubbing',
        'longstories/story-fast',
        'heygen/avatar-6',
        'vidu-q4',
        'minimax/h3-highspeed',
    ],
    tts: [
        'Kokoro-82m',
        'tts-1',
        'gpt-4o-mini-tts',
        'Elevenlabs-Turbo-V2.5',
        'Elevenlabs-V3',
        'microsoft/vibevoice',
        'mureka/api/generate/speech',
        'voxtral-mini-tts-3-0',
        'google/gemini-3.8-flash-lite-tts',
        'elevenlabs/music',
        'elevenlabs/music/v2',
    ],
    stt: [
        'qwen/qwen3-asr-0.6b',
        'qwen/qwen3-asr-1.7b',
        'Whisper-Large-V3',
        'whisper-1',
        'Wizper',
        'Elevenlabs-STT',
        'elevenlabs/scribe-v3',
        'gpt-4o-mini-transcribe',
        'qwen-voice-clone',
        'minimax-voice-clone',
        'inworld-voice-clone',
    ],
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The sizes' naming style, so one entry per style survives. */
function sizeStyles(resolutions) {
    const styles = new Set();
    for (const token of Array.isArray(resolutions) ? resolutions : []) {
        if (/^\d+x\d+$/.test(token)) styles.add('wxh');
        else if (/^\d+\*\d+$/.test(token)) styles.add('w*h');
        else if (/^\d+(\.\d+)?k$/i.test(token)) styles.add('k');
        else if (/^\d+(\.\d+)?:\d+$/.test(token)) styles.add('ratio');
        else if (token === 'auto') styles.add('auto');
        else styles.add('preset');
    }
    return [...styles];
}

function featuresOf(medium, model) {
    const features = new Set();
    const keysOf = (prefix, value) => {
        if (isRecord(value)) for (const key of Object.keys(value)) if (key !== 'currency') features.add(`${prefix}:${key}`);
    };
    keysOf('price', model.pricing);
    keysOf('cap', model.capabilities);
    for (const [key, value] of Object.entries(model.capabilities ?? {})) features.add(`flag:${key}=${value}`);
    features.add(`modality:${model.architecture?.modality ?? '-'}`);
    features.add(`category:${model.category ?? '-'}`);
    if (model.subscription) features.add('subscription');
    const sp = model.supported_parameters ?? {};
    if (medium === 'video') {
        for (const [key, descriptor] of Object.entries(sp.parameters ?? {})) {
            features.add(`param:${key}`);
            if (isRecord(descriptor)) features.add(`paramtype:${descriptor.type ?? '-'}`);
        }
    } else {
        for (const [key, value] of Object.entries(sp)) {
            const shape = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
            features.add(`sp:${key}:${shape}`);
        }
    }
    if (medium === 'image') for (const style of sizeStyles(sp.resolutions)) features.add(`size:${style}`);
    if (medium === 'image' && isRecord(model.pricing?.per_image) && Object.keys(model.pricing.per_image).length === 0) {
        features.add('price:per_image-empty');
    }
    if (medium === 'image' && Object.values(model.pricing?.per_image ?? {}).some((v) => v === 0)) {
        features.add('price:zero');
    }
    return features;
}

function pick(medium, models, limit) {
    const all = models.map((model) => ({ model, features: featuresOf(medium, model) }));
    const counts = new Map();
    for (const { features } of all) for (const f of features) counts.set(f, (counts.get(f) ?? 0) + 1);
    const chosen = new Map();
    const covered = new Set();
    const keep = new Set(MUST_KEEP[medium]);
    for (const entry of all) {
        if (!keep.has(entry.model.id)) continue;
        chosen.set(entry.model.id, entry.model);
        for (const f of entry.features) covered.add(f);
    }
    while (chosen.size < limit) {
        let best = null;
        let bestScore = 0;
        for (const entry of all) {
            if (chosen.has(entry.model.id)) continue;
            let score = 0;
            for (const f of entry.features) if (!covered.has(f)) score += 1 / (counts.get(f) ?? 1);
            if (score > bestScore) {
                best = entry;
                bestScore = score;
            }
        }
        if (!best) break;
        chosen.set(best.model.id, best.model);
        for (const f of best.features) covered.add(f);
    }
    // Keep the live order, so the fixtures read like the list did.
    return models.filter((model) => chosen.has(model.id));
}

function main() {
    const args = process.argv.slice(2);
    const dir = args.find((a) => !a.startsWith('--'));
    const limitIndex = args.indexOf('--per-medium');
    const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 30;
    if (!dir || !Number.isInteger(limit) || limit < 1) {
        console.error('usage: node tools/fixtures/trim-media.mjs <snapshotDir> [--per-medium 30]');
        process.exit(2);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [medium, [input, output]] of Object.entries(SOURCES)) {
        const source = JSON.parse(fs.readFileSync(path.join(dir, input), 'utf8'));
        const models = pick(medium, source.data, limit);
        const doc = {
            object: 'list',
            data: models,
            meta: { count: models.length, generated_at: source.meta?.generated_at ?? null, trimmed_from: source.data.length },
        };
        fs.writeFileSync(path.join(OUT_DIR, output), `${JSON.stringify(doc, null, 1)}\n`);
        console.log(`${medium}: ${models.length} of ${source.data.length} -> tools/fixtures/media/${output}`);
    }
}

main();
