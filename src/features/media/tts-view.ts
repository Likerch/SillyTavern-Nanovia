// The speech studio: a speech model (the list also holds music models, which are left out here), a voice from the model's own
// list, the text, speed and style instructions where the model lists them, a cost estimate before the call, and the result
// played with the content type the response really had (never the requested format). Below it, the second way to use
// NanoGPT speech in ST: the OpenAI-compatible endpoint of a connection for ST's own provider of that name.
import type { MediaError } from '../../host';
import type { MediaModel, TtsResult } from '../../shared/contracts-media';
import { button, chip, clear, el, field, select, textArea, textInput } from '../../ui';
import { copyButton, costBlock, noticeBox, numberInput, statusLine } from './controls';
import type { Studio, StudioDeps } from './controls';
import { createPicker } from './picker';
import { buildTtsRequest, downloadName, ttsForm } from './param-form';
import type { FormIssue } from './param-form';
import {
    actionsEnabled,
    estimateView,
    formatBytes,
    issueText,
    outputSrc,
    speechEndpoints,
    ttsEstimate,
    voiceChoice,
} from './view-model';

export function createTtsStudio(deps: StudioDeps): Studio {
    const { ctx, session } = deps;
    const t = ctx.t;
    const draft = session.tts;
    let disposed = false;
    let busy = false;
    let error: MediaError | null = null;
    let issues: FormIssue[] = [];
    let builtFor: string | null = null;
    let shownAudio: TtsResult['audio'] | null = null;
    let shownCost: TtsResult['cost'] | null = null;
    let speakButton: HTMLButtonElement | null = null;
    let selectedConnection = '';

    const formHost = el('div', { class: 'nanovia-media-form' });
    const estimateHost = el('div', { class: 'nanovia-media-estimate', attrs: { 'aria-live': 'polite' } });
    const issuesHost = el('div', { class: 'nanovia-media-issues' });
    const actionsHost = el('div', { class: 'nanovia-row' });
    const statusHost = el('div', { class: 'nanovia-media-status', attrs: { 'aria-live': 'polite' } });
    const playerHost = el('div', { class: 'nanovia-media-player' });
    const costHost = el('div', { class: 'nanovia-media-result-cost' });
    const metaHost = el('div', { class: 'nanovia-muted nanovia-media-meta' });
    const resultHead = el('div', { class: 'nanovia-row nanovia-media-result-head' });
    const resultHost = el('section', { class: 'nanovia-media-result', attrs: { hidden: true } }, [
        resultHead,
        playerHost,
        costHost,
        metaHost,
    ]);
    const endpointHost = el('details', { class: 'nanovia-details nanovia-media-endpoint' });

    const picker = createPicker({
        ctx,
        medium: 'tts',
        value: () => draft.model,
        preferred: 'Kokoro-82m',
        onPick: (model) => {
            draft.model = model?.id ?? null;
            buildForm();
        },
    });

    const root = el('div', { class: 'nanovia-media-studio' }, [
        picker.el,
        formHost,
        estimateHost,
        issuesHost,
        actionsHost,
        statusHost,
        resultHost,
        endpointHost,
    ]);

    const model = (): MediaModel | null => picker.model();

    function drawEstimate(): void {
        clear(estimateHost);
        const current = model();
        if (!current) return;
        const view = estimateView(ttsEstimate(current, draft), false, t);
        estimateHost.appendChild(
            el('div', { class: ['nanovia-media-estimate-line', view.unknown ? 'nanovia-muted' : ''], text: view.text }),
        );
        if (current.subscriptionIncluded === true) {
            estimateHost.appendChild(
                el('div', { class: 'nanovia-field-hint', text: t('media.estimate.subscription') }),
            );
        }
    }

    function syncButtons(): void {
        if (speakButton) speakButton.disabled = busy || !actionsEnabled(ctx.media.state()) || !model();
    }

    function buildForm(): void {
        clear(formHost);
        clear(actionsHost);
        speakButton = null;
        const current = model();
        builtFor = current?.id ?? null;
        if (!current) {
            drawEstimate();
            return;
        }
        const spec = ttsForm(current);
        draft.voice = voiceChoice(current, draft.voice);
        const bad = (name: string): boolean => issues.some((issue) => issue.field === name);

        formHost.appendChild(
            field(
                t('media.field.voice'),
                spec.voices.length > 0
                    ? select<string>({
                          value: draft.voice,
                          label: t('media.field.voice'),
                          options: spec.voices.map((voice) => ({ value: voice, label: voice })),
                          onChange: (value) => {
                              draft.voice = value;
                          },
                      })
                    : textInput({
                          value: draft.voice,
                          label: t('media.field.voice'),
                          placeholder: t('media.tts.voice.free'),
                          onInput: (value) => {
                              draft.voice = value;
                          },
                      }),
                spec.voices.length > 0 ? undefined : t('media.tts.voice.freeHint'),
            ),
        );
        const counter = el('span', { class: 'nanovia-muted nanovia-media-counter' });
        const drawCounter = (): void => {
            counter.textContent = t('media.tts.chars', { count: draft.text.trim().length });
        };
        formHost.appendChild(
            field(
                t('media.field.text'),
                el('div', {}, [
                    textArea({
                        value: draft.text,
                        rows: 5,
                        label: t('media.field.text'),
                        placeholder: t('media.tts.text.placeholder'),
                        onInput: (value) => {
                            draft.text = value;
                            drawCounter();
                            drawEstimate();
                        },
                    }),
                    counter,
                ]),
            ),
        );
        drawCounter();
        formHost.appendChild(
            field(
                t('media.field.speed'),
                numberInput({
                    value: draft.speed,
                    label: t('media.field.speed'),
                    invalid: bad('speed'),
                    onInput: (value) => {
                        draft.speed = value;
                    },
                }),
                spec.speed.listed
                    ? t('media.field.range', { min: spec.speed.min, max: spec.speed.max })
                    : t('media.tts.speed.unlisted'),
            ),
        );
        if (spec.instructions) {
            formHost.appendChild(
                field(
                    t('media.field.instructions'),
                    textArea({
                        value: draft.instructions,
                        rows: 2,
                        label: t('media.field.instructions'),
                        placeholder: t('media.tts.instructions.placeholder'),
                        onInput: (value) => {
                            draft.instructions = value;
                        },
                    }),
                ),
            );
        }
        speakButton = button({
            label: t('media.tts.speak'),
            icon: 'volume-high',
            kind: 'primary',
            onClick: () => {
                void speak();
            },
        });
        actionsHost.append(speakButton);
        drawEstimate();
        syncButtons();
    }

    function drawIssues(): void {
        clear(issuesHost);
        for (const issue of issues) issuesHost.appendChild(noticeBox('error', issueText(issue, t)));
    }

    async function speak(): Promise<void> {
        const current = model();
        if (!current || busy) return;
        const built = buildTtsRequest(current, draft);
        if (!built.ok) {
            issues = built.issues;
            error = null;
            drawIssues();
            statusLine(statusHost, t, { busy: null, error: null });
            buildForm();
            return;
        }
        issues = [];
        drawIssues();
        busy = true;
        error = null;
        statusLine(statusHost, t, { busy: t('media.tts.busy'), error: null });
        syncButtons();
        const result = await ctx.media.speak(built.request);
        busy = false;
        if (disposed) return;
        error = result.ok ? null : result.error;
        statusLine(statusHost, t, { busy: null, error });
        syncButtons();
        drawResult();
    }

    function drawResult(): void {
        const result = ctx.media.last().tts;
        if (!result) {
            shownAudio = null;
            shownCost = null;
            for (const host of [resultHead, playerHost, costHost, metaHost]) clear(host);
            resultHost.hidden = true;
            return;
        }
        resultHost.hidden = false;
        if (result.audio !== shownAudio) {
            shownAudio = result.audio;
            clear(resultHead);
            clear(playerHost);
            clear(metaHost);
            resultHead.append(
                el('b', { text: t('media.result.title') }),
                el('span', { class: 'nanovia-muted', text: result.model }),
                button({
                    label: t('media.result.clear'),
                    icon: 'trash',
                    kind: 'ghost',
                    onClick: () => ctx.media.clearLast('tts'),
                }),
            );
            const src = outputSrc(result.audio);
            if (src) {
                playerHost.append(
                    el('audio', { class: 'nanovia-media-audio', attrs: { controls: true, src, preload: 'auto' } }),
                    el('div', { class: 'nanovia-row' }, [
                        el('a', {
                            class: 'menu_button nanovia-btn',
                            attrs: {
                                href: src,
                                download: downloadName(result.model, 0, result.audio.mime),
                                target: result.audio.dataBase64 ? undefined : '_blank',
                                rel: 'noopener noreferrer',
                            },
                            text: result.audio.dataBase64 ? t('media.result.download') : t('media.result.open'),
                        }),
                        chip(result.audio.mime, 'muted', t('media.tts.mime')),
                        result.audio.bytes
                            ? el('span', { class: 'nanovia-muted', text: formatBytes(result.audio.bytes) })
                            : null,
                    ]),
                );
            } else playerHost.appendChild(el('div', { class: 'nanovia-error-text', text: t('media.tts.noData') }));
            metaHost.append(
                el('span', { text: t('media.tts.billedChars', { count: result.chars }) }),
                el('span', { text: t('media.result.latency', { seconds: (result.latencyMs / 1000).toFixed(1) }) }),
            );
        }
        if (result.cost !== shownCost) {
            shownCost = result.cost;
            clear(costHost);
            costHost.appendChild(costBlock(result.cost, 'tts', t));
        }
    }

    /* ----------------------------------------------------------------------- ST's «OpenAI Compatible» provider */

    function drawEndpoint(): void {
        const wasOpen = endpointHost.open;
        clear(endpointHost);
        endpointHost.appendChild(el('summary', { text: t('media.tts.endpoint.title') }));
        endpointHost.appendChild(el('div', { class: 'nanovia-field-hint', text: t('media.tts.endpoint.intro') }));
        const endpoints = speechEndpoints(ctx.connections.list());
        if (endpoints.length === 0) {
            endpointHost.appendChild(el('div', { class: 'nanovia-muted', text: t('media.tts.endpoint.none') }));
        } else {
            if (!endpoints.some((item) => item.connectionId === selectedConnection)) {
                selectedConnection = endpoints[0]?.connectionId ?? '';
            }
            const chosen = endpoints.find((item) => item.connectionId === selectedConnection) ?? endpoints[0];
            const urlBox = textInput({ value: chosen?.url ?? '', label: t('media.tts.endpoint.url') });
            urlBox.readOnly = true;
            endpointHost.append(
                field(
                    t('media.tts.endpoint.connection'),
                    select<string>({
                        value: selectedConnection,
                        label: t('media.tts.endpoint.connection'),
                        options: endpoints.map((item) => ({ value: item.connectionId, label: item.name })),
                        onChange: (value) => {
                            selectedConnection = value;
                            drawEndpoint();
                        },
                    }),
                ),
                field(
                    t('media.tts.endpoint.url'),
                    el('div', { class: 'nanovia-row' }, [
                        urlBox,
                        copyButton(t('media.copy'), t('media.copied'), () => chosen?.url ?? ''),
                    ]),
                ),
            );
        }
        endpointHost.appendChild(el('div', { class: 'nanovia-field-hint', text: t('media.tts.endpoint.token') }));
        endpointHost.open = wasOpen;
    }

    picker.update();
    if ((picker.model()?.id ?? null) !== builtFor) buildForm();
    drawResult();
    drawEndpoint();

    const offConnections = ctx.connections.onChange(() => {
        if (!disposed) drawEndpoint();
    });

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
            offConnections();
        },
    };
}
