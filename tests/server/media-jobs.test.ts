/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    FileTooLarge,
    ID_PATTERN,
    JOBS_FILE,
    MAX_JOBS,
    createMediaJobStore,
    isJobId,
    isTerminal,
    normalizeStoredJob,
    type StoredJob,
} from '../../src/server/media-jobs';
import { cleanTempDirs, makeTempDir, recordingLogger } from './helpers';

afterEach(cleanTempDirs);

function job(id: string, over: Partial<StoredJob> = {}): StoredJob {
    return {
        id,
        model: 'kling-v25-turbo-std',
        prompt: 'a cat',
        status: 'queued',
        progress: null,
        createdAt: 1000,
        updatedAt: 1000,
        cost: { usd: 0.2, source: 'response', estimateUsd: 0.2, paymentSource: 'USD', remainingUsd: 1 },
        connectionId: null,
        output: null,
        error: null,
        keyId: null,
        usageAt: 1000,
        adjusted: false,
        ...over,
    };
}

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield part;
}

function make(maxJobs?: number) {
    const root = makeTempDir();
    const { log, lines } = recordingLogger();
    return { root, lines, store: createMediaJobStore({ log, ...(maxJobs !== undefined ? { maxJobs } : {}) }) };
}

describe('job ids and statuses', () => {
    it('lets only names that cannot be a path become file names', () => {
        for (const ok of ['vid_abc123', 'A-b_c', 'x'.repeat(128)]) expect(isJobId(ok), ok).toBe(true);
        for (const bad of ['', '../x', 'a/b', 'a\\b', 'a.b', 'a b', 'a:b', 'x'.repeat(129), '..', 5, null, undefined]) {
            expect(isJobId(bad), String(bad)).toBe(false);
        }
        expect(ID_PATTERN.test('vid_1')).toBe(true);
        expect(['queued', 'running', 'completed', 'failed', 'expired'].map((s) => isTerminal(s as any))).toEqual([
            false,
            false,
            true,
            true,
            true,
        ]);
    });
});

describe('normalizeStoredJob', () => {
    it('reads a stored job and gives every missing piece its neutral value', () => {
        expect(normalizeStoredJob({ id: 'vid_1', model: 'm', status: 'running', createdAt: 5 })).toEqual({
            id: 'vid_1',
            model: 'm',
            prompt: '',
            status: 'running',
            progress: null,
            createdAt: 5,
            updatedAt: 5,
            cost: { usd: null, source: 'unknown', estimateUsd: null, paymentSource: null, remainingUsd: null },
            connectionId: null,
            output: null,
            error: null,
            keyId: null,
            usageAt: 5,
            adjusted: false,
        });
    });

    it('clamps progress, drops unusable costs and links, and keeps what is sound', () => {
        const read = normalizeStoredJob({
            ...job('vid_2', { status: 'completed', progress: 7 }),
            cost: { usd: '0.5', source: 'lookup', estimateUsd: -1, paymentSource: 3, remainingUsd: 'x' },
            output: { kind: 'video', mime: '', url: 'ftp://x', file: '/media/files/vid_2', bytes: 12 },
            keyId: 'secret-1',
            adjusted: true,
            error: 'boom',
            connectionId: 'abc12345',
        });
        expect(read).toMatchObject({
            progress: 1,
            cost: { usd: 0.5, source: 'lookup', estimateUsd: null, paymentSource: null, remainingUsd: null },
            output: { kind: 'video', mime: 'video/mp4', file: '/media/files/vid_2', bytes: 12 },
            keyId: 'secret-1',
            adjusted: true,
            error: 'boom',
            connectionId: 'abc12345',
        });
        expect(read?.output?.url).toBeUndefined();
        expect(normalizeStoredJob({ ...job('vid_3'), progress: -4 })?.progress).toBe(0);
        expect(normalizeStoredJob({ ...job('vid_3'), output: { kind: 'image' } })?.output).toBeNull();
        expect(normalizeStoredJob({ ...job('vid_3'), cost: { usd: 1, source: 'weird' } })?.cost.source).toBe('unknown');
        expect(normalizeStoredJob({ ...job('vid_3'), cost: { usd: null, source: 'response' } })?.cost.source).toBe(
            'unknown',
        );
    });

    it('refuses what is not a job', () => {
        for (const bad of [
            null,
            'x',
            [],
            {},
            { id: '../evil', model: 'm', status: 'queued', createdAt: 1 },
            { id: 'vid_1', model: 'm', status: 'weird', createdAt: 1 },
            { id: 'vid_1', model: 'm', status: 'queued' },
            { id: 'vid_1', status: 'queued', createdAt: 1 },
        ]) {
            expect(normalizeStoredJob(bad), JSON.stringify(bad)).toBeNull();
        }
    });
});

describe('the job store', () => {
    it('adds, replaces, lists newest first and hands out copies', () => {
        const { store, root } = make();
        store.put(root, job('vid_a', { createdAt: 1 }));
        store.put(root, job('vid_b', { createdAt: 3 }));
        store.put(root, job('vid_c', { createdAt: 2 }));
        expect(store.list(root).map((j) => j.id)).toEqual(['vid_b', 'vid_c', 'vid_a']);
        store.put(root, job('vid_a', { createdAt: 1, status: 'running' }));
        expect(store.get(root, 'vid_a')?.status).toBe('running');
        expect(store.list(root)).toHaveLength(3);
        const copy = store.get(root, 'vid_a') as StoredJob;
        copy.status = 'failed';
        expect(store.get(root, 'vid_a')?.status).toBe('running');
        expect(store.get(root, 'missing')).toBeNull();
        expect(store.list(path.join(root, 'nobody'))).toEqual([]);
    });

    it('persists with an atomic write and reloads in a fresh store', () => {
        const { store, root, lines } = make();
        store.put(root, job('vid_a', { createdAt: 1, status: 'completed', keyId: 'k1' }));
        const file = path.join(root, 'nanovia', JOBS_FILE);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
            version: 1,
            jobs: [{ id: 'vid_a', keyId: 'k1' }],
        });
        expect(fs.readdirSync(path.join(root, 'nanovia')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
        const again = createMediaJobStore({ log: recordingLogger().log });
        expect(again.list(root)).toHaveLength(1);
        expect(again.get(root, 'vid_a')).toMatchObject({ status: 'completed', keyId: 'k1' });
        expect(lines).toEqual([]);
    });

    it('keeps at most the cap and deletes the saved files of what it drops', async () => {
        const { store, root } = make(2);
        store.put(root, job('vid_a', { createdAt: 1 }));
        await store.saveFile(root, 'vid_a', chunks(Buffer.from('aa')), 100);
        store.put(root, job('vid_b', { createdAt: 2 }));
        expect(store.hasFile(root, 'vid_a')).toBe(true);
        store.put(root, job('vid_c', { createdAt: 3 }));
        expect(store.list(root).map((j) => j.id)).toEqual(['vid_c', 'vid_b']);
        expect(store.hasFile(root, 'vid_a')).toBe(false);
        expect(MAX_JOBS).toBe(100);
        // The default cap is 100.
        const big = make();
        for (let i = 0; i < 105; i += 1) big.store.put(big.root, job(`vid_${i}`, { createdAt: i }));
        expect(big.store.list(big.root)).toHaveLength(100);
        expect(big.store.get(big.root, 'vid_4')).toBeNull();
        expect(big.store.get(big.root, 'vid_5')).not.toBeNull();
    });

    it('removes a job with its file and reports what it removed', async () => {
        const { store, root } = make();
        store.put(root, job('vid_a'));
        await store.saveFile(root, 'vid_a', chunks(Buffer.from('bytes')), 100);
        expect(store.remove(root, 'vid_a')).toMatchObject({ id: 'vid_a' });
        expect(store.hasFile(root, 'vid_a')).toBe(false);
        expect(store.get(root, 'vid_a')).toBeNull();
        expect(store.remove(root, 'vid_a')).toBeNull();
        // A file of an id nobody knows can still be discarded.
        await store.saveFile(root, 'vid_orphan', chunks(Buffer.from('x')), 100);
        store.discardFile(root, 'vid_orphan');
        expect(store.hasFile(root, 'vid_orphan')).toBe(false);
        store.discardFile(root, 'vid_orphan');
    });

    it('refuses to build a path from anything but a job id', () => {
        const { store, root } = make();
        expect(() => store.filePath(root, '../../etc/passwd')).toThrow();
        expect(() => store.filePath(root, 'a/b')).toThrow();
        expect(store.filePath(root, 'vid_ok')).toBe(path.join(root, 'nanovia', 'media', 'vid_ok.mp4'));
        expect(store.hasFile(root, '../x')).toBe(false);
        expect(() => store.discardFile(root, '../x')).not.toThrow();
    });

    it('streams a file in, whole or not at all', async () => {
        const { store, root } = make();
        const size = await store.saveFile(root, 'vid_a', chunks(Buffer.from('abc'), Buffer.from('defg')), 100);
        expect(size).toBe(7);
        expect(fs.readFileSync(store.filePath(root, 'vid_a'), 'utf8')).toBe('abcdefg');
        // Over the cap: refused, and neither the target nor a part file is left.
        await expect(
            store.saveFile(root, 'vid_b', chunks(Buffer.alloc(60), Buffer.alloc(60)), 100),
        ).rejects.toBeInstanceOf(FileTooLarge);
        expect(store.hasFile(root, 'vid_b')).toBe(false);
        // A source that fails half way: same.
        async function* failing(): AsyncGenerator<Uint8Array> {
            yield Buffer.from('half');
            throw new Error('connection reset');
        }
        await expect(store.saveFile(root, 'vid_c', failing(), 100)).rejects.toThrow('connection reset');
        expect(store.hasFile(root, 'vid_c')).toBe(false);
        expect(fs.readdirSync(path.join(root, 'nanovia', 'media')).filter((n) => n.endsWith('.part'))).toEqual([]);
        // A second save replaces the first.
        await store.saveFile(root, 'vid_a', chunks(Buffer.from('new')), 100);
        expect(fs.readFileSync(store.filePath(root, 'vid_a'), 'utf8')).toBe('new');
    });

    it('sweeps half-saved downloads of an earlier run when a user is first loaded', () => {
        const { store, root } = make();
        const dir = path.join(root, 'nanovia', 'media');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'vid_a.mp4.1234.part'), 'half');
        fs.writeFileSync(path.join(dir, 'vid_a.mp4'), 'whole');
        store.list(root);
        expect(fs.readdirSync(dir)).toEqual(['vid_a.mp4']);
    });

    it('treats a missing file as nothing and a damaged one as nothing with a warning', () => {
        const { store, root, lines } = make();
        expect(store.list(root)).toEqual([]);
        expect(lines).toEqual([]);
        const damaged = make();
        fs.mkdirSync(path.join(damaged.root, 'nanovia'), { recursive: true });
        fs.writeFileSync(path.join(damaged.root, 'nanovia', JOBS_FILE), '{ not json');
        expect(damaged.store.list(damaged.root)).toEqual([]);
        expect(damaged.lines).toEqual(['warn media-jobs.json is unreadable and is treated as empty']);
        // And it is usable afterwards.
        damaged.store.put(damaged.root, job('vid_a'));
        expect(damaged.store.list(damaged.root)).toHaveLength(1);
    });
});
