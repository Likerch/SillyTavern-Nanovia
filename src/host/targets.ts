// Recognising Nanovia's own endpoints in a URL: the local proxy (`http://127.0.0.1:<port>/c/<id>/v1`) and NanoGPT itself.
import { isValidConnectionId } from '../domain/connection';
import { NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK, PROXY_HOST } from '../shared/constants';

export interface ProxyTarget {
    connectionId: string;
    port: number;
}

const PROXY_PATH = /^\/c\/([a-z0-9]{6,16})\/v1\/?$/;
const PROXY_HOSTS = new Set<string>([PROXY_HOST, 'localhost']);

/** The connection id and port of a Nanovia proxy URL; null for any other URL. */
export function parseProxyUrl(value: unknown): ProxyTarget | null {
    if (typeof value !== 'string' || !value) return null;
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' || !PROXY_HOSTS.has(url.hostname) || !url.port) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const match = PROXY_PATH.exec(url.pathname);
    const connectionId = match?.[1];
    const port = Number(url.port);
    if (!connectionId || !isValidConnectionId(connectionId) || !Number.isInteger(port) || port <= 0) return null;
    return { connectionId, port };
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

/** true when the URL is NanoGPT's API base (either host) or a path under it. */
export function isNanoGptUrl(value: unknown): boolean {
    if (typeof value !== 'string' || !value) return false;
    const url = trimSlash(value.trim()).toLowerCase();
    return [NANOGPT_API_BASE, NANOGPT_API_BASE_FALLBACK].some((base) => {
        const lower = base.toLowerCase();
        return url === lower || url.startsWith(`${lower}/`);
    });
}
