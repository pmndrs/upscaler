import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// Library build for @pmndrs/upscaler. The interactive test bench has its own
// config at bench/vite.config.ts (run via `yarn dev` / `yarn bench`).
export default defineConfig({
    test: {
        environment: 'node',
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'index',
        },
        rollupOptions: {
            external: ['three', 'three/tsl', 'three/webgpu'],
        },
    },
});
