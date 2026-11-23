// The Media tab without the DOM: prices and costs worded through i18n, what the state banner says, how an error reads, the
// capability chips of a model, the estimate wiring of each studio and how a video job is shown. Pure functions of their
// arguments (the clock and the translator come in), so they are tested directly; the view files only draw what they return.
import type { MediaState } from '../../core/media';
import { estimateImageCost, estimateSttCost, estimateTtsCost, estimateVideoCost } from '../../domain/media';
import type { I18nParams } from '../../core/types';
import type { MediaError } from '../../host';
import { mediaFileUrl } from '../../host';
import type { MediaCost, MediaModel, MediaOutput, MediaPrice, Medium, VideoJob } from '../../shared/contracts-media';
import type { ChipKind } from '../../ui';
import { trimZeros } from '../../ui/format';
import { choiceValue, imageForm, parseNumber, ttsForm, videoDurationOf, videoForm } from './param-form';
import type { FormIssue, ImageDraft, TtsDraft, VideoDraft } from './param-form';

export type Translate = (key: string, params?: I18nParams) => string;

const DASH = '—';

export interface ChipSpec {
    label: string;
    kind: ChipKind;
    title?: string;
}

/* ---------------------------------------------------------------------------------------------- money */

/**
 * USD with three significant digits and no exponent, at least two decimals: $12.40, $0.0017, $0.00000666. Media prices
 * and costs are tiny (a second of transcription is millionths of a dollar), so the six-decimal floor of the Account tab
 * would round them to zero. null -> a dash.
 */
export function formatUsdAmount(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return DASH;
    if (value === 0) return '$0';
    const abs = Math.abs(value);
    const rounded = Number(abs.toPrecision(3));
    const decimals = rounded >= 100 ? 0 : Math.min(10, Math.max(2, 2 - Math.floor(Math.log10(rounded))));
    const fixed = rounded.toFixed(decimals);
    // Keep two decimals for money-sized figures ($12.40), trim the noise on small ones ($0.0017).
    const text = rounded >= 1 ? fixed : trimZeros(fixed).padEnd(fixed.indexOf('.') + 3, '0');
    return `${value < 0 ? '-' : ''}$${text}`;
}

const UNIT_KEYS: Record<MediaPrice['unit'], string> = {
    image: 'media.unit.image',
    megapixel: 'media.unit.megapixel',
    second: 'media.unit.second',
    minute: 'media.unit.minute',
    thousand_chars: 'media.unit.thousandChars',
    thousand_bytes: 'media.unit.thousandBytes',
    million_tokens: 'media.unit.millionTokens',
    request: 'media.unit.request',
    unknown: 'media.unit.unknown',
};

/** A price as the list shows it: `$0.0017 / image`, `$0.0017–$0.0051 / image`; a shape nobody understood as its own text. */
export function priceText(price: MediaPrice, t: Translate): string {
    if (price.unit === 'unknown') {
        if (price.from === null && typeof price.raw === 'string' && price.raw) return price.raw;
        if (price.from === null) return t('media.price.unknown');
    }
    if (price.from === null) return t('media.price.unknown');
    const range =
        price.to !== null && price.to !== price.from
            ? `${formatUsdAmount(price.from)}–${formatUsdAmount(price.to)}`
            : formatUsdAmount(price.from);
    return price.unit === 'unknown' ? range : `${range} / ${t(UNIT_KEYS[price.unit])}`;
}

/** The named prices of a model (`1024x1024: $0.0034`), for a tooltip; undefined when there are none. */
export function priceTitle(price: MediaPrice): string | undefined {
    const entries = Object.entries(price.byKey);
    if (entries.length === 0) return undefined;
    return entries.map(([key, value]) => `${key}: ${formatUsdAmount(value)}`).join('\n');
}

/** An option of a model select: `Name · $0.0017 / image`. */
export function modelLabel(model: MediaModel, t: Translate): string {
    return `${model.name} · ${priceText(model.price, t)}`;
}

export function mediumLabel(medium: Medium, t: Translate): string {
    return t(`media.medium.${medium}`);
}

/* ---------------------------------------------------------------------------------------------- chips */

/** What a model can do and how it is billed, as chips: only what the list states (an absent flag says nothing). */
export function capabilityChips(model: MediaModel, t: Translate): ChipSpec[] {
    const c = model.capabilities;
    const chips: ChipSpec[] = [];
    const add = (on: boolean | undefined, key: string, kind: ChipKind = 'info', title?: string): void => {
        if (on === true) chips.push({ label: t(`media.cap.${key}`), kind, ...(title ? { title } : {}) });
    };
    switch (model.medium) {
        case 'image':
            add(
                c.imageToImage,
                'img2img',
                'info',
                model.maxInputImages > 0 ? t('media.cap.refs', { count: model.maxInputImages }) : undefined,
            );
            add(c.inpainting, 'inpainting');
            break;
        case 'video':
            add(c.textToVideo, 'textToVideo');
            add(c.imageToVideo, 'imageToVideo');
            add(c.videoToVideo, 'videoToVideo');
            add(c.audioInput, 'audioInput');
            break;
        case 'tts':
            add(c.music, 'music', 'warn', t('media.cap.music.hint'));
            add(c.voiceCloning, 'voiceCloning');
            add(c.streaming, 'streaming');
            break;
        case 'stt':
            add(c.diarization, 'diarization');
            add(c.streaming, 'streaming');
            break;
    }
    add(c.nsfw, 'nsfw', 'muted');
    if (model.subscriptionIncluded === true) chips.push({ label: t('media.cap.subscription'), kind: 'ok' });
    else if (model.subscriptionIncluded === false) chips.push({ label: t('media.cap.notSubscription'), kind: 'muted' });
    if (model.priceIsApproximate) {
        chips.push({ label: t('media.cap.approx'), kind: 'warn', title: t('media.cap.approx.hint') });
    }
    return chips;
}

/* ---------------------------------------------------------------------------------------------- banner and errors */

export interface Banner {
    kind: 'error' | 'warn';
    title: string;
    text: string;
    /** A button next to the text: where to go to fix it. */
    action: 'keys' | null;
}

/** The studios work only through a plugin that answers; a missing key is fixable but does not block the page. */
export function actionsEnabled(state: MediaState): boolean {
    return state !== 'needs_plugin' && state !== 'plugin_outdated' && state !== 'plugin_down';
}

/** The banner under the head for the states where media cannot work; null otherwise. */
export function bannerFor(state: MediaState, problem: MediaError | null, t: Translate): Banner | null {
    switch (state) {
        case 'needs_plugin':
            return {
                kind: 'warn',
                title: t('media.banner.needsPlugin.title'),
                text: t('media.banner.needsPlugin'),
                action: null,
            };
        case 'plugin_outdated':
            return {
                kind: 'warn',
                title: t('media.banner.outdated.title'),
                text: t('media.banner.outdated'),
                action: null,
            };
        case 'plugin_down':
            return {
                kind: 'error',
                title: t('media.banner.down.title'),
                text: problem ? errorText(problem, t) : t('media.error.pluginDown'),
                action: null,
            };
        case 'no_key':
            return { kind: 'warn', title: t('media.banner.noKey.title'), text: t('media.error.noKey'), action: 'keys' };
        default:
            return null;
    }
}

/** What an error says to the user, in the interface language. Never includes a key (the plugin never sends one). */
export function errorText(error: MediaError, t: Translate): string {
    switch (error.kind) {
        case 'plugin_down':
            return t('media.error.pluginDown');
        case 'not_installed':
            return t('media.error.notInstalled');
        case 'forbidden':
            return t('media.error.forbidden');
        case 'no_key':
            return t('media.error.noKey');
        case 'invalid_request':
            return t('media.error.invalidRequest', { message: error.message });
        case 'too_large':
            return t('media.error.tooLarge');
        case 'rate_limited':
            return t('media.error.rateLimited');
        case 'unavailable':
            return t('media.error.unavailable');
        case 'upstream':
            return t('media.error.upstream', { message: error.message });
        case 'timeout':
            return t('media.error.timeout');
        case 'insufficient_balance':
            return error.requiredUsd === undefined
                ? t('media.error.balance')
                : t('media.error.balanceAmount', { amount: formatUsdAmount(error.requiredUsd) });
        case 'content_policy':
            return t('media.error.contentPolicy');
        case 'not_found':
            return t('media.error.notFound');
        case 'invalid_response':
            return t('media.error.invalidResponse');
        default:
            return t('media.error.other', { code: error.code });
    }
}

/** Errors that mean NanoGPT may have done (and billed) the work although no answer arrived. */
export function mayHaveBeenCharged(error: MediaError): boolean {
    return error.kind === 'timeout';
}

/* ---------------------------------------------------------------------------------------------- estimates */

/** The four estimators of domain/media.ts; a parameter so tests can fix the numbers. */
export interface Estimators {
    image: typeof estimateImageCost;
    video: typeof estimateVideoCost;
    tts: typeof estimateTtsCost;
    stt: typeof estimateSttCost;
}

export const ESTIMATORS: Estimators = {
    image: estimateImageCost,
    video: estimateVideoCost,
    tts: estimateTtsCost,
    stt: estimateSttCost,
};

/** Runs an estimator; a thrown error (it must not) is "cannot estimate". */
function safely(run: () => number | null): number | null {
    try {
        const value = run();
        return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
        return null;
    }
}

export function imageEstimate(
    model: MediaModel,
    draft: ImageDraft,
    estimators: Estimators = ESTIMATORS,
): number | null {
    const spec = imageForm(model);
    const parsed = parseNumber(draft.count);
    const n = typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
    const size = spec.size ? choiceValue(spec.size, draft.size).trim() : '';
    return safely(() => estimators.image(model, { n, ...(size ? { size } : {}) }));
}

export function videoEstimate(
    model: MediaModel,
    draft: VideoDraft,
    estimators: Estimators = ESTIMATORS,
): number | null {
    const spec = videoForm(model);
    const resolution = spec.resolution ? choiceValue(spec.resolution, draft.resolution) : '';
    const duration = videoDurationOf(model, draft);
    return safely(() =>
        estimators.video(model, {
            ...(duration !== null ? { duration } : {}),
            ...(resolution ? { resolution } : {}),
        }),
    );
}

export function ttsEstimate(model: MediaModel, draft: TtsDraft, estimators: Estimators = ESTIMATORS): number | null {
    const chars = draft.text.trim().length;
    if (chars === 0) return null;
    return safely(() => estimators.tts(model, chars));
}

export function sttEstimate(
    model: MediaModel,
    seconds: number | null,
    estimators: Estimators = ESTIMATORS,
): number | null {
    if (seconds === null || !(seconds > 0)) return null;
    return safely(() => estimators.stt(model, seconds));
}

export interface EstimateView {
    text: string;
    /** The figure could not be computed: the line says so instead of showing zero. */
    unknown: boolean;
}

/** The "before you press the button" line. `approximate` is the video price that depends on length and resolution. */
export function estimateView(estimate: number | null, approximate: boolean, t: Translate): EstimateView {
    if (estimate === null) return { text: t('media.estimate.unknown'), unknown: true };
    const cost = formatUsdAmount(estimate);
    return {
        text: approximate ? t('media.estimate.approx', { cost }) : t('media.estimate.value', { cost }),
        unknown: false,
    };
}

/* ---------------------------------------------------------------------------------------------- cost of a call */

export interface CostView {
    /** What NanoGPT billed (or the best figure there is): `$0.00255`, a dash when unknown. */
    billed: string;
    source: ChipSpec;
    /** Why the figure may be off (or is not), in words. */
    note: string;
    /** The estimate made before the call; null when there was none. */
    estimated: string | null;
    /** NanoGPT's `paymentSource` when it said ('USD', 'XNO', …). */
    paymentSource: string | null;
}

/**
 * The cost line after a call. The figure NanoGPT's response carries for an image is the list price and can understate the
 * real charge (live: 0.0017 in the body, 0.00255 billed), so a `response` figure is shown as exactly that, with the
 * explanation, until the plugin's billing lookup turns it into a `lookup` one.
 */
export function costView(cost: MediaCost, medium: Medium, t: Translate): CostView {
    const billed = formatUsdAmount(cost.usd);
    let source: ChipSpec;
    let note: string;
    switch (cost.source) {
        case 'lookup':
            source = { label: t('media.cost.source.lookup'), kind: 'ok' };
            note = t('media.cost.note.lookup');
            break;
        case 'response':
            source = { label: t('media.cost.source.response'), kind: medium === 'image' ? 'warn' : 'info' };
            note = medium === 'image' ? t('media.cost.note.responseImage') : t('media.cost.note.response');
            break;
        case 'estimate':
            source = { label: t('media.cost.source.estimate'), kind: 'info' };
            note = t('media.cost.note.estimate');
            break;
        default:
            source = { label: t('media.cost.source.unknown'), kind: 'muted' };
            note = t('media.cost.note.unknown');
    }
    return {
        billed,
        source,
        note,
        estimated: cost.estimateUsd === null ? null : formatUsdAmount(cost.estimateUsd),
        paymentSource: cost.paymentSource,
    };
}

/* ---------------------------------------------------------------------------------------------- outputs */

/** The `src` of an output: its inline bytes as a data URL, or its https URL; null when it has neither. */
export function outputSrc(output: MediaOutput): string | null {
    if (output.dataBase64) return `data:${output.mime};base64,${output.dataBase64}`;
    if (output.url && /^https?:\/\//i.test(output.url)) return output.url;
    return null;
}

/* ---------------------------------------------------------------------------------------------- video jobs */

export interface JobView {
    id: string;
    statusLabel: string;
    statusKind: ChipKind;
    /** 0..100; null when NanoGPT gave no progress. */
    percent: number | null;
    /** The job will not change any more. */
    terminal: boolean;
    cost: string;
    created: string;
    /** The plugin's copy, for `<video src>`; null until it is saved. */
    fileUrl: string | null;
    /** NanoGPT's own link (expires in about a day): offered while the local copy is missing. */
    upstreamUrl: string | null;
    error: string | null;
}

const STATUS_KIND: Record<VideoJob['status'], ChipKind> = {
    queued: 'muted',
    running: 'info',
    completed: 'ok',
    failed: 'error',
    expired: 'warn',
};

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** HH:MM for today, DD.MM HH:MM for another day (the browser's time zone). */
export function formatMoment(at: number, now: number): string {
    const d = new Date(at);
    const n = new Date(now);
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? clock : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${clock}`;
}

/** Seconds as `m:ss` (a recording's length): 75 -> "1:15". */
export function formatClock(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
}

/** Bytes as KB or MB for the size meters. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${trimZeros((bytes / 1024).toFixed(1))} KB`;
    return `${trimZeros((bytes / (1024 * 1024)).toFixed(2))} MB`;
}

export function jobView(job: VideoJob, now: number, t: Translate): JobView {
    const terminal = job.status === 'completed' || job.status === 'failed' || job.status === 'expired';
    const file = job.output?.file;
    return {
        id: job.id,
        statusLabel: t(`media.job.status.${job.status}`),
        statusKind: STATUS_KIND[job.status],
        percent: job.progress === null || terminal ? null : Math.round(job.progress * 100),
        terminal,
        cost:
            job.cost.usd === null
                ? t('media.job.cost.unknown')
                : terminal
                  ? t('media.job.cost.final', { cost: formatUsdAmount(job.cost.usd) })
                  : t('media.job.cost.pre', { cost: formatUsdAmount(job.cost.usd) }),
        created: formatMoment(job.createdAt, now),
        fileUrl: job.status === 'completed' && file ? mediaFileUrl(file) : null,
        upstreamUrl:
            job.status === 'completed' && !file && job.output?.url && /^https?:\/\//i.test(job.output.url)
                ? job.output.url
                : null,
        error: job.status === 'failed' || job.status === 'expired' ? (job.error ?? t('media.job.error.unknown')) : null,
    };
}

/* ---------------------------------------------------------------------------------------------- forms: messages */

/** What a form issue says (the field it is about is named in the message where it matters). */
export function issueText(issue: FormIssue, t: Translate): string {
    const params: I18nParams = {
        field: t(`media.field.${issue.field}`),
        detail: issue.detail === undefined ? '' : issue.detail,
    };
    return t(`media.issue.${issue.code}`, params);
}

/** The voices select of a model with the voice a draft has kept when the model still lists it. */
export function voiceChoice(model: MediaModel, current: string): string {
    const spec = ttsForm(model);
    if (spec.voices.length === 0) return current;
    return spec.voices.includes(current) ? current : (spec.voices[0] ?? '');
}

/* ---------------------------------------------------------------------------------------------- ST's own TTS provider */

export interface SpeechEndpoint {
    connectionId: string;
    name: string;
    /** The full URL for the «Provider Endpoint» field of ST's «OpenAI Compatible» TTS provider. */
    url: string;
}

/** `<proxy base>/audio/speech`: the OpenAI-shaped speech route of a connection's proxy. */
export function speechEndpointOf(proxyUrl: string): string {
    return `${proxyUrl.replace(/\/+$/, '')}/audio/speech`;
}

/** The connections that have a proxy URL (plugin mode), with the endpoint each would give ST's provider. */
export function speechEndpoints(
    entries: readonly { config: { id: string; name: string }; view: { proxyUrl: string } | null }[],
): SpeechEndpoint[] {
    const out: SpeechEndpoint[] = [];
    for (const entry of entries) {
        if (!entry.view?.proxyUrl) continue;
        out.push({
            connectionId: entry.config.id,
            name: entry.config.name,
            url: speechEndpointOf(entry.view.proxyUrl),
        });
    }
    return out;
}
