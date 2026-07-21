const BASE_POSITION = [9, 6, 12] as const;
const BASE_TARGET = [0, 1.6, 0] as const;
const ROOM_TARGET = [0, 3, -5] as const;

function state(
    frame: number,
    cameraPosition: readonly [number, number, number] = BASE_POSITION,
    cameraTarget: readonly [number, number, number] = BASE_TARGET,
): BenchmarkFrameState {
    return {
        frame,
        time: frame / 60,
        cameraPosition,
        cameraTarget,
        sceneTime: frame / 60,
        animateScene: false,
        directionalIntensity: 3.2,
        resetHistory: false,
        resize: null,
        particlesVisible: false,
    };
}

function baselineAnimated(frame: number): BenchmarkFrameState {
    return { ...state(frame), animateScene: true };
}

function q2(frame: number): BenchmarkFrameState {
    const u = frame / 239;
    return state(frame, [9 - 3 * u, 6, 12 - 4 * u]);
}

function q4(frame: number): BenchmarkFrameState {
    const target = BASE_TARGET;
    const radius = 15;
    const height = 4.4;
    const theta0 = Math.atan2(12, 9);
    const theta119 = theta0 + 0.25;
    const c119 = [
        target[0] + radius * Math.cos(theta119),
        target[1] + height,
        target[2] + radius * Math.sin(theta119),
    ] as const;

    if (frame <= 119) {
        const theta = theta0 + (0.25 * frame) / 119;
        return state(frame, [
            target[0] + radius * Math.cos(theta),
            target[1] + height,
            target[2] + radius * Math.sin(theta),
        ]);
    }

    const c239 = [c119[0] - 8, c119[1], c119[2] - 6] as const;
    if (frame <= 239) {
        const u = (frame - 120) / 119;
        return state(frame, [c119[0] - 8 * u, c119[1], c119[2] - 6 * u]);
    }

    const startTheta = Math.atan2(c239[2] - target[2], c239[0] - target[0]);
    const orbitRadius = Math.hypot(c239[0] - target[0], c239[2] - target[2]);
    const orbitFrame = Math.min(frame, 359);
    const theta = startTheta + (0.9 * (orbitFrame - 240)) / 119;
    return state(frame, [
        target[0] + orbitRadius * Math.cos(theta),
        c239[1],
        target[2] + orbitRadius * Math.sin(theta),
    ]);
}

function roomMotion(frame: number): BenchmarkFrameState {
    const time = frame / 60;
    return state(frame, [7 * Math.sin(0.15 * time), 4, 9 + 1.5 * Math.cos(0.15 * time)], ROOM_TARGET);
}

function q9(frame: number): BenchmarkFrameState {
    let directionalIntensity = 3.2;
    if (frame >= 60 && frame < 120) directionalIntensity = 8;
    else if (frame >= 120 && frame < 180)
        directionalIntensity = 8 - (6 * (frame - 120)) / 59;
    return { ...state(frame), directionalIntensity };
}

function q11(frame: number): BenchmarkFrameState {
    // Host pre-exposure transition on an otherwise static scene: identity,
    // 2.5× step at 60, hold, ramp back to 1 over 120–179. With DeltaPreExposure
    // correction the shading-change view stays black through all of it and
    // accumulation age never resets; output brightness simply tracks the drive.
    let hostPreExposure = 1;
    if (frame >= 60 && frame < 120) hostPreExposure = 2.5;
    else if (frame >= 120 && frame < 180) hostPreExposure = 2.5 - (1.5 * (frame - 120)) / 59;
    return { ...state(frame), hostPreExposure };
}

function q10(frame: number): BenchmarkFrameState {
    const afterCut = frame >= 60;
    return {
        ...baselineAnimated(frame),
        cameraPosition: afterCut ? [-7, 4, 9] : BASE_POSITION,
        resetHistory: frame === 60 || frame === 120 || frame === 180,
        resize:
            frame === 120
                ? { width: 1280, height: 720, devicePixelRatio: 1 }
                : frame === 180
                  ? { width: 1920, height: 1080, devicePixelRatio: 1 }
                  : null,
        particlesVisible: false,
    };
}

const SCENARIOS: Record<BenchmarkScenarioId, BenchmarkScenarioDefinition> = {
    Q0: {
        id: 'Q0',
        name: 'input-debug-validation',
        endFrame: 143,
        captures: ['0', '1', '2', '23', 'P-1', 'P', '2*P-1', '119'],
        debugViews: [
            'final',
            'motion-vectors',
            'disocclusion',
            'accumulation-age',
            'locks',
            'exposure',
            'shading-change',
            'reactivity',
        ],
        rois: {
            full: [0, 0, 1, 1],
            floor_grid: [0.05, 0.55, 0.9, 0.45],
            fence_and_spheres: [0.05, 0.28, 0.9, 0.42],
        },
        subruns: [],
        unsupported: null,
        frame: baselineAnimated,
    },
    Q1: {
        id: 'Q1',
        name: 'static-convergence',
        endFrame: 239,
        captures: ['0', '1', '2', '4', '8', '16', '23', 'P-1', 'P', '2*P-1', '119', '239'],
        debugViews: ['final', 'accumulation-age', 'locks', 'exposure', 'shading-change'],
        rois: { full: [0, 0, 1, 1], thin_features: [0.08, 0.3, 0.84, 0.55] },
        subruns: [],
        unsupported: null,
        frame: state,
    },
    Q2: {
        id: 'Q2',
        name: 'slow-aliasing-dolly',
        endFrame: 239,
        captures: ['0', '1', '2', '23', 'P-1', 'P', '2*P-1', '59', '119', '179', '239'],
        debugViews: ['final', 'motion-vectors', 'disocclusion', 'accumulation-age', 'locks'],
        rois: { floor_grid: [0, 0.48, 1, 0.52], fence: [0.05, 0.35, 0.9, 0.32] },
        subruns: [],
        unsupported: null,
        frame: q2,
    },
    Q3: {
        id: 'Q3',
        name: 'object-motion-disocclusion',
        endFrame: 239,
        captures: ['0', '1', '2', '23', 'P-1', 'P', '2*P-1', '59', '119', '179', '239'],
        debugViews: ['final', 'motion-vectors', 'disocclusion', 'accumulation-age'],
        rois: {
            full: [0, 0, 1, 1],
            moving_spheres: [0.12, 0.2, 0.76, 0.58],
            fence_silhouette: [0.05, 0.35, 0.9, 0.3],
        },
        subruns: [],
        unsupported: null,
        frame: baselineAnimated,
    },
    Q4: {
        id: 'Q4',
        name: 'camera-motion-hold',
        endFrame: 479,
        captures: [
            '0', '23', 'P-1', 'P', '2*P-1', '118', '119', '120', '121', '238', '239',
            '240', '241', '358', '359', '360', '361', '383', '479',
        ],
        debugViews: ['final', 'motion-vectors', 'disocclusion', 'accumulation-age', 'shading-change'],
        rois: { full: [0, 0, 1, 1], thin_geometry: [0.05, 0.25, 0.9, 0.55] },
        subruns: [],
        unsupported: null,
        frame: q4,
    },
    Q5: {
        id: 'Q5',
        name: 'seeded-transparency-reactivity',
        endFrame: 239,
        captures: ['0', '1', '2', '23', 'P-1', 'P', '2*P-1', '59', '119', '179', '239'],
        debugViews: ['final', 'motion-vectors', 'accumulation-age', 'locks', 'reactivity'],
        rois: {
            full: [0, 0, 1, 1],
            particle_volume: [0.18, 0.1, 0.64, 0.72],
            opaque_edges: [0.05, 0.35, 0.9, 0.45],
        },
        subruns: [],
        unsupported: null,
        frame: (frame) => ({ ...state(frame), particlesVisible: true }),
    },
    Q6: {
        id: 'Q6',
        name: 'isolated-screenspace-effects',
        endFrame: 239,
        captures: ['0', '1', '2', '23', 'P-1', 'P', '2*P-1', '59', '119', '239'],
        debugViews: ['final', 'motion-vectors', 'disocclusion', 'accumulation-age'],
        rois: {
            full: [0, 0, 1, 1],
            floor_reflection: [0.05, 0.5, 0.9, 0.5],
            wall_contact_and_bounce: [0.08, 0.08, 0.84, 0.6],
        },
        subruns: ['gtao', 'ssr', 'ssgi'],
        unsupported: null,
        frame: (frame) => state(frame, [0, 4, 10], ROOM_TARGET),
    },
    Q7: {
        id: 'Q7',
        name: 'in-graph-screenspace-composition',
        endFrame: 239,
        captures: ['0', '1', '2', '23', 'P-1', 'P', '2*P-1', '59', '119', '179', '239'],
        debugViews: ['final', 'motion-vectors', 'disocclusion', 'accumulation-age'],
        rois: {
            full: [0, 0, 1, 1],
            glossy_floor: [0.05, 0.48, 0.9, 0.52],
            colored_walls: [0.05, 0.05, 0.9, 0.62],
        },
        subruns: [],
        unsupported: null,
        frame: roomMotion,
    },
    Q8: {
        id: 'Q8',
        name: 'recurrent-denoiser-characterization',
        endFrame: 239,
        captures: ['0', '1', '2', '4', '8', '16', '23', 'P-1', 'P', '2*P-1', '59', '119', '239'],
        debugViews: ['final', 'motion-vectors', 'accumulation-age'],
        rois: {
            full: [0, 0, 1, 1],
            flat_walls: [0.08, 0.08, 0.84, 0.52],
            occlusion_edges: [0.18, 0.24, 0.64, 0.54],
        },
        subruns: ['builtin', 'spatial', 'recurrent'],
        unsupported: null,
        frame: roomMotion,
    },
    Q9: {
        id: 'Q9',
        name: 'exposure-transition',
        endFrame: 239,
        captures: [
            '0', '23', 'P-1', 'P', '2*P-1', '59', '60', '61', '62', '64', '68', '76',
            '83', '119', '120', '121', '149', '178', '179', '180', '181', '182', '184',
            '188', '196', '203', '239',
        ],
        debugViews: ['final', 'accumulation-age', 'locks', 'exposure', 'shading-change'],
        rois: {
            full: [0, 0, 1, 1],
            lit_knots: [0.18, 0.16, 0.64, 0.38],
            hdr_bulb: [0.43, 0.08, 0.14, 0.2],
        },
        subruns: [],
        unsupported: null,
        frame: q9,
    },
    Q10: {
        id: 'Q10',
        name: 'reset-cut-resize',
        endFrame: 239,
        captures: [
            '0', '1', '2', '23', 'P-1', 'P', '2*P-1', '59', '60', '61', '62', '64',
            '68', '76', '83', '119', '120', '121', '122', '124', '128', '136', '143',
            '179', '180', '181', '182', '184', '188', '196', '203', '239',
        ],
        debugViews: [
            'final',
            'motion-vectors',
            'disocclusion',
            'accumulation-age',
            'locks',
            'exposure',
            'shading-change',
        ],
        rois: { full: [0, 0, 1, 1], moving_silhouettes: [0.08, 0.18, 0.84, 0.58] },
        subruns: [],
        unsupported: null,
        frame: q10,
    },
    Q11: {
        id: 'Q11',
        name: 'host-pre-exposure',
        endFrame: 239,
        captures: [
            '0', '23', 'P-1', 'P', '59', '60', '61', '62', '64', '68', '76', '83',
            '119', '120', '121', '135', '149', '164', '179', '180', '181', '184',
            '196', '203', '239',
        ],
        debugViews: ['final', 'accumulation-age', 'locks', 'exposure', 'shading-change'],
        rois: {
            full: [0, 0, 1, 1],
            lit_knots: [0.18, 0.16, 0.64, 0.38],
            hdr_bulb: [0.43, 0.08, 0.14, 0.2],
        },
        subruns: [],
        unsupported: null,
        frame: q11,
    },
};

/**
 * Returns a manifest-defined scenario and validates its subrun.
 * @param id - Scenario ID
 * @param subrun - Optional effect subrun
 * @returns Immutable scenario contract
 */
export function getBenchmarkScenario(
    id: BenchmarkScenarioId,
    subrun: string | null = null,
): BenchmarkScenarioDefinition {
    const scenario = SCENARIOS[id];
    if (scenario.subruns.length > 0 && (!subrun || !scenario.subruns.includes(subrun)))
        throw new Error(`Scenario ${id} requires subrun: ${scenario.subruns.join(', ')}`);
    if (scenario.subruns.length === 0 && subrun)
        throw new Error(`Scenario ${id} does not define subruns.`);
    return scenario;
}

/**
 * Resolves manifest frame expressions against a jitter period.
 * @param expressions - Integer or `P` expressions from the scenario contract
 * @param jitterPeriod - Active resolver jitter phase count
 * @returns Ordered, unique, integer capture frames
 */
export function resolveCaptureFrames(
    expressions: readonly string[],
    jitterPeriod: number,
): number[] {
    const values = expressions.map((expression) => {
        if (/^\d+$/.test(expression)) return Number(expression);
        if (expression === 'P') return jitterPeriod;
        if (expression === 'P-1') return jitterPeriod - 1;
        if (expression === '2*P-1') return 2 * jitterPeriod - 1;
        throw new Error(`Unsupported capture frame expression: ${expression}`);
    });
    return [...new Set(values)];
}

/** All immutable E00 scenario contracts. */
export const BENCHMARK_SCENARIOS: Readonly<Record<BenchmarkScenarioId, BenchmarkScenarioDefinition>> =
    SCENARIOS;
