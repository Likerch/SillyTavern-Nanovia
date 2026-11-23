// The committed bundle: it must import in plain Node, expose { info, init, exit } like ST's plugin loader expects, serve
// its proxy and admin routes, and be exactly what `npm run build:server` produces from the current sources.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
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
        process.env['NANOVIA_PORT'] = '0';
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
                ['get', 'post', 'put', 'delete'].map((method) => [
                    method,
                    (route: string, handler: Handler) => routes.set(`${method.toUpperCase()} ${route}`, handler),
                ]),
            );
            await plugin.init(router);
            expect([...routes.keys()].sort()).toEqual([
                'DELETE /connections/:id',
                'DELETE /keys/:id',
                'GET /connections',
                'GET /keys',
                'GET /status',
                'POST /connections',
                'POST /connections/:id/rotate-token',
                'POST /keys',
                'POST /keys/:id/check',
                'PUT /connections/:id',
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

            const health = await fetch(`http://127.0.0.1:${status.proxy.port}/health`);
            expect(await health.json()).toEqual({ ok: true, version: pkg.version });

            await plugin.exit();
            await expect(fetch(`http://127.0.0.1:${status.proxy.port}/health`)).rejects.toThrow();
        } finally {
            quiet.forEach((s) => s.mockRestore());
            if (previousPort === undefined) delete process.env['NANOVIA_PORT'];
            else process.env['NANOVIA_PORT'] = previousPort;
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
