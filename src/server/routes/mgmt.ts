// Management API routes of stage 0.6 (contracts-mgmt.ts): the user's Management token (write-only), the inference keys
// it manages (list, create, change limits, revoke) and the model presets. Table of routes and errors: contracts-mgmt.ts.
//   GET /mgmt/status   PUT|DELETE /mgmt/token   GET|POST /mgmt/keys   PATCH|DELETE /mgmt/keys/:id
//   GET|POST /mgmt/presets   PUT|DELETE /mgmt/presets/:name
// The token sits in `<user root>/nanovia/mgmt.json`. A route never returns it and never puts it in an error or a log line.
import { randomUUID } from 'node:crypto';
import {
    checkKeyId,
    checkMgmtToken,
    checkPresetName,
    describeIssues,
    describeTokenIssue,
    keyCreateToWire,
    keyPatchToWire,
    normalizeManagedKey,
    normalizeManagedKeys,
    normalizeModelPreset,
    normalizeModelPresets,
    presetToWire,
    sanitizeKeyCreateInput,
    sanitizeKeyLimitsPatch,
    sanitizePresetInput,
    type Checked,
} from '../../domain/mgmt';
import { isRecord } from '../../domain/usage';
import { SECRET_KEY_NANOGPT, SECRET_LABEL_PREFIX } from '../../shared/constants';
import type { ManagedKeyCreated, ManagedKeyList, ModelPreset } from '../../shared/contracts-mgmt';
import { SecretValue } from '../secret-value';
import type { RouteModule } from '../types';
import { HttpError, bodyObject, route, sendJson, userOf } from './http';
import { callStored, probeToken, refusedCheck, statusOf, storeCheck, type MgmtAnswer } from './mgmt-api';
import { queryText } from './nanogpt';

const MAX_LABEL_LENGTH = 100;

/** The value of a checked input, or the HttpError that tells the client what to fix (413 for an oversized body). */
function accepted<T>(result: Checked<T>): T {
    if (result.ok) return result.value;
    const tooLarge = result.issues.some((issue) => issue.code === 'too_large');
    throw new HttpError(
        tooLarge ? 413 : 400,
        tooLarge ? 'payload_too_large' : 'invalid_request',
        describeIssues(result.issues),
    );
}

function flagOf(value: string | null): boolean {
    return value === '1' || value === 'true';
}

function badAnswer(what: string): HttpError {
    return new HttpError(502, 'bad_response', `NanoGPT answered with something else than ${what}`);
}

function keyIdOf(raw: string | undefined): string {
    const id = checkKeyId(raw);
    if (id === null) throw new HttpError(400, 'invalid_request', 'The key id must be a positive whole number');
    return id;
}

function presetNameOf(raw: unknown): string {
    const name = checkPresetName(raw);
    if (name === null) {
        throw new HttpError(
            400,
            'invalid_request',
            'The preset name is 1 to 80 letters, digits, dashes or underscores, starting with a letter or digit',
        );
    }
    return name;
}

function presetOf(answer: MgmtAnswer): ModelPreset {
    const preset = normalizeModelPreset(answer.json);
    if (!preset) throw badAnswer('a preset');
    return preset;
}

export const mgmtRoutes: RouteModule = (router, deps) => {
    const { store, st, log } = deps;

    /* ---------------------------------------------------------------------------------------------- token */

    router.get(
        '/mgmt/status',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const record = store.mgmt.read(user.root);
            if (record && flagOf(queryText(req, 'verify'))) {
                const check = await probeToken(deps, new SecretValue(record.token));
                // No verdict (NanoGPT unreachable): say so now, keep what was stored.
                if (check.valid === null) return sendJson(res, 200, statusOf({ ...record, check }));
                storeCheck(deps, user, record.token, check);
                return sendJson(res, 200, statusOf({ ...record, check }));
            }
            sendJson(res, 200, statusOf(record));
        }),
    );

    router.put(
        '/mgmt/token',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const shape = checkMgmtToken(bodyObject(req)['token']);
            if (!shape.ok) throw new HttpError(400, 'mgmt_token_malformed', describeTokenIssue(shape.issue));
            const check = await probeToken(deps, new SecretValue(shape.token));
            const force = flagOf(queryText(req, 'force'));
            if (!force && check.valid !== true) throw refusedCheck(check);
            store.mgmt.write(user.root, { token: shape.token, check });
            log.info(`Management token stored (${check.valid === true ? 'recognised by NanoGPT' : 'not verified'})`);
            sendJson(res, 200, statusOf({ token: shape.token, check }));
        }),
    );

    router.delete(
        '/mgmt/token',
        route(log, (req, res) => {
            store.mgmt.clear(userOf(req, deps).root);
            log.info('Management token removed');
            sendJson(res, 200, { ok: true });
        }),
    );

    /* ---------------------------------------------------------------------------------------------- keys */

    router.get(
        '/mgmt/keys',
        route(log, async (req, res) => {
            const answer = await callStored(deps, userOf(req, deps), 'api_keys:read', {
                method: 'GET',
                path: '/api-keys',
            });
            const keys = normalizeManagedKeys(answer.json);
            if (!keys) throw badAnswer('a key list');
            sendJson(res, 200, { keys, fetchedAt: deps.now() } satisfies ManagedKeyList);
        }),
    );

    router.post(
        '/mgmt/keys',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const input = accepted(sanitizeKeyCreateInput(req.body));
            // The secret of the new key is shown once; with nowhere to put it the key must not be made.
            if (!st.available) throw new HttpError(503, 'secrets_unavailable', 'ST secret store is unavailable');
            const request = {
                method: 'POST',
                path: '/api-keys',
                body: keyCreateToWire(input),
                idempotencyKey: `nanovia-${randomUUID()}`,
            } as const;
            let answer: MgmtAnswer;
            try {
                answer = await callStored(deps, user, 'api_keys:write', request);
            } catch (error) {
                // A lost answer may hide a key that was made; the same Idempotency-Key replays it, secret included.
                const lost =
                    error instanceof HttpError && ['upstream_unreachable', 'upstream_timeout'].includes(error.code);
                if (!lost) throw error;
                answer = await callStored(deps, user, 'api_keys:write', request);
            }
            const key = normalizeManagedKey(answer.json);
            const secret = isRecord(answer.json) && typeof answer.json['key'] === 'string' ? answer.json['key'] : '';
            if (!key || !secret) throw badAnswer('a created key');
            let secretId: string;
            try {
                const label = `${SECRET_LABEL_PREFIX}${key.name}`.slice(0, MAX_LABEL_LENGTH);
                // keepActive: a key made for one connection must not become the active key of every other one.
                secretId = st.writeSecret(user.handle, SECRET_KEY_NANOGPT, secret, label, { keepActive: true });
            } catch {
                log.error(`NanoGPT key ${key.id} was created but ST could not store it`);
                throw new HttpError(
                    500,
                    'secrets_failed',
                    `Key ${key.id} was created at NanoGPT but could not be stored; revoke it from the list`,
                );
            }
            sendJson(res, 200, { key, secretId } satisfies ManagedKeyCreated);
        }),
    );

    router.patch(
        '/mgmt/keys/:id',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const id = keyIdOf(req.params['id']);
            const patch = accepted(sanitizeKeyLimitsPatch(req.body));
            const answer = await callStored(deps, user, 'api_keys:write', {
                method: 'PATCH',
                path: `/api-keys/${id}`,
                body: keyPatchToWire(patch),
            });
            const key = normalizeManagedKey(answer.json);
            if (!key) throw badAnswer('a key');
            sendJson(res, 200, { key });
        }),
    );

    router.delete(
        '/mgmt/keys/:id',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const id = keyIdOf(req.params['id']);
            await callStored(deps, user, 'api_keys:write', { method: 'DELETE', path: `/api-keys/${id}` });
            sendJson(res, 200, { ok: true });
        }),
    );

    /* ---------------------------------------------------------------------------------------------- presets */

    router.get(
        '/mgmt/presets',
        route(log, async (req, res) => {
            const answer = await callStored(deps, userOf(req, deps), 'model_presets:read', {
                method: 'GET',
                path: '/model-presets',
            });
            const presets = normalizeModelPresets(answer.json);
            if (!presets) throw badAnswer('a preset list');
            sendJson(res, 200, { presets, fetchedAt: deps.now() });
        }),
    );

    router.post(
        '/mgmt/presets',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const body = bodyObject(req);
            const name = presetNameOf(body['name']);
            const rest = { ...body };
            delete rest['name'];
            const input = accepted(sanitizePresetInput(rest));
            // PUT would silently replace a preset of the same name: a create looks first.
            const existing = await callStored(
                deps,
                user,
                'model_presets:read',
                { method: 'GET', path: `/model-presets/${encodeURIComponent(name)}` },
                { allow: [404] },
            );
            if (existing.status !== 404) {
                throw new HttpError(
                    409,
                    'preset_exists',
                    'A preset with this name exists; replace it with PUT instead',
                );
            }
            const answer = await callStored(deps, user, 'model_presets:write', {
                method: 'PUT',
                path: `/model-presets/${encodeURIComponent(name)}`,
                body: presetToWire(input),
            });
            sendJson(res, 200, { preset: presetOf(answer) });
        }),
    );

    router.put(
        '/mgmt/presets/:name',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const name = presetNameOf(req.params['name']);
            const input = accepted(sanitizePresetInput(req.body));
            const answer = await callStored(deps, user, 'model_presets:write', {
                method: 'PUT',
                path: `/model-presets/${encodeURIComponent(name)}`,
                body: presetToWire(input),
            });
            sendJson(res, 200, { preset: presetOf(answer) });
        }),
    );

    router.delete(
        '/mgmt/presets/:name',
        route(log, async (req, res) => {
            const user = userOf(req, deps);
            const name = presetNameOf(req.params['name']);
            await callStored(deps, user, 'model_presets:write', {
                method: 'DELETE',
                path: `/model-presets/${encodeURIComponent(name)}`,
            });
            sendJson(res, 200, { ok: true });
        }),
    );
};
