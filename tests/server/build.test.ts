// The committed bundle: it must import in plain Node, expose { info, init, exit } like ST's plugin loader expects, serve
// its proxy and admin routes, and be exactly what `npm run build:server` produces from the current sources.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { SAMPLE_MODEL_COUNT, startFakeNanoGpt } from './catalog-fake';
import { cleanTempDirs, makeTempDir } from './helpers';

afterEach(cleanTempDirs);

const root = process.cwd();
const bundle = path.join(root, 'server', 'index.js');

interface PluginModule {
    info: { id: string; name: string; description: string };
    init(router: unknown): Promise<void>;
    exit(): Promise<void>;
}

type Handler = (req: unknown, res: unknown) => unknown;

describe('built server/index.js', () => {
    it('imports and exposes info, init and exit, serves the proxy and the admin routes, and exits cleanly', async () => {
        const previousPort = process.env['NANOVIA_PORT'];
        const previousSite = process.env['NANOVIA_SITE'];
        const globals = globalThis as { DATA_ROOT?: unknown };
        const previousRoot = globals.DATA_ROOT;
        // The plugin fetches the public catalog at start: point it at a fake site and a scratch data root.
        const nano = await startFakeNanoGpt();
        process.env['NANOVIA_PORT'] = '0';
        process.env['NANOVIA_SITE'] = nano.site;
        globals.DATA_ROOT = makeTempDir();
        const quiet = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')].map((s) => s.mockImplementation(() => {}));
        try {
            const plugin = (await import(/* @vite-ignore */ pathToFileURL(bundle).href)) as PluginModule;
            expect(plugin.info).toMatchObject({
                id: 'nanovia',
                name: expect.any(String),
                description: expect.any(String),
            });
            expect(typeof plugin.init).toBe('function');
            expect(typeof plugin.exit).toBe('function');

            const routes = new Map<string, Handler>();
            const router = Object.fromEntries(
                ['get', 'post', 'put', 'patch', 'delete'].map((method) => [
                    method,
                    (route: string, handler: Handler) => routes.set(`${method.toUpperCase()} ${route}`, handler),
                ]),
            );
            await plugin.init(router);
            expect([...routes.keys()].sort()).toEqual([
                'DELETE /connections/:id',
                'DELETE /keys/:id',
                'DELETE /mgmt/keys/:id',
                'DELETE /mgmt/presets/:name',
                'DELETE /mgmt/token',
                'GET /account/balance',
                'GET /account/subscription',
                'GET /catalog',
                'GET /catalog/:id/hints',
                'GET /catalog/:id/providers',
                'GET /catalog/hints',
                'GET /catalog/providers',
                'GET /connections',
                'GET /keys',
                'GET /mgmt/keys',
                'GET /mgmt/presets',
                'GET /mgmt/status',
                'GET /spend',
                'GET /status',
                'GET /usage/recent',
                'PATCH /mgmt/keys/:id',
                'POST /connections',
                'POST /connections/:id/rotate-token',
                'POST /keys',
                'POST /keys/:id/check',
                'POST /lookup/:requestId',
                'POST /mgmt/keys',
                'POST /mgmt/presets',
                'PUT /connections/:id',
                'PUT /mgmt/presets/:name',
                'PUT /mgmt/token',
            ]);

            let body: unknown;
            const res = {
                set: () => res,
                status: () => res,
                json: (value: unknown) => {
                    body = value;
                },
            };
            await routes.get('GET /status')!({ params: {} }, res);
            const status = body as {
                version: string;
                plugin: boolean;
                proxy: { up: boolean; host: string; port: number };
            };
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
            expect(status).toMatchObject({
                version: pkg.version,
                plugin: true,
                proxy: { up: true, host: '127.0.0.1' },
            });
            expect(status.proxy.port).toBeGreaterThan(0);

            await routes.get('GET /catalog')!({ params: {}, query: {} }, res);
            expect(body).toMatchObject({ source: 'live', models: expect.any(Array) });
            expect((body as { models: unknown[] }).models).toHaveLength(SAMPLE_MODEL_COUNT);
            expect(fs.existsSync(path.join(globals.DATA_ROOT as string, '_nanovia', 'catalog.json'))).toBe(true);

            await routes.get('GET /mgmt/status')!({ params: {}, query: {} }, res);
            expect(body).toEqual({ present: false, valid: null, checkedAt: null, error: null });

            const health = await fetch(`http://127.0.0.1:${status.proxy.port}/health`);
            expect(await health.json()).toEqual({ ok: true, version: pkg.version });

            await plugin.exit();
            await expect(fetch(`http://127.0.0.1:${status.proxy.port}/health`)).rejects.toThrow();
        } finally {
            quiet.forEach((s) => s.mockRestore());
            if (previousPort === undefined) delete process.env['NANOVIA_PORT'];
            else process.env['NANOVIA_PORT'] = previousPort;
            if (previousSite === undefined) delete process.env['NANOVIA_SITE'];
            else process.env['NANOVIA_SITE'] = previousSite;
            if (previousRoot === undefined) delete globals.DATA_ROOT;
            else globals.DATA_ROOT = previousRoot;
            await nano.close();
        }
    });

    it('is exactly what `npm run build:server` produces from the current sources', async () => {
        const out = makeTempDir();
        await build({
            root,
            configFile: path.join(root, 'vite.server.config.ts'),
            logLevel: 'silent',
            build: { outDir: out, emptyOutDir: true },
        });
        const fresh = fs.readFileSync(path.join(out, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
        const committed = fs.readFileSync(bundle, 'utf8').replace(/\r\n/g, '\n');
        expect(committed, 'server/index.js is stale: run `npm run build:server` and commit it').toBe(fresh);
    });
});
