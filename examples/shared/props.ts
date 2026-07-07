import * as THREE from 'three/webgpu';

/**
 * Shared, asset-free scene props used across the examples. Everything here is
 * chosen to stress a temporal upscaler: high-frequency textures, thin geometry,
 * specular highlights.
 */

/** Builds a checkerboard + thin-grid floor texture on a canvas (no asset deps). */
export function createGridTexture(repeat = 12): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#5c6470';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#823535';
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);

    // Thin grid lines — the sub-pixel detail that shows off upscaler quality.
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

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** Adds a warm key light + cool hemisphere fill. */
export function addStudioLighting(scene: THREE.Scene): void {
    const sun = new THREE.DirectionalLight(0xfff2df, 3.2);
    sun.position.set(8, 14, 6);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9));
}

/** A large grid floor plane laid flat at y=0. */
export function createGridFloor(repeat = 12): THREE.Mesh {
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 120),
        new THREE.MeshStandardMaterial({ map: createGridTexture(repeat), roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    return floor;
}
