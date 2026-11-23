import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROXY_PORT,
    NANOGPT_API_BASE,
    NANOGPT_API_BASE_FALLBACK,
    NANOGPT_MGMT_BASE,
} from '../../src/shared/constants';
import { DEFAULT_TIMEOUT_MS, defaultConfig, parseConfig } from '../../src/server/config';

describe('parseConfig', () => {
    it('uses the defaults without a file or environment', () => {
        const { config, warnings } = parseConfig(null, {});
        expect(config).toEqual(defaultConfig());
        expect(config.port).toBe(DEFAULT_PROXY_PORT);
        expect(config.upstreamBase).toBe(NANOGPT_API_BASE);
        expect(config.upstreamFallbackBase).toBe(NANOGPT_API_BASE_FALLBACK);
        expect(config.mgmtBase).toBe(NANOGPT_MGMT_BASE);
        expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
        expect(warnings).toEqual([]);
    });

    it('reads the file, then lets the environment win', () => {
        const file = JSON.stringify({ port: 9000, upstreamBase: 'http://127.0.0.1:1/api/v1/', timeoutMs: 5000 });
        expect(parseConfig(file, {}).config).toMatchObject({
            port: 9000,
            upstreamBase: 'http://127.0.0.1:1/api/v1',
            timeoutMs: 5000,
        });
        const env = { NANOVIA_PORT: '9100', NANOVIA_UPSTREAM: 'https://example.test/v1' };
        expect(parseConfig(file, env).config).toMatchObject({ port: 9100, upstreamBase: 'https://example.test/v1' });
    });

    it('never falls back to the public site when the upstream is custom, unless the file says so', () => {
        expect(parseConfig(null, { NANOVIA_UPSTREAM: 'http://localhost:5/v1' }).config.upstreamFallbackBase).toBeNull();
        const file = JSON.stringify({ upstreamBase: 'http://a.test/v1', upstreamFallbackBase: 'http://b.test/v1' });
        expect(parseConfig(file, {}).config.upstreamFallbackBase).toBe('http://b.test/v1');
        expect(parseConfig(JSON.stringify({ upstreamFallbackBase: null }), {}).config.upstreamFallbackBase).toBeNull();
    });

    it('reads the Management base from the file or NANOVIA_MGMT, and keeps it apart from the other bases', () => {
        expect(NANOGPT_MGMT_BASE).toBe('https://nano-gpt.com/api/management/v1');
        const file = JSON.stringify({ mgmtBase: 'http://127.0.0.1:5300/api/management/v1/' });
        expect(parseConfig(file, {}).config.mgmtBase).toBe('http://127.0.0.1:5300/api/management/v1');
        expect(parseConfig(file, { NANOVIA_MGMT: 'https://example.test/m' }).config.mgmtBase).toBe(
            'https://example.test/m',
        );
        // A custom upstream or site says nothing about where the Management token goes.
        const others = parseConfig(null, {
            NANOVIA_UPSTREAM: 'http://localhost:5/v1',
            NANOVIA_SITE: 'http://localhost:5',
        });
        expect(others.config.mgmtBase).toBe(NANOGPT_MGMT_BASE);
        // There is one Management host and no fallback for it to fall back to.
        expect(Object.keys(parseConfig(file, {}).config).filter((key) => /mgmt/i.test(key))).toEqual(['mgmtBase']);
    });

    it('falls back to defaults with a warning for broken values', () => {
        const file = JSON.stringify({
            port: 'abc',
            upstreamBase: 'ftp://x',
            timeoutMs: 5,
            siteBase: 'nope',
            mgmtBase: 'file:///etc',
        });
        const { config, warnings } = parseConfig(file, {});
        expect(config).toEqual(defaultConfig());
        expect(warnings).toHaveLength(5);
        expect(parseConfig('{ broken', {}).warnings).toEqual(['config.json is not valid JSON; ignored']);
        expect(parseConfig('[]', {}).warnings).toEqual(['config.json is not an object; ignored']);
        expect(parseConfig(null, { NANOVIA_PORT: '99999' }).warnings).toHaveLength(1);
    });

    it('accepts port 0 (any free port) and a degraded-mode key', () => {
        const { config } = parseConfig(JSON.stringify({ port: 0, nanogptKey: '  sk-test  ' }), {});
        expect(config.port).toBe(0);
        expect(config.nanogptKey).toBe('sk-test');
    });
});
