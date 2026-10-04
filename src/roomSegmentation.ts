/**
 * Room segmentation of a floor level, from its walkable grid and wall bitmasks.
 *
 * Idea (distance-transform + seeded growth, a light "watershed"):
 *  1. Distance of every walkable cell to the nearest obstacle (wall edge or non-walkable cell).
 *  2. Cells farther than doorWidth/2 form "cores": doorways and narrow openings are thinner
 *     than that, so they cut the cores apart => one core component per room.
 *  3. Cores grow back (BFS, never crossing a wall), but only over the band that erosion
 *     removed, so they don't leak through doors into narrow corridors.
 *  4. Leftover cells (corridors, closets...) become their own regions, then regions
 *     smaller than minRoomArea are merged into the neighbour they share the longest border with.
 */

/**
 * @typedef Room
 * @prop id Room index (value stored in roomIds)
 * @prop cellCount Number of cells in the room
 * @prop area Room area in m²
 * @prop center World XZ centroid of the room
 */
export interface Room {
    id: number;
    cellCount: number;
    area: number;
    center: { x: number; z: number };
}

/** Value stored in roomIds for cells that belong to no room */
export const NO_ROOM = -1;

// Same bitmask convention as FloorLevel.walls: N (−Z), E (+X), S (+Z), W (−X)
const DIRS: { dr: number; dc: number; bit: number; opposite: number }[] = [
    { dr: -1, dc: 0, bit: 1, opposite: 4 },
    { dr: 0, dc: 1, bit: 2, opposite: 8 },
    { dr: 1, dc: 0, bit: 4, opposite: 1 },
    { dr: 0, dc: -1, bit: 8, opposite: 2 },
];
const N = 0, E = 1, S = 2, W = 3;

/**
 * Minimal binary min-heap on (priority, value), used by the distance transform
 */
class MinHeap {
    private prio: number[] = [];
    private vals: number[] = [];

    get size(): number { return this.vals.length; }

    push(p: number, v: number): void {
        this.prio.push(p);
        this.vals.push(v);
        let i = this.vals.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.prio[parent] <= this.prio[i]) break;
            this.swap(i, parent);
            i = parent;
        }
    }

    pop(): [number, number] {
        const top: [number, number] = [this.prio[0], this.vals[0]];
        const lastP = this.prio.pop()!;
        const lastV = this.vals.pop()!;
        if (this.vals.length > 0) {
            this.prio[0] = lastP;
            this.vals[0] = lastV;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < this.vals.length && this.prio[l] < this.prio[m]) m = l;
                if (r < this.vals.length && this.prio[r] < this.prio[m]) m = r;
                if (m === i) break;
                this.swap(i, m);
                i = m;
            }
        }
        return top;
    }

    private swap(a: number, b: number): void {
        [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
        [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
    }
}

/**
 * Segment a floor into rooms
 * @param walkable Walkable grid of the floor
 * @param walls Wall bitmask grid (same dimensions as walkable)
 * @param gridSize Size of a cell (m)
 * @param sceneMinX Scene min X (grid origin)
 * @param sceneMinZ Scene min Z (grid origin)
 * @param doorWidth Openings narrower than this (m) separate two rooms
 * @param minRoomArea Regions smaller than this (m²) are merged into a neighbour room
 * @returns room id per cell (NO_ROOM if none) + room list
 */
export function segmentRooms(
    walkable: boolean[][],
    walls: number[][],
    gridSize: number,
    sceneMinX: number,
    sceneMinZ: number,
    doorWidth: number,
    minRoomArea: number,
): { roomIds: number[][]; rooms: Room[] } {
    const rows = walkable.length;
    const cols = walkable[0]?.length ?? 0;
    const total = rows * cols;

    const isWalk = (r: number, c: number) =>
        r >= 0 && r < rows && c >= 0 && c < cols && walkable[r][c];

    // Can we step from (r, c) to its neighbour in direction d without crossing a wall?
    const passable = (r: number, c: number, d: number): boolean => {
        const { dr, dc, bit, opposite } = DIRS[d];
        const nr = r + dr, nc = c + dc;
        if (!isWalk(r, c) || !isWalk(nr, nc)) return false;
        return ((walls[r]?.[c] ?? 0) & bit) === 0 && ((walls[nr]?.[nc] ?? 0) & opposite) === 0;
    };

    // Step 1 - distance transform (Dijkstra, 8-connected chamfer, walls block propagation)
    const dist = new Float32Array(total).fill(Infinity);
    const heap = new MinHeap();

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!walkable[r][c]) continue;
            // Border cell: at least one side is a wall or the void => half a cell from the obstacle
            if (!passable(r, c, N) || !passable(r, c, E) || !passable(r, c, S) || !passable(r, c, W)) {
                dist[r * cols + c] = 0.5;
                heap.push(0.5, r * cols + c);
            }
        }
    }

    const diagonals: { dr: number; dc: number; v: number; h: number }[] = [
        { dr: -1, dc: 1, v: N, h: E },
        { dr: 1, dc: 1, v: S, h: E },
        { dr: 1, dc: -1, v: S, h: W },
        { dr: -1, dc: -1, v: N, h: W },
    ];

    while (heap.size > 0) {
        const [d, idx] = heap.pop();
        if (d > dist[idx]) continue;
        const r = Math.floor(idx / cols), c = idx % cols;

        for (let k = 0; k < 4; k++) {
            if (!passable(r, c, k)) continue;
            const nIdx = (r + DIRS[k].dr) * cols + (c + DIRS[k].dc);
            if (d + 1 < dist[nIdx]) {
                dist[nIdx] = d + 1;
                heap.push(d + 1, nIdx);
            }
        }
        // Diagonal only when both L-shaped paths are free (no corner cutting through walls)
        for (const { dr, dc, v, h } of diagonals) {
            if (!passable(r, c, v) || !passable(r, c, h)) continue;
            if (!passable(r + dr, c, h) || !passable(r, c + dc, v)) continue;
            const nIdx = (r + dr) * cols + (c + dc);
            if (d + Math.SQRT2 < dist[nIdx]) {
                dist[nIdx] = d + Math.SQRT2;
                heap.push(d + Math.SQRT2, nIdx);
            }
        }
    }

    // Step 2 - cores = cells far enough from any obstacle
    const coreThreshold = doorWidth / 2 / gridSize;
    const label = new Int32Array(total).fill(NO_ROOM);
    let nextLabel = 0;

    const floodFill = (seedIdx: number, accept: (idx: number) => boolean, lbl: number, queue: number[]) => {
        label[seedIdx] = lbl;
        const local = [seedIdx];
        while (local.length > 0) {
            const idx = local.pop()!;
            queue.push(idx);
            const r = Math.floor(idx / cols), c = idx % cols;
            for (let k = 0; k < 4; k++) {
                if (!passable(r, c, k)) continue;
                const nIdx = (r + DIRS[k].dr) * cols + (c + DIRS[k].dc);
                if (label[nIdx] !== NO_ROOM || !accept(nIdx)) continue;
                label[nIdx] = lbl;
                local.push(nIdx);
            }
        }
    };

    // Tiny cores (e.g. where a door opens onto a corridor) are noise: dropped, their cells become leftovers
    const minCells = Math.ceil(minRoomArea / (gridSize * gridSize));
    const minCoreCells = Math.max(1, Math.ceil(minCells / 4));
    const isCore = new Uint8Array(total);
    let frontier: number[] = [];
    for (let idx = 0; idx < total; idx++) {
        if (label[idx] !== NO_ROOM || !(dist[idx] > coreThreshold) || dist[idx] === Infinity) continue;
        const cells: number[] = [];
        floodFill(idx, i => dist[i] > coreThreshold && !isCore[i], nextLabel, cells);
        for (const i of cells) isCore[i] = 1;
        if (cells.length < minCoreCells) {
            for (const i of cells) label[i] = NO_ROOM;
            continue;
        }
        frontier.push(...cells);
        nextLabel++;
    }

    // Step 3 - grow cores back over the band that erosion removed, layer by layer (8-connected).
    // A cell at distance d from the walls lies ~(coreThreshold - d) layers from its room core;
    // cells much farther than that are behind a narrow opening (doorway, corridor) => left for step 4.
    const neighbours = [
        ...DIRS.map((d, k) => ({ dr: d.dr, dc: d.dc, ok: (r: number, c: number) => passable(r, c, k) })),
        ...diagonals.map(({ dr, dc, v, h }) => ({
            dr, dc,
            ok: (r: number, c: number) =>
                passable(r, c, v) && passable(r, c, h) && passable(r + dr, c, h) && passable(r, c + dc, v),
        })),
    ];
    const BAND_TOLERANCE = 1.5;
    for (let layer = 1; frontier.length > 0; layer++) {
        const next: number[] = [];
        for (const idx of frontier) {
            const r = Math.floor(idx / cols), c = idx % cols;
            for (const { dr, dc, ok } of neighbours) {
                if (!ok(r, c)) continue;
                const nIdx = (r + dr) * cols + (c + dc);
                if (label[nIdx] !== NO_ROOM) continue;
                if (layer > coreThreshold - dist[nIdx] + BAND_TOLERANCE) continue;
                label[nIdx] = label[idx];
                next.push(nIdx);
            }
        }
        frontier = next;
    }

    // Leftovers (narrow areas not reachable from any core) => own regions
    for (let idx = 0; idx < total; idx++) {
        const r = Math.floor(idx / cols), c = idx % cols;
        if (label[idx] !== NO_ROOM || !walkable[r][c]) continue;
        floodFill(idx, () => true, nextLabel++, []);
    }

    // Step 4 - merge regions smaller than minRoomArea into their best neighbour
    const sizes = new Array(nextLabel).fill(0);
    for (let idx = 0; idx < total; idx++) if (label[idx] !== NO_ROOM) sizes[label[idx]]++;

    // remap[l] = label that l has been merged into (union-find style)
    const remap = Array.from({ length: nextLabel }, (_, i) => i);
    const find = (l: number): number => {
        while (remap[l] !== l) l = remap[l] = remap[remap[l]];
        return l;
    };

    let changed = true;
    while (changed) {
        changed = false;

        // Shared border length between each small region and its neighbours
        const borders = new Map<number, Map<number, number>>();
        for (let idx = 0; idx < total; idx++) {
            if (label[idx] === NO_ROOM) continue;
            const a = find(label[idx]);
            if (sizes[a] >= minCells) continue;
            const r = Math.floor(idx / cols), c = idx % cols;
            for (let k = 0; k < 4; k++) {
                if (!passable(r, c, k)) continue;
                const b = find(label[(r + DIRS[k].dr) * cols + (c + DIRS[k].dc)]);
                if (b === a) continue;
                if (!borders.has(a)) borders.set(a, new Map());
                const m = borders.get(a)!;
                m.set(b, (m.get(b) ?? 0) + 1);
            }
        }

        // Smallest regions first, so tiny fragments join before being joined
        const small = [...borders.keys()].sort((x, y) => sizes[x] - sizes[y]);
        for (const a of small) {
            if (find(a) !== a || sizes[a] >= minCells) continue;
            let best = -1, bestLen = 0;
            for (const [b, len] of borders.get(a)!) {
                const rb = find(b);
                if (rb !== a && len > bestLen) { best = rb; bestLen = len; }
            }
            if (best < 0) continue;
            remap[a] = best;
            sizes[best] += sizes[a];
            sizes[a] = 0;
            changed = true;
        }
    }

    // Final compact numbering + stats. Isolated tiny regions (no neighbour to merge into) get NO_ROOM.
    const finalId = new Map<number, number>();
    const rooms: Room[] = [];
    const sumX: number[] = [], sumZ: number[] = [];
    const roomIds: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(NO_ROOM));

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const l = label[r * cols + c];
            if (l === NO_ROOM) continue;
            const root = find(l);
            if (sizes[root] < minCells) continue;

            let id = finalId.get(root);
            if (id === undefined) {
                id = rooms.length;
                finalId.set(root, id);
                rooms.push({ id, cellCount: 0, area: 0, center: { x: 0, z: 0 } });
                sumX.push(0);
                sumZ.push(0);
            }
            roomIds[r][c] = id;
            rooms[id].cellCount++;
            sumX[id] += sceneMinX + (c + 0.5) * gridSize;
            sumZ[id] += sceneMinZ + (r + 0.5) * gridSize;
        }
    }

    for (const room of rooms) {
        room.area = room.cellCount * gridSize * gridSize;
        room.center = { x: sumX[room.id] / room.cellCount, z: sumZ[room.id] / room.cellCount };
    }

    return { roomIds, rooms };
}

/** Color of walkable cells outside any room (wall footprints, isolated scraps) */
export const NO_ROOM_COLOR = 0x777777;

// Golden angle hue spacing => neighbouring ids get clearly different colors
const GOLDEN_ANGLE = 137.508;

/**
 * Distinct color for a room, as a CSS color (canvas minimap)
 */
export function roomColorCss(id: number, alpha = 1): string {
    return `hsla(${(id * GOLDEN_ANGLE) % 360}, 65%, 55%, ${alpha})`;
}

/**
 * Distinct color for a room, as a hex number (THREE materials)
 */
export function roomColorHex(id: number): number {
    const h = ((id * GOLDEN_ANGLE) % 360) / 360;
    const s = 0.65, l = 0.55;
    // HSL -> RGB
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    const r = Math.round(channel(h + 1 / 3) * 255);
    const g = Math.round(channel(h) * 255);
    const b = Math.round(channel(h - 1 / 3) * 255);
    return (r << 16) | (g << 8) | b;
}
