// File stores (docs/ARCHITECTURE.md §3):
//   <user root>/nanovia/connections.json  { version: 1, connections: ConnectionConfig[] }
//   <data root>/_nanovia/registry.json    { version: 1, tokens: { [sha256(token)]: { connectionId, userHandle } } }
// Reads are cached by mtime and size, writes go to a temp file that is renamed over the target, and every read is
// tolerant: a missing, empty or corrupt file means "nothing stored", a bad entry is dropped. All I/O is synchronous so a
// read-modify-write never interleaves with another request.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConnectionConfig } from '../shared/contracts';
import { isValidConnectionId, normalizeConnection } from '../domain/connection';
import type { Logger } from './types';

export const STORE_VERSION = 1;
export const CONNECTIONS_FILE = 'connections.json';
export const REGISTRY_FILE = 'registry.json';
export const USER_DIR_NAME = 'nanovia';
export const GLOBAL_DIR_NAME = '_nanovia';

export interface RegistryEntry {
    connectionId: string;
    userHandle: string;
    /** Id of the ST secret (under api_key_custom) that holds the token itself. */
    tokenSecretId: string | null;
}

export interface Registry {
    version: typeof STORE_VERSION;
    tokens: Record<string, RegistryEntry>;
}

export interface ConnectionStore {
    list(userRoot: string): ConnectionConfig[];
    get(userRoot: string, id: string): ConnectionConfig | null;
    /** Replaces the whole list. */
    save(userRoot: string, connections: ConnectionConfig[]): void;
}

export interface RegistryStore {
    read(): Registry;
    lookup(tokenHash: string): RegistryEntry | null;
    /** Read-modify-write: `change` edits the registry in place, the result is written atomically. */
    mutate(change: (registry: Registry) => void): void;
}

export interface Store {
    connections: ConnectionStore;
    registry: RegistryStore;
    /** `<user root>/nanovia`. */
    userDir(userRoot: string): string;
}

export interface StoreOptions {
    /** The ST data root: the global registry lives under it. */
    dataRoot: () => string;
    now: () => number;
    log: Logger;
}

/** A JSON file with an mtime cache, atomic writes and tolerant reads. */
class JsonFile<T> {
    private cache: { mtimeMs: number; size: number; value: T } | null = null;
    /** The file on disk could not be parsed at the last read: it is copied aside before the next write. */
    private corrupt = false;

    constructor(
        private readonly file: () => string,
        private readonly parse: (raw: unknown) => T,
        private readonly serialize: (value: T) => unknown,
        private readonly empty: () => T,
        private readonly log: Logger,
    ) {}

    read(): T {
        const file = this.file();
        let stat: fs.Stats;
        try {
            stat = fs.statSync(file);
        } catch {
            this.cache = null;
            return this.empty();
        }
        if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
            return structuredClone(this.cache.value);
        }
        let value: T;
        try {
            value = this.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
            this.corrupt = false;
        } catch {
            this.log.warn(`${path.basename(file)} is unreadable and is treated as empty`);
            this.corrupt = true;
            value = this.empty();
        }
        this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
        return structuredClone(value);
    }

    write(value: T): void {
        const file = this.file();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (this.corrupt) {
            try {
                fs.copyFileSync(file, `${file}.corrupt`);
            } catch {
                // the copy is a courtesy
            }
            this.corrupt = false;
        }
        writeFileAtomic(file, `${JSON.stringify(this.serialize(value), null, 2)}\n`);
        try {
            const stat = fs.statSync(file);
            this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, value: structuredClone(value) };
        } catch {
            this.cache = null;
        }
    }
}

/** Writes to a temp file next to the target and renames it over it, so a reader never sees half a file. */
export function writeFileAtomic(file: string, text: string): void {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
        let lastError: unknown;
        // Windows can refuse a rename for a moment while a virus scanner or an indexer holds the target.
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                fs.renameSync(tmp, file);
                return;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    } catch (error) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            // nothing more to do
        }
        throw error;
    }
}

function parseConnections(raw: unknown, now: number): ConnectionConfig[] {
    if (!isRecord(raw) || !Array.isArray(raw['connections'])) return [];
    const out: ConnectionConfig[] = [];
    const seen = new Set<string>();
    for (const item of raw['connections'] as unknown[]) {
        const connection = normalizeConnection(item, now);
        if (!connection || seen.has(connection.id)) continue;
        seen.add(connection.id);
        out.push(connection);
    }
    return out;
}

const TOKEN_HASH = /^[0-9a-f]{64}$/;

function parseRegistry(raw: unknown): Registry {
    const registry = emptyRegistry();
    if (!isRecord(raw) || !isRecord(raw['tokens'])) return registry;
    for (const [hash, entry] of Object.entries(raw['tokens'])) {
        if (!TOKEN_HASH.test(hash) || !isRecord(entry)) continue;
        const { connectionId, userHandle, tokenSecretId } = entry;
        if (!isValidConnectionId(connectionId) || typeof userHandle !== 'string' || !userHandle) continue;
        registry.tokens[hash] = {
            connectionId,
            userHandle,
            tokenSecretId: typeof tokenSecretId === 'string' && tokenSecretId ? tokenSecretId : null,
        };
    }
    return registry;
}

function emptyRegistry(): Registry {
    return { version: STORE_VERSION, tokens: {} };
}

export function createStore(options: StoreOptions): Store {
    const { dataRoot, now, log } = options;
    const userFiles = new Map<string, JsonFile<ConnectionConfig[]>>();

    const connectionsFile = (userRoot: string): JsonFile<ConnectionConfig[]> => {
        let file = userFiles.get(userRoot);
        if (!file) {
            file = new JsonFile<ConnectionConfig[]>(
                () => path.join(userRoot, USER_DIR_NAME, CONNECTIONS_FILE),
                (raw) => parseConnections(raw, now()),
                (connections) => ({ version: STORE_VERSION, connections }),
                () => [],
                log,
            );
            userFiles.set(userRoot, file);
        }
        return file;
    };

    const registryFile = new JsonFile<Registry>(
        () => path.join(dataRoot(), GLOBAL_DIR_NAME, REGISTRY_FILE),
        parseRegistry,
        (registry) => registry,
        emptyRegistry,
        log,
    );

    return {
        userDir: (userRoot) => path.join(userRoot, USER_DIR_NAME),
        connections: {
            list: (userRoot) => connectionsFile(userRoot).read(),
            get: (userRoot, id) => connectionsFile(userRoot).read().find((c) => c.id === id) ?? null,
            save: (userRoot, connections) => connectionsFile(userRoot).write(connections),
        },
        registry: {
            read: () => registryFile.read(),
            lookup: (tokenHash) => {
                const tokens = registryFile.read().tokens;
                return Object.hasOwn(tokens, tokenHash) ? (tokens[tokenHash] ?? null) : null;
            },
            mutate: (change) => {
                const registry = registryFile.read();
                change(registry);
                registryFile.write(registry);
            },
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
