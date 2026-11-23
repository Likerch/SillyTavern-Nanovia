import { describe, expect, it } from 'vitest';
import { isNanoGptUrl, parseProxyUrl } from '../../src/host/targets';

describe('parseProxyUrl', () => {
    it('reads the connection id and port of a proxy URL', () => {
        expect(parseProxyUrl('http://127.0.0.1:8787/c/abc12345/v1')).toEqual({ connectionId: 'abc12345', port: 8787 });
        expect(parseProxyUrl('http://localhost:9000/c/abcdef123456/v1/')).toEqual({
            connectionId: 'abcdef123456',
            port: 9000,
        });
        expect(parseProxyUrl(' http://127.0.0.1:8787/c/abc12345/v1 ')).toEqual({
            connectionId: 'abc12345',
            port: 8787,
        });
    });

    it('refuses anything else', () => {
        for (const url of [
            'https://127.0.0.1:8787/c/abc12345/v1',
            'http://127.0.0.1/c/abc12345/v1',
            'http://example.com:8787/c/abc12345/v1',
            'http://127.0.0.1:8787/c/ABC12345/v1',
            'http://127.0.0.1:8787/c/abc/v1',
            'http://127.0.0.1:8787/c/abc12345/v2',
            'http://127.0.0.1:8787/c/abc12345/v1/chat/completions',
            'http://user:pw@127.0.0.1:8787/c/abc12345/v1',
            'http://127.0.0.1:8787/c/abc12345/v1?x=1',
            'http://127.0.0.1:8787/api/plugins/nanovia',
            'not a url',
            '',
        ]) {
            expect(parseProxyUrl(url), url).toBeNull();
        }
        expect(parseProxyUrl(undefined)).toBeNull();
        expect(parseProxyUrl(5)).toBeNull();
    });
});

describe('isNanoGptUrl', () => {
    it('matches both NanoGPT hosts, with or without a trailing slash or a path', () => {
        expect(isNanoGptUrl('https://api.nano-gpt.com/api/v1')).toBe(true);
        expect(isNanoGptUrl('https://api.nano-gpt.com/api/v1/')).toBe(true);
        expect(isNanoGptUrl('https://NANO-GPT.com/api/v1/chat/completions')).toBe(true);
    });

    it('does not match look-alikes', () => {
        expect(isNanoGptUrl('https://api.nano-gpt.com.evil.example/api/v1')).toBe(false);
        expect(isNanoGptUrl('https://api.nano-gpt.com/api/v10')).toBe(false);
        expect(isNanoGptUrl('https://example.com/v1')).toBe(false);
        expect(isNanoGptUrl(null)).toBe(false);
    });
});
