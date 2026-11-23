import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createSecretsHost } from '../../src/host/secrets';
import type { SecretsHost } from '../../src/host/secrets';
import { SECRET_KEY_CUSTOM } from '../../src/shared/constants';
import { createFakeBackend } from '../helpers/fake-backend';
import type { FakeBackend } from '../helpers/fake-backend';
import { memoryLogger } from '../helpers/fakes';
import type { MemoryLogger } from '../helpers/fakes';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

const KEY = 'sk-nano-super-secret-value-0001';

let mock: StMock;
let backend: FakeBackend;
let log: MemoryLogger;
let secrets: SecretsHost;
let afterChange: Mock<() => Promise<void>>;

beforeEach(() => {
    mock = installStMock();
    backend = createFakeBackend();
    backend.csrf = mock.csrfToken;
    log = memoryLogger();
    afterChange = vi.fn<() => Promise<void>>(async () => {});
    secrets = createSecretsHost({ ctx: () => mock.context, log, fetchImpl: backend.fetch, afterChange });
});

afterEach(() => mock.restore());

function customRows() {
    return backend.secrets.get(SECRET_KEY_CUSTOM) ?? [];
}

describe('write', () => {
    it('writes under api_key_custom and returns only the id', async () => {
        const result = await secrets.write(KEY, 'Nanovia: Main (direct)');
        expect(result.ok).toBe(true);
        expect(JSON.stringify(result)).not.toContain(KEY);
        expect(customRows()).toHaveLength(1);
        expect(customRows()[0]).toMatchObject({ value: KEY, label: 'Nanovia: Main (direct)' });
        expect(result.ok && result.id).toBe(customRows()[0]?.id);
        expect(afterChange).toHaveBeenCalledOnce();
    });

    it('trims a pasted key and refuses an empty one', async () => {
        await secrets.write(`  ${KEY}\n`, 'L');
        expect(customRows()[0]?.value).toBe(KEY);
        expect(await secrets.write('   ', 'L')).toEqual({ ok: false, error: 'empty' });
        expect(customRows()).toHaveLength(1);
    });

    it("puts the user's previously active Custom key back, so their own setup keeps working", async () => {
        backend.secrets.set(SECRET_KEY_CUSTOM, [
            { id: 'mine', value: 'my-own-key', label: 'My proxy', active: false },
            { id: 'active-one', value: 'active-key', label: 'Active', active: true },
        ]);
        const result = await secrets.write(KEY, 'Nanovia');
        expect(result.ok).toBe(true);
        const active = customRows().filter((row) => row.active);
        expect(active.map((row) => row.id)).toEqual(['active-one']);
        expect(customRows()).toHaveLength(3);
    });

    it('lets the new secret be active when there was none before', async () => {
        const result = await secrets.write(KEY, 'Nanovia');
        expect(customRows().find((row) => row.active)?.id).toBe(result.ok ? result.id : '');
    });

    it('reports a refusal by status and never leaks the value in errors or logs', async () => {
        backend.csrf = 'other';
        const result = await secrets.write(KEY, 'Nanovia');
        expect(result).toEqual({ ok: false, error: 'HTTP 403' });
        const failing = createSecretsHost({
            ctx: () => mock.context,
            log,
            fetchImpl: async () => {
                throw new TypeError('Failed to fetch');
            },
        });
        const down = await failing.write(KEY, 'Nanovia');
        expect(down.ok).toBe(false);
        expect(JSON.stringify([result, down, log.lines])).not.toContain(KEY);
    });

    it('rejects an answer without an id', async () => {
        const odd = createSecretsHost({
            ctx: () => mock.context,
            log,
            fetchImpl: async (input) =>
                String(input).endsWith('/read') ? new Response('{}') : new Response(JSON.stringify({ nope: 1 })),
        });
        expect(await odd.write(KEY, 'L')).toEqual({ ok: false, error: 'no id in the answer' });
    });

    it("still succeeds when ST's list cannot be refreshed", async () => {
        afterChange.mockRejectedValueOnce(new Error('no secrets.js'));
        expect((await secrets.write(KEY, 'L')).ok).toBe(true);
    });

    it('warns, without the value, when the previous key could not be put back', async () => {
        backend.secrets.set(SECRET_KEY_CUSTOM, [{ id: 'a', value: 'x', label: 'A', active: true }]);
        const flaky = createSecretsHost({
            ctx: () => mock.context,
            log,
            fetchImpl: async (input, init) =>
                String(input).endsWith('/rotate') ? new Response('no', { status: 500 }) : backend.fetch(input, init),
        });
        expect((await flaky.write(KEY, 'L')).ok).toBe(true);
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
        expect(JSON.stringify(log.lines)).not.toContain(KEY);
    });
});

describe('remove and has', () => {
    it('removes one secret by id and keeps the others', async () => {
        const first = await secrets.write(KEY, 'A');
        const second = await secrets.write('another-key-value-0002', 'B');
        if (!first.ok || !second.ok) throw new Error('write failed');
        expect(await secrets.has(first.id)).toBe(true);
        expect(await secrets.remove(first.id)).toBe(true);
        expect(await secrets.has(first.id)).toBe(false);
        expect(await secrets.has(second.id)).toBe(true);
    });

    it('does not delete "the active one" when no id is given', async () => {
        await secrets.write(KEY, 'A');
        expect(await secrets.remove('')).toBe(false);
        expect(customRows()).toHaveLength(1);
    });

    it('answers null from has() when ST cannot be asked, false when there are no secrets at all', async () => {
        expect(await secrets.has('x')).toBe(false);
        const down = createSecretsHost({
            ctx: () => mock.context,
            log,
            fetchImpl: async () => {
                throw new TypeError('Failed to fetch');
            },
        });
        expect(await down.has('x')).toBeNull();
        expect(await down.remove('x')).toBe(false);
    });

    it('drops values even when ST exposes them in the state', async () => {
        const exposing = createSecretsHost({
            ctx: () => mock.context,
            log,
            fetchImpl: async () =>
                new Response(
                    JSON.stringify({ [SECRET_KEY_CUSTOM]: [{ id: 's1', value: KEY, label: 'L', active: true }] }),
                ),
        });
        expect(await exposing.has('s1')).toBe(true);
        expect(JSON.stringify(log.lines)).not.toContain(KEY);
    });
});

describe('sync', () => {
    it("asks ST's own secret list to catch up with the server", async () => {
        await secrets.sync();
        expect(afterChange).toHaveBeenCalledOnce();
    });

    it('never throws when the refresh fails', async () => {
        const failing = createSecretsHost({
            ctx: () => mock.context,
            log,
            fetchImpl: backend.fetch,
            afterChange: async () => {
                throw new Error('module gone');
            },
        });
        await expect(failing.sync()).resolves.toBeUndefined();
    });

    it('is a no-op without a refresh hook', async () => {
        const bare = createSecretsHost({ ctx: () => mock.context, log, fetchImpl: backend.fetch });
        await expect(bare.sync()).resolves.toBeUndefined();
    });
});
