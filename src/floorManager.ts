import * as THREE from 'three';

import type { SceneMap } from './minimap.js';
import { placePlayerOnFloor } from './player.js';

// trigger value in [0,1]
const TRIGGER_THRESHOLD = 0.5;
const JOYSTICK_THRESHOLD = 0.7;
const COOLDOWN_MS = 600;

/**
 * @typedef FloorManagerState
 * @prop curFloorIdx current floor id
 * @prop prevFloorIdx previous floor id
 * @prop triggerHeld to indicate trigger holding
 */
export interface FloorManagerState {
    curFloorIdx: number;
    prevFloorIdx: number;
    triggerHeld: boolean;
    dir: -1 | 0 | 1;
    isCoolingDown: boolean;
}

export function createFloorManager(initialIdx = 0): FloorManagerState {
    return {
        curFloorIdx: initialIdx,
        prevFloorIdx: initialIdx,
        triggerHeld: false,
        dir: 0,
        isCoolingDown: false,
    };
}

// Above this much under a floor the feet count as on it: the next floor shows up near the top of a staircase
const FLOOR_SNAP_BELOW = 0.3;

/**
 * Index of the floor the feet are on: the highest floor whose height they reached (lowest floor when under all of them)
 * @param feetY world height of the user's feet
 */
export function floorIndexAtHeight(map: SceneMap, feetY: number): number {
    let best = -1;
    for (let i = 0; i < map.levels.length; i++) {
        const { floorY } = map.levels[i];
        if (feetY >= floorY - FLOOR_SNAP_BELOW && (best < 0 || floorY > map.levels[best].floorY)) best = i;
    }
    if (best >= 0) return best;
    for (let i = 0; i < map.levels.length; i++) {
        if (best < 0 || map.levels[i].floorY < map.levels[best].floorY) best = i;
    }
    return Math.max(0, best);
}

/**
 * Follow the player's height (walking up stairs, Y / X buttons): the current floor becomes the one under their feet.
 * Not while the trigger previews another floor
 */
export function syncFloorWithHeight(state: FloorManagerState, map: SceneMap, feetY: number): void {
    if (state.triggerHeld || map.levels.length === 0) return;
    state.curFloorIdx = floorIndexAtHeight(map, feetY);
    state.prevFloorIdx = state.curFloorIdx;
}

/**
 * Returns the currently targeted floor index (preview floor while trigger is held, or confirmed current floor)
 */
export function getActiveFloorIdx(state: FloorManagerState): number {
    return state.triggerHeld ? state.prevFloorIdx : state.curFloorIdx;
}

export function updateFloorManager(
    state: FloorManagerState,
    map: SceneMap,
    session: XRSession | null,
    player: THREE.Group,
    camera: THREE.Camera
): void {
    if (!session) return;

    let gp: Gamepad | null = null;
    for (const src of session.inputSources) {
        if (src.handedness === 'right' && src.gamepad) {
            gp = src.gamepad;
            break;
        }
    }
    if (!gp) return;

    const triggerVal = gp.buttons[0]?.value ?? 0;
    const joystickY = gp.axes[3] ?? 0;

    const wasHeld = state.triggerHeld;
    state.triggerHeld = triggerVal > TRIGGER_THRESHOLD;

    // TODO: navigate through multiple floors
    if (state.triggerHeld) {
        if (joystickY < -JOYSTICK_THRESHOLD)
            state.dir = 1;
        else if (joystickY > JOYSTICK_THRESHOLD)
            state.dir = -1;
        else
            state.dir = 0;

        const target = state.curFloorIdx + state.dir;
        state.prevFloorIdx = Math.max(0, Math.min(map.levels.length - 1, target));

    } else if (wasHeld) {
        const target = state.curFloorIdx + state.dir;

        if (state.dir !== 0 && target >= 0 && target < map.levels.length) {
            state.curFloorIdx = target;
            const level = map.levels[target];
            placePlayerOnFloor(player, camera, level.spawnPoint.x, level.floorY, level.spawnPoint.z);

            // avoid spamming command
            state.isCoolingDown = true;
            setTimeout(() => { state.isCoolingDown = false; }, COOLDOWN_MS);
        }
        state.dir = 0;
        state.prevFloorIdx = state.curFloorIdx;
    }
}
