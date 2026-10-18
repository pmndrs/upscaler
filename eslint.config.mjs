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
);
