// Type-level regression test for the TSL node factories — compiled by
// `pnpm typecheck` (tsconfig.json includes `test/`), never executed, so it
// stays GPU-free. It fails the build if a factory's return type degrades to
// `unknown`/`any` again: the 0.3 factories returned
// `ReturnType<typeof nodeObject>`, which resolves `nodeObject`'s generic to
// `NodeObject<unknown>` = `unknown`, so README snippets needed
// `as unknown as THREE.Node` just to assign `post.outputNode`.
import * as THREE from 'three/webgpu';
import { pass, screenUV, smoothstep, vec2, vec3, vec4 } from 'three/tsl';

import {
    QualityMode,
    temporalGuides,
    upscale,
    upscaleScene,
    upscaleSpatial,
    type Upscaler,
    type UpscalerNode,
} from '@pmndrs/upscaler';

// `any` would also make the assignments below compile, so pin that it isn't.
type IsAny<T> = 0 extends 1 & T ? true : false;
type Expect<T extends true> = T;
type Not<T extends boolean> = T extends true ? false : true;

declare const renderer: THREE.WebGPURenderer;
declare const scene: THREE.Scene;
declare const camera: THREE.PerspectiveCamera;

const post = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');
const depth = scenePass.getTextureNode('depth');
const velocity = scenePass.getTextureNode('velocity');

//* Assignment to RenderPipeline.outputNode — no cast.
const sceneNode = upscaleScene(scene, camera, { quality: QualityMode.Performance });
post.outputNode = sceneNode;
post.outputNode = upscale(color, depth, velocity, camera);
post.outputNode = upscaleSpatial(color);

//* Composition with TSL math (example 08's vignette) — no cast.
const vignette = vec4(vec3(smoothstep(0.85, 0.25, screenUV.sub(0.5).length())), 1);
post.outputNode = sceneNode.mul(vignette);

//* The node's own API is reachable without a cast.
const upscaler: Upscaler | null = sceneNode.upscaler;
sceneNode.dispose();

//* Linked guides.
const guides = temporalGuides(depth, velocity, camera);
post.outputNode = upscale(color, depth, velocity, camera, { guides });

//* jitterNode (issue #68) — a vec2 uniform that composes into TSL math without a cast.
const jitterUV = sceneNode.jitterNode.div(vec2(640, 360));
post.outputNode = vec4(jitterUV, 0, 1);

export type _Checks = [
    Expect<Not<IsAny<ReturnType<typeof upscaleScene>>>>,
    Expect<Not<IsAny<ReturnType<typeof upscale>>>>,
    Expect<Not<IsAny<ReturnType<typeof upscaleSpatial>>>>,
    Expect<ReturnType<typeof upscaleScene> extends UpscalerNode ? true : false>,
    Expect<ReturnType<typeof upscale> extends THREE.Node<'vec4'> ? true : false>,
    Expect<ReturnType<typeof upscaleSpatial> extends THREE.Node<'vec4'> ? true : false>,
    Expect<Not<IsAny<typeof jitterUV>>>,
];

export { upscaler };
