// The transcription studio: a model, speech from the microphone (MediaRecorder, feature-detected, with a visible permission
// and error state and the size and time ceilings in view) or from a file, an optional language, the text back with
// segments and speakers when the model gives them, a copy button, and a cost estimate from the length of the audio before
// the call. ST 1.19 has no speech recognition of its own, so this is the only place Nanovia offers it.
import type { MediaError, RecordedAudio, RecorderError, RecorderHandle, RecorderSupport } from '../../host';
import { recorderSupport, startRecording } from '../../host';
import type { MediaModel, SttResult } from '../../shared/contracts-media';
import { button, chip, clear, el, field, textInput, toggle } from '../../ui';
import { append } from '../../ui/dom';
import { copyButton, costBlock, noticeBox, readAsDataUrl, statusLine } from './controls';
import type { Studio, StudioDeps, TabHooks } from './controls';
import { createPicker } from './picker';
import {
    MAX_RECORDING_SECONDS,
    MAX_UPLOAD_BYTES,
    buildSttRequest,
    checkAudioBytes,
    extensionOf,
    sttForm,
    stripDataUrl,
} from './param-form';
import type { AudioInput, FormIssue } from './param-form';
import { actionsEnabled, estimateView, formatBytes, formatClock, issueText, sttEstimate } from './view-model';

/** The duration of an audio file from its metadata; null when the browser cannot tell within a moment. */
export function audioDuration(file: Blob): Promise<number | null> {
    return new Promise((resolve) => {
        if (typeof Audio === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            resolve(null);
            return;
        }
        let url = '';
        const finish = (value: number | null): void => {
            clearTimeout(timer);
            if (url) URL.revokeObjectURL(url);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), 3000);
        try {
            url = URL.createObjectURL(file);
            const audio = new Audio();
            audio.preload = 'metadata';
            audio.onloadedmetadata = () =>
                finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
            audio.onerror = () => finish(null);
            audio.src = url;
        } catch {
            finish(null);
        }
    });
}

export function createSttStudio(deps: StudioDeps, hooks: TabHooks = {}): Studio {
    const { ctx, session } = deps;
    const t = ctx.t;
    const draft = session.stt;
    const support = hooks.recorderSupport ?? recorderSupport;
    const start = hooks.startRecording ?? startRecording;
    const measure = hooks.audioDuration ?? audioDuration;

    let disposed = false;
    let busy = false;
    let error: MediaError | null = null;
    let issues: FormIssue[] = [];
    let builtFor: string | null = null;
    let shownResult: SttResult | null = null;
    let shownCost: SttResult['cost'] | null = null;
    let transcribeButton: HTMLButtonElement | null = null;

    /** The audio ready to send, and what it came from. */
    let audio: AudioInput | null = null;
    let playbackUrl: string | null = null;
    let recorder: RecorderHandle | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let recordingError: RecorderError | null = null;
    let audioNotice: string | null = null;

    const formHost = el('div', { class: 'nanovia-media-form' });
    const sourceHost = el('div', { class: 'nanovia-media-source' });
    const estimateHost = el('div', { class: 'nanovia-media-estimate', attrs: { 'aria-live': 'polite' } });
    const issuesHost = el('div', { class: 'nanovia-media-issues' });
    const actionsHost = el('div', { class: 'nanovia-row' });
    const statusHost = el('div', { class: 'nanovia-media-status', attrs: { 'aria-live': 'polite' } });
    const textHost = el('div', { class: 'nanovia-media-transcript', attrs: { 'aria-label': t('media.stt.text') } });
    const segmentsHost = el('div', { class: 'nanovia-media-segments' });
    const costHost = el('div', { class: 'nanovia-media-result-cost' });
    const metaHost = el('div', { class: 'nanovia-row nanovia-media-meta' });
    const resultHead = el('div', { class: 'nanovia-row nanovia-media-result-head' });
    const resultHost = el('section', { class: 'nanovia-media-result', attrs: { hidden: true } }, [
        resultHead,
        textHost,
        segmentsHost,
        metaHost,
        costHost,
    ]);

    const picker = createPicker({
        ctx,
        medium: 'stt',
        value: () => draft.model,
        onPick: (model) => {
            draft.model = model?.id ?? null;
            buildForm();
        },
    });

    const root = el('div', { class: 'nanovia-media-studio' }, [
        picker.el,
        sourceHost,
        formHost,
        estimateHost,
        issuesHost,
        actionsHost,
        statusHost,
        resultHost,
    ]);

    const model = (): MediaModel | null => picker.model();

    function syncButtons(): void {
        if (transcribeButton)
            transcribeButton.disabled = busy || !actionsEnabled(ctx.media.state()) || !model() || recorder !== null;
    }

    function drawEstimate(): void {
        clear(estimateHost);
        const current = model();
        if (!current) return;
        const seconds = audio?.durationSec ?? null;
        if (audio && seconds === null) {
            estimateHost.appendChild(el('div', { class: 'nanovia-muted', text: t('media.stt.estimate.noLength') }));
            return;
        }
        const view = estimateView(sttEstimate(current, seconds), false, t);
        estimateHost.appendChild(
            el('div', {
                class: ['nanovia-media-estimate-line', view.unknown ? 'nanovia-muted' : ''],
                text: audio ? view.text : t('media.stt.estimate.needsAudio'),
            }),
        );
    }

    /* ---------------------------------------------------------------------------------- recording and files */

    function releasePlayback(): void {
        if (playbackUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(playbackUrl);
        }
        playbackUrl = null;
    }

    function stopTicker(): void {
        if (ticker !== null) clearInterval(ticker);
        ticker = null;
    }

    function setAudio(next: AudioInput | null, blob: Blob | null): void {
        releasePlayback();
        audio = next;
        if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try {
                playbackUrl = URL.createObjectURL(blob);
            } catch {
                playbackUrl = null;
            }
        }
        drawSource();
        drawEstimate();
        syncButtons();
    }

    async function finishRecording(taken: RecordedAudio): Promise<void> {
        // «Stop» and a ceiling can both end the same recording: the first to arrive collects it.
        if (recorder === null) return;
        recorder = null;
        stopTicker();
        if (checkAudioBytes(taken.bytes) === 'empty') {
            audioNotice = t('media.stt.rec.empty');
            drawSource();
            syncButtons();
            return;
        }
        const dataUrl = await readAsDataUrl(taken.blob).catch(() => '');
        if (disposed) return;
        if (!dataUrl) {
            audioNotice = t('media.stt.file.unreadable');
            drawSource();
            syncButtons();
            return;
        }
        audioNotice =
            taken.reason === 'max_bytes'
                ? t('media.stt.rec.limitBytes')
                : taken.reason === 'max_time'
                  ? t('media.stt.rec.limitTime')
                  : null;
        setAudio(
            {
                base64: stripDataUrl(dataUrl),
                mime: taken.mime,
                filename: `recording.${extensionOf(taken.mime)}`,
                bytes: taken.bytes,
                durationSec: taken.durationMs / 1000,
            },
            taken.blob,
        );
    }

    async function toggleRecording(): Promise<void> {
        if (recorder) {
            const handle = recorder;
            const taken = await handle.stop();
            await finishRecording(taken);
            return;
        }
        recordingError = null;
        audioNotice = null;
        const result = await start({
            maxBytes: MAX_UPLOAD_BYTES - 64 * 1024,
            maxMs: MAX_RECORDING_SECONDS * 1000,
            onLimit: () => {
                // The recorder ended by itself: collect what it has, like a press of «Stop».
                const handle = recorder;
                if (handle) void handle.stop().then(finishRecording);
            },
        });
        if (disposed) {
            if (result.ok) result.handle.cancel();
            return;
        }
        if (!result.ok) {
            recordingError = result.error;
            drawSource();
            return;
        }
        releasePlayback();
        audio = null;
        recorder = result.handle;
        ticker = setInterval(() => drawMeter(), 250);
        drawSource();
        drawEstimate();
        syncButtons();
    }

    async function chooseFile(files: FileList | null): Promise<void> {
        const file = files?.[0];
        if (!file) return;
        audioNotice = null;
        recordingError = null;
        const verdict = checkAudioBytes(file.size);
        if (verdict !== 'ok') {
            audioNotice =
                verdict === 'too_large'
                    ? t('media.stt.file.tooLarge', { size: formatBytes(MAX_UPLOAD_BYTES) })
                    : t('media.stt.file.empty');
            drawSource();
            return;
        }
        let dataUrl: string;
        try {
            dataUrl = await readAsDataUrl(file);
        } catch {
            audioNotice = t('media.stt.file.unreadable');
            drawSource();
            return;
        }
        const seconds = await measure(file);
        if (disposed) return;
        setAudio(
            {
                base64: stripDataUrl(dataUrl),
                mime: file.type || 'audio/mpeg',
                filename: file.name || 'audio',
                bytes: file.size,
                durationSec: seconds,
            },
            file,
        );
    }

    const meter = el('div', { class: 'nanovia-muted nanovia-media-meter', attrs: { 'aria-live': 'off' } });

    function drawMeter(): void {
        if (!recorder) return;
        meter.textContent = t('media.stt.rec.meter', {
            elapsed: formatClock(recorder.elapsedMs() / 1000),
            max: formatClock(MAX_RECORDING_SECONDS),
            size: formatBytes(recorder.bytes()),
            limit: formatBytes(MAX_UPLOAD_BYTES),
        });
    }

    function drawSource(): void {
        clear(sourceHost);
        const supported: RecorderSupport = support();
        const recording = recorder !== null;
        const controls = el('div', { class: 'nanovia-row' });

        if (supported.supported) {
            controls.appendChild(
                button({
                    label: recording ? t('media.stt.rec.stop') : t('media.stt.rec.start'),
                    icon: recording ? 'stop' : 'microphone',
                    kind: recording ? 'danger' : 'primary',
                    disabled: busy,
                    onClick: () => {
                        void toggleRecording();
                    },
                }),
            );
        }
        const fileInput = el('input', {
            class: 'nanovia-media-file',
            attrs: {
                type: 'file',
                accept: 'audio/*',
                'aria-label': t('media.stt.file.choose'),
                disabled: recording || busy,
            },
        });
        fileInput.addEventListener('change', () => {
            void chooseFile(fileInput.files).then(() => {
                fileInput.value = '';
            });
        });
        controls.appendChild(fileInput);

        const blocks: (HTMLElement | null)[] = [
            el('b', { text: t('media.stt.source.title') }),
            controls,
            el('div', {
                class: 'nanovia-field-hint',
                text: t('media.stt.limits', {
                    size: formatBytes(MAX_UPLOAD_BYTES),
                    time: formatClock(MAX_RECORDING_SECONDS),
                }),
            }),
            supported.supported
                ? null
                : noticeBox(
                      'warn',
                      supported.reason === 'insecure' ? t('media.stt.rec.insecure') : t('media.stt.rec.unsupported'),
                  ),
            recordingError ? noticeBox('error', t(`media.stt.rec.error.${recordingError.kind}`)) : null,
            recording ? meter : null,
            audioNotice ? noticeBox('warn', audioNotice) : null,
        ];
        for (const block of blocks) if (block) sourceHost.appendChild(block);
        if (recording) drawMeter();

        if (audio) {
            sourceHost.appendChild(
                el('div', { class: 'nanovia-media-recorded' }, [
                    playbackUrl
                        ? el('audio', { class: 'nanovia-media-audio', attrs: { controls: true, src: playbackUrl } })
                        : null,
                    el('div', { class: 'nanovia-row' }, [
                        el('span', { text: audio.filename }),
                        chip(formatBytes(audio.bytes), 'muted'),
                        audio.durationSec !== null
                            ? chip(formatClock(audio.durationSec), 'muted', t('media.stt.length'))
                            : null,
                        button({
                            label: t('media.stt.discard'),
                            icon: 'trash',
                            kind: 'ghost',
                            disabled: busy,
                            onClick: () => {
                                audioNotice = null;
                                setAudio(null, null);
                            },
                        }),
                    ]),
                ]),
            );
        }
    }

    /* ------------------------------------------------------------------------------------------- the form */

    function buildForm(): void {
        clear(formHost);
        clear(actionsHost);
        transcribeButton = null;
        const current = model();
        builtFor = current?.id ?? null;
        if (!current) {
            drawEstimate();
            return;
        }
        const spec = sttForm(current);
        formHost.appendChild(
            field(
                t('media.field.language'),
                textInput({
                    value: draft.language,
                    label: t('media.field.language'),
                    placeholder: t('media.stt.language.placeholder'),
                    maxLength: 12,
                    onInput: (value) => {
                        draft.language = value;
                    },
                }),
                t('media.stt.language.hint'),
            ),
        );
        if (spec.diarize) {
            formHost.appendChild(
                toggle({
                    label: t('media.stt.diarize'),
                    checked: draft.diarize,
                    hint: t('media.stt.diarize.hint'),
                    onChange: (on) => {
                        draft.diarize = on;
                    },
                }),
            );
        }
        transcribeButton = button({
            label: t('media.stt.transcribe'),
            icon: 'file-lines',
            kind: 'primary',
            onClick: () => {
                void transcribe();
            },
        });
        actionsHost.append(transcribeButton);
        drawEstimate();
        syncButtons();
    }

    /* ------------------------------------------------------------------------------------------ the call */

    function drawIssues(): void {
        clear(issuesHost);
        for (const issue of issues) issuesHost.appendChild(noticeBox('error', issueText(issue, t)));
    }

    async function transcribe(): Promise<void> {
        const current = model();
        if (!current || busy) return;
        const built = buildSttRequest(current, draft, audio);
        if (!built.ok) {
            issues = built.issues;
            error = null;
            drawIssues();
            statusLine(statusHost, t, { busy: null, error: null });
            return;
        }
        issues = [];
        drawIssues();
        busy = true;
        error = null;
        statusLine(statusHost, t, { busy: t('media.stt.busy'), error: null });
        syncButtons();
        const result = await ctx.media.transcribe(built.request);
        busy = false;
        if (disposed) return;
        error = result.ok ? null : result.error;
        statusLine(statusHost, t, { busy: null, error });
        syncButtons();
        drawResult();
    }

    /* ----------------------------------------------------------------------------------------- the result */

    function segmentLine(segment: SttResult['segments'][number]): HTMLElement {
        const span =
            segment.start !== null
                ? `${formatClock(segment.start)}${segment.end !== null ? `–${formatClock(segment.end)}` : ''}`
                : '';
        return el('div', { class: 'nanovia-media-segment' }, [
            span ? el('span', { class: 'nanovia-muted nanovia-media-segment-time', text: span }) : null,
            segment.speaker ? chip(segment.speaker, 'info') : null,
            el('span', { text: segment.text }),
        ]);
    }

    function drawResult(): void {
        const result = ctx.media.last().stt;
        if (!result) {
            shownResult = null;
            shownCost = null;
            for (const host of [resultHead, segmentsHost, costHost, metaHost]) clear(host);
            textHost.textContent = '';
            resultHost.hidden = true;
            return;
        }
        resultHost.hidden = false;
        if (result !== shownResult) {
            shownResult = result;
            clear(resultHead);
            clear(segmentsHost);
            clear(metaHost);
            resultHead.append(
                el('b', { text: t('media.stt.text') }),
                el('span', { class: 'nanovia-muted', text: result.model }),
                copyButton(t('media.copy'), t('media.copied'), () => result.text),
                button({
                    label: t('media.result.clear'),
                    icon: 'trash',
                    kind: 'ghost',
                    onClick: () => ctx.media.clearLast('stt'),
                }),
            );
            textHost.textContent = result.text || t('media.stt.noSpeech');
            if (result.segments.length > 0) {
                segmentsHost.appendChild(el('b', { text: t('media.stt.segments') }));
                for (const segment of result.segments) segmentsHost.appendChild(segmentLine(segment));
            }
            append(metaHost, [
                result.language ? chip(result.language, 'muted', t('media.stt.language')) : null,
                result.durationSec !== null
                    ? chip(formatClock(result.durationSec), 'muted', t('media.stt.length'))
                    : null,
                el('span', {
                    class: 'nanovia-muted',
                    text: t('media.result.latency', { seconds: (result.latencyMs / 1000).toFixed(1) }),
                }),
            ]);
        }
        if (result.cost !== shownCost) {
            shownCost = result.cost;
            clear(costHost);
            costHost.appendChild(costBlock(result.cost, 'stt', t));
        }
    }

    /* ------------------------------------------------------------------------------------------ lifecycle */

    picker.update();
    if ((picker.model()?.id ?? null) !== builtFor) buildForm();
    drawSource();
    drawResult();

    return {
        el: root,
        update() {
            if (disposed) return;
            picker.update();
            if ((picker.model()?.id ?? null) !== builtFor) buildForm();
            syncButtons();
            drawResult();
        },
        dispose() {
            disposed = true;
            stopTicker();
            releasePlayback();
            // A recording in progress is thrown away when the tab closes: the microphone must not stay open.
            recorder?.cancel();
            recorder = null;
        },
    };
}
