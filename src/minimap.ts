import * as THREE from 'three';
import type {FloorManagerState} from './floorManager.js';

const CACHE_VERSION = 4;

// Types

export interface SubLevel {
    deltaY: number;        // floorY of next floor
    absoluteY: number;
    walkable: boolean[][];
}

export interface FloorLevel {
    id: number;
    floorY: number;
    ceilingY: number;
    walkable: boolean[][];
    subLevels: SubLevel[];
    spawnPoint: { x: number; y: number; z: number };
}

export interface SceneMap {
    version: number;
    modelPath: string;
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    cols: number;
    rows: number;
    gridSize: number;
    levels: FloorLevel[];
}

export interface MinimapConfig {
    gridSize?: number;
    minWalkableArea?: number;
    normalThreshold?: number;
    raycastHeight?: number;
    clusterTolerance?: number;
    minFloorGap?: number;        // min gap between two floor
}

// Helpers

function clusterByY(
    values: number[],
    tolerance: number
): { avgY: number; values: number[] }[] {
    if (values.length === 0) return [];

    const sorted = [...values].sort((a, b) => a - b);
    const clusters: { avgY: number; values: number[] }[] = [];
    let current: number[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] < tolerance) {
            current.push(sorted[i]);
        } else {
            const avg = current.reduce((a, b) => a + b, 0) / current.length;
            clusters.push({ avgY: avg, values: current });
            current = [sorted[i]];
        }
    }
    const avg = current.reduce((a, b) => a + b, 0) / current.length;
    clusters.push({ avgY: avg, values: current });

    return clusters;
}

function buildWalkableGrid(
    allHits: { r: number; c: number; y: number }[],
    targetY: number,
    tolerance: number,
    rows: number,
    cols: number,
    minCells: number
): { walkable: boolean[][]; bestComponent: [number, number][] } {
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const half = tolerance / 2;

    const raw: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
    for (const hit of allHits) {
        if (Math.abs(hit.y - targetY) <= half) {
            raw[hit.r][hit.c] = true;
        }
    }

    const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const walkable = Array.from({ length: rows }, () => new Array(cols).fill(false));
    let bestComponent: [number, number][] = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!raw[r][c] || visited[r][c]) continue;

            const cells: [number, number][] = [];
            const queue: [number, number][] = [[r, c]];
            visited[r][c] = true;

            while (queue.length > 0) {
                const [cr, cc] = queue.shift()!;
                cells.push([cr, cc]);
                for (const [dr, dc] of DIRS) {
                    const nr = cr + dr, nc = cc + dc;
                    if (
                        nr >= 0 && nr < rows &&
                        nc >= 0 && nc < cols &&
                        raw[nr][nc] && !visited[nr][nc]
                    ) {
                        visited[nr][nc] = true;
                        queue.push([nr, nc]);
                    }
                }
            }

            if (cells.length >= minCells) {
                for (const [cr, cc] of cells) walkable[cr][cc] = true;
                if (cells.length > bestComponent.length) bestComponent = cells;
            }
        }
    }

    return { walkable, bestComponent };
}

function pickSpawn(
    bestComponent: [number, number][],
    floorY: number,
    minX: number,
    minZ: number,
    gridSize: number
): { x: number; y: number; z: number } {
    const mid = bestComponent[Math.floor(bestComponent.length / 2)];
    return mid
        ? {
            x: minX + (mid[1] + 0.5) * gridSize,
            y: floorY + 1.6,
            z: minZ + (mid[0] + 0.5) * gridSize,
        }
        : { x: minX, y: floorY + 1.6, z: minZ };
}

// Build

export function buildSceneMap(
    scene: THREE.Scene,
    modelPath: string,
    config: MinimapConfig = {}
): SceneMap {
    const {
        gridSize = 0.25,
        minWalkableArea = 1.0,
        normalThreshold = 0.7,
        raycastHeight = 50,
        clusterTolerance = 0.15,
        minFloorGap = 1.8,
    } = config;

    const box = new THREE.Box3().setFromObject(scene);
    const { min, max } = box;
    const cols = Math.ceil((max.x - min.x) / gridSize);
    const rows = Math.ceil((max.z - min.z) / gridSize);
    const totalCells = rows * cols;
    const minCells = Math.ceil(minWalkableArea / (gridSize * gridSize));

    console.group('buildSceneMap');
    console.log(`Grille : ${cols}×${rows} = ${totalCells} cellules  (gridSize=${gridSize}m)`);
    console.log(`Bounds : X[${min.x.toFixed(2)}, ${max.x.toFixed(2)}]  Z[${min.z.toFixed(2)}, ${max.z.toFixed(2)}]`);

    // Raycasting
    console.group('Passe 1 - Raycasting');
    console.time('raycasting');

    const raycaster = new THREE.Raycaster();
    const downDir = new THREE.Vector3(0, -1, 0);
    const normalMat = new THREE.Matrix3();
    const allHits: { r: number; c: number; y: number }[] = [];

    const logStep = Math.max(1, Math.floor(totalCells / 20)); // log tous les 5%
    let lastPct = 0;

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cellIdx = r * cols + c;
            const pct = Math.floor((cellIdx / totalCells) * 100);

            if (pct !== lastPct && cellIdx % logStep === 0) {
                console.log(`  ${pct}%  (${cellIdx}/${totalCells} cellules, ${allHits.length} hits)`);
                lastPct = pct;
            }

            const x = min.x + (c + 0.5) * gridSize;
            const z = min.z + (r + 0.5) * gridSize;

            raycaster.set(new THREE.Vector3(x, raycastHeight, z), downDir);
            const hits = raycaster.intersectObject(scene, true);

            for (const hit of hits) {
                if (!hit.face) continue;
                normalMat.getNormalMatrix(hit.object.matrixWorld);
                const worldNormal = hit.face.normal
                    .clone()
                    .applyMatrix3(normalMat)
                    .normalize();
                if (worldNormal.y > normalThreshold) {
                    allHits.push({ r, c, y: hit.point.y });
                }
            }
        }
    }

    console.timeEnd('raycasting');
    console.log(`Total hits horizontaux : ${allHits.length}`);
    console.groupEnd();

    // Clustering Y
    console.group('Passe 2 - Clustering fin des surfaces');
    console.time('clustering-fin');

    const rawClusters = clusterByY(allHits.map(h => h.y), clusterTolerance);
    console.log(`${rawClusters.length} surfaces détectées (tolerance=${clusterTolerance}m)`);
    rawClusters.forEach((c, i) =>
        console.log(`  Surface ${i} : Y=${c.avgY.toFixed(3)}m  (${c.values.length} pts)`)
    );

    console.timeEnd('clustering-fin');
    console.groupEnd();

    // group by minFloorGap
    console.group('Passe 3 - Groupement en étages');
    console.time('groupement-etages');

    type FloorGroup = { mainY: number; subYs: number[] };
    const floorGroups: FloorGroup[] = [];

    for (const cluster of rawClusters) {
        const last = floorGroups[floorGroups.length - 1];
        if (!last || cluster.avgY - last.mainY >= minFloorGap) {
            floorGroups.push({ mainY: cluster.avgY, subYs: [] });
        } else {
            last.subYs.push(cluster.avgY);
        }
    }

    console.log(`${floorGroups.length} étages détectés (minFloorGap=${minFloorGap}m)`);
    floorGroups.forEach((g, i) =>
        console.log(
            `  Étage ${i} : floorY=${g.mainY.toFixed(3)}m` +
            (g.subYs.length ? `  sous-niveaux=[${g.subYs.map(y => y.toFixed(2)).join(', ')}]` : '')
        )
    );

    console.timeEnd('groupement-etages');
    console.groupEnd();

    // walkable grid + flood fill
    console.group('Passe 4 - Grilles walkable + flood fill');
    console.time('walkable');

    const levels: FloorLevel[] = floorGroups.map((group, idx) => {
        console.log(`  Étage ${idx} (Y=${group.mainY.toFixed(2)}m)…`);

        const ceilingY = floorGroups[idx + 1]?.mainY ?? Infinity;

        // Niveau principal
        const { walkable, bestComponent } = buildWalkableGrid(
            allHits, group.mainY, clusterTolerance, rows, cols, minCells
        );
        const spawnPoint = pickSpawn(bestComponent, group.mainY, min.x, min.z, gridSize);

        const walkableCount = walkable.flat().filter(Boolean).length;
        console.log(`    Principal : ${walkableCount} cellules marchables, spawn=(${spawnPoint.x.toFixed(2)}, ${spawnPoint.z.toFixed(2)})`);

        // Sous-niveaux
        const subLevels: SubLevel[] = group.subYs.map(subY => {
            const { walkable: subWalkable } = buildWalkableGrid(
                allHits, subY, clusterTolerance, rows, cols, minCells
            );
            const subCount = subWalkable.flat().filter(Boolean).length;
            console.log(`    Sous-niveau Y=${subY.toFixed(2)}m : ${subCount} cellules`);
            return {
                deltaY: subY - group.mainY,
                absoluteY: subY,
                walkable: subWalkable,
            };
        });

        return {
            id: idx,
            floorY: group.mainY,
            ceilingY,
            walkable,
            subLevels,
            spawnPoint,
        };
    });

    console.timeEnd('walkable');
    console.groupEnd();

    console.log('buildSceneMap terminé');
    console.groupEnd();

    return {
        version: CACHE_VERSION,
        modelPath,
        bounds: { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z },
        cols,
        rows,
        gridSize,
        levels,
    };
}

// Save floor mapping

const storageKey = (path: string) => `sceneMap:${path}`;
const InfToJson = (_: string, v: unknown) => (v === Infinity ? '__INF__' : v);
const JsonToInf = (_: string, v: unknown) => (v === '__INF__' ? Infinity : v);

export function saveSceneMap(map: SceneMap): void {
    try {
        localStorage.setItem(storageKey(map.modelPath), JSON.stringify(map, InfToJson));
    } catch (e) {
        console.warn('SceneMap: impossible de sauvegarder (quota ?)', e);
    }
}

export function loadSceneMap(modelPath: string): SceneMap | null {
    try {
        const raw = localStorage.getItem(storageKey(modelPath));
        if (!raw) return null;
        const map = JSON.parse(raw, JsonToInf) as SceneMap;
        if (map.version !== CACHE_VERSION) {
            localStorage.removeItem(storageKey(modelPath));
            console.log('SceneMap: cache obsolète, reconstruction nécessaire');
            return null;
        }
        console.log(`SceneMap: cache chargé (${map.levels.length} étage(s))`);
        return map;
    } catch {
        return null;
    }
}

// Render Minimap

export function renderMinimap(
    map: SceneMap,
    floor: FloorLevel,
    playerPos: THREE.Vector3,
    playerDir: THREE.Vector3,
    canvas: HTMLCanvasElement,
    canvasSize = 256,
    floorState?: FloorManagerState
): void {
    const ctx = canvas.getContext('2d')!;
    canvas.width = canvas.height = canvasSize;

    const { bounds: { minX, maxX, minZ, maxZ }, cols, rows } = map;
    const cellW = canvasSize / cols;
    const cellH = canvasSize / rows;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    const mapAlpha = floorState?.triggerHeld ? '0.35' : '0.85';

    // Niveau principal
    ctx.fillStyle = `rgba(80, 180, 120, ${mapAlpha})`;
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (floor.walkable[r][c])
                ctx.fillRect(c * cellW, r * cellH, cellW, cellH);

    // Sous-niveaux en teinte différente
    ctx.fillStyle = `rgba(80, 140, 220, ${mapAlpha})`;
    for (const sub of floor.subLevels)
        for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
                if (sub.walkable[r][c])
                    ctx.fillRect(c * cellW, r * cellH, cellW, cellH);

    // Overlay sélection d'étage
    if (floorState?.triggerHeld) {
        const totalFloors = map.levels.length;
        const cx = canvasSize / 2;
        const panelH = totalFloors * 28 + 48;

        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.roundRect(cx - 70, canvasSize / 2 - panelH / 2, 140, panelH, 8);
        ctx.fill();

        map.levels.forEach((lvl, idx) => {
            const isPreview = idx === floorState.prevFloorIdx;
            const isCurrent = idx === floorState.curFloorIdx;
            const y = canvasSize / 2 - panelH / 2 + 24 + idx * 28;

            if (isPreview) {
                ctx.fillStyle = 'rgba(255,200,60,0.25)';
                ctx.fillRect(cx - 68, y - 12, 136, 26);
            }

            ctx.fillStyle = isPreview ? '#ffc83c' : isCurrent ? '#fff' : '#888';
            ctx.font = `${isPreview ? 'bold ' : ''}${isPreview ? 14 : 12}px monospace`;
            ctx.textAlign = 'center';
            ctx.fillText(
                `${isCurrent && !isPreview ? '• ' : ''}Étage ${lvl.id}  Y=${lvl.floorY.toFixed(1)}m`,
                cx, y + 5
            );
        });

        ctx.fillStyle = floorState.dir === 1 ? '#ffc83c' : '#555';
        ctx.font = '18px monospace';
        ctx.fillText('▲', cx, canvasSize / 2 - panelH / 2 + 14);

        ctx.fillStyle = floorState.dir === -1 ? '#ffc83c' : '#555';
        ctx.fillText('▼', cx, canvasSize / 2 + panelH / 2 - 6);

        ctx.fillStyle = '#666';
        ctx.font = '10px monospace';
        ctx.fillText('relâcher trigger = confirmer', cx, canvasSize - 8);

    } else {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(4, 4, 140, 20);
        ctx.fillStyle = '#fff';
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`Étage ${floor.id}  Y=${floor.floorY.toFixed(1)}m`, 8, 18);
    }

    // Joueur
    if (!floorState?.triggerHeld) {
        const px = ((playerPos.x - minX) / (maxX - minX)) * canvasSize;
        const pz = ((playerPos.z - minZ) / (maxZ - minZ)) * canvasSize;
        const angle = Math.atan2(playerDir.x, playerDir.z);

        ctx.save();
        ctx.translate(px, pz);
        ctx.rotate(angle);
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(4, 4);
        ctx.lineTo(0, 2);
        ctx.lineTo(-4, 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
}

// VR Minimap

export interface VRMinimap {
    mesh: THREE.Mesh;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
}

export function createVRMinimap(
    leftGrip: THREE.XRTargetRaySpace,
    canvasSize = 256
): VRMinimap {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = canvasSize;

    const texture = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.15, 0.15),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
    );

    mesh.position.set(0, 0.05, -0.02);
    mesh.rotation.set(-Math.PI / 2.5, 0, 0);
    leftGrip.add(mesh);

    return { mesh, texture, canvas };
}