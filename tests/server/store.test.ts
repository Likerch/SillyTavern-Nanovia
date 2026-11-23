import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import { createStore, writeFileAtomic } from '../../src/server/store';
import { hashToken } from '../../src/server/tokens';
import { cleanTempDirs, makeTempDir, recordingLogger } from './helpers';

afterEach(cleanTempDirs);

function setup() {
    const root = makeTempDir();
    const userRoot = path.join(root, 'default-user');
    const { log, lines } = recordingLogger();
    const store = createStore({ dataRoot: () => root, now: () => 1_000, log });
    return { root, userRoot, store, lines };
}

const conn = (id: string, name = 'Main') => createConnection({ name, modelId: 'glm-5' }, id, 10);

describe('connection store', () => {
    it('returns nothing for a missing file', () => {
        const { store, userRoot } = setup();
        expect(store.connections.list(userRoot)).toEqual([]);
        expect(store.connections.get(userRoot, 'abcd1234')).toBeNull();
    });

    it('round-trips connections and writes { version: 1, connections }', () => {
        const { store, userRoot } = setup();
        store.connections.save(userRoot, [conn('abcd1234'), conn('wxyz9876', 'Second')]);
        expect(store.connections.list(userRoot).map((c) => c.name)).toEqual(['Main', 'Second']);
        const raw = JSON.parse(fs.readFileSync(path.join(userRoot, 'nanovia', 'connections.json'), 'utf8'));
        expect(raw.version).toBe(1);
        expect(raw.connections).toHaveLength(2);
        expect(store.connections.get(userRoot, 'wxyz9876')?.name).toBe('Second');
    });

    it('leaves no temp files behind after a write', () => {
        const { store, userRoot } = setup();
        store.connections.save(userRoot, [conn('abcd1234')]);
        store.connections.save(userRoot, [conn('abcd1234', 'Renamed')]);
        expect(fs.readdirSync(path.join(userRoot, 'nanovia'))).toEqual(['connections.json']);
    });

    it('keeps the old file and removes its temp file when the rename fails', () => {
        const dir = makeTempDir();
        const target = path.join(dir, 'target.json');
        fs.mkdirSync(target); // a directory in the way: renaming a file over it fails
        expect(() => writeFileAtomic(target, '{}')).toThrow();
        expect(fs.readdirSync(dir)).toEqual(['target.json']);
        expect(fs.statSync(target).isDirectory()).toBe(true);
    });

    it('treats a corrupt file as empty, warns once, and keeps a copy before the next write', () => {
        const { store, userRoot, lines } = setup();
        const file = path.join(userRoot, 'nanovia', 'connections.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        expect(store.connections.list(userRoot)).toEqual([]);
        expect(store.connections.list(userRoot)).toEqual([]);
        expect(lines.filter((l) => l.startsWith('warn'))).toHaveLength(1);
        store.connections.save(userRoot, [conn('abcd1234')]);
        expect(fs.readFileSync(`${file}.corrupt`, 'utf8')).toBe('{ not json');
        expect(store.connections.list(userRoot)).toHaveLength(1);
    });

    it('tolerates wrong shapes, drops bad and duplicate entries and fills defaults', () => {
        const { store, userRoot } = setup();
        const file = path.join(userRoot, 'nanovia', 'connections.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ version: 1, connections: 'nope' }));
        expect(store.connections.list(userRoot)).toEqual([]);
        fs.writeFileSync(
            file,
            JSON.stringify({
                version: 1,
                connections: [
                    { id: 'abcd1234', name: 'Ok', modelId: 'm', mode: 'bogus', routing: { sort: 'price' } },
                    { id: 'abcd1234', name: 'Duplicate', modelId: 'm' },
                    { id: 'BAD!', name: 'Bad id', modelId: 'm' },
                    { id: 'wxyz9876', name: '', modelId: 'm' },
                    42,
                ],
            }),
        );
        // a different size than before so the cache notices even with an identical mtime
        const list = store.connections.list(userRoot);
        expect(list).toHaveLength(1);
        expect(list[0]?.name).toBe('Ok');
        expect(list[0]?.mode).toBe('auto');
        expect(list[0]?.routing.sort).toBe('price');
        expect(list[0]?.stripNeutralSamplers).toBe(true);
    });

    it('notices a file that changed on disk (mtime cache)', () => {
        const { store, userRoot } = setup();
        const file = path.join(userRoot, 'nanovia', 'connections.json');
        store.connections.save(userRoot, [conn('abcd1234')]);
        expect(store.connections.list(userRoot)[0]?.name).toBe('Main');
        const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
        edited.connections[0].name = 'Edited by hand!';
        fs.writeFileSync(file, JSON.stringify(edited));
        expect(store.connections.list(userRoot)[0]?.name).toBe('Edited by hand!');
    });

    it('returns copies, so a caller cannot corrupt the cache', () => {
        const { store, userRoot } = setup();
        store.connections.save(userRoot, [conn('abcd1234')]);
        const first = store.connections.list(userRoot);
        first[0]!.name = 'mutated';
        expect(store.connections.list(userRoot)[0]?.name).toBe('Main');
    });

    it('keeps users apart', () => {
        const { store, root } = setup();
        const a = path.join(root, 'a');
        const b = path.join(root, 'b');
        store.connections.save(a, [conn('abcd1234')]);
        expect(store.connections.list(b)).toEqual([]);
    });
});

describe('token registry', () => {
    it('stores hashes only and finds an entry by hash', () => {
        const { store, root } = setup();
        const hash = hashToken('secret-token');
        store.registry.mutate((r) => {
            r.tokens[hash] = { connectionId: 'abcd1234', userHandle: 'default-user', tokenSecretId: 's1' };
        });
        const file = fs.readFileSync(path.join(root, '_nanovia', 'registry.json'), 'utf8');
        expect(file).toContain(hash);
        expect(file).not.toContain('secret-token');
        expect(JSON.parse(file).version).toBe(1);
        expect(store.registry.lookup(hash)).toEqual({
            connectionId: 'abcd1234',
            userHandle: 'default-user',
            tokenSecretId: 's1',
        });
        expect(store.registry.lookup(hashToken('other'))).toBeNull();
        expect(store.registry.lookup('__proto__')).toBeNull();
    });

    it('drops malformed entries and survives a corrupt file', () => {
        const { store, root } = setup();
        const file = path.join(root, '_nanovia', 'registry.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const good = hashToken('x');
        fs.writeFileSync(
            file,
            JSON.stringify({
                version: 1,
                tokens: {
                    [good]: { connectionId: 'abcd1234', userHandle: 'u' },
                    nothex: { connectionId: 'abcd1234', userHandle: 'u' },
                    [hashToken('y')]: { connectionId: 'BAD', userHandle: 'u' },
                    [hashToken('z')]: { connectionId: 'abcd1234', userHandle: '' },
                },
            }),
        );
        expect(Object.keys(store.registry.read().tokens)).toEqual([good]);
        expect(store.registry.lookup(good)?.tokenSecretId).toBeNull();
        fs.writeFileSync(file, 'garbage');
        expect(store.registry.read().tokens).toEqual({});
    });

    it('mutate is a read-modify-write that keeps other entries', () => {
        const { store } = setup();
        const h1 = hashToken('1');
        const h2 = hashToken('2');
        store.registry.mutate((r) => {
            r.tokens[h1] = { connectionId: 'abcd1234', userHandle: 'u', tokenSecretId: null };
        });
        store.registry.mutate((r) => {
            r.tokens[h2] = { connectionId: 'wxyz9876', userHandle: 'u', tokenSecretId: null };
            delete r.tokens[h1];
        });
        expect(Object.keys(store.registry.read().tokens)).toEqual([h2]);
    });
});
