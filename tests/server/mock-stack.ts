// A whole plugin in front of the mock NanoGPT (tools/mock-nanogpt): the proxy, the admin routes, a catalog built from the
// mock's real-model snapshot, and one stored key. Used by the usage and account tests.
/* eslint-disable @typescript-eslint/no-explicit-any -- the mock and parsed JSON are inspected loosely */
import { normalizeCatalog } from '../../src/domain/catalog';
import type { CatalogModel } from '../../src/shared/contracts';
import { createMockServer } from '../../tools/mock-nanogpt/server.mjs';
import { NANO_KEY, boot, type BootOptions, type Harness } from './helpers';

export interface MockStack {
    mock: ReturnType<typeof createMockServer>;
    /** `http://127.0.0.1:<port>` of the mock. */
    origin: string;
    h: Harness;
    models: Map<string, CatalogModel>;
    /** The mock's request log for a path prefix (the key is masked there). */
    seen(path: string): any[];
    close(): Promise<void>;
}

export interface MockStackOptions extends BootOptions {
    /** false: the catalog knows nothing (the default of a plugin without stage 0.3). Ignored when lookupModel is given. */
    catalog?: boolean;
}

export async function startMockStack(options: MockStackOptions = {}): Promise<MockStack> {
    const mock = createMockServer();
    const port: number = await mock.listen(0);
    const origin = `http://127.0.0.1:${port}`;
    const models = new Map(normalizeCatalog(mock.catalog.models).map((m) => [m.id, m]));
    const withCatalog = options.catalog !== false;
    const h = await boot({
        ...options,
        lookupModel: options.lookupModel ?? (withCatalog ? (id) => models.get(id) ?? null : undefined),
        config: { upstreamBase: `${origin}/api/v1`, upstreamFallbackBase: null, siteBase: origin, ...options.config },
    });
    h.st.addNanoKey('default-user', NANO_KEY, 'main');
    return {
        mock,
        origin,
        h,
        models,
        seen: (path) => (mock.state.log as any[]).filter((entry) => String(entry.path).startsWith(path)),
        async close() {
            await h.close();
            await mock.close();
        },
    };
}
