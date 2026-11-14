import * as THREE from 'three/webgpu';
import { cos, float, normalize, positionGeometry, sin, transformNormalToView, vec2, vec3 } from 'three/tsl';

import { checkerMaterial, FPS, segmentAt, sunLight, timeline, type SceneFactory } from './common';

/** Geometric swell (moves vertices): amplitude, wavenumber, direction, angular speed. */
const SWELL = [
    { amplitude: 0.14, k: 0.9, direction: [1, 0.3], omega: 1.6 },
    { amplitude: 0.08, k: 1.7, direction: [-0.4, 1], omega: 2.3 },
    { amplitude: 0.04, k: 3.1, direction: [0.8, -0.6], omega: 3.4 },
] as const;
/** Ripples in the normal only: shading motion no motion vector carries. */
const RIPPLES = [
    { slope: 0.18, k: 9, direction: [0.6, 0.8], omega: 4.5 },
    { slope: 0.12, k: 15, direction: [-0.9, 0.4], omega: 6.1 },
] as const;
const BUOY = { amplitude: 0.18, omega: 1.9 };

type Time = THREE.Node<'float'>;

/**
 * Water: an animated swell plane with a low sun glint and scrolling normal
 * ripples, a bobbing buoy, a static pier, still camera. The swell is geometric
 * motion (the oracle is exact; three reports the total offset, not the step);
 * the glint and ripples are shading motion nothing but image-based flow can
 * follow. This is the scene for gate D3.
 * Objects: 1 water, 2 buoy (rigid, control), 0 the pier.
 */
export const createWater: SceneFactory = (oracle) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x8fb4d8);
    scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x203040, 0.7));
    // Low and in front of the camera, so its reflection lies on the water.
    const sun = sunLight(5, [0, 4, -40], 30);
    sun.target.position.set(0, 0, 0);
    scene.add(sun, sun.target);

    const unit = (d: readonly number[]) => {
        const length = Math.hypot(d[0], d[1]);
        return [d[0] / length, d[1] / length] as const;
    };
    // Height and its gradient over local plane coordinates (x, y), local +z up.
    const swell = (time: Time) => {
        const p = positionGeometry.xy;
        let height: THREE.Node<'float'> = float(0);
        let gradient: THREE.Node<'vec2'> = vec2(0, 0);
        for (const wave of SWELL) {
            const [dx, dy] = unit(wave.direction);
            const phase = p.dot(vec2(dx * wave.k, dy * wave.k)).add(time.mul(wave.omega));
            height = height.add(sin(phase).mul(wave.amplitude));
            gradient = gradient.add(vec2(dx, dy).mul(cos(phase).mul(wave.amplitude * wave.k)));
        }
        return { height, gradient };
    };

    const material = new THREE.MeshPhysicalNodeMaterial({ color: 0x0b3a52, roughness: 0.07, metalness: 0 });
    const current = swell(oracle.time);
    material.positionNode = positionGeometry.add(vec3(0, 0, current.height));
    let slope: THREE.Node<'vec2'> = current.gradient;
    for (const ripple of RIPPLES) {
        const [dx, dy] = unit(ripple.direction);
        const phase = positionGeometry.xy.dot(vec2(dx * ripple.k, dy * ripple.k)).add(oracle.time.mul(ripple.omega));
        slope = slope.add(vec2(dx, dy).mul(cos(phase).mul(ripple.slope)));
    }
    material.normalNode = transformNormalToView(normalize(vec3(slope.x.negate(), slope.y.negate(), 1)));
    const water = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 320, 320), material);
    water.rotation.x = -Math.PI / 2;
    water.receiveShadow = true;
    oracle.instrument(water, 1, positionGeometry.add(vec3(0, 0, swell(oracle.previousTime).height)));

    const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.4, 48, 32), checkerMaterial(0xf05030, 0xf0f0f0, 6));
    buoy.castShadow = true;
    oracle.instrument(buoy, 2);
    const pier = new THREE.Group();
    for (let i = 0; i < 6; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 0.3), checkerMaterial(0x6a5040, 0x3a2a20, 3));
        post.position.set(3.5, 0.4, 2 - i * 2.2);
        post.castShadow = true;
        pier.add(post);
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.15, 13), checkerMaterial(0x8a6a50, 0x5a4030, 8));
    deck.position.set(4, 1.6, -3.5);
    deck.castShadow = true;
    pier.add(deck);
    scene.add(water, buoy, pier);

    const segments = timeline([['water', 240]]);
    return {
        name: 'water',
        scene,
        objects: { 0: 'pier', 1: 'water', 2: 'buoy' },
        end: 239,
        segments,
        update(frame, camera) {
            const t = frame / FPS;
            buoy.position.set(-1.5, 0.15 + BUOY.amplitude * Math.sin(t * BUOY.omega), -2);
            buoy.rotation.set(0.25 * Math.sin(t * 1.3), 0, 0.2 * Math.cos(t * 1.1));
            camera.position.set(0, 2.2, 8);
            camera.lookAt(0, 0, -6);
            return { segment: segmentAt(segments, frame).name, cut: false };
        },
    };
};
