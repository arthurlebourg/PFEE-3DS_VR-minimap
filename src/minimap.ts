import * as THREE from 'three';
import type {FloorManagerState} from './floorManager.js';

const CACHE_VERSION = 7;

// Types

/**
 * @typedef SubLevel
 * @prop deltaY floor Y of next floor
 * @prop absoluteY
 * @prop walkable walkable tiles
 */
export interface SubLevel {
    deltaY: number;
    absoluteY: number;
    walkable: boolean[][];
}

/**
 * @typedef FloorLevel
 * @prop id
 * @prop floorY
 * @prop ceilingY
 * @prop walkable
 * @prop subLevels
 * @prop spawnPoint
 * @prop bounds
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
 * @prop version
 * @prop bounds
 * @prop cols
 * @prop rows
 * @prop gridSize size of a cell
 * @prop levels
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
 * MinimapConfig
 */
export interface MinimapConfig {
    gridSize: number;
    minWalkableArea: number;
    normalThreshold: number;
    voxYThr: number;
    minFloorGap: number;
    histogramBinSize: number;
    histogramMinDensity: number;
}

// Save floor mapping
const InfToJson = (_: string, v: unknown) => (v === Infinity ? '__INF__' : v);
const JsonToInf = (_: string, v: unknown) => (v === '__INF__' ? Infinity : v);

export function saveSceneMapAsFile(map: SceneMap): void {
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
        // les sous-niveaux partagent les bounds de l'étage parent
        const sCellW = canvasSize / subCols;
        const sCellH = canvasSize / subRows;
        for (let r = 0; r < subRows; r++)
            for (let c = 0; c < subCols; c++)
                if (sub.walkable[r][c])
                    ctx.fillRect(c * sCellW, r * sCellH, sCellW, sCellH);
    }

    // Overlay sélection d'étage — inchangé
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

    // Joueur — utilise floor.bounds
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