import * as THREE from 'three';
import type { SceneMap } from './minimap.js';
import type { VRMinimap3D } from './minimap3D.ts';
import type { FloorManagerState } from './floorManager.js';
import { placePlayerOnFloor } from './player.js';
import type { Notify } from './feedback.js';
import type { ControllerRay } from './controllerRay.js';

/**
 * Navigation from the minimap: the right controller points at the maquette in the left hand.
 * While it does, its stick up / down shows the floor above / below on the maquette and its trigger takes the player
 * to the pointed spot of the shown floor. Elsewhere, the right controller does as usual (trigger + stick: floors)
 */

const TRIGGER_THRESHOLD = 0.5;
const BROWSE_THRESHOLD = 0.7;
const BROWSE_REARM = 0.3; // the stick has to come back near the centre before the next floor
// The browsed floor stays shown this long after the ray leaves it: another floor's shape may not be under the ray
const BROWSE_KEEP_MS = 1500;

export interface MinimapPointer {
    /**
     * Once per frame in VR, after ray.update() and before the floor manager
     * @param enabled pointing allowed (not in edit mode, the maquette shown...)
     */
    update: (minimap: VRMinimap3D | null, map: SceneMap | null, floorState: FloorManagerState, enabled: boolean) => void;
    /** The right controller's stick and trigger are the pointer's this frame: the floor manager must ignore them */
    readonly isActive: boolean;
    /** Floor shown on the maquette while pointing (browsed with the stick), null when not pointing */
    readonly shownFloorIdx: number | null;
}

export function createMinimapPointer(
    ray: ControllerRay,
    player: THREE.Group,
    camera: THREE.Camera,
    notify: Notify,
): MinimapPointer {
    let isActive = false;
    let shownFloorIdx: number | null = null;
    let triggerWasHeld = false;
    // the trigger went down while pointing: until it's released it stays the pointer's
    let triggerFromPointer = false;
    let browseArmed = true;
    let lastHitAt = -Infinity;

    return {
        get isActive() { return isActive; },
        get shownFloorIdx() { return shownFloorIdx; },

        update(minimap, map, floorState, enabled) {
            const gamepad = ray.gamepad;
            const triggerHeld = (gamepad?.buttons[0]?.value ?? 0) > TRIGGER_THRESHOLD;
            const triggerPressed = triggerHeld && !triggerWasHeld;
            triggerWasHeld = triggerHeld;
            if (!triggerHeld) triggerFromPointer = false;

            // The floor manager has the trigger (held before pointing): leave it alone until released
            if (!enabled || !gamepad || !minimap || !map || map.levels.length === 0 || floorState.triggerHeld) {
                shownFloorIdx = null;
                minimap?.setAimMarker(null);
                isActive = triggerFromPointer;
                return;
            }

            if (shownFloorIdx === null) shownFloorIdx = floorState.curFloorIdx;
            minimap.setFloorHighlight(shownFloorIdx, shownFloorIdx !== floorState.curFloorIdx);
            const hit = minimap.pick(ray.raycaster);

            if (!hit) {
                minimap.setAimMarker(null);
                if (performance.now() - lastHitAt > BROWSE_KEEP_MS) shownFloorIdx = null;
                ray.show(null);
                isActive = triggerFromPointer;
                return;
            }

            isActive = true;
            lastHitAt = performance.now();
            ray.show(hit.world.distanceTo(ray.origin));
            minimap.setAimMarker(hit.world);

            // Stick up / down: show the floor above / below (stick up = negative axis value)
            const stickY = gamepad.axes[3] ?? 0;
            if (browseArmed && Math.abs(stickY) > BROWSE_THRESHOLD) {
                browseArmed = false;
                const next = shownFloorIdx + (stickY < 0 ? 1 : -1);
                if (next < 0 || next >= map.levels.length) {
                    notify('right', 'refused', stickY < 0 ? 'Pas d\'étage au-dessus' : 'Pas d\'étage en dessous');
                } else {
                    shownFloorIdx = next;
                    notify('right', 'tick', `Étage ${map.levels[next].id}`);
                }
            } else if (Math.abs(stickY) < BROWSE_REARM) {
                browseArmed = true;
            }

            // Trigger: go to the pointed spot of the shown floor
            if (triggerPressed) {
                triggerFromPointer = true;
                const level = map.levels[shownFloorIdx];
                placePlayerOnFloor(player, camera, hit.model.x, hit.model.y, hit.model.z);
                floorState.curFloorIdx = shownFloorIdx;
                floorState.prevFloorIdx = shownFloorIdx;
                notify('right', 'done', level ? `Étage ${level.id}` : 'Téléporté');
            }
        },
    };
}
