import * as THREE from 'three/webgpu';

/**
 * Q30's dense, depth-layered geometry (issue #102 finding 3): a procedural
 * stand-in for the Bistro / Sponza captures the bench has no assets for.
 * Thin, overlapping pieces at many depths, so a camera pan or orbit reveals
 * and hides background beside hundreds of silhouettes every frame:
 *
 * - three rows of pillars (z = −4, −12, −20) in front of a far wall
 * - a railing (two rails + 0.3-unit balusters) across the foreground (z = 3)
 * - two crossed lattice panels (diagonal slats, 0.25 apart) at z = −8 and −15
 * - ten "bushes": clusters of 140 small double-sided cards each (foliage-like
 *   alpha-free quads) at depths from z = 1 to −24
 *
 * Everything is static and seeded, so frames are deterministic. No shadows
 * (cost; the scenario measures geometry, not shading). Instanced pieces keep
 * static instance matrices: per-instance motion would need per-instance
 * previous matrices, and the disocclusion ground truth
 * (bench/src/probes/disocclusionTruth.ts) reprojects through the mesh's
 * matrixWorld alone.
 * @returns The scene (background colour set; lights included)
 */
export function createDenseScene(): THREE.Scene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e1218);
    const sun = new THREE.DirectionalLight(0xfff2df, 3.0);
    sun.position.set(6, 12, 8);
    scene.add(sun, new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 1.1));

    let seed = 0x0de45e01;
    const random = (): number => {
        seed = (seed ^ ((seed << 13) >>> 0)) >>> 0;
        seed = (seed ^ (seed >>> 17)) >>> 0;
        seed = (seed ^ ((seed << 5) >>> 0)) >>> 0;
        return seed / 4294967296;
    };

    //* Ground and Far Wall
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(90, 90),
        new THREE.MeshStandardMaterial({ color: 0x5a5d52, roughness: 0.9 }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(90, 30),
        new THREE.MeshStandardMaterial({ color: 0x7d746a, roughness: 0.85 }),
    );
    wall.position.set(0, 15, -30);
    scene.add(wall);

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const instanced = (
        geometry: THREE.BufferGeometry,
        material: THREE.Material,
        placements: readonly (readonly [number, number, number, number?, number?, number?])[],
    ): THREE.InstancedMesh => {
        const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
        placements.forEach(([x, y, z, rx = 0, ry = 0, rz = 0], index) => {
            quaternion.setFromEuler(euler.set(rx, ry, rz));
            mesh.setMatrixAt(index, matrix.compose(position.set(x, y, z), quaternion, scale));
        });
        mesh.computeBoundingSphere();
        scene.add(mesh);
        return mesh;
    };

    //* Pillars — three rows, staggered so rows overlap in every view
    const pillarMaterial = new THREE.MeshStandardMaterial({ color: 0xb9b1a2, roughness: 0.7 });
    for (const [row, z] of [-4, -12, -20].entries()) {
        const radius = 0.22 + 0.08 * row;
        const placements: [number, number, number][] = [];
        for (let x = -18 + 1.5 * row; x <= 18; x += 3) placements.push([x, 3.5, z]);
        instanced(new THREE.CylinderGeometry(radius, radius, 7, 20), pillarMaterial, placements);
    }

    //* Railing — the nearest thin layer
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 0.5, metalness: 0.4 });
    instanced(new THREE.BoxGeometry(30, 0.05, 0.05), railMaterial, [
        [0, 1.0, 3],
        [0, 0.45, 3],
    ]);
    const balusters: [number, number, number][] = [];
    for (let x = -15; x <= 15; x += 0.3) balusters.push([x, 0.5, 3]);
    instanced(new THREE.BoxGeometry(0.035, 1.0, 0.035), railMaterial, balusters);

    //* Lattice — two panels of crossed diagonal slats
    const latticeMaterial = new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.8 });
    const slat = new THREE.BoxGeometry(0.04, 7.5, 0.04);
    for (const [cx, z] of [
        [-3, -8],
        [5, -15],
    ] as const) {
        const placements: [number, number, number, number, number, number][] = [];
        for (let offset = -5; offset <= 5; offset += 0.25) {
            placements.push([cx + offset, 3, z, 0, 0, Math.PI / 4]);
            placements.push([cx + offset, 3, z - 0.06, 0, 0, -Math.PI / 4]);
        }
        instanced(slat, latticeMaterial, placements);
    }

    //* Bushes — clusters of small double-sided cards
    const cardGeometry = new THREE.PlaneGeometry(0.32, 0.18);
    const leafColors = [0x4f7a3a, 0x6b8f3e, 0x3d6b4a, 0x7f9a4c];
    for (let bush = 0; bush < 10; bush++) {
        const cx = -12 + random() * 24;
        const cz = 1 - bush * 2.5 - random();
        const cy = 0.8 + random() * 1.6;
        const radius = 0.9 + random() * 0.6;
        const placements: [number, number, number, number, number, number][] = [];
        for (let card = 0; card < 140; card++) {
            // Uniform in a squashed ball.
            let x = 0;
            let y = 0;
            let z = 0;
            do {
                x = 2 * random() - 1;
                y = 2 * random() - 1;
                z = 2 * random() - 1;
            } while (x * x + y * y + z * z > 1);
            placements.push([
                cx + x * radius,
                cy + y * radius * 0.7,
                cz + z * radius,
                random() * Math.PI,
                random() * Math.PI,
                random() * Math.PI,
            ]);
        }
        const material = new THREE.MeshStandardMaterial({
            color: leafColors[bush % leafColors.length],
            roughness: 0.75,
            side: THREE.DoubleSide,
        });
        instanced(cardGeometry, material, placements);
    }
    return scene;
}
