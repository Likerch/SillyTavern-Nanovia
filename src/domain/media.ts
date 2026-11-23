// Pure logic of the media stage (contracts-media.ts): turning NanoGPT's heterogeneous model lists into MediaModel and
// estimating what a call costs from the catalog price. NO DOM, NO network. The parsers of the upstream RESPONSES live in
// media-wire.ts.
//
// What the live lists of 2026-11-23 look like (docs/research/media-api.md §6, snapshots in tools/fixtures/media):
//   image  `pricing.per_image` is an object keyed by a size token (`1024x1024`, `1024*1024`, `2k`, `16:9`, `square_hd`, `auto`);
//          four upscalers have it empty and a `starting_at`; `supported_parameters` is a bag of arrays and ad hoc objects.
//   video  `pricing` has no common figure (per second by resolution, per duration, per video, with/without audio, base price
//          plus extra seconds, and about 75 shapes that reduce to nothing); parameters are typed UI descriptors.
//   tts    one list for speech AND music/sound/processing; prices per 1k characters, per generation, per second, per interval,
//          per million tokens or "compute".
//   stt    prices per minute (some per second); four entries are voice-cloning ids, not transcribers.
// Every reader here is tolerant: junk gives the neutral value, an entry without an id is dropped, nothing throws.
import type {
    MediaCapabilities,
    MediaModel,
    MediaPrice,
    Medium,
    ParamSpec,
    PriceUnit,
} from '../shared/contracts-media';
import { isRecord, parseCost, roundUsd } from './usage';

/* ------------------------------------------------------------------------------------------------ small readers */

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const s = text(item);
        if (s) out.push(s);
    }
    return out;
}

function booleanOf(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

/** A price figure: a non-negative number or decimal string. */
function priceOf(value: unknown): number | null {
    return parseCost(value);
}

/** The numeric entries of an object (`{ '1024x1024': 0.0034 }`), keys renamed by `rename`. */
function priceMap(value: unknown, rename: (key: string) => string = (key) => key): Record<string, number> {
    const out: Record<string, number> = {};
    if (!isRecord(value)) return out;
    for (const [key, raw] of Object.entries(value)) {
        const n = priceOf(raw);
        if (n !== null) out[rename(key)] = n;
    }
    return out;
}

const hasKeys = (map: Record<string, number>): boolean => Object.keys(map).length > 0;

function flatPrice(unit: PriceUnit, value: number): MediaPrice {
    return { unit, from: value, to: value, byKey: {}, raw: null };
}

function spreadPrice(unit: PriceUnit, byKey: Record<string, number>): MediaPrice {
    const values = Object.values(byKey);
    return { unit, from: Math.min(...values), to: Math.max(...values), byKey: { ...byKey }, raw: null };
}

function unknownPrice(raw: unknown, from: number | null = null, to: number | null = from): MediaPrice {
    return { unit: 'unknown', from, to, byKey: {}, raw };
}

/* ------------------------------------------------------------------------------------------------ parameters */

/** `supported_parameters` keys that describe limits or inputs, not request fields a user can set. */
const META_KEYS = new Set([
    'required',
    'max_prompt_characters',
    'min_prompt_characters',
    'prompt_length',
    'max_images',
    'max_output_images',
    'max_input_images',
    'input_image_constraints',
    'fixed_image_count',
    'quote_source_dimensions',
    'max_output_pixels',
    'target_only_algorithms',
    'exact_factor_target_algorithms',
    'fixed_upscale_factor',
    'optional_prompt',
    'voices',
    'default_voice',
    'max_chars',
    'max_input_bytes',
    'payment_modes',
    'languages',
    'output_formats',
    'sample_rates',
    'sample_count_parameter',
    'generation_count_parameter',
    'max_generations',
    'min_samples',
    'max_samples',
    'min_duration',
    'max_duration',
    'duration_step',
    'default_duration',
    'default_text_duration',
    'default_video_duration',
    'video_min_duration',
    'duration_requires_no_audio_input',
    'return_url',
    'streaming',
    'stream',
    'music_mode',
    'resolutions',
]);

type Scalar = string | number | boolean | null;

function scalarOf(value: unknown): Scalar | undefined {
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
}

/** The values of an enumerated option list: `[{ value, label }]`, `['a', 'b']` or `[1, 2]`, as strings. */
function optionValues(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const raw = isRecord(item) ? item['value'] : item;
        if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out.push(String(raw));
    }
    return out;
}

/** The request fields that a bare `true` in the list says "supported" about, with the type they obviously have. */
function typeForBareFlag(key: string): ParamSpec['type'] {
    if (key === 'seed') return 'integer';
    if (/negative|prompt|instruction|style|lyrics/.test(key)) return 'text';
    return 'boolean';
}

function boundsOf(source: Record<string, unknown>): { min?: number; max?: number; step?: number } {
    const min = finite(source['min'] ?? source['minimum']);
    const max = finite(source['max'] ?? source['maximum']);
    const step = finite(source['step']);
    return {
        ...(min !== null ? { min } : {}),
        ...(max !== null ? { max } : {}),
        ...(step !== null ? { step } : {}),
    };
}

function withDefault(spec: ParamSpec, value: unknown): ParamSpec {
    const scalar = scalarOf(value);
    if (scalar !== undefined) spec.default = scalar;
    return spec;
}

/** One entry of `supported_parameters` (an array, a descriptor object, a bare flag) as a ParamSpec; null = not a setting. */
function specFromValue(key: string, value: unknown, fallbackDefault?: unknown): ParamSpec | null {
    if (!key || key.length > 64) return null;
    if (value === true) return { key, type: typeForBareFlag(key) };
    if (value === false || value === null || value === undefined) return null;
    if (Array.isArray(value)) {
        const values = optionValues(value);
        return values.length > 0 ? { key, type: 'enum', values } : null;
    }
    if (!isRecord(value)) return null;

    const kind = text(value['type']).toLowerCase();
    const values = optionValues(value['options'] ?? value['values'] ?? value['enum']);
    const defaultValue = value['default'] ?? fallbackDefault;
    const required = value['required'] === true ? { required: true } : {};
    if (values.length > 0) {
        // The values are strings, so the default is too (a list may give `default: 5` beside `options: ["5", "10"]`).
        const named =
            typeof defaultValue === 'number' || typeof defaultValue === 'boolean' ? String(defaultValue) : defaultValue;
        return withDefault({ key, type: 'enum', values, ...required }, named);
    }
    const bounds = boundsOf(value);
    if (kind === 'switch' || kind === 'boolean')
        return withDefault({ key, type: 'boolean', ...required }, defaultValue);
    if (kind === 'integer') return withDefault({ key, type: 'integer', ...bounds, ...required }, defaultValue);
    if (kind === 'number' || kind === '') {
        if (bounds.min !== undefined && bounds.max !== undefined) {
            return withDefault({ key, type: 'range', ...bounds, ...required }, defaultValue);
        }
        if (kind === 'number' || bounds.min !== undefined || bounds.max !== undefined) {
            return withDefault({ key, type: 'number', ...bounds, ...required }, defaultValue);
        }
        // Untyped and unbounded: the default tells what it is, else the name does.
        if (typeof defaultValue === 'boolean') return withDefault({ key, type: 'boolean', ...required }, defaultValue);
        if (typeof defaultValue === 'number') return withDefault({ key, type: 'number', ...required }, defaultValue);
        if (typeof defaultValue === 'string') return withDefault({ key, type: 'text', ...required }, defaultValue);
        return { key, type: typeForBareFlag(key) === 'text' ? 'text' : 'unknown', ...required };
    }
    if (kind === 'text' || kind === 'string') return withDefault({ key, type: 'text', ...required }, defaultValue);
    return { key, type: 'unknown', ...required };
}

/** Every setting of a `supported_parameters` bag except the limit-like keys. */
function collectParams(sp: Record<string, unknown>): ParamSpec[] {
    const params: ParamSpec[] = [];
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(sp)) {
        if (META_KEYS.has(key) || seen.has(key)) continue;
        const spec = specFromValue(key, value);
        if (!spec) continue;
        seen.add(key);
        params.push(spec);
    }
    return params;
}

/** The `required: ['voice', …]` list of a `supported_parameters` bag marks those settings. */
function markRequired(params: ParamSpec[], sp: Record<string, unknown>): ParamSpec[] {
    const required = new Set(strings(sp['required']));
    return required.size === 0
        ? params
        : params.map((spec) => (required.has(spec.key) ? { ...spec, required: true } : spec));
}

/* ------------------------------------------------------------------------------------------------ the common part */

interface Base {
    id: string;
    name: string;
    description: string;
    owner: string;
    category: string;
    tags: string[];
    subscriptionIncluded: boolean | null;
}

function baseOf(entry: Record<string, unknown>): Base | null {
    const id = text(entry['id']);
    if (!id) return null;
    const subscription = recordOf(entry['subscription']);
    return {
        id,
        name: text(entry['name']) || id,
        description: text(entry['description']),
        owner: text(entry['owned_by']),
        category: text(entry['category']),
        tags: strings(entry['tags']),
        subscriptionIncluded: booleanOf(subscription['included']) ?? null,
    };
}

function modalitiesOf(entry: Record<string, unknown>): { inputs: string[]; outputs: string[]; primary: string[] } {
    const arch = recordOf(entry['architecture']);
    let inputs = strings(arch['input_modalities']);
    let outputs = strings(arch['output_modalities']);
    const modality = text(arch['modality']);
    const [from = '', to = ''] = modality.includes('->') ? modality.split('->') : [];
    const primary = from
        .split('+')
        .map((s) => s.trim())
        .filter(Boolean);
    if (inputs.length === 0) inputs = primary;
    if (outputs.length === 0) outputs = to.split('+').map((s) => s.trim());
    // `input_modalities` also lists optional inputs (a video model may take an optional text prompt); the modality string
    // is the primary one (`video->music`).
    return { inputs: inputs.filter(Boolean), outputs: outputs.filter(Boolean), primary };
}

/** Sets a flag only when the list said something about it. */
function listed(caps: Record<string, unknown>, ...keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = booleanOf(caps[key]);
        if (value !== undefined) return value;
    }
    return undefined;
}

function putFlags(
    target: MediaCapabilities,
    flags: Partial<Record<keyof MediaCapabilities, boolean | undefined>>,
): void {
    for (const [key, value] of Object.entries(flags) as [keyof MediaCapabilities, boolean | undefined][]) {
        if (value !== undefined) target[key] = value;
    }
}

function assemble(
    medium: Medium,
    base: Base,
    parts: Pick<MediaModel, 'price' | 'capabilities' | 'params'> &
        Partial<Pick<MediaModel, 'voices' | 'formats' | 'maxInputImages' | 'priceIsApproximate'>>,
): MediaModel {
    return {
        id: base.id,
        medium,
        name: base.name,
        description: base.description,
        owner: base.owner,
        category: base.category,
        tags: base.tags,
        price: parts.price,
        capabilities: parts.capabilities,
        params: parts.params,
        voices: parts.voices ?? [],
        formats: parts.formats ?? [],
        maxInputImages: parts.maxInputImages ?? 0,
        subscriptionIncluded: base.subscriptionIncluded,
        priceIsApproximate: parts.priceIsApproximate ?? false,
    };
}

/* ------------------------------------------------------------------------------------------------ image */

function imagePrice(pricing: Record<string, unknown>): MediaPrice {
    const perImage = priceMap(pricing['per_image']);
    if (hasKeys(perImage)) return spreadPrice('image', perImage);
    const perMegapixel = priceOf(pricing['per_megapixel']);
    if (perMegapixel !== null) return flatPrice('megapixel', perMegapixel);
    // The Topaz upscalers: an empty table, a "starting at" and a tariff of blocks nobody can price from a size alone.
    return unknownPrice(pricing, priceOf(pricing['starting_at']));
}

function imageModel(base: Base, entry: Record<string, unknown>): MediaModel {
    const caps = recordOf(entry['capabilities']);
    const sp = recordOf(entry['supported_parameters']);
    const { inputs } = modalitiesOf(entry);
    const acceptsText = inputs.length === 0 || inputs.includes('text');
    const editOnly =
        !base.tags.includes('text-to-image') &&
        (base.tags.includes('image-edit') || base.tags.includes('image-to-image'));
    const maxIn = finite(sp['max_input_images']);
    const imageToImage = caps['image_to_image'] === true || (maxIn !== null && maxIn > 0);
    const maxInputImages = maxIn !== null && maxIn >= 0 ? Math.floor(maxIn) : imageToImage ? 1 : 0;

    const capabilities: MediaCapabilities = {
        textToImage: acceptsText && !editOnly && caps['image_generation'] !== false,
        imageToImage,
        inpainting: caps['inpainting'] === true,
    };
    putFlags(capabilities, { nsfw: listed(caps, 'nsfw') });

    const params: ParamSpec[] = [];
    const sizes = strings(sp['resolutions']);
    if (sizes.length > 0) params.push({ key: 'size', type: 'enum', values: sizes });
    const fixed = finite(sp['fixed_image_count']);
    const maxImages = finite(sp['max_images']) ?? finite(sp['max_output_images']);
    if (fixed !== null && fixed >= 1) {
        params.push({
            key: 'n',
            type: 'integer',
            min: Math.floor(fixed),
            max: Math.floor(fixed),
            default: Math.floor(fixed),
        });
    } else if (maxImages !== null && maxImages >= 1) {
        params.push({ key: 'n', type: 'integer', min: 1, max: Math.floor(maxImages), default: 1 });
    }
    params.push(...collectParams(sp));

    return assemble('image', base, {
        price: imagePrice(recordOf(entry['pricing'])),
        capabilities,
        params: markRequired(params, sp),
        maxInputImages,
    });
}

/* ------------------------------------------------------------------------------------------------ video */

/** Pricing keys that say nothing about the price itself (limits, defaults, descriptions). */
const NEUTRAL_PRICE_KEY =
    /^(currency|note|unit|billing|available|type|variant|resolution|outputs|formula|source_metadata_required|num_inference_steps|duration_step|maxSeconds|maxMinutes)$|^(minimum|maximum)(_|$)|^(min|max)_|^default_|^supported_|^fixed_duration|^frame_limits|^durations_seconds|^reference_(video|image)_(min|max)/;

const PRICE_LEAF_KEY = /(per_|price|rate|fee|usd|cost)/i;
const NOT_A_PRICE_KEY = /(multiplier|threshold|limit|max|min|ratio|count|bytes|frames|fps|steps)/i;

/** The cheapest and dearest figure found under price-like keys of an unreadable price block (depth <= 3). */
function scanPrices(value: unknown, depth = 0, under = false): number[] {
    if (depth > 3) return [];
    if (typeof value === 'number') return under && Number.isFinite(value) && value >= 0 ? [value] : [];
    if (!isRecord(value)) return [];
    const found: number[] = [];
    for (const [key, item] of Object.entries(value)) {
        if (NOT_A_PRICE_KEY.test(key) || NEUTRAL_PRICE_KEY.test(key)) continue;
        found.push(...scanPrices(item, depth + 1, under || PRICE_LEAF_KEY.test(key)));
    }
    return found;
}

const durationKey = (key: string): string => (/^\d+(\.\d+)?$/.test(key.trim()) ? `${key.trim()}s` : key);

interface VideoPrice {
    price: MediaPrice;
    approximate: boolean;
}

function videoPrice(pricing: Record<string, unknown>): VideoPrice {
    const used = new Set<string>(['currency']);
    const use = (key: string): void => void used.add(key);
    let price: MediaPrice | null = null;
    /** The shape is known but one figure cannot stand for every option (audio on/off, duration overrides). */
    let forced = false;

    const perSecondTable = priceMap(pricing['per_second_by_resolution']);
    const perSecond = pricing['per_second'];
    const perDuration = priceMap(pricing['per_duration'], durationKey);
    const baseTable = priceMap(pricing['base_prices_by_resolution']);

    if (hasKeys(perSecondTable)) {
        price = spreadPrice('second', perSecondTable);
        use('per_second_by_resolution');
    } else if (isRecord(perSecond) && hasKeys(priceMap(perSecond))) {
        price = spreadPrice('second', priceMap(perSecond));
        use('per_second');
    } else if (priceOf(perSecond) !== null) {
        price = flatPrice('second', priceOf(perSecond) as number);
        use('per_second');
    } else if (priceOf(pricing['pricePerSecond']) !== null) {
        price = flatPrice('second', priceOf(pricing['pricePerSecond']) as number);
        use('pricePerSecond');
    } else if (priceOf(pricing['pricePerMinute']) !== null) {
        price = flatPrice('minute', priceOf(pricing['pricePerMinute']) as number);
        use('pricePerMinute');
    } else if (hasKeys(perDuration)) {
        price = spreadPrice('request', perDuration);
        use('per_duration');
    } else if (priceOf(pricing['per_video']) !== null) {
        price = flatPrice('request', priceOf(pricing['per_video']) as number);
        use('per_video');
    } else if (priceOf(pricing['with_audio']) !== null && priceOf(pricing['without_audio']) !== null) {
        price = spreadPrice('request', {
            with_audio: priceOf(pricing['with_audio']) as number,
            without_audio: priceOf(pricing['without_audio']) as number,
        });
        use('with_audio');
        use('without_audio');
        forced = true;
    } else if (hasKeys(baseTable)) {
        price = spreadPrice('request', baseTable);
        use('base_prices_by_resolution');
        forced = true;
    } else if (priceOf(pricing['base_price']) !== null) {
        const base = priceOf(pricing['base_price']) as number;
        const extra = priceOf(pricing['per_extra_second']);
        const baseSeconds = finite(pricing['base_duration']);
        const maxSeconds = finite(pricing['max_duration']);
        const top =
            extra !== null && baseSeconds !== null && maxSeconds !== null && maxSeconds > baseSeconds
                ? roundUsd(base + extra * (maxSeconds - baseSeconds))
                : base;
        price = { unit: 'request', from: base, to: top, byKey: {}, raw: null };
        for (const key of ['base_price', 'per_extra_second', 'base_duration']) use(key);
        forced = true;
    }

    if (!price) {
        const found = scanPrices(pricing);
        const from = found.length > 0 ? Math.min(...found) : null;
        const to = found.length > 0 ? Math.max(...found) : null;
        return { price: unknownPrice(pricing, from, to), approximate: true };
    }
    // Anything else that moves the price (multipliers, per-mode tables, reference-video rates) makes the figure approximate;
    // a zero (an `audio_surcharge: 0`) moves nothing.
    const leftover = Object.entries(pricing).some(
        ([key, value]) =>
            !used.has(key) &&
            !NEUTRAL_PRICE_KEY.test(key) &&
            ((typeof value === 'number' && value !== 0) || (typeof value === 'object' && value !== null)),
    );
    return { price, approximate: forced || leftover };
}

function videoModel(base: Base, entry: Record<string, unknown>): MediaModel {
    const caps = recordOf(entry['capabilities']);
    const sp = recordOf(entry['supported_parameters']);
    const descriptors = recordOf(sp['parameters']);
    const defaults = recordOf(sp['defaults']);
    const { inputs } = modalitiesOf(entry);

    const capabilities: MediaCapabilities = {};
    putFlags(capabilities, {
        textToVideo: listed(caps, 'text_to_video'),
        imageToVideo: listed(caps, 'image_to_video'),
        videoToVideo: listed(caps, 'video_to_video'),
        audioInput: listed(caps, 'audio_input'),
        nsfw: listed(caps, 'nsfw'),
    });
    const takesImage = capabilities.imageToVideo === true || inputs.includes('image');
    const references = recordOf(descriptors['reference_images']);
    const maxReferences = finite(references['max_items']);
    const maxInputImages = takesImage ? Math.max(1, maxReferences !== null ? Math.floor(maxReferences) : 1) : 0;

    const params: ParamSpec[] = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
        const spec = specFromValue(key, descriptor, defaults[key]);
        if (spec) params.push(spec);
    }
    const { price, approximate } = videoPrice(recordOf(entry['pricing']));
    return assemble('video', base, {
        price,
        capabilities,
        params,
        maxInputImages,
        priceIsApproximate: approximate,
    });
}

/* ------------------------------------------------------------------------------------------------ speech and music */

function ttsPrice(pricing: Record<string, unknown>): MediaPrice {
    const perChars = priceOf(pricing['per_thousand_chars']);
    const perBytes = priceOf(pricing['per_thousand_utf8_bytes']);
    const perGeneration = priceOf(pricing['per_generation']);
    const perSecond = priceOf(pricing['per_second']);
    const perInterval = priceOf(pricing['per_billing_interval']);
    const interval = finite(pricing['billing_interval_seconds']);
    const prompt = priceOf(pricing['prompt']);
    const completion = priceOf(pricing['completion']);

    // A zero next to a real figure is a placeholder (`per_thousand_chars: 0` beside `per_generation`).
    if (perChars !== null && (perChars > 0 || (perGeneration === null && perBytes === null))) {
        return flatPrice('thousand_chars', perChars);
    }
    if (perBytes !== null) return flatPrice('thousand_bytes', perBytes);
    if (perGeneration !== null) return flatPrice('request', perGeneration);
    if (perSecond !== null) return flatPrice('second', perSecond);
    if (perInterval !== null && interval !== null && interval > 0) {
        return interval === 60 ? flatPrice('minute', perInterval) : flatPrice('second', perInterval / interval);
    }
    if (prompt !== null || completion !== null) {
        const byKey: Record<string, number> = {};
        if (prompt !== null) byKey['prompt'] = prompt;
        if (completion !== null) byKey['completion'] = completion;
        return spreadPrice('million_tokens', byKey);
    }
    return unknownPrice(pricing);
}

/** `output_format`/`response_format` as the list gives it: `{ values }`, `{ values, default }` or a bare array. */
function formatsOf(sp: Record<string, unknown>): string[] {
    for (const key of ['response_format', 'output_format', 'output_formats']) {
        const value = sp[key];
        const list = isRecord(value) ? optionValues(value['values'] ?? value['options']) : optionValues(value);
        if (list.length > 0) return list;
    }
    return [];
}

function ttsModel(base: Base, entry: Record<string, unknown>): MediaModel | null {
    const caps = recordOf(entry['capabilities']);
    const sp = recordOf(entry['supported_parameters']);
    const { inputs, outputs, primary } = modalitiesOf(entry);
    const speech = caps['text_to_speech'] === true;
    const acceptsText = primary.length > 0 ? primary.includes('text') : inputs.length === 0 || inputs.includes('text');
    const makesAudioFromText =
        caps['text_to_music'] === true ||
        caps['text_to_audio'] === true ||
        (acceptsText && (outputs.includes('audio') || outputs.includes('music')));
    // The `type=tts` list also carries audio processing, lyrics and analysis entries that take no text or answer no audio
    // (nothing `POST /v1/audio/speech` can drive): they are not part of the speech catalog.
    if (!speech && !makesAudioFromText) return null;

    const capabilities: MediaCapabilities = { music: !speech };
    putFlags(capabilities, {
        voiceCloning: listed(caps, 'voice_cloning', 'voice_clone'),
        streaming: listed(caps, 'streaming'),
    });
    const voices = strings(sp['voices']);
    const params: ParamSpec[] = [];
    if (voices.length > 0) {
        const preferred = text(sp['default_voice']);
        params.push(
            preferred && voices.includes(preferred)
                ? { key: 'voice', type: 'enum', values: voices, default: preferred }
                : { key: 'voice', type: 'enum', values: voices },
        );
    }
    const formats = formatsOf(sp);
    const formatSpec = specFromValue('response_format', sp['response_format']);
    if (formatSpec?.type === 'enum') params.push(formatSpec);
    else if (formats.length > 0) params.push({ key: 'response_format', type: 'enum', values: formats });
    params.push(...collectParams(sp).filter((spec) => spec.key !== 'response_format' && spec.key !== 'output_format'));

    return assemble('tts', base, {
        price: ttsPrice(recordOf(entry['pricing'])),
        capabilities,
        params: markRequired(params, sp),
        voices,
        formats,
    });
}

/* ------------------------------------------------------------------------------------------------ transcription */

function sttPrice(pricing: Record<string, unknown>): MediaPrice {
    const perMinute = priceOf(pricing['per_minute']);
    if (perMinute !== null) return flatPrice('minute', perMinute);
    const perSecond = priceOf(pricing['per_second']);
    if (perSecond !== null) return flatPrice('second', perSecond);
    // The voice-cloning ids bill per run.
    const perGeneration = priceOf(pricing['per_generation']);
    if (perGeneration !== null) return flatPrice('request', perGeneration);
    return unknownPrice(pricing);
}

function sttModel(base: Base, entry: Record<string, unknown>): MediaModel {
    const caps = recordOf(entry['capabilities']);
    const sp = recordOf(entry['supported_parameters']);
    const features = strings(sp['features']).join(' ');
    const cloning = /voice[-_ ]?clon/i.test(base.id) || /voice[-_ ]?clon/i.test(features);

    const capabilities: MediaCapabilities = { audioInput: true };
    putFlags(capabilities, {
        diarization: listed(caps, 'diarization', 'diarization_beta'),
        streaming: listed(caps, 'realtime'),
        voiceCloning: cloning ? true : undefined,
    });

    const params: ParamSpec[] = [];
    const languages = strings(sp['supported_languages']);
    params.push(
        languages.length > 0
            ? { key: 'language', type: 'enum', values: languages, default: languages.includes('auto') ? 'auto' : null }
            : { key: 'language', type: 'text' },
    );
    const responseFormats = strings(sp['response_formats']);
    if (responseFormats.length > 0) {
        params.push({
            key: 'response_format',
            type: 'enum',
            values: responseFormats,
            default: responseFormats[0] ?? null,
        });
    }
    if (capabilities.diarization === true) params.push({ key: 'diarize', type: 'boolean', default: false });
    // What a recording may be: lower-case extensions, and the smallest of the two size limits (MB).
    const accepted = strings(sp['supported_formats']).map((format) => format.toLowerCase());
    if (accepted.length > 0) params.push({ key: 'input_format', type: 'enum', values: accepted });
    const limits = [finite(sp['max_file_size_mb']), finite(sp['max_request_body_mb'])].filter(
        (n): n is number => n !== null && n > 0,
    );
    if (limits.length > 0) params.push({ key: 'file_size_mb', type: 'number', min: 0, max: Math.min(...limits) });

    return assemble('stt', base, { price: sttPrice(recordOf(entry['pricing'])), capabilities, params });
}

/* ------------------------------------------------------------------------------------------------ the entry point */

function entriesOf(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (isRecord(raw)) {
        if (Array.isArray(raw['data'])) return raw['data'];
        if (Array.isArray(raw['models'])) return raw['models'];
    }
    return [];
}

function normalizeEntry(medium: Medium, entry: unknown): MediaModel | null {
    if (!isRecord(entry)) return null;
    const base = baseOf(entry);
    if (!base) return null;
    switch (medium) {
        case 'image':
            return imageModel(base, entry);
        case 'video':
            return videoModel(base, entry);
        case 'tts':
            return ttsModel(base, entry);
        case 'stt':
            return sttModel(base, entry);
        default:
            return null;
    }
}

/**
 * One model list as NanoGPT sent it (`data` array of `GET /api/v1/images/models`, `/video-models`,
 * `/audio-models?type=tts|stt`) -> MediaModel[]. Tolerant: an entry that cannot be read is dropped, a field that cannot be
 * read gets its neutral value; never throws.
 *
 * For `tts` the list mixes three kinds of entry: speech (`capabilities.text_to_speech`), music and sound generation from
 * a text prompt (`capabilities.music: true`) and audio processing/lyrics/analysis that no speech call can drive (dropped).
 * For `stt` the voice-cloning ids that ride on the same list are kept but flagged `capabilities.voiceCloning`.
 * `ParamSpec.key` is the upstream request field (`size`, `aspect_ratio`, `duration`, `voice`, `response_format` …); the
 * image `resolutions` become `size` and `max_images` become `n`; for `stt` the extra keys `input_format` (accepted file
 * types, lower case) and `file_size_mb` (the smallest size limit) describe the recording.
 */
export function normalizeMediaList(medium: Medium, raw: unknown): MediaModel[] {
    const seen = new Set<string>();
    const out: MediaModel[] = [];
    for (const entry of entriesOf(raw)) {
        let model: MediaModel | null;
        try {
            model = normalizeEntry(medium, entry);
        } catch {
            model = null;
        }
        if (!model || seen.has(model.id)) continue;
        seen.add(model.id);
        out.push(model);
    }
    return out;
}

/* ------------------------------------------------------------------------------------------------ estimates */

/** `1024*1024`, `1024X1024`, `1024×1024` -> `1024x1024`; everything else lower-cased. */
function sizeKey(size: string): string {
    return size.trim().toLowerCase().replace(/[×*]/g, 'x');
}

function parseSize(size: string): { width: number; height: number } | null {
    const m = /^(\d{1,5})x(\d{1,5})$/.exec(sizeKey(size));
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
}

/** The figure for a named option (size, resolution): the exact entry, else the cheapest the list gives. */
function figureFor(price: MediaPrice, name: string | undefined, normalize: (key: string) => string): number | null {
    if (name !== undefined && name.trim() !== '') {
        const wanted = normalize(name);
        for (const [key, value] of Object.entries(price.byKey)) {
            if (normalize(key) === wanted) return value;
        }
    }
    return price.from;
}

function positive(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** USD for `n` images of `size` (`WxH` or a size token the price list names); null when not computable. */
export function estimateImageCost(model: MediaModel, request: { n?: number; size?: string }): number | null {
    const n = typeof request.n === 'number' && Number.isInteger(request.n) && request.n >= 1 ? request.n : 1;
    const { price } = model;
    if (price.unit === 'image') {
        const each = figureFor(price, request.size, sizeKey);
        return each === null ? null : roundUsd(each * n);
    }
    if (price.unit === 'megapixel' && price.from !== null && request.size) {
        const size = parseSize(request.size);
        return size ? roundUsd(price.from * ((size.width * size.height) / 1_000_000) * n) : null;
    }
    return null;
}

/**
 * USD for a video of `duration` seconds at `resolution`; null when not computable: the price is approximate (a floor, a
 * multiplier, per-mode tables …) or missing, the duration is not given for a per-second price, or a per-duration price
 * has no entry for it. A resolution the list does not name falls back to the cheapest one.
 */
export function estimateVideoCost(
    model: MediaModel,
    request: { duration?: number; resolution?: string },
): number | null {
    const { price } = model;
    if (model.priceIsApproximate || price.from === null) return null;
    if (price.unit === 'second' || price.unit === 'minute') {
        const seconds = positive(request.duration);
        const rate =
            price.unit === 'second' ? figureFor(price, request.resolution, (k) => k.trim().toLowerCase()) : price.from;
        if (seconds === null || rate === null) return null;
        return roundUsd(rate * (price.unit === 'second' ? seconds : seconds / 60));
    }
    if (price.unit === 'request') {
        if (!hasKeys(price.byKey)) return price.from;
        const seconds = positive(request.duration);
        if (seconds === null) return price.from;
        const exact = price.byKey[`${seconds}s`];
        return exact === undefined ? null : exact;
    }
    return null;
}

/** USD for `chars` characters of speech; null when not computable. */
export function estimateTtsCost(model: MediaModel, chars: number): number | null {
    const { price } = model;
    if (price.from === null || !Number.isFinite(chars) || chars < 0) return null;
    if (price.unit === 'thousand_chars') return roundUsd((chars / 1000) * price.from);
    if (price.unit === 'request') return price.from;
    return null;
}

/** USD for `seconds` of audio to transcribe; null when not computable. */
export function estimateSttCost(model: MediaModel, seconds: number): number | null {
    const { price } = model;
    if (price.from === null || !Number.isFinite(seconds) || seconds < 0) return null;
    if (price.unit === 'minute') return roundUsd((seconds / 60) * price.from);
    if (price.unit === 'second') return roundUsd(seconds * price.from);
    if (price.unit === 'request') return price.from;
    return null;
}

/** A price as a short, locale-free string for logs and tests (`0.0017/image`, `0.0017-0.0051/image`, `?`); the UI words it itself. */
export function describePrice(price: MediaPrice): string {
    if (price.from === null) return '?';
    const range = price.to !== null && price.to !== price.from ? `${price.from}-${price.to}` : `${price.from}`;
    return `${range}/${price.unit}`;
}
