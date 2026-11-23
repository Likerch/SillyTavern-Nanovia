// Where the catalog snapshot (~700 KB) is kept between page loads: IndexedDB through ST's own localforage
// (`SillyTavern.libs.localforage`), so it neither bloats `extension_settings` nor travels to the server. When IndexedDB
// or the library is missing (private window, blocked site data, a test) the snapshot lives in memory for the session.
// Nothing here throws: a failed read is "nothing stored", a failed write is only logged.
import type { Logger } from './types';

export const CATALOG_STORAGE_VERSION = 1;
const DB_NAME = 'nanovia';
const STORE_NAME = 'catalog';
const SNAPSHOT_KEY = 'snapshot';

/** What is stored: the models are in the contract shape (CatalogModel[]), read back through `readCatalogModels`. */
export interface StoredCatalog {
    version: number;
    fetchedAt: number;
    models: unknown;
}

export interface CatalogStorage {
    load(): Promise<StoredCatalog | null>;
    save(value: StoredCatalog): Promise<void>;
}

/** Keeps the snapshot in memory only (the fallback, and what tests use). */
export function createMemoryCatalogStorage(initial: StoredCatalog | null = null): CatalogStorage {
    let held = initial;
    return {
        load: async () => held,
        save: async (value) => {
            held = value;
        },
    };
}

function isStored(value: unknown): value is StoredCatalog {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        record['version'] === CATALOG_STORAGE_VERSION &&
        typeof record['fetchedAt'] === 'number' &&
        Number.isFinite(record['fetchedAt']) &&
        Array.isArray(record['models'])
    );
}

/** IndexedDB through ST's localforage; falls back to memory when it cannot be opened or used. */
export function createCatalogStorage(log: Logger): CatalogStorage {
    const memory = createMemoryCatalogStorage();
    let instance: STLocalForage | null | undefined;

    function store(): STLocalForage | null {
        if (instance !== undefined) return instance;
        try {
            const forage = globalThis.SillyTavern?.libs?.localforage;
            instance = forage ? forage.createInstance({ name: DB_NAME, storeName: STORE_NAME }) : null;
        } catch (error) {
            log.debug('localforage is not usable; the catalog is kept in memory', error);
            instance = null;
        }
        return instance;
    }

    return {
        async load() {
            const forage = store();
            if (forage) {
                try {
                    const value = await forage.getItem<unknown>(SNAPSHOT_KEY);
                    if (isStored(value)) return value;
                } catch (error) {
                    log.debug('the stored catalog could not be read', error);
                }
            }
            return memory.load();
        },

        async save(value) {
            await memory.save(value);
            const forage = store();
            if (!forage) return;
            try {
                await forage.setItem(SNAPSHOT_KEY, value);
            } catch (error) {
                log.debug('the catalog could not be stored', error);
            }
        },
    };
}
