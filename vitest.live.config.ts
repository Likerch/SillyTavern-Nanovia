import { defineConfig } from 'vitest/config';

// Live checks against the real NanoGPT: only run on request (`npm run test:live`, needs NANOVIA_LIVE_KEY).
export default defineConfig({
    test: { include: ['tests/live/**/*.live.ts'], environment: 'node' },
});
