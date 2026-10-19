import { resolve } from 'path';
import { defineConfig } from 'vite';

// Standalone examples gallery. Serves this folder; the library is consumed
// straight from ../src so shader/pipeline edits hot-reload (same as the bench).
const root = __dirname;

export default defineConfig(({ mode }) => {
    const packageConsumer = mode === 'package-consumer';
    const packageEntry = process.env.UPSCALER_PACKAGE_ENTRY;
    if (packageConsumer && !packageEntry)
        throw new Error('package-consumer mode requires UPSCALER_PACKAGE_ENTRY.');

    return {
        root,
        optimizeDeps: { exclude: ['three-gpu-pathtracer/webgpu'] },
        plugins: [{
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
                      { find: /^@pmndrs\/upscaler$/, replacement: resolve(root, '../src/index.ts') },
                      { find: /^@pmndrs\/upscaler\/(core|three|babylon)$/, replacement: resolve(root, '../src/$1.ts') },
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
