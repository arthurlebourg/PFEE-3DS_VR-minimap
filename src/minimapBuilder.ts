import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { CACHE_VERSION, type SceneMap, type FloorLevel, type MinimapConfig, type StairConnector } from './minimap.js';
import { buildWalkableGrid, pickSpawn, openingByReconstruction, largestComponent } from './minimapUtils.js';
import { segmentRooms } from './roomSegmentation.js';

// Globbing grid size = gridSize * factor
const MACRO_CELL_MULTIPLIER = 5;

// Below this rise, a climb is noise, not a stair
const MIN_CONNECTOR_RISE = 0.15;

// Max time spent computing before handing control back to the browser (repaint, input)
const YIELD_INTERVAL_MS = 30;

export type BuildProgressCallback = (progress: number, label: string) => void;

/**
 * Let the browser repaint (loading bar) before continuing the computation
 */
function yieldToBrowser(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * To call often inside long loops: hands control back to the browser (repaint, input,
 * render loop) at most every YIELD_INTERVAL_MS, reporting progress right before
 */
function createYielder(): (reportProgress: () => void) => Promise<void> {
    let lastYield = performance.now();
    return async reportProgress => {
        if (performance.now() - lastYield < YIELD_INTERVAL_MS) return;
        reportProgress();
        await yieldToBrowser();
        lastYield = performance.now();
    };
}

// Extensions BVH, once when loading
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Build BVH on meshes in scene (once)
 */
function ensureBoundsTrees(scene: THREE.Object3D): void {
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
    scene: THREE.Object3D,
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
    scene: THREE.Object3D,
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
 * @param onProgress Called with progress in [0, 1]
 * @returns 2D grid of wall bitmasks (same dimensions as walkable)
 */
async function buildWallGrid(
    scene: THREE.Object3D,
    walkable: boolean[][],
    floorY: number,
    sceneMin: THREE.Vector3,
    config: MinimapConfig,
    onProgress: (progress: number) => void,
): Promise<number[][]> {
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
    const maybeYield = createYielder();

    for (let r = 0; r < rows; r++) {
        await maybeYield(() => onProgress(r / rows));
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

const BRIDGE_NEIGHBOURHOOD: [number, number][] = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
const BRIDGE_STEP_Y = 0.05; // m, how finely the projected trend is sampled
const BRIDGE_OVERSHOOT = 0.3; // meters past the target floor's own Y, in case its landing sits a bit off

/**
 * On dead-end, project the seed->highest-reached
 * trend in a straight line and check if it crosses the next floor's walkable area
 */
function tryBridgeToNextFloor(
    seed: { r: number; c: number },
    seedY: number,
    cells: { r: number; c: number; y: number }[],
    sourceLevel: FloorLevel,
    levels: FloorLevel[],
): number | null {
    const frontier = cells.reduce((best, cell) => (cell.y > best.y ? cell : best), cells[0]);
    const dy = frontier.y - seedY;
    if (dy <= 0) return null; // no upward trend to project

    const slopeR = (frontier.r - seed.r) / dy;
    const slopeC = (frontier.c - seed.c) / dy;

    const target = levels
        .filter(l => l.id !== sourceLevel.id && l.floorY > frontier.y)
        .sort((a, b) => a.floorY - b.floorY)[0];
    if (!target) return null;

    for (let y = frontier.y + BRIDGE_STEP_Y; y <= target.floorY + BRIDGE_OVERSHOOT; y += BRIDGE_STEP_Y) {
        const r = Math.round(frontier.r + slopeR * (y - frontier.y));
        const c = Math.round(frontier.c + slopeC * (y - frontier.y));
        for (const [or_, oc] of BRIDGE_NEIGHBOURHOOD) {
            if (target.walkable[r + or_]?.[c + oc]) return target.id;
        }
    }
    return null;
}

/**
 * Grows from a boundary cell of `sourceLevel`.
 * A neighbour is accepted only if its height sits within [-stairFlatTolerance, +stairMaxStepRise] of the current cell.
 * No global slope, just a bounded step each time, so landings pass but a jump to furniture height doesn't.
 */
function climbFromSeed(
    seed: { r: number; c: number },
    sourceLevel: FloorLevel,
    heightNear: (r: number, c: number, fromY: number) => number | undefined,
    levels: FloorLevel[],
    claimedByThisFloor: Set<string>,
    gridSize: number,
    config: MinimapConfig,
): StairConnector | null {
    const { stairMaxStepRise, stairFlatTolerance, maxLandingRun, minStairArea, maxStairArea } = config;
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const maxLandingCells = Math.ceil(maxLandingRun / gridSize);

    // Use the seed's actual measured height, not sourceLevel.floorY
    const seedY = heightNear(seed.r, seed.c, sourceLevel.floorY) ?? sourceLevel.floorY;

    type Node = { r: number; c: number; y: number; flatRun: number };
    const climbQueue: Node[] = [{ r: seed.r, c: seed.c, y: seedY, flatRun: 0 }];
    const flatQueue: Node[] = [];
    const localVisited = new Set<string>();
    const cells: { r: number; c: number; y: number }[] = [];
    const touchedFloorIds = new Set<number>();

    let node: Node | undefined;
    while ((node = climbQueue.shift() ?? flatQueue.shift())) {
        const key = `${node.r}_${node.c}`;
        if (localVisited.has(key)) continue;
        localVisited.add(key);

        for (const [dr, dc] of DIRS) {
            const nr = node.r + dr, nc = node.c + dc;
            const nKey = `${nr}_${nc}`;
            if (localVisited.has(nKey) || claimedByThisFloor.has(nKey)) continue;

            const hitFloor = levels.find(l => l.id !== sourceLevel.id && l.walkable[nr]?.[nc]);
            const neighbourY = hitFloor ? hitFloor.floorY : heightNear(nr, nc, node.y);
            if (neighbourY === undefined) continue; // no surface there at all

            const dy = neighbourY - node.y;
            if (dy < -stairFlatTolerance || dy > stairMaxStepRise) continue; // too steep either way

            const isFlat = dy <= stairFlatTolerance;
            const flatRun = isFlat ? node.flatRun + 1 : 0;
            if (flatRun > maxLandingCells) continue; // wandered too far on a plateau — dead end

            if (hitFloor) {
                touchedFloorIds.add(hitFloor.id);
                localVisited.add(nKey); // arrival cell — don't grow past it
                continue;
            }

            cells.push({ r: nr, c: nc, y: neighbourY });
            (isFlat ? flatQueue : climbQueue).push({ r: nr, c: nc, y: neighbourY, flatRun });
        }
    }

    for (const { r, c } of cells) claimedByThisFloor.add(`${r}_${c}`);

    if (cells.length === 0) return null; // nothing climbed at all — not worth reporting

    const area = cells.length * gridSize * gridSize;
    if (area < minStairArea || area > maxStairArea) return null;

    // Require real climbed height
    const ys = cells.map(c => c.y);
    if (Math.max(...ys) - Math.min(...ys) < MIN_CONNECTOR_RISE) return null;

    // Resolved = landed on exactly one floor.
    // A pure dead end gets one more chance via tryBridgeToNextFloor.
    // An already-ambiguous climb is left alone.
    // Still-unresolved is reported, not dropped.
    let resolved = touchedFloorIds.size === 1;
    let bridged = false;
    let toFloorId = resolved ? [...touchedFloorIds][0] : null;

    if (!resolved && touchedFloorIds.size === 0) {
        const bridgedFloorId = tryBridgeToNextFloor(seed, seedY, cells, sourceLevel, levels);
        if (bridgedFloorId !== null) {
            resolved = true;
            bridged = true;
            toFloorId = bridgedFloorId;
        }
    }

    return {
        fromFloorId: sourceLevel.id,
        toFloorId,
        resolved,
        bridged,
        cells,
        entryY: Math.min(...ys),
        exitY: Math.max(...ys),
    };
}

/**
 * Detect stair connectors by climbing outward from each floor's edge
 *
 * @param allHits every raw hit from the downward raycast pass
 * @param levels finalized floor levels (post sub-level merge)
 * @param gridSize size of a cell
 * @param config stairMaxStepRise / stairFlatTolerance / maxLandingRun / minStairArea / maxStairArea
 * @param scene scene rays against
 * @param raycaster reused raycaster instance
 * @param sceneMin scene bounding-box min, to convert back to world
 * @param rayOriginY Y to fire catch-up rays down from
 * @param onProgress Called with progress in [0, 1]
 */
async function detectStairConnectors(
    allHits: { r: number; c: number; y: number }[],
    levels: FloorLevel[],
    gridSize: number,
    config: MinimapConfig,
    scene: THREE.Object3D,
    raycaster: THREE.Raycaster,
    sceneMin: THREE.Vector3,
    rayOriginY: number,
    onProgress: (progress: number) => void,
): Promise<StairConnector[]> {
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    // Height field: raw hits per cell, kept separate so the climb can pick whichever
    // surface is closest to its current Y
    const cellYs = new Map<string, number[]>();
    for (const { r, c, y } of allHits) {
        const key = `${r}_${c}`;
        const arr = cellYs.get(key);
        if (arr) arr.push(y); else cellYs.set(key, [y]);
    }

    // Try with a dense sub-grid reaching past the cell's edge, fired whenever no "ahead"
    // candidate is found, not just on zero data, or a cell with one hit never gets reprobed.
    const fallbackOrigin = new THREE.Vector3();
    const fallbackDown = new THREE.Vector3(0, -1, 0);
    const FALLBACK_GRID = 5;
    const FALLBACK_REACH = 0.4; // cell widths
    const fallbackOffsets: [number, number][] = [];
    for (let i = 0; i < FALLBACK_GRID; i++) {
        for (let j = 0; j < FALLBACK_GRID; j++) {
            fallbackOffsets.push([
                -FALLBACK_REACH + (2 * FALLBACK_REACH * i) / (FALLBACK_GRID - 1),
                -FALLBACK_REACH + (2 * FALLBACK_REACH * j) / (FALLBACK_GRID - 1),
            ]);
        }
    }

    const fallbackTried = new Set<string>();
    const pickAhead = (candidates: number[], fromY: number): number | undefined => {
        const ahead = candidates.filter(y => y >= fromY - config.stairFlatTolerance);
        return ahead.length > 0 ? Math.min(...ahead) : undefined;
    };

    function heightNear(r: number, c: number, fromY: number): number | undefined {
        const key = `${r}_${c}`;
        let arr = cellYs.get(key);

        if (arr) {
            const ahead = pickAhead(arr, fromY);
            if (ahead !== undefined) return ahead;
        }

        // No usable "ahead" candidate yet, try the dense catch-up probe,
        // once per cell, before falling back to whatever's closest.
        if (!fallbackTried.has(key)) {
            fallbackTried.add(key);
            const cx = sceneMin.x + (c + 0.5) * gridSize;
            const cz = sceneMin.z + (r + 0.5) * gridSize;
            const found: number[] = [];
            for (const [ox, oz] of fallbackOffsets) {
                found.push(...castDown(
                    scene, raycaster, fallbackOrigin, fallbackDown, config.normalThreshold,
                    cx + ox * gridSize, cz + oz * gridSize, rayOriginY
                ));
            }
            if (found.length > 0) {
                arr = arr ? [...arr, ...found] : found;
                cellYs.set(key, arr);
                const ahead = pickAhead(arr, fromY);
                if (ahead !== undefined) return ahead;
            }
        }

        if (!arr || arr.length === 0) return undefined;
        // "Closest in Y" has no sense of climb direction and can grab the step behind us
        // prefer an ahead candidate, only falling back to nearest when none exists
        return arr.reduce((best, y) => Math.abs(y - fromY) < Math.abs(best - fromY) ? y : best);
    }

    const connectors: StairConnector[] = [];
    const maybeYield = createYielder();

    for (const [li, level] of levels.entries()) {
        const rows = level.walkable.length;
        const cols = level.walkable[0]?.length ?? 0;

        // Scoped per source floor: a spiral can revisit the same (r,c) at a higher Y on its way up
        const claimedByThisFloor = new Set<string>();

        // candidate stair entrances
        for (let r = 0; r < rows; r++) {
            await maybeYield(() => onProgress((li + r / rows) / levels.length));
            for (let c = 0; c < cols; c++) {
                if (!level.walkable[r][c]) continue;
                const isBoundary = DIRS.some(([dr, dc]) => !level.walkable[r + dr]?.[c + dc]);
                if (!isBoundary) continue;

                const connector = climbFromSeed({ r, c }, level, heightNear, levels, claimedByThisFloor, gridSize, config);
                if (connector) connectors.push(connector);
            }
        }
    }

    return connectors;
}

/**
 * Clean wall masks by removing tiny disconnected wall fragments.
 * This keeps long walls and curved wall segments while removing furniture/table artifacts.
 */
function filterWallClusters(walls: number[][], minClusterCells: number = 3): number[][] {
    const rows = walls.length;
    const cols = walls[0]?.length ?? 0;
    if (rows === 0 || cols === 0) return walls;

    const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const filtered = walls.map(row => [...row]);

    const DIRS: [number, number][] = [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1], [0, 1],
        [1, -1], [1, 0], [1, 1],
    ];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (visited[r][c] || filtered[r][c] === 0) continue;

            const queue: [number, number][] = [[r, c]];
            visited[r][c] = true;
            const cluster: [number, number][] = [];

            while (queue.length > 0) {
                const [cr, cc] = queue.pop()!;
                cluster.push([cr, cc]);

                for (const [dr, dc] of DIRS) {
                    const nr = cr + dr;
                    const nc = cc + dc;
                    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
                    if (visited[nr][nc] || filtered[nr][nc] === 0) continue;
                    visited[nr][nc] = true;
                    queue.push([nr, nc]);
                }
            }

            if (cluster.length < minClusterCells) {
                for (const [cr, cc] of cluster) filtered[cr][cc] = 0;
            }
        }
    }

    return filtered;
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
async function adaptiveRaycastQueue(
    scene: THREE.Object3D,
    raycaster: THREE.Raycaster,
    normalThreshold: number,
    min: THREE.Vector3,
    gridSize: number,
    rayOriginY: number,
    macroCells: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }[],
    allHits: { r: number; c: number; y: number }[],
    seen: Set<string>,
    onProgress: (progress: number) => void
): Promise<number> {
    const origin = new THREE.Vector3();
    const downDir = new THREE.Vector3(0, -1, 0);

    // Each pass halves the cells, until a single grid cell
    const expectedPasses = Math.ceil(Math.log2(MACRO_CELL_MULTIPLIER)) + 1;

    let queue = macroCells;
    let pass = 0;
    let totalRays = 0;
    const maybeYield = createYielder();

    while (queue.length > 0) {
        const cellsThisPass = queue.length;
        console.log(`Pass ${pass} : ${cellsThisPass} rays`);
        console.time(`    pass ${pass}`);

        const nextQueue: typeof queue = [];
        let touched = 0;

        for (let i = 0; i < queue.length; i++) {
            await maybeYield(() => onProgress(Math.min((pass + i / queue.length) / expectedPasses, 1)));

            const { rowStart, rowEnd, colStart, colEnd } = queue[i];

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
 * @param scene Model to scan: pass the loaded model, not the whole scene, so helpers
 * (debug overlay, controllers...) are not raycast nor included in the bounds
 * @param config Parameters use during map creation
 * @param onProgress Called with progress in [0, 1] and the current step label
 */
export async function buildSceneMap(
    scene: THREE.Object3D,
    config: MinimapConfig,
    onProgress: BuildProgressCallback = () => { },
): Promise<{ map: SceneMap; histogram: HistogramBin[] }> {
    const {
        gridSize,
        minWalkableArea,
        normalThreshold,
        voxYThr,
        minFloorGap,
        histoHeightSize,
        minPeakArea,
        floorOpeningRadius,
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

    onProgress(0, 'Building BVH…');
    await yieldToBrowser();
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

    onProgress(0.05, 'Raycasting floors…');
    await yieldToBrowser();
    const totalRays = await adaptiveRaycastQueue(
        scene, raycaster, normalThreshold,
        min, gridSize, rayOriginY,
        macroCells, allHits, seen,
        p => onProgress(0.05 + p * 0.55, 'Raycasting floors…')
    );

    console.timeEnd('raycast total');
    console.log(`${totalRays} rayons tirés (vs ${totalCells} en brute force)`);
    console.log(`${allHits.length} hits horizontal on ${totalCells} cells`);
    console.groupEnd();

    // Histogram Y => pics = floors
    onProgress(0.6, 'Detecting floors…');
    await yieldToBrowser();
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
        onProgress(0.62 + (pi / peaks.length) * 0.13, 'Building walkable grids…');
        await yieldToBrowser();
        console.group(`    Peak ${pi} Y=${peak.centerY.toFixed(2)}m`);

        const peakHits = allHits.filter((_, idx) => hitPeakIndex[idx] === pi);

        const { walkable: rawWalkable } = buildWalkableGrid(
            peakHits, peak.centerY, voxYThr, minCells, rows, cols
        );

        // Opening by reconstruction: areas with nothing left after an opening by a disk are noise and removed,
        // the others are kept whole (corridors, doors, stairs intact); nothing left => the whole floor is noise
        const openingRadius = Math.round(floorOpeningRadius);
        const walkable = openingByReconstruction(rawWalkable, openingRadius);
        const bestComponent = largestComponent(walkable);

        if (bestComponent.length === 0) {
            console.log(`    Nothing left after opening (disk r=${openingRadius}) => noise, ignored`);
            console.groupEnd();
            continue;
        }

        // Bounds of what's left after the noise removal, not of the raw hits (noise included)
        let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
        walkable.forEach((row, r) => row.forEach((isWalkable, c) => {
            if (!isWalkable) return;
            cMin = Math.min(cMin, c); cMax = Math.max(cMax, c);
            rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
        }));
        const tMinX = min.x + cMin * gridSize;
        const tMaxX = min.x + (cMax + 1) * gridSize;
        const tMinZ = min.z + rMin * gridSize;
        const tMaxZ = min.z + (rMax + 1) * gridSize;

        const spawnPoint = pickSpawn(bestComponent, peak.centerY, min.x, min.z, gridSize);
        const walkableCount = walkable.flat().filter(Boolean).length;
        const rawCount = rawWalkable.flat().filter(Boolean).length;

        console.log(`    ${walkableCount} walkable cells (${rawCount - walkableCount} noise cells removed), component : ${bestComponent.length}`);
        console.log(`    Bounds XZ : X[${tMinX.toFixed(2)}, ${tMaxX.toFixed(2)}]  Z[${tMinZ.toFixed(2)}, ${tMaxZ.toFixed(2)}]`);
        console.log(`    Spawn : (${spawnPoint.x.toFixed(2)}, ${spawnPoint.y.toFixed(2)}, ${spawnPoint.z.toFixed(2)})`);
        console.groupEnd();

        rawLevels.push({
            id: rawLevels.length,
            floorY: peak.centerY,
            ceilingY: peaks[pi + 1]?.centerY ?? Infinity,
            walkable,
            walls: [], // populated in Step 4
            roomIds: [], // populated in Step 5
            rooms: [],
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
        const wallLabel = `Detecting walls (floor ${level.id + 1}/${levels.length})…`;
        level.walls = await buildWallGrid(
            scene, level.walkable, level.floorY, min, config,
            p => onProgress(0.75 + ((level.id + p) / levels.length) * 0.15, wallLabel)
        );
        level.walls = filterWallClusters(level.walls, 3);
        const wallCount = level.walls.flat().filter(v => v !== 0).length;
        console.log(`    Floor ${level.id}: ${wallCount} cells with wall(s)`);
        console.timeEnd(`    floor ${level.id}`);
    }

    console.timeEnd('walls');
    console.groupEnd();

    // Step 5 - Room segmentation
    console.group('Step 5 - Room segmentation');
    console.time('rooms');

    for (const level of levels) {
        onProgress(0.9 + (level.id / levels.length) * 0.05, 'Segmenting rooms…');
        await yieldToBrowser();
        const { roomIds, rooms } = segmentRooms(
            level.walkable, level.walls, gridSize, min.x, min.z, config
        );
        level.roomIds = roomIds;
        level.rooms = rooms;
        const corridorCount = rooms.filter(r => r.type === 'corridor').length;
        console.log(`    Floor ${level.id}: ${rooms.length - corridorCount} rooms, ${corridorCount} corridors`);
        rooms.forEach(r => console.log(
            `        ${r.type === 'corridor' ? 'Corridor' : 'Room'} ${r.id} : ${r.area.toFixed(1)}m², width ${r.width.toFixed(2)}m, elongation ${r.elongation.toFixed(1)}`
        ));
    }

    console.timeEnd('rooms');
    console.groupEnd();

    // Step 6 - Stair / ramp connectors between floors
    onProgress(0.95, 'Detecting stairs…');
    await yieldToBrowser();
    console.group('Step 6 - Stair connectors');
    console.time('stairs');
    console.log('Detecting stair connectors…');

    const connectors = await detectStairConnectors(
        allHits, levels, gridSize, config, scene, raycaster, min, rayOriginY,
        p => onProgress(0.95 + p * 0.05, 'Detecting stairs…')
    );

    console.log(`${connectors.length} connector(s) detected :`);
    connectors.forEach((c, i) => console.log(
        `    Connector ${i} : floor ${c.fromFloorId} <-> floor ${c.toFloorId}, ${c.cells.length} cells, Y[${c.entryY.toFixed(2)}, ${c.exitY.toFixed(2)}]`
    ));

    console.timeEnd('stairs');
    console.groupEnd();

    // Global bounds
    const globalMinX = Math.min(...levels.map(l => l.bounds.minX));
    const globalMaxX = Math.max(...levels.map(l => l.bounds.maxX));
    const globalMinZ = Math.min(...levels.map(l => l.bounds.minZ));
    const globalMaxZ = Math.max(...levels.map(l => l.bounds.maxZ));

    console.log(`${levels.length} floors.`);
    console.groupEnd();

    console.log('Map built !');
    onProgress(1, 'Done');

    const map: SceneMap = {
        version: CACHE_VERSION,
        modelSha1: null, // set by the caller, which loaded the model
        config: { ...config },
        sceneBounds: { sceneMinX: min.x, sceneMinZ: min.z },
        bounds: { minX: globalMinX, maxX: globalMaxX, minZ: globalMinZ, maxZ: globalMaxZ },
        cols: Math.ceil((globalMaxX - globalMinX) / gridSize),
        rows: Math.ceil((globalMaxZ - globalMinZ) / gridSize),
        gridSize,
        levels,
        connectors,
    };

    return { map, histogram: bins };
}
