import * as THREE from 'three';
import type { SceneMap, FloorLevel, MinimapConfig } from './minimap.js';
import { buildWalkableGrid, pickSpawn } from './minimapUtils.js';

const CACHE_VERSION = 1;

/**
 * Create a histogram of Y hits
 * @param hits
 * @param sliceSize small cluster Y
 * @param minPeakArea minimal area to define a peak
 * @param gridSize size of a cell
 * @return List of histogram peaks + density
 */
function buildYHistogram(
    hits: { y: number }[],
    sliceSize: number,
    minPeakArea: number,
    gridSize: number
): { centerY: number; count: number }[] {
    if (hits.length === 0) return [];

    const minY = Math.min(...hits.map(h => h.y));
    const maxY = Math.max(...hits.map(h => h.y));
    const numSlices = Math.ceil((maxY - minY) / sliceSize) + 1;
    const histo = new Array(numSlices).fill(0);

    for (const hit of hits) {
        const idx = Math.min(Math.floor((hit.y - minY) / sliceSize), numSlices - 1);
        histo[idx]++;
    }

    console.group("Histogram Y");
    histo.forEach((count, i) => {
        if (count === 0) return;
        const y = minY + (i + 0.5) * sliceSize;
        const bar = '█'.repeat(Math.ceil(count / hits.length * 200));
        console.log(`    Y=${y.toFixed(2)}m  [${count.toString().padStart(5)}]  ${bar}`);
    });
    console.groupEnd();

    // Local peaks => bigger than neighbour & above surface threshold
    const peaks: { centerY: number; count: number }[] = [];

    for (let i = 0; i < histo.length; i++) {
        const prev = histo[i - 1] ?? 0;
        const next = histo[i + 1] ?? 0;
        const area = histo[i] * gridSize;
        if (histo[i] >= prev && histo[i] >= next && area > minPeakArea) {
            // Merge with previous peak
            const last = peaks[peaks.length - 1];
            if (last && minY + (i + 0.5) * sliceSize - last.centerY < sliceSize * 2) {
                // Keep the bigger one
                if (histo[i] > last.count) {
                    peaks[peaks.length - 1] = { centerY: minY + (i + 0.5) * sliceSize, count: histo[i] };
                }
            } else {
                peaks.push({ centerY: minY + (i + 0.5) * sliceSize, count: histo[i] });
            }
        }
    }

    return peaks;
}

/**
 * Build the scene map with floor detection
 * @param scene Scene of the 3D world
 * @param config Parameters use during map creation
 */
export async function buildSceneMap(
    scene: THREE.Scene,
    config: MinimapConfig,
    modelPath: string,
): Promise<SceneMap> {
    const {
        gridSize,
        minWalkableArea,
        normalThreshold,
        voxYThr,
        minFloorGap,
        histoHeightSize,
        minPeakArea
    } = config;

    const box = new THREE.Box3().setFromObject(scene);
    const { min, max } = box;
    const cols = Math.ceil((max.x - min.x) / gridSize);
    const rows = Math.ceil((max.z - min.z) / gridSize);
    const totalCells = rows * cols;
    const minCells = Math.ceil(minWalkableArea / (gridSize * gridSize));

    console.group('buildSceneMap');
    console.log(`Bounds : X[${min.x.toFixed(2)}, ${max.x.toFixed(2)}]  Y[${min.y.toFixed(2)}, ${max.y.toFixed(2)}]  Z[${min.z.toFixed(2)}, ${max.z.toFixed(2)}]`);
    console.log(`Global grid : ${cols}×${rows} = ${totalCells} cells`);

    // Global Raycast (offloaded to a worker to keep the main thread responsive)
    console.group('Step 1 - Global raycast');
    console.time('raycast');

    const worker = new Worker(new URL('./raycastWorker.ts', import.meta.url), { type: 'module' });
    const allHits = await new Promise<{ r: number; c: number; y: number }[]>((resolve, reject) => {
        worker.onmessage = e => resolve(e.data);
        worker.onerror = reject;
        worker.postMessage({ modelPath, gridSize, normalThreshold });
    });
    worker.terminate();

    console.log(`Raycast… 100%`);
    console.timeEnd('raycast');
    console.log(`${allHits.length} hits horizontal on ${totalCells} cells`);
    console.groupEnd();

    // Histogram Y => pics = floors
    console.group('Step 2 - Histogram Y');
    console.time('histogram');

    console.log('Building histogram Y…');
    const peaks = buildYHistogram(allHits, histoHeightSize, minPeakArea, gridSize);

    console.log(`${peaks.length} peaks detected :`);
    peaks.forEach((p, i) => console.log(`    Peak ${i} : Y=${p.centerY.toFixed(3)}m  (${p.count} hits)`));

    console.timeEnd('histogram');
    console.groupEnd();

    // Walkable grid per peak
    console.group('Step 3 - Walkable grid per peak');
    console.time('walkable');
    console.log('Building Walkable grids…');

    const rawLevels: FloorLevel[] = [];

    for (let pi = 0; pi < peaks.length; pi++) {
        const peak = peaks[pi];
        console.group(`    Peak ${pi} Y=${peak.centerY.toFixed(2)}m`);

        const { walkable, bestComponent } = buildWalkableGrid(
            allHits, peak.centerY, voxYThr, minCells, rows, cols
        );

        if (bestComponent.length === 0) {
            console.log('    Not enough surfaces => ignored');
            console.groupEnd();
            continue;
        }

        // LOG INFO
        const peakHits = allHits.filter(h => Math.abs(h.y - peak.centerY) <= voxYThr);
        const tMinX = Math.min(...peakHits.map(h => min.x + h.c * gridSize));
        const tMaxX = Math.max(...peakHits.map(h => min.x + (h.c + 1) * gridSize));
        const tMinZ = Math.min(...peakHits.map(h => min.z + h.r * gridSize));
        const tMaxZ = Math.max(...peakHits.map(h => min.z + (h.r + 1) * gridSize));

        const spawnPoint = pickSpawn(bestComponent, peak.centerY, min.x, min.z, gridSize);
        const walkableCount = walkable.flat().filter(Boolean).length;

        console.log(`    ${walkableCount} walkable cells, component : ${bestComponent.length}`);
        console.log(`    Bounds XZ : X[${tMinX.toFixed(2)}, ${tMaxX.toFixed(2)}]  Z[${tMinZ.toFixed(2)}, ${tMaxZ.toFixed(2)}]`);
        console.log(`    Spawn : (${spawnPoint.x.toFixed(2)}, ${spawnPoint.y.toFixed(2)}, ${spawnPoint.z.toFixed(2)})`);
        console.groupEnd();

        rawLevels.push({
            id: rawLevels.length,
            floorY: peak.centerY,
            ceilingY: peaks[pi + 1]?.centerY ?? Infinity,
            walkable,
            subLevels: [],
            spawnPoint,
            bounds: { minX: tMinX, maxX: tMaxX, minZ: tMinZ, maxZ: tMaxZ },
        });
    }

    console.timeEnd('walkable');
    console.groupEnd();

    // Merge close levels
    const levels: FloorLevel[] = [];
    for (const level of rawLevels) {
        const last = levels[levels.length - 1];
        if (last && level.floorY - last.floorY < minFloorGap) {
            console.log(`    Merge Y=${level.floorY.toFixed(2)} => sub-level of Y=${last.floorY.toFixed(2)} (gap=${( level.floorY - last.floorY).toFixed(2)}m < ${minFloorGap}m)`);
            last.subLevels.push({
                deltaY: level.floorY - last.floorY,
                absoluteY: level.floorY,
                walkable: level.walkable,
            });
        } else {
            levels.push({ ...level, id: levels.length });
        }
    }

    // Global bounds
    const globalMinX = Math.min(...levels.map(l => l.bounds.minX));
    const globalMaxX = Math.max(...levels.map(l => l.bounds.maxX));
    const globalMinZ = Math.min(...levels.map(l => l.bounds.minZ));
    const globalMaxZ = Math.max(...levels.map(l => l.bounds.maxZ));

    console.log(`${levels.length} floors.`);
    console.groupEnd();

    console.log('Map built !');

    return {
        version: CACHE_VERSION,
        sceneBounds: { sceneMinX: min.x, sceneMinZ: min.z },
        bounds: { minX: globalMinX, maxX: globalMaxX, minZ: globalMinZ, maxZ: globalMaxZ },
        cols: Math.ceil((globalMaxX - globalMinX) / gridSize),
        rows: Math.ceil((globalMaxZ - globalMinZ) / gridSize),
        gridSize,
        levels,
    };
}
