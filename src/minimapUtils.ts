/**
 * create a grid of walkable area + find the largest surface (spawn on it)
 * 
 * @param allHits List of raycast hits coordinates
 * @param targetY Detected Peak on Y axe
 * @param thr Threshold grabbing close surface
 * @param minCells Minimum surface to define a floor
 * @param rows Number of rows in minimap
 * @param cols Number of cols in minimap
 * @returns walkable area + the largest component
 */
export function buildWalkableGrid(
    allHits: { r: number; c: number; y: number }[],
    targetY: number,
    thr: number,
    _minCells: number,
    rows: number,
    cols: number,
): { walkable: boolean[][]; bestComponent: [number, number][] } {

    // graph representing the potential floor
    const raw: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
    for (const hit of allHits) {
        if (Math.abs(hit.y - targetY) <= thr) {
            raw[hit.r][hit.c] = true;
        }
    }

    return { walkable: raw, bestComponent: largestComponent(raw) };
}

/**
 * Largest 4-connected group of walkable cells (where the player spawns)
 * @param walkable Walkable grid
 * @returns the component's cells as [row, col]
 */
export function largestComponent(walkable: boolean[][]): [number, number][] {
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const rows = walkable.length;
    const cols = walkable[0]?.length ?? 0;
    const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
    let bestComponent: [number, number][] = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!walkable[r][c] || visited[r][c]) continue;

            const cells: [number, number][] = [];
            const queue: [number, number][] = [[r, c]];
            visited[r][c] = true;

            // BFS order (head index instead of shift()): the spawn is picked in the middle of this list
            for (let head = 0; head < queue.length; head++) {
                const [cr, cc] = queue[head];
                cells.push([cr, cc]);
                for (const [dr, dc] of DIRS) {
                    const nr = cr + dr, nc = cc + dc;
                    if (
                        nr >= 0 && nr < rows &&
                        nc >= 0 && nc < cols &&
                        walkable[nr][nc] && !visited[nr][nc]
                    ) {
                        visited[nr][nc] = true;
                        queue.push([nr, nc]);
                    }
                }
            }

            if (cells.length > bestComponent.length)
                bestComponent = cells;
        }
    }

    return bestComponent;
}


/**
 * Disk structuring element: every offset (dr, dc) with dr² + dc² <= radius²
 * (radius 2 => the 13-cell diamond-ish disk, 5x5 without its corners)
 */
function diskOffsets(radius: number): [number, number][] {
    const offsets: [number, number][] = [];
    for (let dr = -radius; dr <= radius; dr++)
        for (let dc = -radius; dc <= radius; dc++)
            if (dr * dr + dc * dc <= radius * radius) offsets.push([dr, dc]);
    return offsets;
}

/**
 * Binary erosion (keep a cell if the whole disk around it is walkable) or dilation
 * (mark a cell if any cell of the disk around it is walkable). Outside the grid = not walkable.
 */
function erodeOrDilate(grid: boolean[][], disk: [number, number][], erode: boolean): boolean[][] {
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    const at = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c];
    return Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) =>
            erode
                ? disk.every(([dr, dc]) => at(r + dr, c + dc))
                : disk.some(([dr, dc]) => at(r + dr, c + dc))
        )
    );
}

/**
 * Morphological opening (erosion then dilation) by a disk: removes everything thinner than the disk
 * (noise, thin strips) and smooths contours, while areas wide enough get their shape back.
 * Also removes legit passages narrower than the disk (2 × radius + 1 cells): see openingByReconstruction.
 *
 * @param walkable Walkable grid of the floor
 * @param radius Disk radius in cells, 0 = no-op
 * @returns the opened grid (new array)
 */
export function morphologicalOpening(walkable: boolean[][], radius: number): boolean[][] {
    if (radius <= 0) return walkable.map(row => [...row]);
    const disk = diskOffsets(radius);
    return erodeOrDilate(erodeOrDilate(walkable, disk, true), disk, false);
}

/**
 * Opening by reconstruction: the opening only tells which areas are real, then each 4-connected
 * area of the original grid that keeps at least one cell after the opening is restored whole.
 * Isolated noise (nothing survives the opening) is removed, while corridors, doors and stairs
 * connected to a real room stay intact. Thin spurs stuck to a room stay too.
 *
 * @param walkable Walkable grid of the floor
 * @param radius Disk radius in cells of the opening, 0 = no-op
 * @returns the reconstructed grid (new array)
 */
export function openingByReconstruction(walkable: boolean[][], radius: number): boolean[][] {
    if (radius <= 0) return walkable.map(row => [...row]);

    const rows = walkable.length;
    const cols = walkable[0]?.length ?? 0;
    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    // Markers: what survives the opening. Flood fill from them, constrained to the original grid
    const result = morphologicalOpening(walkable, radius);
    const queue: [number, number][] = [];
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
            if (result[r][c]) queue.push([r, c]);

    for (let head = 0; head < queue.length; head++) {
        const [r, c] = queue[head];
        for (const [dr, dc] of DIRS) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (result[nr][nc] || !walkable[nr][nc]) continue;
            result[nr][nc] = true;
            queue.push([nr, nc]);
        }
    }

    return result;
}

// Height (m) of the spawn point above the floor surface
export const SPAWN_ABOVE_FLOOR = 0.5;

// Cells checked at most for a spawn point (each one may cost rays)
const MAX_SPAWN_CANDIDATES = 2000;

/** Floor surface height in a cell and free height above it (to the next surface) */
export type SurfaceAt = (r: number, c: number) => { surfaceY: number; headroom: number } | undefined;

/**
 * Select a spawn point: near the middle of the floor's largest area, away from its edge, where a person can stand.
 * Its y is the floor surface there (+ SPAWN_ABOVE_FLOOR): the floor's Y is a histogram slice centre, a few cm off
 *
 * @param bestComponent Largest surface of the floor
 * @param floorY Y position of the floor
 * @param minX Minimum X of the scene
 * @param minZ Minimum Z of the scene
 * @param gridSize Size of the floor grid
 * @param surfaceAt Floor surface and free height above it in a cell, undefined if unknown
 * @param minHeadroom Free height (m) needed above the spawn: under a seat, a table or a deck, the head would go through
 * @return Coordinates of the spawn
 */
export function pickSpawn(
    bestComponent: [number, number][],
    floorY: number,
    minX: number,
    minZ: number,
    gridSize: number,
    surfaceAt: SurfaceAt = () => undefined,
    minHeadroom = 0,
): { x: number; y: number; z: number } {
    if (bestComponent.length === 0) return { x: minX, y: floorY + SPAWN_ABOVE_FLOOR, z: minZ };

    const inComponent = new Set(bestComponent.map(([r, c]) => `${r}_${c}`));
    const isInterior = (r: number, c: number) => [[-1, 0], [1, 0], [0, -1], [0, 1]]
        .every(([dr, dc]) => inComponent.has(`${r + dr}_${c + dc}`));

    // From the middle of the list outwards: the first interior cell with room enough above.
    // None among the candidates: the one with the most room
    const mid = Math.floor(bestComponent.length / 2);
    let chosen = bestComponent[mid];
    let chosenHeadroom = -Infinity;
    let candidates = 0;
    for (let i = 0; i < 2 * bestComponent.length && candidates < MAX_SPAWN_CANDIDATES; i++) {
        const cell = bestComponent[mid + (i % 2 === 1 ? (i + 1) / 2 : -i / 2)];
        if (!cell || !isInterior(cell[0], cell[1])) continue;
        candidates++;
        const headroom = surfaceAt(cell[0], cell[1])?.headroom ?? Infinity;
        if (headroom > chosenHeadroom) {
            chosen = cell;
            chosenHeadroom = headroom;
        }
        if (headroom >= minHeadroom) break;
    }

    const [r, c] = chosen;
    return {
        x: minX + (c + 0.5) * gridSize,
        y: (surfaceAt(r, c)?.surfaceY ?? floorY) + SPAWN_ABOVE_FLOOR,
        z: minZ + (r + 0.5) * gridSize,
    };
}
