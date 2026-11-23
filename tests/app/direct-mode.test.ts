// @vitest-environment happy-dom
// Direct mode as the App wires it: the request hook plans the request of a direct connection, the response tap turns
// the usage of the answer into a record on the bus, and both read the catalog through ctx (so a later catalog is used).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startNanovia } from '../../src/app/app';
import type { Runtime } from '../../src/app/app';
import { GENERATE_PATH } from '../../src/host/fetch-hook';
import { NANOGPT_API_BASE, NANOVIA_API_GLOBAL } from '../../src/shared/constants';
import type { UsageRecord } from '../../src/shared/contracts';
import { createFakeBackend } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { installStMock, seedConnectionManager } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { catalogOf, makeModel } from '../helpers/plan-fixtures';

const globals = globalThis as unknown as Record<string, unknown>;

let mock: StMock;
let backend: FakeBackend;
let runtime: Runtime | null;

beforeEach(() => {
    mock = installStMock();
    backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    seedConnectionManager(mock);
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    runtime = null;
    // ST's own backend answers a generate request with JSON that carries usage; everything else is the fake backend.
    mock.fetchImpl = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith(GENERATE_PATH)) {
            return new Response(
                JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0 } }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }
        return backend.fetch(input, init);
    };
});

afterEach(async () => {
    await runtime?.stop();
    mock.restore();
    delete globals[NANOVIA_API_GLOBAL];
    document.body.innerHTML = '';
});

async function directConnection(over: Record<string, unknown> = {}): Promise<{ id: string; secretId: string }> {
    runtime = await startNanovia({ skipInitialRefresh: true });
    const saved = await runtime.connections.save({
        patch: { name: 'Direct', modelId: 'vendor/model', mode: 'direct', ...over },
        directKey: 'sk-nano-direct-test-0001',
    });
    if (!saved.ok) throw new Error(`could not save: ${saved.error.code}`);
    const id = saved.data.id;
    const secretId = runtime.settings.get().directSecrets[id];
    if (!secretId) throw new Error('no secret was remembered');
    return { id, secretId };
}

function generate(secretId: string): Promise<Response> {
    return fetch(GENERATE_PATH, {
        method: 'POST',
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: NANOGPT_API_BASE,
            secret_id: secretId,
            model: 'vendor/model',
            type: 'normal',
            messages: [{ role: 'user', content: 'hi' }],
            reasoning_effort: 'high',
        }),
    });
}

function sentBody(): Record<string, unknown> {
    const body = mock.requests.filter((request) => request.url.endsWith(GENERATE_PATH)).at(-1)?.init?.body;
    return JSON.parse(String(body)) as Record<string, unknown>;
}

describe('direct mode in the App', () => {
    it('plans the request of a direct connection and sends the difference through custom_include_body', async () => {
        const { secretId } = await directConnection({
            routing: { enabled: true, order: ['Alpha'] },
            reasoning: { policy: 'fixed', effort: 'low', hideThoughts: false },
        });
        await generate(secretId);
        const body = sentBody();
        const include = String(body['custom_include_body']);
        expect(include).toContain('provider: {"order":["alpha"]}');
        expect(include).toContain('usage: {"include":true}');
        expect(include).toContain('reasoning: {"effort":"low"}');
        expect(body['reasoning_effort']).toBeUndefined();
    });

    it('emits a usage record on the bus when the answer comes back', async () => {
        const { id, secretId } = await directConnection();
        const records: UsageRecord[] = [];
        runtime!.ctx.bus.on('usage:record', ({ record }) => void records.push(record));
        const response = await generate(secretId);
        expect(((await response.json()) as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(100);
        await vi.waitFor(() => expect(records).toHaveLength(1));
        expect(records[0]).toMatchObject({
            connectionId: id,
            model: 'vendor/model',
            promptTokens: 100,
            completionTokens: 20,
            consumer: 'main',
            status: 200,
            stream: false,
        });
    });

    it('uses the catalog that is in ctx now, not the one at start', async () => {
        const { secretId } = await directConnection();
        const records: UsageRecord[] = [];
        runtime!.ctx.bus.on('usage:record', ({ record }) => void records.push(record));
        await generate(secretId);
        await vi.waitFor(() => expect(records).toHaveLength(1));
        // Nothing is known about the model yet: a request that cost 0 cannot be called a subscription one.
        expect(records[0]?.billing).toBe('unknown');

        runtime!.ctx.catalog = catalogOf([makeModel({ id: 'vendor/model', included: true })]);
        await generate(secretId);
        await vi.waitFor(() => expect(records).toHaveLength(2));
        expect(records[1]?.billing).toBe('subscription');
    });

    it('leaves requests of other connections and other profiles alone', async () => {
        await directConnection({ routing: { enabled: true, order: ['alpha'] } });
        await generate('somebody-elses-secret');
        expect(sentBody()['custom_include_body']).toBeUndefined();
    });

    it('stop removes the hook and the tap', async () => {
        const { secretId } = await directConnection({ routing: { enabled: true, order: ['alpha'] } });
        const records: UsageRecord[] = [];
        runtime!.ctx.bus.on('usage:record', ({ record }) => void records.push(record));
        await runtime!.stop();
        runtime = null;
        await generate(secretId);
        expect(sentBody()['custom_include_body']).toBeUndefined();
        expect(records).toEqual([]);
    });
});
