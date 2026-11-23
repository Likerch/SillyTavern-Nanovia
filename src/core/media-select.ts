// Choosing among the models of a media catalog: speech or music (the TTS list mixes both), the adult-capable ones, a text
// search, a sort by price or name. Pure functions of their arguments, used by the Media tab, the studios and the TTS
// provider alike, so "the models a studio offers" is one definition.
import type { MediaModel, Medium } from '../shared/contracts-media';

export type TtsKind = 'speech' | 'music' | 'all';
export type ModelSort = 'name' | 'price';

export interface ModelQuery {
    /** Words that must all appear in the id, name, owner, category, tags or description (any case). */
    search?: string;
    /** Only models the list flags as adult-capable (`capabilities.nsfw`). */
    uncensored?: boolean;
    sort?: ModelSort;
    /** `tts` lists only: speech (default), music, or both. Ignored for the other media. */
    ttsKind?: TtsKind;
}

/** The `type=tts` list holds music models too; they say so through `capabilities.music`. */
export function isMusicModel(model: MediaModel): boolean {
    return model.medium === 'tts' && model.capabilities.music === true;
}

export function isSpeechModel(model: MediaModel): boolean {
    return model.medium === 'tts' && model.capabilities.music !== true;
}

function haystack(model: MediaModel): string {
    return [model.id, model.name, model.owner, model.category, model.description, ...model.tags]
        .join(' ')
        .toLowerCase();
}

/** Every word of `text` is somewhere in the model's descriptive fields; an empty text matches everything. */
export function matchesSearch(model: MediaModel, text: string): boolean {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const hay = haystack(model);
    return words.every((word) => hay.includes(word));
}

/** The figure models are ranked by when sorting by price: the cheapest the list gives; unknown prices rank last. */
export function priceRank(model: MediaModel): number {
    const figure = model.price.from;
    return figure === null || !Number.isFinite(figure) ? Number.POSITIVE_INFINITY : figure;
}

function byName(a: MediaModel, b: MediaModel): number {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortModels(models: readonly MediaModel[], sort: ModelSort): MediaModel[] {
    const list = [...models];
    if (sort === 'name') return list.sort(byName);
    return list.sort((a, b) => {
        const x = priceRank(a);
        const y = priceRank(b);
        // Infinity - Infinity is NaN: compare unknown prices by name instead.
        if (x === y) return byName(a, b);
        return x < y ? -1 : 1;
    });
}

/** The models of a list that pass `query`, in its order (by name unless asked for the price). */
export function selectModels(models: readonly MediaModel[], query: ModelQuery = {}): MediaModel[] {
    const kind = query.ttsKind ?? 'speech';
    const passing = models.filter((model) => {
        if (model.medium === 'tts') {
            if (kind === 'speech' && !isSpeechModel(model)) return false;
            if (kind === 'music' && !isMusicModel(model)) return false;
        }
        if (query.uncensored && model.capabilities.nsfw !== true) return false;
        return matchesSearch(model, query.search ?? '');
    });
    return sortModels(passing, query.sort ?? 'name');
}

/**
 * The model a studio starts with: the remembered one when it is still in the list, else the preferred id (any case) when the
 * list has it, else the cheapest, else the first by name. null for an empty list.
 */
export function defaultModel(
    models: readonly MediaModel[],
    options: { remembered?: string | null; preferred?: string; suitable?: (model: MediaModel) => boolean } = {},
): MediaModel | null {
    if (models.length === 0) return null;
    const remembered = options.remembered ? models.find((model) => model.id === options.remembered) : undefined;
    if (remembered) return remembered;
    const preferred = options.preferred?.toLowerCase();
    const wanted = preferred ? models.find((model) => model.id.toLowerCase() === preferred) : undefined;
    if (wanted) return wanted;
    // The cheapest model is often a tool that cannot start from a prompt (a cropper, an upscaler, a video reframer): prefer
    // the ones that can, and fall back to the whole list only when none qualifies.
    const fit = options.suitable ? models.filter(options.suitable) : [];
    const candidates = fit.length > 0 ? fit : models;
    // A price of 0 is how the list shows helper tools ("Image Model Recommender", a cropper): a real generator costs money.
    const paid = candidates.filter((model) => (model.price.from ?? 0) > 0);
    const pool = paid.length > 0 ? paid : candidates;
    const priced = sortModels(pool, 'price')[0];
    if (priced && Number.isFinite(priceRank(priced))) return priced;
    return sortModels(pool, 'name')[0] ?? null;
}

/** Whether a model can be the studio's first choice: it works from the user's own text (or recording) alone. */
export function startsFromPrompt(medium: Medium, model: MediaModel): boolean {
    if (medium === 'image') return model.capabilities.textToImage === true;
    if (medium === 'video') return model.capabilities.textToVideo === true;
    if (medium === 'stt') return model.capabilities.voiceCloning !== true;
    return true;
}
