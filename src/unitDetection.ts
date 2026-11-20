import * as THREE from 'three';
import { ensureBoundsTrees, collectRayTargets, castDown } from './minimapBuilder.js';

// Coarse pre-scan: one downward ray per column, a few thousand at most so it stays under a second or so
const PRESCAN_MAX_RAYS = 10_000;

// Floor levels are the Y slices where many columns have an upward surface. Measured in auto-scale units
// (see glbLoader.ts), within a factor ~3 of metres for the units handled here
const LEVEL_BIN = 0.02;
const LEVEL_SUPPRESS = 0.5; // a level hides weaker ones closer than this: furniture tops, slab thickness
const LEVEL_MIN_COVERAGE = 0.3; // relative to the most covered level: under it, furniture or a mezzanine, not a floor

// Storey height (m) of a real building
const MIN_STOREY_HEIGHT = 1.8;
const MAX_STOREY_HEIGHT = 6;

// Units the power of 10 auto-scale can't express. Their storey heights in raw units don't overlap
// (inches: 71 to 236, feet: 5.9 to 19.7), so at most one of them fits
const IMPERIAL_UNITS = [
    { unit: 'in', scale: 0.0254 },
    { unit: 'ft', scale: 0.3048 },
] as const;

const YIELD_EVERY_MS = 30;

/**
 * @typedef ScaleDetection
 * @prop scale scale to apply to the model's raw coordinates
 * @prop unit imperial unit detected, null when the power of 10 auto-scale is kept
 * @prop storeyHeight median storey height (m) at that scale, null when the model has a single floor level
 * @prop levels floor levels found by the pre-scan
 * @prop rays rays cast by the pre-scan
 */
export interface ScaleDetection {
    scale: number;
    unit: 'in' | 'ft' | null;
    storeyHeight: number | null;
    levels: number;
    rays: number;
}

/**
 * Fix the power of 10 auto-scale of models in inches or feet, which it can't express (×0.01 instead of ×0.0254,
 * ×0.1 instead of ×0.3048): their storeys come out 2.5 to 3 times too low.
 * The storey height is the gap between the model's floor levels, found by a coarse pre-scan
 * @param model loaded model, at its auto-scale
 * @param autoScale the power of 10 auto-scale applied to it
 * @param normalThreshold same floor normal threshold as the build
 * @param onProgress Called with progress in [0, 1]
 */
export async function detectModelScale(
    model: THREE.Object3D,
    autoScale: number,
    normalThreshold: number,
    onProgress: (progress: number) => void = () => { },
): Promise<ScaleDetection> {
    model.updateMatrixWorld(true);
    const { min, max } = new THREE.Box3().setFromObject(model);
    const sizeX = max.x - min.x;
    const sizeZ = max.z - min.z;
    const step = Math.sqrt((sizeX * sizeZ) / PRESCAN_MAX_RAYS) || 1;
    const cols = Math.max(1, Math.ceil(sizeX / step));
    const rows = Math.max(1, Math.ceil(sizeZ / step));

    // Built once here, reused by the build
    ensureBoundsTrees(model);
    const targets = collectRayTargets(model);
    const raycaster = new THREE.Raycaster();
    const rayOriginY = max.y + 1;
    raycaster.far = rayOriginY - min.y + 1;
    raycaster.firstHitOnly = false;
    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);

    // Columns with an upward surface in each Y slice, counted once per column
    const binCount = Math.ceil((max.y - min.y) / LEVEL_BIN) + 1;
    const columnsPerBin = new Float64Array(binCount);
    const columnBins = new Set<number>();
    let lastYield = performance.now();

    for (let r = 0; r < rows; r++) {
        if (performance.now() - lastYield > YIELD_EVERY_MS) {
            onProgress(r / rows);
            await new Promise(resolve => setTimeout(resolve, 0));
            lastYield = performance.now();
        }
        for (let c = 0; c < cols; c++) {
            const ys = castDown(
                targets, raycaster, origin, down, normalThreshold,
                min.x + (c + 0.5) * step, min.z + (r + 0.5) * step, rayOriginY,
            );
            columnBins.clear();
            for (const y of ys) columnBins.add(Math.floor((y - min.y) / LEVEL_BIN));
            for (const bin of columnBins) columnsPerBin[bin]++;
        }
    }
    onProgress(1);

    const levels = findFloorLevels(columnsPerBin).map(bin => min.y + (bin + 0.5) * LEVEL_BIN);
    const rays = rows * cols;
    const gaps = levels.slice(1).map((y, i) => y - levels[i]);
    if (gaps.length === 0) return { scale: autoScale, unit: null, storeyHeight: null, levels: levels.length, rays };

    // Storey height in auto-scale units. A plausible one keeps the auto-scale, and so does a too high one:
    // a hall in metres and a house in feet can't be told apart, the start screen's unit choice settles it
    const storey = median(gaps);
    if (storey >= MIN_STOREY_HEIGHT) return { scale: autoScale, unit: null, storeyHeight: storey, levels: levels.length, rays };

    const rawStorey = storey / autoScale;
    const fit = IMPERIAL_UNITS.find(({ scale }) => {
        const height = rawStorey * scale;
        return height >= MIN_STOREY_HEIGHT && height <= MAX_STOREY_HEIGHT;
    });
    if (!fit) return { scale: autoScale, unit: null, storeyHeight: storey, levels: levels.length, rays };
    return { scale: fit.scale, unit: fit.unit, storeyHeight: rawStorey * fit.scale, levels: levels.length, rays };
}

/**
 * Floor levels: the most covered Y slices, each hiding the weaker ones around it, down to a fraction of the most covered
 * @returns bin indices, bottom up
 */
function findFloorLevels(columnsPerBin: Float64Array): number[] {
    // smoothed over 3 slices: a flat floor straddling two slices still makes one peak
    const smoothed = columnsPerBin.map((_, i) => (columnsPerBin[i - 1] ?? 0) + columnsPerBin[i] + (columnsPerBin[i + 1] ?? 0));
    const byCoverage = [...smoothed.keys()].filter(i => smoothed[i] > 0).sort((a, b) => smoothed[b] - smoothed[a]);
    if (byCoverage.length === 0) return [];

    const minCoverage = LEVEL_MIN_COVERAGE * smoothed[byCoverage[0]];
    const suppressBins = LEVEL_SUPPRESS / LEVEL_BIN;
    const levels: number[] = [];
    for (const bin of byCoverage) {
        if (smoothed[bin] < minCoverage) break;
        if (levels.some(level => Math.abs(level - bin) < suppressBins)) continue;
        levels.push(bin);
    }
    return levels.sort((a, b) => a - b);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
