import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnection } from '../../src/domain/connection';
import { SECRET_KEY_CUSTOM } from '../../src/shared/constants';
import { maskSecret, SecretValue } from '../../src/server/secret-value';
import { createStore } from '../../src/server/store';
import { createTokenService, generateConnectionId, generateToken, hashToken } from '../../src/server/tokens';
import { cleanTempDirs, FakeSt, makeTempDir, recordingLogger } from './helpers';

afterEach(cleanTempDirs);

function setup() {
    const root = makeTempDir();
    const st = new FakeSt(root);
    const { log } = recordingLogger();
    const store = createStore({ dataRoot: () => root, now: () => 1, log });
    const tokens = createTokenService({ st, store });
    const connection = createConnection({ name: 'Main', modelId: 'glm-5' }, 'abcd1234', 1);
    return { st, store, tokens, connection };
}

describe('token primitives', () => {
    it('generates distinct url-safe tokens of 32 bytes and hashes them with sha256', () => {
        const a = generateToken();
        const b = generateToken();
        expect(a).not.toBe(b);
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('generates connection ids [a-z0-9]{8} that avoid taken ones', () => {
        const taken = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const id = generateConnectionId(taken);
            expect(id).toMatch(/^[a-z0-9]{8}$/);
            expect(taken.has(id)).toBe(false);
            taken.add(id);
        }
    });
});

describe('SecretValue', () => {
    it('never serialises, prints or interpolates its value', () => {
        const secret = new SecretValue('sk-very-secret-value');
        expect(JSON.stringify({ key: secret })).toBe('{"key":"[redacted]"}');
        expect(`${secret}`).toBe('[redacted]');
        expect(inspect({ secret })).not.toContain('very-secret');
        expect(secret.reveal()).toBe('sk-very-secret-value');
        expect(secret.redact('error with sk-very-secret-value inside')).toBe('error with [redacted] inside');
    });

    it('masks at most the first 8 and the last 4 characters', () => {
        expect(maskSecret('sk-nano-0123456789abcdefghijklmnopqrstuv-KEYTAIL')).toBe('sk-nano-…TAIL');
        expect(maskSecret('')).toBe('');
        for (const value of ['a', 'abc', 'abcdefgh', 'abcdefghijkl', 'abcdefghijklmnop']) {
            const masked = maskSecret(value);
            expect(masked.replace('…', '').length).toBeLessThan(Math.max(value.length, 2));
            expect(masked.replace('…', '').length).toBeLessThanOrEqual(12);
        }
    });
});

describe('token service', () => {
    it('writes the token into ST under api_key_custom with a labelled secret and stores only its hash', () => {
        const { st, store, tokens, connection } = setup();
        const id = tokens.ensure('default-user', connection);
        expect(id).toBeTruthy();
        const [secret] = st.listSecrets('default-user', SECRET_KEY_CUSTOM);
        expect(secret?.id).toBe(id);
        expect(secret?.label).toBe('Nanovia: Main');
        const token = secret?.value ?? '';
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const registry = store.registry.read();
        expect(Object.keys(registry.tokens)).toEqual([hashToken(token)]);
        expect(JSON.stringify(registry)).not.toContain(token);
        expect(registry.tokens[hashToken(token)]).toEqual({
            connectionId: 'abcd1234',
            userHandle: 'default-user',
            tokenSecretId: id,
        });
        expect(tokens.secretId('default-user', 'abcd1234')).toBe(id);
    });

    it('is idempotent and repairs an entry whose secret is gone', () => {
        const { st, tokens, connection } = setup();
        const first = tokens.ensure('default-user', connection);
        expect(tokens.ensure('default-user', connection)).toBe(first);
        st.deleteSecret('default-user', SECRET_KEY_CUSTOM, first!);
        expect(tokens.secretId('default-user', 'abcd1234')).toBeNull();
        const repaired = tokens.ensure('default-user', connection);
        expect(repaired).not.toBe(first);
        expect(st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toHaveLength(1);
    });

    it('keeps the previously active Custom key active', () => {
        const { st, tokens, connection } = setup();
        const mine = st.writeSecret('default-user', SECRET_KEY_CUSTOM, 'my-own-custom-key', 'mine');
        tokens.ensure('default-user', connection);
        const active = st.listSecrets('default-user', SECRET_KEY_CUSTOM).find((s) => s.active);
        expect(active?.id).toBe(mine);
    });

    it('rotates: new token works, old hash and secret are gone', () => {
        const { st, store, tokens, connection } = setup();
        const first = tokens.ensure('default-user', connection)!;
        const oldToken = st.readSecret('default-user', SECRET_KEY_CUSTOM, first);
        const second = tokens.rotate('default-user', connection)!;
        expect(second).not.toBe(first);
        const newToken = st.readSecret('default-user', SECRET_KEY_CUSTOM, second);
        expect(store.registry.lookup(hashToken(oldToken))).toBeNull();
        expect(store.registry.lookup(hashToken(newToken))?.connectionId).toBe('abcd1234');
        expect(st.readSecret('default-user', SECRET_KEY_CUSTOM, first)).toBe('');
    });

    it('revokes: registry entry and secret are removed', () => {
        const { st, store, tokens, connection } = setup();
        tokens.ensure('default-user', connection);
        tokens.revoke('default-user', 'abcd1234');
        expect(store.registry.read().tokens).toEqual({});
        expect(st.listSecrets('default-user', SECRET_KEY_CUSTOM)).toEqual([]);
    });

    it('relabels the secret after a rename', () => {
        const { st, tokens, connection } = setup();
        tokens.ensure('default-user', connection);
        tokens.relabel('default-user', { ...connection, name: 'Renamed' });
        expect(st.listSecrets('default-user', SECRET_KEY_CUSTOM)[0]?.label).toBe('Nanovia: Renamed');
    });

    it('does nothing without the ST secret store', () => {
        const { st, store, tokens, connection } = setup();
        st.available = false;
        expect(tokens.ensure('default-user', connection)).toBeNull();
        expect(tokens.rotate('default-user', connection)).toBeNull();
        expect(tokens.secretId('default-user', 'abcd1234')).toBeNull();
        expect(store.registry.read().tokens).toEqual({});
    });
});
