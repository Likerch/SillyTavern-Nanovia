// The model picker of a studio: a search box, the adult-capable and cheapest-first switches, the select of models (with
// their prices) and a short card of the chosen one. The catalog of a medium is long (hundreds of image models), so the
// picker is built to be filtered; the search box is built once and never redrawn, so typing is not interrupted when the
// catalog or the plugin's state changes underneath it.
import type { FeatureContext } from '../../core/context';
import { defaultModel, startsFromPrompt } from '../../core/media-select';
import type { ModelSort } from '../../core/media-select';
import type { MediaModel, Medium } from '../../shared/contracts-media';
import { button, chip, clear, el, field, select, textInput, toggle } from '../../ui';
import { append } from '../../ui/dom';
import { capabilityChips, errorText, modelLabel, priceText, priceTitle } from './view-model';

export interface PickerOptions {
    ctx: FeatureContext;
    medium: Medium;
    /** The id the draft holds (null = none chosen yet: the picker chooses one when the catalog is there). */
    value(): string | null;
    /** The user (or the default) chose a model; null when the list is empty. */
    onPick(model: MediaModel | null): void;
    /** The id a fresh studio starts with when the catalog has it (any case). */
    preferred?: string;
}

export interface Picker {
    el: HTMLElement;
    /** Redraw the select and the card from the store (the search box stays as it is). */
    update(): void;
    /** The chosen model; null while the catalog is not loaded or empty. */
    model(): MediaModel | null;
}

export function createPicker(options: PickerOptions): Picker {
    const { ctx, medium } = options;
    const t = ctx.t;
    let search = '';
    let uncensored = false;
    let sort: ModelSort = 'name';
    let chosen: MediaModel | null = null;

    const statusHost = el('div', { class: 'nanovia-media-picker-status' });
    const selectHost = el('div', { class: 'nanovia-media-picker-select' });
    const cardHost = el('div', { class: 'nanovia-media-model-card' });

    const searchInput = textInput({
        value: '',
        label: t('media.picker.search'),
        placeholder: t('media.picker.search'),
        onInput: (value) => {
            search = value;
            draw();
        },
    });
    const controls = el('div', { class: 'nanovia-row nanovia-media-picker-controls' }, [
        toggle({
            label: t('media.filter.uncensored'),
            checked: false,
            hint: t('media.filter.uncensored.hint'),
            onChange: (on) => {
                uncensored = on;
                draw();
            },
        }),
        select<ModelSort>({
            value: sort,
            label: t('media.filter.sort'),
            options: [
                { value: 'name', label: t('media.sort.name') },
                { value: 'price', label: t('media.sort.price') },
            ],
            onChange: (value) => {
                sort = value;
                draw();
            },
        }),
    ]);

    const root = el('div', { class: 'nanovia-media-picker' }, [
        field(t('media.picker.model'), selectHost),
        searchInput,
        controls,
        statusHost,
        cardHost,
    ]);

    function drawCard(model: MediaModel | null): void {
        clear(cardHost);
        if (!model) return;
        const title = priceTitle(model.price);
        append(cardHost, [
            el('div', { class: 'nanovia-row' }, [
                el('b', { text: model.name }),
                model.owner ? el('span', { class: 'nanovia-muted', text: model.owner }) : null,
                model.category ? chip(model.category, 'muted') : null,
            ]),
            el('div', { class: 'nanovia-row' }, [
                el('span', {
                    class: 'nanovia-media-money',
                    text: priceText(model.price, t),
                    ...(title ? { title } : {}),
                }),
                ...capabilityChips(model, t).map((spec) => chip(spec.label, spec.kind, spec.title)),
            ]),
            model.description
                ? el('div', { class: 'nanovia-field-hint nanovia-media-description', text: model.description })
                : null,
        ]);
    }

    function draw(): void {
        const view = ctx.media.catalogView(medium);
        clear(statusHost);
        clear(selectHost);

        if (view.models.length === 0) {
            chosen = null;
            if (view.status === 'failed' && view.error) {
                statusHost.append(
                    el('div', { class: 'nanovia-error-text', text: errorText(view.error, t) }),
                    button({
                        label: t('media.catalog.retry'),
                        icon: 'rotate',
                        kind: 'ghost',
                        onClick: async () => {
                            await ctx.media.ensure(medium, { refresh: true });
                        },
                    }),
                );
            } else {
                statusHost.appendChild(
                    el('div', {
                        class: 'nanovia-muted',
                        text: view.status === 'ready' ? t('media.picker.empty') : t('media.catalog.loading'),
                    }),
                );
            }
            drawCard(null);
            return;
        }

        const found = ctx.media.select(medium, { search, uncensored, sort, ttsKind: 'speech' });
        const currentId = options.value();
        const current = currentId ? (view.models.find((model) => model.id === currentId) ?? null) : null;
        // A model that the filters hide stays in the list while it is the chosen one: filtering must not change the choice.
        const listed = current && !found.some((model) => model.id === current.id) ? [current, ...found] : found;

        if (listed.length === 0) {
            chosen = null;
            statusHost.appendChild(el('div', { class: 'nanovia-muted', text: t('media.picker.noMatch') }));
            drawCard(null);
            return;
        }

        const target =
            current ??
            defaultModel(listed, {
                ...(options.preferred ? { preferred: options.preferred } : {}),
                suitable: (model) => startsFromPrompt(medium, model),
            });
        const selectEl = select<string>({
            value: target?.id ?? '',
            label: t('media.picker.model'),
            options: listed.map((model) => ({ value: model.id, label: modelLabel(model, t) })),
            onChange: (id) => {
                const model = view.models.find((item) => item.id === id) ?? null;
                chosen = model;
                drawCard(model);
                options.onPick(model);
            },
        });
        selectHost.appendChild(selectEl);
        statusHost.appendChild(
            el('div', {
                class: 'nanovia-muted',
                text: t('media.picker.count', { shown: listed.length, total: view.models.length }),
            }),
        );
        const changed = target?.id !== chosen?.id;
        chosen = target;
        drawCard(target);
        // The first draw (or a catalog that arrived after the draft was made) settles on a model: tell the studio.
        if (changed && target && target.id !== currentId) options.onPick(target);
    }

    // Nothing is drawn yet: the studio calls update() once it is ready for onPick (a first choice is announced from it).
    void ctx.media.ensure(medium);

    return {
        el: root,
        update: draw,
        model: () => chosen,
    };
}
