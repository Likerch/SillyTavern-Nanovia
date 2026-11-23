// @vitest-environment happy-dom
// The transcription studio (microphone, files, transcript) and the video studio (form, jobs, polling, player).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateSttCost, estimateVideoCost } from '../../src/domain/media';
import type { RecordedAudio, RecorderHandle } from '../../src/host/recorder';
import { MAX_UPLOAD_BYTES } from '../../src/features/media/param-form';
import { createSession } from '../../src/features/media/session';
import type { MediaSession } from '../../src/features/media/session';
import { MEDIA_STRINGS } from '../../src/features/media/strings';
import { renderMediaTab } from '../../src/features/media/view';
import type { TabHooks } from '../../src/features/media/controls';
import type { ParamSpec } from '../../src/shared/contracts-media';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';
import {
    buttonNamed,
    check,
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
import { POPUP_RESULT } from '../helpers/st-mock';
import { PNG_BASE64, costOf, mediaModel } from '../helpers/media-fake';

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
let hooks: TabHooks;

const enumSpec = (key: string, values: string[], fallback?: string): ParamSpec => ({
    key,
    type: 'enum',
    values,
    ...(fallback !== undefined ? { default: fallback } : {}),
});

beforeEach(() => {
    h = createHarness();
    tc = createContext(h);
    tc.ctx.i18n.register(MEDIA_STRINGS);
    vi.mocked(estimateSttCost).mockClear();
    vi.mocked(estimateVideoCost).mockClear();
    tc.mediaFake.catalogs.stt = [
        mediaModel({
            id: 'asr',
            name: 'ASR',
            medium: 'stt',
            price: { unit: 'second', from: 0.0000033, to: 0.0000033, byKey: {}, raw: null },
        }),
        mediaModel({ id: 'speakers', name: 'Speakers', medium: 'stt', capabilities: { diarization: true } }),
    ];
    tc.mediaFake.catalogs.video = [
        mediaModel({
            id: 'veo3',
            name: 'Veo 3',
            medium: 'video',
            price: { unit: 'second', from: 0.4, to: 0.4, byKey: {}, raw: null },
            capabilities: { imageToVideo: true },
            priceIsApproximate: true,
            params: [
                enumSpec('duration', ['5s', '8s'], '8s'),
                enumSpec('aspect_ratio', ['16:9', '9:16']),
                enumSpec('resolution', ['720p', '1080p'], '720p'),
            ],
        }),
        mediaModel({
            id: 'plain',
            name: 'Plain',
            medium: 'video',
            price: { unit: 'second', from: 0.9, to: 0.9, byKey: {}, raw: null },
        }),
    ];
    hooks = {};
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
    vi.unstubAllGlobals();
    h.restore();
});

async function open(section: 'stt' | 'video'): Promise<void> {
    session.section = section;
    await h.connections.refresh();
    dispose = renderMediaTab(root, tc.ctx, session, hooks);
    await settle();
}

const lastBody = (route: string): Record<string, unknown> =>
    (tc.mediaFake.callsTo(route).at(-1)?.body ?? {}) as Record<string, unknown>;

/* ------------------------------------------------------------------------------------------ transcription */

interface FakeRecording {
    handle: RecorderHandle;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    onLimit: ((reason: 'max_bytes' | 'max_time') => void) | undefined;
    options: { maxBytes: number; maxMs: number } | undefined;
}

function fakeMicrophone(audio: Partial<RecordedAudio> = {}): FakeRecording {
    const recording: FakeRecording = {
        handle: undefined as unknown as RecorderHandle,
        stop: vi.fn(),
        cancel: vi.fn(),
        onLimit: undefined,
        options: undefined,
    };
    const taken: RecordedAudio = {
        blob: new Blob([new Uint8Array(5000)], { type: 'audio/webm;codecs=opus' }),
        mime: 'audio/webm',
        durationMs: 12_000,
        bytes: 5000,
        reason: 'stopped',
        ...audio,
    };
    recording.stop.mockResolvedValue(taken);
    recording.handle = {
        mime: 'audio/webm',
        elapsedMs: () => 3_000,
        bytes: () => 1_500,
        stop: recording.stop as RecorderHandle['stop'],
        cancel: recording.cancel as RecorderHandle['cancel'],
    };
    hooks = {
        recorderSupport: () => ({ supported: true }),
        startRecording: async (options) => {
            recording.onLimit = options.onLimit;
            recording.options = { maxBytes: options.maxBytes, maxMs: options.maxMs };
            return { ok: true, handle: recording.handle };
        },
        audioDuration: async () => 2.5,
    };
    return recording;
}

describe('transcription studio: where the audio comes from', () => {
    it('without MediaRecorder it says so and still takes a file', async () => {
        hooks = { recorderSupport: () => ({ supported: false, reason: 'unsupported' }) };
        await open('stt');
        expect(text(root)).toContain('This browser cannot record from the microphone. Choose a file instead.');
        expect(hasButton(root, 'Record')).toBe(false);
        expect(root.querySelector('input[type="file"]')).not.toBeNull();
    });

    it('on a page that is not secure it explains https and localhost', async () => {
        hooks = { recorderSupport: () => ({ supported: false, reason: 'insecure' }) };
        await open('stt');
        expect(text(root)).toContain('only on a secure page (https, or localhost)');
        expect(hasButton(root, 'Record')).toBe(false);
    });

    it('shows the size and time ceilings before anything is recorded', async () => {
        fakeMicrophone();
        await open('stt');
        expect(text(root)).toContain('Up to 4 MB and 5:00 per recording.');
    });

    it.each([
        ['denied', 'The microphone is blocked'],
        ['no_device', 'No microphone was found.'],
        ['busy', 'The microphone is busy'],
        ['insecure', 'only on a secure page'],
        ['failed', 'could not be started'],
        ['unsupported', 'cannot record from the microphone'],
    ] as const)('a refused microphone (%s) is shown as a state, not swallowed', async (kind, words) => {
        fakeMicrophone();
        hooks.startRecording = async () => ({ ok: false, error: { kind, message: 'x' } });
        await open('stt');
        await click(root, 'Record');
        expect(text(root)).toContain(words);
        expect(hasButton(root, 'Record')).toBe(true);
    });

    it('records, shows the meter, and on stop keeps the recording with its length and size', async () => {
        const microphone = fakeMicrophone();
        await open('stt');
        await click(root, 'Record');
        expect(microphone.options).toEqual({ maxBytes: MAX_UPLOAD_BYTES - 64 * 1024, maxMs: 300_000 });
        expect(hasButton(root, 'Stop')).toBe(true);
        expect(text(root)).toContain('Recording 0:03 of 5:00');
        expect(buttonNamed(root, 'Transcribe').disabled).toBe(true);
        await click(root, 'Stop');
        expect(hasButton(root, 'Record')).toBe(true);
        expect(text(root)).toContain('recording.webm');
        expect(text(root)).toContain('4.9 KB');
        expect(text(root)).toContain('0:12');
        expect(root.querySelector('.nanovia-media-recorded audio')).not.toBeNull();
        expect(buttonNamed(root, 'Transcribe').disabled).toBe(false);
    });

    it('estimates from the length of the recording', async () => {
        fakeMicrophone();
        await open('stt');
        expect(text(root)).toContain('Record or choose audio to see the estimate.');
        await click(root, 'Record');
        await click(root, 'Stop');
        expect(text(root)).toContain('Estimated cost: $0.00001');
        expect(estimateSttCost).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'asr' }), 12);
    });

    it('a recording that reached a ceiling says so and is kept', async () => {
        const microphone = fakeMicrophone({ reason: 'max_bytes', bytes: 4_000_000 });
        await open('stt');
        await click(root, 'Record');
        microphone.onLimit?.('max_bytes');
        await settle();
        expect(text(root)).toContain('The recording stopped at the size limit.');
        expect(text(root)).toContain('recording.webm');
        expect(hasButton(root, 'Record')).toBe(true);
    });

    it('an empty recording is not kept', async () => {
        fakeMicrophone({ bytes: 0, blob: new Blob([]) });
        await open('stt');
        await click(root, 'Record');
        await click(root, 'Stop');
        expect(text(root)).toContain('The recording came out empty.');
        expect(root.querySelector('.nanovia-media-recorded')).toBeNull();
    });

    it('leaving the tab while recording lets go of the microphone', async () => {
        const microphone = fakeMicrophone();
        await open('stt');
        await click(root, 'Record');
        dispose?.();
        dispose = undefined;
        expect(microphone.cancel).toHaveBeenCalledOnce();
    });

    it('takes a file, reads its length, and refuses one over 4 MB', async () => {
        fakeMicrophone();
        await open('stt');
        const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
        pickFile(input, fileOf('speech.mp3', 'audio/mpeg', 2000));
        await settle(8);
        expect(text(root)).toContain('speech.mp3');
        expect(text(root)).toContain('0:02');
        expect(estimateSttCost).toHaveBeenLastCalledWith(expect.anything(), 2.5);
        await click(root, 'Discard');
        expect(root.querySelector('.nanovia-media-recorded')).toBeNull();
        pickFile(
            root.querySelector<HTMLInputElement>('input[type="file"]')!,
            fileOf('big.wav', 'audio/wav', MAX_UPLOAD_BYTES + 1),
        );
        await settle(8);
        expect(text(root)).toContain('The file is over 4 MB, which NanoGPT does not accept.');
        expect(root.querySelector('.nanovia-media-recorded')).toBeNull();
        pickFile(root.querySelector<HTMLInputElement>('input[type="file"]')!, fileOf('empty.wav', 'audio/wav', 0));
        await settle(8);
        expect(text(root)).toContain('The file is empty.');
    });

    it('a file of unknown length cannot be estimated, and says so', async () => {
        fakeMicrophone();
        hooks.audioDuration = async () => null;
        await open('stt');
        pickFile(root.querySelector<HTMLInputElement>('input[type="file"]')!, fileOf('speech.mp3', 'audio/mpeg', 2000));
        await settle(8);
        expect(text(root)).toContain('The length of this file is unknown, so the cost cannot be estimated.');
    });
});

describe('transcription studio: sending and reading the transcript', () => {
    async function recorded(): Promise<void> {
        fakeMicrophone();
        await open('stt');
        await click(root, 'Record');
        await click(root, 'Stop');
    }

    it('without audio it asks for some, and sends nothing', async () => {
        fakeMicrophone();
        await open('stt');
        await click(root, 'Transcribe');
        expect(text(root)).toContain('Record or choose some audio first.');
        expect(tc.mediaFake.callsTo('POST /media/stt')).toHaveLength(0);
    });

    it('sends the audio as plain base64 with its own name, type and the language', async () => {
        await recorded();
        type(root, 'Language', ' ru ');
        await click(root, 'Transcribe');
        const body = lastBody('POST /media/stt');
        expect(body).toMatchObject({ model: 'asr', filename: 'recording.webm', mime: 'audio/webm', language: 'ru' });
        expect(typeof body['audioBase64']).toBe('string');
        expect(String(body['audioBase64'])).not.toContain('data:');
        expect(String(body['audioBase64']).length).toBeGreaterThan(1000);
    });

    it('shows the text and a copy button that copies it', async () => {
        const writeText = vi.fn(async () => {});
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        await recorded();
        await click(root, 'Transcribe');
        expect(root.querySelector('.nanovia-media-transcript')?.textContent).toBe('Hello, there, friend.');
        expect(text(root)).toContain('auto-detect');
        expect(root.querySelector('.nanovia-media-cost')?.textContent).toContain('$0.00000666');
        await click(root, 'Copy');
        expect(writeText).toHaveBeenCalledWith('Hello, there, friend.');
    });

    it('shows segments with their times and speakers when the model gives them', async () => {
        tc.mediaFake.sttResult = () => ({
            model: 'speakers',
            text: 'Hi. Hello.',
            language: 'en',
            durationSec: 6,
            segments: [
                { start: 0, end: 2.5, text: 'Hi.', speaker: 'Speaker 1' },
                { start: 3, end: 6, text: 'Hello.', speaker: 'Speaker 2' },
            ],
            cost: costOf({ usd: 0.001 }),
            latencyMs: 1200,
        });
        await recorded();
        await click(root, 'Transcribe');
        const segments = [...root.querySelectorAll('.nanovia-media-segment')].map((node) => node.textContent);
        expect(segments).toEqual(['0:00–0:02Speaker 1Hi.', '0:03–0:06Speaker 2Hello.']);
    });

    it('speaker labels are offered, and sent, only for a model that gives them', async () => {
        await recorded();
        expect(text(root)).not.toContain('Label speakers');
        choose(root, 'Model', 'speakers');
        await settle();
        expect(text(root)).toContain('Label speakers');
        check(root, 'Label speakers', true);
        await click(root, 'Transcribe');
        expect(lastBody('POST /media/stt')).toMatchObject({ model: 'speakers', diarize: true });
    });

    it('speech with nothing in it is said, not shown as an empty box', async () => {
        tc.mediaFake.sttResult = () => ({
            model: 'asr',
            text: '',
            language: '',
            durationSec: null,
            segments: [],
            cost: costOf(),
            latencyMs: 10,
        });
        await recorded();
        await click(root, 'Transcribe');
        expect(root.querySelector('.nanovia-media-transcript')?.textContent).toBe('(no speech found)');
    });

    it('says why a call failed, and keeps the audio for another try', async () => {
        await recorded();
        tc.mediaFake.fail.set('POST /media/stt', { status: 413, code: 'payload_too_large' });
        await click(root, 'Transcribe');
        expect(text(root)).toContain('over the 4 MB NanoGPT accepts');
        expect(root.querySelector('.nanovia-media-recorded')).not.toBeNull();
        tc.mediaFake.fail.clear();
        await click(root, 'Transcribe');
        expect(root.querySelector('.nanovia-media-transcript')?.textContent).toBe('Hello, there, friend.');
    });
});

/* ------------------------------------------------------------------------------------------ video */

describe('video studio: the form', () => {
    it('shows what the model lists: duration, aspect, resolution, and a start image only for image-to-video', async () => {
        await open('video');
        expect(field<HTMLSelectElement>(root, 'Model').value).toBe('veo3');
        expect([...field<HTMLSelectElement>(root, 'Duration (s)').options].map((o) => o.value)).toEqual(['5s', '8s']);
        expect(field<HTMLSelectElement>(root, 'Duration (s)').value).toBe('8s');
        expect(field<HTMLSelectElement>(root, 'Resolution').value).toBe('720p');
        expect(hasField(root, 'Aspect ratio')).toBe(true);
        expect(root.querySelector('input[type="file"]')).not.toBeNull();
        choose(root, 'Model', 'plain');
        await settle();
        expect(hasField(root, 'Duration (s)')).toBe(false);
        expect(hasField(root, 'Resolution')).toBe(false);
        expect(root.querySelector('input[type="file"]')).toBeNull();
    });

    it('estimates with the duration and resolution chosen, and says when the price is approximate', async () => {
        await open('video');
        expect(text(root)).toContain('Estimated cost: about $1.20 (approximate)');
        expect(text(root)).toContain('treat the number as approximate');
        choose(root, 'Duration (s)', '5s');
        choose(root, 'Resolution', '1080p');
        expect(estimateVideoCost).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'veo3' }), {
            duration: 5,
            resolution: '1080p',
        });
        choose(root, 'Model', 'plain');
        await settle();
        expect(text(root)).toContain('Estimated cost: $1.20');
        expect(text(root)).not.toContain('(approximate)');
    });

    it('a price that cannot be estimated is not shown as zero', async () => {
        vi.mocked(estimateVideoCost).mockReturnValueOnce(null);
        await open('video');
        expect(text(root)).toContain('cannot be estimated');
    });

    it('states plainly that NanoGPT has no cancel', async () => {
        await open('video');
        expect(text(root)).toContain('NanoGPT has no cancel');
        expect(text(root)).toContain('billed');
    });

    it('takes a start image up to 4 MB after encoding and refuses a larger one', async () => {
        await open('video');
        const input = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[type="file"]')!;
        pickFile(input(), fileOf('big.png', 'image/png', 3_200_000));
        await settle(8);
        expect(text(root)).toContain('big.png is over 4 MB after encoding');
        pickFile(input(), fileOf('start.png', 'image/png', 1000));
        await settle(8);
        expect(root.querySelector('.nanovia-media-ref')?.textContent).toContain('start.png');
        type(root, 'Prompt', 'a dragon');
        await click(root, 'Start video');
        expect(String(lastBody('POST /media/video')['imageUrl'])).toMatch(/^data:image\/png;base64,/);
    });
});

describe('video studio: jobs', () => {
    const cardOf = (id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-job="${id}"]`)!;

    async function submit(prompt = 'a dragon over a lake'): Promise<void> {
        type(root, 'Prompt', prompt);
        await click(root, 'Start video');
    }

    it('wants a prompt', async () => {
        await open('video');
        await click(root, 'Start video');
        expect(text(root)).toContain('Write a prompt first.');
        expect(tc.mediaFake.callsTo('POST /media/video')).toHaveLength(0);
    });

    it('sends the form as numbers and choices and shows the job', async () => {
        await open('video');
        choose(root, 'Duration (s)', '5s');
        choose(root, 'Aspect ratio', '9:16');
        await submit();
        expect(lastBody('POST /media/video')).toEqual({
            model: 'veo3',
            prompt: 'a dragon over a lake',
            duration: 5,
            aspectRatio: '9:16',
            resolution: '720p',
        });
        expect(text(root)).toContain('The job was submitted.');
        const card = cardOf('vid_1');
        expect(card.textContent).toContain('queued');
        expect(card.textContent).toContain('a dragon over a lake');
        expect(card.textContent).toContain('Pre-charge: $0.40');
        expect(root.querySelector('video')).toBeNull();
    });

    it('polls by itself while the section is open: progress, then the video from the plugin’s files route', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        await open('video');
        await submit();
        vi.advanceTimersByTime(5000);
        await settle();
        let card = cardOf('vid_1');
        expect(card.textContent).toContain('running');
        expect(card.textContent).toContain('50%');
        expect(card.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
        expect(card.querySelector('video')).toBeNull();

        vi.advanceTimersByTime(5000);
        await settle();
        card = cardOf('vid_1');
        expect(card.textContent).toContain('done');
        expect(card.textContent).toContain('Cost: $0.41');
        const video = card.querySelector('video')!;
        expect(video.getAttribute('src')).toBe('/api/plugins/nanovia/media/files/vid_1');
        expect(video.hasAttribute('controls')).toBe(true);
        expect(card.querySelector('[role="progressbar"]')?.hasAttribute('hidden')).toBe(true);

        // Another redraw does not make a new player (it would restart the playback).
        tc.media.onChange(() => {});
        await tc.media.refreshVideos();
        await settle();
        expect(cardOf('vid_1').querySelector('video')).toBe(video);
    });

    it('stops polling when the section is left, and starts again when it is opened', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        tc.mediaFake.script = ['running'];
        await open('video');
        await submit();
        await click(root, 'Catalog');
        vi.advanceTimersByTime(30_000);
        await settle();
        expect(tc.mediaFake.callsTo('GET /media/video/')).toHaveLength(0);
        await click(root, 'Video');
        vi.advanceTimersByTime(5_000);
        await settle();
        expect(tc.mediaFake.callsTo('GET /media/video/')).toHaveLength(1);
    });

    it('while the plugin’s copy is missing, the link at NanoGPT is offered', async () => {
        await open('video');
        await submit();
        const job = tc.mediaFake.jobs[0]!;
        tc.mediaFake.jobs[0] = {
            ...job,
            status: 'completed',
            output: { kind: 'video', mime: 'video/mp4', url: 'https://cdn.example.test/v.mp4' },
        };
        await tc.media.videoStatus('vid_1');
        await settle();
        const card = cardOf('vid_1');
        expect(card.querySelector('video')).toBeNull();
        expect(card.textContent).toContain('no saved copy of this video');
        const link = card.querySelector('a');
        expect(link?.getAttribute('href')).toBe('https://cdn.example.test/v.mp4');
        expect(link?.getAttribute('rel')).toContain('noopener');
    });

    it('a failed job shows its reason', async () => {
        tc.mediaFake.script = ['failed'];
        await open('video');
        await submit();
        await tc.media.videoStatus('vid_1');
        await settle();
        expect(cardOf('vid_1').textContent).toContain('failed');
        expect(cardOf('vid_1').textContent).toContain('NanoGPT could not render the video');
    });

    it('deleting asks first, then forgets the job; a refusal keeps it', async () => {
        await open('video');
        await submit();
        h.mock.popupResult = POPUP_RESULT.NEGATIVE;
        await click(cardOf('vid_1'), 'Delete');
        expect(cardOf('vid_1')).not.toBeNull();
        expect(tc.mediaFake.jobs).toHaveLength(1);
        h.mock.popupResult = POPUP_RESULT.AFFIRMATIVE;
        await click(cardOf('vid_1'), 'Delete');
        expect(root.querySelector('[data-job="vid_1"]')).toBeNull();
        expect(tc.mediaFake.jobs).toHaveLength(0);
        expect(text(root)).toContain('No video jobs yet.');
    });

    it('the confirmation says there is no cancel', async () => {
        await open('video');
        await submit();
        await click(cardOf('vid_1'), 'Delete');
        const popup = h.mock.popups.at(-1)?.content as HTMLElement;
        expect(popup.textContent).toContain('there is no cancel');
    });

    it('the jobs of the plugin are there when the tab opens, newest first', async () => {
        await tc.media.startVideo({ model: 'veo3', prompt: 'older' });
        await tc.media.startVideo({ model: 'veo3', prompt: 'newer' });
        tc.media.dispose();
        await open('video');
        const order = [...root.querySelectorAll<HTMLElement>('[data-job]')].map((node) => node.dataset['job']);
        expect(order).toEqual(['vid_2', 'vid_1']);
    });

    it('a plugin that stops answering leaves the jobs on the page, with a note', async () => {
        await open('video');
        await submit();
        h.backend.plugin.up = false;
        await tc.media.refreshVideos();
        await settle();
        expect(cardOf('vid_1')).not.toBeNull();
        expect(text(root)).toContain('The list may be out of date');
        h.backend.plugin.up = true;
        await tc.media.refreshVideos();
        await settle();
        expect(text(root)).not.toContain('The list may be out of date');
    });

    it('a submit that fails says why and makes no job', async () => {
        await open('video');
        tc.mediaFake.fail.set('POST /media/video', {
            status: 402,
            code: 'insufficient_balance',
            message: 'required: 3.2',
        });
        await submit();
        expect(text(root)).toContain('it needs $3.20');
        expect(root.querySelector('[data-job]')).toBeNull();
    });
});

describe('studio images are not mixed up', () => {
    it('the PNG fixture is a real PNG', () => {
        expect(atob(PNG_BASE64).slice(1, 4)).toBe('PNG');
    });
});
