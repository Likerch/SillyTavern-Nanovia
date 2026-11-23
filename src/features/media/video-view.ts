// The video studio: a model, prompt, an optional start image, duration, aspect and resolution from the model's own list, an
// estimate (said to be approximate when the price depends on length and resolution), and the list of jobs. A video takes
// minutes, so a submit only makes a job; the store polls the unfinished ones while this section is open. NanoGPT has no
// cancel: a submitted job runs to the end and is billed (a failed one is refunded by NanoGPT), and the page says so.
import type { MediaError } from '../../host';
import type { MediaModel, VideoJob } from '../../shared/contracts-media';
import { button, chip, clear, el, field, select, textArea } from '../../ui';
import { append } from '../../ui/dom';
import { noticeBox, numberInput, readAsDataUrl, statusLine } from './controls';
import type { Studio, StudioDeps } from './controls';
import { createPicker } from './picker';
import {
    MAX_UPLOAD_BYTES,
    buildVideoRequest,
    checkImageDataUrl,
    choiceValue,
    dataUrlBytes,
    videoForm,
} from './param-form';
import type { ChoiceField, FormIssue, NumberField } from './param-form';
import { actionsEnabled, errorText, estimateView, formatBytes, issueText, jobView, videoEstimate } from './view-model';

interface JobCard {
    el: HTMLElement;
    update(job: VideoJob, now: number): void;
}

export function createVideoStudio(deps: StudioDeps): Studio {
    const { ctx, session } = deps;
    const t = ctx.t;
    const draft = session.video;
    let disposed = false;
    let busy = false;
    let error: MediaError | null = null;
    let issues: FormIssue[] = [];
    let builtFor: string | null = null;
    let submitButton: HTMLButtonElement | null = null;
    let startNotice: string | null = null;
    const cards = new Map<string, JobCard>();

    const formHost = el('div', { class: 'nanovia-media-form' });
    const estimateHost = el('div', { class: 'nanovia-media-estimate', attrs: { 'aria-live': 'polite' } });
    const issuesHost = el('div', { class: 'nanovia-media-issues' });
    const actionsHost = el('div', { class: 'nanovia-row' });
    const statusHost = el('div', { class: 'nanovia-media-status', attrs: { 'aria-live': 'polite' } });
    const jobsNotice = el('div', { class: 'nanovia-media-jobs-notice' });
    const jobsList = el('div', { class: 'nanovia-cards nanovia-media-jobs' });
    const jobsEmpty = el('div', { class: 'nanovia-muted nanovia-empty', text: t('media.video.jobs.empty') });
    const jobsSection = el('section', { class: 'nanovia-media-result' }, [
        el('b', { text: t('media.video.jobs.title') }),
        el('div', { class: 'nanovia-field-hint', text: t('media.video.noCancel') }),
        jobsNotice,
        jobsEmpty,
        jobsList,
    ]);

    const picker = createPicker({
        ctx,
        medium: 'video',
        value: () => draft.model,
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
        jobsSection,
    ]);

    const model = (): MediaModel | null => picker.model();

    function drawEstimate(): void {
        clear(estimateHost);
        const current = model();
        if (!current) return;
        const estimate = videoEstimate(current, draft);
        const view = estimateView(estimate, current.priceIsApproximate, t);
        estimateHost.appendChild(
            el('div', { class: ['nanovia-media-estimate-line', view.unknown ? 'nanovia-muted' : ''], text: view.text }),
        );
        if (current.priceIsApproximate) {
            estimateHost.appendChild(
                el('div', { class: 'nanovia-field-hint', text: t('media.video.estimate.approxHint') }),
            );
        }
        estimateHost.appendChild(el('div', { class: 'nanovia-field-hint', text: t('media.video.estimate.final') }));
    }

    function syncButtons(): void {
        if (submitButton) submitButton.disabled = busy || !actionsEnabled(ctx.media.state()) || !model();
    }

    function choice(spec: ChoiceField, value: string, label: string, set: (value: string) => void): HTMLElement {
        return select<string>({
            value,
            label,
            options: (spec.kind === 'enum' ? spec.values : []).map((item) => ({ value: item, label: item })),
            onChange: (next) => {
                set(next);
                drawEstimate();
            },
        });
    }

    function drawStartImage(host: HTMLElement): void {
        clear(host);
        if (draft.startImage) {
            host.appendChild(
                el('div', { class: 'nanovia-media-ref' }, [
                    el('img', {
                        class: 'nanovia-media-thumb',
                        attrs: { src: draft.startImage.dataUrl, alt: draft.startImage.name },
                    }),
                    el('div', { class: 'nanovia-media-ref-info' }, [
                        el('div', { class: 'nanovia-media-ref-name', text: draft.startImage.name }),
                        el('div', { class: 'nanovia-muted', text: formatBytes(draft.startImage.bytes) }),
                    ]),
                    button({
                        icon: 'xmark',
                        title: t('media.image.refs.remove'),
                        kind: 'ghost',
                        onClick: () => {
                            draft.startImage = null;
                            drawStartImage(host);
                        },
                    }),
                ]),
            );
        }
        if (startNotice) host.appendChild(noticeBox('error', startNotice));
    }

    async function chooseStartImage(files: FileList | null, host: HTMLElement): Promise<void> {
        const file = files?.[0];
        if (!file) return;
        startNotice = null;
        let dataUrl = '';
        try {
            dataUrl = await readAsDataUrl(file);
        } catch {
            startNotice = t('media.image.refs.unreadable', { name: file.name });
        }
        if (dataUrl) {
            const verdict = checkImageDataUrl(dataUrl);
            if (verdict === 'not_image') startNotice = t('media.image.refs.notImage', { name: file.name });
            else if (verdict === 'too_large') startNotice = t('media.image.refs.tooLarge', { name: file.name });
            else draft.startImage = { name: file.name, dataUrl, bytes: dataUrlBytes(dataUrl) };
        }
        if (!disposed) drawStartImage(host);
    }

    function buildForm(): void {
        clear(formHost);
        clear(actionsHost);
        submitButton = null;
        const current = model();
        builtFor = current?.id ?? null;
        if (!current) {
            drawEstimate();
            return;
        }
        const spec = videoForm(current);
        draft.aspect = choiceValue(spec.aspect, draft.aspect);
        draft.resolution = choiceValue(spec.resolution, draft.resolution);
        if (spec.duration?.kind === 'enum' && !spec.duration.values.includes(draft.duration)) {
            draft.duration = spec.duration.default;
        }
        if (!spec.startImage) draft.startImage = null;
        const bad = (name: string): boolean => issues.some((issue) => issue.field === name);
        const numeric = (name: 'seed', numberSpec: NumberField): HTMLElement =>
            field(
                t(`media.field.${name}`),
                numberInput({
                    value: draft[name],
                    label: t(`media.field.${name}`),
                    placeholder: numberSpec.default !== null ? String(numberSpec.default) : '',
                    invalid: bad(name),
                    onInput: (value) => {
                        draft[name] = value;
                    },
                }),
            );

        formHost.appendChild(
            field(
                t('media.field.prompt'),
                textArea({
                    value: draft.prompt,
                    rows: 4,
                    label: t('media.field.prompt'),
                    placeholder: t('media.video.prompt.placeholder'),
                    onInput: (value) => {
                        draft.prompt = value;
                    },
                }),
            ),
        );
        if (spec.startImage) {
            const preview = el('div', { class: 'nanovia-media-refs' });
            const input = el('input', {
                class: 'nanovia-media-file',
                attrs: { type: 'file', accept: 'image/*', 'aria-label': t('media.video.startImage.add') },
            });
            input.addEventListener('change', () => {
                void chooseStartImage(input.files, preview).then(() => {
                    input.value = '';
                });
            });
            formHost.appendChild(
                field(
                    t('media.video.startImage.title'),
                    el('div', { class: 'nanovia-media-refs-block' }, [input, preview]),
                    t('media.video.startImage.hint', { size: formatBytes(MAX_UPLOAD_BYTES) }),
                ),
            );
            drawStartImage(preview);
        }
        if (spec.duration) {
            const duration = spec.duration;
            formHost.appendChild(
                field(
                    t('media.field.duration'),
                    duration.kind === 'enum'
                        ? select<string>({
                              value: draft.duration,
                              label: t('media.field.duration'),
                              options: duration.values.map((item) => ({ value: item, label: item })),
                              onChange: (value) => {
                                  draft.duration = value;
                                  drawEstimate();
                              },
                          })
                        : numberInput({
                              value: draft.duration,
                              label: t('media.field.duration'),
                              placeholder: duration.field.default !== null ? String(duration.field.default) : '',
                              invalid: bad('duration'),
                              onInput: (value) => {
                                  draft.duration = value;
                                  drawEstimate();
                              },
                          }),
                    duration.kind === 'number' && duration.field.min !== null && duration.field.max !== null
                        ? t('media.field.range', { min: duration.field.min, max: duration.field.max })
                        : undefined,
                ),
            );
        }
        if (spec.aspect) {
            formHost.appendChild(
                field(
                    t('media.field.aspect'),
                    choice(spec.aspect, draft.aspect, t('media.field.aspect'), (value) => {
                        draft.aspect = value;
                    }),
                ),
            );
        }
        if (spec.resolution) {
            formHost.appendChild(
                field(
                    t('media.field.resolution'),
                    choice(spec.resolution, draft.resolution, t('media.field.resolution'), (value) => {
                        draft.resolution = value;
                    }),
                ),
            );
        }
        if (spec.seed) formHost.appendChild(numeric('seed', spec.seed));

        submitButton = button({
            label: t('media.video.submit'),
            icon: 'film',
            kind: 'primary',
            onClick: () => {
                void submit();
            },
        });
        actionsHost.append(submitButton);
        drawEstimate();
        syncButtons();
    }

    function drawIssues(): void {
        clear(issuesHost);
        for (const issue of issues) issuesHost.appendChild(noticeBox('error', issueText(issue, t)));
    }

    async function submit(): Promise<void> {
        const current = model();
        if (!current || busy) return;
        const built = buildVideoRequest(current, draft);
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
        statusLine(statusHost, t, { busy: t('media.video.busy'), error: null });
        syncButtons();
        const result = await ctx.media.startVideo(built.request);
        busy = false;
        if (disposed) return;
        error = result.ok ? null : result.error;
        statusLine(statusHost, t, { busy: null, error });
        if (result.ok) statusHost.appendChild(noticeBox('ok', t('media.video.submitted')));
        syncButtons();
        drawJobs();
    }

    /* ---------------------------------------------------------------------------------------------- jobs */

    function createCard(job: VideoJob): JobCard {
        const head = el('div', { class: 'nanovia-row nanovia-media-job-head' });
        const promptLine = el('div', { class: 'nanovia-media-job-prompt' });
        const progress = el('div', {
            class: 'nanovia-bar',
            attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 },
        });
        const fill = el('div', { class: 'nanovia-bar-fill nanovia-bar-ok' });
        progress.appendChild(fill);
        const numbers = el('div', { class: 'nanovia-row nanovia-muted' });
        const errorLine = el('div', { class: 'nanovia-error-text' });
        const mediaHost = el('div', { class: 'nanovia-media-job-video' });
        const actions = el('div', { class: 'nanovia-row' });
        let shownFile: string | null = null;
        let shownLink: string | null = null;

        actions.appendChild(
            button({
                label: t('media.video.delete'),
                icon: 'trash',
                kind: 'danger',
                onClick: async () => {
                    const confirmed = await ctx.host.confirm(
                        t('media.video.delete.confirm'),
                        t('media.video.delete.title'),
                    );
                    if (!confirmed) return;
                    const result = await ctx.media.deleteVideo(job.id);
                    if (!result.ok) statusLine(statusHost, t, { busy: null, error: result.error });
                },
            }),
        );

        const card = el('div', { class: 'nanovia-card nanovia-media-job', data: { job: job.id } }, [
            head,
            promptLine,
            progress,
            numbers,
            errorLine,
            mediaHost,
            actions,
        ]);

        return {
            el: card,
            update(next, now) {
                const view = jobView(next, now, t);
                clear(head);
                head.append(
                    chip(view.statusLabel, view.statusKind),
                    el('b', { text: next.model }),
                    el('span', { class: 'nanovia-muted', text: view.created }),
                );
                promptLine.textContent = next.prompt;
                progress.hidden = view.terminal || view.percent === null;
                if (view.percent !== null) {
                    fill.style.width = `${view.percent}%`;
                    progress.setAttribute('aria-valuenow', String(view.percent));
                }
                clear(numbers);
                append(numbers, [
                    el('span', { text: view.cost }),
                    view.percent !== null
                        ? el('span', { text: t('media.job.progress', { percent: view.percent }) })
                        : null,
                ]);
                errorLine.textContent = view.error ?? '';
                errorLine.hidden = view.error === null;
                // The player is made once per file: redrawing it on every poll would restart the playback.
                if (view.fileUrl !== shownFile || view.upstreamUrl !== shownLink) {
                    shownFile = view.fileUrl;
                    shownLink = view.upstreamUrl;
                    clear(mediaHost);
                    if (view.fileUrl) {
                        mediaHost.appendChild(
                            el('video', {
                                class: 'nanovia-media-video',
                                attrs: { controls: true, preload: 'metadata', src: view.fileUrl },
                            }),
                        );
                    } else if (view.upstreamUrl) {
                        mediaHost.append(
                            el('div', { class: 'nanovia-field-hint', text: t('media.job.noLocalCopy') }),
                            el('a', {
                                class: 'menu_button nanovia-btn',
                                attrs: { href: view.upstreamUrl, target: '_blank', rel: 'noopener noreferrer' },
                                text: t('media.job.openUpstream'),
                            }),
                        );
                    }
                }
            },
        };
    }

    function drawJobs(): void {
        const view = ctx.media.videos();
        const now = Date.now();
        clear(jobsNotice);
        if (view.error)
            jobsNotice.appendChild(
                noticeBox('warn', t('media.video.jobs.stale', { reason: errorText(view.error, t) })),
            );
        jobsEmpty.hidden = view.jobs.length > 0 || !view.loaded;
        const ids = new Set(view.jobs.map((job) => job.id));
        for (const [id, card] of cards) {
            if (!ids.has(id)) {
                card.el.remove();
                cards.delete(id);
            }
        }
        view.jobs.forEach((job, index) => {
            let card = cards.get(job.id);
            if (!card) {
                card = createCard(job);
                cards.set(job.id, card);
            }
            card.update(job, now);
            // Keep the DOM in the list's order without moving a card that is already in place (a playing video stays put).
            if (jobsList.children[index] !== card.el) jobsList.insertBefore(card.el, jobsList.children[index] ?? null);
        });
    }

    /* ------------------------------------------------------------------------------------------ lifecycle */

    const stopWatching = ctx.media.watchVideos();
    picker.update();
    if ((picker.model()?.id ?? null) !== builtFor) buildForm();
    drawJobs();

    return {
        el: root,
        update() {
            if (disposed) return;
            picker.update();
            if ((picker.model()?.id ?? null) !== builtFor) buildForm();
            syncButtons();
            drawJobs();
        },
        dispose() {
            disposed = true;
            stopWatching();
        },
    };
}
