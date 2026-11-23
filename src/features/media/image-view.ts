// The image studio: model, prompt and the settings the model lists, reference images, a cost estimate before the call, the
// result grid with download buttons, and after the call what was billed against what was estimated. The decisions (which
// fields exist, what a draft must satisfy, what the estimate says) are in param-form.ts and view-model.ts.
import type { MediaError } from '../../host';
import type { ImageResult, MediaModel } from '../../shared/contracts-media';
import { button, chip, clear, el, field, select, textArea, textInput } from '../../ui';
import { append } from '../../ui/dom';
import { costBlock, noticeBox, numberInput, readAsDataUrl, statusLine } from './controls';
import type { Studio, StudioDeps } from './controls';
import { createPicker } from './picker';
import {
    MAX_UPLOAD_BYTES,
    buildImageRequest,
    checkImageDataUrl,
    choiceValue,
    dataUrlBytes,
    downloadName,
    imageForm,
} from './param-form';
import type { ChoiceField, FormIssue, NumberField } from './param-form';
import { actionsEnabled, estimateView, formatBytes, imageEstimate, issueText, outputSrc } from './view-model';

/** A hint for a number field: its bounds, when the model lists them. */
function boundsHint(field: NumberField, t: StudioDeps['ctx']['t']): string {
    if (field.min !== null && field.max !== null) return t('media.field.range', { min: field.min, max: field.max });
    return '';
}

export function createImageStudio(deps: StudioDeps): Studio {
    const { ctx, session } = deps;
    const t = ctx.t;
    const draft = session.image;
    let disposed = false;
    let busy = false;
    let error: MediaError | null = null;
    let issues: FormIssue[] = [];
    let builtFor: string | null = null;
    let shownOutputs: ImageResult['outputs'] | null = null;
    let shownCost: ImageResult['cost'] | null = null;
    let referenceNotice: string | null = null;

    const formHost = el('div', { class: 'nanovia-media-form' });
    const estimateHost = el('div', { class: 'nanovia-media-estimate', attrs: { 'aria-live': 'polite' } });
    const issuesHost = el('div', { class: 'nanovia-media-issues' });
    const actionsHost = el('div', { class: 'nanovia-row' });
    const statusHost = el('div', { class: 'nanovia-media-status', attrs: { 'aria-live': 'polite' } });
    const gridHost = el('div', { class: 'nanovia-media-grid' });
    const costHost = el('div', { class: 'nanovia-media-result-cost' });
    const metaHost = el('div', { class: 'nanovia-muted nanovia-media-meta' });
    const resultHead = el('div', { class: 'nanovia-row nanovia-media-result-head' });
    const resultHost = el('section', { class: 'nanovia-media-result', attrs: { hidden: true } }, [
        resultHead,
        gridHost,
        costHost,
        metaHost,
    ]);

    let generateButton: HTMLButtonElement | null = null;

    const picker = createPicker({
        ctx,
        medium: 'image',
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
        resultHost,
    ]);

    const model = (): MediaModel | null => picker.model();

    /* ------------------------------------------------------------------------------------------- the form */

    function drawEstimate(): void {
        clear(estimateHost);
        const current = model();
        if (!current) return;
        const view = estimateView(imageEstimate(current, draft), false, t);
        estimateHost.appendChild(
            el('div', { class: ['nanovia-media-estimate-line', view.unknown ? 'nanovia-muted' : ''], text: view.text }),
        );
        if (current.subscriptionIncluded === true) {
            estimateHost.appendChild(
                el('div', { class: 'nanovia-field-hint', text: t('media.estimate.subscription') }),
            );
        }
    }

    function choiceControl(spec: ChoiceField, value: string, label: string, set: (value: string) => void): HTMLElement {
        if (spec.kind === 'enum') {
            return select<string>({
                value,
                label,
                options: spec.values.map((item) => ({ value: item, label: item })),
                onChange: (next) => {
                    set(next);
                    drawEstimate();
                },
            });
        }
        return textInput({
            value,
            label,
            placeholder: t('media.image.size.placeholder'),
            onInput: (next) => {
                set(next);
                drawEstimate();
            },
        });
    }

    function drawReferences(host: HTMLElement, max: number): void {
        clear(host);
        for (const [index, reference] of draft.references.entries()) {
            host.appendChild(
                el('div', { class: 'nanovia-media-ref', data: { ref: index } }, [
                    el('img', {
                        class: 'nanovia-media-thumb',
                        attrs: { src: reference.dataUrl, alt: reference.name },
                    }),
                    el('div', { class: 'nanovia-media-ref-info' }, [
                        el('div', { class: 'nanovia-media-ref-name', text: reference.name }),
                        el('div', { class: 'nanovia-muted', text: formatBytes(reference.bytes) }),
                    ]),
                    button({
                        icon: 'xmark',
                        title: t('media.image.refs.remove'),
                        kind: 'ghost',
                        onClick: () => {
                            draft.references.splice(index, 1);
                            drawReferences(host, max);
                        },
                    }),
                ]),
            );
        }
        if (referenceNotice) host.appendChild(noticeBox('error', referenceNotice));
    }

    async function addReferences(files: FileList | null, host: HTMLElement, max: number): Promise<void> {
        referenceNotice = null;
        for (const file of Array.from(files ?? [])) {
            if (draft.references.length >= max) {
                referenceNotice = t('media.issue.too_many_references', { detail: max });
                break;
            }
            let dataUrl: string;
            try {
                dataUrl = await readAsDataUrl(file);
            } catch {
                referenceNotice = t('media.image.refs.unreadable', { name: file.name });
                continue;
            }
            const verdict = checkImageDataUrl(dataUrl);
            if (verdict === 'not_image') {
                referenceNotice = t('media.image.refs.notImage', { name: file.name });
                continue;
            }
            if (verdict === 'too_large') {
                referenceNotice = t('media.image.refs.tooLarge', { name: file.name });
                continue;
            }
            draft.references.push({ name: file.name, dataUrl, bytes: dataUrlBytes(dataUrl) });
        }
        if (!disposed) drawReferences(host, max);
    }

    function buildForm(): void {
        clear(formHost);
        clear(actionsHost);
        generateButton = null;
        const current = model();
        builtFor = current?.id ?? null;
        if (!current) {
            drawEstimate();
            return;
        }
        const spec = imageForm(current);
        draft.size = choiceValue(spec.size, draft.size);
        draft.aspect = choiceValue(spec.aspect, draft.aspect);
        if (!spec.references) draft.references = [];
        else if (draft.references.length > spec.references.max)
            draft.references = draft.references.slice(0, spec.references.max);
        if (spec.count.max < (Number(draft.count) || 1)) draft.count = String(spec.count.max);

        const bad = (name: string): boolean => issues.some((issue) => issue.field === name);
        const numeric = (name: 'seed' | 'steps' | 'guidance', numberSpec: NumberField): HTMLElement => {
            const hint = boundsHint(numberSpec, t);
            return field(
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
                hint || undefined,
            );
        };

        formHost.appendChild(
            field(
                t('media.field.prompt'),
                textArea({
                    value: draft.prompt,
                    rows: 4,
                    label: t('media.field.prompt'),
                    placeholder: t('media.image.prompt.placeholder'),
                    onInput: (value) => {
                        draft.prompt = value;
                    },
                }),
            ),
        );
        if (spec.negative) {
            formHost.appendChild(
                field(
                    t('media.field.negative'),
                    textArea({
                        value: draft.negative,
                        rows: 2,
                        label: t('media.field.negative'),
                        onInput: (value) => {
                            draft.negative = value;
                        },
                    }),
                ),
            );
        }
        if (spec.size) {
            formHost.appendChild(
                field(
                    t('media.field.size'),
                    choiceControl(spec.size, draft.size, t('media.field.size'), (value) => {
                        draft.size = value;
                    }),
                    spec.size.kind === 'free' ? t('media.image.size.hint') : undefined,
                ),
            );
        }
        if (spec.aspect) {
            formHost.appendChild(
                field(
                    t('media.field.aspect'),
                    choiceControl(spec.aspect, draft.aspect, t('media.field.aspect'), (value) => {
                        draft.aspect = value;
                    }),
                ),
            );
        }
        formHost.appendChild(
            field(
                t('media.field.count'),
                numberInput({
                    value: draft.count,
                    label: t('media.field.count'),
                    invalid: bad('count'),
                    onInput: (value) => {
                        draft.count = value;
                        drawEstimate();
                    },
                }),
                t('media.image.count.hint', { max: spec.count.max }),
            ),
        );
        if (spec.seed) formHost.appendChild(numeric('seed', spec.seed));
        if (spec.steps) formHost.appendChild(numeric('steps', spec.steps));
        if (spec.guidance) formHost.appendChild(numeric('guidance', spec.guidance));

        if (spec.references) {
            const max = spec.references.max;
            const list = el('div', { class: 'nanovia-media-refs' });
            const input = el('input', {
                attrs: { type: 'file', accept: 'image/*', multiple: max > 1, 'aria-label': t('media.image.refs.add') },
                class: 'nanovia-media-file',
            });
            input.addEventListener('change', () => {
                void addReferences(input.files, list, max).then(() => {
                    input.value = '';
                });
            });
            formHost.appendChild(
                field(
                    t('media.image.refs.title'),
                    el('div', { class: 'nanovia-media-refs-block' }, [input, list]),
                    t('media.image.refs.hint', { max, size: formatBytes(MAX_UPLOAD_BYTES) }),
                ),
            );
            drawReferences(list, max);
        }

        generateButton = button({
            label: t('media.image.generate'),
            icon: 'wand-magic-sparkles',
            kind: 'primary',
            onClick: () => {
                void generate();
            },
        });
        actionsHost.append(generateButton);
        drawEstimate();
        syncButtons();
    }

    function syncButtons(): void {
        if (generateButton) generateButton.disabled = busy || !actionsEnabled(ctx.media.state()) || !model();
    }

    /* ------------------------------------------------------------------------------------------ the call */

    function drawIssues(): void {
        clear(issuesHost);
        for (const issue of issues) issuesHost.appendChild(noticeBox('error', issueText(issue, t)));
    }

    async function generate(): Promise<void> {
        const current = model();
        if (!current || busy) return;
        const built = buildImageRequest(current, draft);
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
        statusLine(statusHost, t, { busy: t('media.image.busy'), error: null });
        syncButtons();
        const result = await ctx.media.generateImage(built.request);
        busy = false;
        if (disposed) return;
        error = result.ok ? null : result.error;
        statusLine(statusHost, t, { busy: null, error });
        syncButtons();
        drawResult();
    }

    /* ----------------------------------------------------------------------------------------- the result */

    function drawResult(): void {
        const result = ctx.media.last().image;
        if (!result) {
            shownOutputs = null;
            shownCost = null;
            // Large pictures leave the page with the result, not just out of sight.
            for (const host of [resultHead, gridHost, costHost, metaHost]) clear(host);
            resultHost.hidden = true;
            return;
        }
        resultHost.hidden = false;
        if (result.outputs !== shownOutputs) {
            shownOutputs = result.outputs;
            clear(resultHead);
            clear(gridHost);
            clear(metaHost);
            resultHead.append(
                el('b', { text: t('media.result.title') }),
                el('span', { class: 'nanovia-muted', text: result.model }),
                button({
                    label: t('media.result.clear'),
                    icon: 'trash',
                    kind: 'ghost',
                    onClick: () => ctx.media.clearLast('image'),
                }),
            );
            result.outputs.forEach((output, index) => {
                const src = outputSrc(output);
                const card = el('figure', { class: 'nanovia-media-figure', data: { output: index } });
                if (src) {
                    card.appendChild(
                        el('img', {
                            class: 'nanovia-media-image',
                            attrs: { src, alt: t('media.image.alt', { n: index + 1 }), referrerpolicy: 'no-referrer' },
                        }),
                    );
                    card.appendChild(
                        el('figcaption', { class: 'nanovia-row' }, [
                            el('a', {
                                class: 'menu_button nanovia-btn',
                                attrs: {
                                    href: src,
                                    download: downloadName(result.model, index, output.mime),
                                    target: output.dataBase64 ? undefined : '_blank',
                                    rel: 'noopener noreferrer',
                                },
                                text: output.dataBase64 ? t('media.result.download') : t('media.result.open'),
                            }),
                            output.bytes
                                ? el('span', { class: 'nanovia-muted', text: formatBytes(output.bytes) })
                                : null,
                        ]),
                    );
                } else {
                    card.appendChild(el('div', { class: 'nanovia-error-text', text: t('media.image.noData') }));
                }
                gridHost.appendChild(card);
            });
            append(metaHost, [
                el('span', { text: t('media.result.latency', { seconds: (result.latencyMs / 1000).toFixed(1) }) }),
                result.requestId ? chip(result.requestId, 'muted', t('media.result.requestId')) : null,
            ]);
        }
        if (result.cost !== shownCost) {
            shownCost = result.cost;
            clear(costHost);
            costHost.appendChild(costBlock(result.cost, 'image', t));
        }
    }

    /* ------------------------------------------------------------------------------------------ lifecycle */

    picker.update();
    if ((picker.model()?.id ?? null) !== builtFor) buildForm();
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
        },
    };
}
