// GET /catalog                  -> CatalogResponse            (?refresh=1 forces a fetch)
// GET /catalog/:id/providers    -> ModelProvidersResponse     (:id = encodeURIComponent(modelId); ?refresh=1 forces a fetch)
// GET /catalog/:id/hints        -> RoutingHintsResponse
// The same two routes without the id segment take it from the query: GET /catalog/providers?id=<modelId>,
// GET /catalog/hints?id=<modelId> (see contracts-catalog.ts for why both exist).
import type { ModelProviders } from '../../shared/contracts';
import type { RoutingHintsResponse } from '../../shared/contracts-catalog';
import { routingHints } from '../../domain/catalog-hints';
import type { RouteModule, RouteRequest } from '../types';
import { HttpError, route, sendJson } from './http';

const MAX_MODEL_ID_LENGTH = 300;

/** `?id=` wins over the path segment; Express has already decoded both. */
function modelIdOf(req: RouteRequest): string {
    const fromQuery = req.query?.['id'];
    const raw = typeof fromQuery === 'string' && fromQuery.trim() ? fromQuery : req.params['id'];
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || id.length > MAX_MODEL_ID_LENGTH || /\p{Cc}/u.test(id)) {
        throw new HttpError(400, 'invalid_request', 'A model id is required');
    }
    return id;
}

function wantsRefresh(req: RouteRequest): boolean {
    const value = req.query?.['refresh'];
    return value === '1' || value === 'true';
}

export const catalogRoutes: RouteModule = (router, deps) => {
    const catalog = deps.catalog;
    if (!catalog) return;

    const providersHandler = route(deps.log, async (req, res) => {
        const result = await catalog.providers(modelIdOf(req), { refresh: wantsRefresh(req) });
        if (result.ok) return sendJson(res, 200, result.value);
        if (result.reason === 'not_found')
            throw new HttpError(404, 'model_not_found', 'NanoGPT does not know this model');
        throw new HttpError(
            502,
            'providers_unavailable',
            'The host list of this model could not be fetched from NanoGPT',
        );
    });

    const hintsHandler = route(deps.log, async (req, res) => {
        const id = modelIdOf(req);
        let model = catalog.lookupModel(id);
        if (!model) {
            // Not in memory: either the catalog is not loaded yet or the id is not in it.
            if (!(await catalog.catalog())) {
                throw new HttpError(
                    502,
                    'catalog_unavailable',
                    'The NanoGPT catalog is unavailable and no copy is stored',
                );
            }
            model = catalog.lookupModel(id);
            if (!model) throw new HttpError(404, 'model_not_found', 'This model is not in the catalog');
        }
        // Hints that need the hosts stay quiet when the list cannot be fetched.
        const providers = await catalog.providers(model.id);
        const mp: ModelProviders | null = providers.ok ? providers.value : null;
        const body: RoutingHintsResponse = { hints: routingHints(model, mp) };
        sendJson(res, 200, body);
    });

    router.get(
        '/catalog',
        route(deps.log, async (req, res) => {
            const result = await catalog.catalog({ refresh: wantsRefresh(req) });
            if (!result) {
                throw new HttpError(
                    502,
                    'catalog_unavailable',
                    'The NanoGPT catalog is unavailable and no copy is stored',
                );
            }
            sendJson(res, 200, result);
        }),
    );
    router.get('/catalog/providers', providersHandler);
    router.get('/catalog/hints', hintsHandler);
    router.get('/catalog/:id/providers', providersHandler);
    router.get('/catalog/:id/hints', hintsHandler);
};
