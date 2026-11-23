// GET /spend?from&to&connectionId -> UsageSummary (contracts-account.ts): the usage log of the user over a period,
// summed in total, per UTC day, per connection and per model. `from <= at < to` in ms since epoch; both default to the
// last 30 days up to now. Real money and the pay-as-you-go equivalent stay apart (domain/usage.ts summarizeUsage).
import { summarizeUsage } from '../../domain/usage';
import type { RouteModule } from '../types';
import { utcDay } from '../usage-log';
import { HttpError, route, sendJson, userOf } from './http';
import { queryText } from './nanogpt';

const DAY_MS = 86_400_000;
const DEFAULT_SPAN_DAYS = 30;
const MAX_CONNECTION_ID_LENGTH = 64;
const RECENT_DAYS = 7;
const RECENT_DEFAULT_LIMIT = 50;
const RECENT_MAX_LIMIT = 300;

function instant(raw: string | null, name: string): number | null {
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value))
        throw new HttpError(400, 'invalid_request', `"${name}" must be milliseconds since epoch`);
    return value;
}

export const spendRoutes: RouteModule = (router, deps) => {
    router.get(
        '/spend',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const requestedFrom = instant(queryText(req, 'from'), 'from');
            const requestedTo = instant(queryText(req, 'to'), 'to');
            const to = requestedTo ?? deps.now() + 1;
            const from = requestedFrom ?? to - DEFAULT_SPAN_DAYS * DAY_MS;
            if (from >= to) throw new HttpError(400, 'invalid_request', '"from" must be earlier than "to"');
            const connectionId = queryText(req, 'connectionId');
            if (connectionId !== null && connectionId.length > MAX_CONNECTION_ID_LENGTH) {
                throw new HttpError(400, 'invalid_request', '"connectionId" is not a connection id');
            }
            const range = { from, to };
            const records = await deps.usage.read(user.root, range);
            sendJson(res, 200, summarizeUsage(records, range, utcDay, connectionId === null ? {} : { connectionId }));
        }),
    );

    router.get(
        '/usage/recent',
        route(deps.log, async (req, res) => {
            const user = userOf(req, deps);
            const limitRaw = queryText(req, 'limit');
            let limit = RECENT_DEFAULT_LIMIT;
            if (limitRaw !== null) {
                const n = Number(limitRaw);
                if (!Number.isInteger(n) || n < 1 || n > RECENT_MAX_LIMIT) {
                    throw new HttpError(400, 'invalid_request', `"limit" must be an integer 1..${RECENT_MAX_LIMIT}`);
                }
                limit = n;
            }
            const since = instant(queryText(req, 'since'), 'since');
            const connectionId = queryText(req, 'connectionId');
            if (connectionId !== null && connectionId.length > MAX_CONNECTION_ID_LENGTH) {
                throw new HttpError(400, 'invalid_request', '"connectionId" is not a connection id');
            }
            const to = deps.now() + 1;
            const from = Math.max(to - RECENT_DAYS * DAY_MS, since === null ? 0 : since + 1);
            const records = await deps.usage.read(user.root, { from, to });
            const wanted = records.filter((r) => connectionId === null || r.connectionId === connectionId);
            // The log is oldest first: the newest `limit` records, newest first.
            sendJson(res, 200, { records: wanted.slice(-limit).reverse() });
        }),
    );
};
