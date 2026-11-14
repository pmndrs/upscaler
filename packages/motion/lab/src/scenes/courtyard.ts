import * as THREE from 'three/webgpu';

import { checkerMaterial, ramp, segmentAt, sunLight, timeline, type FrameTruth, type SceneFactory, type Segment } from './common';

/** Per-frame speeds, as Q19's (bench scenario issue #67). */
const DOLLY_STEP = 0.1;
const FAST_DOLLY_STEP = 0.3;
const ORBIT_STEP = (0.5 * Math.PI) / 180;
const SLIDE_STEP = 0.05;
const PAN_STEP = (2 * Math.PI) / 180;

const BASE_POSITION = new THREE.Vector3(0, 2.2, 9);
const BASE_TARGET = new THREE.Vector3(0, 1.4, -6);

/**
 * Camera track (Q19's motion types in the lab's own scene): one motion per
 * segment, each followed by a hold. `scene-recede`/`scene-approach` move the
 * props under a still camera: the image motion of a dolly, carried by objects.
 */
const TRACK = timeline([
    ['still', 30],
    ['dolly-back', 60],
    ['hold-1', 30],
    ['dolly-forward', 60],
    ['hold-2', 30],
    ['orbit-left', 60],
    ['hold-3', 30],
    ['orbit-right', 60],
    ['hold-4', 30],
    ['slide', 60],
    ['hold-5', 30],
    ['scene-recede', 60],
    ['hold-6', 30],
    ['scene-approach', 60],
    ['hold-7', 30],
    ['dolly-back-fast', 20],
    ['hold-8', 30],
    ['dolly-forward-fast', 20],
    ['hold-9', 30],
    ['pan-fast', 30],
    ['hold-10', 30],
]);

/**
 * Cut timeline: two hard cuts, a cut between similar shots, and the events a
 * cut detector must *not* fire on (fade, one-frame flash, fast pan).
 * A segment named `cut-…` starts with its cut frame.
 */
const CUTS = timeline([
    ['still', 30],
    ['cut-hard', 30],
    ['cut-similar', 30],
    ['fade', 60],
    ['hold-1', 30],
    ['flash', 30],
    ['pan-fast', 30],
    ['hold-2', 30],
    ['cut-back', 30],
]);

/**
 * The courtyard: static floor and back wall (object 0) and props (object 1:
 * pillar rows at several depths, spheres, a slatted fence) in one group that
 * the track can move. Big depth range, fine detail, shadows.
 * @param mode - `track` (camera and object motion) or `cuts` (scene changes)
 * @returns The scene factory
 */
export function createCourtyard(mode: 'track' | 'cuts'): SceneFactory {
    return (oracle) => {
        const scene = new THREE.Scene();
        const background = new THREE.Color(0x26303c);
        scene.background = background.clone();
        const hemisphere = new THREE.HemisphereLight(0xc8d8ff, 0x403830, 0.8);
        const sun = sunLight(2.8, [8, 14, 6], 24);
        scene.add(hemisphere, sun);

        const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), checkerMaterial(0x8a8f99, 0x30343c, 80));
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(60, 12, 1), checkerMaterial(0xa08070, 0x504038, 24));
        wall.position.set(0, 6, -24);
        wall.receiveShadow = true;
        scene.add(floor, wall);

        const props = new THREE.Group();
        const add = (mesh: THREE.Mesh) => {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            oracle.instrument(mesh, 1);
            props.add(mesh);
        };
        const colors = [0x60c0e0, 0xe0c060, 0xd070a0, 0x80d080];
        for (const [row, z] of [-4, -10, -16].entries())
            for (let x = -8; x <= 8; x += 4) {
                const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 3.2, 0.7), checkerMaterial(colors[(row + x / 4 + 8) % 4], 0x303438, 4));
                pillar.position.set(x + row, 1.6, z);
                add(pillar);
            }
        for (const [i, x] of [-5, -1.5, 2, 5.5].entries()) {
            const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 48, 32), checkerMaterial(colors[i], 0x202428, 8));
            ball.position.set(x, 0.6, -1 - i * 1.5);
            add(ball);
        }
        // Slatted fence: 1-render-pixel-scale detail for the audit's edge cases.
        for (let i = 0; i < 40; i++) {
            const slat = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.4, 0.06), checkerMaterial(0xe8e8e8, 0x909090, 2));
            slat.position.set(-10 + i * 0.5, 0.7, -7);
            add(slat);
        }
        scene.add(props);

        const back = BASE_POSITION.clone().sub(BASE_TARGET).normalize();
        const side = new THREE.Vector3(back.z, 0, -back.x).normalize();
        const offset = new THREE.Vector3();
        const target = new THREE.Vector3();
        const lookDirection = new THREE.Vector3();

        //* Track
        function track(frame: number, camera: THREE.PerspectiveCamera, segments: readonly Segment[]): void {
            const at = (name: string) => segments.find((segment) => segment.name === name)!;
            const run = (name: string) => ramp(frame, at(name).start, at(name).end - at(name).start + 1);
            const dolly =
                DOLLY_STEP * (run('dolly-back') - run('dolly-forward')) +
                FAST_DOLLY_STEP * (run('dolly-back-fast') - run('dolly-forward-fast'));
            const yaw = ORBIT_STEP * (run('orbit-left') - run('orbit-right'));
            const slide = SLIDE_STEP * run('slide');
            const recede = DOLLY_STEP * (run('scene-recede') - run('scene-approach'));
            const pan = PAN_STEP * run('pan-fast');
            target.copy(BASE_TARGET).addScaledVector(side, slide);
            offset.copy(BASE_POSITION).sub(BASE_TARGET).addScaledVector(back, dolly).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
            camera.position.copy(target).add(offset);
            // Pan: turn the camera in place.
            lookDirection.copy(target).sub(camera.position).applyAxisAngle(THREE.Object3D.DEFAULT_UP, pan);
            camera.lookAt(lookDirection.add(camera.position));
            props.position.copy(back).multiplyScalar(-recede);
        }

        //* Cuts
        function cuts(frame: number, camera: THREE.PerspectiveCamera): FrameTruth {
            const segment = segmentAt(CUTS, frame);
            const name = segment.name;
            const local = frame - segment.start;
            const at = (key: string) => CUTS.find((s) => s.name === key)!;
            // Shot A until the hard cut, B after it, A′ (a near copy of A) after the similar cut, A again at cut-back.
            let shot: 'A' | 'B' | 'A2' = 'A';
            if (frame >= at('cut-hard').start && frame < at('cut-similar').start) shot = 'B';
            else if (frame >= at('cut-similar').start && frame < at('cut-back').start) shot = 'A2';
            if (shot === 'B') {
                camera.position.set(12, 4.5, -3);
                camera.lookAt(-3, 1.2, -10);
            } else {
                const shift = shot === 'A2' ? 0.8 : 0;
                const yaw = shot === 'A2' ? (3 * Math.PI) / 180 : 0;
                target.copy(BASE_TARGET).addScaledVector(side, shift);
                offset.copy(BASE_POSITION).sub(BASE_TARGET).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
                camera.position.copy(target).add(offset);
                const pan = name === 'pan-fast' ? 3 * (local + 1) : name === 'hold-2' || name === 'cut-back' ? 90 : 0;
                lookDirection.copy(target).sub(camera.position).applyAxisAngle(THREE.Object3D.DEFAULT_UP, frame >= at('cut-back').start ? 0 : (pan * Math.PI) / 180);
                camera.lookAt(lookDirection.add(camera.position));
            }
            // Fade to 5 % over 30 frames and back; a one-frame ×6 flash.
            let light = 1;
            if (name === 'fade') light = 1 - 0.95 * (local < 30 ? (local + 1) / 30 : (59 - local) / 30);
            if (name === 'flash' && local === 0) light = 6;
            sun.intensity = 2.8 * light;
            hemisphere.intensity = 0.8 * light;
            (scene.background as THREE.Color).copy(background).multiplyScalar(light);
            props.position.set(0, 0, 0);
            return { segment: name, cut: name.startsWith('cut-') && local === 0 };
        }

        const segments = mode === 'track' ? TRACK : CUTS;
        return {
            name: mode,
            scene,
            objects: { 0: 'static', 1: 'props' },
            end: segments[segments.length - 1].end,
            segments,
            update(frame, camera) {
                if (mode === 'cuts') return cuts(frame, camera);
                track(frame, camera, TRACK);
                return { segment: segmentAt(TRACK, frame).name, cut: false };
            },
        };
    };
}
