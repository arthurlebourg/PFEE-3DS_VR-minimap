import * as THREE from 'three';
import type { SceneMap, FloorLevel, StairConnector } from './minimap.js';
import { roomColorHex, NO_ROOM_COLOR } from './roomSegmentation.js';

const FLOOR_COLORS: readonly number[] = [0x4488ff, 0x44ff88, 0xff8844, 0xff44aa, 0xaaff44, 0xaa44ff, 0x44ffff, 0xffee44];
const FLOOR_OPACITY = 0.5;
const SUBLEVEL_OPACITY = 0.25;
const Y_LIFT = 0.05; // slight elevation to be visible
const WALL_HEIGHT = 2.2; // visual height of wall quads in the debug overlay
const WALL_OPACITY = 0.55;
const CONNECTOR_COLOR = 0xffaa00;
const CONNECTOR_BRIDGED_COLOR = 0xe6d23c;
const CONNECTOR_UNRESOLVED_COLOR = 0x888888;
const CONNECTOR_OPACITY = 0.6;

/**
 * @typedef DebugFloorOverlay
 * @prop group THREE.Group representing the debug overlay
 * @prop toggle Toggle visibility of the overlay
 * @prop dispose Dispose (=clear) of the overlay and its resources
 */
export interface DebugFloorOverlay {
    group: THREE.Group;
    toggle: () => void;
    dispose: () => void;
}

export function createDebugFloorOverlay(
    scene: THREE.Scene,
    map: SceneMap,
): DebugFloorOverlay {
    const group = new THREE.Group();
    group.name = 'debug-floor-overlay';

    const disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];

    map.levels.forEach((level, idx) => {
        const color = FLOOR_COLORS[idx % FLOOR_COLORS.length];

        // Main walkable grid (colored per room when segmentation is available)
        const mainMesh = buildWalkableMesh(map, level.walkable, level.floorY + Y_LIFT, color, FLOOR_OPACITY, level.roomIds);
        mainMesh.name = `floor-${level.id}-main`;
        group.add(mainMesh);
        disposables.push(mainMesh.geometry, mainMesh.material as THREE.Material);

        // Wall mesh
        if (level.walls && level.walls.length > 0) {
            const wallMesh = buildWallMesh(map, level.walkable, level.walls, level.floorY + Y_LIFT, color, WALL_OPACITY);
            wallMesh.name = `floor-${level.id}-walls`;
            group.add(wallMesh);
            disposables.push(wallMesh.geometry, wallMesh.material as THREE.Material);
        }

        // Sub-levels (same color, more transparent)
        level.subLevels.forEach((sub, si) => {
            const subMesh = buildWalkableMesh(map, sub.walkable, sub.absoluteY + Y_LIFT, color, SUBLEVEL_OPACITY);
            subMesh.name = `floor-${level.id}-sub-${si}`;
            group.add(subMesh);
            disposables.push(subMesh.geometry, subMesh.material as THREE.Material);
        });

        // Box wireframe (bounds + ceiling height)
        const wire = buildBoundsWireframe(level, color);
        group.add(wire);
        disposables.push(wire.geometry, wire.material as THREE.Material);

        // Floating label above the spawn point
        const { sprite, canvasTexture, spriteMat } = buildFloorLabel(level, color);
        group.add(sprite);
        disposables.push(canvasTexture, spriteMat);
    });

    // Stair / ramp connectors between floors, grey when unresolved (no confirmed destination),
    // amber when resolved by projecting the trend rather than directly climbed
    map.connectors?.forEach((conn, idx) => {
        const color = !conn.resolved ? CONNECTOR_UNRESOLVED_COLOR : conn.bridged ? CONNECTOR_BRIDGED_COLOR : CONNECTOR_COLOR;
        const connMesh = buildConnectorMesh(map, conn.cells, color, CONNECTOR_OPACITY);
        connMesh.name = `connector-${idx}`;
        group.add(connMesh);
        disposables.push(connMesh.geometry, connMesh.material as THREE.Material);

        const { sprite, canvasTexture, spriteMat } = buildConnectorLabel(map, conn);
        group.add(sprite);
        disposables.push(canvasTexture, spriteMat);
    });

    scene.add(group);

    return {
        group,
        toggle: () => { group.visible = !group.visible; },
        dispose: () => {
            disposables.forEach(d => d.dispose());
            scene.remove(group);
        },
    };
}

/**
 * Create vertical quad meshes for detected walls in the debug 3D overlay.
 * Each walkable cell can have up to 4 wall faces (N/E/S/W) drawn as semi-transparent quads.
 *
 * Bitmask: bit 0 = North (−Z), bit 1 = East (+X), bit 2 = South (+Z), bit 3 = West (−X)
 *
 * @param map SceneMap
 * @param walkable Walkable grid for this floor
 * @param walls Wall bitmask grid (same dimensions as walkable)
 * @param yBase Y position of the floor (bottom of the wall quad)
 * @param color Wall color (hex)
 * @param opacity Opacity of the wall material
 */
export function buildWallMesh(
    map: SceneMap,
    walkable: boolean[][],
    walls: number[][],
    yBase: number,
    color: number,
    opacity: number,
): THREE.Mesh {
    const gs = map.gridSize;
    const { sceneMinX, sceneMinZ } = map.sceneBounds;
    const rows = walls.length;
    const cols = walls[0]?.length ?? 0;
    const yTop = yBase + WALL_HEIGHT;

    const positions: number[] = [];
    const indices: number[] = [];

    // For each face: p0/p1 = bottom edge endpoints, p2/p3 = top edge endpoints
    // North (−Z): z = cz − gs/2, x from cx−gs/2 to cx+gs/2
    // East  (+X): x = cx + gs/2, z from cz−gs/2 to cz+gs/2
    // South (+Z): z = cz + gs/2, x from cx+gs/2 to cx−gs/2
    // West  (−X): x = cx − gs/2, z from cz+gs/2 to cz−gs/2
    const faceEdges: { bit: number; ax0: number; az0: number; ax1: number; az1: number }[] = [
        { bit: 1, ax0: -0.5, az0: -0.5, ax1: 0.5, az1: -0.5 }, // N
        { bit: 2, ax0: 0.5, az0: -0.5, ax1: 0.5, az1: 0.5 }, // E
        { bit: 4, ax0: 0.5, az0: 0.5, ax1: -0.5, az1: 0.5 }, // S
        { bit: 8, ax0: -0.5, az0: 0.5, ax1: -0.5, az1: -0.5 }, // W
    ];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const mask = walls[r]?.[c] ?? 0;
            if (mask === 0) continue;
            if (!walkable[r]?.[c]) continue; // safety: only on walkable cells

            const cx = sceneMinX + (c + 0.5) * gs;
            const cz = sceneMinZ + (r + 0.5) * gs;

            for (const { bit, ax0, az0, ax1, az1 } of faceEdges) {
                if (!(mask & bit)) continue;

                const x0 = cx + ax0 * gs;
                const z0 = cz + az0 * gs;
                const x1 = cx + ax1 * gs;
                const z1 = cz + az1 * gs;

                const base = positions.length / 3;
                positions.push(
                    x0, yBase, z0,
                    x1, yBase, z1,
                    x1, yTop, z1,
                    x0, yTop, z0,
                );
                indices.push(
                    base, base + 1, base + 2,
                    base, base + 2, base + 3,
                );
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    if (positions.length > 0) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
    }

    const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
}

/**
 * Create a mesh representing the walkable area of a floor or sub-level in the 3D scene
 * @param map
 * @param walkable
 * @param y Y position of the mesh
 * @param color Color of every cell (ignored when roomIds is given)
 * @param opacity
 * @param roomIds Optional room id per cell => each room gets its own color
 */
export function buildWalkableMesh(
    map: SceneMap,
    walkable: boolean[][],
    y: number,
    color: number,
    opacity: number,
    roomIds?: number[][],
): THREE.Mesh {
    const gs = map.gridSize;
    const half = gs * 0.49;  // small gap between tiles
    const { sceneMinX, sceneMinZ } = map.sceneBounds;
    const rows = walkable.length;
    const cols = walkable[0]?.length ?? 0;

    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const useRooms = !!roomIds && roomIds.length > 0;
    const cellColor = new THREE.Color();

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!walkable[r][c]) continue;

            if (useRooms) {
                const roomId = roomIds![r]?.[c] ?? -1;
                cellColor.setHex(roomId >= 0 ? roomColorHex(roomId) : NO_ROOM_COLOR);
                for (let v = 0; v < 4; v++) colors.push(cellColor.r, cellColor.g, cellColor.b);
            }

            const cx = sceneMinX + (c + 0.5) * gs;
            const cz = sceneMinZ + (r + 0.5) * gs;
            const base = positions.length / 3;

            positions.push(
                cx - half, y, cz - half,
                cx + half, y, cz - half,
                cx + half, y, cz + half,
                cx - half, y, cz + half,
            );
            indices.push(
                base, base + 1, base + 2,
                base, base + 2, base + 3,
            );
        }
    }

    const geo = new THREE.BufferGeometry();
    if (positions.length > 0) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        if (useRooms) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geo.setIndex(indices);
    }

    const mat = new THREE.MeshBasicMaterial({
        color: useRooms ? 0xffffff : color,
        vertexColors: useRooms,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
}

/**
 * Continuous heightfield: corners shared between cells average their Y (not disjoint flat
 * tiles), reads as a ramp between steps, distinct from the flat per-floor walkable mesh.
 * @param map SceneMap
 * @param cells grid cells covered by the connector, each with its own climbed Y
 * @param color
 * @param opacity
 */
export function buildConnectorMesh(
    map: SceneMap,
    cells: { r: number; c: number; y: number }[],
    color: number,
    opacity: number,
): THREE.Mesh {
    const gs = map.gridSize;
    const { sceneMinX, sceneMinZ } = map.sceneBounds;

    const cellY = new Map<string, number>();
    for (const { r, c, y } of cells) cellY.set(`${r}_${c}`, y);

    // Corner (r,c) = world (sceneMinX+c*gs, sceneMinZ+r*gs), shared by cells (r,c)/(r-1,c)/(r,c-1)/(r-1,c-1).
    // Average whichever belong to the connector so adjoining cells blend at their shared edge.
    const CORNER_NEIGHBOURS: [number, number][] = [[0, 0], [-1, 0], [0, -1], [-1, -1]];
    const cornerY = new Map<string, number>();
    function getCornerY(r: number, c: number): number {
        const key = `${r}_${c}`;
        const cached = cornerY.get(key);
        if (cached !== undefined) return cached;

        let sum = 0, count = 0;
        for (const [dr, dc] of CORNER_NEIGHBOURS) {
            const y = cellY.get(`${r + dr}_${c + dc}`);
            if (y !== undefined) { sum += y; count++; }
        }
        const avg = count > 0 ? sum / count : 0;
        cornerY.set(key, avg);
        return avg;
    }

    const positions: number[] = [];
    const indices: number[] = [];
    const vertexIndex = new Map<string, number>();
    function getVertex(r: number, c: number): number {
        const key = `${r}_${c}`;
        const existing = vertexIndex.get(key);
        if (existing !== undefined) return existing;

        const idx = positions.length / 3;
        positions.push(sceneMinX + c * gs, getCornerY(r, c) + Y_LIFT, sceneMinZ + r * gs);
        vertexIndex.set(key, idx);
        return idx;
    }

    for (const { r, c } of cells) {
        const v00 = getVertex(r, c);
        const v01 = getVertex(r, c + 1);
        const v11 = getVertex(r + 1, c + 1);
        const v10 = getVertex(r + 1, c);
        indices.push(v00, v01, v11, v00, v11, v10);
    }

    const geo = new THREE.BufferGeometry();
    if (positions.length > 0) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
    }

    const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    return new THREE.Mesh(geo, mat);
}

/**
 * Create a floating label at a stair connector's centroid, showing which floors it links
 */
function buildConnectorLabel(
    map: SceneMap,
    conn: StairConnector,
): { sprite: THREE.Sprite; canvasTexture: THREE.CanvasTexture; spriteMat: THREE.SpriteMaterial } {
    const gs = map.gridSize;
    const { sceneMinX, sceneMinZ } = map.sceneBounds;
    const avgC = conn.cells.reduce((s, cell) => s + cell.c, 0) / conn.cells.length;
    const avgR = conn.cells.reduce((s, cell) => s + cell.r, 0) / conn.cells.length;
    const worldX = sceneMinX + (avgC + 0.5) * gs;
    const worldZ = sceneMinZ + (avgR + 0.5) * gs;
    const worldY = (conn.entryY + conn.exitY) / 2 + 0.6;

    const W = 200, H = 44;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = !conn.resolved ? '#888888' : conn.bridged ? '#e6d23c' : '#ffaa00';
    ctx.strokeRect(0, 0, W, H);

    ctx.fillStyle = '#fff';
    ctx.font = '14px monospace';
    const dest = !conn.resolved ? '? (non résolu)' : conn.bridged ? `${conn.toFloorId} (projeté)` : String(conn.toFloorId);
    ctx.fillText(`Escalier ${conn.fromFloorId} → ${dest}`, 10, 26);

    const canvasTexture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: canvasTexture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);

    sprite.position.set(worldX, worldY, worldZ);
    sprite.scale.set(1.0, 1.0 * H / W, 1);

    return { sprite, canvasTexture, spriteMat };
}

/**
 * Create a wireframe representing the bounds of a floor (including ceiling height)
 */
function buildBoundsWireframe(level: FloorLevel, color: number): THREE.LineSegments {
    const { minX, maxX, minZ, maxZ } = level.bounds;
    const yBot = level.floorY + Y_LIFT;
    const yTop = level.ceilingY === Infinity ? level.floorY + 3.5 : level.ceilingY;

    // 12 edges in a box = 24 points
    const pts = [
        // bottom
        minX, yBot, minZ, maxX, yBot, minZ,
        maxX, yBot, minZ, maxX, yBot, maxZ,
        maxX, yBot, maxZ, minX, yBot, maxZ,
        minX, yBot, maxZ, minX, yBot, minZ,
        // top
        minX, yTop, minZ, maxX, yTop, minZ,
        maxX, yTop, minZ, maxX, yTop, maxZ,
        maxX, yTop, maxZ, minX, yTop, maxZ,
        minX, yTop, maxZ, minX, yTop, minZ,
        // vertical edges
        minX, yBot, minZ, minX, yTop, minZ,
        maxX, yBot, minZ, maxX, yTop, minZ,
        maxX, yBot, maxZ, maxX, yTop, maxZ,
        minX, yBot, maxZ, minX, yTop, maxZ,
    ];

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));

    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 });
    return new THREE.LineSegments(geo, mat);
}

/**
 * Create a floating label above the spawn point of a floor, showing its ID and Y position
 */
function buildFloorLabel(
    level: FloorLevel,
    color: number,
): { sprite: THREE.Sprite; canvasTexture: THREE.CanvasTexture; spriteMat: THREE.SpriteMaterial } {
    const W = 220, H = 50;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d')!;
    const hex = '#' + color.toString(16).padStart(6, '0');

    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = hex;
    ctx.strokeRect(0, 0, W, H);

    ctx.fillStyle = '#fff';
    ctx.font = '16px monospace';
    const subYs = level.subLevels.map(s => '+ ' + s.absoluteY.toFixed(2) + 'm').join(', ');
    ctx.fillText(`Étage ${level.id}: ${level.floorY.toFixed(1)}m ${subYs}`, 10, 30);

    const canvasTexture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: canvasTexture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);

    sprite.position.set(level.spawnPoint.x, level.spawnPoint.y, level.spawnPoint.z);
    sprite.scale.set(1.2, 1.2 * H / W, 1);

    return { sprite, canvasTexture, spriteMat };
}
