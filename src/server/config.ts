// Plugin configuration: defaults from shared/constants, overridden by `server/config.json` (next to the bundle) and
// then by the NANOVIA_* environment variables. A broken file or value never stops the plugin: it falls back to the
// default and reports a warning.
import {
    DEFAULT_PROXY_PORT,
    NANOGPT_API_BASE,
    NANOGPT_API_BASE_FALLBACK,
    NANOGPT_MGMT_BASE,
    NANOGPT_SITE,
} from '../shared/constants';

export const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;

export interface ServerConfig {
    /** Port of the proxy listener; 0 = any free port (tests). */
    port: number;
    /** NanoGPT API base without a trailing slash. */
    upstreamBase: string;
    /** Second base tried once after a connect-level failure; null = none. */
    upstreamFallbackBase: string | null;
    /** NanoGPT site, for the balance check. */
    siteBase: string;
    /**
     * The Management API base (`.../api/management/v1`), where the user's Management token goes. One host and no
     * fallback: whatever is set here is the only place the token is ever sent (a custom base never falls back to the
     * public one). A stand or a mock must set it too (`NANOVIA_MGMT`), the other bases do not carry over.
     */
    mgmtBase: string;
    /** Time to wait for the upstream answer, and between two chunks of a stream. */
    timeoutMs: number;
    /**
     * Degraded mode only (ST's secret store unavailable): a NanoGPT key from the config file. Never returned by a
     * route, never logged.
     */
    nanogptKey: string | null;
}

export interface LoadedConfig {
    config: ServerConfig;
    /** Human-readable problems found; never contain values. */
    warnings: string[];
}

export function defaultConfig(): ServerConfig {
    return {
        port: DEFAULT_PROXY_PORT,
        upstreamBase: NANOGPT_API_BASE,
        upstreamFallbackBase: NANOGPT_API_BASE_FALLBACK,
        siteBase: NANOGPT_SITE,
        mgmtBase: NANOGPT_MGMT_BASE,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        nanogptKey: null,
    };
}

/**
 * @param fileText the content of config.json, or null when there is no file
 * @param env the environment (process.env)
 */
export function parseConfig(fileText: string | null, env: Record<string, string | undefined>): LoadedConfig {
    const config = defaultConfig();
    const warnings: string[] = [];
    let file: Record<string, unknown> = {};
    if (fileText !== null) {
        try {
            const parsed: unknown = JSON.parse(fileText);
            if (isRecord(parsed)) file = parsed;
            else warnings.push('config.json is not an object; ignored');
        } catch {
            warnings.push('config.json is not valid JSON; ignored');
        }
    }

    const port = pick(file['port'], env['NANOVIA_PORT']);
    if (port !== undefined) {
        const n = typeof port === 'number' ? port : Number(String(port).trim());
        if (Number.isInteger(n) && n >= 0 && n <= 65535) config.port = n;
        else warnings.push('port is not an integer 0..65535; default used');
    }

    const upstream = pick(file['upstreamBase'], env['NANOVIA_UPSTREAM']);
    let upstreamOverridden = false;
    if (upstream !== undefined) {
        const base = cleanBase(upstream);
        if (base) {
            config.upstreamBase = base;
            upstreamOverridden = true;
        } else warnings.push('upstreamBase is not an http(s) URL; default used');
    }
    // A custom upstream (a mock, a corporate proxy) never falls back to the public site: the key would go there.
    if (upstreamOverridden) config.upstreamFallbackBase = null;
    if (file['upstreamFallbackBase'] === null) config.upstreamFallbackBase = null;
    else if (file['upstreamFallbackBase'] !== undefined) {
        const base = cleanBase(file['upstreamFallbackBase']);
        if (base) config.upstreamFallbackBase = base;
        else warnings.push('upstreamFallbackBase is not an http(s) URL; ignored');
    }

    const site = pick(file['siteBase'], env['NANOVIA_SITE']);
    if (site !== undefined) {
        const base = cleanBase(site);
        if (base) config.siteBase = base;
        else warnings.push('siteBase is not an http(s) URL; default used');
    }

    const mgmt = pick(file['mgmtBase'], env['NANOVIA_MGMT']);
    if (mgmt !== undefined) {
        const base = cleanBase(mgmt);
        if (base) config.mgmtBase = base;
        else warnings.push('mgmtBase is not an http(s) URL; default used');
    }

    if (file['timeoutMs'] !== undefined) {
        const n = file['timeoutMs'];
        if (typeof n === 'number' && Number.isFinite(n) && n >= MIN_TIMEOUT_MS && n <= MAX_TIMEOUT_MS) {
            config.timeoutMs = Math.round(n);
        } else warnings.push(`timeoutMs must be ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}; default used`);
    }

    if (typeof file['nanogptKey'] === 'string' && file['nanogptKey'].trim()) {
        config.nanogptKey = file['nanogptKey'].trim();
    }
    return { config, warnings };
}

function pick(fileValue: unknown, envValue: string | undefined): unknown {
    if (typeof envValue === 'string' && envValue.trim()) return envValue;
    return fileValue;
}

/** `https://host/path/` -> `https://host/path`; null when it is not an http(s) URL. */
function cleanBase(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
