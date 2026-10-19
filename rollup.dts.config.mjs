import { dts } from 'rollup-plugin-dts';

// Bundles one .d.ts per public entry. The private workspace packages
// (@pmndrs/upscaler-core / -three / -babylon) are inlined, so the published types never
// name a package that isn't on npm; engine packages stay external.
export default {
    input: { index: 'src/index.ts', three: 'src/three.ts', core: 'src/core.ts', babylon: 'src/babylon.ts' },
    output: { dir: 'dist', format: 'es', chunkFileNames: 'chunks/upscaler-[hash].d.ts' },
    external: [/^three(\/|$)/, /^@babylonjs\/core(\/|$)/],
    plugins: [dts({ respectExternal: true, tsconfig: 'tsconfig.build.json' })],
};
