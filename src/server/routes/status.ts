// GET /status -> ApiStatus
import type { ApiStatus } from '../../shared/contracts';
import type { RouteModule } from '../types';
import { route, sendJson, userOf } from './http';

export const statusRoutes: RouteModule = (router, deps) => {
    router.get(
        '/status',
        route(deps.log, (req, res) => {
            const proxy = deps.proxy();
            const body: ApiStatus = {
                version: deps.version,
                plugin: true,
                proxy: { up: proxy.up, host: proxy.host, port: proxy.port },
                secrets: deps.st.available,
                user: userOf(req, deps).handle,
            };
            sendJson(res, 200, body);
        }),
    );
};
