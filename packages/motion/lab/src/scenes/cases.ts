import * as THREE from 'three/webgpu';
import { attribute, clamp, float, positionGeometry, positionLocal, vec3 } from 'three/tsl';

import { checkerMaterial, FPS, segmentAt, sunLight, timeline, type SceneFactory } from './common';

/** Move from A to B over these frames, then hold at B. */
const MOVE_START = 30;
const MOVE_FRAMES = 60;
const MOVE_DISTANCE = 2;

/**
 * The plan's "moves, then holds" oracle cases (MOTION-VECTORS-PLAN §4), still
 * camera: during the move every object has a per-frame step, during the hold
 * the correct motion is exactly zero.
 * 1 a box moved A→B by `material.positionNode`, 2 a morph weight ramp 0→1,
 * 3 the same box moved by `object.position` (control: three is exact).
 */
export const createCases: SceneFactory = (oracle) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d2228);
    scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x403830, 0.9));
    scene.add(sunLight(2.4, [3, 8, 6], 8));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), checkerMaterial(0x8a8f99, 0x30343c, 30));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Progress 0 → 1 across the move, as a function of scene time (seconds).
    const progressAt = (t: number) => Math.min(Math.max((t * FPS - MOVE_START + 1) / MOVE_FRAMES, 0), 1);
    const progressNode = (time: typeof oracle.time) => clamp(time.mul(FPS).sub(MOVE_START - 1).div(MOVE_FRAMES), 0, 1);

    //* Node Move
    const nodeBox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), checkerMaterial(0x60c0e0, 0x304050, 4));
    (nodeBox.material as THREE.NodeMaterial).positionNode = positionLocal.add(vec3(progressNode(oracle.time).mul(MOVE_DISTANCE), 0, 0));
    nodeBox.position.set(-4.5, 1.2, 0);
    nodeBox.castShadow = true;
    oracle.instrument(nodeBox, 1, positionGeometry.add(vec3(progressNode(oracle.previousTime).mul(MOVE_DISTANCE), 0, 0)));

    //* Morph Ramp
    const sphere = new THREE.SphereGeometry(0.9, 96, 64);
    const base = sphere.attributes.position;
    const target = new Float32Array(base.count * 3);
    const delta = new Float32Array(base.count * 3);
    for (let i = 0; i < base.count; i++) {
        const [x, y, z] = [base.getX(i), base.getY(i), base.getZ(i)];
        const bulge = 1 + 0.45 * Math.sin(y * 5);
        target.set([x * bulge, y, z * bulge], i * 3);
        delta.set([x * bulge - x, 0, z * bulge - z], i * 3);
    }
    sphere.morphAttributes.position = [new THREE.Float32BufferAttribute(target, 3)];
    sphere.setAttribute('morphDelta', new THREE.Float32BufferAttribute(delta, 3));
    const morph = new THREE.Mesh(sphere, checkerMaterial(0xd070a0, 0x403040, 12));
    morph.updateMorphTargets();
    morph.position.set(0, 1.3, 0);
    morph.castShadow = true;
    oracle.instrument(morph, 2, positionGeometry.add(attribute('morphDelta', 'vec3').mul(float(progressNode(oracle.previousTime)))));

    //* Rigid Move (control)
    const rigidBox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), checkerMaterial(0x80d080, 0x304030, 4));
    rigidBox.castShadow = true;
    oracle.instrument(rigidBox, 3);

    scene.add(nodeBox, morph, rigidBox);
    const segments = timeline([
        ['still', MOVE_START],
        ['move', MOVE_FRAMES],
        ['hold', 60],
    ]);
    return {
        name: 'cases',
        scene,
        objects: { 0: 'static', 1: 'node-move', 2: 'morph-ramp', 3: 'rigid-move' },
        end: segments[segments.length - 1].end,
        segments,
        update(frame, camera) {
            const progress = progressAt(frame / FPS);
            morph.morphTargetInfluences![0] = progress;
            rigidBox.position.set(2.5 + progress * MOVE_DISTANCE, 1.2, 0);
            camera.position.set(0, 3, 8.5);
            camera.lookAt(0, 1.2, 0);
            return { segment: segmentAt(segments, frame).name, cut: false };
        },
    };
};
