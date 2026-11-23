import { describe, expect, it } from 'vitest';
import { mergeYamlEntries } from '../../src/host/yaml-merge';

const ENTRIES = { 'x-nanovia-effort': 'high', 'x-nanovia-consumer': 'main' };

function ok(result: ReturnType<typeof mergeYamlEntries>) {
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
    return result;
}

describe('mergeYamlEntries: shapes it understands', () => {
    it('fills an empty field', () => {
        for (const existing of [undefined, null, '', '  \n']) {
            const result = ok(mergeYamlEntries(existing, ENTRIES, { ignoreCase: true }));
            expect(result.text).toBe(
                `${existing ? existing : ''}x-nanovia-effort: "high"\nx-nanovia-consumer: "main"\n`,
            );
            expect(result.added).toEqual(['x-nanovia-effort', 'x-nanovia-consumer']);
        }
    });

    it('keeps a comment-only field and adds below it', () => {
        const result = ok(mergeYamlEntries('# my headers', ENTRIES));
        expect(result.text).toBe('# my headers\nx-nanovia-effort: "high"\nx-nanovia-consumer: "main"\n');
    });

    it("appends to an existing block mapping without touching the user's lines", () => {
        const existing = 'X-Title: SillyTavern\n# keep me\nHTTP-Referer: "https://example.com"\n';
        const result = ok(mergeYamlEntries(existing, ENTRIES, { ignoreCase: true }));
        expect(result.text.startsWith(existing)).toBe(true);
        expect(result.text).toContain('x-nanovia-effort: "high"');
        expect(result.added).toHaveLength(2);
    });

    it('adds the missing final newline and handles CRLF', () => {
        expect(ok(mergeYamlEntries('A: 1', { b: 'x' })).text).toBe('A: 1\nb: "x"\n');
        const crlf = ok(mergeYamlEntries('A: 1\r\nB: 2\r\n', { c: 'x' }));
        expect(crlf.text.startsWith('A: 1\r\nB: 2\r\n')).toBe(true);
        expect(crlf.text).toContain('c: "x"');
    });

    it('skips over nested and multi-line values of the user', () => {
        const existing = 'A:\n  nested: 1\n  other: [1, 2]\nB: |\n  text\n  # not a comment of ours\nC: "x"\n';
        const result = ok(mergeYamlEntries(existing, { d: 'y' }));
        expect(result.text).toBe(`${existing}d: "y"\n`);
    });

    it('understands quoted and punctuated keys', () => {
        const existing = '"X-Quoted": 1\n\'single\': 2\nX.Dotted-Key: 3\n';
        const result = ok(
            mergeYamlEntries(existing, { 'X-Quoted': 'ours', single: 'ours', 'X.Dotted-Key': 'ours', fresh: 'yes' }),
        );
        expect(result.kept).toEqual(['X-Quoted', 'single', 'X.Dotted-Key']);
        expect(result.added).toEqual(['fresh']);
    });

    it('never clobbers: a key the user set stays, headers compare without case', () => {
        const existing = 'X-Nanovia-Effort: low\n';
        const headers = ok(mergeYamlEntries(existing, ENTRIES, { ignoreCase: true }));
        expect(headers.kept).toEqual(['x-nanovia-effort']);
        expect(headers.added).toEqual(['x-nanovia-consumer']);
        expect(headers.text).toContain('X-Nanovia-Effort: low');
        expect(headers.text).not.toContain('x-nanovia-effort: "high"');
        // Case matters for body fields: `Provider` is not `provider`.
        const body = ok(mergeYamlEntries('Provider: 1\n', { provider: { order: ['a'] } }));
        expect(body.added).toEqual(['provider']);
    });

    it('returns the text unchanged when everything is there already (idempotent)', () => {
        const once = ok(mergeYamlEntries('', ENTRIES, { ignoreCase: true }));
        const twice = ok(mergeYamlEntries(once.text, ENTRIES, { ignoreCase: true }));
        expect(twice.text).toBe(once.text);
        expect(twice.added).toEqual([]);
    });

    it('writes values as JSON, so objects and awkward strings stay valid YAML', () => {
        const result = ok(
            mergeYamlEntries('', {
                provider: { order: ['a', 'b'], allow_fallbacks: false },
                note: 'a: b # c',
                'we ird': 1,
                yes: true,
            }),
        );
        expect(result.text).toBe(
            'provider: {"order":["a","b"],"allow_fallbacks":false}\nnote: "a: b # c"\n"we ird": 1\n"yes": true\n',
        );
    });

    it('ignores entries whose value is undefined', () => {
        const result = ok(mergeYamlEntries('', { a: undefined, b: 'x' }));
        expect(result.added).toEqual(['b']);
    });
});

describe('mergeYamlEntries: JSON-like fields', () => {
    it('merges into a JSON object and writes JSON back', () => {
        const result = ok(mergeYamlEntries('{"X-Title": "ST"}', ENTRIES, { ignoreCase: true }));
        expect(JSON.parse(result.text)).toEqual({ 'X-Title': 'ST', ...ENTRIES });
    });

    it("keeps the user's own entry of a JSON object", () => {
        const result = ok(mergeYamlEntries('{"X-Nanovia-Effort": "low"}', ENTRIES, { ignoreCase: true }));
        expect(JSON.parse(result.text)).toEqual({ 'X-Nanovia-Effort': 'low', 'x-nanovia-consumer': 'main' });
    });

    it('adds one more object to a JSON list of objects', () => {
        const result = ok(mergeYamlEntries('[{"A": 1}, {"B": 2}]', ENTRIES));
        expect(JSON.parse(result.text)).toEqual([{ A: 1 }, { B: 2 }, ENTRIES]);
    });

    it('leaves text alone when nothing is to be added', () => {
        const text = '{"x-nanovia-effort": "a", "x-nanovia-consumer": "b"}';
        const result = ok(mergeYamlEntries(text, ENTRIES));
        expect(result.text).toBe(text);
        expect(result.added).toEqual([]);
    });
});

describe('mergeYamlEntries: what it refuses', () => {
    const refused = (text: string) => {
        const result = mergeYamlEntries(text, ENTRIES);
        expect(result.ok).toBe(false);
        return result;
    };

    it('flow mappings that are not plain JSON', () => {
        refused('{X-Title: ST}');
        refused("{'X-Title': 'ST'}");
    });

    it('JSON that is not an object or a list of objects', () => {
        refused('[1, 2]');
        refused('["a"]');
    });

    it('block sequences', () => {
        refused('- X-Title: ST\n- A: 1\n');
        refused('-\n');
    });

    it('an indented first entry', () => {
        refused('  A: 1\n');
    });

    it('document markers', () => {
        refused('---\nA: 1\n');
        refused('A: 1\n...\n');
    });

    it('top-level lines that are not a plain key: value', () => {
        refused('just a scalar\n');
        refused('A: 1\nbroken line\n');
        refused('A: {\n  b: 1\n}\n');
        refused('&anchor A: 1\n');
        refused('? complex\n: key\n');
        refused('a:b: 1\n');
    });

    it('says why', () => {
        const result = mergeYamlEntries('- a: 1', ENTRIES);
        expect(result).toEqual({ ok: false, reason: 'a block sequence' });
    });
});
