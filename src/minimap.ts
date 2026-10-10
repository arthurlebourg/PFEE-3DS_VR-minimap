import * as THREE from 'three';
import type { FloorManagerState } from './floorManager.js';
import { roomColorCss, NO_ROOM, type Room } from './roomSegmentation.js';

const CACHE_VERSION = 12;

// Minimap fills: classic rooms get one hue each, corridors share one neutral sand color, stairs are orange + hatched + outlined
const CORRIDOR_RGB = '215, 200, 160';
const STAIR_RGB = '255, 180, 60';
const STAIR_ICON_SIZE = 12; // px, in canvasSize units

// Hand-held panels (minimap, config, histogram): drawn after everything else, debug overlay included.
// Transparent objects are sorted by distance, which isn't reliable for the overlay (meshes at the origin,
// labels without depth test); renderOrder wins over that sort. Above the floor move axes (999).
export const HUD_RENDER_ORDER = 1000;

// VR minimap plane size (m) on the left grip
const VR_MINIMAP_SIZE = 0.3;
// Canvas pixels per logical pixel: drawing stays in canvasSize units, the texture is sharper on the bigger plane
const MINIMAP_PIXEL_RATIO = 2;

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
/**
 * Wall bitmask per cell (bit 0 = North/−Z, bit 1 = East/+X, bit 2 = South/+Z, bit 3 = West/−X)
 */
export const WALL_N = 1;
export const WALL_E = 2;
export const WALL_S = 4;
export const WALL_W = 8;

export interface FloorLevel {
    id: number;
    floorY: number;
    ceilingY: number;
    walkable: boolean[][];
    /** Wall bitmask per cell (WALL_N | WALL_E | WALL_S | WALL_W). Populated after buildSceneMap. */
    walls: number[][];
    /** Room id per cell (NO_ROOM = -1 if none). Populated after buildSceneMap. */
    roomIds: number[][];
    rooms: Room[];
    subLevels: SubLevel[];
    spawnPoint: { x: number; y: number; z: number };
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/**
 * @typedef StairConnector a staircase/ramp climbing from `fromFloorId`
 * @prop fromFloorId floor the climb started from (always the lower one)
 * @prop toFloorId floor the climb landed on, or null if unresolved
 * @prop resolved true if the climb reached exactly one other floor
 *                false = dead-ended
 * @prop bridged true if `toFloorId` came from projecting the trend
 * @prop cells grid cells covered by the connector (for slope-following render)
 * @prop entryY lowest hit Y
 * @prop exitY highest hit Y
 */
export interface StairConnector {
    fromFloorId: number;
    toFloorId: number | null;
    resolved: boolean;
    bridged: boolean;
    cells: { r: number; c: number; y: number }[];
    entryY: number;
    exitY: number;
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
    sceneBounds: { sceneMinX: number; sceneMinZ: number; };
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    cols: number;
    rows: number;
    gridSize: number;
    levels: FloorLevel[];
    connectors: StairConnector[];
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
 * @prop wallScanHeight Height above floorY at which horizontal rays are cast for wall detection
 * @prop wallNormalThreshold Max |normal.y| to classify a surface as a wall (lower = more vertical)
 * @prop wallRayLength Maximum length of horizontal rays for wall detection
 * @prop minStairArea Minimal area (m²) for a climbed group of cells to be considered a stair connector
 * @prop maxStairArea Maximal area (m²) above which a group is treated as a mezzanine, not a staircase
 * @prop stairMaxStepRise Max Y rise (m) accepted between two adjacent cells while climbing from a floor's edge
 * @prop stairFlatTolerance Max |ΔY| (m) between adjacent cells still considered "flat" (landings, raycast noise)
 * @prop maxLandingRun Max consecutive flat cells (m, converted to a cell count) allowed before a plateau is treated as a dead end
 * @prop doorWidth Openings narrower than this separate two rooms (room segmentation)
 * @prop minRoomArea Rooms smaller than this are merged into a neighbour room
 * @prop minRoomWidth Rooms whose widest spot is narrower than this (m) are removed (gaps between two walls)
 * @prop corridorMaxWidth Rooms narrower than this (m, mean width)...
 * @prop corridorMinElongation ...and at least this long (length / width) are corridors
 */
export interface MinimapConfig {
    gridSize: number;
    minWalkableArea: number;
    normalThreshold: number;
    voxYThr: number;
    minFloorGap: number;
    histoHeightSize: number;
    minPeakArea: number;
    wallScanHeight: number;
    wallNormalThreshold: number;
    wallRayLength: number;
    minStairArea: number;
    maxStairArea: number;
    stairMaxStepRise: number;
    stairFlatTolerance: number;
    maxLandingRun: number;
    doorWidth: number;
    minRoomArea: number;
    minRoomWidth: number;
    corridorMaxWidth: number;
    corridorMinElongation: number;
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
 * @param showRoomLabels draw room / corridor ids
 */
export function renderMinimap(
    map: SceneMap,
    floor: FloorLevel,
    playerPos: THREE.Vector3,
    playerDir: THREE.Vector3,
    canvas: HTMLCanvasElement,
    canvasSize = 256,
    floorState?: FloorManagerState,
    showRoomLabels = true,
): void {
    const ctx = canvas.getContext('2d')!;
    canvas.width = canvas.height = canvasSize * MINIMAP_PIXEL_RATIO;
    ctx.setTransform(MINIMAP_PIXEL_RATIO, 0, 0, MINIMAP_PIXEL_RATIO, 0, 0);

    // dim floor
    const rows = floor.walkable.length;
    const cols = floor.walkable[0]?.length ?? 0;
    const scale = Math.min(canvasSize / cols, canvasSize / rows);
    const offsetX = (canvasSize - cols * scale) / 2;
    const offsetZ = (canvasSize - rows * scale) / 2;

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // transparency
    const mapAlpha = floorState?.triggerHeld ? '0.35' : '0.85';

    // One color per room, one shared color for corridors (grey for cells outside any room, green if segmentation is missing)
    const hasRooms = (floor.rooms?.length ?? 0) > 0;
    const defaultFill = hasRooms ? `rgba(119, 119, 119, ${mapAlpha})` : `rgba(80, 180, 120, ${mapAlpha})`;
    const roomFills = (floor.rooms ?? []).map(room =>
        room.type === 'corridor' ? `rgba(${CORRIDOR_RGB}, ${mapAlpha})` : roomColorCss(room.id, parseFloat(mapAlpha))
    );

    // Room label anchor: the room's cell closest to its centroid (the centroid itself can fall outside an L-shaped room)
    const { sceneMinX, sceneMinZ } = map.sceneBounds;
    const roomCentroids = (floor.rooms ?? []).map(room => ({
        c: (room.center.x - sceneMinX) / map.gridSize - 0.5,
        r: (room.center.z - sceneMinZ) / map.gridSize - 0.5,
    }));
    const roomAnchors = roomCentroids.map(() => ({ r: 0, c: 0, dist: Infinity }));

    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (floor.walkable[r][c]) {
                const roomId = floor.roomIds?.[r]?.[c] ?? NO_ROOM;
                ctx.fillStyle = roomFills[roomId] ?? defaultFill;
                ctx.fillRect(offsetX + c * scale, offsetZ + r * scale, scale, scale);

                const centroid = roomCentroids[roomId];
                if (centroid) {
                    const dist = (r - centroid.r) ** 2 + (c - centroid.c) ** 2;
                    if (dist < roomAnchors[roomId].dist) roomAnchors[roomId] = { r, c, dist };
                }
            }

    // Wall segments
    if (floor.walls && !floorState?.triggerHeld) {
        const wallAlpha = floorState ? '0.9' : '0.9';
        ctx.strokeStyle = `rgba(220, 220, 255, ${wallAlpha})`;
        ctx.lineWidth = Math.max(1, scale * 0.25);
        ctx.lineCap = 'round';
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const mask = floor.walls[r]?.[c] ?? 0;
                if (mask === 0) continue;
                const x0 = offsetX + c * scale;
                const z0 = offsetZ + r * scale;
                const x1 = x0 + scale;
                const z1 = z0 + scale;
                ctx.beginPath();
                // North (−Z) : top edge
                if (mask & 1) { ctx.moveTo(x0, z0); ctx.lineTo(x1, z0); }
                // East (+X)  : right edge
                if (mask & 2) { ctx.moveTo(x1, z0); ctx.lineTo(x1, z1); }
                // South (+Z) : bottom edge
                if (mask & 4) { ctx.moveTo(x0, z1); ctx.lineTo(x1, z1); }
                // West (−X)  : left edge
                if (mask & 8) { ctx.moveTo(x0, z0); ctx.lineTo(x0, z1); }
                ctx.stroke();
            }
        }
    }

    // Stair connectors touching this floor
    const stairIcons: { x: number; y: number; rgb: string; direction: StairDirection }[] = [];
    if (map.connectors && !floorState?.triggerHeld) {
        for (const conn of map.connectors) {
            if (conn.fromFloorId !== floor.id && conn.toFloorId !== floor.id) continue;
            const goingUp = conn.fromFloorId === floor.id; // this floor is the lower end of the connector

            const fillColor = !conn.resolved
                ? '150, 150, 150' // unresolved
                : conn.bridged
                    ? '230, 210, 60' // resolved by projection
                    : goingUp ? STAIR_RGB : '255, 120, 60';
            ctx.fillStyle = `rgba(${fillColor}, ${conn.resolved ? 0.6 : 0.4})`;
            for (const { r, c } of conn.cells)
                ctx.fillRect(offsetX + c * scale, offsetZ + r * scale, scale, scale);

            // Diagonal hatching so the connector reads as distinct from a flat floor tile
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.lineWidth = 1;
            for (const { r, c } of conn.cells) {
                const x0 = offsetX + c * scale;
                const z0 = offsetZ + r * scale;
                ctx.beginPath();
                ctx.moveTo(x0, z0 + scale);
                ctx.lineTo(x0 + scale, z0);
                ctx.stroke();
            }

            // White outline around the connector, so it stands out even over an orange-ish room
            const inConnector = new Set(conn.cells.map(({ r, c }) => `${r}_${c}`));
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (const { r, c } of conn.cells) {
                const x0 = offsetX + c * scale;
                const z0 = offsetZ + r * scale;
                const x1 = x0 + scale;
                const z1 = z0 + scale;
                if (!inConnector.has(`${r - 1}_${c}`)) { ctx.moveTo(x0, z0); ctx.lineTo(x1, z0); }
                if (!inConnector.has(`${r}_${c + 1}`)) { ctx.moveTo(x1, z0); ctx.lineTo(x1, z1); }
                if (!inConnector.has(`${r + 1}_${c}`)) { ctx.moveTo(x0, z1); ctx.lineTo(x1, z1); }
                if (!inConnector.has(`${r}_${c - 1}`)) { ctx.moveTo(x0, z0); ctx.lineTo(x0, z1); }
            }
            ctx.stroke();

            // Stair icon on the connector's centroid, drawn last so nothing covers it
            const avgC = conn.cells.reduce((s, cell) => s + cell.c, 0) / conn.cells.length;
            const avgR = conn.cells.reduce((s, cell) => s + cell.r, 0) / conn.cells.length;
            stairIcons.push({
                x: offsetX + (avgC + 0.5) * scale,
                y: offsetZ + (avgR + 0.5) * scale,
                rgb: fillColor,
                direction: !conn.resolved ? 'unknown' : goingUp ? 'up' : 'down',
            });
        }
    }

    ctx.fillStyle = `rgba(80, 140, 220, ${mapAlpha})`;
    for (const sub of floor.subLevels) {
        const subRows = sub.walkable.length;
        const subCols = sub.walkable[0]?.length ?? 0;
        const sScale = Math.min(canvasSize / subCols, canvasSize / subRows);
        const sOffsetX = (canvasSize - subCols * sScale) / 2;
        const sOffsetZ = (canvasSize - subRows * sScale) / 2;

        for (let r = 0; r < subRows; r++)
            for (let c = 0; c < subCols; c++)
                if (sub.walkable[r][c])
                    ctx.fillRect(sOffsetX + c * sScale, sOffsetZ + r * sScale, sScale, sScale);
    }

    // Room ids ("C" prefix for corridors) + legend
    if (!floorState?.triggerHeld) {
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const [id, anchor] of roomAnchors.entries()) {
            if (!showRoomLabels || anchor.dist === Infinity) continue;
            const isCorridor = floor.rooms[id].type === 'corridor';
            const x = offsetX + (anchor.c + 0.5) * scale;
            const z = offsetZ + (anchor.r + 0.5) * scale;
            const label = isCorridor ? `C${id}` : `${id}`;
            const w = ctx.measureText(label).width + 6;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath();
            ctx.roundRect(x - w / 2, z - 7, w, 14, 3);
            ctx.fill();
            ctx.fillStyle = isCorridor ? `rgb(${CORRIDOR_RGB})` : '#fff';
            ctx.fillText(label, x, z + 1);
        }
        ctx.textBaseline = 'alphabetic';

        for (const { x, y, rgb, direction } of stairIcons) drawStairIcon(ctx, x, y, STAIR_ICON_SIZE, rgb, direction);

        if (hasRooms) drawLegend(ctx, canvasSize);
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
            // floor 0 (lowest) at the bottom
            const rowFromTop = totalFloors - 1 - idx;
            const y = canvasSize / 2 - panelH / 2 + 24 + rowFromTop * 28;

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
        // Player position
        const px = offsetX + ((playerPos.x - sceneMinX) / map.gridSize) * scale;
        const pz = offsetZ + ((playerPos.z - sceneMinZ) / map.gridSize) * scale;
        // Clamp player position to the edge of the minimap
        const EDGE_MARGIN = 5;
        const clampedPx = Math.max(EDGE_MARGIN, Math.min(canvasSize - EDGE_MARGIN, px));
        const clampedPz = Math.max(EDGE_MARGIN, Math.min(canvasSize - EDGE_MARGIN, pz));
        const angle = Math.atan2(playerDir.x, -playerDir.z);

        ctx.save();
        ctx.translate(clampedPx, clampedPz);
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

type StairDirection = 'up' | 'down' | 'unknown' | 'none';

/**
 * Stair icon: rounded badge with a 3-step staircase silhouette, plus a ▲ / ▼ / ? direction mark on its right
 * @param x Icon center X
 * @param y Icon center Y
 * @param size Badge side (px)
 * @param rgb Badge color, "r, g, b"
 * @param direction Up/down from this floor, unknown if the connector is unresolved, none for the legend
 */
function drawStairIcon(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    rgb: string,
    direction: StairDirection,
): void {
    const x0 = x - size / 2;
    const y0 = y - size / 2;

    ctx.fillStyle = `rgb(${rgb})`;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, size / 12);
    ctx.beginPath();
    ctx.roundRect(x0, y0, size, size, size / 5);
    ctx.fill();
    ctx.stroke();

    // Steps going up to the right, filled down to the bottom
    const STEPS = 3;
    const pad = size * 0.18;
    const step = (size - 2 * pad) / STEPS;
    const left = x0 + pad;
    const bottom = y0 + size - pad;
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    for (let i = 0; i < STEPS; i++) {
        ctx.lineTo(left + i * step, bottom - (i + 1) * step);
        ctx.lineTo(left + (i + 1) * step, bottom - (i + 1) * step);
    }
    ctx.lineTo(left + STEPS * step, bottom);
    ctx.closePath();
    ctx.fill();

    if (direction === 'none') return;
    const glyph = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '?';
    ctx.font = `bold ${Math.round(size * 0.6)}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(glyph, x0 + size + 2, y + 1);
    ctx.fillStyle = '#fff';
    ctx.fillText(glyph, x0 + size + 2, y + 1);
    ctx.textBaseline = 'alphabetic';
}

/**
 * Bottom-left legend: room / corridor / stair swatches
 */
function drawLegend(ctx: CanvasRenderingContext2D, canvasSize: number): void {
    const entries: { label: string; draw: (x: number, y: number, s: number) => void }[] = [
        {
            label: 'Pièce',
            // a few room hues side by side: rooms have one color each
            draw: (x, y, s) => [0, 1, 2].forEach(i => {
                ctx.fillStyle = roomColorCss(i);
                ctx.fillRect(x + (i * s) / 3, y, s / 3, s);
            }),
        },
        {
            label: 'Couloir',
            draw: (x, y, s) => {
                ctx.fillStyle = `rgb(${CORRIDOR_RGB})`;
                ctx.fillRect(x, y, s, s);
            },
        },
        {
            label: 'Escalier',
            draw: (x, y, s) => drawStairIcon(ctx, x + s / 2, y + s / 2, s, STAIR_RGB, 'none'),
        },
    ];

    const SWATCH = 10;
    const ENTRY_W = 62;
    const y = canvasSize - 16;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(4, y - 4, entries.length * ENTRY_W + 4, SWATCH + 8);

    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    entries.forEach(({ label, draw }, i) => {
        const x = 8 + i * ENTRY_W;
        draw(x, y, SWATCH);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + SWATCH + 4, y + SWATCH / 2 + 1);
    });
    ctx.textBaseline = 'alphabetic';
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
    canvas.width = canvas.height = canvasSize * MINIMAP_PIXEL_RATIO;

    const texture = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(VR_MINIMAP_SIZE, VR_MINIMAP_SIZE),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
    );

    mesh.position.set(0, 0.05, -0.02);
    mesh.rotation.set(-Math.PI / 2.5, 0, 0);
    mesh.renderOrder = HUD_RENDER_ORDER;
    leftGrip.add(mesh);

    return { mesh, texture, canvas };
}
