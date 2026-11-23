import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../src/shared/contracts';
import { createUsageLog, parseUsageLine, parseUsageRecord, usageFileName } from '../../src/server/usage-log';
import { cleanTempDirs, makeTempDir, recordingLogger } from './helpers';

afterEach(cleanTempDirs);

const DAY = Date.parse('2026-03-05T12:00:00Z');
const NEXT_DAY = Date.parse('2026-03-06T08:00:00Z');

function record(over: Partial<UsageRecord> = {}): UsageRecord {
    return {
        at: DAY,
        connectionId: null,
        requestId: 'media-image:1',
        model: 'rev-animated',
        billing: 'paygo',
        costUsd: 0.0017,
        equivalentUsd: 0.0017,
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
        latencyMs: 10,
        status: 200,
        stream: false,
        consumer: 'unknown',
        error: null,
        medium: 'image',
        units: 1,
        costSource: 'response',
        ...over,
    };
}

const adjustment = (over: Record<string, unknown> = {}) => ({
    adjust: true as const,
    requestId: 'media-image:1',
    costUsd: 0.00255,
    costSource: 'lookup' as const,
    at: NEXT_DAY,
    ...over,
});

const everything = { from: 0, to: Date.parse('2030-01-01T00:00:00Z') };

describe('usage lines: records, adjustments and the stage 0.7 fields', () => {
    it('reads medium, units and costSource back, and leaves a chat record exactly as it was', () => {
        expect(parseUsageRecord(JSON.stringify(record()))).toMatchObject({
            medium: 'image',
            units: 1,
            costSource: 'response',
        });
        const chat = parseUsageRecord('{"at":5,"model":"glm-5"}');
        expect(chat).not.toHaveProperty('medium');
        expect(chat).not.toHaveProperty('units');
        expect(chat).not.toHaveProperty('costSource');
        // Odd values: an unknown medium or source is dropped, bad units become null.
        const odd = parseUsageRecord('{"at":5,"medium":"smell","costSource":"vibes","units":"many"}');
        expect(odd).not.toHaveProperty('medium');
        expect(odd).not.toHaveProperty('costSource');
        expect(odd).toMatchObject({ units: null });
        expect(parseUsageRecord('{"at":5,"medium":"chat"}')).toMatchObject({ medium: 'chat' });
    });

    it('tells a record from an adjustment, and an adjustment is never a record', () => {
        const line = JSON.stringify(adjustment());
        expect(parseUsageRecord(line)).toBeNull();
        expect(parseUsageLine(line)).toEqual({ kind: 'adjust', adjustment: adjustment() });
        expect(parseUsageLine(JSON.stringify(record()))).toMatchObject({
            kind: 'record',
            record: { model: 'rev-animated' },
        });
        expect(parseUsageLine('not json')).toBeNull();
        expect(parseUsageLine('{"adjust":true,"requestId":"x"}')).toBeNull(); // a correction without a figure
        expect(parseUsageLine('{"nothing":1}')).toBeNull();
    });
});

describe('UsageLog.adjust and read', () => {
    it('appends the correction to the file of the record it corrects and read() applies it', async () => {
        const root = makeTempDir();
        const log = createUsageLog(recordingLogger().log);
        await log.append(root, record());
        await log.adjust(root, DAY, adjustment());
        const file = path.join(root, 'nanovia', usageFileName(DAY));
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[1] as string)).toEqual(adjustment());
        const read = await log.read(root, everything);
        expect(read).toHaveLength(1);
        expect(read[0]).toMatchObject({
            costUsd: 0.00255,
            costSource: 'lookup',
            equivalentUsd: 0.00255,
            requestId: 'media-image:1',
        });
    });

    it('files the correction under the day of the record, not the day it was made', async () => {
        const root = makeTempDir();
        const log = createUsageLog(recordingLogger().log);
        await log.append(root, record());
        await log.adjust(root, DAY, adjustment({ at: NEXT_DAY }));
        const dir = path.join(root, 'nanovia');
        expect(fs.readdirSync(dir).sort()).toEqual([usageFileName(DAY)]);
        // A range that covers only the record's day sees the corrected figure.
        const day = await log.read(root, {
            from: Date.parse('2026-03-05T00:00:00Z'),
            to: Date.parse('2026-03-06T00:00:00Z'),
        });
        expect(day[0]?.costUsd).toBe(0.00255);
        // A range that misses the record's day does not see it at all.
        expect(
            await log.read(root, { from: Date.parse('2026-03-06T00:00:00Z'), to: Date.parse('2026-03-07T00:00:00Z') }),
        ).toEqual([]);
    });

    it('lets the latest correction win and leaves other records and chat records alone', async () => {
        const root = makeTempDir();
        const log = createUsageLog(recordingLogger().log);
        const chat = record({
            medium: undefined,
            units: undefined,
            costSource: undefined,
            requestId: 'req-1',
            costUsd: 0.5,
        });
        await log.append(root, record());
        await log.append(root, record({ requestId: 'media-image:2', at: DAY + 1 }));
        await log.append(root, chat);
        await log.adjust(root, DAY, adjustment({ costUsd: 1, at: 100 }));
        await log.adjust(root, DAY, adjustment({ costUsd: 2, at: 200 }));
        await log.adjust(root, DAY, adjustment({ requestId: 'unknown-id', costUsd: 9 }));
        const read = await log.read(root, everything);
        expect(read.map((r) => r.costUsd)).toEqual([2, 0.0017, 0.5]);
        expect(read[2]).toBe(read.find((r) => r.requestId === 'req-1'));
    });

    it('skips corrupt lines and a corrupt adjustment, and survives an unwritable directory', async () => {
        const root = makeTempDir();
        const { log, lines } = recordingLogger();
        const usage = createUsageLog(log);
        await usage.append(root, record());
        fs.appendFileSync(
            path.join(root, 'nanovia', usageFileName(DAY)),
            'garbage\n{"adjust":true,"requestId":"media-image:1","costUsd":"lots","at":1}\n',
        );
        expect((await usage.read(root, everything))[0]?.costUsd).toBe(0.0017);
        // The log lives where a file blocks the directory: bookkeeping fails quietly, with a warning.
        const blocked = makeTempDir();
        fs.writeFileSync(path.join(blocked, 'nanovia'), 'a file');
        await usage.adjust(blocked, DAY, adjustment());
        await usage.append(blocked, record());
        expect(lines.some((l) => l.includes('usage correction not written'))).toBe(true);
        expect(lines.some((l) => l.includes('usage record not written'))).toBe(true);
    });
});
