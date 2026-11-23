// The usage log: one UsageRecord per line in `<user root>/nanovia/usage-YYYY-MM-DD.jsonl` (UTC day). Best effort: a
// failure to write is logged and swallowed, a request never fails because of its bookkeeping.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { UsageRecord } from '../shared/contracts';
import { USER_DIR_NAME } from './store';
import type { Logger } from './types';

export interface UsageLog {
    append(userRoot: string, record: UsageRecord): Promise<void>;
}

export function usageFileName(at: number): string {
    return `usage-${new Date(at).toISOString().slice(0, 10)}.jsonl`;
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
    };
}
