import { describe, expect, it } from 'vitest';
import {
    defaultModel,
    isMusicModel,
    isSpeechModel,
    matchesSearch,
    priceRank,
    selectModels,
    sortModels,
} from '../../src/core/media-select';
import { mediaModel } from '../helpers/media-fake';

const price = (from: number | null) => ({ unit: 'image' as const, from, to: from, byKey: {}, raw: null });

const models = [
    mediaModel({ id: 'flux/dev', name: 'Flux Dev', medium: 'image', owner: 'flux', price: price(0.02), tags: ['4k'] }),
    mediaModel({
        id: 'pony-v9',
        name: 'Pony V9',
        medium: 'image',
        owner: 'community',
        price: price(0.0017),
        capabilities: { nsfw: true },
        tags: ['nsfw', 'lora'],
    }),
    mediaModel({ id: 'mystery', name: 'Mystery', medium: 'image', price: price(null) }),
    mediaModel({ id: 'alpha', name: 'alpha', medium: 'image', price: price(0.0017) }),
];

describe('search', () => {
    it('needs every word, in any field, in any case', () => {
        const flux = models[0]!;
        expect(matchesSearch(flux, '')).toBe(true);
        expect(matchesSearch(flux, '  ')).toBe(true);
        expect(matchesSearch(flux, 'FLUX dev')).toBe(true);
        expect(matchesSearch(flux, 'dev 4K')).toBe(true);
        expect(matchesSearch(flux, 'dev pony')).toBe(false);
    });

    it('looks at the description and the owner too', () => {
        const model = mediaModel({ id: 'm', medium: 'image', description: 'Photoreal portraits', owner: 'Acme' });
        expect(matchesSearch(model, 'portraits acme')).toBe(true);
    });
});

describe('sorting', () => {
    it('by name, case-insensitive, ties by id', () => {
        expect(sortModels(models, 'name').map((m) => m.id)).toEqual(['alpha', 'flux/dev', 'mystery', 'pony-v9']);
        const twins = [
            mediaModel({ id: 'b', name: 'Same', medium: 'image' }),
            mediaModel({ id: 'a', name: 'same', medium: 'image' }),
        ];
        expect(sortModels(twins, 'name').map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('by price, cheapest first, unknown prices last, equal prices by name', () => {
        expect(sortModels(models, 'price').map((m) => m.id)).toEqual(['alpha', 'pony-v9', 'flux/dev', 'mystery']);
        expect(priceRank(models[2]!)).toBe(Number.POSITIVE_INFINITY);
        expect(priceRank(models[0]!)).toBe(0.02);
    });

    it('does not change the list it is given', () => {
        const copy = [...models];
        sortModels(models, 'price');
        expect(models).toEqual(copy);
    });
});

describe('selectModels', () => {
    it('filters to the adult-capable models', () => {
        expect(selectModels(models, { uncensored: true }).map((m) => m.id)).toEqual(['pony-v9']);
    });

    it('combines search, filter and sort', () => {
        expect(selectModels(models, { search: 'v9', uncensored: true, sort: 'price' }).map((m) => m.id)).toEqual([
            'pony-v9',
        ]);
        expect(selectModels(models, { search: 'nothing' })).toEqual([]);
    });

    it('with no query: all models by name', () => {
        expect(selectModels(models).map((m) => m.id)).toEqual(['alpha', 'flux/dev', 'mystery', 'pony-v9']);
    });

    describe('the speech list that also holds music', () => {
        const tts = [
            mediaModel({ id: 'kokoro', name: 'Kokoro', medium: 'tts', capabilities: { voiceCloning: false } }),
            mediaModel({ id: 'suno', name: 'Suno', medium: 'tts', capabilities: { music: true } }),
            mediaModel({ id: 'eleven', name: 'Eleven', medium: 'tts' }),
        ];

        it('classifies by capabilities.music', () => {
            expect(tts.map(isSpeechModel)).toEqual([true, false, true]);
            expect(tts.map(isMusicModel)).toEqual([false, true, false]);
            expect(isSpeechModel(models[0]!)).toBe(false);
            expect(isMusicModel(models[0]!)).toBe(false);
        });

        it('offers speech by default, and music or both when asked', () => {
            expect(selectModels(tts).map((m) => m.id)).toEqual(['eleven', 'kokoro']);
            expect(selectModels(tts, { ttsKind: 'speech' }).map((m) => m.id)).toEqual(['eleven', 'kokoro']);
            expect(selectModels(tts, { ttsKind: 'music' }).map((m) => m.id)).toEqual(['suno']);
            expect(selectModels(tts, { ttsKind: 'all' }).map((m) => m.id)).toEqual(['eleven', 'kokoro', 'suno']);
        });

        it('ignores the kind for the other media', () => {
            expect(selectModels(models, { ttsKind: 'music' })).toHaveLength(4);
        });
    });
});

describe('defaultModel', () => {
    it('is null for an empty list', () => {
        expect(defaultModel([])).toBeNull();
    });

    it('keeps the remembered model while the list still has it', () => {
        expect(defaultModel(models, { remembered: 'flux/dev', preferred: 'alpha' })?.id).toBe('flux/dev');
    });

    it('takes the preferred id (any case) when nothing is remembered or the remembered one is gone', () => {
        expect(defaultModel(models, { preferred: 'PONY-V9' })?.id).toBe('pony-v9');
        expect(defaultModel(models, { remembered: 'gone', preferred: 'pony-v9' })?.id).toBe('pony-v9');
    });

    it('otherwise the cheapest, and the first by name when no price is known', () => {
        expect(defaultModel(models)?.id).toBe('alpha');
        const unpriced = [
            mediaModel({ id: 'b', name: 'B', medium: 'image', price: price(null) }),
            mediaModel({ id: 'a', name: 'A', medium: 'image', price: price(null) }),
        ];
        expect(defaultModel(unpriced)?.id).toBe('a');
    });
});
