import { describe, expect, it } from 'vitest';
import type { CatalogModel } from '../../src/shared/contracts';
import { SseSplitter, processSseText, rewriteSseEvent } from '../../src/domain/sse';
import type { ShimContext } from '../../src/domain/shim';

const MODEL: CatalogModel = {
    id: 'm',
    name: 'm',
    description: '',
    contextLength: null,
    maxOutputTokens: null,
    capabilities: { vision: false, reasoning: false, toolCalling: false, structuredOutput: false },
    reasoningEfforts: [],
    openWeights: false,
    pricing: { prompt: 1, completion: 2, cacheRead: null },
    category: null,
    subscription: { included: true, inputTokenMultiplier: 1 },
    providerIds: [],
    created: null,
};
const CTX: ShimContext = { model: MODEL, billingModeForced: false, explicitRouting: false, requestId: 'rid' };

const enc = new TextEncoder();

/** Feeds `parts` to a splitter and returns every event, flush included. */
function split(parts: Array<string | Uint8Array>): string[] {
    const splitter = new SseSplitter();
    const events: string[] = [];
    for (const part of parts) events.push(...splitter.feed(part));
    events.push(...splitter.flush());
    return events;
}

describe('SseSplitter', () => {
    it('splits events on a blank line and keeps every byte', () => {
        const text = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n';
        expect(split([text])).toEqual(['data: {"a":1}\n\n', 'data: {"a":2}\n\n', 'data: [DONE]\n\n']);
    });

    it('handles CRLF and CR line ends', () => {
        expect(split(['data: 1\r\n\r\ndata: 2\r\n\r\n'])).toEqual(['data: 1\r\n\r\n', 'data: 2\r\n\r\n']);
        expect(split(['data: 1\r\rdata: 2\r\r'])).toEqual(['data: 1\r\r', 'data: 2\r\r']);
        expect(split(['data: 1\n\r\ndata: 2\r\n\n'])).toEqual(['data: 1\n\r\n', 'data: 2\r\n\n']);
    });

    it('waits for a CR at the end of a chunk to see whether LF follows', () => {
        const splitter = new SseSplitter();
        expect(splitter.feed('data: 1\r\n\r')).toEqual([]);
        expect(splitter.feed('\ndata: 2\r')).toEqual(['data: 1\r\n\r\n']);
        expect(splitter.feed('\n')).toEqual([]);
        expect(splitter.feed('\r\n')).toEqual(['data: 2\r\n\r\n']);
        expect(splitter.flush()).toEqual([]);
    });

    it('joins an event split across chunks', () => {
        const splitter = new SseSplitter();
        expect(splitter.feed('data: {"par')).toEqual([]);
        expect(splitter.feed('t":1}\n')).toEqual([]);
        expect(splitter.feed('\ndata: next\n\n')).toEqual(['data: {"part":1}\n\n', 'data: next\n\n']);
    });

    it('keeps multi-line events, comments and field lines in one event', () => {
        const event = ': keep-alive\nevent: message\nid: 7\ndata: a\ndata: b\n\n';
        expect(split([event])).toEqual([event]);
    });

    it('reassembles multi-byte UTF-8 split anywhere across byte chunks', () => {
        const text = 'data: {"t":"Привет, мир 👋 ünï 漢字"}\n\ndata: {"t":"ещё 🙂"}\n\n';
        const bytes = enc.encode(text);
        const expected = ['data: {"t":"Привет, мир 👋 ünï 漢字"}\n\n', 'data: {"t":"ещё 🙂"}\n\n'];
        for (let cut = 1; cut < bytes.length; cut++) {
            expect(split([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(expected);
        }
        // One byte at a time.
        expect(split(Array.from(bytes, (b) => Uint8Array.of(b)))).toEqual(expected);
    });

    it('is lossless for any chunking of a mixed stream (the concatenation equals the input)', () => {
        const text = ': hi\r\n\r\ndata: 1\n\n\n\ndata: 2\r\n\r\ndata: 3\r\r\ndata: ü\n\n';
        const bytes = enc.encode(text);
        for (let a = 0; a < bytes.length; a += 3) {
            for (let b = a; b < bytes.length; b += 5) {
                const events = split([bytes.subarray(0, a), bytes.subarray(a, b), bytes.subarray(b)]);
                expect(events.join('')).toBe(text);
            }
        }
    });

    it('accepts strings and bytes in the same stream', () => {
        const splitter = new SseSplitter();
        expect(splitter.feed(enc.encode('data: 1\n'))).toEqual([]);
        expect(splitter.feed('\n')).toEqual(['data: 1\n\n']);
    });

    it('attaches stray blank lines to the next event', () => {
        expect(split(['\n\ndata: 1\n\n'])).toEqual(['\n\ndata: 1\n\n']);
    });

    it('returns an unterminated tail on flush, and trailing blank lines too', () => {
        expect(split(['data: 1\n\ndata: tail'])).toEqual(['data: 1\n\n', 'data: tail']);
        expect(split(['data: 1\n'])).toEqual(['data: 1\n']);
        expect(split(['data: 1\r'])).toEqual(['data: 1\r']);
        expect(split(['data: 1\n\n\n'])).toEqual(['data: 1\n\n', '\n']);
        expect(split([''])).toEqual([]);
    });

    it('flushes an incomplete UTF-8 sequence as a replacement character and can be reused', () => {
        const splitter = new SseSplitter();
        splitter.feed(Uint8Array.of(0x64, 0xd0));
        expect(splitter.flush()).toEqual(['d�']);
        expect(splitter.feed('data: 2\n\n')).toEqual(['data: 2\n\n']);
    });

    it('keeps a BOM as a character', () => {
        expect(split([Uint8Array.of(0xef, 0xbb, 0xbf, 0x64, 0x3a, 0x0a, 0x0a)])).toEqual(['﻿d:\n\n']);
    });
});

describe('rewriteSseEvent', () => {
    const final = {
        id: 'c1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 },
    };

    it('rewrites the usage of a data event and keeps the layout', () => {
        const raw = `event: message\nid: 9\ndata: ${JSON.stringify(final)}\n\n`;
        const { text, resolved } = rewriteSseEvent(raw, CTX);
        expect(resolved?.billing).toBe('subscription');
        const lines = text.split('\n');
        expect(lines.slice(0, 2)).toEqual(['event: message', 'id: 9']);
        expect(lines[2]?.startsWith('data: {')).toBe(true);
        expect(text.endsWith('\n\n')).toBe(true);
        const data = JSON.parse((lines[2] ?? '').slice(6));
        expect(data.choices).toEqual(final.choices);
        expect(data.usage.nanovia.billing).toBe('subscription');
    });

    it('keeps CRLF endings, the prefix spelling and a BOM', () => {
        const raw = `﻿data:${JSON.stringify(final)}\r\n\r\n`;
        const { text } = rewriteSseEvent(raw, CTX);
        expect(text.startsWith('﻿data:{')).toBe(true);
        expect(text.endsWith('}\r\n\r\n')).toBe(true);
    });

    it('collapses a multi-line data field into one line', () => {
        const json = JSON.stringify(final, null, 1).split('\n');
        const raw = json.map((l) => `data: ${l}`).join('\n') + '\n\n';
        const { text, resolved } = rewriteSseEvent(raw, CTX);
        expect(resolved).not.toBeNull();
        expect(text.split('\n')).toHaveLength(3);
        expect(JSON.parse(text.split('\n')[0]!.slice(6)).usage.cost).toBe(0);
    });

    it('survives U+2028 inside the JSON', () => {
        const chunk = { ...final, choices: [{ delta: { content: 'a b' }, finish_reason: 'stop' }] };
        const { text, resolved } = rewriteSseEvent(`data: ${JSON.stringify(chunk)}\n\n`, CTX);
        expect(resolved).not.toBeNull();
        expect(text).toContain('a b');
    });

    it('handles an event whose last line has no terminator', () => {
        const { text, resolved } = rewriteSseEvent(`data: ${JSON.stringify(final)}`, CTX);
        expect(resolved).not.toBeNull();
        expect(text.endsWith('}')).toBe(true);
        // A second data line makes the joined payload (with a newline between) invalid JSON: forwarded as it came.
        const raw = `data: ${JSON.stringify(final)}\ndata: more\n\n`;
        expect(rewriteSseEvent(raw, CTX)).toEqual({ text: raw, resolved: null });
        // An empty second line only adds whitespace to the JSON, so the event is still rewritten (to one line).
        const blank = rewriteSseEvent(`data: ${JSON.stringify(final)}\ndata: \n\n`, CTX);
        expect(blank.resolved).not.toBeNull();
        expect(blank.text.split('\n')).toHaveLength(3);
    });

    it.each([
        ['an ordinary chunk', 'data: {"choices":[{"delta":{"content":"usage of words"}}],"usage":null}\n\n'],
        ['[DONE]', 'data: [DONE]\n\n'],
        ['a comment that mentions usage', ': usage report\n\n'],
        ['no data field', 'event: usage\n\n'],
        ['data that is not JSON', 'data: usage is high\n\n'],
        ['usage without numbers', 'data: {"usage":{}}\n\n'],
    ])('returns %s untouched', (_name, raw) => {
        const result = rewriteSseEvent(raw, CTX);
        expect(result.text).toBe(raw);
        expect(result.resolved).toBeNull();
    });
});

describe('processSseText', () => {
    const delta = (content: string) =>
        `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content } }], usage: null })}\n\n`;
    const last = `data: ${JSON.stringify({
        id: 'c',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: 30,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 20 },
            cost: '0.0002',
        },
    })}\n\n`;

    it('forwards plain chunks byte for byte and rewrites only the usage chunk', () => {
        const input = delta('Hel') + delta('lo 👋') + last + 'data: [DONE]\n\n';
        const out = processSseText(input, CTX);
        expect(out.startsWith(delta('Hel') + delta('lo 👋'))).toBe(true);
        expect(out.endsWith('data: [DONE]\n\n')).toBe(true);
        const events = out.split('\n\n').filter(Boolean);
        expect(events).toHaveLength(4);
        const usage = JSON.parse(events[2]!.slice(6)).usage;
        expect(usage).toMatchObject({
            prompt_tokens: 30,
            total_tokens: 34,
            cost: 0.0002,
            prompt_tokens_details: { cached_tokens: 20 },
            nanovia: { billing: 'paygo', request_id: 'rid' },
        });
    });

    it('is the identity on a stream without usage', () => {
        const input = ': ping\n\n' + delta('a') + delta('b') + 'data: [DONE]\n\n';
        expect(processSseText(input, CTX)).toBe(input);
    });

    it('rewrites an unterminated final usage event', () => {
        const out = processSseText(last.trimEnd(), CTX);
        expect(JSON.parse(out.slice(6)).usage.nanovia.billing).toBe('paygo');
    });

    it('gives the same result when the stream arrives in chunks', () => {
        const input = delta('x') + last + 'data: [DONE]\n\n';
        const bytes = enc.encode(input);
        const whole = processSseText(input, CTX);
        const splitter = new SseSplitter();
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += 7) {
            for (const event of splitter.feed(bytes.subarray(i, i + 7))) parts.push(rewriteSseEvent(event, CTX).text);
        }
        for (const event of splitter.flush()) parts.push(rewriteSseEvent(event, CTX).text);
        expect(parts.join('')).toBe(whole);
    });
});
