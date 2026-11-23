import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Server plugin build: one ESM file, server/index.js, that SillyTavern loads from <ST>/plugins/nanovia.
// Node built-ins and node-fetch (resolved from SillyTavern's own node_modules at runtime) stay external; everything else
// is bundled. SillyTavern's internal modules (src/endpoints/secrets.js, src/users.js) are imported by relative path at
// runtime with a computed URL, so the bundler never sees them.
export default defineConfig({
    build: {
        ssr: 'src/server/index.ts',
        outDir: 'server',
        // server/ also holds package.json, config.json and runtime data: only index.js is replaced.
        emptyOutDir: false,
        sourcemap: false,
        minify: false,
        target: 'node20',
        rollupOptions: {
            external: [/^node:/, ...builtinModules, 'node-fetch'],
            output: { format: 'es', entryFileNames: 'index.js' },
        },
    },
    ssr: { noExternal: true },
});
