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
    minCells : number,
    rows: number,
    cols: number,
): { walkable: boolean[][]; bestComponent: [number, number][] } {

    const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    // graph representing the potential floor
    const raw: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
    for (const hit of allHits) {
        if (Math.abs(hit.y - targetY) <= thr) {
            raw[hit.r][hit.c] = true;
        }
    }

    const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
    const walkable = Array.from({ length: rows }, () => new Array(cols).fill(false));
    let bestComponent: [number, number][] = [];

    // Propagation
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

            // update walkable surface
            for (const [cr, cc] of cells)
                walkable[cr][cc] = true;

            // update best component
            if (cells.length > bestComponent.length)
                bestComponent = cells;
        }
    }

    return { walkable, bestComponent };
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
 * Tells if a binary erosion of the grid by a disk keeps at least one cell, without building the eroded grid.
 * A cell survives when the whole disk centered on it is walkable (outside the grid = not walkable).
 * Used to drop floors made only of noise (thin strips, scattered cells).
 *
 * @param walkable Walkable grid of the floor
 * @param radius Disk radius, in cells
 * @returns true if something remains after the erosion
 */
export function survivesErosion(walkable: boolean[][], radius: number): boolean {
    const rows = walkable.length;
    const cols = walkable[0]?.length ?? 0;
    const disk = diskOffsets(radius);

    for (let r = radius; r < rows - radius; r++) {
        for (let c = radius; c < cols - radius; c++) {
            if (!walkable[r][c]) continue;
            if (disk.every(([dr, dc]) => walkable[r + dr][c + dc])) return true;
        }
    }
    return false;
}

/**
 * Select a spawn point
 * 
 * @param bestComponent Largest surface of the floor
 * @param floorY Y position of the floor
 * @param minX Minimum X of the scene
 * @param minZ Minimum Z of the scene
 * @param gridSize Size of the floor grid
 * @return Coordinates of the spawn
 */
export function pickSpawn(
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
            y: floorY + 0.5,  // spawn a bit above the floor
            z: minZ + (mid[0] + 0.5) * gridSize,
        }
        : { x: minX, y: floorY + 0.5, z: minZ };
}
