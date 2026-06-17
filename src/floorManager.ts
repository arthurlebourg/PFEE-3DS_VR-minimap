import * as THREE from 'three';

import type { SceneMap } from './minimap.js';
import { teleportTo } from './xrMove.ts';

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

export function updateFloorManager(
    state: FloorManagerState,
    map: SceneMap,
    session: XRSession | null,
    player: THREE.Group
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
        console.log(target)

    } else if (wasHeld) {
        const target = state.curFloorIdx + state.dir;

        if (state.dir !== 0 && target >= 0 && target < map.levels.length) {
            state.curFloorIdx = target;
            const spawn = map.levels[target].spawnPoint;

            const EYE_HEIGHT = 1.65;
            player.position.set(spawn.x, spawn.y - EYE_HEIGHT, spawn.z);

            // avoid spamming command
            state.isCoolingDown = true;
            setTimeout(() => { state.isCoolingDown = false; }, COOLDOWN_MS);
        }
        state.dir = 0;
        state.prevFloorIdx = state.curFloorIdx;
    }
}
