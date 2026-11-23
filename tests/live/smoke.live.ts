// A real call to NanoGPT through the whole plugin (docs/DEPLOY.md "live check"). Skipped unless NANOVIA_LIVE_KEY is set;
// the key is read from the environment only, lives in memory, and is never printed. Spends a fraction of a cent.
//   PowerShell:  $env:NANOVIA_LIVE_KEY = '...'; npm run test:live
/* eslint-disable @typescript-eslint/no-explicit-any -- parsed JSON of responses is inspected loosely */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boot, cleanTempDirs, waitFor, type Harness } from '../server/helpers';

const KEY = process.env['NANOVIA_LIVE_KEY']?.trim() ?? '';
const MODEL = process.env['NANOVIA_LIVE_MODEL']?.trim() || 'deepseek/deepseek-v4.1-flash-1017';

describe.skipIf(!KEY)('live NanoGPT through the plugin', () => {
    let h: Harness;
    let token = '';

    beforeAll(async () => {
        h = await boot({ config: { upstreamFallbackBase: null } });
        h.st.addNanoKey('default-user', KEY, 'live');
        ({ token } = await h.connect({ name: 'Live', modelId: MODEL, mode: 'plugin' }));
    });

    afterAll(async () => {
        await h?.close();
        cleanTempDirs();
    });

    async function chat(body: Record<string, unknown>): Promise<Response> {
        const connections = (await h.api('GET', '/connections')).json['connections'] as any[];
        const base = (connections[0].proxyUrl as string).replace(/\/c\/.*$/, '');
        return fetch(`${base}/c/${connections[0].id}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    }

    it('answers a non-streaming request and reports a real cost', async () => {
        const response = await chat({
            model: MODEL,
            max_tokens: 24,
            messages: [{ role: 'user', content: 'Reply with one word: ok' }],
        });
        const text = await response.text();
        expect(response.status, text.replaceAll(KEY, '***')).toBe(200);
        const json = JSON.parse(text);
        expect(json.choices?.[0]?.message).toBeTruthy();
        expect(typeof json.usage?.cost).toBe('number');
        expect(text).not.toContain(KEY);
        const record = await waitFor(() => h.usage()[0]);
        expect(typeof record.costUsd).toBe('number');
        expect(record.promptTokens).toBeGreaterThan(0);
        expect(record.status).toBe(200);
    }, 60_000);

    it('streams and ends with usage', async () => {
        const response = await chat({
            model: MODEL,
            max_tokens: 24,
            stream: true,
            messages: [{ role: 'user', content: 'Reply with one word: ok' }],
        });
        const text = await response.text();
        expect(response.status, text.replaceAll(KEY, '***')).toBe(200);
        const tail = text.slice(-900).replaceAll(KEY, '***');
        expect(text, tail).toContain('[DONE]');
        expect(text, tail).toMatch(/"cost":\s*[0-9.e-]+/);
        expect(text).not.toContain(KEY);
    }, 60_000);

    it('leaves the key out of every log line and usage record', () => {
        expect(JSON.stringify(h.usage())).not.toContain(KEY);
        expect(h.logs.join('\n')).not.toContain(KEY);
    });
});
