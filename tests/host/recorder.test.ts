import { describe, expect, it, vi } from 'vitest';
import { RECORDER_MIME_CANDIDATES, recorderSupport, startRecording } from '../../src/host/recorder';
import type { RecorderEnv } from '../../src/host/recorder';

/** A MediaRecorder stand-in: the test pushes chunks and decides when `stop` fires. */
class FakeRecorder {
    static supported: string[] = ['audio/webm;codecs=opus'];
    static instances: FakeRecorder[] = [];
    static isTypeSupported(type: string): boolean {
        return FakeRecorder.supported.includes(type);
    }

    state: 'inactive' | 'recording' = 'inactive';
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    started: number | undefined;
    failStart = false;

    constructor(
        readonly stream: unknown,
        readonly options?: { mimeType?: string },
    ) {
        this.mimeType = options?.mimeType ?? '';
        FakeRecorder.instances.push(this);
    }

    start(timeslice?: number): void {
        if (this.failStart) throw new Error('start failed');
        this.started = timeslice;
        this.state = 'recording';
    }

    stop(): void {
        this.state = 'inactive';
        queueMicrotask(() => this.onstop?.());
    }

    push(bytes: number): void {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
    }
}

function makeEnv(overrides: Partial<RecorderEnv> = {}): {
    env: RecorderEnv;
    tracks: { stop: ReturnType<typeof vi.fn> }[];
    clock: { now: number };
    timers: { callback: () => void; ms: number; cleared: boolean }[];
} {
    FakeRecorder.instances = [];
    FakeRecorder.supported = ['audio/webm;codecs=opus'];
    const tracks = [{ stop: vi.fn() }];
    const clock = { now: 1000 };
    const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
    const env: RecorderEnv = {
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) as unknown as MediaStream },
        Recorder: FakeRecorder as unknown as RecorderEnv['Recorder'],
        isSecureContext: true,
        now: () => clock.now,
        setTimer: (callback, ms) => {
            const entry = { callback, ms, cleared: false };
            timers.push(entry);
            return entry;
        },
        clearTimer: (handle) => {
            (handle as { cleared: boolean }).cleared = true;
        },
        ...overrides,
    };
    return { env, tracks, clock, timers };
}

const LIMITS = { maxBytes: 1000, maxMs: 60_000 };

describe('recorderSupport', () => {
    it('is supported with a recorder, getUserMedia and a secure page', () => {
        expect(recorderSupport(makeEnv().env)).toEqual({ supported: true });
    });

    it('says insecure on plain http (browsers hide the microphone there)', () => {
        const { env } = makeEnv({ isSecureContext: false });
        expect(recorderSupport(env)).toEqual({ supported: false, reason: 'insecure' });
        expect(recorderSupport({ isSecureContext: false })).toEqual({ supported: false, reason: 'insecure' });
    });

    it('says unsupported without a recorder or without getUserMedia', () => {
        const { env } = makeEnv();
        expect(recorderSupport({ ...env, Recorder: undefined })).toEqual({ supported: false, reason: 'unsupported' });
        expect(recorderSupport({ ...env, mediaDevices: {} })).toEqual({ supported: false, reason: 'unsupported' });
        expect(recorderSupport({})).toEqual({ supported: false, reason: 'unsupported' });
    });
});

describe('startRecording: why it cannot start', () => {
    it('refuses without support, naming the reason', async () => {
        const { env } = makeEnv({ isSecureContext: false });
        expect(await startRecording({ ...LIMITS, env })).toMatchObject({ ok: false, error: { kind: 'insecure' } });
        expect(await startRecording({ ...LIMITS, env: {} })).toMatchObject({
            ok: false,
            error: { kind: 'unsupported' },
        });
    });

    it.each([
        ['NotAllowedError', 'denied'],
        ['SecurityError', 'denied'],
        ['NotFoundError', 'no_device'],
        ['NotReadableError', 'busy'],
        ['AbortError', 'busy'],
        ['SomethingElse', 'failed'],
    ])('maps %s from getUserMedia to %s', async (name, kind) => {
        const { env } = makeEnv({
            mediaDevices: {
                getUserMedia: async () => {
                    throw Object.assign(new Error('nope'), { name });
                },
            },
        });
        expect(await startRecording({ ...LIMITS, env })).toMatchObject({ ok: false, error: { kind, message: 'nope' } });
    });

    it('releases the microphone when the recorder cannot start', async () => {
        const { env, tracks } = makeEnv();
        const original = env.Recorder as unknown as typeof FakeRecorder;
        env.Recorder = class extends original {
            override start(): void {
                throw new Error('cannot start');
            }
        } as unknown as RecorderEnv['Recorder'];
        expect(await startRecording({ ...LIMITS, env })).toMatchObject({ ok: false, error: { kind: 'failed' } });
        expect(tracks[0]?.stop).toHaveBeenCalled();
    });

    it('releases the microphone when the recorder cannot be built', async () => {
        const { env, tracks } = makeEnv();
        env.Recorder = class {
            constructor() {
                throw new Error('bad options');
            }
        } as unknown as RecorderEnv['Recorder'];
        expect(await startRecording({ ...LIMITS, env })).toMatchObject({ ok: false, error: { kind: 'unsupported' } });
        expect(tracks[0]?.stop).toHaveBeenCalled();
    });
});

describe('startRecording: a recording', () => {
    it('prefers webm/opus, reports its container without parameters and records in one-second slices', async () => {
        const { env } = makeEnv();
        const result = await startRecording({ ...LIMITS, env });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const recorder = FakeRecorder.instances[0]!;
        expect(recorder.options).toEqual({ mimeType: 'audio/webm;codecs=opus' });
        expect(recorder.started).toBe(1000);
        expect(result.handle.mime).toBe('audio/webm');
        expect(RECORDER_MIME_CANDIDATES[0]).toBe('audio/webm;codecs=opus');
    });

    it('falls back to a container the browser has (Safari: mp4), or to the browser’s own default', async () => {
        const first = makeEnv();
        FakeRecorder.supported = ['audio/mp4'];
        const mp4 = await startRecording({ ...LIMITS, env: first.env });
        expect(mp4.ok && mp4.handle.mime).toBe('audio/mp4');

        const second = makeEnv();
        FakeRecorder.supported = [];
        const fallback = await startRecording({ ...LIMITS, env: second.env });
        expect(FakeRecorder.instances[0]?.options).toBeUndefined();
        expect(fallback.ok && fallback.handle.mime).toBe('audio/webm');
    });

    it('stop() ends the recording, hands over the blob and releases the microphone; calling it again is the same recording', async () => {
        const { env, tracks, clock } = makeEnv();
        const result = await startRecording({ ...LIMITS, env });
        if (!result.ok) throw new Error('expected a recording');
        const recorder = FakeRecorder.instances[0]!;
        recorder.push(300);
        recorder.push(200);
        clock.now += 4500;
        expect(result.handle.elapsedMs()).toBe(4500);
        expect(result.handle.bytes()).toBe(500);
        const taken = await result.handle.stop();
        expect(taken).toMatchObject({ mime: 'audio/webm', bytes: 500, durationMs: 4500, reason: 'stopped' });
        expect(taken.blob.size).toBe(500);
        expect(taken.blob.type).toBe('audio/webm;codecs=opus');
        expect(tracks[0]?.stop).toHaveBeenCalledOnce();
        expect(await result.handle.stop()).toBe(taken);
        // The clock stops with the recording.
        clock.now += 9999;
        expect(result.handle.elapsedMs()).toBe(4500);
    });

    it('stops by itself at the size ceiling, and says why', async () => {
        const { env, tracks } = makeEnv();
        const onLimit = vi.fn();
        const result = await startRecording({ ...LIMITS, onLimit, env });
        if (!result.ok) throw new Error('expected a recording');
        const recorder = FakeRecorder.instances[0]!;
        recorder.push(600);
        expect(onLimit).not.toHaveBeenCalled();
        recorder.push(500);
        expect(onLimit).toHaveBeenCalledWith('max_bytes');
        const taken = await result.handle.stop();
        expect(taken).toMatchObject({ bytes: 1100, reason: 'max_bytes' });
        expect(tracks[0]?.stop).toHaveBeenCalledOnce();
    });

    it('stops by itself at the time ceiling, and clears its timer when stopped by hand', async () => {
        const first = makeEnv();
        const onLimit = vi.fn();
        const timed = await startRecording({ ...LIMITS, onLimit, env: first.env });
        if (!timed.ok) throw new Error('expected a recording');
        expect(first.timers[0]?.ms).toBe(60_000);
        first.timers[0]?.callback();
        expect(onLimit).toHaveBeenCalledWith('max_time');
        expect(await timed.handle.stop()).toMatchObject({ reason: 'max_time' });

        const second = makeEnv();
        const manual = await startRecording({ ...LIMITS, env: second.env });
        if (!manual.ok) throw new Error('expected a recording');
        await manual.handle.stop();
        expect(second.timers[0]?.cleared).toBe(true);
    });

    it('cancel() throws the audio away and releases the microphone', async () => {
        const { env, tracks } = makeEnv();
        const result = await startRecording({ ...LIMITS, env });
        if (!result.ok) throw new Error('expected a recording');
        FakeRecorder.instances[0]!.push(100);
        result.handle.cancel();
        const taken = await result.handle.stop();
        expect(tracks[0]?.stop).toHaveBeenCalled();
        // What was recorded before the cancel is gone, and a chunk that arrives after it is not kept.
        FakeRecorder.instances[0]!.push(50);
        expect(taken).toMatchObject({ reason: 'stopped', bytes: 0 });
        expect(taken.blob.size).toBe(0);
    });

    it('a recorder error ends the recording', async () => {
        const { env, tracks } = makeEnv();
        const result = await startRecording({ ...LIMITS, env });
        if (!result.ok) throw new Error('expected a recording');
        FakeRecorder.instances[0]!.onerror?.();
        await result.handle.stop();
        expect(tracks[0]?.stop).toHaveBeenCalled();
    });
});
