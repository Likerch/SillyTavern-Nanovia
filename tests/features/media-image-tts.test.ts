// @vitest-environment happy-dom
// The image studio and the speech studio of the «Media» tab (and the endpoint hint for ST's «OpenAI Compatible» provider).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateImageCost, estimateTtsCost } from '../../src/domain/media';
import { createSession } from '../../src/features/media/session';
import type { MediaSession } from '../../src/features/media/session';
import { MEDIA_STRINGS } from '../../src/features/media/strings';
import { renderMediaTab } from '../../src/features/media/view';
import type { ParamSpec } from '../../src/shared/contracts-media';
import { usageRecord } from '../helpers/account-fake';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { seedConnection } from '../helpers/fake-backend';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import {
    buttonNamed,
    choose,
    click,
    field,
    fileOf,
    hasButton,
    hasField,
    pickFile,
    settle,
    text,
    type,
} from '../helpers/media-dom';
import { PNG_BASE64, WAV_BASE64, costOf, mediaModel } from '../helpers/media-fake';

vi.mock('../../src/domain/media', () => ({
    normalizeMediaList: vi.fn(() => []),
    estimateImageCost: vi.fn(() => 0.0034),
    estimateVideoCost: vi.fn(() => 1.2),
    estimateTtsCost: vi.fn(() => 0.002),
    estimateSttCost: vi.fn(() => 0.00001),
    describePrice: vi.fn(() => '?'),
}));

let h: Harness;
let tc: TestContext;
let root: HTMLElement;
let session: MediaSession;
let dispose: (() => void) | undefined;

const enumSpec = (key: string, values: string[], fallback?: string): ParamSpec => ({
    key,
    type: 'enum',
    values,
    ...(fallback !== undefined ? { default: fallback } : {}),
});
const price = (unit: 'image' | 'thousand_chars', from: number) => ({ unit, from, to: from, byKey: {}, raw: null });

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(MEDIA_STRINGS);
    vi.mocked(estimateImageCost).mockClear();
    vi.mocked(estimateTtsCost).mockClear();
    tc.mediaFake.catalogs.image = [
        mediaModel({
            id: 'flux',
            name: 'Flux',
            medium: 'image',
            price: price('image', 0.0017),
            maxInputImages: 2,
            capabilities: { imageToImage: true },
            subscriptionIncluded: true,
            params: [
                enumSpec('size', ['512x512', '1024x1024'], '1024x1024'),
                enumSpec('aspect_ratio', ['1:1', '16:9']),
                { key: 'negative_prompt', type: 'boolean' },
                { key: 'max_images', type: 'integer', max: 4 },
                { key: 'seed', type: 'integer', min: 0, max: 99 },
                { key: 'steps', type: 'range', min: 1, max: 50 },
                { key: 'guidance', type: 'range', min: 0, max: 20 },
            ],
        }),
        mediaModel({ id: 'free', name: 'Free size', medium: 'image', params: [{ key: 'size', type: 'text' }] }),
        mediaModel({ id: 'bare', name: 'Bare', medium: 'image', price: price('image', 0.0001) }),
    ];
    tc.mediaFake.catalogs.tts = [
        mediaModel({
            id: 'Kokoro-82m',
            name: 'Kokoro',
            medium: 'tts',
            price: price('thousand_chars', 0.0017),
            voices: ['af_bella', 'am_adam'],
        }),
        mediaModel({
            id: 'gpt-4o-mini-tts',
            name: 'GPT mini',
            medium: 'tts',
            voices: ['alloy'],
            params: [
                { key: 'instructions', type: 'text' },
                { key: 'speed', type: 'range', min: 0.5, max: 2 },
            ],
        }),
        mediaModel({ id: 'novoice', name: 'No voices', medium: 'tts' }),
        mediaModel({ id: 'suno', name: 'Suno', medium: 'tts', capabilities: { music: true } }),
    ];
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

async function open(section: 'image' | 'tts'): Promise<void> {
    session.section = section;
    await h.connections.refresh();
    dispose = renderMediaTab(root, tc.ctx, session);
    await settle();
}

const lastBody = (route: string): Record<string, unknown> =>
    (tc.mediaFake.callsTo(route).at(-1)?.body ?? {}) as Record<string, unknown>;
const pickModel = (id: string): void => choose(root, 'Model', id);

describe('image studio: the form follows the model', () => {
    it('starts on the cheapest model and shows the fields that model lists', async () => {
        await open('image');
        expect(field<HTMLSelectElement>(root, 'Model').value).toBe('bare');
        expect(hasField(root, 'Prompt')).toBe(true);
        expect(hasField(root, 'Negative prompt')).toBe(false);
        expect(hasField(root, 'Size')).toBe(false);
        expect(hasField(root, 'Seed')).toBe(false);
        expect(hasField(root, 'Images')).toBe(true);
        expect(root.querySelector('input[type="file"]')).toBeNull();
    });

    it('a model with parameters gets them: choices, bounded numbers and a reference upload', async () => {
        await open('image');
        pickModel('flux');
        await settle();
        expect(session.image.model).toBe('flux');
        expect([...field<HTMLSelectElement>(root, 'Size').options].map((o) => o.value)).toEqual([
            '512x512',
            '1024x1024',
        ]);
        expect(field<HTMLSelectElement>(root, 'Size').value).toBe('1024x1024');
        expect([...field<HTMLSelectElement>(root, 'Aspect ratio').options].map((o) => o.value)).toEqual([
            '1:1',
            '16:9',
        ]);
        for (const label of ['Negative prompt', 'Seed', 'Steps', 'Guidance'])
            expect(hasField(root, label), label).toBe(true);
        expect(text(root)).toContain('from 0 to 99');
        expect(text(root)).toContain('From 1 to 4 images in one call.');
        expect(root.querySelector('input[type="file"]')).not.toBeNull();
        expect(text(root)).toContain('Up to 2 images');
    });

    it('a size the list gives as free text is a WxH box that is checked', async () => {
        await open('image');
        pickModel('free');
        await settle();
        const size = field<HTMLInputElement>(root, 'Size');
        expect(size.placeholder).toBe('1024x1024');
        type(root, 'Prompt', 'a cat');
        type(root, 'Size', 'big');
        await click(root, 'Generate');
        expect(text(root)).toContain('The size must look like 1024x1024.');
        expect(tc.mediaFake.callsTo('POST /media/image')).toHaveLength(0);
        type(root, 'Size', '640x480');
        await click(root, 'Generate');
        expect(lastBody('POST /media/image')).toMatchObject({ model: 'free', size: '640x480' });
    });

    it('shows what the model costs, and an estimate before the call from the form', async () => {
        await open('image');
        pickModel('flux');
        await settle();
        expect(text(root)).toContain('$0.0017 / image');
        expect(text(root)).toContain('in subscription');
        expect(text(root)).toContain('Estimated cost: $0.0034');
        expect(text(root)).toContain('the subscription’s quota may cover it');
        type(root, 'Images', '3');
        choose(root, 'Size', '512x512');
        expect(estimateImageCost).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'flux' }), {
            n: 3,
            size: '512x512',
        });
    });

    it('an estimate that cannot be computed says so instead of showing zero', async () => {
        vi.mocked(estimateImageCost).mockReturnValueOnce(null);
        await open('image');
        expect(text(root)).toContain('cannot be estimated');
    });
});

describe('image studio: generating', () => {
    it('sends only what the form holds, and shows the picture, a download button and the cost with its source', async () => {
        tc.mediaFake.cost = costOf({ usd: 0.0017, source: 'response', estimateUsd: 0.0034 });
        await open('image');
        pickModel('flux');
        await settle();
        type(root, 'Prompt', ' a cat in a hat ');
        type(root, 'Negative prompt', 'blurry');
        choose(root, 'Size', '512x512');
        type(root, 'Images', '2');
        type(root, 'Seed', '42');
        await click(root, 'Generate');
        expect(lastBody('POST /media/image')).toEqual({
            model: 'flux',
            prompt: 'a cat in a hat',
            negativePrompt: 'blurry',
            n: 2,
            size: '512x512',
            aspectRatio: '1:1',
            seed: 42,
        });
        const images = [...root.querySelectorAll<HTMLImageElement>('.nanovia-media-image')];
        expect(images).toHaveLength(2);
        expect(images[0]?.src).toBe(`data:image/png;base64,${PNG_BASE64}`);
        const download = root.querySelector<HTMLAnchorElement>('figure a');
        expect(download?.getAttribute('download')).toBe('nanovia-flux-1.png');
        expect(download?.textContent).toBe('Download');
        // The figure of the response is shown as exactly that: a list price that can understate the charge.
        const cost = root.querySelector('.nanovia-media-cost')!;
        expect(cost.textContent).toContain('$0.0017');
        expect(cost.textContent).toContain('NanoGPT’s figure');
        expect(cost.textContent).toContain('Estimated before the call: $0.0034');
        expect(cost.textContent).toContain('can understate'.slice(0, 0) + 'list-price');
        expect(cost.textContent).toContain('billed (confirmed)');
        expect(cost.getAttribute('data-source')).toBe('response');
        expect(text(root)).toContain('took 4.2 s');
        // The plugin already wrote the record: the browser only reads the usage again.
        expect(tc.fake.callsTo('GET /spend').length).toBeGreaterThan(0);
    });

    it('nothing is sent for a draft that does not hold up, and each problem is said', async () => {
        await open('image');
        pickModel('flux');
        await settle();
        type(root, 'Images', '9');
        type(root, 'Seed', 'abc');
        await click(root, 'Generate');
        expect(tc.mediaFake.callsTo('POST /media/image')).toHaveLength(0);
        const body = text(root);
        expect(body).toContain('Write a prompt first.');
        expect(body).toContain('The number of images must be a whole number from 1 to 4.');
        expect(body).toContain('Seed: a number is expected.');
    });

    it('the button is off while the call runs, and the busy line says so', async () => {
        await open('image');
        let finish: (value: Awaited<ReturnType<typeof tc.mediaFake.media.image>>) => void = () => {};
        vi.spyOn(tc.mediaFake.media, 'image').mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        type(root, 'Prompt', 'a cat');
        buttonNamed(root, 'Generate').click();
        await settle();
        expect(buttonNamed(root, 'Generate').disabled).toBe(true);
        expect(text(root)).toContain('Generating…');
        buttonNamed(root, 'Generate').click();
        expect(vi.mocked(tc.mediaFake.media.image)).toHaveBeenCalledTimes(1);
        finish({
            ok: true,
            data: {
                model: 'bare',
                outputs: [{ kind: 'image', mime: 'image/png', dataBase64: PNG_BASE64 }],
                requestId: null,
                cost: costOf(),
                latencyMs: 100,
            },
        });
        await settle();
        expect(buttonNamed(root, 'Generate').disabled).toBe(false);
        expect(text(root)).not.toContain('Generating…');
        expect(root.querySelectorAll('.nanovia-media-image')).toHaveLength(1);
    });

    it('an output NanoGPT gave as a link is shown from that link and opened, not downloaded', async () => {
        tc.mediaFake.imageResult = () => ({
            model: 'bare',
            outputs: [{ kind: 'image', mime: 'image/png', url: 'https://cdn.example.test/a.png' }],
            requestId: null,
            cost: costOf(),
            latencyMs: 10,
        });
        await open('image');
        type(root, 'Prompt', 'a cat');
        await click(root, 'Generate');
        expect(root.querySelector<HTMLImageElement>('.nanovia-media-image')?.src).toBe(
            'https://cdn.example.test/a.png',
        );
        expect(root.querySelector('figure a')?.textContent).toBe('Open');
        expect(root.querySelector('figure a')?.getAttribute('target')).toBe('_blank');
    });

    it('«Clear» forgets the result', async () => {
        await open('image');
        type(root, 'Prompt', 'a cat');
        await click(root, 'Generate');
        expect(root.querySelector('.nanovia-media-image')).not.toBeNull();
        await click(root, 'Clear');
        expect(root.querySelector('.nanovia-media-image')).toBeNull();
        expect(tc.media.last().image).toBeNull();
    });

    it('keeps the form while another section is open', async () => {
        await open('image');
        pickModel('flux');
        await settle();
        type(root, 'Prompt', 'a cat in a hat');
        await click(root, 'Speech');
        await click(root, 'Image');
        expect(field<HTMLTextAreaElement>(root, 'Prompt').value).toBe('a cat in a hat');
        expect(field<HTMLSelectElement>(root, 'Model').value).toBe('flux');
    });
});

describe('image studio: when the call fails', () => {
    const generate = async (): Promise<void> => {
        await open('image');
        type(root, 'Prompt', 'a cat');
        await click(root, 'Generate');
    };

    it('insufficient balance shows the amount NanoGPT named', async () => {
        tc.mediaFake.fail.set('POST /media/image', {
            status: 402,
            code: 'insufficient_balance',
            message: 'required: 0.25',
        });
        await generate();
        expect(text(root)).toContain('The NanoGPT balance is too low for this call: it needs $0.25.');
        expect(root.querySelector('.nanovia-media-image')).toBeNull();
    });

    it('a content-policy block says it is not charged', async () => {
        tc.mediaFake.fail.set('POST /media/image', {
            status: 400,
            code: 'content_policy_violation',
            message: 'blocked',
        });
        await generate();
        expect(text(root)).toContain('NanoGPT blocked the prompt (content policy). The request is not charged.');
    });

    it('rate limiting', async () => {
        tc.mediaFake.fail.set('POST /media/image', { status: 429, code: 'rate_limited' });
        await generate();
        expect(text(root)).toContain('NanoGPT is limiting requests. Try again in a minute.');
    });

    it('a timeout warns that the call may still have been charged', async () => {
        tc.mediaFake.fail.set('POST /media/image', { status: 504, code: 'upstream_timeout' });
        await generate();
        expect(text(root)).toContain('No answer in time.');
        expect(text(root)).toContain('may still have been completed and charged');
    });

    it('NanoGPT’s own refusal is passed on, and an input over 4 MB is named', async () => {
        tc.mediaFake.fail.set('POST /media/image', {
            status: 502,
            code: 'upstream_error',
            message: 'model overloaded',
        });
        await generate();
        expect(text(root)).toContain('NanoGPT refused or failed the call: model overloaded');
        tc.mediaFake.fail.set('POST /media/image', { status: 413, code: 'payload_too_large' });
        await click(root, 'Generate');
        expect(text(root)).toContain('over the 4 MB NanoGPT accepts');
        expect(text(root)).not.toContain('model overloaded');
    });

    it('never shows a key', async () => {
        tc.mediaFake.fail.set('POST /media/image', { status: 502, code: 'upstream_error', message: 'bad request' });
        await generate();
        expect(root.innerHTML).not.toMatch(/sk-nano/);
    });
});

describe('image studio: reference images', () => {
    const referenceInput = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[type="file"]')!;

    async function openFlux(): Promise<void> {
        await open('image');
        pickModel('flux');
        await settle();
    }

    it('takes an image, shows it, and sends it as a data URL', async () => {
        await openFlux();
        pickFile(referenceInput(), fileOf('ref.png', 'image/png', 1000));
        await settle();
        expect(root.querySelector('.nanovia-media-ref')?.textContent).toContain('ref.png');
        type(root, 'Prompt', 'a cat');
        await click(root, 'Generate');
        const sent = lastBody('POST /media/image')['inputImages'] as string[];
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatch(/^data:image\/png;base64,/);
    });

    it('refuses an image over 4 MB after encoding, and a file that is not an image', async () => {
        await openFlux();
        // 3.2 MB of file is 4.27 MB once encoded.
        pickFile(referenceInput(), fileOf('big.png', 'image/png', 3_200_000));
        await settle(8);
        expect(text(root)).toContain('big.png is over 4 MB after encoding');
        expect(root.querySelector('.nanovia-media-ref')).toBeNull();
        pickFile(referenceInput(), fileOf('notes.txt', 'text/plain', 100));
        await settle();
        expect(text(root)).toContain('notes.txt is not an image');
        expect(root.querySelector('.nanovia-media-ref')).toBeNull();
    });

    it('takes no more images than the model does, and an image can be taken out again', async () => {
        await openFlux();
        for (const name of ['a.png', 'b.png', 'c.png']) {
            pickFile(referenceInput(), fileOf(name, 'image/png', 100));
            await settle();
        }
        expect(root.querySelectorAll('.nanovia-media-ref')).toHaveLength(2);
        expect(text(root)).toContain('This model takes at most 2 reference images.');
        await click(root.querySelector('.nanovia-media-ref')!, '');
        expect(root.querySelectorAll('.nanovia-media-ref')).toHaveLength(1);
    });

    it('drops the references when the model is changed to one that takes none', async () => {
        await openFlux();
        pickFile(referenceInput(), fileOf('a.png', 'image/png', 100));
        await settle();
        pickModel('bare');
        await settle();
        expect(root.querySelector('input[type="file"]')).toBeNull();
        expect(session.image.references).toEqual([]);
    });
});

describe('image studio: the real cost arrives a little later', () => {
    it('turns the list-price figure into the confirmed one from the plugin’s records', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        tc.mediaFake.cost = costOf({ usd: 0.0017, source: 'response' });
        const advance = async (ms: number): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms));
        session.section = 'image';
        await h.connections.refresh();
        dispose = renderMediaTab(root, tc.ctx, session);
        await advance(0);
        type(root, 'Prompt', 'a cat');
        buttonNamed(root, 'Generate').click();
        await advance(50);
        const requestId = tc.media.last().image?.requestId ?? '';
        expect(root.querySelector('.nanovia-media-cost')?.getAttribute('data-source')).toBe('response');

        tc.fake.records.push(
            usageRecord({
                at: Date.now(),
                requestId,
                medium: 'image',
                model: 'bare',
                units: 1,
                costUsd: 0.00255,
                costSource: 'lookup',
            }),
        );
        await advance(21_000);
        const cost = root.querySelector('.nanovia-media-cost')!;
        expect(cost.getAttribute('data-source')).toBe('lookup');
        expect(cost.textContent).toContain('$0.00255');
        expect(cost.textContent).toContain('billed (confirmed)');
        // The picture was not drawn again for a cost that changed.
        expect(root.querySelectorAll('.nanovia-media-image')).toHaveLength(1);
        // The usage list the Account tab shows learnt the corrected figure too.
        expect(tc.usage.recent().find((record) => record.requestId === requestId)).toMatchObject({
            costUsd: 0.00255,
            costSource: 'lookup',
        });
    });
});

describe('speech studio', () => {
    it('offers speech models only (the music ones are left out), starting on Kokoro', async () => {
        await open('tts');
        const options = [...field<HTMLSelectElement>(root, 'Model').options].map((o) => o.value).sort();
        expect(options).toEqual(['Kokoro-82m', 'gpt-4o-mini-tts', 'novoice']);
        expect(field<HTMLSelectElement>(root, 'Model').value).toBe('Kokoro-82m');
    });

    it('the voice comes from the model’s own list, or is typed when the list is empty', async () => {
        await open('tts');
        expect([...field<HTMLSelectElement>(root, 'Voice').options].map((o) => o.value)).toEqual([
            'af_bella',
            'am_adam',
        ]);
        pickModel('novoice');
        await settle();
        expect(field<HTMLInputElement>(root, 'Voice').tagName).toBe('INPUT');
        expect(text(root)).toContain('names no voices');
    });

    it('style instructions only for a model that lists them; speed always, flagged when unlisted', async () => {
        await open('tts');
        expect(hasField(root, 'Style instructions')).toBe(false);
        expect(text(root)).toContain('does not mention speed');
        pickModel('gpt-4o-mini-tts');
        await settle();
        expect(hasField(root, 'Style instructions')).toBe(true);
        expect(text(root)).toContain('from 0.5 to 2');
        expect(text(root)).not.toContain('does not mention speed');
    });

    it('estimates from the characters typed, before the call', async () => {
        await open('tts');
        expect(text(root)).toContain('cannot be estimated');
        type(root, 'Text', 'Hello there, friend.');
        expect(text(root)).toContain('Estimated cost: $0.002');
        expect(estimateTtsCost).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'Kokoro-82m' }), 20);
        expect(text(root)).toContain('20 characters');
    });

    it('speaks: sends the voice, plays the audio with the real content type, offers it for download', async () => {
        await open('tts');
        type(root, 'Text', 'Hello there, friend.');
        choose(root, 'Voice', 'am_adam');
        await click(root, 'Speak');
        expect(lastBody('POST /media/tts')).toEqual({
            model: 'Kokoro-82m',
            input: 'Hello there, friend.',
            voice: 'am_adam',
        });
        const audio = root.querySelector<HTMLAudioElement>('audio');
        expect(audio?.getAttribute('src')).toBe(`data:audio/x-wav;base64,${WAV_BASE64}`);
        expect(audio?.hasAttribute('controls')).toBe(true);
        expect(root.querySelector('.nanovia-media-player a')?.getAttribute('download')).toBe(
            'nanovia-Kokoro-82m-1.wav',
        );
        // The format that was asked for is not the one that came back: the page shows the one that did.
        expect(text(root)).toContain('audio/x-wav');
        expect(text(root)).toContain('20 characters billed');
        const cost = root.querySelector('.nanovia-media-cost')!;
        expect(cost.getAttribute('data-source')).toBe('estimate');
        expect(cost.textContent).toContain('$0.000034');
        expect(cost.textContent).toContain('Computed from the catalog price');
    });

    it('sends speed and instructions only when they differ from the defaults and the model lists them', async () => {
        await open('tts');
        pickModel('gpt-4o-mini-tts');
        await settle();
        type(root, 'Text', 'Hi');
        type(root, 'Speed', '1,5');
        type(root, 'Style instructions', 'whisper');
        await click(root, 'Speak');
        expect(lastBody('POST /media/tts')).toEqual({
            model: 'gpt-4o-mini-tts',
            input: 'Hi',
            voice: 'alloy',
            speed: 1.5,
            instructions: 'whisper',
        });
    });

    it('wants text, and a speed in range', async () => {
        await open('tts');
        await click(root, 'Speak');
        expect(text(root)).toContain('Type the text to speak first.');
        type(root, 'Text', 'Hi');
        type(root, 'Speed', '9');
        await click(root, 'Speak');
        expect(text(root)).toContain('Speed is outside the range this model accepts.');
        expect(tc.mediaFake.callsTo('POST /media/tts')).toHaveLength(0);
    });

    it('says why a call failed', async () => {
        await open('tts');
        type(root, 'Text', 'Hi');
        tc.mediaFake.fail.set('POST /media/tts', { status: 402, code: 'insufficient_balance', message: 'needs 0.01' });
        await click(root, 'Speak');
        expect(text(root)).toContain('it needs $0.01');
        expect(root.querySelector('audio')).toBeNull();
    });
});

describe('speech studio: ST’s «OpenAI Compatible» provider as the second option', () => {
    it('without a connection it says there is none to point at', async () => {
        await open('tts');
        expect(text(root)).toContain('No connection has a proxy URL yet');
    });

    it('shows the endpoint of a connection and says its key field needs the token that Nanovia cannot show', async () => {
        const config = seedConnection(h.backend, { name: 'Main', modelId: 'vendor/model' }, 'main000001');
        await open('tts');
        const url = field<HTMLInputElement>(root, 'Provider endpoint');
        expect(url.value).toBe('http://127.0.0.1:8787/c/main000001/v1/audio/speech');
        expect(url.readOnly).toBe(true);
        const note = text(root);
        expect(note).toContain('recommended way');
        expect(note).toContain('connection’s own token');
        expect(note).toContain('Nanovia cannot show it');
        expect(config.id).toBe('main000001');
        expect(root.innerHTML).not.toMatch(/token-main000001/);
    });

    it('chooses among several connections', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'vendor/model' }, 'main000001');
        seedConnection(h.backend, { name: 'Second', modelId: 'vendor/model' }, 'seco000002');
        await open('tts');
        choose(root, 'Connection', 'seco000002');
        expect(field<HTMLInputElement>(root, 'Provider endpoint').value).toBe(
            'http://127.0.0.1:8787/c/seco000002/v1/audio/speech',
        );
    });

    it('the copy button copies the URL', async () => {
        seedConnection(h.backend, { name: 'Main', modelId: 'vendor/model' }, 'main000001');
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        try {
            await open('tts');
            expect(hasButton(root, 'Copy')).toBe(true);
            await click(root, 'Copy');
            expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:8787/c/main000001/v1/audio/speech');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
