import * as THREE from 'three/webgpu';
import { attribute, normalGeometry, normalLocal, positionGeometry, positionLocal, sin } from 'three/tsl';

import { checkerMaterial, FPS, segmentAt, sunLight, timeline, type SceneFactory } from './common';

/**
 * One object per velocity gap, still camera (MOTION.md §2):
 * 1 static `positionNode` displacement (nothing moves; three reports motion),
 * 2 animated displacement `sin(5x + 3t)` (real motion three can't see),
 * 3 morph target oscillating, 4 rigid rotating box (control: three is exact),
 * 5 a ball that leaves the frustum and re-enters elsewhere.
 */
export const createDeformers: SceneFactory = (oracle) => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b2030);
    scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x40362c, 0.8));
    scene.add(sunLight(2.6, [4, 9, 5], 10));
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), checkerMaterial(0x8a8f99, 0x30343c, 40));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    //* Displacement Through positionNode
    const ripple = (position: THREE.Node<'vec3'>, normal: THREE.Node<'vec3'>, time: THREE.Node<'float'> | null) =>
        position.add(normal.mul(sin(time ? position.x.mul(5).add(time.mul(3)) : position.x.mul(5)).mul(0.3)));

    const displaced = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4, 96, 96), checkerMaterial(0xe0c060, 0x404850, 10));
    (displaced.material as THREE.NodeMaterial).positionNode = ripple(positionLocal, normalLocal, null);
    displaced.position.set(-4.6, 1.5, 0);
    displaced.rotation.y = 0.55;
    oracle.instrument(displaced, 1, ripple(positionGeometry, normalGeometry, null));

    const wave = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4, 96, 96), checkerMaterial(0x60c0e0, 0x404850, 10));
    (wave.material as THREE.NodeMaterial).positionNode = ripple(positionLocal, normalLocal, oracle.time);
    wave.position.set(-1.6, 1.5, 0);
    wave.rotation.y = 0.2;
    oracle.instrument(wave, 2, ripple(positionGeometry, normalGeometry, oracle.previousTime));

    //* Morph Target
    // Influence 0.5 + 0.5·sin(2t), written on the CPU for three and as a node
    // of last frame's time for the oracle.
    const sphere = new THREE.SphereGeometry(0.9, 96, 64);
    const base = sphere.attributes.position;
    const target = new Float32Array(base.count * 3);
    const delta = new Float32Array(base.count * 3);
    for (let i = 0; i < base.count; i++) {
        const [x, y, z] = [base.getX(i), base.getY(i), base.getZ(i)];
        const bulge = 1 + 0.35 * Math.sin(y * 6);
        target.set([x * bulge, y, z * bulge], i * 3);
        delta.set([x * bulge - x, 0, z * bulge - z], i * 3);
    }
    sphere.morphAttributes.position = [new THREE.Float32BufferAttribute(target, 3)];
    sphere.setAttribute('morphDelta', new THREE.Float32BufferAttribute(delta, 3));
    const morph = new THREE.Mesh(sphere, checkerMaterial(0xd070a0, 0x403040, 12));
    morph.updateMorphTargets();
    morph.position.set(1.5, 1.4, 0);
    morph.castShadow = true;
    const influenceAt = (t: number) => 0.5 + 0.5 * Math.sin(t * 2);
    const previousInfluence = sin(oracle.previousTime.mul(2)).mul(0.5).add(0.5);
    oracle.instrument(morph, 3, positionGeometry.add(attribute('morphDelta', 'vec3').mul(previousInfluence)));

    //* Rigid Control and Re-entry
    const rigid = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), checkerMaterial(0x80d080, 0x304030, 6));
    rigid.position.set(4.4, 1.3, 0);
    rigid.castShadow = true;
    oracle.instrument(rigid, 4);
    const reentry = new THREE.Mesh(new THREE.SphereGeometry(0.45, 48, 32), checkerMaterial(0xf08040, 0x502010, 8));
    reentry.castShadow = true;
    oracle.instrument(reentry, 5);

    const objects = { displaced, wave, morph, rigid, reentry };
    for (const object of Object.values(objects)) scene.add(object);
    const segments = timeline([['deformers', 240]]);
    return {
        name: 'deformers',
        scene,
        objects: { 0: 'static', 1: 'displaced', 2: 'wave', 3: 'morph', 4: 'rigid', 5: 'reentry' },
        end: 239,
        segments,
        update(frame, camera) {
            const t = frame / FPS;
            morph.morphTargetInfluences![0] = influenceAt(t);
            // ~3 px/frame at the corners: below ~1 px the warp audit can't
            // separate motion from resampling error (the oracle comparison can).
            rigid.rotation.set(t * 1.2, t * 2.4, 0);
            // 0–79 right along y 3.2, 80–119 down off-screen, 120+ back left at y 0.7.
            const f = frame % 240;
            if (f < 80) reentry.position.set(-2 + (f / 80) * 13, 3.2, 1.5);
            else if (f < 120) reentry.position.set(11 + ((f - 80) / 40) * 1, 3.2 - ((f - 80) / 40) * 2.5, 1.5);
            else reentry.position.set(12 - ((f - 120) / 120) * 14, 0.7, 1.5);
            camera.position.set(0, 3.2, 9);
            camera.lookAt(0, 1.4, 0);
            return { segment: segmentAt(segments, frame).name, cut: false };
        },
        select(names) {
            for (const [name, object] of Object.entries(objects)) {
                object.visible = !names || names.includes(name);
                // The flat planes' shadows are shading motion, not geometry: off by default.
                object.castShadow = name !== 'displaced' && name !== 'wave';
            }
        },
    };
};
