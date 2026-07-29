import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { SceneMap, FloorLevel, MinimapConfig } from './minimap.js';
import { buildWalkableGrid, pickSpawn } from './minimapUtils.js';

const CACHE_VERSION = 8;

// Globbing grid size = gridSize * factor
const MACRO_CELL_MULTIPLIER = 5;

// Extensions BVH, once when loading
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Build BVH on meshes in scene (once)
 */
function ensureBoundsTrees(scene: THREE.Scene): void {
    scene.traverse(obj => {
        if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
        const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
        if (geo.boundsTree) return;
        try {
            geo.computeBoundsTree!();
        } catch (e) {
            // meshes unsupported by BV
            console.warn(`BVH skip on "${obj.name || obj.uuid}" :`, e);
        }
    });
}

// static scene during scan
const normalMatrixCache = new WeakMap<THREE.Object3D, THREE.Matrix3>();
const _worldNormal = new THREE.Vector3();

/**
 * Sent a vertical ray and return Y hits (filtered normal)
 */
function castDown(
    scene: THREE.Scene,
    raycaster: THREE.Raycaster,
    origin: THREE.Vector3,
    downDir: THREE.Vector3,
    normalThreshold: number,
    x: number,
    z: number,
    rayOriginY: number
): number[] {
    origin.set(x, rayOriginY, z);
    raycaster.set(origin, downDir);
    const intersects = raycaster.intersectObject(scene, true);

    const ys: number[] = [];
    for (const hit of intersects) {
        if (!hit.face) continue;

        let mat = normalMatrixCache.get(hit.object);
        if (!mat) {
            mat = new THREE.Matrix3();
            mat.getNormalMatrix(hit.object.matrixWorld);
            normalMatrixCache.set(hit.object, mat);
        }

        _worldNormal.copy(hit.face.normal).applyMatrix3(mat).normalize();
        if (_worldNormal.y > normalThreshold) ys.push(hit.point.y);
    }
    return ys;
}

/** @typedef HistogramBin one Y-slice of the density histogram */
export interface HistogramBin {
    y: number;
    count: number;
}

/**
 * Cast a horizontal ray from (x, y, z) in direction (dx, 0, dz) and return true
 * if a wall surface is hit within wallRayLength.
 * A surface is a "wall" when its world normal is nearly horizontal (|normal.y| < wallNormalThreshold).
 */
function castHorizontal(
    scene: THREE.Scene,
    raycaster: THREE.Raycaster,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    wallNormalThreshold: number,
    wallRayLength: number,
    x: number,
    y: number,
    z: number,
): boolean {
    origin.set(x, y, z);
    raycaster.set(origin, dir);
    const intersects = raycaster.intersectObject(scene, true);

    for (const hit of intersects) {
        if (hit.distance > wallRayLength) break;
        if (!hit.face) continue;

        let mat = normalMatrixCache.get(hit.object);
        if (!mat) {
            mat = new THREE.Matrix3();
            mat.getNormalMatrix(hit.object.matrixWorld);
            normalMatrixCache.set(hit.object, mat);
        }

        _worldNormal.copy(hit.face.normal).applyMatrix3(mat).normalize();
        if (Math.abs(_worldNormal.y) < wallNormalThreshold) return true;
    }
    return false;
}

/**
 * Build a wall bitmask grid for a floor level.
 * For each walkable cell, fire 4 horizontal rays (N/E/S/W) and mark the corresponding
 * face bit when a wall is detected within wallRayLength.
 *
 * Bitmask: bit 0 = North (−Z), bit 1 = East (+X), bit 2 = South (+Z), bit 3 = West (−X)
 *
 * @param scene THREE.Scene
 * @param walkable Walkable grid for this floor level
 * @param floorY Y position of the floor
 * @param sceneMin Scene bounding box minimum (THREE.Vector3)
 * @param config MinimapConfig (wallScanHeight, wallNormalThreshold, wallRayLength, gridSize)
 * @returns 2D grid of wall bitmasks (same dimensions as walkable)
 */
function buildWallGrid(
    scene: THREE.Scene,
    walkable: boolean[][],
    floorY: number,
    sceneMin: THREE.Vector3,
    config: MinimapConfig,
): number[][] {
    const { gridSize, wallScanHeight, wallNormalThreshold, wallRayLength } = config;
    const rows = walkable.length;
    const cols = walkable[0]?.length ?? 0;

    const walls: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

    const origin = new THREE.Vector3();
    const raycaster = new THREE.Raycaster();
    raycaster.far = wallRayLength + 0.01;
    raycaster.firstHitOnly = false;

    const scanY = floorY + wallScanHeight;

    // Pre-built direction vectors for N / E / S / W
    const DIRS: { dx: number; dz: number; bit: number }[] = [
        { dx: 0, dz: -1, bit: 1 }, // North (−Z)
        { dx: 1, dz: 0, bit: 2 }, // East  (+X)
        { dx: 0, dz: 1, bit: 4 }, // South (+Z)
        { dx: -1, dz: 0, bit: 8 }, // West  (−X)
    ];
    const dirVec = new THREE.Vector3();

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!walkable[r][c]) continue;

            const cx = sceneMin.x + (c + 0.5) * gridSize;
            const cz = sceneMin.z + (r + 0.5) * gridSize;

            let mask = 0;
            for (const { dx, dz, bit } of DIRS) {
                dirVec.set(dx, 0, dz);
                if (castHorizontal(scene, raycaster, origin, dirVec, wallNormalThreshold, wallRayLength, cx, scanY, cz)) {
                    mask |= bit;
                }
            }
            walls[r][c] = mask;
        }
    }

    return walls;
}

/**
 * Create a histogram of Y hits
 * @param hits
 * @param sliceSize small cluster Y
 * @param minPeakArea minimal area to define a peak
 * @param gridSize size of a cell
 * @return the full binned histogram + the detected peaks (candidate floors)
 */
function buildYHistogram(
    hits: { y: number }[],
    sliceSize: number,
    minPeakArea: number,
    gridSize: number
): { bins: HistogramBin[]; peaks: { centerY: number; count: number }[] } {
    if (hits.length === 0) return { bins: [], peaks: [] };

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

    const bins: HistogramBin[] = histo.map((count, i) => ({ y: minY + (i + 0.5) * sliceSize, count }));

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

    return { bins, peaks };
}

/**
 * Raycast with BFS. Découpe des plages d'indices entiers [rowStart,rowEnd)×[colStart,colEnd)
 * jusqu'à une seule cellule. La position du rayon est toujours dérivée des indices,
 * jamais l'inverse => alignement garanti avec la grille, aucune dérive flottante.
 *
 * Anti-faux-négatif : si le centre d'un carré rate tout, on vérifie ses 4 coins
 * (légèrement rentrés) avant d'abandonner la zone — évite qu'un joint/gap de mesh
 * pile au centre fasse sauter toute une zone qui a pourtant du sol.
 */
function adaptiveRaycastQueue(
    scene: THREE.Scene,
    raycaster: THREE.Raycaster,
    normalThreshold: number,
    min: THREE.Vector3,
    gridSize: number,
    rayOriginY: number,
    macroCells: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }[],
    allHits: { r: number; c: number; y: number }[],
    seen: Set<string>
): number {
    const origin = new THREE.Vector3();
    const downDir = new THREE.Vector3(0, -1, 0);

    let queue = macroCells;
    let pass = 0;
    let totalRays = 0;

    while (queue.length > 0) {
        const cellsThisPass = queue.length;
        console.log(`Pass ${pass} : ${cellsThisPass} rays`);
        console.time(`    pass ${pass}`);

        const nextQueue: typeof queue = [];
        let touched = 0;

        for (const cell of queue) {
            const { rowStart, rowEnd, colStart, colEnd } = cell;

            const x0 = min.x + colStart * gridSize;
            const x1 = min.x + colEnd * gridSize;
            const z0 = min.z + rowStart * gridSize;
            const z1 = min.z + rowEnd * gridSize;
            const cx = (x0 + x1) / 2;
            const cz = (z0 + z1) / 2;

            totalRays++;
            let ys = castDown(scene, raycaster, origin, downDir, normalThreshold, cx, cz, rayOriginY);

            // empty square
            if (ys.length === 0) continue;

            touched++;

            const isLeaf = (rowEnd - rowStart) <= 1 && (colEnd - colStart) <= 1;

            if (isLeaf) {
                const r = rowStart;
                const c = colStart;
                const key = `${r}_${c}`;
                if (seen.has(key)) continue;
                seen.add(key);
                for (const y of ys) allHits.push({ r, c, y });
                continue;
            }

            // avoid empty ranges
            const rowMid = rowStart + Math.ceil((rowEnd - rowStart) / 2);
            const colMid = colStart + Math.ceil((colEnd - colStart) / 2);

            const rowRanges = (rowEnd - rowStart) > 1
                ? [[rowStart, rowMid], [rowMid, rowEnd]]
                : [[rowStart, rowEnd]];
            const colRanges = (colEnd - colStart) > 1
                ? [[colStart, colMid], [colMid, colEnd]]
                : [[colStart, colEnd]];

            for (const [rS, rE] of rowRanges) {
                for (const [cS, cE] of colRanges) {
                    nextQueue.push({ rowStart: rS, rowEnd: rE, colStart: cS, colEnd: cE });
                }
            }
        }

        console.timeEnd(`    pass ${pass}`);
        console.log(`    -> ${touched}/${cellsThisPass} hits, ${nextQueue.length} sub-cells for next pass`);

        queue = nextQueue;
        pass++;
    }

    console.log(`Total : ${totalRays} rays sent in ${pass} passes`);
    return totalRays;
}

/**
 * Build the scene map with floor detection
 * @param scene Scene of the 3D world
 * @param config Parameters use during map creation
 */
export async function buildSceneMap(
    scene: THREE.Scene,
    config: MinimapConfig,
): Promise<{ map: SceneMap; histogram: HistogramBin[] }> {
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

    console.time('BVH build');
    ensureBoundsTrees(scene);
    console.timeEnd('BVH build');

    const raycaster = new THREE.Raycaster();
    const rayOriginY = max.y + 1;

    // Far born from scene
    raycaster.far = (rayOriginY - min.y) + gridSize;
    raycaster.firstHitOnly = false;

    // Global Raycast (adaptatif, quadtree)
    console.group('Step 1 - Global raycast');
    console.time('raycast total');

    const allHits: { r: number; c: number; y: number }[] = [];
    const seen = new Set<string>();

    const macroCells: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }[] = [];
    for (let r0 = 0; r0 < rows; r0 += MACRO_CELL_MULTIPLIER) {
        const r1 = Math.min(r0 + MACRO_CELL_MULTIPLIER, rows);
        for (let c0 = 0; c0 < cols; c0 += MACRO_CELL_MULTIPLIER) {
            const c1 = Math.min(c0 + MACRO_CELL_MULTIPLIER, cols);
            macroCells.push({ rowStart: r0, rowEnd: r1, colStart: c0, colEnd: c1 });
        }
    }

    console.log(`Macro grid : ${macroCells.length} starting cells`);

    const totalRays = adaptiveRaycastQueue(
        scene, raycaster, normalThreshold,
        min, gridSize, rayOriginY,
        macroCells, allHits, seen
    );

    console.timeEnd('raycast total');
    console.log(`${totalRays} rayons tirés (vs ${totalCells} en brute force)`);
    console.log(`${allHits.length} hits horizontal on ${totalCells} cells`);
    console.groupEnd();

    // Histogram Y => pics = floors
    console.group('Step 2 - Histogram Y');
    console.time('histogram');

    console.log('Building histogram Y…');
    const { bins, peaks } = buildYHistogram(allHits, histoHeightSize, minPeakArea, gridSize);

    console.log(`${peaks.length} peaks detected :`);
    peaks.forEach((p, i) => console.log(`    Peak ${i} : Y=${p.centerY.toFixed(3)}m  (${p.count} hits)`));

    console.timeEnd('histogram');
    console.groupEnd();

    // Walkable grid per peak
    console.group('Step 3 - Walkable grid per peak');
    console.time('walkable');
    console.log('Building Walkable grids…');

    const rawLevels: FloorLevel[] = [];

    // Assign each hit to its nearest peak
    const hitPeakIndex = allHits.map(hit => {
        let best = -1;
        let bestDist = Infinity;
        for (let pi = 0; pi < peaks.length; pi++) {
            const d = Math.abs(hit.y - peaks[pi].centerY);
            if (d < bestDist) {
                bestDist = d;
                best = pi;
            }
        }
        return bestDist <= voxYThr ? best : -1;
    });

    for (let pi = 0; pi < peaks.length; pi++) {
        const peak = peaks[pi];
        console.group(`    Peak ${pi} Y=${peak.centerY.toFixed(2)}m`);

        const peakHits = allHits.filter((_, idx) => hitPeakIndex[idx] === pi);

        const { walkable, bestComponent } = buildWalkableGrid(
            peakHits, peak.centerY, voxYThr, minCells, rows, cols
        );

        if (bestComponent.length === 0) {
            console.log('    Not enough surfaces => ignored');
            console.groupEnd();
            continue;
        }

        // LOG INFO
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
            walls: [], // populated in Step 4
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
            console.log(`    Merge Y=${level.floorY.toFixed(2)} => sub-level of Y=${last.floorY.toFixed(2)} (gap=${(level.floorY - last.floorY).toFixed(2)}m < ${minFloorGap}m)`);
            last.subLevels.push({
                deltaY: level.floorY - last.floorY,
                absoluteY: level.floorY,
                walkable: level.walkable,
            });
        } else {
            levels.push({ ...level, id: levels.length });
        }
    }

    // Step 4 - Wall detection
    console.group('Step 4 - Wall detection');
    console.time('walls');
    console.log('Building wall grids…');

    for (const level of levels) {
        console.time(`    floor ${level.id}`);
        level.walls = buildWallGrid(scene, level.walkable, level.floorY, min, config);
        const wallCount = level.walls.flat().filter(v => v !== 0).length;
        console.log(`    Floor ${level.id}: ${wallCount} cells with wall(s)`);
        console.timeEnd(`    floor ${level.id}`);
    }

    console.timeEnd('walls');
    console.groupEnd();

    // Global bounds
    const globalMinX = Math.min(...levels.map(l => l.bounds.minX));
    const globalMaxX = Math.max(...levels.map(l => l.bounds.maxX));
    const globalMinZ = Math.min(...levels.map(l => l.bounds.minZ));
    const globalMaxZ = Math.max(...levels.map(l => l.bounds.maxZ));

    console.log(`${levels.length} floors.`);
    console.groupEnd();

    console.log('Map built !');

    const map: SceneMap = {
        version: CACHE_VERSION,
        sceneBounds: { sceneMinX: min.x, sceneMinZ: min.z },
        bounds: { minX: globalMinX, maxX: globalMaxX, minZ: globalMinZ, maxZ: globalMaxZ },
        cols: Math.ceil((globalMaxX - globalMinX) / gridSize),
        rows: Math.ceil((globalMaxZ - globalMinZ) / gridSize),
        gridSize,
        levels,
    };

    return { map, histogram: bins };
}
