import { afterEach, describe, expect, it, vi } from 'vitest';
import { QVINK_INTERCEPTOR, qvinkState, readStVersion } from '../../src/host/extensions';

const holder = globalThis as unknown as Record<string, unknown>;

afterEach(() => {
    delete holder[QVINK_INTERCEPTOR];
    vi.unstubAllGlobals();
});

function ctxWith(disabledExtensions: unknown): () => STContext {
    return () => ({ extensionSettings: { disabledExtensions } }) as unknown as STContext;
}

describe('qvinkState', () => {
    it('is "absent" when ST can say what is switched off and Qvink is neither loaded nor listed', () => {
        expect(qvinkState(ctxWith([]))).toBe('absent');
        expect(qvinkState(ctxWith(['third-party/Other-Extension']))).toBe('absent');
    });

    it('is "present" when Qvink’s interceptor is loaded and it is not switched off', () => {
        holder[QVINK_INTERCEPTOR] = () => {};
        expect(qvinkState(ctxWith([]))).toBe('present');
        expect(qvinkState(ctxWith(['third-party/Other-Extension']))).toBe('present');
    });

    it('is "disabled" when ST lists Qvink as switched off, loaded or not', () => {
        for (const name of ['third-party/SillyTavern-MessageSummarize', 'third-party/qvink_memory']) {
            expect(qvinkState(ctxWith([name])), name).toBe('disabled');
        }
        holder[QVINK_INTERCEPTOR] = () => {};
        expect(qvinkState(ctxWith(['third-party/SillyTavern-MessageSummarize']))).toBe('disabled');
    });

    it('ignores junk in the list', () => {
        expect(qvinkState(ctxWith([42, null, { name: 'qvink' }]))).toBe('absent');
    });

    it('cannot tell without the list: only a loaded interceptor is a sure sign', () => {
        for (const list of [undefined, null, 'qvink', {}]) {
            expect(qvinkState(ctxWith(list)), String(list)).toBe('unknown');
        }
        holder[QVINK_INTERCEPTOR] = () => {};
        expect(qvinkState(ctxWith(undefined))).toBe('present');
    });

    it('survives a context that cannot be read', () => {
        const broken = (): STContext => {
            throw new Error('SillyTavern is not here');
        };
        expect(qvinkState(broken)).toBe('unknown');
        holder[QVINK_INTERCEPTOR] = () => {};
        expect(qvinkState(broken)).toBe('present');
    });

    it('does not take a value that is not a function for the interceptor', () => {
        holder[QVINK_INTERCEPTOR] = 'yes';
        expect(qvinkState(ctxWith([]))).toBe('absent');
    });
});

function answer(body: unknown, status = 200): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
}

describe('readStVersion', () => {
    it('reads pkgVersion from GET /version', async () => {
        const fetchImpl = vi.fn(answer({ agent: 'x', pkgVersion: ' 1.19.2 ', gitRevision: 'abc' }));
        expect(await readStVersion(fetchImpl)).toBe('1.19.2');
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('/version');
    });

    it('uses the page’s fetch by default', async () => {
        const stub = vi.fn(answer({ pkgVersion: '1.20.0' }));
        vi.stubGlobal('fetch', stub);
        expect(await readStVersion()).toBe('1.20.0');
        expect(stub).toHaveBeenCalledOnce();
    });

    it('is null for an error status, a missing or empty version, junk and no answer', async () => {
        expect(await readStVersion(answer({ pkgVersion: '1.19.0' }, 404))).toBeNull();
        expect(await readStVersion(answer({ agent: 'x' }))).toBeNull();
        expect(await readStVersion(answer({ pkgVersion: '  ' }))).toBeNull();
        expect(await readStVersion(answer({ pkgVersion: 1.19 }))).toBeNull();
        expect(await readStVersion(answer('<html>not json</html>'))).toBeNull();
        expect(await readStVersion(answer('null'))).toBeNull();
        expect(
            await readStVersion(async () => {
                throw new TypeError('Failed to fetch');
            }),
        ).toBeNull();
    });

    it('gives up after the time limit', async () => {
        const hang = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            });
        expect(await readStVersion(hang, 10)).toBeNull();
    });
});
