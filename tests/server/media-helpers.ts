// Shared pieces of the media server tests: a plugin in front of the mock (with a hand-driven billing clock), recordings,
// and the raw usage lines of a user.
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import path from 'node:path';
import type { Timers } from '../../src/server/media-billing';
import type { FetchLike } from '../../src/server/types';
import { startMockStack, type MockStack, type MockStackOptions } from './mock-stack';

interface TimerEntry {
    fn: () => void;
    ms: number;
    cleared: boolean;
    fired: boolean;
}

/** A clock the test holds: `set` records, `fire` runs the oldest waiting timer. */
export function manualTimers() {
    const all: TimerEntry[] = [];
    const timers: Timers = {
        set(fn, ms) {
            const entry: TimerEntry = { fn, ms, cleared: false, fired: false };
            all.push(entry);
            return entry;
        },
        clear(handle) {
            (handle as TimerEntry).cleared = true;
        },
    };
    return {
        timers,
        /** Delays (ms) of the timers that are still waiting, oldest first. */
        waiting: () => all.filter((e) => !e.cleared && !e.fired).map((e) => e.ms),
        /** Every delay ever asked for, in order. */
        asked: () => all.map((e) => e.ms),
        /** Runs the oldest waiting timer; false when there is none. */
        fire(): boolean {
            const next = all.find((e) => !e.cleared && !e.fired);
            if (!next) return false;
            next.fired = true;
            next.fn();
            return true;
        },
    };
}

export type ManualTimers = ReturnType<typeof manualTimers>;

export interface MediaStack extends MockStack {
    clock: ManualTimers;
}

/** The plugin behind the mock, with one stored key, a billing clock the test drives and no wait between video polls. */
export async function startMediaStack(options: MockStackOptions = {}): Promise<MediaStack> {
    const clock = manualTimers();
    const stack = await startMockStack({
        ...options,
        media: { timers: clock.timers, pollIntervalMs: 0, ...options.media },
    });
    return Object.assign(stack, { clock });
}

/** A mono 8-bit 8 kHz WAV of `seconds` (silence), like the mock's own speech. */
export function wav(seconds: number): Buffer {
    const samples = seconds * 8000;
    const data = Buffer.alloc(44 + samples, 128);
    data.write('RIFF', 0, 'latin1');
    data.writeUInt32LE(36 + samples, 4);
    data.write('WAVEfmt ', 8, 'latin1');
    data.writeUInt32LE(8000, 28);
    return data;
}

/** The JSON lines of a user's usage files (records AND adjust lines), oldest file first. */
export function usageLines(root: string, user = 'default-user'): Record<string, any>[] {
    const dir = path.join(root, user, 'nanovia');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .flatMap((f) =>
            fs
                .readFileSync(path.join(dir, f), 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as Record<string, any>),
        );
}

/** Everything of a user's `nanovia` folder as text (the saved videos are skipped), for "no key anywhere" sweeps. */
export function userFolderText(root: string, user = 'default-user'): string {
    const dir = path.join(root, user, 'nanovia');
    if (!fs.existsSync(dir)) return '';
    const out: string[] = [];
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d)) {
            const full = path.join(d, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (!name.endsWith('.mp4')) out.push(fs.readFileSync(full, 'utf8'));
        }
    };
    walk(dir);
    return out.join('\n');
}

/** A fetch that adds headers to every call it forwards (`x-mock-error`, `x-mock-delay-ms` …). */
export function forcing(extra: () => Record<string, string>): FetchLike {
    const real = globalThis.fetch as unknown as FetchLike;
    return (url, init) => real(url, { ...init, headers: { ...init.headers, ...extra() } });
}

/** A multipart upload as the proxy's clients send it (OpenAI SDKs, ST). */
export function transcriptionForm(
    fields: Record<string, string>,
    file: Buffer | null = wav(1),
    filename = 'speech.wav',
): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    if (file) form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), filename);
    return form;
}
