// The real ST adapter, driven through the same dynamic import it uses in ST, against stand-in `secrets.js` and `users.js`
// modules written to a temp folder (the stand-ins copy the semantics of ST 1.19's SecretManager).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createStServices, createUnavailableSt, defaultStModuleUrls, assertSafeHandle } from '../../src/server/st';
import { cleanTempDirs, makeTempDir, recordingLogger } from './helpers';

afterEach(cleanTempDirs);

const SECRETS_MODULE = `
const store = (globalThis.__nanoviaFakeSecrets ??= new Map());
let counter = 0;
export class SecretManager {
    constructor(directories) { this.root = directories.root; }
    all() { if (!store.has(this.root)) store.set(this.root, {}); return store.get(this.root); }
    getAllSecrets() { return structuredClone(this.all()); }
    readSecret(key, id) { const a = this.all()[key]; if (!Array.isArray(a)) return ''; return a.find(s => id ? s.id === id : s.active)?.value || ''; }
    writeSecret(key, value, label = 'Unlabeled') {
        const all = this.all(); if (!Array.isArray(all[key])) all[key] = [];
        all[key].forEach(s => { s.active = false; });
        const secret = { id: 'id-' + (++counter), value, label, active: true };
        all[key].push(secret); return secret.id;
    }
    rotateSecret(key, id) { const a = this.all()[key]; if (!a) return; a.forEach(s => { s.active = false; }); const t = a.find(s => s.id === id); if (t) t.active = true; }
    renameSecret(key, id, label) { const t = this.all()[key]?.find(s => s.id === id); if (t) t.label = label; }
    deleteSecret(key, id) {
        const a = this.all()[key]; if (!Array.isArray(a)) return;
        const i = a.findIndex(s => id ? s.id === id : s.active); if (i !== -1) a.splice(i, 1);
        if (a.length && !a.some(s => s.active)) a[0].active = true;
        if (a.length === 0) delete this.all()[key];
    }
}
`;

const USERS_MODULE = `
export function getUserDirectories(handle) { return { root: '/data/' + handle }; }
`;

function writeModules() {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'secrets.mjs'), SECRETS_MODULE);
    fs.writeFileSync(path.join(dir, 'users.mjs'), USERS_MODULE);
    return {
        secrets: pathToFileURL(path.join(dir, 'secrets.mjs')).href,
        users: pathToFileURL(path.join(dir, 'users.mjs')).href,
    };
}

describe('real ST adapter', () => {
    it('loads ST modules by URL and reads, writes, renames and deletes secrets per user', async () => {
        const { log, lines } = recordingLogger();
        const st = await createStServices(log, writeModules());
        expect(st.available).toBe(true);
        expect(lines).toEqual([]);
        expect(st.userRoot('alice')).toBe('/data/alice');

        const first = st.writeSecret('alice', 'api_key_nanogpt', 'sk-one', 'one');
        const second = st.writeSecret('alice', 'api_key_nanogpt', 'sk-two', 'two');
        expect(st.listSecrets('alice', 'api_key_nanogpt')).toEqual([
            { id: first, label: 'one', active: false, value: 'sk-one' },
            { id: second, label: 'two', active: true, value: 'sk-two' },
        ]);
        expect(st.readSecret('alice', 'api_key_nanogpt', null)).toBe('sk-two');
        expect(st.readSecret('alice', 'api_key_nanogpt', first)).toBe('sk-one');
        expect(st.listSecrets('bob', 'api_key_nanogpt')).toEqual([]);

        st.renameSecret('alice', 'api_key_nanogpt', first, 'renamed');
        expect(st.listSecrets('alice', 'api_key_nanogpt')[0]?.label).toBe('renamed');

        st.deleteSecret('alice', 'api_key_nanogpt', second);
        expect(st.listSecrets('alice', 'api_key_nanogpt').map((s) => [s.id, s.active])).toEqual([[first, true]]);
    });

    it('keepActive leaves the previously active secret active; a falsy id never deletes the active secret', async () => {
        const st = await createStServices(recordingLogger().log, writeModules());
        const mine = st.writeSecret('carol', 'api_key_custom', 'mine', 'mine');
        const added = st.writeSecret('carol', 'api_key_custom', 'token', 'token', { keepActive: true });
        expect(st.listSecrets('carol', 'api_key_custom').find((s) => s.active)?.id).toBe(mine);
        expect(st.listSecrets('carol', 'api_key_custom').map((s) => s.id)).toEqual([mine, added]);
        st.deleteSecret('carol', 'api_key_custom', '');
        expect(st.listSecrets('carol', 'api_key_custom')).toHaveLength(2);
    });

    it('degrades with a warning when ST modules cannot be imported', async () => {
        const { log, lines } = recordingLogger();
        const missing = pathToFileURL(path.join(makeTempDir(), 'nope.mjs')).href;
        const st = await createStServices(log, { secrets: missing, users: missing });
        expect(st.available).toBe(false);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('warn');
        expect(st.listSecrets('default-user', 'api_key_nanogpt')).toEqual([]);
        expect(st.readSecret('default-user', 'api_key_nanogpt', null)).toBe('');
        expect(() => st.writeSecret('default-user', 'api_key_nanogpt', 'x', 'y')).toThrow();
        expect(st.userRoot('default-user')).toBe(path.join(st.dataRoot(), 'default-user'));
    });

    it('degrades when the modules have the wrong shape', async () => {
        const dir = makeTempDir();
        fs.writeFileSync(path.join(dir, 'x.mjs'), 'export const nothing = 1;');
        const url = pathToFileURL(path.join(dir, 'x.mjs')).href;
        expect((await createStServices(recordingLogger().log, { secrets: url, users: url })).available).toBe(false);
    });

    it('resolves ST modules two levels up from the plugin folder', () => {
        const urls = defaultStModuleUrls('file:///opt/st/plugins/nanovia/index.js');
        expect(urls.secrets).toBe('file:///opt/st/src/endpoints/secrets.js');
        expect(urls.users).toBe('file:///opt/st/src/users.js');
    });

    it('refuses a user handle that could leave the data root', () => {
        for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'a\0b']) expect(() => assertSafeHandle(bad)).toThrow();
        expect(() => assertSafeHandle('default-user')).not.toThrow();
        expect(() => createUnavailableSt().userRoot('../x')).toThrow();
    });
});
