// NanoGPT key routes: the keys live in ST's secret store under api_key_nanogpt; these routes list them (masked), add one,
// delete one and check a balance. A value is never returned: `masked` shows at most the first 8 and the last 4 characters.
//   GET /keys   POST /keys   DELETE /keys/:id   POST /keys/:id/check
import type { KeyCheck, KeyInfo } from '../../shared/contracts';
import { SECRET_KEY_NANOGPT } from '../../shared/constants';
import { SecretValue, maskSecret } from '../secret-value';
import type { RouteModule, SecretEntry, ServerDeps } from '../types';
import { HttpError, bodyObject, route, sendJson, userOf } from './http';

const MAX_KEY_LENGTH = 512;
const MAX_LABEL_LENGTH = 100;
const DEFAULT_LABEL = 'NanoGPT';
const CHECK_TIMEOUT_MS = 15_000;

function toInfo(entry: SecretEntry): KeyInfo {
    return { id: entry.id, label: entry.label, active: entry.active, masked: maskSecret(entry.value ?? '') };
}

export const keyRoutes: RouteModule = (router, deps: ServerDeps) => {
    const { st } = deps;

    const requireSecrets = (): void => {
        if (!st.available) throw new HttpError(503, 'secrets_unavailable', 'ST secret store is unavailable');
    };

    router.get(
        '/keys',
        route(deps.log, (req, res) => {
            const user = userOf(req, deps);
            const keys = st.available ? st.listSecrets(user.handle, SECRET_KEY_NANOGPT).map(toInfo) : [];
            sendJson(res, 200, { keys });
        }),
    );

    router.post(
        '/keys',
        route(deps.log, (req, res) => {
            requireSecrets();
            const user = userOf(req, deps);
            const body = bodyObject(req);
            const value = typeof body['value'] === 'string' ? body['value'].trim() : '';
            // eslint-disable-next-line no-control-regex
            if (!value || value.length > MAX_KEY_LENGTH || /[\u0000-\u001f\u007f\s]/.test(value)) {
                throw new HttpError(400, 'invalid_request', '"value" must be a key without spaces or line breaks');
            }
            const rawLabel = body['label'];
            if (rawLabel !== undefined && typeof rawLabel !== 'string') {
                throw new HttpError(400, 'invalid_request', '"label" must be a string');
            }
            const label = (typeof rawLabel === 'string' ? rawLabel.trim() : '').slice(0, MAX_LABEL_LENGTH) || DEFAULT_LABEL;
            const id = st.writeSecret(user.handle, SECRET_KEY_NANOGPT, value, label);
            const written = st.listSecrets(user.handle, SECRET_KEY_NANOGPT).find((s) => s.id === id);
            const key: KeyInfo = written
                ? toInfo(written)
                : { id, label, active: true, masked: maskSecret(value) };
            sendJson(res, 200, { key });
        }),
    );

    router.delete(
        '/keys/:id',
        route(deps.log, (req, res) => {
            requireSecrets();
            const user = userOf(req, deps);
            const id = req.params['id'] ?? '';
            if (!id || !st.listSecrets(user.handle, SECRET_KEY_NANOGPT).some((s) => s.id === id)) {
                throw new HttpError(404, 'not_found', 'Unknown key');
            }
            st.deleteSecret(user.handle, SECRET_KEY_NANOGPT, id);
            sendJson(res, 200, { ok: true });
        }),
    );

    router.post(
        '/keys/:id/check',
        route(deps.log, async (req, res) => {
            requireSecrets();
            const user = userOf(req, deps);
            const id = req.params['id'] ?? '';
            const entry = st.listSecrets(user.handle, SECRET_KEY_NANOGPT).find((s) => s.id === id);
            const value = id && entry ? st.readSecret(user.handle, SECRET_KEY_NANOGPT, id) : '';
            if (!value) throw new HttpError(404, 'not_found', 'Unknown key');
            sendJson(res, 200, await checkBalance(deps, new SecretValue(value)));
        }),
    );
};

/** `POST <site>/api/check-balance` with the key in `x-api-key`. Never throws; the outcome is the KeyCheck. */
export async function checkBalance(deps: ServerDeps, key: SecretValue): Promise<KeyCheck> {
    const failed = (error: string): KeyCheck => ({ ok: false, usdBalance: null, nanoBalance: null, error });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    timer.unref?.();
    try {
        const response = await deps.fetch(`${deps.config.siteBase}/api/check-balance`, {
            method: 'POST',
            headers: { 'x-api-key': key.reveal(), accept: 'application/json', 'content-type': 'application/json' },
            body: '{}',
            signal: controller.signal,
        });
        const text = key.redact(await response.text());
        let parsed: Record<string, unknown> = {};
        try {
            const json: unknown = JSON.parse(text);
            if (typeof json === 'object' && json !== null && !Array.isArray(json)) parsed = json as Record<string, unknown>;
        } catch {
            // not JSON
        }
        if (response.status < 200 || response.status >= 300) {
            const detail = typeof parsed['error'] === 'string' ? parsed['error'] : typeof parsed['message'] === 'string' ? parsed['message'] : '';
            return failed(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }
        const usd = amount(parsed['usd_balance'] ?? parsed['usdBalance']);
        const nano = amount(parsed['nano_balance'] ?? parsed['nanoBalance']);
        if (usd === null && nano === null) return failed('The balance is missing in the answer');
        return { ok: true, usdBalance: usd, nanoBalance: nano, error: null };
    } catch {
        return failed(controller.signal.aborted ? 'The balance check timed out' : 'NanoGPT could not be reached');
    } finally {
        clearTimeout(timer);
    }
}

function amount(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}
