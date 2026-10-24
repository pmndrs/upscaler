import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { defineConfig } from 'vite';

// Standalone examples gallery. Serves this folder; the library is consumed
// straight from ../src so shader/pipeline edits hot-reload (same as the bench).
const root = __dirname;
// The pixi-3d closed beta isn't on npm and must not be committed: its examples
// run only when a beta tester has unpacked the release tarball here
// (examples/pixi3d/README.md). Without it they build as a setup notice.
const pixi3d = resolve(root, 'pixi3d/vendor');
const hasPixi3d = existsSync(resolve(pixi3d, 'package.json'));

export default defineConfig(({ mode }) => {
    const packageConsumer = mode === 'package-consumer';
    const packageEntry = process.env.UPSCALER_PACKAGE_ENTRY;
    if (packageConsumer && !packageEntry)
        throw new Error('package-consumer mode requires UPSCALER_PACKAGE_ENTRY.');

    return {
        root,
        optimizeDeps: { exclude: ['three-gpu-pathtracer/webgpu'] },
        plugins: [{
            // Every example page gets the gallery nav (back link, title, source);
            // the gallery itself doesn't. Injected here so examples stay standalone
            // and a new example can't forget it.
            name: 'example-nav',
            // 'pre', so the build bundles the injected script like a written one.
            transformIndexHtml: {
                order: 'pre' as const,
                handler(_html: string, ctx: { path: string }) {
                    if (ctx.path === '/index.html') return;
                    return [{ tag: 'script', attrs: { type: 'module', src: '/shared/nav.ts' }, injectTo: 'body' as const }];
                },
            },
        }, {
            // Without the beta, a pixi-3d example's main.ts loads as the setup notice.
            // Its source, not an import of it: the root package.json's
            // `sideEffects: false` lets the build drop a side-effect-only import.
            name: 'pixi3d-optional',
            load(id: string) {
                if (hasPixi3d) return;
                const path = id.split('?')[0].replaceAll('\\', '/');
                if (/\/pixi3d\/[^/]+\/main\.ts$/.test(path)) return readFileSync(resolve(root, 'pixi3d/unavailable.ts'), 'utf8');
            },
        }, {
            name: 'pathtracer-texture-source-compat',
            transform(code: string, id: string) {
                if (!id.split('?')[0].replaceAll('\\', '/').endsWith('/three-gpu-pathtracer/src/uniforms/EquirectHdrInfoUniform.js')) return;
                // Examples use r186+, which renamed Source; keep the dependency's local identifier.
                return code.replace('HalfFloatType, Source, RepeatWrapping', 'HalfFloatType, TextureSource as Source, RepeatWrapping');
            },
        }],
        // Own dep-optimizer cache, separate from the bench's (see bench/vite.config.ts):
        // a shared node_modules/.vite makes concurrent dev servers 504 each other.
        cacheDir: resolve(root, '../node_modules/.vite-examples'),
        // Deploy base. GitHub Pages serves a project site under /<repo>/, so the CI
        // build sets PAGES_BASE=/upscaler/; local dev/build default to '/'. A custom
        // domain later just drops PAGES_BASE. Gallery links are relative so they
        // resolve correctly under either base.
        base: process.env.PAGES_BASE ?? '/',
        resolve: {
            // Exact-match entries per public subpath: a plain '@pmndrs/upscaler'
            // key is a prefix alias and would send '@pmndrs/upscaler/core' to
            // 'src/index.ts/core'.
            alias: packageConsumer
                ? { '@pmndrs/upscaler': packageEntry }
                : [
                      ...(hasPixi3d
                          ? [
                                { find: /^@pixi\/3d$/, replacement: resolve(pixi3d, 'dist/index.mjs') },
                                { find: /^@pixi\/3d\/extras$/, replacement: resolve(pixi3d, 'dist/extras/index.mjs') },
                            ]
                          : []),
                      { find: /^@pmndrs\/upscaler$/, replacement: resolve(root, '../src/index.ts') },
                      { find: /^@pmndrs\/upscaler\/(core|three|babylon|pixi)$/, replacement: resolve(root, '../src/$1.ts') },
                  ],
        },
        // Top-level await (renderer.init) needs a modern target.
        build: {
            target: 'esnext',
            chunkSizeWarningLimit: packageConsumer ? 1200 : 500,
            rollupOptions: {
                // Package verification exercises only the linked guides consumer.
                input: packageConsumer
                    ? { guidesnode: resolve(root, '13-guides-node/index.html') }
                    : {
                          index: resolve(root, 'index.html'),
                          hello: resolve(root, '01-hello/index.html'),
                          compare: resolve(root, '02-fsr1-vs-fsr3/index.html'),
                          split: resolve(root, '03-split-compare/index.html'),
                          aliasing: resolve(root, '04-aliasing-torture/index.html'),
                          transparency: resolve(root, '05-transparency/index.html'),
                          screenspace: resolve(root, '06-screenspace-gi/index.html'),
                          tslnode: resolve(root, '07-tsl-node/index.html'),
                          compose: resolve(root, '08-tsl-compose/index.html'),
                          kitchensink: resolve(root, '09-kitchen-sink/index.html'),
                          ssgidenoise: resolve(root, '10-ssgi-denoise/index.html'),
                          nodereactive: resolve(root, '11-node-reactive/index.html'),
                          temporalguides: resolve(root, '12-temporal-guides/index.html'),
                          guidesnode: resolve(root, '13-guides-node/index.html'),
                          pathtraceralpha: resolve(root, '14-pathtracer-alpha/index.html'),
                          transparentcanvas: resolve(root, '15-transparent-canvas/index.html'),
                          spatialnode: resolve(root, '16-spatial-node/index.html'),
                          webgpuhello: resolve(root, 'webgpu/hello/index.html'),
                          babylonhello: resolve(root, 'babylon/hello/index.html'),
                          pixihello: resolve(root, 'pixi/hello/index.html'),
                          pixi3dhello: resolve(root, 'pixi3d/hello/index.html'),
                          s1reinvest: resolve(root, 's1-reinvest/index.html'),
                          s2fractal: resolve(root, 's2-fractal/index.html'),
                          s3howlow: resolve(root, 's3-how-low/index.html'),
                          s4convergence: resolve(root, 's4-convergence/index.html'),
                      },
            },
        },
        server: {
            port: 5300,
            open: false,
        },
    };
});
