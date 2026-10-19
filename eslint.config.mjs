import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/', 'bench/dist/', 'examples/dist/', '.claude/'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/consistent-type-imports': [
                'warn',
                { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
            ],
        },
    },
    {
        // The core runs on a bare GPUDevice; engines live in their adapters.
        files: ['packages/core/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['three', 'three/*', '@babylonjs/*', 'pixi.js', 'pixi.js/*', '@pmndrs/upscaler-*'],
                    message: 'packages/core must stay engine-free (and depend on no other workspace package).',
                }],
            }],
        },
    },
    {
        // Each adapter depends on the core and its own engine only.
        files: ['packages/three/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['@babylonjs/*', 'pixi.js', 'pixi.js/*', '@pmndrs/upscaler-babylon*', '@pmndrs/upscaler-pixi*'],
                    message: 'packages/three may import only three and @pmndrs/upscaler-core.',
                }],
            }],
        },
    },
    {
        files: ['packages/babylon/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    group: ['three', 'three/*', 'pixi.js', 'pixi.js/*', '@pmndrs/upscaler-three*', '@pmndrs/upscaler-pixi*'],
                    message: 'packages/babylon may import only @babylonjs/core and @pmndrs/upscaler-core.',
                }],
            }],
        },
    },
);
