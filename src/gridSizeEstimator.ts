import * as THREE from 'three';
import { ensureBoundsTrees, collectRayTargets, castDown } from './minimapBuilder.js';

// Coarse pre-scan: one downward ray per cell, a few thousand rays at most so it stays under a second or so
const PRESCAN_STEP = 0.5; // m
const PRESCAN_MAX_RAYS = 10_000;

// Cells the full build may handle (floor area summed over every storey / gridSize²): the time budget.
// To calibrate against measured build times
const MAX_BUILD_CELLS = 1_000_000;

// Two upward surfaces of a column at least this far apart are two storeys: above a tall shelf or a bunk bed, below a real floor gap
const MIN_STOREY_HEIGHT = 2.4; // m
const MAX_STOREY_HEIGHT = 6; // m, over that it's a roof above a hall, not a storey
const DEFAULT_STOREY_HEIGHT = 3; // m, single storey models (or cut away ones, without a ceiling)

// A real door is ~0.9 m wide for a ~3 m storey. The measured storey height corrects models whose auto-scale is
// slightly off (cartoon proportions...), within limits: a high ceiling hall doesn't come with wider doors
const DOOR_PER_STOREY = 0.3;
const MIN_SCALE_CORRECTION = 0.67;
const MAX_SCALE_CORRECTION = 1.5;

// Cells across a door: finer than FINE is wasted time, coarser than COARSE and doors stop splitting rooms
const FINE_CELLS_PER_DOOR = 10;
const COARSE_CELLS_PER_DOOR = 5;

// Slider range offered for the model: from finer than useful (and at most 4× the cells of the
// time budget) to coarse enough that a door spans only 3 cells (rooms no longer split)
const MIN_RANGE_CELLS_PER_DOOR = 15;
const MAX_BUDGET_FACTOR = 2; // grid size ratio, 4× the cells
const MAX_RANGE_CELLS_PER_DOOR = 3;

const MIN_GRID_SIZE = 0.05;
const MAX_GRID_SIZE = 1.0;
const GRID_SIZE_ROUNDING = 0.01;
const FALLBACK_GRID_SIZE = 0.1;

const YIELD_EVERY_MS = 30;

/**
 * @typedef GridSizeEstimate
 * @prop gridSize suggested grid size (m)
 * @prop minGridSize / maxGridSize range worth offering for this model (m), gridSize included
 * @prop floorArea floor area summed over every storey (m²)
 * @prop storeyHeight median storey height (m), null when the model has a single storey
 * @prop doorWidth door width the grid is sized for (m)
 * @prop budgetGridSize finest grid size fitting MAX_BUILD_CELLS
 * @prop isTooCoarse the time budget forced a grid too coarse for doors to split rooms
 * @prop rays rays cast by the pre-scan
 */
export interface GridSizeEstimate {
    gridSize: number;
    minGridSize: number;
    maxGridSize: number;
    floorArea: number;
    storeyHeight: number | null;
    doorWidth: number;
    budgetGridSize: number;
    isTooCoarse: boolean;
    rays: number;
}

/**
 * Suggest a grid size for a model: as fine as the build time budget allows, but no finer than needed
 * to see its doors. Both come from a coarse pre-scan: the floor area (time) and the storey height (door size)
 * @param model loaded model (scaled to metres)
 * @param normalThreshold same floor normal threshold as the build
 * @param onProgress Called with progress in [0, 1]
 */
export async function estimateGridSize(
    model: THREE.Object3D,
    normalThreshold: number,
    onProgress: (progress: number) => void = () => { },
): Promise<GridSizeEstimate> {
    const { min, max } = new THREE.Box3().setFromObject(model);
    const sizeX = max.x - min.x;
    const sizeZ = max.z - min.z;
    const step = Math.max(PRESCAN_STEP, Math.sqrt((sizeX * sizeZ) / PRESCAN_MAX_RAYS));
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

    let storeyCells = 0;
    const storeyGaps: number[] = [];
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
            if (ys.length === 0) continue;

            // Storeys of the column, bottom up: a surface far enough above the current storey's floor starts the next one
            // (furniture tops in between are skipped)
            ys.sort((a, b) => a - b);
            let base = ys[0];
            storeyCells++;
            for (const y of ys) {
                const gap = y - base;
                if (gap < MIN_STOREY_HEIGHT) continue;
                if (gap <= MAX_STOREY_HEIGHT) {
                    storeyGaps.push(gap);
                    storeyCells++;
                }
                base = y;
            }
        }
    }
    onProgress(1);

    const rays = rows * cols;
    const floorArea = storeyCells * step * step;
    if (floorArea === 0) {
        console.warn('Grid size estimate: no floor found by the pre-scan, falling back to the default');
        return {
            gridSize: FALLBACK_GRID_SIZE, minGridSize: MIN_GRID_SIZE, maxGridSize: MAX_GRID_SIZE,
            floorArea, storeyHeight: null, doorWidth: DOOR_PER_STOREY * DEFAULT_STOREY_HEIGHT,
            budgetGridSize: FALLBACK_GRID_SIZE, isTooCoarse: false, rays,
        };
    }

    const storeyHeight = storeyGaps.length > 0 ? median(storeyGaps) : null;
    const scaleCorrection = clamp((storeyHeight ?? DEFAULT_STOREY_HEIGHT) / DEFAULT_STOREY_HEIGHT, MIN_SCALE_CORRECTION, MAX_SCALE_CORRECTION);
    const doorWidth = DOOR_PER_STOREY * DEFAULT_STOREY_HEIGHT * scaleCorrection;

    const budgetGridSize = Math.sqrt(floorArea / MAX_BUILD_CELLS);
    const raw = Math.max(budgetGridSize, doorWidth / FINE_CELLS_PER_DOOR);
    const gridSize = roundGridSize(raw);
    const isTooCoarse = gridSize > doorWidth / COARSE_CELLS_PER_DOOR;

    // a model too large for its budget still gets its estimate within range
    const minGridSize = Math.min(gridSize, roundGridSize(Math.max(doorWidth / MIN_RANGE_CELLS_PER_DOOR, budgetGridSize / MAX_BUDGET_FACTOR)));
    const maxGridSize = Math.max(gridSize, roundGridSize(doorWidth / MAX_RANGE_CELLS_PER_DOOR));

    return { gridSize, minGridSize, maxGridSize, floorArea, storeyHeight, doorWidth, budgetGridSize, isTooCoarse, rays };
}

function roundGridSize(v: number): number {
    return clamp(Math.round(v / GRID_SIZE_ROUNDING) * GRID_SIZE_ROUNDING, MIN_GRID_SIZE, MAX_GRID_SIZE);
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
