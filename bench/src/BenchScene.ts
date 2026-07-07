import * as THREE from 'three/webgpu';

/**
 * The bench scene — deliberately full of upscaler torture tests:
 * - a thin-line grid floor (sub-pixel detail, shimmer magnet)
 * - rotating torus knots with specular highlights (fireflies)
 * - a picket fence of thin boxes (geometric aliasing, disocclusion)
 * - orbiting spheres (fast motion, motion-vector validation)
 */
export interface BenchScene {
    scene: THREE.Scene;
    /** Advances animations. @param time - Elapsed seconds @param animate - Freeze toggle */
    update(time: number, animate: boolean): void;
}

/** Builds the checkerboard+grid floor texture on a canvas (no asset deps). */
function createGridTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    //* Checkerboard base
    ctx.fillStyle = '#5c6470';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#823535';
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);

    //* Thin grid lines — the sub-pixel detail that shows off upscaler quality
    ctx.strokeStyle = '#e8edf4';
    ctx.lineWidth = 2;
    const cells = 8;
    for (let i = 0; i <= cells; i++) {
        const p = (i / cells) * size;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, size);
        ctx.moveTo(0, p);
        ctx.lineTo(size, p);
        ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/**
 * Creates the bench scene.
 * @returns The scene and its per-frame update hook
 */
export function createBenchScene(): BenchScene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x10141a);
    scene.fog = new THREE.Fog(0x10141a, 40, 90);

    //* Lighting
    const sun = new THREE.DirectionalLight(0xfff2df, 3.2);
    sun.position.set(8, 14, 6);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9));

    //* Floor
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 120),
        new THREE.MeshStandardMaterial({ map: createGridTexture(), roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    //* Torus Knots — specular aliasing + rotation motion
    const knots: THREE.Mesh[] = [];
    const knotMaterial = new THREE.MeshStandardMaterial({
        color: 0xc0c8d8,
        metalness: 0.9,
        roughness: 0.22,
    });
    for (let i = 0; i < 3; i++) {
        const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.1, 0.34, 220, 28), knotMaterial);
        knot.position.set(-6 + i * 6, 2.2, -4);
        scene.add(knot);
        knots.push(knot);
    }

    //* Picket Fence — thin geometry, classic temporal-upscaler stress test
    const picketMaterial = new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.6 });
    const picketGeometry = new THREE.BoxGeometry(0.09, 2.4, 0.3);
    const pickets = new THREE.InstancedMesh(picketGeometry, picketMaterial, 60);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 60; i++) {
        m.setPosition(-12 + i * 0.4, 1.2, 3.5);
        pickets.setMatrixAt(i, m);
    }
    scene.add(pickets);

    //* Orbiting Spheres — fast coherent motion + disocclusion behind them
    const spheres: THREE.Mesh[] = [];
    const sphereColors = [0xe86a5f, 0x5fb1e8, 0x8fe85f, 0xe8d15f];
    for (let i = 0; i < 4; i++) {
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.55, 48, 32),
            new THREE.MeshStandardMaterial({
                color: sphereColors[i],
                roughness: 0.35,
                metalness: 0.1,
            }),
        );
        scene.add(sphere);
        spheres.push(sphere);
    }

    //* Emissive Accent — small HDR hotspot to exercise the invertible tonemap
    const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 24, 16),
        new THREE.MeshStandardMaterial({ emissive: 0xfff0c0, emissiveIntensity: 14 }),
    );
    bulb.position.set(0, 5.5, -2);
    scene.add(bulb);

    function update(time: number, animate: boolean): void {
        if (!animate) return;
        knots.forEach((knot, i) => {
            knot.rotation.x = time * 0.35 + i;
            knot.rotation.y = time * 0.5;
        });
        spheres.forEach((sphere, i) => {
            const a = time * 0.9 + (i * Math.PI) / 2;
            sphere.position.set(
                Math.cos(a) * 5.5,
                1.1 + Math.sin(time * 2 + i) * 0.4,
                Math.sin(a) * 5.5,
            );
        });
    }

    return { scene, update };
}
