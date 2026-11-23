// The media studios without the DOM: what a model's ParamSpec list turns into as form fields, what a draft must satisfy
// before a call is made, and the request it becomes. NanoGPT's model lists are heterogeneous, so a field only exists when the
// model's `params` list it (an enum becomes a choice, a range a bounded number, a free text a `WxH` box); everything else is
// not offered, so the plugin never receives a setting the model does not know. Pure functions of their arguments, tested
// directly; the view files only draw what they return.
import type {
    ImageRequest,
    MediaModel,
    ParamSpec,
    SttRequest,
    TtsRequest,
    VideoRequest,
} from '../../shared/contracts-media';

/** NanoGPT accepts uploads up to 4 MB; a data URL is measured after encoding (base64 is a third larger than the file). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** Longest recording the studio makes; the size ceiling usually comes first. */
export const MAX_RECORDING_SECONDS = 300;
/** Default and hard limit of images per call when the model's list names none. */
export const DEFAULT_MAX_IMAGES = 4;

/* ------------------------------------------------------------------------------------------------ param lookup */

export const SIZE_KEYS = ['size', 'resolution', 'resolutions', 'image_size'] as const;
export const ASPECT_KEYS = ['aspect_ratio', 'aspectRatio'] as const;
export const NEGATIVE_KEYS = ['negative_prompt', 'negativePrompt'] as const;
export const SEED_KEYS = ['seed'] as const;
export const STEPS_KEYS = ['steps', 'num_steps', 'num_inference_steps'] as const;
export const GUIDANCE_KEYS = ['guidance', 'guidance_scale', 'cfg_scale'] as const;
export const COUNT_KEYS = ['n', 'num_images', 'max_images', 'max_output_images'] as const;
export const DURATION_KEYS = ['duration', 'seconds'] as const;
export const SPEED_KEYS = ['speed'] as const;
export const INSTRUCTIONS_KEYS = ['instructions'] as const;

/** The first of `keys` the model lists (case-insensitive), null when none. */
export function findParam(model: MediaModel, keys: readonly string[]): ParamSpec | null {
    for (const key of keys) {
        const found = model.params.find((spec) => spec.key.toLowerCase() === key.toLowerCase());
        if (found) return found;
    }
    return null;
}

/* ------------------------------------------------------------------------------------------------ parsing */

/**
 * What a user typed into a number field: '' = null ("no value"), a decimal number (a comma works as the decimal mark,
 * spaces inside are grouping) = the number, anything else = undefined (not a number).
 */
export function parseNumber(text: string): number | null | undefined {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const compact = trimmed.replace(/\s/g, '').replace(',', '.');
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(compact)) return undefined;
    const value = Number(compact);
    return Number.isFinite(value) ? value : undefined;
}

/** `1024x1024`, `1024 x 1024`, `1024*1024` or `1024×1024` as numbers; null for anything else (and for a zero side). */
export function parseSize(text: string): { width: number; height: number } | null {
    const match = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$/i.exec(text);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : null;
}

/** The leading number of a duration word: `5` -> 5, `"8s"` -> 8, `"12 s"` -> 12; null when there is none. */
export function parseDuration(text: string): number | null {
    const match = /^\s*(\d+(?:[.,]\d+)?)/.exec(text);
    if (!match) return null;
    const value = Number((match[1] ?? '').replace(',', '.'));
    return Number.isFinite(value) && value > 0 ? value : null;
}

/** Size in bytes of an encoded data URL (the measure NanoGPT's 4 MB applies to); an empty string is 0. */
export function dataUrlBytes(dataUrl: string): number {
    return dataUrl.length;
}

/** Is this a data URL of an image the plugin can forward, within the 4 MB ceiling? */
export function checkImageDataUrl(dataUrl: string): 'ok' | 'not_image' | 'too_large' {
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) return 'not_image';
    return dataUrlBytes(dataUrl) > MAX_UPLOAD_BYTES ? 'too_large' : 'ok';
}

/** Is a recording or an audio file within the 4 MB ceiling? `bytes` is the file's own size. */
export function checkAudioBytes(bytes: number): 'ok' | 'empty' | 'too_large' {
    if (!(bytes > 0)) return 'empty';
    return bytes > MAX_UPLOAD_BYTES ? 'too_large' : 'ok';
}

/** The data URL's payload without its prefix (the plugin's STT route wants plain base64). */
export function stripDataUrl(dataUrl: string): string {
    const comma = dataUrl.indexOf(',');
    return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

const EXTENSIONS: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/webm': 'webm',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/** The file extension for a content type, as the response said it (`audio/x-wav` -> `wav`); `bin` when unknown. */
export function extensionOf(mime: string): string {
    const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
    const known = EXTENSIONS[base];
    if (known) return known;
    const subtype = base.split('/')[1] ?? '';
    return /^[a-z0-9]{2,5}$/.test(subtype) ? subtype : 'bin';
}

/** `nanovia-<model>-<n>.<ext>` with the model id made safe for a file name. */
export function downloadName(model: string, index: number, mime: string): string {
    const safe = model.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'media';
    return `nanovia-${safe}-${index + 1}.${extensionOf(mime)}`;
}

/* ------------------------------------------------------------------------------------------------ field specs */

/** A choice list, or a free text box (`WxH` for sizes). */
export type ChoiceField =
    { kind: 'enum'; key: string; values: string[]; default: string } | { kind: 'free'; key: string; default: string };

export interface NumberField {
    key: string;
    min: number | null;
    max: number | null;
    step: number | null;
    default: number | null;
    integer: boolean;
}

function choiceField(spec: ParamSpec | null, freeText: boolean): ChoiceField | null {
    if (!spec) return null;
    if (spec.type === 'enum' && spec.values && spec.values.length > 0) {
        const wanted = typeof spec.default === 'string' || typeof spec.default === 'number' ? String(spec.default) : '';
        return {
            kind: 'enum',
            key: spec.key,
            values: spec.values,
            default: spec.values.includes(wanted) ? wanted : (spec.values[0] ?? ''),
        };
    }
    if (freeText && (spec.type === 'text' || spec.type === 'unknown')) {
        return { kind: 'free', key: spec.key, default: typeof spec.default === 'string' ? spec.default : '' };
    }
    return null;
}

function numberField(spec: ParamSpec | null): NumberField | null {
    if (!spec) return null;
    if (spec.type !== 'range' && spec.type !== 'integer' && spec.type !== 'number' && spec.type !== 'unknown') {
        return null;
    }
    const fallback = typeof spec.default === 'number' ? spec.default : null;
    return {
        key: spec.key,
        min: spec.min ?? null,
        max: spec.max ?? null,
        step: spec.step ?? null,
        default: fallback,
        integer: spec.type === 'integer',
    };
}

/** True for a flag-like param (`negative_prompt: true`) or any param that is simply listed. */
function listed(spec: ParamSpec | null): boolean {
    return spec !== null;
}

export interface ImageFormSpec {
    size: ChoiceField | null;
    aspect: ChoiceField | null;
    negative: boolean;
    /** Images per call: 1..max. */
    count: { max: number };
    seed: NumberField | null;
    steps: NumberField | null;
    guidance: NumberField | null;
    /** How many reference images the model takes; null = it takes none (the upload is not offered). */
    references: { max: number } | null;
}

export function imageForm(model: MediaModel): ImageFormSpec {
    const count = findParam(model, COUNT_KEYS);
    const countMax =
        count?.max ?? (count?.values ? Math.max(...count.values.map(Number).filter(Number.isFinite), 1) : null);
    const takesInput = model.maxInputImages > 0 || model.capabilities.imageToImage === true;
    return {
        size: choiceField(findParam(model, SIZE_KEYS), true),
        aspect: choiceField(findParam(model, ASPECT_KEYS), false),
        negative: listed(findParam(model, NEGATIVE_KEYS)),
        count: { max: Math.max(1, Math.floor(countMax ?? DEFAULT_MAX_IMAGES)) },
        seed: numberField(findParam(model, SEED_KEYS)),
        steps: numberField(findParam(model, STEPS_KEYS)),
        guidance: numberField(findParam(model, GUIDANCE_KEYS)),
        references: takesInput ? { max: Math.max(1, model.maxInputImages || 1) } : null,
    };
}

export interface VideoFormSpec {
    /** Seconds: a choice of the listed durations or a bounded number. */
    duration: { kind: 'enum'; values: string[]; default: string } | { kind: 'number'; field: NumberField } | null;
    aspect: ChoiceField | null;
    resolution: ChoiceField | null;
    seed: NumberField | null;
    /** The start image of an image-to-video model; null = the model has none. */
    startImage: boolean;
}

export function videoForm(model: MediaModel): VideoFormSpec {
    const durationSpec = findParam(model, DURATION_KEYS);
    let duration: VideoFormSpec['duration'] = null;
    if (durationSpec) {
        const choice = choiceField(durationSpec, false);
        if (choice && choice.kind === 'enum')
            duration = { kind: 'enum', values: choice.values, default: choice.default };
        else {
            const field = numberField(durationSpec);
            if (field) duration = { kind: 'number', field };
        }
    }
    return {
        duration,
        aspect: choiceField(findParam(model, ASPECT_KEYS), false),
        resolution: choiceField(findParam(model, ['resolution', 'resolutions']), false),
        seed: numberField(findParam(model, SEED_KEYS)),
        startImage: model.capabilities.imageToVideo === true || model.maxInputImages > 0,
    };
}

export interface TtsFormSpec {
    /** The voices the list names; empty = a free text box. */
    voices: string[];
    /** The model lists `speed`; when it does not, the field is still offered (most models take it) but flagged. */
    speed: { min: number; max: number; step: number; listed: boolean };
    instructions: boolean;
}

export function ttsForm(model: MediaModel): TtsFormSpec {
    const spec = findParam(model, SPEED_KEYS);
    return {
        voices: model.voices,
        speed: {
            min: spec?.min ?? 0.25,
            max: spec?.max ?? 4,
            step: spec?.step ?? 0.05,
            listed: spec !== null,
        },
        instructions: findParam(model, INSTRUCTIONS_KEYS) !== null,
    };
}

export interface SttFormSpec {
    diarize: boolean;
}

export function sttForm(model: MediaModel): SttFormSpec {
    return { diarize: model.capabilities.diarization === true || findParam(model, ['diarize']) !== null };
}

/* ------------------------------------------------------------------------------------------------ drafts */

export interface ReferenceImage {
    name: string;
    dataUrl: string;
    bytes: number;
}

export interface ImageDraft {
    model: string | null;
    prompt: string;
    negative: string;
    size: string;
    aspect: string;
    count: string;
    seed: string;
    steps: string;
    guidance: string;
    references: ReferenceImage[];
}

export function emptyImageDraft(): ImageDraft {
    return {
        model: null,
        prompt: '',
        negative: '',
        size: '',
        aspect: '',
        count: '1',
        seed: '',
        steps: '',
        guidance: '',
        references: [],
    };
}

export interface TtsDraft {
    model: string | null;
    voice: string;
    text: string;
    speed: string;
    instructions: string;
}

export function emptyTtsDraft(): TtsDraft {
    return { model: null, voice: '', text: '', speed: '1', instructions: '' };
}

export interface SttDraft {
    model: string | null;
    language: string;
    diarize: boolean;
}

export function emptySttDraft(): SttDraft {
    return { model: null, language: '', diarize: false };
}

export interface VideoDraft {
    model: string | null;
    prompt: string;
    duration: string;
    aspect: string;
    resolution: string;
    seed: string;
    startImage: ReferenceImage | null;
}

export function emptyVideoDraft(): VideoDraft {
    return { model: null, prompt: '', duration: '', aspect: '', resolution: '', seed: '', startImage: null };
}

/** The value a choice field starts with for a model: what the draft has if the model still offers it, else the default. */
export function choiceValue(field: ChoiceField | null, current: string): string {
    if (!field) return '';
    if (field.kind === 'free') return current || field.default;
    return field.values.includes(current) ? current : field.default;
}

/* ------------------------------------------------------------------------------------------------ validation */

export type IssueCode =
    | 'prompt_empty'
    | 'text_empty'
    | 'size_invalid'
    | 'count_range'
    | 'number_invalid'
    | 'number_range'
    | 'too_many_references'
    | 'reference_not_image'
    | 'reference_too_large'
    | 'audio_missing'
    | 'audio_too_large'
    | 'no_model';

export interface FormIssue {
    code: IssueCode;
    /** The field the issue is about (`size`, `seed`, `count` …), for the message and the highlight. */
    field: string;
    /** A bound or an index the message names (`max`, the reference number). */
    detail?: number | string;
}

export type FormResult<T> = { ok: true; request: T } | { ok: false; issues: FormIssue[] };

function readNumber(text: string, field: NumberField, issues: FormIssue[], name: string): number | undefined {
    const value = parseNumber(text);
    if (value === undefined) {
        issues.push({ code: 'number_invalid', field: name });
        return undefined;
    }
    if (value === null) return undefined;
    if (field.integer && !Number.isInteger(value)) {
        issues.push({ code: 'number_invalid', field: name });
        return undefined;
    }
    if ((field.min !== null && value < field.min) || (field.max !== null && value > field.max)) {
        issues.push({ code: 'number_range', field: name, detail: field.min !== null ? field.min : (field.max ?? 0) });
        return undefined;
    }
    return value;
}

function checkReferences(references: readonly ReferenceImage[], max: number, issues: FormIssue[], field: string): void {
    if (references.length > max) issues.push({ code: 'too_many_references', field, detail: max });
    references.forEach((reference, index) => {
        const verdict = checkImageDataUrl(reference.dataUrl);
        if (verdict === 'not_image') issues.push({ code: 'reference_not_image', field, detail: index + 1 });
        else if (verdict === 'too_large') issues.push({ code: 'reference_too_large', field, detail: index + 1 });
    });
}

/** What the plugin receives for an image call; issues otherwise. Fields the model does not list are never sent. */
export function buildImageRequest(model: MediaModel, draft: ImageDraft): FormResult<ImageRequest> {
    const spec = imageForm(model);
    const issues: FormIssue[] = [];
    const prompt = draft.prompt.trim();
    if (!prompt) issues.push({ code: 'prompt_empty', field: 'prompt' });

    const request: ImageRequest = { model: model.id, prompt };

    if (spec.negative && draft.negative.trim()) request.negativePrompt = draft.negative.trim();

    const count = parseNumber(draft.count);
    if (count === undefined || (count !== null && (!Number.isInteger(count) || count < 1 || count > spec.count.max))) {
        issues.push({ code: 'count_range', field: 'count', detail: spec.count.max });
    } else if (count !== null && count > 1) request.n = count;

    if (spec.size) {
        const size = choiceValue(spec.size, draft.size).trim();
        if (spec.size.kind === 'free' && size && !parseSize(size)) issues.push({ code: 'size_invalid', field: 'size' });
        else if (size) request.size = size;
    }
    if (spec.aspect) {
        const aspect = choiceValue(spec.aspect, draft.aspect);
        if (aspect) request.aspectRatio = aspect;
    }
    if (spec.seed) {
        const seed = readNumber(draft.seed, spec.seed, issues, 'seed');
        if (seed !== undefined) request.seed = Math.trunc(seed);
    }
    if (spec.steps) {
        const steps = readNumber(draft.steps, spec.steps, issues, 'steps');
        if (steps !== undefined) request.steps = Math.trunc(steps);
    }
    if (spec.guidance) {
        const guidance = readNumber(draft.guidance, spec.guidance, issues, 'guidance');
        if (guidance !== undefined) request.guidance = guidance;
    }
    if (spec.references && draft.references.length > 0) {
        checkReferences(draft.references, spec.references.max, issues, 'references');
        request.inputImages = draft.references.map((reference) => reference.dataUrl);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, request };
}

export function buildTtsRequest(model: MediaModel, draft: TtsDraft): FormResult<TtsRequest> {
    const spec = ttsForm(model);
    const issues: FormIssue[] = [];
    const input = draft.text.trim();
    if (!input) issues.push({ code: 'text_empty', field: 'text' });
    const request: TtsRequest = { model: model.id, input };
    const voice = draft.voice.trim() || spec.voices[0] || '';
    if (voice) request.voice = voice;
    const speed = parseNumber(draft.speed);
    if (speed === undefined || (speed !== null && (speed < spec.speed.min || speed > spec.speed.max))) {
        issues.push({
            code: speed === undefined ? 'number_invalid' : 'number_range',
            field: 'speed',
            detail: spec.speed.min,
        });
    } else if (speed !== null && speed !== 1) request.speed = speed;
    if (spec.instructions && draft.instructions.trim()) request.instructions = draft.instructions.trim();
    return issues.length > 0 ? { ok: false, issues } : { ok: true, request };
}

/** The recording or file that goes to the transcription route. */
export interface AudioInput {
    base64: string;
    mime: string;
    filename: string;
    bytes: number;
    /** Seconds, when known (a recording knows; a file only after its metadata loaded). */
    durationSec: number | null;
}

export function buildSttRequest(model: MediaModel, draft: SttDraft, audio: AudioInput | null): FormResult<SttRequest> {
    const spec = sttForm(model);
    const issues: FormIssue[] = [];
    if (!audio) issues.push({ code: 'audio_missing', field: 'audio' });
    else if (checkAudioBytes(audio.bytes) === 'empty') issues.push({ code: 'audio_missing', field: 'audio' });
    else if (checkAudioBytes(audio.bytes) === 'too_large') issues.push({ code: 'audio_too_large', field: 'audio' });
    if (issues.length > 0 || !audio) return { ok: false, issues };
    const request: SttRequest = {
        model: model.id,
        audioBase64: audio.base64,
        filename: audio.filename,
        mime: audio.mime,
    };
    const language = draft.language.trim();
    if (language) request.language = language;
    if (spec.diarize && draft.diarize) request.diarize = true;
    return { ok: true, request };
}

/** The duration the form holds, in seconds, for the estimate; null when the model lists none or the field is not a valid number. */
export function videoDurationOf(model: MediaModel, draft: VideoDraft): number | null {
    const spec = videoForm(model).duration;
    if (!spec) return null;
    if (spec.kind === 'enum') {
        return parseDuration(spec.values.includes(draft.duration) ? draft.duration : spec.default);
    }
    const value = parseNumber(draft.duration);
    return typeof value === 'number' && value > 0 ? value : null;
}

export function buildVideoRequest(model: MediaModel, draft: VideoDraft): FormResult<VideoRequest> {
    const spec = videoForm(model);
    const issues: FormIssue[] = [];
    const prompt = draft.prompt.trim();
    if (!prompt) issues.push({ code: 'prompt_empty', field: 'prompt' });
    const request: VideoRequest = { model: model.id, prompt };

    if (spec.duration) {
        const seconds =
            spec.duration.kind === 'enum'
                ? parseDuration(spec.duration.values.includes(draft.duration) ? draft.duration : spec.duration.default)
                : (readNumber(draft.duration, spec.duration.field, issues, 'duration') ?? null);
        if (seconds !== null) request.duration = seconds;
    }
    if (spec.aspect) {
        const aspect = choiceValue(spec.aspect, draft.aspect);
        if (aspect) request.aspectRatio = aspect;
    }
    if (spec.resolution) {
        const resolution = choiceValue(spec.resolution, draft.resolution);
        if (resolution) request.resolution = resolution;
    }
    if (spec.seed) {
        const seed = readNumber(draft.seed, spec.seed, issues, 'seed');
        if (seed !== undefined) request.seed = Math.trunc(seed);
    }
    if (spec.startImage && draft.startImage) {
        checkReferences([draft.startImage], 1, issues, 'startImage');
        request.imageUrl = draft.startImage.dataUrl;
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, request };
}
