// Shared helpers of the server tests: a fake SillyTavern (secrets + user directories), real http servers on port 0 for a
// fake upstream, and a harness that boots the whole plugin behind a real express Router.
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of test responses is inspected loosely */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { CatalogModel, ConnectionView } from '../../src/shared/contracts';
import { SECRET_KEY_CUSTOM, SECRET_KEY_NANOGPT } from '../../src/shared/constants';
import { startNanovia, type Nanovia } from '../../src/server/app';
import { defaultConfig, type ServerConfig } from '../../src/server/config';
import type { PipelineSteps } from '../../src/server/proxy';
import type { FetchLike, Logger, SecretEntry, StServices } from '../../src/server/types';

export const NANO_KEY = 'sk-nano-0123456789abcdefghijklmnopqrstuv-KEYTAIL';

/* ------------------------------------------------------------------------------------------------ files */

const tempDirs: string[] = [];

export function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanovia-test-'));
    tempDirs.push(dir);
    return dir;
}

export function cleanTempDirs(): void {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------------------------------------ fake ST */

export class FakeSt implements StServices {
    available = true;
    private readonly secrets = new Map<string, SecretEntry[]>();
    private counter = 0;

    constructor(private readonly root: string) {}

    dataRoot(): string {
        return this.root;
    }

    userRoot(handle: string): string {
        return path.join(this.root, handle);
    }

    private list(handle: string, key: string): SecretEntry[] {
        const id = `${handle}\u0000${key}`;
        let entries = this.secrets.get(id);
        if (!entries) {
            entries = [];
            this.secrets.set(id, entries);
        }
        return entries;
    }

    listSecrets(handle: string, key: string): SecretEntry[] {
        return this.list(handle, key).map((s) => ({ ...s }));
    }

    readSecret(handle: string, key: string, id: string | null): string {
        const found = this.list(handle, key).find((s) => (id ? s.id === id : s.active));
        return found?.value ?? '';
    }

    writeSecret(handle: string, key: string, value: string, label: string, options?: { keepActive?: boolean }): string {
        const entries = this.list(handle, key);
        const previous = entries.find((s) => s.active);
        for (const s of entries) s.active = false;
        const id = `secret-${++this.counter}`;
        entries.push({ id, label, active: true, value });
        if (options?.keepActive && previous) {
            previous.active = true;
            const added = entries.find((s) => s.id === id);
            if (added) added.active = false;
        }
        return id;
    }

    renameSecret(handle: string, key: string, id: string, label: string): void {
        const found = this.list(handle, key).find((s) => s.id === id);
        if (found) found.label = label;
    }

    deleteSecret(handle: string, key: string, id: string): void {
        const entries = this.list(handle, key);
        const index = entries.findIndex((s) => s.id === id);
        if (index >= 0) entries.splice(index, 1);
        const first = entries[0];
        if (first && !entries.some((s) => s.active)) first.active = true;
    }

    /** Test shortcut: a NanoGPT key stored the way ST stores it. */
    addNanoKey(handle = 'default-user', value = NANO_KEY, label = 'main'): string {
        return this.writeSecret(handle, SECRET_KEY_NANOGPT, value, label);
    }

    /** Every secret value of the fake store, for "nothing leaked" checks. */
    allValues(): string[] {
        return [...this.secrets.values()].flatMap((entries) => entries.map((s) => s.value ?? ''));
    }
}

/* ------------------------------------------------------------------------------------------------ http servers */

export interface RecordedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

export interface TestServer {
    port: number;
    /** `http://127.0.0.1:<port>`. */
    origin: string;
    requests: RecordedRequest[];
    close(): Promise<void>;
}

export async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>,
    port = 0,
): Promise<TestServer> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
            Promise.resolve(handler(req, res, body)).catch(() => {
                if (!res.headersSent) res.writeHead(500);
                res.end();
            });
        });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const actual = (server.address() as AddressInfo).port;
    return {
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** An upstream that answers every chat completion with a fixed OpenAI-style reply. */
export function jsonUpstream(extra: Record<string, unknown> = {}): Promise<TestServer> {
    return startServer((_req, res, body) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'up-123' });
        res.end(
            JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
                echo: JSON.parse(body || '{}'),
                ...extra,
            }),
        );
    });
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = read();
        if (value) return value;
        if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
        await sleep(15);
    }
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/** A port that nothing listens on (bound and released). */
export async function closedPort(): Promise<number> {
    const server = await startServer(() => {});
    const port = server.port;
    await server.close();
    return port;
}

/* ------------------------------------------------------------------------------------------------ harness */

export interface BootOptions {
    st?: FakeSt;
    config?: Partial<ServerConfig>;
    steps?: PipelineSteps;
    fetch?: FetchLike;
    /** Fixed clock for the plugin. */
    now?: () => number;
    /** The catalog seam; absent = the catalog knows nothing. */
    lookupModel?: (modelId: string) => CatalogModel | null;
    providerSelection?: (modelId: string) => boolean | null;
}

export interface Harness {
    st: FakeSt;
    root: string;
    app: Nanovia;
    logs: string[];
    /** `http://127.0.0.1:<port>/api/plugins/nanovia` of the express test app. */
    admin: string;
    /** `http://127.0.0.1:<port>` of the proxy listener. */
    proxy: string;
    api(
        method: string,
        route: string,
        body?: unknown,
        user?: string,
    ): Promise<{ status: number; json: Record<string, any>; text: string }>;
    /** Creates a connection through the admin API and returns the view and its proxy token. */
    connect(body?: Record<string, unknown>, user?: string): Promise<{ view: ConnectionView; token: string }>;
    usage(user?: string): Record<string, any>[];
    close(): Promise<void>;
}

export function recordingLogger(): { log: Logger; lines: string[] } {
    const lines: string[] = [];
    return {
        lines,
        log: {
            info: (m) => lines.push(`info ${m}`),
            warn: (m) => lines.push(`warn ${m}`),
            error: (m) => lines.push(`error ${m}`),
        },
    };
}

export async function boot(options: BootOptions = {}): Promise<Harness> {
    const root = makeTempDir();
    const st = options.st ?? new FakeSt(root);
    const dataRoot = st.dataRoot();
    const { log, lines } = recordingLogger();
    const router = express.Router();
    const config: ServerConfig = { ...defaultConfig(), port: 0, ...options.config };
    const app = await startNanovia(router, {
        config,
        st,
        fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike),
        log,
        steps: options.steps,
        now: options.now,
        lookupModel: options.lookupModel,
        providerSelection: options.providerSelection,
        version: '9.9.9-test',
    });

    const express_ = express();
    express_.use(express.json());
    express_.use((req, _res, next) => {
        const user = req.headers['x-test-user'];
        if (typeof user === 'string') Object.assign(req, { user: { profile: { handle: user } } });
        next();
    });
    express_.use('/api/plugins/nanovia', router);
    const adminServer = http.createServer(express_);
    await new Promise<void>((resolve) => adminServer.listen(0, '127.0.0.1', resolve));
    const admin = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}/api/plugins/nanovia`;

    const api: Harness['api'] = async (method, route, body, user) => {
        const response = await fetch(`${admin}${route}`, {
            method,
            headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let json: Record<string, any> = {};
        try {
            json = JSON.parse(text);
        } catch {
            // not JSON
        }
        return { status: response.status, json, text };
    };

    return {
        st,
        root: dataRoot,
        app,
        logs: lines,
        admin,
        get proxy() {
            return `http://127.0.0.1:${app.proxy.status().port}`;
        },
        api,
        async connect(body = {}, user = 'default-user') {
            const created = await api('POST', '/connections', { name: 'Main', modelId: 'glm-5', ...body }, user);
            if (created.status !== 200) throw new Error(`connect failed: ${created.status} ${created.text}`);
            const view = created.json['connection'] as ConnectionView;
            const token = view.tokenSecretId ? st.readSecret(user, SECRET_KEY_CUSTOM, view.tokenSecretId) : '';
            return { view, token };
        },
        usage(user = 'default-user') {
            const dir = path.join(st.userRoot(user), 'nanovia');
            if (!fs.existsSync(dir)) return [];
            return fs
                .readdirSync(dir)
                .filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
                .sort()
                .flatMap((f) =>
                    fs
                        .readFileSync(path.join(dir, f), 'utf8')
                        .split('\n')
                        .filter(Boolean)
                        .map((line) => JSON.parse(line) as Record<string, any>),
                );
        },
        async close() {
            await app.close();
            await new Promise<void>((resolve) => {
                adminServer.close(() => resolve());
                adminServer.closeAllConnections();
            });
        },
    };
}

/** POST /c/<id>/v1/chat/completions through the proxy. */
export function chat(
    harness: Pick<Harness, 'proxy'>,
    connectionId: string,
    token: string,
    body: Record<string, unknown>,
    init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
    return fetch(`${harness.proxy}/c/${connectionId}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers },
        body: JSON.stringify(body),
        signal: init.signal,
    });
}
