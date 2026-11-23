// The usage log: one UsageRecord per line in `<user root>/nanovia/usage-YYYY-MM-DD.jsonl` (UTC day of `at`). Best effort:
// a failure to write is logged and swallowed, a request never fails because of its bookkeeping; reading skips what it
// cannot parse (a half-written line after a crash, a hand edit) instead of failing.
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { applyUsageAdjustments, parseUsageAdjustment, type UsageAdjustment } from '../domain/media-wire';
import type { BillingOutcome, RequestHints, UsageRecord } from '../shared/contracts';
import { MEDIA_MEDIA } from '../shared/contracts-media';
import { USER_DIR_NAME } from './store';
import type { Logger } from './types';

export interface UsageLog {
    append(userRoot: string, record: UsageRecord): Promise<void>;
    /**
     * Appends a correction (`{ adjust: true, requestId, costUsd, costSource, at }`) to the file of the day of the record it
     * corrects (`recordAt` is that record's `at`). Stage 0.7: a media call's real charge is known only after the call.
     */
    adjust(userRoot: string, recordAt: number, adjustment: UsageAdjustment): Promise<void>;
    /**
     * Records with `from <= at < to`, oldest day first, in file order, with the corrections of their files applied (so
     * every summary already sees the corrected cost). Corrupt lines and unreadable files are skipped.
     */
    read(userRoot: string, range: { from: number; to: number }): Promise<UsageRecord[]>;
}

const FILE_PATTERN = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** The days a log can name: from the epoch to the last instant of year 9999 (so a day is always YYYY-MM-DD). */
const MAX_TIME = 253_402_300_799_999;

export function usageFileName(at: number): string {
    return `usage-${new Date(at).toISOString().slice(0, 10)}.jsonl`;
}

/** The UTC day (`YYYY-MM-DD`) of an instant; clamped to 1970..9999 so any number gives a day. */
export function utcDay(at: number): string {
    const clamped = Math.min(MAX_TIME, Math.max(0, Number.isFinite(at) ? at : 0));
    return new Date(clamped).toISOString().slice(0, 10);
}

const OUTCOMES: readonly BillingOutcome[] = ['subscription', 'paygo', 'unknown'];
const CONSUMERS: ReadonlyArray<RequestHints['consumer']> = ['main', 'background', 'unknown'];
const MEDIUMS: ReadonlyArray<NonNullable<UsageRecord['medium']>> = [...MEDIA_MEDIA, 'chat'];
const COST_SOURCES: ReadonlyArray<NonNullable<UsageRecord['costSource']>> = [
    'response',
    'lookup',
    'estimate',
    'unknown',
];

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/** One line of a usage file as a UsageRecord, tolerant of missing fields; null when it is not a record at all. */
export function parseUsageRecord(line: string): UsageRecord | null {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (r['adjust'] === true) return null; // a correction, not a request (see parseUsageLine)
    const at = count(r['at']);
    if (at === null) return null;
    const billing = OUTCOMES.find((o) => o === r['billing']);
    const consumer = CONSUMERS.find((c) => c === r['consumer']);
    const medium = MEDIUMS.find((m) => m === r['medium']);
    const costSource = COST_SOURCES.find((s) => s === r['costSource']);
    const units = count(r['units']);
    return {
        at,
        connectionId: text(r['connectionId']),
        requestId: text(r['requestId']),
        model: text(r['model']) ?? 'unknown',
        billing: billing ?? 'unknown',
        costUsd: count(r['costUsd']),
        equivalentUsd: count(r['equivalentUsd']),
        promptTokens: count(r['promptTokens']),
        completionTokens: count(r['completionTokens']),
        cachedTokens: count(r['cachedTokens']),
        reasoningTokens: count(r['reasoningTokens']),
        latencyMs: count(r['latencyMs']) ?? 0,
        status: count(r['status']) ?? 0,
        stream: r['stream'] === true,
        consumer: consumer ?? 'unknown',
        error: text(r['error']),
        // Stage 0.7 fields: present only when the line has them, so a chat record reads back exactly as before.
        ...(medium ? { medium } : {}),
        ...(r['units'] !== undefined ? { units } : {}),
        ...(costSource ? { costSource } : {}),
    };
}

/** One line of a usage file: a request, a correction of one, or neither (null). */
export type UsageLine = { kind: 'record'; record: UsageRecord } | { kind: 'adjust'; adjustment: UsageAdjustment };

export function parseUsageLine(line: string): UsageLine | null {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return null;
    }
    const adjustment = parseUsageAdjustment(raw);
    if (adjustment) return { kind: 'adjust', adjustment };
    const record = parseUsageRecord(line);
    return record ? { kind: 'record', record } : null;
}

export function createUsageLog(log: Logger): UsageLog {
    const appendLine = async (userRoot: string, at: number, value: unknown): Promise<void> => {
        const dir = path.join(userRoot, USER_DIR_NAME);
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(path.join(dir, usageFileName(at)), `${JSON.stringify(value)}\n`, 'utf8');
    };
    return {
        async append(userRoot, record) {
            try {
                await appendLine(userRoot, record.at, record);
            } catch (error) {
                log.warn(`usage record not written (${error instanceof Error ? error.message : 'unknown error'})`);
            }
        },

        async adjust(userRoot, recordAt, adjustment) {
            try {
                await appendLine(userRoot, recordAt, adjustment);
            } catch (error) {
                log.warn(`usage correction not written (${error instanceof Error ? error.message : 'unknown error'})`);
            }
        },

        async read(userRoot, range) {
            const dir = path.join(userRoot, USER_DIR_NAME);
            let names: string[];
            try {
                names = await fs.readdir(dir);
            } catch {
                return []; // no directory yet: nothing was ever logged
            }
            const first = utcDay(range.from);
            const last = utcDay(range.to - 1);
            const files = names
                .flatMap((name) => {
                    const day = FILE_PATTERN.exec(name)?.[1];
                    return day !== undefined && day >= first && day <= last ? [{ name, day }] : [];
                })
                .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
            const records: UsageRecord[] = [];
            const adjustments: UsageAdjustment[] = [];
            for (const file of files) {
                try {
                    await readLines(path.join(dir, file.name), (line) => {
                        const parsed = parseUsageLine(line);
                        if (!parsed) return;
                        if (parsed.kind === 'adjust') adjustments.push(parsed.adjustment);
                        else if (parsed.record.at >= range.from && parsed.record.at < range.to)
                            records.push(parsed.record);
                    });
                } catch (error) {
                    log.warn(
                        `usage file ${file.name} not read (${error instanceof Error ? error.message : 'unknown error'})`,
                    );
                }
            }
            return applyUsageAdjustments(records, adjustments);
        },
    };
}

async function readLines(file: string, onLine: (line: string) => void): Promise<void> {
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (line.trim()) onLine(line);
        }
    } finally {
        lines.close();
        input.destroy();
    }
}
