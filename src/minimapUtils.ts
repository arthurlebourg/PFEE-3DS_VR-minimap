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
