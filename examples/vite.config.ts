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
        // build derives PAGES_BASE from configure-pages; local dev/build default
        // to '/'. A custom domain gets '/' too. Gallery links are relative so they
        // resolve correctly under either base.
        base: process.env.PAGES_BASE ?? '/',
        resolve: {
            alias: {
                '@pmndrs/upscaler/core': packageConsumer ? resolve(packageEntry!, '../core.js') : resolve(root, '../src/core/index.ts'),
                '@pmndrs/upscaler/babylon': packageConsumer ? resolve(packageEntry!, '../babylon.js') : resolve(root, '../src/babylon/index.ts'),
                '@pmndrs/upscaler/three': packageConsumer ? resolve(packageEntry!, '../three.js') : resolve(root, '../src/three/index.ts'),
                '@pmndrs/upscaler': packageConsumer
                    ? packageEntry
                    : resolve(root, '../src/index.ts'),
            },
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
                          core: resolve(root, '17-core-webgpu/index.html'),
                          babylon: resolve(root, '18-babylon-framegraph/index.html'),
                          babylonhello: resolve(root, '19-babylon-hello/index.html'),
                          babylonaliasing: resolve(root, '20-babylon-aliasing/index.html'),
                          babyloncompare: resolve(root, '21-babylon-compare/index.html'),
                          babylontransparency: resolve(root, '22-babylon-transparency/index.html'),
                          babylonspatial: resolve(root, '23-babylon-spatial-temporal/index.html'),
                          babyloncompose: resolve(root, '24-babylon-compose/index.html'),
                          babylonreactive: resolve(root, '25-babylon-reactive-mask/index.html'),
                          babyloncanvasalpha: resolve(root, '26-babylon-transparent-canvas/index.html'),
                          babyloneffects: resolve(root, '27-babylon-screen-effects/index.html'),
                          babylonstack: resolve(root, '28-babylon-effect-stack/index.html'),
                          babylonguides: resolve(root, '29-babylon-temporal-guides/index.html'),
                          babylonguidescompose: resolve(root, '30-babylon-guides-compose/index.html'),
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
