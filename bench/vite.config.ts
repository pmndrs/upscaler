import { resolve } from 'path';
import { defineConfig } from 'vite';

// Interactive FSR3 test bench. Serves this folder; the library is consumed
// straight from ../src so shader/pipeline edits hot-reload.
export default defineConfig({
    root: __dirname,
    // Own dep-optimizer cache. Vite otherwise resolves both this config and the
    // examples config to the repo's shared node_modules/.vite, so running both
    // dev servers at once re-optimizes under the other's feet and serves 504
    // "Outdated Optimize Dep" errors.
    cacheDir: resolve(__dirname, '../node_modules/.vite-bench'),
    resolve: {
        // Exact-match per subpath (a string key is a prefix alias).
        alias: [
            { find: /^@pmndrs\/upscaler$/, replacement: resolve(__dirname, '../src/index.ts') },
            { find: /^@pmndrs\/upscaler\/(core|three|babylon)$/, replacement: resolve(__dirname, '../src/$1.ts') },
        ],
    },
    // Top-level await (renderer.init) needs a modern target.
    build: {
        target: 'esnext',
    },
    server: {
        port: 5199,
        open: false,
    },
});
