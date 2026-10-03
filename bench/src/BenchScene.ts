import * as THREE from 'three/webgpu';

import { EMITTER_DISTANCE } from './benchmark/scenarios';

/**
 * The bench scene — deliberately full of upscaler torture tests:
 * - a thin-line grid floor (sub-pixel detail, shimmer magnet)
 * - rotating torus knots with specular highlights (fireflies)
 * - a picket fence of thin boxes (geometric aliasing, disocclusion)
 * - orbiting spheres (fast motion, motion-vector validation)
 */
export interface BenchScene {
    scene: THREE.Scene;
    roomScene: THREE.Scene;
    cornellScene: THREE.Scene;
    /** Q14: SSGI-lit room with 1px wireframe features (issue #17). */
    wireRoomScene: THREE.Scene;
    /** Q16: sub-texel full-contrast bars over an empty black background (issue #22). */
    sparseWireScene: THREE.Scene;
    /** Q17: isolated sub-pixel emitters over black and a textured backdrop (issue #51). */
    emitterScene: THREE.Scene;
    reactiveScene: THREE.Scene;
    /**
     * Q13 transparents the auto-generator must see: hidden while the
     * opaque-only color (`reactiveOpaqueColor`) renders, shown in the final.
     */
    autoReactiveObjects: readonly THREE.Object3D[];
    /** Advances animations. @param time - Elapsed seconds @param animate - Freeze toggle */
    update(time: number, animate: boolean): void;
    /** Applies a deterministic absolute scenario frame. */
    applyFrame(frame: BenchmarkFrameState): void;
    /** Recreates all seeded Q5 particle constants. */
    resetDeterministicState(): void;
}

/** Q17 emitter diameters per row, in render pixels at ratio 2. */
const EMITTER_DIAMETERS = [0.3, 0.5, 0.7, 1.0, 1.5] as const;
/** Q17 linear radiance: an LDR and an HDR group per row (left / right columns). */
const EMITTER_RADIANCE = [1, 4] as const;
const EMITTER_COLUMNS = 16;
/** Render pixels between emitters, and from the centre line to the first column. */
const EMITTER_SPACING = 12;
const EMITTER_MARGIN = 20;
/** Q17 block centres, render px above/below the axis (floating top, decal bottom). */
const EMITTER_BLOCK_Y = 90;

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
    const roomScene = new THREE.Scene();
    const reactiveScene = new THREE.Scene();
    scene.background = new THREE.Color(0x10141a);
    scene.fog = new THREE.Fog(0x10141a, 40, 90);

    //* Lighting
    const sun = new THREE.DirectionalLight(0xfff2df, 3.2);
    sun.position.set(8, 14, 6);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9));

    //* Screen-Space Effect Room ==============================================
    roomScene.background = new THREE.Color(0x0a0c10);
    const roomSun = new THREE.DirectionalLight(0xfff2df, 3.2);
    roomSun.position.set(8, 14, 6);
    roomScene.add(roomSun);
    roomScene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9));
    roomScene.add(new THREE.AmbientLight(0x404860, 0.4));

    const roomFloor = new THREE.Mesh(
        new THREE.PlaneGeometry(60, 60),
        new THREE.MeshStandardMaterial({
            color: 0x20242c,
            metalness: 0.9,
            roughness: 0.12,
        }),
    );
    roomFloor.rotation.x = -Math.PI / 2;
    roomScene.add(roomFloor);

    const wallGeometry = new THREE.BoxGeometry(20, 10, 0.4);
    const leftWall = new THREE.Mesh(
        wallGeometry,
        new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9 }),
    );
    leftWall.position.set(-8, 5, -4);
    leftWall.rotation.y = Math.PI / 2;
    roomScene.add(leftWall);
    const rightWall = new THREE.Mesh(
        wallGeometry,
        new THREE.MeshStandardMaterial({ color: 0x2ecc71, roughness: 0.9 }),
    );
    rightWall.position.set(8, 5, -4);
    rightWall.rotation.y = -Math.PI / 2;
    roomScene.add(rightWall);
    const backWall = new THREE.Mesh(
        wallGeometry,
        new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9 }),
    );
    backWall.position.set(0, 5, -12);
    roomScene.add(backWall);

    for (let i = 0; i < 5; i++) {
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(1.6, 2 + i * 0.5, 1.6),
            new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.6 }),
        );
        box.position.set(-5 + i * 2.5, 1 + i * 0.25, -6 + (i % 2) * 3);
        roomScene.add(box);
    }
    const roomBall = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 48, 32),
        new THREE.MeshStandardMaterial({
            color: 0xdfe6f0,
            metalness: 0.5,
            roughness: 0.15,
        }),
    );
    roomBall.position.set(2, 1.6, -2);
    roomScene.add(roomBall);

    //* Cornell Convergence Room (Q12) =======================================
    // Mirrors the first consumer's still-camera repro (GUIDES-HANDOFF-RESPONSE
    // report 3): an enclosed box lit by a shadow-casting point light. three's
    // WebGPU point shadows use an IGN-dithered Vogel filter whose dither is
    // SCREEN-anchored, so under camera jitter every penumbra texel re-rolls
    // each frame — deliberately unstable input luminance. A converged temporal
    // pipeline must hold a still image against exactly this.
    const cornellScene = new THREE.Scene();
    cornellScene.background = new THREE.Color(0x05060a);
    const cornellLight = new THREE.PointLight(0xfff4e5, 60, 0, 2);
    cornellLight.position.set(0, 5.4, 0.4);
    cornellLight.castShadow = true;
    cornellLight.shadow.mapSize.set(1024, 1024);
    cornellLight.shadow.bias = -0.004;
    cornellScene.add(cornellLight);
    cornellScene.add(new THREE.AmbientLight(0x8090b0, 0.25));

    const cornellWall = (color: number, width: number, height: number) => {
        const wall = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
        );
        wall.receiveShadow = true;
        cornellScene.add(wall);
        return wall;
    };
    const cornellFloor = cornellWall(0xd8d4cc, 6, 6);
    cornellFloor.rotation.x = -Math.PI / 2;
    const cornellCeiling = cornellWall(0xd8d4cc, 6, 6);
    cornellCeiling.rotation.x = Math.PI / 2;
    cornellCeiling.position.y = 6;
    const cornellBack = cornellWall(0xd8d4cc, 6, 6);
    cornellBack.position.set(0, 3, -3);
    const cornellLeft = cornellWall(0xb02020, 6, 6);
    cornellLeft.rotation.y = Math.PI / 2;
    cornellLeft.position.set(-3, 3, 0);
    const cornellRight = cornellWall(0x1fa03a, 6, 6);
    cornellRight.rotation.y = -Math.PI / 2;
    cornellRight.position.set(3, 3, 0);

    const cornellBoxMaterial = new THREE.MeshStandardMaterial({ color: 0xd0ccc2, roughness: 0.9 });
    const cornellTall = new THREE.Mesh(new THREE.BoxGeometry(1.9, 3.6, 1.9), cornellBoxMaterial);
    cornellTall.position.set(-1.05, 1.8, -0.7);
    cornellTall.rotation.y = 0.3;
    const cornellShort = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), cornellBoxMaterial);
    cornellShort.position.set(1.15, 0.85, 0.9);
    cornellShort.rotation.y = -0.35;
    for (const box of [cornellTall, cornellShort]) {
        box.castShadow = true;
        box.receiveShadow = true;
        cornellScene.add(box);
    }

    // Emissive ceiling panel — a bright thin region under the light, the kind
    // of high-contrast edge the convergence meter is most sensitive to.
    const cornellPanel = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 1.6),
        new THREE.MeshStandardMaterial({
            color: 0x000000,
            emissive: 0xfff4e5,
            emissiveIntensity: 4,
        }),
    );
    cornellPanel.rotation.x = Math.PI / 2;
    cornellPanel.position.set(0, 5.98, 0.4);
    cornellScene.add(cornellPanel);

    //* SSGI Wire Room (Q14) ==================================================
    // Issue #17's repro: thin-feature locks under a noisy SSGI input. An open-
    // fronted coloured box (strong diffuse bounce for SSGI) holding 1px
    // wireframe meshes — `wireframe: true` renders line primitives, so every
    // wire is a sub-texel, full-contrast feature against a GI-lit wall. No
    // shadow-casting light: the only screen-anchored noise must be SSGI's, so
    // the `off` subrun is a clean control for the same geometry.
    const wireRoomScene = new THREE.Scene();
    wireRoomScene.background = new THREE.Color(0x05060a);
    const wireLight = new THREE.PointLight(0xfff4e5, 45, 0, 2);
    wireLight.position.set(0, 5.2, 1.2);
    wireRoomScene.add(wireLight);
    wireRoomScene.add(new THREE.AmbientLight(0x8090b0, 0.15));
    const wireRoomWall = (color: number, width: number, height: number) => {
        const wall = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
        );
        wireRoomScene.add(wall);
        return wall;
    };
    wireRoomWall(0xd8d4cc, 6, 6).rotation.x = -Math.PI / 2;
    const wireCeiling = wireRoomWall(0xd8d4cc, 6, 6);
    wireCeiling.rotation.x = Math.PI / 2;
    wireCeiling.position.y = 6;
    wireRoomWall(0xd8d4cc, 6, 6).position.set(0, 3, -3);
    const wireLeft = wireRoomWall(0xb02020, 6, 6);
    wireLeft.rotation.y = Math.PI / 2;
    wireLeft.position.set(-3, 3, 0);
    const wireRight = wireRoomWall(0x1fa03a, 6, 6);
    wireRight.rotation.y = -Math.PI / 2;
    wireRight.position.set(3, 3, 0);
    const wireBlock = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 2.2, 1.4),
        new THREE.MeshStandardMaterial({ color: 0xd0ccc2, roughness: 0.9 }),
    );
    wireBlock.position.set(1.6, 1.1, -1.2);
    wireBlock.rotation.y = -0.35;
    wireRoomScene.add(wireBlock);
    const wireMaterial = new THREE.MeshStandardMaterial({
        color: 0xe8edf4,
        roughness: 0.5,
        wireframe: true,
    });
    // A lattice hung in front of the back wall (lines over a flat GI-lit
    // surface), a wire sphere over the floor/left-wall bounce, and a wire knot.
    const wireLattice = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4, 16, 12), wireMaterial);
    wireLattice.position.set(-0.3, 3.4, -2.2);
    const wireSphere = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 2), wireMaterial);
    wireSphere.position.set(-1.6, 1.0, -0.6);
    const wireKnot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.55, 0.16, 96, 10), wireMaterial);
    wireKnot.position.set(1.6, 2.9, -1.2);
    wireRoomScene.add(wireLattice, wireSphere, wireKnot);

    //* Sparse Wires Over Nothing (Q16) ======================================
    // Issue #22's repro: full-contrast geometry thinner than a render texel
    // over an EMPTY (black) background, still camera. Whether a bar lands in a
    // texel is decided by the jitter phase, so 4×4 / 8×8 block-mean luma swings
    // between "the bar" and "nothing" although nothing changed. Bar widths are
    // 0.012 / 0.018 / 0.024 units at ~8.8 units from the camera — about 0.5 /
    // 0.8 / 1.05 render px at ratio 2 and 0.35 / 0.5 / 0.7 at ratio 3 (1280×720,
    // fov 50) — in near-vertical, near-horizontal and diagonal fans, so both
    // block axes and every wire-to-block-edge offset are covered. A solid knot
    // gives a full-coverage silhouette control on the same black. Its light
    // follows `directionalIntensity`, so the scenario's light step (a genuine
    // change ON the sparse geometry) can be measured with measure-drift-lag.
    const sparseWireScene = new THREE.Scene();
    sparseWireScene.background = new THREE.Color(0x000000);
    const sparseLight = new THREE.DirectionalLight(0xfff2df, 3.2);
    sparseLight.position.set(4, 6, 9);
    sparseWireScene.add(sparseLight, new THREE.AmbientLight(0x8090b0, 0.6));
    const sparseMaterial = new THREE.MeshStandardMaterial({ color: 0xe8edf4, roughness: 0.5 });
    const sparseWidths = [0.012, 0.018, 0.024];
    for (let i = 0; i < 9; i++) {
        const width = sparseWidths[i % 3];
        // Near-vertical fan (right of centre).
        const upright = new THREE.Mesh(new THREE.BoxGeometry(width, 3.6, width), sparseMaterial);
        upright.position.set(0.6 + i * 0.32, 2.6, 0);
        upright.rotation.z = (i - 4) * 0.045;
        // Near-horizontal fan (top band).
        const level = new THREE.Mesh(new THREE.BoxGeometry(3.4, width, width), sparseMaterial);
        level.position.set(-2.4, 3.3 + i * 0.16, 0);
        level.rotation.z = (i - 4) * 0.03;
        // Diagonal fan (bottom band).
        const slant = new THREE.Mesh(new THREE.BoxGeometry(2.6, width, width), sparseMaterial);
        slant.position.set(-2.6 + i * 0.12, 1.4 - i * 0.07, 0);
        slant.rotation.z = 0.6 + (i - 4) * 0.05;
        sparseWireScene.add(upright, level, slant);
    }
    const sparseKnot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.62, 0.17, 160, 20),
        new THREE.MeshStandardMaterial({ color: 0xff7a3d, metalness: 0.35, roughness: 0.3 }),
    );
    sparseKnot.position.set(-2.5, 1.05, -0.6);
    sparseKnot.rotation.set(0.6, 0.9, 0);
    sparseWireScene.add(sparseKnot);

    //* Sub-Pixel Emitter Field (Q17) ========================================
    // Issue #51's repro: emitters smaller than one render pixel only rasterize
    // on the jitter phases whose sample lands on them, so on every other phase
    // the 3×3 neighbourhood holds no trace of them. Unlit discs (constant
    // radiance) on a grid of render-pixel diameters, each at a different
    // sub-pixel offset so coverage varies, plus two 0.5 px lines per block (the
    // thin-feature case locks were tuned on) for a points-vs-lines comparison.
    // Four blocks: left = empty black background (σ = 0 on a miss, and an
    // achromatic neighbourhood), right = a low-contrast textured backdrop;
    // top = FLOATING (the background is far behind, so a miss phase is also a
    // depth discontinuity the reconstruct pass reads as disocclusion), bottom
    // = DECAL (a backdrop plane just behind the discs, no depth edge — like a
    // texture-space glint or a light painted on a surface). Spacing is 12
    // render px so no emitter's Lanczos/3×3 footprint touches another's. The
    // camera (scenario q17) sits at z = EMITTER_DISTANCE on the axis; fov 50 →
    // one render pixel is 2·d·tan(25°)/360 world units at ratio 2.
    const emitterScene = new THREE.Scene();
    emitterScene.background = new THREE.Color(0x000000);
    const renderPixel = (2 * EMITTER_DISTANCE * Math.tan((25 * Math.PI) / 180)) / 360;
    const emitterGeometry = new THREE.CircleGeometry(0.5, 24);
    const emitterMaterials = EMITTER_RADIANCE.map(
        (radiance) =>
            new THREE.MeshBasicMaterial({ color: new THREE.Color(radiance, radiance, radiance) }),
    );
    // Deterministic sub-pixel offsets (golden-ratio sequences) so no two
    // emitters in a block share a coverage pattern.
    const fract = (value: number) => value - Math.floor(value);
    const rows = EMITTER_DIAMETERS.length + 2;
    const blockWidth = (EMITTER_COLUMNS - 1) * EMITTER_SPACING;
    for (const side of [-1, 1]) {
        for (const centreY of [EMITTER_BLOCK_Y, -EMITTER_BLOCK_Y]) {
            const top = centreY + ((rows - 1) / 2) * EMITTER_SPACING;
            for (let row = 0; row < EMITTER_DIAMETERS.length; row++) {
                for (let column = 0; column < EMITTER_COLUMNS; column++) {
                    const index = row * EMITTER_COLUMNS + column;
                    const disc = new THREE.Mesh(
                        emitterGeometry,
                        emitterMaterials[column < EMITTER_COLUMNS / 2 ? 0 : 1],
                    );
                    const x = side * (EMITTER_MARGIN + column * EMITTER_SPACING) + fract(index * 0.618034);
                    const y = top - row * EMITTER_SPACING + fract(index * 0.754878);
                    disc.position.set(x * renderPixel, y * renderPixel, 0);
                    disc.scale.setScalar(EMITTER_DIAMETERS[row] * renderPixel);
                    emitterScene.add(disc);
                }
            }
            // Two horizontal sub-texel lines (0.5 render px thick), one per radiance.
            for (let line = 0; line < 2; line++) {
                const bar = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), emitterMaterials[line]);
                bar.scale.set(blockWidth * renderPixel, 0.5 * renderPixel, 1);
                bar.position.set(
                    side * (EMITTER_MARGIN + blockWidth / 2) * renderPixel,
                    (top - (EMITTER_DIAMETERS.length + line) * EMITTER_SPACING + 0.37) * renderPixel,
                    0,
                );
                emitterScene.add(bar);
            }
        }
    }
    // Right-half backdrop texture: fine, low-contrast value noise (~3 render px
    // per texel), so a miss phase sees a real (small) σ instead of 0.
    const backdropSize = 256;
    const backdropCanvas = document.createElement('canvas');
    backdropCanvas.width = backdropSize;
    backdropCanvas.height = backdropSize;
    const backdropContext = backdropCanvas.getContext('2d')!;
    const backdropImage = backdropContext.createImageData(backdropSize, backdropSize);
    let backdropSeed = 0x51c0ffee;
    for (let p = 0; p < backdropSize * backdropSize; p++) {
        backdropSeed = (backdropSeed ^ ((backdropSeed << 13) >>> 0)) >>> 0;
        backdropSeed = (backdropSeed ^ (backdropSeed >>> 17)) >>> 0;
        backdropSeed = (backdropSeed ^ ((backdropSeed << 5) >>> 0)) >>> 0;
        const value = 70 + Math.floor((backdropSeed / 4294967296) * 40);
        backdropImage.data.set([value, value * 0.95, value * 0.9, 255], p * 4);
    }
    backdropContext.putImageData(backdropImage, 0, 0);
    const backdropTexture = new THREE.CanvasTexture(backdropCanvas);
    backdropTexture.colorSpace = THREE.SRGBColorSpace;
    backdropTexture.magFilter = THREE.NearestFilter;
    const halfWidth = 340 * renderPixel;
    const halfHeight = 190 * renderPixel;
    const backdrop = (texture: THREE.Texture | null, x: number, y: number, z: number) => {
        const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(halfWidth, halfHeight),
            new THREE.MeshBasicMaterial(texture ? { map: texture } : { color: 0x000000 }),
        );
        if (texture) {
            texture.repeat.set(halfWidth / (backdropSize * 3 * renderPixel), halfHeight / (backdropSize * 3 * renderPixel));
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
        }
        plane.position.set(x, y, z);
        emitterScene.add(plane);
    };
    // Textured: floating (0.5 behind) top-right, decal (just behind) bottom-right.
    // Black: floating = nothing behind at all; decal = a black plane just behind.
    const decalOffset = -0.002;
    backdrop(backdropTexture, halfWidth / 2 + 2 * renderPixel, halfHeight / 2, -0.5);
    backdrop(backdropTexture, halfWidth / 2 + 2 * renderPixel, -halfHeight / 2, decalOffset);
    backdrop(null, -halfWidth / 2 - 2 * renderPixel, -halfHeight / 2, decalOffset);

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

    //* Seeded Transparency Fixture ============================================
    const particleCount = 128;
    const particleGeometry = new THREE.SphereGeometry(0.06, 8, 6);
    const particles = new THREE.InstancedMesh(
        particleGeometry,
        new THREE.MeshBasicMaterial({
            color: 0x7fdfff,
            transparent: true,
            opacity: 0.7,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
        particleCount,
    );
    const reactiveParticles = new THREE.InstancedMesh(
        particleGeometry,
        new THREE.MeshBasicMaterial({
            color: 0xffffff,
            depthTest: true,
            depthWrite: false,
        }),
        particleCount,
    );
    particles.layers.set(1);
    reactiveParticles.layers.set(1);
    particles.visible = false;
    reactiveParticles.visible = false;
    scene.add(particles);
    reactiveScene.add(reactiveParticles);

    //* Merged Reactive-Mask Fixture (Q13) ====================================
    // Three camera-facing panels, each owned by a different reactivity source,
    // so generateReactive's max-merge is visible region by region:
    // - left  "explicit-only": translucent but drawn in BOTH the opaque-only
    //   and final passes (zero diff), flagged by the explicit mask at 1.0
    // - centre "overlap": additive vertical ramp drawn only in the final pass
    //   (diff ramps ~0 → past the 0.9 cap), AND flagged explicitly at 0.5 —
    //   the merged result is a flat 0.5 floor that turns into the generated
    //   ramp where it exceeds 0.5 (min/sum/overwrite all read differently)
    // - right "diff-only": translucent, final pass only, no explicit coverage
    // The explicit coverage ignores depth: the panels sit between the camera
    // and every other object, so nothing can occlude them.
    const mergeGroup = new THREE.Group();
    const mergeCoverage = new THREE.Group();
    // 45% of the way from the base camera (9, 6, 12) to its target (0, 1.6, 0).
    mergeGroup.position.set(4.95, 4.02, 6.6);
    mergeGroup.lookAt(9, 6, 12);
    mergeCoverage.position.copy(mergeGroup.position);
    mergeCoverage.quaternion.copy(mergeGroup.quaternion);
    const mergePanelGeometry = new THREE.PlaneGeometry(2.2, 3);
    const rampGeometry = new THREE.PlaneGeometry(2.2, 3);
    const rampColors = new Float32Array(4 * 3);
    const rampPositions = rampGeometry.getAttribute('position');
    for (let i = 0; i < 4; i++) rampColors.fill(rampPositions.getY(i) > 0 ? 0.7 : 0, i * 3, i * 3 + 3);
    rampGeometry.setAttribute('color', new THREE.BufferAttribute(rampColors, 3));

    const explicitOnlyPanel = new THREE.Mesh(
        mergePanelGeometry,
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(0.2, 0.5, 0.9),
            transparent: true,
            opacity: 0.45,
            depthWrite: false,
        }),
    );
    explicitOnlyPanel.position.x = -2.8;
    const overlapPanel = new THREE.Mesh(
        rampGeometry,
        new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    const diffOnlyPanel = new THREE.Mesh(
        mergePanelGeometry,
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(1, 0.55, 0.2),
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
        }),
    );
    diffOnlyPanel.position.x = 2.8;
    mergeGroup.add(explicitOnlyPanel, overlapPanel, diffOnlyPanel);

    const coverageMaterial = (value: number) =>
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(value, value, value),
            depthTest: false,
            depthWrite: false,
        });
    const explicitOnlyCoverage = new THREE.Mesh(mergePanelGeometry, coverageMaterial(1));
    explicitOnlyCoverage.position.x = explicitOnlyPanel.position.x;
    const overlapCoverage = new THREE.Mesh(mergePanelGeometry, coverageMaterial(0.5));
    mergeCoverage.add(explicitOnlyCoverage, overlapCoverage);
    mergeGroup.visible = false;
    mergeCoverage.visible = false;
    scene.add(mergeGroup);
    reactiveScene.add(mergeCoverage);

    const particleBase = new Float32Array(particleCount * 3);
    const particlePhase = new Float32Array(particleCount);
    const particleUp = new Float32Array(particleCount);

    function resetDeterministicState(): void {
        let seed = 0x5eed1234;
        const random = (): number => {
            seed = (seed ^ ((seed << 13) >>> 0)) >>> 0;
            seed = (seed ^ (seed >>> 17)) >>> 0;
            seed = (seed ^ ((seed << 5) >>> 0)) >>> 0;
            return seed / 4294967296;
        };

        for (let i = 0; i < particleCount; i++) {
            const ux = random();
            const uy = random();
            const uz = random();
            const up = random();
            particleBase[i * 3] = -5 + 10 * ux;
            particleBase[i * 3 + 1] = 0.7 + 4 * uy;
            particleBase[i * 3 + 2] = -5 + 10 * uz;
            particlePhase[i] = 2 * Math.PI * up;
            particleUp[i] = up;
        }
    }

    function updateObjects(time: number): void {
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

    function updateParticles(time: number): void {
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < particleCount; i++) {
            const phase = particlePhase[i];
            const up = particleUp[i];
            const x = particleBase[i * 3] + 0.35 * Math.sin(0.7 * time + phase);
            const y =
                particleBase[i * 3 + 1] + 0.6 * ((0.35 * time + up) % 1);
            const z =
                particleBase[i * 3 + 2] + 0.35 * Math.cos(0.7 * time + phase);
            matrix.makeTranslation(x, y, z);
            particles.setMatrixAt(i, matrix);
            reactiveParticles.setMatrixAt(i, matrix);
        }
        particles.instanceMatrix.needsUpdate = true;
        reactiveParticles.instanceMatrix.needsUpdate = true;
    }

    resetDeterministicState();
    updateObjects(0);
    updateParticles(0);

    function update(time: number, animate: boolean): void {
        if (!animate) return;
        updateObjects(time);
    }

    function applyFrame(frame: BenchmarkFrameState): void {
        updateObjects(frame.animateScene ? frame.sceneTime : 0);
        updateParticles(frame.time);
        particles.visible = frame.particlesVisible;
        reactiveParticles.visible = frame.particlesVisible;
        mergeGroup.visible = frame.reactiveMerge === true;
        mergeCoverage.visible = frame.reactiveMerge === true;
        sun.intensity = frame.directionalIntensity;
        sparseLight.intensity = frame.directionalIntensity;
        // The Q11 host pre-exposure multiplier lives in the MRT output node,
        // which the background never passes through — scale it here so the
        // whole frame is uniformly pre-exposed like a real app's render.
        (scene.background as THREE.Color)
            .setHex(0x10141a)
            .multiplyScalar(frame.hostPreExposure ?? 1);
    }

    return {
        scene,
        roomScene,
        cornellScene,
        wireRoomScene,
        sparseWireScene,
        emitterScene,
        reactiveScene,
        autoReactiveObjects: [overlapPanel, diffOnlyPanel],
        update,
        applyFrame,
        resetDeterministicState,
    };
}
