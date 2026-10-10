import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import config from './vite.config';

const originalPackageEntry = process.env.UPSCALER_PACKAGE_ENTRY;

afterEach(() => {
    if (originalPackageEntry === undefined) delete process.env.UPSCALER_PACKAGE_ENTRY;
    else process.env.UPSCALER_PACKAGE_ENTRY = originalPackageEntry;
});

test('package-consumer mode resolves Example 13 from the packed entry', async () => {
    const packageEntry = '/tmp/upscaler-consumer/package/dist/index.js';
    process.env.UPSCALER_PACKAGE_ENTRY = packageEntry;

    const resolvedConfig =
        typeof config === 'function'
            ? await config({
                  command: 'build',
                  mode: 'package-consumer',
                  isSsrBuild: false,
                  isPreview: false,
              })
            : config;

    expect(resolvedConfig.resolve?.alias).toMatchObject({
        '@pmndrs/upscaler': packageEntry,
    });
    expect(resolvedConfig.build?.rollupOptions?.input).toEqual({
        guidesnode: resolve(import.meta.dirname, '13-guides-node/index.html'),
    });
});

test('ordinary modes ignore the package entry and resolve source', async () => {
    process.env.UPSCALER_PACKAGE_ENTRY = '/tmp/upscaler-consumer/package/dist/index.js';

    const resolvedConfig =
        typeof config === 'function'
            ? await config({
                  command: 'serve',
                  mode: 'development',
                  isSsrBuild: false,
                  isPreview: false,
              })
            : config;

    expect(resolvedConfig.resolve?.alias).toMatchObject({
        '@pmndrs/upscaler': resolve(import.meta.dirname, '../src/index.ts'),
    });
});
