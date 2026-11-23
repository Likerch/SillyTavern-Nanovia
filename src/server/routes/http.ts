// Small helpers shared by the admin routes: the user of a request, JSON errors in the contract's shape, and a wrapper that
// turns a thrown error into a 500 (a rejected promise in an Express 4 handler would crash ST).
import type { Logger, RouteHandler, RouteRequest, RouteResponse, ServerDeps } from '../types';

export const DEFAULT_USER_HANDLE = 'default-user';

export interface RequestUser {
    handle: string;
    /** `<data root>/<handle>`: from ST's own directories when the request carries them. */
    root: string;
}

export function userOf(req: RouteRequest, deps: ServerDeps): RequestUser {
    const raw = req.user?.profile?.handle;
    const handle = typeof raw === 'string' && raw ? raw : DEFAULT_USER_HANDLE;
    const root = req.user?.directories?.root;
    return { handle, root: typeof root === 'string' && root ? root : deps.st.userRoot(handle) };
}

export class HttpError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

export function sendJson(res: RouteResponse, status: number, body: unknown): void {
    res.set('Cache-Control', 'no-store');
    res.status(status).json(body);
}

export function sendError(res: RouteResponse, status: number, code: string, message: string): void {
    sendJson(res, status, { error: { code, message } });
}

/** Wraps a handler: HttpError becomes its status, anything else a generic 500 (the message is not echoed). */
export function route(log: Logger, handler: RouteHandler): RouteHandler {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (error) {
            if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message);
            log.error(`admin route failed (${error instanceof Error ? error.name : 'unknown error'})`);
            sendError(res, 500, 'internal_error', 'Internal error');
        }
    };
}

export function bodyObject(req: RouteRequest): Record<string, unknown> {
    const body = req.body;
    if (body === undefined || body === null) return {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'invalid_request', 'The request body must be a JSON object');
    }
    return body as Record<string, unknown>;
}
