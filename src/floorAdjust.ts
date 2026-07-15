import type { FloorLevel } from './minimap.js';

export type AxisMode = 'vertical' | 'horizontal';

/** Read-only view of the map the panels/input handlers need but don't own */
export interface MapContext {
    levelCount: number;
    gridSize: number;
    levels: FloorLevel[];
}

/**
 * @typedef FloorAdjustState
 * @prop selectedFloorIdx floor currently targeted for repositioning
 * @prop axisMode 'vertical' moves Y only, 'horizontal' moves X/Z only
 * @prop previewDelta uncommitted offset, applied visually only until commitFloorMove
 * @prop isMoving true while trigger held in VR drives the axis line visibility
 */
export interface FloorAdjustState {
    selectedFloorIdx: number;
    axisMode: AxisMode;
    previewDelta: { x: number; y: number; z: number };
    isMoving: boolean;
}

export function createFloorAdjustState(): FloorAdjustState {
    return {
        selectedFloorIdx: 0,
        axisMode: 'vertical',
        previewDelta: { x: 0, y: 0, z: 0 },
        isMoving: false,
    };
}

export function selectNextFloor(state: FloorAdjustState, levelCount: number, dir: 1 | -1): void {
    if (levelCount === 0) return;
    state.selectedFloorIdx = (state.selectedFloorIdx + dir + levelCount) % levelCount;
    state.previewDelta = { x: 0, y: 0, z: 0 };
    state.isMoving = false;
}

export function toggleAxisMode(state: FloorAdjustState): void {
    state.axisMode = state.axisMode === 'vertical' ? 'horizontal' : 'vertical';
}

export function hasPendingPreview(state: FloorAdjustState): boolean {
    const { x, y, z } = state.previewDelta;
    return x !== 0 || y !== 0 || z !== 0;
}

export function cancelPreview(state: FloorAdjustState): void {
    state.previewDelta = { x: 0, y: 0, z: 0 };
    state.isMoving = false;
}

const VERTICAL_SPEED = 1.0; // m/s at full stick deflection

// Continuous vertical nudge -> call every frame while trigger held in vertical axis mode
export function nudgeVertical(state: FloorAdjustState, stickY: number, deltaTime: number): void {
    // pushing the stick "up" (negative axis value) raises the floor, matching floorManager's convention
    state.previewDelta.y += -stickY * VERTICAL_SPEED * deltaTime;
}

// Discrete vertical nudge for click-driven UIs (desktop panel)
export function nudgeVerticalStep(state: FloorAdjustState, step: number): void {
    state.previewDelta.y += step;
}

// Discrete one-cell nudge in the horizontal plane (caller handles the repeat cooldown)
export function nudgeHorizontal(state: FloorAdjustState, dCells: { x: number; z: number }, gridSize: number): void {
    state.previewDelta.x += dCells.x * gridSize;
    state.previewDelta.z += dCells.z * gridSize;
}

function shiftGrid(grid: boolean[][], dRows: number, dCols: number): boolean[][] {
    const rows = grid.length;
    const cols = grid[0]?.length ?? 0;
    const result: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (!grid[r][c]) continue;
            const nr = r + dRows, nc = c + dCols;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) result[nr][nc] = true;
        }
    }
    return result;
}

/**
 * Bake the preview delta into the actual floor data (floorY/spawn/bounds/walkable grid),
 * then clear the preview. The walkable grid can only shift by whole cells, so horizontal
 * deltas are rounded to the nearest gridSize step.
 */
export function commitFloorMove(state: FloorAdjustState, level: FloorLevel, gridSize: number): void {
    const { x, y, z } = state.previewDelta;

    if (y !== 0) {
        level.floorY += y;
        level.spawnPoint.y += y;
        if (level.ceilingY !== Infinity) level.ceilingY += y;
        for (const sub of level.subLevels) sub.absoluteY += y;
    }

    if (x !== 0 || z !== 0) {
        const dCols = Math.round(x / gridSize);
        const dRows = Math.round(z / gridSize);

        level.bounds.minX += dCols * gridSize;
        level.bounds.maxX += dCols * gridSize;
        level.bounds.minZ += dRows * gridSize;
        level.bounds.maxZ += dRows * gridSize;
        level.spawnPoint.x += dCols * gridSize;
        level.spawnPoint.z += dRows * gridSize;
        level.walkable = shiftGrid(level.walkable, dRows, dCols);
        for (const sub of level.subLevels) sub.walkable = shiftGrid(sub.walkable, dRows, dCols);
    }

    cancelPreview(state);
}
