// The microphone door: records speech with the browser's MediaRecorder for the transcription studio. Feature-detected
// (an old browser, a page that is not a secure context, no microphone), never throws: a refusal is an ordinary error value
// the UI words. Nothing is kept after a recording ends; the caller owns the blob. The recording stops by itself at a size or
// time ceiling, so a forgotten recording cannot grow past what NanoGPT accepts (4 MB per upload).
export type RecorderErrorKind =
    /** No MediaRecorder or no getUserMedia in this browser. */
    | 'unsupported'
    /** The page is not a secure context (https or localhost): browsers refuse the microphone there. */
    | 'insecure'
    /** The user (or the browser's policy) refused the microphone. */
    | 'denied'
    /** No microphone is connected. */
    | 'no_device'
    /** The microphone is in use by something else or could not be opened. */
    | 'busy'
    | 'failed';

export interface RecorderError {
    kind: RecorderErrorKind;
    message: string;
}

export type RecorderSupport = { supported: true } | { supported: false; reason: 'insecure' | 'unsupported' };

export interface RecordedAudio {
    blob: Blob;
    /** The container's own type without parameters (`audio/webm`). */
    mime: string;
    durationMs: number;
    bytes: number;
    /** Why it ended: the user stopped it, or a ceiling did. */
    reason: 'stopped' | 'max_bytes' | 'max_time';
}

export interface RecorderHandle {
    /** The container the recording uses (`audio/webm`), known before it ends. */
    readonly mime: string;
    elapsedMs(): number;
    /** Bytes recorded so far. */
    bytes(): number;
    /** Ends the recording and resolves to it; calling it again returns the same recording. */
    stop(): Promise<RecordedAudio>;
    /** Ends it and throws the audio away. */
    cancel(): void;
}

/** The browser pieces the recorder uses; replaced in tests. */
export interface RecorderEnv {
    mediaDevices?: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> };
    Recorder?: {
        new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
        isTypeSupported?: (type: string) => boolean;
    };
    isSecureContext?: boolean;
    now?: () => number;
    /** Time limit timers (tests drive them). */
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/** Containers in the order the studio prefers: opus in webm (Chrome, Firefox), mp4 (Safari), ogg. */
export const RECORDER_MIME_CANDIDATES: readonly string[] = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
];

function browserEnv(): RecorderEnv {
    const scope = globalThis as unknown as {
        navigator?: { mediaDevices?: RecorderEnv['mediaDevices'] };
        MediaRecorder?: RecorderEnv['Recorder'];
        isSecureContext?: boolean;
    };
    return {
        ...(scope.navigator?.mediaDevices ? { mediaDevices: scope.navigator.mediaDevices } : {}),
        ...(scope.MediaRecorder ? { Recorder: scope.MediaRecorder } : {}),
        ...(typeof scope.isSecureContext === 'boolean' ? { isSecureContext: scope.isSecureContext } : {}),
    };
}

/** Can this page record at all? `insecure` is its own reason because the fix (https, or localhost) is the user's. */
export function recorderSupport(env: RecorderEnv = browserEnv()): RecorderSupport {
    if (typeof env.Recorder !== 'function' || typeof env.mediaDevices?.getUserMedia !== 'function') {
        // Without getUserMedia the missing secure context is the usual reason: browsers hide mediaDevices on plain http.
        return { supported: false, reason: env.isSecureContext === false ? 'insecure' : 'unsupported' };
    }
    if (env.isSecureContext === false) return { supported: false, reason: 'insecure' };
    return { supported: true };
}

function failure(kind: RecorderErrorKind, error: unknown): { ok: false; error: RecorderError } {
    return { ok: false, error: { kind, message: error instanceof Error ? error.message : String(error) } };
}

function kindOfDomError(error: unknown): RecorderErrorKind {
    const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
    switch (name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
        case 'SecurityError':
            return 'denied';
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return 'no_device';
        case 'NotReadableError':
        case 'TrackStartError':
        case 'AbortError':
            return 'busy';
        default:
            return 'failed';
    }
}

export interface StartRecordingOptions {
    /** Stops by itself when this many bytes are recorded. */
    maxBytes: number;
    /** Stops by itself after this long. */
    maxMs: number;
    /** Called once when a ceiling ended the recording (the recording is then available from `stop()`). */
    onLimit?: (reason: 'max_bytes' | 'max_time') => void;
    env?: RecorderEnv;
}

/** Asks for the microphone and starts recording. Resolves to a handle, or to the reason it could not. */
export async function startRecording(
    options: StartRecordingOptions,
): Promise<{ ok: true; handle: RecorderHandle } | { ok: false; error: RecorderError }> {
    const env = options.env ?? browserEnv();
    const support = recorderSupport(env);
    if (!support.supported) {
        return failure(support.reason, support.reason === 'insecure' ? 'not a secure context' : 'no MediaRecorder');
    }
    const Recorder = env.Recorder;
    const getUserMedia = env.mediaDevices?.getUserMedia?.bind(env.mediaDevices);
    if (!Recorder || !getUserMedia) return failure('unsupported', 'no MediaRecorder');
    const now = env.now ?? Date.now;
    const setTimer = env.setTimer ?? ((callback: () => void, ms: number): unknown => setTimeout(callback, ms));
    const clearTimer =
        env.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

    let stream: MediaStream;
    try {
        stream = await getUserMedia({ audio: true });
    } catch (error) {
        return failure(kindOfDomError(error), error);
    }
    const stopTracks = (): void => {
        for (const track of stream.getTracks()) {
            try {
                track.stop();
            } catch {
                // A track that cannot stop is already gone.
            }
        }
    };

    let recorder: MediaRecorder;
    const chosen = RECORDER_MIME_CANDIDATES.find((type) => Recorder.isTypeSupported?.(type) === true);
    try {
        recorder = chosen ? new Recorder(stream, { mimeType: chosen }) : new Recorder(stream);
    } catch (error) {
        stopTracks();
        return failure('unsupported', error);
    }
    const fullMime = recorder.mimeType || chosen || 'audio/webm';
    const mime = (fullMime.split(';')[0] ?? 'audio/webm').trim() || 'audio/webm';

    const chunks: Blob[] = [];
    let bytes = 0;
    const startedAt = now();
    let endedAt: number | null = null;
    let reason: RecordedAudio['reason'] = 'stopped';
    let timer: unknown = null;
    let ended: Promise<RecordedAudio> | null = null;
    let discard = false;

    function finish(why: RecordedAudio['reason']): Promise<RecordedAudio> {
        if (ended) return ended;
        reason = why;
        endedAt = now();
        if (timer !== null) clearTimer(timer);
        timer = null;
        ended = new Promise<RecordedAudio>((resolve) => {
            const done = (): void => {
                stopTracks();
                resolve({
                    blob: new Blob(chunks, { type: fullMime }),
                    mime,
                    durationMs: Math.max(0, (endedAt ?? now()) - startedAt),
                    bytes,
                    reason,
                });
            };
            if (recorder.state === 'inactive') {
                done();
                return;
            }
            recorder.onstop = done;
            try {
                recorder.stop();
            } catch {
                done();
            }
        });
        return ended;
    }

    recorder.ondataavailable = (event: BlobEvent): void => {
        if (discard || ended !== null) {
            // The last chunk arrives after stop(): it still belongs to the recording unless it was cancelled.
            if (!discard && event.data.size > 0) {
                chunks.push(event.data);
                bytes += event.data.size;
            }
            return;
        }
        if (event.data.size > 0) {
            chunks.push(event.data);
            bytes += event.data.size;
        }
        if (bytes >= options.maxBytes) {
            options.onLimit?.('max_bytes');
            void finish('max_bytes');
        }
    };
    recorder.onerror = (): void => {
        void finish('stopped');
    };

    try {
        recorder.start(1000);
    } catch (error) {
        stopTracks();
        return failure('failed', error);
    }
    timer = setTimer(() => {
        options.onLimit?.('max_time');
        void finish('max_time');
    }, options.maxMs);

    return {
        ok: true,
        handle: {
            mime,
            elapsedMs: () => Math.max(0, (endedAt ?? now()) - startedAt),
            bytes: () => bytes,
            stop: () => finish('stopped'),
            cancel: () => {
                discard = true;
                chunks.length = 0;
                bytes = 0;
                void finish('stopped');
            },
        },
    };
}
