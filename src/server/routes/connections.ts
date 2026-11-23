// Connection admin routes (contract table in shared/contracts.ts):
//   GET    /connections                  POST   /connections            PUT /connections/:id
//   DELETE /connections/:id              POST   /connections/:id/rotate-token
// A connection in mode plugin or auto owns a proxy token (secret in ST, hash in the registry); a connection in direct
// mode has none. Switching modes creates or revokes the token.
import type { ConnectionConfig, ConnectionView } from '../../shared/contracts';
import { NANOGPT_API_BASE } from '../../shared/constants';
import { createConnection, mergeConnection } from '../../domain/connection';
import { generateConnectionId } from '../tokens';
import type { RouteModule, RouterLike, ServerDeps } from '../types';
import { HttpError, bodyObject, route, sendJson, userOf, type RequestUser } from './http';

const MODES = ['auto', 'plugin', 'direct'];
const BILLING = ['auto', 'subscription', 'paygo'];
const BOOLEAN_FIELDS = ['modelLock', 'webSearch', 'stripNeutralSamplers'];
const OBJECT_FIELDS = ['routing', 'reasoning', 'memory'];

export function toView(deps: ServerDeps, user: RequestUser, connection: ConnectionConfig): ConnectionView {
    const proxy = deps.proxy();
    return {
        ...connection,
        proxyUrl: `http://${proxy.host}:${proxy.port}/c/${connection.id}/v1`,
        directUrl: NANOGPT_API_BASE,
        tokenSecretId: connection.mode === 'direct' ? null : deps.tokens.secretId(user.handle, connection.id),
    };
}

/** Checks the types of the fields a client may send; values inside routing/reasoning/memory are merged leniently. */
export function validateInput(body: Record<string, unknown>, create: boolean): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    for (const field of ['name', 'modelId']) {
        const value = body[field];
        if (value === undefined && !create) continue;
        if (typeof value !== 'string' || !value.trim()) {
            throw new HttpError(400, 'invalid_request', `"${field}" must be a non-empty string`);
        }
        patch[field] = value;
    }
    for (const field of BOOLEAN_FIELDS) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_request', `"${field}" must be a boolean`);
        patch[field] = value;
    }
    for (const [field, allowed] of [
        ['mode', MODES],
        ['billing', BILLING],
    ] as const) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== 'string' || !allowed.includes(value)) {
            throw new HttpError(400, 'invalid_request', `"${field}" must be one of: ${allowed.join(', ')}`);
        }
        patch[field] = value;
    }
    if (body['keyId'] !== undefined) {
        const value = body['keyId'];
        if (value !== null && (typeof value !== 'string' || !value.trim())) {
            throw new HttpError(400, 'invalid_request', '"keyId" must be a non-empty string or null');
        }
        patch['keyId'] = value;
    }
    if (body['note'] !== undefined) {
        if (typeof body['note'] !== 'string') throw new HttpError(400, 'invalid_request', '"note" must be a string');
        patch['note'] = body['note'];
    }
    for (const field of OBJECT_FIELDS) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new HttpError(400, 'invalid_request', `"${field}" must be an object`);
        }
        patch[field] = value;
    }
    return patch;
}

function tokenFailure(error: unknown): never {
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, 'secrets_failed', 'The proxy token could not be stored');
}

export const connectionRoutes: RouteModule = (router: RouterLike, deps: ServerDeps) => {
    const { store, tokens, st } = deps;

    router.get(
        '/connections',
        route(deps.log, (req, res) => {
            const user = userOf(req, deps);
            const connections = store.connections.list(user.root).map((c) => toView(deps, user, c));
            sendJson(res, 200, { connections });
        }),
    );

    router.post(
        '/connections',
        route(deps.log, (req, res) => {
            const user = userOf(req, deps);
            const patch = validateInput(bodyObject(req), true);
            const list = store.connections.list(user.root);
            const id = generateConnectionId(new Set(list.map((c) => c.id)));
            const connection = createConnection(
                patch as Partial<ConnectionConfig> & { name: string; modelId: string },
                id,
                deps.now(),
            );
            if (connection.mode !== 'direct') {
                try {
                    tokens.ensure(user.handle, connection);
                } catch (error) {
                    tokenFailure(error);
                }
            }
            try {
                store.connections.save(user.root, [...list, connection]);
            } catch (error) {
                tokens.revoke(user.handle, connection.id);
                throw error;
            }
            sendJson(res, 200, { connection: toView(deps, user, connection) });
        }),
    );

    router.put(
        '/connections/:id',
        route(deps.log, (req, res) => {
            const user = userOf(req, deps);
            const list = store.connections.list(user.root);
            const index = list.findIndex((c) => c.id === req.params['id']);
            const existing = list[index];
            if (!existing) throw new HttpError(404, 'not_found', 'Unknown connection');
            const patch = validateInput(bodyObject(req), false);
            const next = mergeConnection(existing, patch, deps.now());

            const proxied = next.mode !== 'direct';
            if (proxied) {
                try {
                    tokens.ensure(user.handle, next);
                    if (next.name !== existing.name) tokens.relabel(user.handle, next);
                } catch (error) {
                    tokenFailure(error);
                }
            }
            list[index] = next;
            store.connections.save(user.root, list);
            if (!proxied && existing.mode !== 'direct') tokens.revoke(user.handle, next.id);
            sendJson(res, 200, { connection: toView(deps, user, next) });
        }),
    );

    router.delete(
        '/connections/:id',
        route(deps.log, (req, res) => {
            const user = userOf(req, deps);
            const list = store.connections.list(user.root);
            const existing = list.find((c) => c.id === req.params['id']);
            if (!existing) throw new HttpError(404, 'not_found', 'Unknown connection');
            store.connections.save(
                user.root,
                list.filter((c) => c.id !== existing.id),
            );
            tokens.revoke(user.handle, existing.id);
            sendJson(res, 200, { ok: true });
        }),
    );

    router.post(
        '/connections/:id/rotate-token',
        route(deps.log, (req, res) => {
            const user = userOf(req, deps);
            const existing = store.connections.get(user.root, req.params['id'] ?? '');
            if (!existing) throw new HttpError(404, 'not_found', 'Unknown connection');
            if (existing.mode === 'direct') {
                throw new HttpError(409, 'direct_mode', 'A connection in direct mode has no proxy token');
            }
            if (!st.available) {
                throw new HttpError(503, 'secrets_unavailable', 'ST secret store is unavailable');
            }
            try {
                tokens.rotate(user.handle, existing);
            } catch (error) {
                tokenFailure(error);
            }
            sendJson(res, 200, { connection: toView(deps, user, existing) });
        }),
    );
};
