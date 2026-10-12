import { resolve } from 'path';
import { configDefaults, defineConfig } from 'vitest/config';

// Library build for @pmndrs/upscaler. The interactive test bench has its own
// config at bench/vite.config.ts (run via `yarn dev` / `yarn bench`).
export default defineConfig({
    test: {
        environment: 'node',
        exclude: [...configDefaults.exclude, '**/.worktrees/**', 'artifacts/**'],
        // The shader tests import bench modules, which import the package by
        // its own name. Node's self-reference resolves that through
        // package.json `exports` → `dist/`, which doesn't exist before a build
        // (CI runs `npm test` first, so it failed there while passing locally
        // off a stale dist). Point it at the source, like bench/vite.config.ts.
        alias: {
            '@pmndrs/upscaler/core': resolve(__dirname, 'src/core/index.ts'),
            '@pmndrs/upscaler/three': resolve(__dirname, 'src/three/index.ts'),
            '@pmndrs/upscaler/babylon': resolve(__dirname, 'src/babylon/index.ts'),
            '@pmndrs/upscaler': resolve(__dirname, 'src/index.ts'),
        },
    },
    build: {
        lib: {
            entry: {
                index: resolve(__dirname, 'src/index.ts'),
                core: resolve(__dirname, 'src/core/index.ts'),
                three: resolve(__dirname, 'src/three/index.ts'),
                babylon: resolve(__dirname, 'src/babylon/index.ts'),
            },
            formats: ['es'],
            fileName: (_format, name) => `${name}.js`,
        },
        rollupOptions: {
            external: id => /^(?:three|@babylonjs\/core)(?:\/|$)/.test(id),
        },
    },
});
