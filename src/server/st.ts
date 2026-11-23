// The real adapter over SillyTavern's internals. ST's own modules are imported by a computed URL relative to the plugin
// folder (`<ST>/plugins/nanovia/index.js` -> `<ST>/src/...`), so the bundler never sees them and the plugin still loads
// (degraded: `available: false`) when they cannot be found, exactly like NAI Studio's plugin.
import path from 'node:path';
import type { Logger, SecretEntry, StServices } from './types';

interface SecretManagerLike {
    getAllSecrets(): Record<string, unknown>;
    readSecret(key: string, id: string | null): string;
    writeSecret(key: string, value: string, label: string): string;
    renameSecret(key: string, id: string, label: string): void;
    rotateSecret(key: string, id: string): void;
    deleteSecret(key: string, id: string | null): void;
}

interface SecretsModule {
    SecretManager: new (directories: unknown) => SecretManagerLike;
}

interface UsersModule {
    getUserDirectories(handle: string): { root: string };
}

export interface StModuleUrls {
    secrets: string;
    users: string;
}

/** Default locations: two levels up from the plugin folder. */
export function defaultStModuleUrls(base: string = import.meta.url): StModuleUrls {
    return {
        secrets: new URL('../../src/endpoints/secrets.js', base).href,
        users: new URL('../../src/users.js', base).href,
    };
}

/** A handle is a directory name; anything that could leave the data root is refused. */
export function assertSafeHandle(handle: string): void {
    if (!handle || handle === '.' || handle === '..' || /[\\/\0]/.test(handle)) {
        throw new Error('invalid user handle');
    }
}

function currentDataRoot(): string {
    const root = (globalThis as { DATA_ROOT?: unknown }).DATA_ROOT;
    return typeof root === 'string' && root ? root : path.join(process.cwd(), 'data');
}

/** The adapter when ST's internals are missing: no secrets, user directories under the data root. */
export function createUnavailableSt(): StServices {
    return {
        available: false,
        dataRoot: currentDataRoot,
        userRoot(handle) {
            assertSafeHandle(handle);
            return path.join(currentDataRoot(), handle);
        },
        listSecrets: () => [],
        readSecret: () => '',
        writeSecret() {
            throw new Error('the ST secret store is unavailable');
        },
        renameSecret() {},
        deleteSecret() {},
    };
}

export function createStServicesFromModules(secrets: SecretsModule, users: UsersModule): StServices {
    const manager = (handle: string): SecretManagerLike => {
        assertSafeHandle(handle);
        return new secrets.SecretManager(users.getUserDirectories(handle));
    };
    return {
        available: true,
        dataRoot: currentDataRoot,
        userRoot(handle) {
            assertSafeHandle(handle);
            return users.getUserDirectories(handle).root;
        },
        listSecrets(handle, key) {
            const all = manager(handle).getAllSecrets()[key];
            if (!Array.isArray(all)) return [];
            const out: SecretEntry[] = [];
            for (const item of all as unknown[]) {
                if (!isRecord(item) || typeof item['id'] !== 'string') continue;
                out.push({
                    id: item['id'],
                    label: typeof item['label'] === 'string' ? item['label'] : '',
                    active: item['active'] === true,
                    value: typeof item['value'] === 'string' ? item['value'] : undefined,
                });
            }
            return out;
        },
        readSecret(handle, key, id) {
            return manager(handle).readSecret(key, id);
        },
        writeSecret(handle, key, value, label, options) {
            const m = manager(handle);
            const previous = options?.keepActive ? readActiveId(m, key) : null;
            const id = m.writeSecret(key, value, label);
            if (previous) {
                try {
                    m.rotateSecret(key, previous);
                } catch {
                    // the new secret stays active: harmless, only less polite
                }
            }
            return id;
        },
        renameSecret(handle, key, id, label) {
            manager(handle).renameSecret(key, id, label);
        },
        deleteSecret(handle, key, id) {
            if (!id) return; // ST would delete the active secret for a falsy id
            manager(handle).deleteSecret(key, id);
        },
    };
}

/**
 * Loads ST's modules and builds the adapter; resolves to the degraded adapter when they are unavailable.
 * `urls` is injectable for tests.
 */
export async function createStServices(log: Logger, urls: StModuleUrls = defaultStModuleUrls()): Promise<StServices> {
    try {
        const secrets = (await import(/* @vite-ignore */ urls.secrets)) as unknown as SecretsModule;
        const users = (await import(/* @vite-ignore */ urls.users)) as unknown as UsersModule;
        if (typeof secrets.SecretManager !== 'function' || typeof users.getUserDirectories !== 'function') {
            throw new Error('unexpected shape of the ST modules');
        }
        return createStServicesFromModules(secrets, users);
    } catch (error) {
        log.warn(`SillyTavern internals unavailable, running without the secret store (${describe(error)})`);
        return createUnavailableSt();
    }
}

function readActiveId(manager: SecretManagerLike, key: string): string | null {
    const all = manager.getAllSecrets()[key];
    if (!Array.isArray(all)) return null;
    for (const item of all as unknown[]) {
        if (isRecord(item) && item['active'] === true && typeof item['id'] === 'string') return item['id'];
    }
    return null;
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
