// The usage log: one UsageRecord per line in `<user root>/nanovia/usage-YYYY-MM-DD.jsonl` (UTC day of `at`). Best effort:
// a failure to write is logged and swallowed, a request never fails because of its bookkeeping; reading skips what it
// cannot parse (a half-written line after a crash, a hand edit) instead of failing.
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { BillingOutcome, RequestHints, UsageRecord } from '../shared/contracts';
import { USER_DIR_NAME } from './store';
import type { Logger } from './types';

export interface UsageLog {
    append(userRoot: string, record: UsageRecord): Promise<void>;
    /** Records with `from <= at < to`, oldest day first, in file order. Corrupt lines and unreadable files are skipped. */
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
    const at = count(r['at']);
    if (at === null) return null;
    const billing = OUTCOMES.find((o) => o === r['billing']);
    const consumer = CONSUMERS.find((c) => c === r['consumer']);
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
    };
}

export function createUsageLog(log: Logger): UsageLog {
    return {
        async append(userRoot, record) {
            try {
                const dir = path.join(userRoot, USER_DIR_NAME);
                await fs.mkdir(dir, { recursive: true });
                await fs.appendFile(path.join(dir, usageFileName(record.at)), `${JSON.stringify(record)}\n`, 'utf8');
            } catch (error) {
                log.warn(`usage record not written (${error instanceof Error ? error.message : 'unknown error'})`);
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
            for (const file of files) {
                try {
                    await readLines(path.join(dir, file.name), (line) => {
                        const record = parseUsageRecord(line);
                        if (record && record.at >= range.from && record.at < range.to) records.push(record);
                    });
                } catch (error) {
                    log.warn(
                        `usage file ${file.name} not read (${error instanceof Error ? error.message : 'unknown error'})`,
                    );
                }
            }
            return records;
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
