// @vitest-environment happy-dom
// The «Media» tab: registration, the state banners, the catalog section and the way sections hand a model to a studio.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaFeature } from '../../src/features/media';
import { createSession } from '../../src/features/media/session';
import type { MediaSession } from '../../src/features/media/session';
import { MEDIA_STRINGS } from '../../src/features/media/strings';
import { renderMediaTab } from '../../src/features/media/view';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import { buttonNamed, check, choose, click, field, hasButton, settle, text, type } from '../helpers/media-dom';
import { mediaModel } from '../helpers/media-fake';

vi.mock('../../src/domain/media', () => ({
    normalizeMediaList: () => [],
    estimateImageCost: () => 0.0034,
    estimateVideoCost: () => 1.2,
    estimateTtsCost: () => 0.002,
    estimateSttCost: () => 0.00001,
    describePrice: () => '?',
}));

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let session: MediaSession;
let dispose: (() => void) | undefined;

const price = (unit: 'image' | 'second' | 'thousand_chars', from: number | null, to: number | null = from) => ({
    unit,
    from,
    to,
    byKey: {},
    raw: null,
});

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(MEDIA_STRINGS);
    tc.ctx.panel.open = vi.fn();
    const fake = tc.mediaFake;
    fake.catalogs.image = [
        mediaModel({
            id: 'flux/dev',
            name: 'Flux Dev',
            medium: 'image',
            owner: 'flux',
            category: 'Featured',
            price: price('image', 0.02),
            capabilities: { imageToImage: true },
            maxInputImages: 4,
            description: 'A fast model',
        }),
        mediaModel({
            id: 'pony-v9',
            name: 'Pony V9',
            medium: 'image',
            owner: 'community',
            price: price('image', 0.0017, 0.0051),
            capabilities: { nsfw: true },
            subscriptionIncluded: false,
        }),
        mediaModel({ id: 'mystery', name: 'Mystery', medium: 'image', price: price('image', null) }),
    ];
    fake.catalogs.tts = [
        mediaModel({
            id: 'Kokoro-82m',
            name: 'Kokoro',
            medium: 'tts',
            price: price('thousand_chars', 0.0017),
            voices: ['af_bella'],
        }),
        mediaModel({ id: 'suno', name: 'Suno', medium: 'tts', capabilities: { music: true } }),
    ];
    fake.catalogs.stt = [mediaModel({ id: 'asr', name: 'ASR', medium: 'stt', price: price('second', 0.00000333) })];
    fake.catalogs.video = [mediaModel({ id: 'veo3', name: 'Veo 3', medium: 'video', price: price('second', 0.4) })];
    root = document.createElement('div');
    document.body.appendChild(root);
    session = createSession();
});

afterEach(() => {
    dispose?.();
    dispose = undefined;
    root.remove();
    tc.media.dispose();
    vi.useRealTimers();
    h.restore();
});

async function open(): Promise<void> {
    await h.connections.refresh();
    dispose = renderMediaTab(root, tc.ctx, session);
    await settle();
}

const cards = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.nanovia-media-model')];
const cardNames = (): string[] =>
    cards().map((card) => card.querySelector('.nanovia-media-model-name')?.textContent ?? '');

describe('registration', () => {
    it('adds the tab «Media» (id media, order 380: after Management, before Account) and its strings', () => {
        const registered: { id: string; titleKey: string; order: number }[] = [];
        const i18nRegister = vi.spyOn(tc.ctx.i18n, 'register');
        const ctx = {
            ...tc.ctx,
            // ST's TTS module is not in this page: the provider integration quietly stays off.
            host: {
                ...tc.ctx.host,
                modules: { ...tc.ctx.host.modules, load: () => Promise.reject(new Error('no module')) },
            },
            panel: {
                registerTab: (tab: { id: string; titleKey: string; order: number }) => {
                    registered.push(tab);
                    return () => void registered.splice(0);
                },
            },
        } as unknown as typeof tc.ctx;
        const off = mediaFeature.init(ctx);
        expect(registered).toMatchObject([{ id: 'media', titleKey: 'media.tab', order: 380 }]);
        expect(i18nRegister).toHaveBeenCalledWith(MEDIA_STRINGS);
        expect(typeof off).toBe('function');
        if (typeof off === 'function') off();
        expect(registered).toEqual([]);
    });
});

describe('the head and the sections', () => {
    it('opens on the catalog with five sections and the integration note', async () => {
        await open();
        const sections = [...root.querySelectorAll<HTMLElement>('.nanovia-media-nav button')].map(
            (node) => node.dataset['section'],
        );
        expect(sections).toEqual(['catalog', 'image', 'tts', 'stt', 'video']);
        expect(root.querySelector('.nanovia-media-nav .nanovia-chip-active')?.textContent).toBe('Catalog');
        expect(root.querySelector('[data-integration]')?.getAttribute('data-integration')).toBe('pending');
    });

    it('switching sections shows the studio and remembers the section in the session', async () => {
        await open();
        await click(root, 'Image');
        expect(session.section).toBe('image');
        expect(field(root, 'Prompt')).toBeTruthy();
        await click(root, 'Catalog');
        expect(root.querySelector('.nanovia-media-catalog')).not.toBeNull();
    });

    it('a second opening of the tab starts on the section that was open', async () => {
        await open();
        await click(root, 'Speech');
        dispose?.();
        root.textContent = '';
        dispose = renderMediaTab(root, tc.ctx, session);
        await settle();
        expect(root.querySelector('.nanovia-media-nav .nanovia-chip-active')?.textContent).toBe('Speech');
    });

    it('the integration note follows what the registration said', async () => {
        await open();
        session.setIntegration('active');
        expect(text(root)).toContain('The «Nanovia» provider is registered');
        expect(root.querySelector('[data-integration="active"]')).not.toBeNull();
        session.setIntegration('unavailable', 'ST’s TTS extension is switched off');
        expect(text(root)).toContain('ST integration off');
        expect(text(root)).toContain('switched off');
        session.setIntegration('failed', 'boom');
        expect(text(root)).toContain('ST integration failed');
        expect(text(root)).toContain('boom');
    });

    it('stops listening to the stores when the tab is closed', async () => {
        await open();
        dispose?.();
        dispose = undefined;
        const before = root.innerHTML;
        session.setIntegration('active');
        await tc.media.ensure('image', { refresh: true });
        expect(root.innerHTML).toBe(before);
    });
});

describe('state banners', () => {
    it('no plugin: explains that media needs it, and there is nothing to press in the studios', async () => {
        h.backend.plugin.installed = false;
        await open();
        expect(text(root)).toContain('Needs the plugin');
        expect(text(root)).toContain('Media is called by the Nanovia server plugin');
        await click(root, 'Image');
        expect(hasButton(root, 'Generate')).toBe(false);
        expect(text(root)).toContain('Try again');
    });

    it('a plugin that goes away after the page was drawn: the studio’s button is switched off', async () => {
        await open();
        await click(root, 'Image');
        expect(buttonNamed(root, 'Generate').disabled).toBe(false);
        h.backend.plugin.up = false;
        await click(root, 'Refresh');
        expect(text(root)).toContain('The plugin is not answering');
        expect(buttonNamed(root, 'Generate').disabled).toBe(true);
        h.backend.plugin.up = true;
        await click(root, 'Refresh');
        expect(buttonNamed(root, 'Generate').disabled).toBe(false);
    });

    it('a plugin without the media routes (an older one): "update the plugin"', async () => {
        tc.mediaFake.hasRoutes = false;
        await open();
        expect(text(root)).toContain('The plugin is too old');
        expect(text(root)).toContain('Update the plugin');
        expect(text(root)).not.toContain('Needs the plugin');
    });

    it('a plugin that stops answering', async () => {
        await open();
        h.backend.plugin.up = false;
        await click(root, 'Refresh');
        expect(text(root)).toContain('The plugin is not answering');
    });

    it('no key: a banner with a way to the Keys tab, and the page keeps working', async () => {
        await open();
        tc.mediaFake.hasKey = false;
        await click(root, 'Image');
        type(root, 'Prompt', 'a cat');
        await click(root, 'Generate');
        expect(text(root)).toContain('No NanoGPT key');
        expect(text(root)).toContain('The plugin has no NanoGPT key to call with');
        expect(buttonNamed(root, 'Generate').disabled).toBe(false);
        await click(root, 'Open the Keys tab');
        expect(tc.ctx.panel.open).toHaveBeenCalledWith('keys');
    });

    it('the banner goes away when the plugin is back', async () => {
        h.backend.plugin.up = false;
        await open();
        expect(text(root)).toContain('The plugin is not answering');
        h.backend.plugin.up = true;
        await click(root, 'Refresh');
        expect(text(root)).not.toContain('The plugin is not answering');
        expect(cards()).toHaveLength(3);
    });
});

describe('the catalog section', () => {
    it('lists the models of the first medium with name, owner, category, price and capabilities', async () => {
        await open();
        expect(cardNames()).toEqual(['Flux Dev', 'Mystery', 'Pony V9']);
        const flux = cards()[0]!;
        expect(flux.textContent).toContain('flux');
        expect(flux.textContent).toContain('Featured');
        expect(flux.textContent).toContain('$0.02 / image');
        expect(flux.textContent).toContain('img2img');
        expect(flux.textContent).toContain('A fast model');
        expect(flux.querySelector('code')?.textContent).toBe('flux/dev');
        const pony = cards()[2]!;
        expect(pony.textContent).toContain('$0.0017–$0.0051 / image');
        expect(pony.textContent).toContain('NSFW');
        expect(pony.textContent).toContain('not in subscription');
        expect(cards()[1]!.textContent).toContain('price unknown');
        expect(text(root)).toContain('3 of 3 models');
    });

    it('searches by any word of a model', async () => {
        await open();
        type(root, 'Search models', 'community');
        expect(cardNames()).toEqual(['Pony V9']);
        type(root, 'Search models', 'nothing like this');
        expect(cardNames()).toEqual([]);
        expect(text(root)).toContain('No model matches the filters');
        type(root, 'Search models', '');
        expect(cards()).toHaveLength(3);
    });

    it('filters to the adult-capable models and sorts cheapest first', async () => {
        await open();
        check(root, 'Adult-capable only', true);
        expect(cardNames()).toEqual(['Pony V9']);
        check(root, 'Adult-capable only', false);
        choose(root, 'Sort', 'price');
        expect(cardNames()).toEqual(['Pony V9', 'Flux Dev', 'Mystery']);
    });

    it('switches between the four media', async () => {
        await open();
        const switcher = root.querySelector('.nanovia-media-switcher')!;
        expect([...switcher.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
            'Image',
            'Video',
            'Speech',
            'Transcription',
        ]);
        await click(switcher, 'Video');
        expect(cardNames()).toEqual(['Veo 3']);
        expect(cards()[0]!.textContent).toContain('$0.40 / second');
        await click(switcher, 'Transcription');
        expect(cardNames()).toEqual(['ASR']);
        expect(cards()[0]!.textContent).toContain('$0.00000333 / second');
        expect(tc.mediaFake.callsTo('GET /media/catalog').map((call) => call.path)).toEqual([
            '/media/catalog?medium=image',
            '/media/catalog?medium=video',
            '/media/catalog?medium=stt',
        ]);
    });

    it('speech models first; music models are a filter away', async () => {
        await open();
        await click(root.querySelector('.nanovia-media-switcher')!, 'Speech');
        expect(cardNames()).toEqual(['Kokoro']);
        choose(root, 'Kind', 'music');
        expect(cardNames()).toEqual(['Suno']);
        expect(cards()[0]!.textContent).toContain('music');
        choose(root, 'Kind', 'all');
        expect(cardNames()).toEqual(['Kokoro', 'Suno']);
    });

    it('draws a long list a page at a time', async () => {
        tc.mediaFake.catalogs.image = Array.from({ length: 120 }, (_, index) =>
            mediaModel({
                id: `m${String(index).padStart(3, '0')}`,
                name: `Model ${String(index).padStart(3, '0')}`,
                medium: 'image',
            }),
        );
        await open();
        expect(cards()).toHaveLength(50);
        expect(text(root)).toContain('120 of 120 models');
        await click(root, 'Show 50 more');
        expect(cards()).toHaveLength(100);
        await click(root, 'Show 20 more');
        expect(cards()).toHaveLength(120);
        expect(hasButton(root, 'Show 20 more')).toBe(false);
    });

    it('says when the list is an older copy', async () => {
        tc.mediaFake.source = 'stale';
        await open();
        expect(text(root)).toContain('an older copy');
    });

    it('a failed load says why and offers a retry that works', async () => {
        tc.mediaFake.fail.set('GET /media/catalog', { status: 502, code: 'media_unavailable', message: 'no data' });
        await open();
        expect(cards()).toHaveLength(0);
        expect(text(root)).toContain('The model list cannot be had');
        tc.mediaFake.fail.clear();
        await click(root, 'Try again');
        expect(cards()).toHaveLength(3);
    });

    it('an empty list from NanoGPT is said, not left blank', async () => {
        tc.mediaFake.catalogs.image = [];
        await open();
        expect(text(root)).toContain('NanoGPT’s list is empty');
    });

    it('reloads the list on demand', async () => {
        await open();
        tc.mediaFake.catalogs.image = [mediaModel({ id: 'new', name: 'Newcomer', medium: 'image' })];
        await click(root, 'Reload list');
        expect(cardNames()).toEqual(['Newcomer']);
        expect(tc.mediaFake.callsTo('GET /media/catalog').at(-1)?.path).toBe('/media/catalog?medium=image&refresh=1');
    });

    it('«Use» opens the studio of the medium with that model chosen', async () => {
        await open();
        await click(cards()[2]!, 'Use');
        expect(session.section).toBe('image');
        expect(session.image.model).toBe('pony-v9');
        expect(root.querySelector<HTMLSelectElement>('.nanovia-media-picker-select select')?.value).toBe('pony-v9');
        expect(text(root)).toContain('Pony V9');
    });

    it('«Use» on a speech model opens the speech studio, on a video model the video studio', async () => {
        await open();
        await click(root.querySelector('.nanovia-media-switcher')!, 'Video');
        await click(cards()[0]!, 'Use');
        expect(session.section).toBe('video');
        expect(session.video.model).toBe('veo3');
        await click(root, 'Catalog');
        await click(root.querySelector('.nanovia-media-switcher')!, 'Speech');
        await click(cards()[0]!, 'Use');
        expect(session.section).toBe('tts');
        expect(session.tts.model).toBe('Kokoro-82m');
    });

    it('keeps the filters while the tab is closed and opened again', async () => {
        await open();
        type(root, 'Search models', 'pony');
        dispose?.();
        root.textContent = '';
        dispose = renderMediaTab(root, tc.ctx, session);
        await settle();
        expect(field<HTMLInputElement>(root, 'Search models').value).toBe('pony');
        expect(cardNames()).toEqual(['Pony V9']);
    });
});
