// A fake nano-gpt.com for the catalog tests: the public catalog and host-list endpoints served from the real trimmed
// fixtures, with switches for outages, junk answers, hangs and a gate that holds responses (single-flight checks).
import type { IncomingMessage, ServerResponse } from 'node:http';
import modelsSample from '../fixtures/catalog/models.sample.json';
import deepseekProviders from '../fixtures/catalog/providers.deepseek-v4.1-flash-1017.json';
import emberProviders from '../fixtures/catalog/providers.ember-1.json';
import fixedRoute from '../fixtures/catalog/providers.glm-4.5v.fixed-route.json';
import glmProviders from '../fixtures/catalog/providers.glm-5.3.json';
import teeProviders from '../fixtures/catalog/providers.tee-glm-5.3.json';
import { startServer, type TestServer } from './helpers';

export type NanoMode =
    /** Normal answers. */
    | 'ok'
    /** 503 for everything. */
    | 'down'
    /** 200 with JSON that is not what the endpoint returns. */
    | 'junk'
    /** 200 with a body that is not JSON. */
    | 'html'
    /** Accepts the request and never answers. */
    | 'hang';

export const GLM = 'z-ai/glm-5.3';
export const GLM_FIXED_ROUTE = 'z-ai/glm-4.5v';
export const EMBER = 'fireworks/ember-1';
export const TEE_GLM = 'TEE/glm-5.3';
export const DEEPSEEK = 'deepseek/deepseek-v4.1-flash-1017';
/** Number of models in the sample catalog. */
export const SAMPLE_MODEL_COUNT = 20;

const HOST_LISTS: Record<string, unknown> = {
    [GLM]: glmProviders,
    [GLM_FIXED_ROUTE]: fixedRoute,
    [EMBER]: emberProviders,
    [TEE_GLM]: teeProviders,
    [DEEPSEEK]: deepseekProviders,
};

export interface FakeNanoGpt {
    server: TestServer;
    /** `http://127.0.0.1:<port>`: the value for `siteBase`. */
    site: string;
    mode: NanoMode;
    /** While set, every answer waits for it. */
    gate: Promise<void> | null;
    /** Requests to the catalog endpoint. */
    catalogHits(): number;
    /** Requests to the host list of a model (by decoded id). */
    providerHits(id: string): number;
    /** The raw request lines (`/api/models/z-ai%2Fglm-5.3/providers`), for URL-shape checks. */
    urls(): string[];
    /** Headers of the most recent request. */
    lastHeaders(): Record<string, string | string[] | undefined>;
    close(): Promise<void>;
}

export async function startFakeNanoGpt(): Promise<FakeNanoGpt> {
    const fake: FakeNanoGpt = {
        server: undefined as unknown as TestServer,
        site: '',
        mode: 'ok',
        gate: null,
        catalogHits: () => fake.server.requests.filter((r) => r.url.startsWith('/api/v1/models')).length,
        providerHits: (id) => fake.server.requests.filter((r) => decodeProvidersId(r.url) === id).length,
        urls: () => fake.server.requests.map((r) => r.url),
        lastHeaders: () => fake.server.requests.at(-1)?.headers ?? {},
        close: () => fake.server.close(),
    };
    fake.server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (fake.gate) await fake.gate;
        if (fake.mode === 'hang') return;
        if (fake.mode === 'down') return send(res, 503, { error: 'service unavailable' });
        if (fake.mode === 'html') return send(res, 200, '<html>maintenance</html>', 'text/html');
        const url = req.url ?? '';
        if (url.startsWith('/api/v1/models')) {
            return send(res, 200, fake.mode === 'junk' ? { error: 'nothing here' } : modelsSample);
        }
        const id = decodeProvidersId(url);
        if (id !== null) {
            if (fake.mode === 'junk') return send(res, 200, { error: 'nothing here' });
            const list = HOST_LISTS[id];
            return list ? send(res, 200, list) : send(res, 404, { error: 'model not found' });
        }
        return send(res, 404, { error: 'unknown route' });
    });
    fake.site = fake.server.origin;
    return fake;
}

function decodeProvidersId(url: string): string | null {
    const match = /^\/api\/models\/([^/]+)\/providers(?:\?.*)?$/.exec(url);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
