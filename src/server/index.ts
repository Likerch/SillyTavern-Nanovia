// Nanovia server plugin for SillyTavern (docs/ARCHITECTURE.md §1, §3, §4).
// Install: copy server/ to <ST>/plugins/nanovia, set enableServerPlugins: true, restart ST.
// Optional config: <ST>/plugins/nanovia/config.json { "port": 8787, "upstreamBase": "...", "timeoutMs": 300000 };
// environment overrides: NANOVIA_PORT, NANOVIA_UPSTREAM.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID } from '../shared/constants';
import { startNanovia, type Nanovia } from './app';
import { parseConfig } from './config';
import { createStServices } from './st';
import type { FetchLike, Logger, RouterLike } from './types';
import { PLUGIN_VERSION } from './version';

export const info = {
    id: PLUGIN_ID,
    name: 'Nanovia',
    description:
        'NanoGPT for SillyTavern: a local OpenAI-compatible proxy with per-connection routing, billing awareness and a usage log. Keeps the NanoGPT key on the server.',
};

const LOG_PREFIX = '[Nanovia]';

const log: Logger = {
    info: (message) => console.info(LOG_PREFIX, message),
    warn: (message) => console.warn(LOG_PREFIX, message),
    error: (message) => console.error(LOG_PREFIX, message),
};

let running: Nanovia | null = null;

function readConfigFile(): string | null {
    try {
        return fs.readFileSync(fileURLToPath(new URL('./config.json', import.meta.url)), 'utf8');
    } catch {
        return null;
    }
}

/** ST's node-fetch honours its request-proxy settings; Node's own fetch is the fallback. */
async function loadFetch(): Promise<FetchLike> {
    try {
        const specifier = 'node-fetch';
        const mod = (await import(/* @vite-ignore */ specifier)) as { default?: unknown };
        if (typeof mod.default === 'function') return mod.default as FetchLike;
    } catch {
        // not running inside ST
    }
    return globalThis.fetch as unknown as FetchLike;
}

export async function init(router: RouterLike): Promise<void> {
    await exit(); // a second init in the same process must not leave the first listener behind
    const { config, warnings } = parseConfig(readConfigFile(), process.env);
    for (const warning of warnings) log.warn(warning);
    const st = await createStServices(log);
    const fetch = await loadFetch();
    running = await startNanovia(router, { config, st, fetch, log, catalog: { autoFetch: true } });
    const proxy = running.status;
    log.info(
        `v${PLUGIN_VERSION} ready (secrets: ${st.available ? 'ST' : 'unavailable'}, proxy: ${
            proxy.up ? `http://${proxy.host}:${proxy.port}` : `down (${proxy.error ?? 'unknown'})`
        })`,
    );
}

export async function exit(): Promise<void> {
    const current = running;
    running = null;
    await current?.close();
}
