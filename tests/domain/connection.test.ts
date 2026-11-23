import { describe, expect, it } from 'vitest';
import { createConnection, defaultRouting, mergeConnection, normalizeConnection } from '../../src/domain/connection';

describe('connection model', () => {
    it('creates a connection with defaults', () => {
        const c = createConnection({ name: ' Main ', modelId: 'deepseek/deepseek-v4.1-flash-1017' }, 'abc12345', 100);
        expect(c).toMatchObject({
            id: 'abc12345',
            name: 'Main',
            mode: 'auto',
            billing: 'auto',
            webSearch: false,
            stripNeutralSamplers: true,
            createdAt: 100,
            updatedAt: 100,
        });
        expect(c.routing).toEqual(defaultRouting());
        expect(c.reasoning).toEqual({ policy: 'follow', effort: null, hideThoughts: false });
    });

    it('ignores invalid fields of a patch and clamps numbers', () => {
        const base = createConnection({ name: 'A', modelId: 'm' }, 'abc12345', 1);
        const next = mergeConnection(
            base,
            {
                mode: 'nonsense',
                billing: 'subscription',
                routing: {
                    enabled: true,
                    sort: 'price',
                    quantizations: ['fp8', 'bad', 'fp8'],
                    only: [' DeepInfra ', 5, 'deepinfra'],
                },
                memory: { enabled: true, expirationDays: 9999 },
                maxPrice: 1,
            },
            2,
        );
        expect(next.mode).toBe('auto');
        expect(next.billing).toBe('subscription');
        expect(next.routing.enabled).toBe(true);
        expect(next.routing.sort).toBe('price');
        expect(next.routing.quantizations).toEqual(['fp8']);
        expect(next.routing.only).toEqual(['deepinfra']);
        expect(next.memory).toEqual({ enabled: true, expirationDays: 365 });
        expect(next.updatedAt).toBe(2);
        // The base object is untouched.
        expect(base.routing.enabled).toBe(false);
    });

    it('normalises a connection from disk and rejects junk', () => {
        expect(normalizeConnection(null, 1)).toBeNull();
        expect(normalizeConnection({ id: 'x', name: 'a', modelId: 'm' }, 1)).toBeNull();
        expect(normalizeConnection({ id: 'abc12345', name: '', modelId: 'm' }, 1)).toBeNull();
        const c = normalizeConnection(
            { id: 'abc12345', name: 'A', modelId: 'm', routing: { zdr: true }, createdAt: 5 },
            9,
        );
        expect(c?.routing.zdr).toBe(true);
        expect(c?.createdAt).toBe(5);
        expect(c?.updatedAt).toBe(9);
    });
});
