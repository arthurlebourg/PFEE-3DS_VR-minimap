import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { CACHE_VERSION, type SceneMap, type FloorLevel, type MinimapConfig, type StairConnector } from './minimap.js';
import { buildWalkableGrid, pickSpawn, openingByReconstruction, largestComponent } from './minimapUtils.js';
import { segmentRooms } from './roomSegmentation.js';

// Globbing grid size = gridSize * factor
const MACRO_CELL_MULTIPLIER = 4;

// Below this rise, a climb is noise, not a stair
const MIN_CONNECTOR_RISE = 0.15;

/** Height (m) a stair flood may climb between two adjacent cells: the steepest slope over one cell */
function maxStepRise(config: MinimapConfig, gridSize: number): number {
    return gridSize * Math.tan(config.maxSlopeDeg * Math.PI / 180);
}

// Default max time spent computing before handing control back to the browser (repaint, input)
const DEFAULT_SLICE_MS = 30;

export type BuildProgressCallback = (progress: number, label: string) => void;

/**
 * @typedef BuildOptions
 * @prop signal aborting it stops the build at its next pause: buildSceneMap then rejects with the abort reason
 * @prop sliceMs max compute time (ms) between two pauses, read at each check: shorter keeps
 * the render loop smoother (VR) but makes the build slower
 */
export interface BuildOptions {
    signal?: AbortSignal;
    sliceMs?: () => number;
}

/**
 * Hands control back to the browser (repaint, input, render loop) during the build,
 * which is also where an aborted build stops
 */
interface BuildYielder {
    /** Pause now */
    yieldNow(): Promise<void>;
    /** To call often inside long loops: pauses at most every slice, reporting progress right before */
    maybeYield(reportProgress: () => void): Promise<void>;
}

function createYielder({ signal, sliceMs = () => DEFAULT_SLICE_MS }: BuildOptions): BuildYielder {
    let lastYield = performance.now();

    async function yieldNow(): Promise<void> {
        signal?.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 0));
        signal?.throwIfAborted();
        lastYield = performance.now();
    }

    return {
        yieldNow,
        async maybeYield(reportProgress) {
            if (performance.now() - lastYield < sliceMs()) return;
            reportProgress();
            await yieldNow();
        },
    };
}

// Extensions BVH, once when loading
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Build BVH on meshes in scene (once)
 */
export function ensureBoundsTrees(scene: THREE.Object3D): void {
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

/** A mesh with its world-space bounding box */
interface MeshBounds {
    mesh: THREE.Mesh;
    box: THREE.Box3;
}

/** What the rays are cast against: the meshes of the scanned model */
export type RayTargets = MeshBounds[];

/**
 * World-space bounding box of every mesh, once per build (the scene is static during the scan).
 * Casting against the whole scene costs a fixed ~2 ms per ray with a few hundred meshes (each one is asked,
 * BVH or not), whatever the ray length: see intersectTargets
 */
export function collectRayTargets(scene: THREE.Object3D): RayTargets {
    scene.updateMatrixWorld(true);
    const targets: RayTargets = [];
    scene.traverse(obj => {
        if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;

        const box = new THREE.Box3();
        if (obj instanceof THREE.InstancedMesh || obj instanceof THREE.SkinnedMesh) {
            // drawn outside of the geometry's own box: always a candidate
            box.set(new THREE.Vector3(-Infinity, -Infinity, -Infinity), new THREE.Vector3(Infinity, Infinity, Infinity));
        } else {
            if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
            box.copy(obj.geometry.boundingBox!).applyMatrix4(obj.matrixWorld).expandByScalar(1e-4); // flat meshes and rays grazing a face
        }
        targets.push({ mesh: obj, box });
    });
    return targets;
}

const _boxHit = new THREE.Vector3();
const _candidates: THREE.Object3D[] = [];

/**
 * Same hits as raycaster.intersectObject(scene, true), but only asks the meshes whose box the ray reaches
 * (within raycaster.far): a vertical ray crosses a few of them, a short horizontal one often a single one
 */
function intersectTargets(raycaster: THREE.Raycaster, targets: RayTargets): THREE.Intersection[] {
    const { ray, far } = raycaster;
    const farSq = far * far;

    _candidates.length = 0;
    for (const { mesh, box } of targets) {
        if (box.containsPoint(ray.origin)) {
            _candidates.push(mesh);
            continue;
        }
        const entry = ray.intersectBox(box, _boxHit);
        if (entry !== null && entry.distanceToSquared(ray.origin) <= farSq) _candidates.push(mesh);
    }
    return raycaster.intersectObjects(_candidates, false);
}

// static scene during scan
const normalMatrixCache = new WeakMap<THREE.Object3D, THREE.Matrix3>();
const _worldNormal = new THREE.Vector3();

/**
 * Sent a vertical ray and return Y hits (filtered normal)
 */
export function castDown(
    targets: RayTargets,
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
    const intersects = intersectTargets(raycaster, targets);

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
    targets: RayTargets,
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
    const intersects = intersectTargets(raycaster, targets);

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
 * @param targets Meshes to cast rays against
 * @param walkable Walkable grid for this floor level
 * @param floorY Y position of the floor
 * @param sceneMin Scene bounding box minimum (THREE.Vector3)
 * @param config MinimapConfig (wallScanHeight, wallNormalThreshold, wallRayLength, gridSize)
 * @param onProgress Called with progress in [0, 1]
 * @returns 2D grid of wall bitmasks (same dimensions as walkable)
 */
async function buildWallGrid(
    targets: RayTargets,
    walkable: boolean[][],
    floorY: number,
    sceneMin: THREE.Vector3,
    config: MinimapConfig,
    onProgress: (progress: number) => void,
    yielder: BuildYielder,
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

    for (let r = 0; r < rows; r++) {
        await yielder.maybeYield(() => onProgress(r / rows));
        for (let c = 0; c < cols; c++) {
            if (!walkable[r][c]) continue;

            const cx = sceneMin.x + (c + 0.5) * gridSize;
            const cz = sceneMin.z + (r + 0.5) * gridSize;

            let mask = 0;
            for (const { dx, dz, bit } of DIRS) {
                dirVec.set(dx, 0, dz);
                if (castHorizontal(targets, raycaster, origin, dirVec, wallNormalThreshold, wallRayLength, cx, scanY, cz)) {
                    mask |= bit;
                }
            }
            walls[r][c] = mask;
        }
    }

    return walls;
}

// Walls stop the stair flood and the bridge projection
const STAIR_FLOOD_USES_WALLS = false;

// A dead-end climb is projected in a straight line to the next floor (tryBridgeToNextFloor) and counted as landed there
const STAIR_BRIDGE_ENABLED = false;

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
    wallBetween: (r: number, c: number, dr: number, dc: number, scanY: number) => boolean,
    gridSize: number,
    wallScanHeight: number,
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

    let prevR = frontier.r, prevC = frontier.c;
    for (let y = frontier.y + BRIDGE_STEP_Y; y <= target.floorY + BRIDGE_OVERSHOOT; y += BRIDGE_STEP_Y) {
        const r = Math.round(frontier.r + slopeR * (y - frontier.y));
        const c = Math.round(frontier.c + slopeC * (y - frontier.y));

        // A wall on the way ends the projection
        const scanY = Math.max(y + gridSize, Math.min(y + wallScanHeight, target.floorY - gridSize));
        let walkR = prevR, walkC = prevC;
        while (walkR !== r || walkC !== c) {
            const dr = Math.sign(r - walkR);
            const dc = dr !== 0 ? 0 : Math.sign(c - walkC);
            if (wallBetween(walkR, walkC, dr, dc, scanY)) return null;
            walkR += dr;
            walkC += dc;
        }
        prevR = r;
        prevC = c;

        for (const [or_, oc] of BRIDGE_NEIGHBOURHOOD) {
            if (target.walkable[r + or_]?.[c + oc]) return target.id;
        }
    }
    return null;
}

/** A climb that was dropped, with what's needed to tell why (debug) */
interface RejectedClimb {
    reason: 'too small' | 'too large' | 'no rise';
    floorId: number;
    seed: { r: number; c: number };
    seedY: number;
    touchedFloorIds: number[];
    cells: { r: number; c: number; y: number }[];
    area: number;
    minY: number;
    maxY: number;
}

/** Summary of a rejected climb, in world units */
interface RejectedSummary {
    reason: RejectedClimb['reason'];
    floorId: number;
    cells: number;
    area: number;
    minY: number;
    maxY: number;
    x: number;
    z: number;
    seedX: number;
    seedZ: number;
    seedY: number;
    touchedFloorIds: number[];
}

/**
 * Properties of a set of grid cells, in world units (debug).
 * Slope of a cell = steepest drop to a neighbouring cell of the set, as an angle (a riser seen over one cell is steep,
 * a tread is flat: the mean over a staircase tells how steep it is overall)
 * @return positions [x, y, z] of the cell centers, size in m², slope in degrees per cell (same order)
 */
function describeCells(
    cells: { r: number; c: number; y: number }[],
    sceneMin: THREE.Vector3,
    gridSize: number,
): { positions: [number, number, number][]; sizeM2: number; slopesDeg: number[] } {
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const round2 = (v: number) => Math.round(v * 100) / 100;

    const yByKey = new Map<string, number>();
    for (const { r, c, y } of cells) yByKey.set(`${r}_${c}`, y);

    const positions = cells.map(({ r, c, y }): [number, number, number] => [
        round2(sceneMin.x + (c + 0.5) * gridSize), round2(y), round2(sceneMin.z + (r + 0.5) * gridSize),
    ]);
    const slopesDeg = cells.map(({ r, c, y }) => {
        let maxDy = 0;
        for (const [dr, dc] of DIRS) {
            const ny = yByKey.get(`${r + dr}_${c + dc}`);
            if (ny !== undefined) maxDy = Math.max(maxDy, Math.abs(ny - y));
        }
        return Math.round(Math.atan2(maxDy, gridSize) * 180 / Math.PI);
    });

    return { positions, sizeM2: cells.length * gridSize * gridSize, slopesDeg };
}

/**
 * Grows from a boundary cell of `sourceLevel`.
 * A neighbour is accepted only if its height sits within [-stairFlatTolerance, +gridSize * tan(maxSlopeDeg)] of the current cell.
 * No global slope, just a bounded step each time, so landings pass but a jump to furniture height doesn't.
 */
function climbFromSeed(
    seed: { r: number; c: number },
    sourceLevel: FloorLevel,
    heightNear: (r: number, c: number, fromY: number) => number | undefined,
    heightInBand: (r: number, c: number, floorY: number) => number | undefined,
    wallBetween: (r: number, c: number, dr: number, dc: number, scanY: number) => boolean,
    levels: FloorLevel[],
    claimedByThisFloor: Set<string>,
    gridSize: number,
    config: MinimapConfig,
    onReject?: (rejected: RejectedClimb) => void,
    startY?: number,
): StairConnector | null {
    const { stairFlatTolerance, maxLandingRun, minStairArea, maxStairArea, voxYThr, wallScanHeight } = config;
    const maxRise = maxStepRise(config, gridSize);
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    // The staircase ends on the next floor above: from the bottom of that floor's band, a surface is the arrival
    const nextLevel = levels
        .filter(l => l.floorY > sourceLevel.floorY)
        .sort((a, b) => a.floorY - b.floorY)[0];
    const arrivalY = nextLevel ? nextLevel.floorY - voxYThr : Infinity;

    const maxLandingCells = Math.ceil(maxLandingRun / gridSize);

    // Use the seed's actual measured height, not sourceLevel.floorY: the surface of the floor itself
    const seedY = startY
        ?? heightInBand(seed.r, seed.c, sourceLevel.floorY)
        ?? heightNear(seed.r, seed.c, sourceLevel.floorY)
        ?? sourceLevel.floorY;
    // The climb never goes down: nothing under where it started
    const lowestY = seedY - stairFlatTolerance;

    type Node = { r: number; c: number; y: number; flatRun: number };
    const climbQueue: Node[] = [{ r: seed.r, c: seed.c, y: seedY, flatRun: 0 }];
    const flatQueue: Node[] = [];
    const localVisited = new Set<string>();
    const queued = new Set<string>(); // marked when pushed, not when popped: a cell must not be pushed (and counted) twice
    const cells: { r: number; c: number; y: number }[] = [];
    const touchedFloorIds = new Set<number>();
    const arrivals: { r: number; c: number; y: number }[] = []; // first cells of the next floor's band the climb reached

    let node: Node | undefined;
    while ((node = climbQueue.shift() ?? flatQueue.shift())) {
        const key = `${node.r}_${node.c}`;
        if (localVisited.has(key)) continue;
        localVisited.add(key);

        for (const [dr, dc] of DIRS) {
            const nr = node.r + dr, nc = node.c + dc;
            const nKey = `${nr}_${nc}`;
            if (localVisited.has(nKey) || queued.has(nKey) || claimedByThisFloor.has(nKey)) continue;

            // Lowest surface ahead: a stair running under the slab of the next floor must be followed, not the slab
            const neighbourY = heightNear(nr, nc, node.y);
            if (neighbourY === undefined) continue; // no surface there at all
            if (neighbourY < lowestY) continue;
            const arrives = nextLevel !== undefined && neighbourY >= arrivalY;

            // The floor we depart from is not the staircase: its cells  are neither
            // crossed nor counted, or the flood wanders over the floor and inflates the area, the heights and the claims
            if (sourceLevel.walkable[nr]?.[nc] && Math.abs(neighbourY - sourceLevel.floorY) <= voxYThr) continue;

            const dy = neighbourY - node.y;
            if (dy < -stairFlatTolerance || dy > maxRise) continue; // too steep either way

            const isFlat = dy <= stairFlatTolerance;
            const flatRun = isFlat ? node.flatRun + 1 : 0;
            if (flatRun > maxLandingCells) continue; // wandered too far on a plateau — dead end

            // The flood does not go through a wall : the ray is cast above the stair surface
            // and under the slab of the next floor
            const scanY = Math.max(node.y + gridSize, Math.min(node.y + wallScanHeight, nextLevel ? nextLevel.floorY - gridSize : Infinity));
            if (wallBetween(node.r, node.c, dr, dc, scanY)) continue;

            if (arrives) {
                touchedFloorIds.add(nextLevel!.id);
                arrivals.push({ r: nr, c: nc, y: neighbourY });
                localVisited.add(nKey); // arrival cell — don't grow past it
                continue;
            }

            queued.add(nKey);
            cells.push({ r: nr, c: nc, y: neighbourY });
            (isFlat ? flatQueue : climbQueue).push({ r: nr, c: nc, y: neighbourY, flatRun });
        }
    }

    for (const { r, c } of cells) claimedByThisFloor.add(`${r}_${c}`);

    if (cells.length === 0) return null; // nothing climbed at all — not worth reporting

    const area = cells.length * gridSize * gridSize;

    // a climb leaking over a whole floor holds far more cells than the spread limit
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { y } of cells) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    const reject = (reason: RejectedClimb['reason']): null => {
        onReject?.({
            reason, floorId: sourceLevel.id, seed, seedY, touchedFloorIds: [...touchedFloorIds], cells, area, minY, maxY,
        });
        return null;
    };
    if (area < minStairArea) return reject('too small');
    if (area > maxStairArea) return reject('too large');

    // Require real climbed height
    let climbedY = maxY - minY;
    if (touchedFloorIds.size === 1) {
        const landing = levels.find(l => l.id === [...touchedFloorIds][0]);
        if (landing) climbedY = Math.max(climbedY, Math.abs(landing.floorY - seedY));
    }
    if (climbedY < MIN_CONNECTOR_RISE) return reject('no rise');

    // Resolved = landed on exactly one floor.
    // A pure dead end gets one more chance via tryBridgeToNextFloor.
    // An already-ambiguous climb is left alone.
    // Still-unresolved is reported, not dropped.
    let resolved = touchedFloorIds.size === 1;
    let bridged = false;
    let toFloorId = resolved ? [...touchedFloorIds][0] : null;

    if (STAIR_BRIDGE_ENABLED && !resolved && touchedFloorIds.size === 0) {
        const bridgedFloorId = tryBridgeToNextFloor(seed, seedY, cells, sourceLevel, levels, wallBetween, gridSize, wallScanHeight);
        if (bridgedFloorId !== null) {
            resolved = true;
            bridged = true;
            toFloorId = bridgedFloorId;
        }
    }

    // Anchors: the cell the climb departs from and the ones it arrives on
    const anchors = [{ r: seed.r, c: seed.c, y: seedY }, ...arrivals];
    let exitY = maxY;
    for (const { y } of arrivals) if (y > exitY) exitY = y;

    return {
        fromFloorId: sourceLevel.id,
        toFloorId,
        resolved,
        bridged,
        cells: [...cells, ...anchors],
        entryY: Math.min(minY, seedY),
        exitY,
        entryCells: [{ r: seed.r, c: seed.c, y: seedY }],
        exitCells: arrivals,
    };
}

// Two connectors closer than this (m) are pieces of the same staircase
const STAIR_MERGE_DISTANCE = 0.3;

/**
 * Merge the connectors that are pieces of the same staircase
 *  - same floor of departure: the several entrances of a staircase (the flood of the first claims the cells,
 *    the next one stops at them and ends as a stub);
 *  - or an unresolved one departing from the floor where the other lands
 * Two connectors landing on different floors are never merged.
 */
function mergeConnectors(connectors: StairConnector[], levels: FloorLevel[], gridSize: number): StairConnector[] {
    const reach = Math.max(1, Math.round(STAIR_MERGE_DISTANCE / gridSize));

    const parent = connectors.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    // per group root: where it departs and where it lands
    const info = connectors.map(conn => ({ from: conn.fromFloorId, to: conn.resolved ? conn.toFloorId : null }));

    const compatible = (p: { from: number; to: number | null }, q: { from: number; to: number | null }): boolean => {
        if (p.to !== null && q.to !== null) return p.from === q.from && p.to === q.to;
        if (p.to !== null) return q.from === p.from || q.from === p.to;
        if (q.to !== null) return p.from === q.from || p.from === q.to;
        return p.from === q.from;
    };

    const owners = new Map<string, number[]>();
    connectors.forEach((conn, i) => {
        for (const { r, c } of conn.cells) {
            const key = `${r}_${c}`;
            const list = owners.get(key);
            if (list) list.push(i); else owners.set(key, [i]);
        }
    });

    connectors.forEach((conn, i) => {
        for (const { r, c } of conn.cells) {
            for (let dr = -reach; dr <= reach; dr++) {
                for (let dc = -reach; dc <= reach; dc++) {
                    for (const j of owners.get(`${r + dr}_${c + dc}`) ?? []) {
                        const a = find(i), b = find(j);
                        if (a === b || !compatible(info[a], info[b])) continue;

                        // The group that lands keeps its floors; the other is its stub or its top part
                        const lander = info[a].to !== null ? info[a] : info[b];
                        parent[a] = b;
                        info[b] = info[a].to !== null || info[b].to !== null
                            ? { from: lander.from, to: lander.to }
                            : { from: info[b].from, to: null };
                    }
                }
            }
        }
    });

    const groups = new Map<number, StairConnector[]>();
    connectors.forEach((conn, i) => {
        const root = find(i);
        const group = groups.get(root);
        if (group) group.push(conn); else groups.set(root, [conn]);
    });

    return [...groups.entries()].map(([root, group]) => {
        if (group.length === 1) return group[0];

        const { from, to } = info[root];
        const topLevel = to !== null ? levels.find(l => l.id === to) : undefined;

        // Resolved connectors first: their cells are the ones kept when a cell is seen twice
        const ordered = [...group].sort((x, y) => Number(y.resolved) - Number(x.resolved));
        const cells = new Map<string, { r: number; c: number; y: number }>();
        for (const conn of ordered) {
            const isTopPart = to !== null && conn.fromFloorId === to && conn.fromFloorId !== from;
            for (const cell of conn.cells) {
                if (isTopPart && topLevel?.walkable[cell.r]?.[cell.c]) continue;
                const key = `${cell.r}_${cell.c}`;
                if (!cells.has(key)) cells.set(key, cell);
            }
        }
        const merged = [...cells.values()];
        let minY = Infinity, maxY = -Infinity;
        for (const { y } of merged) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }

        // Where it starts and where it arrives. The edge cells of an absorbed top part are on the arrival floor
        const entryCells = new Map<string, { r: number; c: number; y: number }>();
        const exitCells = new Map<string, { r: number; c: number; y: number }>();
        for (const conn of ordered) {
            const isTopPart = to !== null && conn.fromFloorId === to && conn.fromFloorId !== from;
            for (const cell of conn.entryCells ?? []) (isTopPart ? exitCells : entryCells).set(`${cell.r}_${cell.c}`, cell);
            if (!isTopPart) for (const cell of conn.exitCells ?? []) exitCells.set(`${cell.r}_${cell.c}`, cell);
        }

        const landed = group.filter(conn => conn.resolved);
        return {
            fromFloorId: from,
            toFloorId: to,
            resolved: to !== null,
            bridged: landed.length > 0 && landed.every(conn => conn.bridged), // one real landing is enough to be confirmed
            cells: merged,
            entryY: minY,
            exitY: maxY,
            entryCells: [...entryCells.values()],
            exitCells: [...exitCells.values()],
        };
    });
}

/**
 * Detect stair connectors by climbing outward from each floor's edge
 *
 * @param allHits every raw hit from the downward raycast pass
 * @param levels finalized floor levels (post sub-level merge)
 * @param gridSize size of a cell
 * @param config maxSlopeDeg / stairFlatTolerance / maxLandingRun / minStairArea / maxStairArea
 * @param targets meshes rays against
 * @param raycaster reused raycaster instance
 * @param sceneMin scene bounding-box min, to convert back to world
 * @param rayOriginY Y to fire catch-up rays down from
 * @param onProgress Called with progress in [0, 1]
 * @param yielder pauses of the build
 */
async function detectStairConnectors(
    allHits: { r: number; c: number; y: number }[],
    levels: FloorLevel[],
    gridSize: number,
    config: MinimapConfig,
    targets: RayTargets,
    raycaster: THREE.Raycaster,
    sceneMin: THREE.Vector3,
    rayOriginY: number,
    onProgress: (progress: number) => void,
    yielder: BuildYielder,
): Promise<{ connectors: StairConnector[]; rejected: RejectedSummary[] }> {
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
                    targets, raycaster, fallbackOrigin, fallbackDown, config.normalThreshold,
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

    // The surface of a floor in a cell: the hit inside the floor's band closest to its Y
    function heightInBand(r: number, c: number, floorY: number): number | undefined {
        const arr = cellYs.get(`${r}_${c}`);
        if (!arr) return undefined;

        let best: number | undefined;
        for (const y of arr) {
            if (Math.abs(y - floorY) > config.voxYThr) continue;
            if (best === undefined || Math.abs(y - floorY) < Math.abs(best - floorY)) best = y;
        }
        return best;
    }

    // Is there a wall between a cell and its neighbour? Horizontal ray from the cell center to the neighbour's,
    // same test as the floors' wall grid. Asked once per edge
    const wallRaycaster = new THREE.Raycaster();
    wallRaycaster.far = gridSize + 0.01;
    wallRaycaster.firstHitOnly = false;
    const wallOrigin = new THREE.Vector3();
    const wallDir = new THREE.Vector3();
    const wallCache = new Map<string, boolean>();
    let wallRays = 0;
    let wallBlocked = 0;

    function wallBetween(r: number, c: number, dr: number, dc: number, scanY: number): boolean {
        if (!STAIR_FLOOD_USES_WALLS) return false;

        // same edge from both sides: one ray
        const from = `${r}_${c}`, to = `${r + dr}_${c + dc}`;
        const key = from < to ? `${from}|${to}` : `${to}|${from}`;
        const cached = wallCache.get(key);
        if (cached !== undefined) return cached;

        wallRays++;
        wallDir.set(dc, 0, dr); // columns X, rows Z
        const blocked = castHorizontal(
            targets, wallRaycaster, wallOrigin, wallDir, config.wallNormalThreshold, gridSize,
            sceneMin.x + (c + 0.5) * gridSize, scanY, sceneMin.z + (r + 0.5) * gridSize,
        );
        if (blocked) wallBlocked++;
        wallCache.set(key, blocked);
        return blocked;
    }

    const connectors: StairConnector[] = [];
    const rejected: RejectedSummary[] = [];
    const onReject = (climb: RejectedClimb) => {
        let sumR = 0, sumC = 0;
        for (const { r, c } of climb.cells) { sumR += r; sumC += c; }
        const n = climb.cells.length;
        rejected.push({
            reason: climb.reason,
            floorId: climb.floorId,
            cells: n,
            area: climb.area,
            minY: climb.minY,
            maxY: climb.maxY,
            x: sceneMin.x + (sumC / n + 0.5) * gridSize,
            z: sceneMin.z + (sumR / n + 0.5) * gridSize,
            seedX: sceneMin.x + (climb.seed.c + 0.5) * gridSize,
            seedZ: sceneMin.z + (climb.seed.r + 0.5) * gridSize,
            seedY: climb.seedY,
            touchedFloorIds: climb.touchedFloorIds,
        });
    };

    for (const [li, level] of levels.entries()) {
        const rows = level.walkable.length;
        const cols = level.walkable[0]?.length ?? 0;

        // Scoped per source floor: a spiral can revisit the same (r,c) at a higher Y on its way up
        const claimedByThisFloor = new Set<string>();
        let boundarySeeds = 0;

        // candidate stair entrances
        for (let r = 0; r < rows; r++) {
            await yielder.maybeYield(() => onProgress((li + r / rows) / levels.length));
            for (let c = 0; c < cols; c++) {
                if (!level.walkable[r][c]) continue;
                const isBoundary = DIRS.some(([dr, dc]) => !level.walkable[r + dr]?.[c + dc]);
                if (!isBoundary) continue;

                const connector = climbFromSeed({ r, c }, level, heightNear, heightInBand, wallBetween, levels, claimedByThisFloor, gridSize, config, onReject);
                if (connector) connectors.push(connector);
                boundarySeeds++;
            }
        }

        // Rise seeds: a stair standing over the floor has no boundary cell, its cells are walkable on the floor.
        // Any floor cell with a surface just above the floor's band, within one step of it, starts a climb from that surface.
        // The climb is the strict part: it never goes down
        const riseFloor = level.floorY + config.voxYThr;
        const riseCeil = riseFloor + maxStepRise(config, gridSize);
        let riseSeeds = 0;
        for (let r = 0; r < rows; r++) {
            await yielder.maybeYield(() => onProgress((li + r / rows) / levels.length));
            for (let c = 0; c < cols; c++) {
                if (!level.walkable[r][c] || claimedByThisFloor.has(`${r}_${c}`)) continue;

                let startY: number | undefined;
                for (const y of cellYs.get(`${r}_${c}`) ?? []) {
                    if (y > riseFloor && y <= riseCeil && (startY === undefined || y < startY)) startY = y;
                }
                if (startY === undefined) continue;

                riseSeeds++;
                const connector = climbFromSeed({ r, c }, level, heightNear, heightInBand, wallBetween, levels, claimedByThisFloor, gridSize, config, onReject, startY);
                if (connector) connectors.push(connector);
            }
        }
        console.log(`    Floor ${level.id} : ${boundarySeeds} boundary seeds, ${riseSeeds} rise seeds`);
    }

    if (STAIR_FLOOD_USES_WALLS) console.log(`    Walls : ${wallRays} edges checked, ${wallBlocked} blocked the flood`);
    return { connectors: mergeConnectors(connectors, levels, gridSize), rejected };
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

    // Loop, spreading a few hundred thousand hits overflows the call stack
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { y } of hits) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
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
    targets: RayTargets,
    raycaster: THREE.Raycaster,
    normalThreshold: number,
    min: THREE.Vector3,
    gridSize: number,
    rayOriginY: number,
    macroCells: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }[],
    allHits: { r: number; c: number; y: number }[],
    seen: Set<string>,
    onProgress: (progress: number) => void,
    yielder: BuildYielder,
): Promise<number> {
    const origin = new THREE.Vector3();
    const downDir = new THREE.Vector3(0, -1, 0);

    // Each pass halves the cells, until a single grid cell
    const expectedPasses = Math.ceil(Math.log2(MACRO_CELL_MULTIPLIER)) + 1;

    let queue = macroCells;
    let pass = 0;
    let totalRays = 0;

    while (queue.length > 0) {
        const cellsThisPass = queue.length;
        console.log(`Pass ${pass} : ${cellsThisPass} rays`);
        console.time(`    pass ${pass}`);

        const nextQueue: typeof queue = [];
        let touched = 0;

        for (let i = 0; i < queue.length; i++) {
            await yielder.maybeYield(() => onProgress(Math.min((pass + i / queue.length) / expectedPasses, 1)));

            const { rowStart, rowEnd, colStart, colEnd } = queue[i];

            const x0 = min.x + colStart * gridSize;
            const x1 = min.x + colEnd * gridSize;
            const z0 = min.z + rowStart * gridSize;
            const z1 = min.z + rowEnd * gridSize;
            const cx = (x0 + x1) / 2;
            const cz = (z0 + z1) / 2;

            totalRays++;
            const ys = castDown(targets, raycaster, origin, downDir, normalThreshold, cx, cz, rayOriginY);
            let hit = ys.length > 0;

            const isLeaf = (rowEnd - rowStart) <= 1 && (colEnd - colStart) <= 1;

            // Center missed: try the centers of the 4 corner cells before dropping the square,
            // e.g. a square straddling an outer wall has its center outside but floor on the inside
            if (!hit && !isLeaf) {
                const cornerXs = [min.x + (colStart + 0.5) * gridSize, min.x + (colEnd - 0.5) * gridSize];
                const cornerZs = [min.z + (rowStart + 0.5) * gridSize, min.z + (rowEnd - 0.5) * gridSize];
                corners: for (const x of cornerXs) {
                    for (const z of cornerZs) {
                        totalRays++;
                        hit = castDown(targets, raycaster, origin, downDir, normalThreshold, x, z, rayOriginY).length > 0;
                        if (hit) break corners;
                    }
                }
            }

            // empty square
            if (!hit) continue;

            touched++;

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
 * @param options abort signal, pause frequency
 */
export async function buildSceneMap(
    scene: THREE.Object3D,
    config: MinimapConfig,
    onProgress: BuildProgressCallback = () => { },
    options: BuildOptions = {},
): Promise<{ map: SceneMap; histogram: HistogramBin[] }> {
    try {
        return await runBuildSteps(scene, config, onProgress, createYielder(options));
    } catch (e) {
        // close the console groups (map + step) left open by the interrupted step, extra calls are no-ops
        console.groupEnd();
        console.groupEnd();
        throw e;
    }
}

async function runBuildSteps(
    scene: THREE.Object3D,
    config: MinimapConfig,
    onProgress: BuildProgressCallback,
    yielder: BuildYielder,
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
    await yielder.yieldNow();
    console.time('BVH build');
    ensureBoundsTrees(scene);
    console.timeEnd('BVH build');
    const targets = collectRayTargets(scene);
    console.log(`Rays are cast against ${targets.length} mesh boxes`);

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
    await yielder.yieldNow();
    const totalRays = await adaptiveRaycastQueue(
        targets, raycaster, normalThreshold,
        min, gridSize, rayOriginY,
        macroCells, allHits, seen,
        p => onProgress(0.05 + p * 0.55, 'Raycasting floors…'),
        yielder,
    );

    console.timeEnd('raycast total');
    console.log(`${totalRays} rayons tirés (vs ${totalCells} en brute force)`);
    console.log(`${allHits.length} hits horizontal on ${totalCells} cells`);
    console.groupEnd();

    // Histogram Y => pics = floors
    onProgress(0.6, 'Detecting floors…');
    await yielder.yieldNow();
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
        await yielder.yieldNow();
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

    // Merge close levels. Within a group of close peaks the one with the most walkable cells is the floor, the others are its sub-levels
    const countCells = (grid: boolean[][]) => grid.reduce((n, row) => n + row.filter(Boolean).length, 0);
    const cellCounts = new Map<FloorLevel, number>(rawLevels.map(l => [l, countCells(l.walkable)]));
    const biggest = (group: FloorLevel[]) => group.reduce((best, l) => (cellCounts.get(l)! > cellCounts.get(best)! ? l : best));

    const groups: FloorLevel[][] = [];
    for (const level of rawLevels) {
        const group = groups[groups.length - 1];
        if (group && level.floorY - biggest(group).floorY < minFloorGap) group.push(level);
        else groups.push([level]);
    }

    const levels: FloorLevel[] = [];
    for (const group of groups) {
        const main = biggest(group);
        for (const sub of group) {
            if (sub === main) continue;
            console.log(
                `    Merge Y=${sub.floorY.toFixed(2)} (${cellCounts.get(sub)} cells) => sub-level of Y=${main.floorY.toFixed(2)}` +
                ` (${cellCounts.get(main)} cells) (gap=${Math.abs(sub.floorY - main.floorY).toFixed(2)}m < ${minFloorGap}m)`
            );
            main.subLevels.push({
                deltaY: sub.floorY - main.floorY,
                absoluteY: sub.floorY,
                walkable: sub.walkable,
            });
        }
        levels.push({ ...main, id: levels.length });
    }

    // Step 4 - Wall detection
    console.group('Step 4 - Wall detection');
    console.time('walls');
    console.log('Building wall grids…');

    for (const level of levels) {
        console.time(`    floor ${level.id}`);
        const wallLabel = `Detecting walls (floor ${level.id + 1}/${levels.length})…`;
        level.walls = await buildWallGrid(
            targets, level.walkable, level.floorY, min, config,
            p => onProgress(0.75 + ((level.id + p) / levels.length) * 0.15, wallLabel),
            yielder,
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
        await yielder.yieldNow();
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
    await yielder.yieldNow();
    console.group('Step 6 - Stair connectors');
    console.time('stairs');
    console.log(
        `Detecting stair connectors… (slope up to ${config.maxSlopeDeg}° => ${maxStepRise(config, gridSize).toFixed(2)} m` +
        ` per ${gridSize} m cell)`
    );

    // `rejected` (the dropped climbs) is also returned
    const { connectors } = await detectStairConnectors(
        allHits, levels, gridSize, config, targets, raycaster, min, rayOriginY,
        p => onProgress(0.95 + p * 0.05, 'Detecting stairs…'),
        yielder,
    );

    console.log(`${connectors.length} connector(s) detected :`);
    connectors.forEach((c, i) => {
        const { sizeM2, slopesDeg } = describeCells(c.cells, min, gridSize);
        const meanSlope = slopesDeg.reduce((sum, v) => sum + v, 0) / Math.max(1, slopesDeg.length);
        const state = !c.resolved ? 'unresolved' : c.bridged ? 'bridged' : 'resolved';
        console.log(
            `    Connector ${i} : floor ${c.fromFloorId} <-> floor ${c.toFloorId} (${state}), ${c.cells.length} cells, ${sizeM2.toFixed(2)} m²,` +
            ` Y[${c.entryY.toFixed(2)}, ${c.exitY.toFixed(2)}], slope mean ${meanSlope.toFixed(0)}° max ${Math.max(0, ...slopesDeg)}°`
        );
    });

    // Dropped climbs (too small / too large / no rise): the near-misses tell which parameter to loosen.
    // Commented out: uncomment, and take `rejected` from detectStairConnectors above, to debug
    // const byReason = (reason: RejectedSummary['reason']) => rejected.filter(r => r.reason === reason).length;
    // console.log(
    //     `${rejected.length} climb(s) rejected : ${byReason('too small')} too small (< ${config.minStairArea} m²), ` +
    //     `${byReason('too large')} too large (> ${config.maxStairArea} m²), ${byReason('no rise')} no rise (< ${MIN_CONNECTOR_RISE} m)`
    // );
    // // Grouped by place then by floor, so the flights of a stairwell (same x, z on several floors) come out together
    // const MIN_LISTED_CELLS = 8;
    // const listed = rejected.filter(r => r.cells >= MIN_LISTED_CELLS).sort((a, b) =>
    //     Math.round(a.x / 0.5) - Math.round(b.x / 0.5) || Math.round(a.z / 0.5) - Math.round(b.z / 0.5) || a.floorId - b.floorId
    // );
    // console.log(`    ${listed.length} of them with at least ${MIN_LISTED_CELLS} cells, by place then floor :`);
    // listed.forEach(r => console.log(
    //     `    ${r.reason} : floor ${r.floorId}, ${r.cells} cells, ${r.area.toFixed(2)} m², Y[${r.minY.toFixed(2)}, ${r.maxY.toFixed(2)}]` +
    //     ` around (${r.x.toFixed(2)}, ${r.z.toFixed(2)}), from (${r.seedX.toFixed(2)}, ${r.seedY.toFixed(2)}, ${r.seedZ.toFixed(2)})` +
    //     `, landed on ${r.touchedFloorIds.length > 0 ? 'floor ' + r.touchedFloorIds.join(', ') : 'nothing'}`
    // ));

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
