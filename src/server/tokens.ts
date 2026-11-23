// Proxy tokens and connection ids. A token is 32 random bytes (base64url); the registry keeps only its SHA-256, the
// token itself lives in ST's secret store under api_key_custom (label "Nanovia: <name>") where the Connection Manager
// profile of the connection reads it. The token is returned to nobody: the browser refers to it by secret id.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { ConnectionConfig } from '../shared/contracts';
import { SECRET_KEY_CUSTOM, SECRET_LABEL_PREFIX } from '../shared/constants';
import type { Store } from './store';
import type { StServices } from './types';

export function generateToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new connection id, [a-z0-9]{8}, not among `taken`. */
export function generateConnectionId(taken: ReadonlySet<string>): string {
    for (;;) {
        let id = '';
        for (let i = 0; i < 8; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
        if (!taken.has(id)) return id;
    }
}

export function tokenLabel(connection: Pick<ConnectionConfig, 'name'>): string {
    return SECRET_LABEL_PREFIX + connection.name;
}

export interface TokenService {
    /** The secret id of the connection's token, when it has one and the secret still exists. */
    secretId(user: string, connectionId: string): string | null;
    /** Makes sure the connection has a live token (creates one when missing); returns the secret id, or null without ST secrets. */
    ensure(user: string, connection: ConnectionConfig): string | null;
    /** Replaces the token with a new one; returns the new secret id, or null without ST secrets. */
    rotate(user: string, connection: ConnectionConfig): string | null;
    /** Removes the registry entry and the token secret. */
    revoke(user: string, connectionId: string): void;
    /** Keeps the label of the token secret in step with the connection's name. */
    relabel(user: string, connection: ConnectionConfig): void;
}

export function createTokenService(deps: { st: StServices; store: Store }): TokenService {
    const { st, store } = deps;

    const entriesOf = (user: string, connectionId: string): [string, string | null][] => {
        const out: [string, string | null][] = [];
        for (const [hash, entry] of Object.entries(store.registry.read().tokens)) {
            if (entry.userHandle === user && entry.connectionId === connectionId) out.push([hash, entry.tokenSecretId]);
        }
        return out;
    };

    const secretExists = (user: string, id: string | null): boolean =>
        !!id && st.listSecrets(user, SECRET_KEY_CUSTOM).some((s) => s.id === id);

    const dropSecret = (user: string, id: string | null): void => {
        if (!id) return;
        try {
            st.deleteSecret(user, SECRET_KEY_CUSTOM, id);
        } catch {
            // an orphaned secret is harmless: its token is no longer in the registry
        }
    };

    const create = (user: string, connection: ConnectionConfig): string => {
        const token = generateToken();
        // The previously active Custom key stays active: ST's Custom source may be in use for something else.
        const secretId = st.writeSecret(user, SECRET_KEY_CUSTOM, token, tokenLabel(connection), { keepActive: true });
        try {
            const hash = hashToken(token);
            store.registry.mutate((registry) => {
                registry.tokens[hash] = { connectionId: connection.id, userHandle: user, tokenSecretId: secretId };
            });
        } catch (error) {
            dropSecret(user, secretId);
            throw error;
        }
        return secretId;
    };

    const service: TokenService = {
        secretId(user, connectionId) {
            if (!st.available) return null;
            const existing = entriesOf(user, connectionId).find(([, id]) => secretExists(user, id));
            return existing ? existing[1] : null;
        },

        ensure(user, connection) {
            if (!st.available) return null;
            const current = service.secretId(user, connection.id);
            if (current) return current;
            service.revoke(user, connection.id); // clears half-dead entries before a fresh one
            return create(user, connection);
        },

        rotate(user, connection) {
            if (!st.available) return null;
            const old = entriesOf(user, connection.id);
            const secretId = create(user, connection);
            store.registry.mutate((registry) => {
                for (const [hash] of old) delete registry.tokens[hash];
            });
            for (const [, id] of old) dropSecret(user, id);
            return secretId;
        },

        revoke(user, connectionId) {
            const old = entriesOf(user, connectionId);
            if (old.length > 0) {
                store.registry.mutate((registry) => {
                    for (const [hash] of old) delete registry.tokens[hash];
                });
            }
            if (st.available) for (const [, id] of old) dropSecret(user, id);
        },

        relabel(user, connection) {
            if (!st.available) return;
            const id = service.secretId(user, connection.id);
            if (!id) return;
            try {
                st.renameSecret(user, SECRET_KEY_CUSTOM, id, tokenLabel(connection));
            } catch {
                // cosmetic
            }
        },
    };
    return service;
}
