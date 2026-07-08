import { resolve } from 'path';
import { defineConfig } from 'vite';

// Standalone examples gallery. Serves this folder; the library is consumed
// straight from ../src so shader/pipeline edits hot-reload (same as the bench).
const root = __dirname;

export default defineConfig({
    root,
    resolve: {
        alias: {
            'three-fsr3': resolve(root, '../src/index.ts'),
        },
    },
    // Top-level await (renderer.init) needs a modern target.
    build: {
        target: 'esnext',
        rollupOptions: {
            // Multi-page build so `vite build` emits a hostable static gallery.
            input: {
                index: resolve(root, 'index.html'),
                hello: resolve(root, '01-hello/index.html'),
                compare: resolve(root, '02-fsr1-vs-fsr3/index.html'),
                split: resolve(root, '03-split-compare/index.html'),
                aliasing: resolve(root, '04-aliasing-torture/index.html'),
                transparency: resolve(root, '05-transparency/index.html'),
                screenspace: resolve(root, '06-screenspace-gi/index.html'),
                tslnode: resolve(root, '07-tsl-node/index.html'),
                compose: resolve(root, '08-tsl-compose/index.html'),
            },
        },
    },
    server: {
        port: 5300,
        open: false,
    },
});
