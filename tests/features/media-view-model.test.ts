import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import type { MediaState } from '../../src/core/media';
import type { MediaError } from '../../src/host/plugin-media';
import { MEDIA_STRINGS } from '../../src/features/media/strings';
import { emptyImageDraft, emptyTtsDraft, emptyVideoDraft } from '../../src/features/media/param-form';
import type { ParamSpec, VideoJob } from '../../src/shared/contracts-media';
import {
    actionsEnabled,
    bannerFor,
    capabilityChips,
    costView,
    errorText,
    estimateView,
    formatBytes,
    formatClock,
    formatMoment,
    formatUsdAmount,
    imageEstimate,
    issueText,
    jobView,
    mayHaveBeenCharged,
    modelLabel,
    outputSrc,
    priceText,
    priceTitle,
    speechEndpointOf,
    speechEndpoints,
    sttEstimate,
    ttsEstimate,
    videoEstimate,
    voiceChoice,
} from '../../src/features/media/view-model';
import type { Estimators } from '../../src/features/media/view-model';
import { costOf, mediaModel } from '../helpers/media-fake';

const en = createI18n(() => 'en');
en.register(MEDIA_STRINGS);
const ru = createI18n(() => 'ru');
ru.register(MEDIA_STRINGS);
const t = en.t.bind(en);

const price = (
    unit: 'image' | 'second' | 'unknown',
    from: number | null,
    to: number | null = from,
    raw: unknown = null,
) => ({
    unit,
    from,
    to,
    byKey: {},
    raw,
});

const error = (kind: MediaError['kind'], extra: Partial<MediaError> = {}): MediaError => ({
    kind,
    code: kind,
    message: `${kind} message`,
    status: null,
    ...extra,
});

describe('money', () => {
    it.each([
        [null, '—'],
        [Number.NaN, '—'],
        [0, '$0'],
        [12.4, '$12.40'],
        [1, '$1.00'],
        [0.5, '$0.50'],
        [0.12, '$0.12'],
        [0.0017, '$0.0017'],
        [0.00255, '$0.00255'],
        [0.00000666, '$0.00000666'],
        [0.034, '$0.034'],
        [123.456, '$123'],
        [1234, '$1230'],
        [-0.5, '-$0.50'],
    ])('formats %s as %s', (value, text) => {
        expect(formatUsdAmount(value)).toBe(text);
    });
});

describe('price words', () => {
    it('a flat price per unit', () => {
        expect(priceText(price('image', 0.0017), t)).toBe('$0.0017 / image');
        expect(priceText(price('second', 0.36), t)).toBe('$0.36 / second');
    });

    it('a range, and the unit in Russian', () => {
        expect(priceText(price('image', 0.0017, 0.0051), t)).toBe('$0.0017–$0.0051 / image');
        expect(priceText(price('second', 0.18, 1.8), ru.t.bind(ru))).toBe('$0.18–$1.80 / секунда');
    });

    it('every unit has a word in both languages', () => {
        for (const unit of [
            'image',
            'megapixel',
            'second',
            'minute',
            'thousand_chars',
            'thousand_bytes',
            'million_tokens',
            'request',
        ] as const) {
            const text = priceText({ unit, from: 1, to: 1, byKey: {}, raw: null }, t);
            expect(text).not.toContain('media.unit');
            expect(priceText({ unit, from: 1, to: 1, byKey: {}, raw: null }, ru.t.bind(ru))).not.toContain(
                'media.unit',
            );
        }
    });

    it('a price nobody could read is "unknown", or the list’s own text', () => {
        expect(priceText(price('image', null), t)).toBe('price unknown');
        expect(priceText(price('unknown', null, null, 'from $1'), t)).toBe('from $1');
        expect(priceText(price('unknown', null, null, { odd: 1 }), t)).toBe('price unknown');
        expect(priceText(price('unknown', 0.5), t)).toBe('$0.50');
    });

    it('named prices go in a tooltip', () => {
        expect(priceTitle({ ...price('image', 0.1), byKey: { '1k': 0.1, '2k': 0.2 } })).toBe('1k: $0.10\n2k: $0.20');
        expect(priceTitle(price('image', 0.1))).toBeUndefined();
    });

    it('a model option reads "name · price"', () => {
        expect(modelLabel(mediaModel({ id: 'm', name: 'Flux', medium: 'image', price: price('image', 0.02) }), t)).toBe(
            'Flux · $0.02 / image',
        );
    });
});

describe('capability chips', () => {
    const labels = (model: Parameters<typeof capabilityChips>[0]) =>
        capabilityChips(model, t).map((chip) => chip.label);

    it('image: only what the list states', () => {
        expect(labels(mediaModel({ id: 'a', medium: 'image' }))).toEqual([]);
        const model = mediaModel({
            id: 'a',
            medium: 'image',
            maxInputImages: 4,
            capabilities: { imageToImage: true, inpainting: true, nsfw: true },
        });
        expect(labels(model)).toEqual(['img2img', 'inpainting', 'NSFW']);
        expect(capabilityChips(model, t)[0]?.title).toBe('up to 4 reference images');
    });

    it('video, speech and transcription each have their own', () => {
        expect(
            labels(
                mediaModel({
                    id: 'v',
                    medium: 'video',
                    capabilities: { textToVideo: true, imageToVideo: true, videoToVideo: true, audioInput: true },
                }),
            ),
        ).toEqual(['text to video', 'image to video', 'video to video', 'takes audio']);
        expect(
            labels(
                mediaModel({
                    id: 't',
                    medium: 'tts',
                    capabilities: { music: true, voiceCloning: true, streaming: true },
                }),
            ),
        ).toEqual(['music', 'voice cloning', 'streaming']);
        expect(
            labels(mediaModel({ id: 's', medium: 'stt', capabilities: { diarization: true, streaming: true } })),
        ).toEqual(['speakers', 'streaming']);
    });

    it('a flag of another medium says nothing', () => {
        expect(
            labels(mediaModel({ id: 'a', medium: 'image', capabilities: { music: true, diarization: true } })),
        ).toEqual([]);
    });

    it('subscription: said when the list says it, in both directions, never when it does not', () => {
        const base = { id: 'a', medium: 'image' as const };
        expect(labels(mediaModel({ ...base, subscriptionIncluded: true }))).toEqual(['in subscription']);
        expect(labels(mediaModel({ ...base, subscriptionIncluded: false }))).toEqual(['not in subscription']);
        expect(labels(mediaModel({ ...base, subscriptionIncluded: null }))).toEqual([]);
        expect(capabilityChips(mediaModel({ ...base, subscriptionIncluded: true }), t)[0]?.kind).toBe('ok');
    });

    it('an approximate video price is flagged', () => {
        const chips = capabilityChips(mediaModel({ id: 'v', medium: 'video', priceIsApproximate: true }), t);
        expect(chips).toMatchObject([{ label: 'approximate price', kind: 'warn' }]);
        expect(chips[0]?.title).toContain('approximation');
    });
});

describe('the state banner', () => {
    it('says nothing while all is well', () => {
        expect(bannerFor('idle', null, t)).toBeNull();
        expect(bannerFor('ready', null, t)).toBeNull();
    });

    it('explains a missing plugin, an old one, a silent one and a missing key', () => {
        expect(bannerFor('needs_plugin', error('not_installed'), t)).toMatchObject({
            kind: 'warn',
            title: 'Needs the plugin',
            action: null,
        });
        expect(bannerFor('plugin_outdated', error('not_installed'), t)).toMatchObject({
            kind: 'warn',
            title: 'The plugin is too old',
        });
        expect(bannerFor('plugin_down', error('plugin_down'), t)).toMatchObject({
            kind: 'error',
            text: 'The Nanovia plugin is not answering.',
        });
        expect(bannerFor('plugin_down', null, t)?.text).toBe('The Nanovia plugin is not answering.');
        expect(bannerFor('no_key', error('no_key'), t)).toMatchObject({ kind: 'warn', action: 'keys' });
    });

    it('studios are off without a plugin, but a missing key does not lock the page', () => {
        const states: MediaState[] = ['idle', 'ready', 'no_key', 'needs_plugin', 'plugin_outdated', 'plugin_down'];
        expect(states.map(actionsEnabled)).toEqual([true, true, true, false, false, false]);
    });
});

describe('error wording', () => {
    it('has a sentence for every kind, in both languages, with the amount when there is one', () => {
        const kinds: MediaError['kind'][] = [
            'plugin_down',
            'not_installed',
            'forbidden',
            'no_key',
            'invalid_request',
            'too_large',
            'rate_limited',
            'unavailable',
            'upstream',
            'timeout',
            'insufficient_balance',
            'content_policy',
            'not_found',
            'invalid_response',
            'other',
        ];
        for (const kind of kinds) {
            expect(errorText(error(kind), t), kind).not.toContain('media.error');
            expect(errorText(error(kind), ru.t.bind(ru)), kind).not.toContain('media.error');
        }
    });

    it('insufficient balance shows the amount when the error carries it', () => {
        expect(errorText(error('insufficient_balance', { requiredUsd: 0.0035 }), t)).toBe(
            'The NanoGPT balance is too low for this call: it needs $0.0035.',
        );
        expect(errorText(error('insufficient_balance'), t)).toBe('The NanoGPT balance is too low for this call.');
    });

    it('content policy says the request is not charged', () => {
        expect(errorText(error('content_policy'), t)).toContain('not charged');
        expect(errorText(error('content_policy'), ru.t.bind(ru))).toContain('не списываются');
    });

    it('passes NanoGPT’s own text for an upstream refusal and the plugin’s for a bad request', () => {
        expect(errorText(error('upstream', { message: 'model overloaded' }), t)).toBe(
            'NanoGPT refused or failed the call: model overloaded',
        );
        expect(errorText(error('invalid_request', { message: 'size: bad' }), t)).toBe(
            'The request was refused: size: bad',
        );
        expect(errorText(error('other', { code: 'http_500' }), t)).toBe('The call failed (http_500).');
    });

    it('only a timeout may have been charged', () => {
        expect(mayHaveBeenCharged(error('timeout'))).toBe(true);
        expect(mayHaveBeenCharged(error('upstream'))).toBe(false);
        expect(mayHaveBeenCharged(error('plugin_down'))).toBe(false);
    });

    it('form issues name their field and detail', () => {
        expect(issueText({ code: 'count_range', field: 'count', detail: 4 }, t)).toBe(
            'The number of images must be a whole number from 1 to 4.',
        );
        expect(issueText({ code: 'number_invalid', field: 'seed' }, t)).toBe('Seed: a number is expected.');
        expect(issueText({ code: 'reference_too_large', field: 'references', detail: 2 }, t)).toContain('Reference 2');
        for (const code of [
            'prompt_empty',
            'text_empty',
            'size_invalid',
            'count_range',
            'number_invalid',
            'number_range',
            'too_many_references',
            'reference_not_image',
            'reference_too_large',
            'audio_missing',
            'audio_too_large',
            'no_model',
        ] as const) {
            expect(issueText({ code, field: 'seed', detail: 1 }, t)).not.toContain('media.issue');
            expect(issueText({ code, field: 'seed', detail: 1 }, ru.t.bind(ru))).not.toContain('media.issue');
        }
    });
});

describe('estimate wiring (with estimators the test fixes)', () => {
    const estimators = (): { [K in keyof Estimators]: ReturnType<typeof vi.fn> } & Estimators => ({
        image: vi.fn(() => 0.0034),
        video: vi.fn(() => 1.2),
        tts: vi.fn(() => 0.002),
        stt: vi.fn(() => 0.00001),
    });
    const sized: ParamSpec = { key: 'size', type: 'enum', values: ['512x512', '1024x1024'], default: '1024x1024' };

    it('image: the count and the size of the form, the default size when the draft has none', () => {
        const fixed = estimators();
        const model = mediaModel({ id: 'm', medium: 'image', params: [sized] });
        expect(imageEstimate(model, { ...emptyImageDraft(), count: '3', size: '512x512' }, fixed)).toBe(0.0034);
        expect(fixed.image).toHaveBeenLastCalledWith(model, { n: 3, size: '512x512' });
        imageEstimate(model, emptyImageDraft(), fixed);
        expect(fixed.image).toHaveBeenLastCalledWith(model, { n: 1, size: '1024x1024' });
    });

    it('image: no size when the model lists none, and a bad count counts as one', () => {
        const fixed = estimators();
        const model = mediaModel({ id: 'm', medium: 'image' });
        imageEstimate(model, { ...emptyImageDraft(), count: 'abc', size: '9x9' }, fixed);
        expect(fixed.image).toHaveBeenLastCalledWith(model, { n: 1 });
        imageEstimate(model, { ...emptyImageDraft(), count: '2.5' }, fixed);
        expect(fixed.image).toHaveBeenLastCalledWith(model, { n: 1 });
    });

    it('video: the duration in seconds and the resolution', () => {
        const fixed = estimators();
        const model = mediaModel({
            id: 'v',
            medium: 'video',
            params: [
                { key: 'duration', type: 'enum', values: ['5s', '8s'], default: '8s' },
                { key: 'resolution', type: 'enum', values: ['720p', '1080p'], default: '720p' },
            ],
        });
        expect(videoEstimate(model, { ...emptyVideoDraft(), duration: '5s', resolution: '1080p' }, fixed)).toBe(1.2);
        expect(fixed.video).toHaveBeenLastCalledWith(model, { duration: 5, resolution: '1080p' });
        videoEstimate(model, emptyVideoDraft(), fixed);
        expect(fixed.video).toHaveBeenLastCalledWith(model, { duration: 8, resolution: '720p' });
        const bare = mediaModel({ id: 'b', medium: 'video' });
        videoEstimate(bare, emptyVideoDraft(), fixed);
        expect(fixed.video).toHaveBeenLastCalledWith(bare, {});
    });

    it('speech: the characters typed; nothing to estimate for no text', () => {
        const fixed = estimators();
        const model = mediaModel({ id: 't', medium: 'tts' });
        expect(ttsEstimate(model, { ...emptyTtsDraft(), text: '  Hello there!  ' }, fixed)).toBe(0.002);
        expect(fixed.tts).toHaveBeenLastCalledWith(model, 12);
        fixed.tts.mockClear();
        expect(ttsEstimate(model, emptyTtsDraft(), fixed)).toBeNull();
        expect(fixed.tts).not.toHaveBeenCalled();
    });

    it('transcription: the length of the audio; nothing when it is unknown', () => {
        const fixed = estimators();
        const model = mediaModel({ id: 's', medium: 'stt' });
        expect(sttEstimate(model, 12.5, fixed)).toBe(0.00001);
        expect(fixed.stt).toHaveBeenLastCalledWith(model, 12.5);
        fixed.stt.mockClear();
        expect(sttEstimate(model, null, fixed)).toBeNull();
        expect(sttEstimate(model, 0, fixed)).toBeNull();
        expect(fixed.stt).not.toHaveBeenCalled();
    });

    it('an estimator that cannot compute, throws or answers nonsense is "cannot estimate"', () => {
        const model = mediaModel({ id: 'm', medium: 'image' });
        const draft = emptyImageDraft();
        const none = { ...estimators(), image: vi.fn(() => null) };
        expect(imageEstimate(model, draft, none)).toBeNull();
        const throwing = {
            ...estimators(),
            image: vi.fn(() => {
                throw new Error('boom');
            }),
        };
        expect(imageEstimate(model, draft, throwing)).toBeNull();
        expect(imageEstimate(model, draft, { ...estimators(), image: vi.fn(() => Number.NaN) })).toBeNull();
        expect(imageEstimate(model, draft, { ...estimators(), image: vi.fn(() => -1) })).toBeNull();
    });

    it('the line says the figure, says "approximate", or says it cannot be estimated', () => {
        expect(estimateView(0.0034, false, t)).toEqual({ text: 'Estimated cost: $0.0034', unknown: false });
        expect(estimateView(1.2, true, t)).toEqual({
            text: 'Estimated cost: about $1.20 (approximate)',
            unknown: false,
        });
        expect(estimateView(null, false, t)).toMatchObject({ unknown: true });
        expect(estimateView(null, false, t).text).toContain('cannot be estimated');
    });
});

describe('the cost of a call', () => {
    it('an image figure from the response is shown as a list price that can understate the charge', () => {
        const view = costView(costOf({ usd: 0.0017, source: 'response', estimateUsd: 0.0017 }), 'image', t);
        expect(view).toMatchObject({
            billed: '$0.0017',
            source: { label: 'NanoGPT’s figure', kind: 'warn' },
            estimated: '$0.0017',
            paymentSource: 'USD',
        });
        expect(view.note).toContain('list-price');
        expect(view.note).toContain('1.5 times');
        expect(view.note).toContain('billed (confirmed)');
    });

    it('a confirmed figure says so', () => {
        const view = costView(costOf({ usd: 0.00255, source: 'lookup', estimateUsd: 0.0017 }), 'image', t);
        expect(view).toMatchObject({
            billed: '$0.00255',
            source: { label: 'billed (confirmed)', kind: 'ok' },
            estimated: '$0.0017',
        });
        expect(view.note).toContain('billing record');
    });

    it('speech is an estimate from the catalog price; transcription a figure of the response', () => {
        expect(costView(costOf({ usd: 0.000034, source: 'estimate' }), 'tts', t)).toMatchObject({
            billed: '$0.000034',
            source: { label: 'estimate', kind: 'info' },
            estimated: null,
        });
        expect(costView(costOf({ usd: 0.00000666, source: 'response' }), 'stt', t).source).toMatchObject({
            kind: 'info',
        });
        expect(costView(costOf({ usd: 0.00000666, source: 'response' }), 'stt', t).note).not.toContain('list-price');
    });

    it('an unknown cost is a dash', () => {
        expect(costView(costOf({ usd: null, source: 'unknown', paymentSource: null }), 'video', t)).toMatchObject({
            billed: '—',
            source: { label: 'unknown', kind: 'muted' },
            paymentSource: null,
        });
    });

    it('is worded in Russian too', () => {
        const view = costView(costOf({ source: 'lookup' }), 'image', ru.t.bind(ru));
        expect(view.source.label).toBe('списано (подтверждено)');
    });
});

describe('outputs', () => {
    it('inline bytes become a data URL with the real mime; an https link stays; anything else has no source', () => {
        expect(outputSrc({ kind: 'audio', mime: 'audio/x-wav', dataBase64: 'QUJD' })).toBe(
            'data:audio/x-wav;base64,QUJD',
        );
        expect(outputSrc({ kind: 'image', mime: 'image/png', url: 'https://x.test/a.png' })).toBe(
            'https://x.test/a.png',
        );
        expect(outputSrc({ kind: 'image', mime: 'image/png', url: 'javascript:alert(1)' })).toBeNull();
        expect(outputSrc({ kind: 'video', mime: 'video/mp4', file: 'vid_1' })).toBeNull();
    });
});

describe('video jobs', () => {
    const NOW = new Date(2026, 10, 23, 15, 0, 0).getTime();
    const job = (patch: Partial<VideoJob> = {}): VideoJob => ({
        id: 'vid_1',
        model: 'veo3',
        prompt: 'a dragon',
        status: 'running',
        progress: 0.42,
        createdAt: NOW - 60_000,
        updatedAt: NOW,
        cost: costOf({ usd: 0.4, source: 'estimate' }),
        connectionId: null,
        output: null,
        error: null,
        ...patch,
    });

    it('a running job: progress, pre-charge, no player', () => {
        expect(jobView(job(), NOW, t)).toEqual({
            id: 'vid_1',
            statusLabel: 'running',
            statusKind: 'info',
            percent: 42,
            terminal: false,
            cost: 'Pre-charge: $0.40',
            created: '14:59',
            fileUrl: null,
            upstreamUrl: null,
            error: null,
        });
    });

    it('a queued job with no progress figure', () => {
        expect(jobView(job({ status: 'queued', progress: null }), NOW, t)).toMatchObject({
            statusKind: 'muted',
            percent: null,
            terminal: false,
        });
    });

    it('a finished job: the final cost and the plugin’s file', () => {
        const done = jobView(
            job({
                status: 'completed',
                progress: 1,
                cost: costOf({ usd: 0.41 }),
                output: { kind: 'video', mime: 'video/mp4', url: 'https://cdn.example.test/v.mp4', file: 'vid_1' },
            }),
            NOW,
            t,
        );
        expect(done).toMatchObject({
            statusLabel: 'done',
            statusKind: 'ok',
            percent: null,
            terminal: true,
            cost: 'Cost: $0.41',
            fileUrl: '/api/plugins/nanovia/media/files/vid_1',
            upstreamUrl: null,
        });
    });

    it('while the local copy is missing the upstream link is offered', () => {
        const done = jobView(
            job({
                status: 'completed',
                output: { kind: 'video', mime: 'video/mp4', url: 'https://cdn.example.test/v.mp4' },
            }),
            NOW,
            t,
        );
        expect(done).toMatchObject({ fileUrl: null, upstreamUrl: 'https://cdn.example.test/v.mp4' });
        expect(
            jobView(
                job({ status: 'completed', output: { kind: 'video', mime: 'video/mp4', url: 'javascript:1' } }),
                NOW,
                t,
            ).upstreamUrl,
        ).toBeNull();
    });

    it('failures and expiries carry their message', () => {
        expect(jobView(job({ status: 'failed', error: 'render failed' }), NOW, t)).toMatchObject({
            statusKind: 'error',
            error: 'render failed',
            terminal: true,
        });
        expect(jobView(job({ status: 'expired', error: null }), NOW, t)).toMatchObject({
            statusKind: 'warn',
            error: 'NanoGPT gave no reason.',
        });
        expect(jobView(job({ cost: costOf({ usd: null }) }), NOW, t).cost).toBe('Cost not known yet');
    });

    it('moments and sizes', () => {
        expect(formatMoment(NOW, NOW)).toBe('15:00');
        expect(formatMoment(new Date(2026, 10, 21, 9, 5).getTime(), NOW)).toBe('21.11 09:05');
        expect(formatClock(75)).toBe('1:15');
        expect(formatClock(0)).toBe('0:00');
        expect(formatClock(-5)).toBe('0:00');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(4 * 1024 * 1024)).toBe('4 MB');
    });
});

describe('ST’s OpenAI-compatible provider endpoint', () => {
    it('is the proxy base plus the speech route', () => {
        expect(speechEndpointOf('http://127.0.0.1:8787/c/abc/v1')).toBe('http://127.0.0.1:8787/c/abc/v1/audio/speech');
        expect(speechEndpointOf('http://127.0.0.1:8787/c/abc/v1/')).toBe('http://127.0.0.1:8787/c/abc/v1/audio/speech');
    });

    it('is offered for the connections that have a proxy URL', () => {
        expect(
            speechEndpoints([
                { config: { id: 'a', name: 'Main' }, view: { proxyUrl: 'http://127.0.0.1:8787/c/a/v1' } },
                { config: { id: 'b', name: 'Direct' }, view: null },
            ]),
        ).toEqual([{ connectionId: 'a', name: 'Main', url: 'http://127.0.0.1:8787/c/a/v1/audio/speech' }]);
    });
});

describe('voices', () => {
    it('keeps a voice the model lists, else the first, and passes a typed voice when the list is empty', () => {
        const model = mediaModel({ id: 't', medium: 'tts', voices: ['a', 'b'] });
        expect(voiceChoice(model, 'b')).toBe('b');
        expect(voiceChoice(model, 'z')).toBe('a');
        expect(voiceChoice(mediaModel({ id: 't', medium: 'tts' }), 'typed')).toBe('typed');
    });
});

describe('strings', () => {
    it('every English string has a Russian one and the other way round', () => {
        expect(en.missingRussian().filter((key) => key.startsWith('media.'))).toEqual([]);
        expect(en.missingEnglish().filter((key) => key.startsWith('media.'))).toEqual([]);
    });

    it('both languages keep the same {params}', () => {
        const params = (text: string): string[] =>
            [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
        for (const [key, text] of Object.entries(MEDIA_STRINGS.en)) {
            expect(params(MEDIA_STRINGS.ru[key] ?? ''), key).toEqual(params(text));
        }
    });

    it('every key the media sources name exists (the dynamic families are listed here)', () => {
        const dynamic = [
            ...[
                'img2img',
                'inpainting',
                'textToVideo',
                'imageToVideo',
                'videoToVideo',
                'audioInput',
                'music',
                'voiceCloning',
                'streaming',
                'diarization',
                'nsfw',
            ].map((key) => `media.cap.${key}`),
            ...[
                'prompt',
                'negative',
                'size',
                'aspect',
                'count',
                'seed',
                'steps',
                'guidance',
                'voice',
                'text',
                'speed',
                'instructions',
                'duration',
                'resolution',
                'language',
                'references',
                'audio',
                'startImage',
            ].map((key) => `media.field.${key}`),
            ...[
                'prompt_empty',
                'text_empty',
                'size_invalid',
                'count_range',
                'number_invalid',
                'number_range',
                'too_many_references',
                'reference_not_image',
                'reference_too_large',
                'audio_missing',
                'audio_too_large',
                'no_model',
            ].map((key) => `media.issue.${key}`),
            ...['queued', 'running', 'completed', 'failed', 'expired'].map((key) => `media.job.status.${key}`),
            ...['image', 'video', 'tts', 'stt'].map((key) => `media.medium.${key}`),
            ...['catalog', 'image', 'tts', 'stt', 'video'].map((key) => `media.section.${key}`),
            ...['unsupported', 'insecure', 'denied', 'no_device', 'busy', 'failed'].map(
                (key) => `media.stt.rec.error.${key}`,
            ),
        ];
        const dir = join(process.cwd(), 'src', 'features', 'media');
        const used = new Set<string>(dynamic);
        for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'strings.ts')) {
            const source = readFileSync(join(dir, file), 'utf8');
            for (const match of source.matchAll(/'(media\.[A-Za-z0-9_.]+)'/g)) used.add(match[1] ?? '');
        }
        const missing = [...used].filter((key) => !Object.hasOwn(MEDIA_STRINGS.en, key));
        expect(missing).toEqual([]);
        // And nothing is written that no source uses (a dead string is a translation nobody needed).
        const unused = Object.keys(MEDIA_STRINGS.en).filter((key) => !used.has(key));
        expect(unused).toEqual([]);
    });
});
