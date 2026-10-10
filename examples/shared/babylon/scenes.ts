import type { Scene } from '@babylonjs/core/scene.js';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateTorusKnot } from '@babylonjs/core/Meshes/Builders/torusKnotBuilder.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { Material } from '@babylonjs/core/Materials/material.js';

export type DemoKind = 'hello' | 'aliasing' | 'compare' | 'transparency' | 'spatial' | 'compose' | 'reactive' | 'canvas-alpha' | 'effects' | 'stack' | 'guides' | 'guides-compose';

export function createSceneContent(scene: Scene, camera: FreeCamera, kind: DemoKind): (objectTime: number, cameraTime: number) => void {
    const light = new HemisphericLight('soft-light', new Vector3(0.3, 1, -0.5), scene); light.intensity = 1.1;
    light.groundColor = new Color3(0.15, 0.18, 0.24);
    const material = (name: string, color: string, emission = 0) => {
        const m = new StandardMaterial(name, scene); m.diffuseColor = Color3.FromHexString(color);
        m.emissiveColor = m.diffuseColor.scale(emission); m.specularColor.set(0.22, 0.22, 0.22); return m;
    };
    // Disconnected, vertex-colored quads retain sharp checks at every distance:
    // this deliberately tests reconstruction instead of texture mip filtering.
    const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
    for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) {
        const base = positions.length / 3;
        const c = (x + z) % 2 ? [0.035, 0.055, 0.085] : [0.35, 0.42, 0.53];
        for (const [dx, dz] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
            positions.push(x - 24 + dx, 0, z - 16 + dz); normals.push(0, 1, 0); colors.push(...c, 1);
        }
        // Babylon's left-handed front face uses the opposite winding to +Y cross products.
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const floor = new Mesh('checkerboard', scene), data = new VertexData();
    data.positions = positions; data.normals = normals; data.colors = colors; data.indices = indices; data.applyToMesh(floor);
    floor.material = material('floor', '#ffffff');
    if (kind === 'canvas-alpha') floor.dispose();
    const cyan = material('cyan', '#28c7ce', 0.16), amber = material('amber', '#ffb247', 0.12);
    const knot = CreateTorusKnot('knot', { radius: 1.25, tube: 0.33, radialSegments: 128, tubularSegments: 24 }, scene);
    knot.position.set(0, 2, 0); knot.material = cyan;
    const box = CreateBox('moving-box', { size: 1.1 }, scene); box.position.set(3, 0.8, 1); box.material = amber;
    if (kind !== 'hello' && kind !== 'compose' && kind !== 'effects' && kind !== 'stack') {
        const white = material('thin-lines', '#f2f0de', 0.35);
        // Real geometry produces both depth and velocity, including at subpixel widths.
        for (let i = 0; i < 72; i++) {
            const bar = CreateBox('picket-' + i, { width: 0.018, height: 3.2, depth: 0.025 }, scene);
            bar.position.set(-5.3 + i * 0.15, 1.6, 3); bar.rotation.z = 0.15; bar.material = white;
        }
        for (let i = 0; i < 20; i++) {
            const wire = CreateBox('wire-' + i, { width: 10.5, height: 0.013, depth: 0.02 }, scene);
            wire.position.set(0, 0.5 + i * 0.14, 3.1); wire.material = amber;
        }
    }
    if (kind === 'effects' || kind === 'stack') {
        const glossy = material('glossy-floor', '#303744'); glossy.specularColor.set(0.9, 0.9, 0.9); glossy.specularPower = 128;
        floor.useVertexColors = false; floor.material = glossy;
        for (const [x, color] of [[-5.5, '#d6473a'], [5.5, '#3aaf74']] as const) {
            const wall = CreateBox('colored-wall', { width: 0.25, height: 5, depth: 10 }, scene);
            wall.position.set(x, 2.5, 2); wall.material = material('wall-' + color, color, 0.05);
        }
        const back = CreateBox('back-wall', { width: 11, height: 5, depth: 0.2 }, scene); back.position.set(0, 2.5, 7); back.material = material('back', '#9ca8bb');
        for (let i = 0; i < 5; i++) {
            const column = CreateBox('occluder-' + i, { width: 1, depth: 1, height: 1 + i * 0.4 }, scene);
            column.position.set(-3.4 + i * 1.7, (1 + i * 0.4) / 2, 4); column.material = material('column-' + i, '#c8d4de');
        }
        const lightStrip = CreateBox('emissive-strip', { width: 6, height: 0.08, depth: 0.12 }, scene);
        lightStrip.position.set(0, 3.9, 6.7); lightStrip.material = material('emissive', '#ffc979', 5);
        const marker = CreateSphere('hdr-marker', { diameter: 0.6 }, scene); marker.position.set(-3, 0.4, -1.5); marker.material = material('marker', '#fc6253', 2);
    }
    const transparent: Mesh[] = [];
    if (kind === 'transparency' || kind === 'reactive') {
        const glass = material('alpha-blended-glass', '#54cfea', 0.3); glass.alpha = 0.28; glass.backFaceCulling = false;
        glass.transparencyMode = Material.MATERIAL_ALPHABLEND;
        const sphere = CreateSphere('glass-sphere', { diameter: 2.8, segments: 32 }, scene); sphere.material = glass;
        sphere.position.set(-2, 1.6, -1); transparent.push(sphere);
        for (let i = 0; i < 18; i++) {
            const glow = material('glow-' + i, i % 2 ? '#fc8e4c' : '#61e7dd', 2);
            glow.alpha = 0.3; glow.disableLighting = true; glow.backFaceCulling = false; glow.transparencyMode = Material.MATERIAL_ALPHABLEND;
            const plane = CreatePlane('transparent-patch-' + i, { size: 0.35 + i % 3 * 0.15 }, scene);
            plane.material = glow; transparent.push(plane);
        }
    }
    camera.minZ = 0.1; camera.maxZ = 120;
    return (objectTime, cameraTime) => {
        knot.rotation.set(0.15, objectTime * 0.35, 0.1);
        box.position.x = 2.8 + Math.sin(objectTime * 0.8) * 0.75; box.rotation.y = objectTime * 0.6;
        transparent.forEach((mesh, i) => {
            if (i === 0) { mesh.position.x = -2 + Math.sin(objectTime) * 1.1; return; }
            mesh.position.set(Math.sin(i * 2.4 + objectTime * 0.7) * 3.5, 0.5 + (i * 0.23 + objectTime * 0.22) % 3.5, -1.8 + Math.cos(i) * 0.5);
            mesh.rotation.z = objectTime * 0.15 + i;
        });
        camera.position.set(Math.sin(cameraTime * 0.2) * 2, 3.8, -10.5);
        camera.setTarget(new Vector3(0, 1.4, 1));
    };
}
