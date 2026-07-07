import { resolve } from 'path';
import { defineConfig } from 'vite';

// Interactive FSR3 test bench. Serves this folder; the library is consumed
// straight from ../src so shader/pipeline edits hot-reload.
export default defineConfig({
    root: __dirname,
    resolve: {
        alias: {
            'three-fsr3': resolve(__dirname, '../src/index.ts'),
        },
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
