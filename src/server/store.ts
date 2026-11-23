// File stores (docs/ARCHITECTURE.md §3):
//   <user root>/nanovia/connections.json  { version: 1, connections: ConnectionConfig[] }
//   <data root>/_nanovia/registry.json    { version: 1, tokens: { [sha256(token)]: { connectionId, userHandle } } }
//   <user root>/nanovia/mgmt.json         { version: 1, token, check: { valid, checkedAt, error } }  (the Management token:
//                                         write-only for every route, file mode 0600 where the OS has modes)
// Reads are cached by mtime and size, writes go to a temp file that is renamed over the target, and every read is
// tolerant: a missing, empty or corrupt file means "nothing stored", a bad entry is dropped. All I/O is synchronous so a
// read-modify-write never interleaves with another request.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConnectionConfig } from '../shared/contracts';
import type { MgmtErrorCode } from '../shared/contracts-mgmt';
import { isValidConnectionId, normalizeConnection } from '../domain/connection';
import type { Logger } from './types';

export const STORE_VERSION = 1;
export const CONNECTIONS_FILE = 'connections.json';
export const REGISTRY_FILE = 'registry.json';
export const MGMT_FILE = 'mgmt.json';
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

/** The outcome of the last contact with NanoGPT for a Management token (what GET /mgmt/status reports). */
export interface MgmtCheck {
    valid: boolean | null;
    checkedAt: number | null;
    error: MgmtErrorCode | null;
}

export interface MgmtRecord {
    /** The Management token. Only the plugin's own calls to NanoGPT read it; it is never returned, logged or echoed. */
    token: string;
    check: MgmtCheck;
}

/** One Management token per ST user, kept in the user's own folder. */
export interface MgmtStore {
    read(userRoot: string): MgmtRecord | null;
    /** Replaces the record (atomic write). */
    write(userRoot: string, record: MgmtRecord): void;
    /** Deletes the file. No error when there is none. */
    clear(userRoot: string): void;
}

export interface Store {
    connections: ConnectionStore;
    registry: RegistryStore;
    mgmt: MgmtStore;
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

    /** Deletes the file and the aside copy of a corrupt one (no error when they are not there); forgets the cache. */
    remove(): void {
        const file = this.file();
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.corrupt`, { force: true });
        this.cache = null;
        this.corrupt = false;
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

const MGMT_ERRORS: readonly MgmtErrorCode[] = [
    'mgmt_token_invalid',
    'upstream_unreachable',
    'upstream_timeout',
    'upstream_error',
    'rate_limited',
];
const STORABLE_TOKEN = /^[!-~]{1,512}$/;

/** A record needs a token that is one printable word; the check block is optional and read leniently. */
function parseMgmt(raw: unknown): MgmtRecord | null {
    if (!isRecord(raw)) return null;
    const token = raw['token'];
    if (typeof token !== 'string' || !STORABLE_TOKEN.test(token)) return null;
    const check = isRecord(raw['check']) ? raw['check'] : {};
    const error = MGMT_ERRORS.find((code) => code === check['error']) ?? null;
    const checkedAt = check['checkedAt'];
    return {
        token,
        check: {
            valid: typeof check['valid'] === 'boolean' ? check['valid'] : null,
            checkedAt: typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? checkedAt : null,
            error,
        },
    };
}

function emptyRegistry(): Registry {
    return { version: STORE_VERSION, tokens: {} };
}

export function createStore(options: StoreOptions): Store {
    const { dataRoot, now, log } = options;
    const userFiles = new Map<string, JsonFile<ConnectionConfig[]>>();
    const mgmtFiles = new Map<string, JsonFile<MgmtRecord | null>>();

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

    const mgmtFile = (userRoot: string): JsonFile<MgmtRecord | null> => {
        let file = mgmtFiles.get(userRoot);
        if (!file) {
            file = new JsonFile<MgmtRecord | null>(
                () => path.join(userRoot, USER_DIR_NAME, MGMT_FILE),
                parseMgmt,
                (record) => ({ version: STORE_VERSION, ...record }),
                () => null,
                log,
            );
            mgmtFiles.set(userRoot, file);
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
            get: (userRoot, id) =>
                connectionsFile(userRoot)
                    .read()
                    .find((c) => c.id === id) ?? null,
            save: (userRoot, connections) => connectionsFile(userRoot).write(connections),
        },
        mgmt: {
            read: (userRoot) => mgmtFile(userRoot).read(),
            write: (userRoot, record) => mgmtFile(userRoot).write(record),
            clear: (userRoot) => mgmtFile(userRoot).remove(),
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
