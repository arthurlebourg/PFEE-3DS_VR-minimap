import * as THREE from 'three';
import type {FloorManagerState} from './floorManager.js';

const CACHE_VERSION = 7;

// Types

/**
 * @typedef SubLevel
 * @prop deltaY Difference Y with last level
 * @prop absoluteY floor Y of the level
 * @prop walkable walkable tiles
 */
export interface SubLevel {
    deltaY: number;
    absoluteY: number;
    walkable: boolean[][];
}

/**
 * @typedef FloorLevel
 * @prop id Unique identifier (Useful to select a certain floor)
 * @prop floorY Y floor's coordinates
 * @prop ceilingY Y ceiling's coordinates
 * @prop walkable Grid representing the walkable area
 * @prop subLevels List of close-floor  merge in the current
 * @prop spawnPoint Potential player starting point
 * @prop bounds XZ min-max bounds
 */
export interface FloorLevel {
    id: number;
    floorY: number;
    ceilingY: number;
    walkable: boolean[][];
    subLevels: SubLevel[];
    spawnPoint: { x: number; y: number; z: number };
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/**
 * @typedef SceneMap
 * @prop version Map version
 * @prop bounds XZ min-max bound
 * @prop cols cols's length
 * @prop rows rows's length
 * @prop gridSize size of a cell
 * @prop levels Available floors
 */
export interface SceneMap {
    version: number;
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    cols: number;
    rows: number;
    gridSize: number;
    levels: FloorLevel[];
}

/**
 * @typedef MinimapConfig
 * @prop gridSize Total size of the grid map
 * @prop minWalkableArea Minimal walkable area to define a walkable space
 * @prop normalThreshold Normal max differential angle
 * @prop voxYThr floor thickness
 * @prop minFloorGap gap minimal between 2 floors
 * @prop histoHeightSize Y slice thickness for histogram
 * @prop minPeakArea minimal area to define a peak
 */
export interface MinimapConfig {
    gridSize: number;
    minWalkableArea: number;
    normalThreshold: number;
    voxYThr: number;
    minFloorGap: number;
    histoHeightSize: number;
    minPeakArea: number;
}

// Save floor mapping
const InfToJson = (_: string, v: unknown) => (v === Infinity ? '__INF__' : v);
const JsonToInf = (_: string, v: unknown) => (v === '__INF__' ? Infinity : v);

/**
 * Save a SceneMap in a json
 * @param map SceneMap object
 */
export function saveSceneMapAsFile(map: SceneMap): void {
    map.version = CACHE_VERSION;
    const json = JSON.stringify(map, InfToJson, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sceneMap.json`;
    a.click();

    URL.revokeObjectURL(url);
    console.log(`SceneMap saved : ${a.download}  (${(json.length / 1024).toFixed(1)} KB)`);
}

/**
 * Load a map from a file
 * @param mapPath Path to the map file
 */
export async function loadSceneMapFromFile(mapPath: string): Promise<SceneMap | null> {
    try {
        const res = await fetch(mapPath);
        if (!res.ok) return null;
        const map = JSON.parse(await res.text(), JsonToInf) as SceneMap;
        if (map.version !== CACHE_VERSION) {
            console.log('SceneMap: deprecated version, need rebuild');
            return null;
        }
        console.log(`SceneMap: load from ${mapPath} (${map.levels.length} floors)`);
        return map;
    } catch {
        return null;
    }
}

// Render Minimap
/**
 * Render a minimap on the right hand
 * @param map
 * @param floor current floor object
 * @param playerPos player position
 * @param playerDir look at direction
 * @param canvas html canvas
 * @param canvasSize canvas size
 * @param floorState current floor
 */
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

    // dim floor
    const { minX, maxX, minZ, maxZ } = floor.bounds;
    const rows = floor.walkable.length;
    const cols = floor.walkable[0]?.length ?? 0;
    const cellW = canvasSize / cols;
    const cellH = canvasSize / rows;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // transparency
    const mapAlpha = floorState?.triggerHeld ? '0.35' : '0.85';

    ctx.fillStyle = `rgba(80, 180, 120, ${mapAlpha})`;
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (floor.walkable[r][c])
                ctx.fillRect(c * cellW, r * cellH, cellW, cellH);

    ctx.fillStyle = `rgba(80, 140, 220, ${mapAlpha})`;
    for (const sub of floor.subLevels) {
        const subRows = sub.walkable.length;
        const subCols = sub.walkable[0]?.length ?? 0;

        const sCellW = canvasSize / subCols;
        const sCellH = canvasSize / subRows;

        for (let r = 0; r < subRows; r++)
            for (let c = 0; c < subCols; c++)
                if (sub.walkable[r][c])
                    ctx.fillRect(c * sCellW, r * sCellH, sCellW, sCellH);
    }

    // Overlay 'select floor'
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
/**
 * @typedef VRMinimap canvas 3D object to display minimap
 */
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