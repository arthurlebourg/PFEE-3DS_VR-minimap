import * as THREE from 'three';
import type { SceneMap } from './minimap.js';
import type { VRMinimap3D } from './minimap3D.ts';
import type { FloorManagerState } from './floorManager.js';
import { placePlayerOnFloor } from './player.js';
import type { Notify } from './feedback.js';

/**
 * Navigation from the minimap: the right controller points at the maquette in the left hand.
 * While it does, its stick up / down shows the floor above / below on the maquette and its trigger takes the player
 * to the pointed spot of the shown floor. Elsewhere, the right controller does as usual (trigger + stick: floors)
 */

const RAY_IDLE_LENGTH = 0.4; // m, the ray drawn while pointing at nothing
const RAY_IDLE_OPACITY = 0.3;
const RAY_AIM_OPACITY = 0.95;
const RAY_IDLE_COLOR = 0x88aaff;
const RAY_AIM_COLOR = 0xffee44;
const RAY_MAX_DISTANCE = 1.5; // m, the maquette is held at arm's length
const TRIGGER_THRESHOLD = 0.5;
const BROWSE_THRESHOLD = 0.7;
const BROWSE_REARM = 0.3; // the stick has to come back near the centre before the next floor
// The browsed floor stays shown this long after the ray leaves it: another floor's shape may not be under the ray
const BROWSE_KEEP_MS = 1500;

export interface MinimapPointer {
    /**
     * Once per frame in VR, before the floor manager
     * @param enabled pointing allowed (not in edit mode, the maquette shown...)
     */
    update: (minimap: VRMinimap3D | null, map: SceneMap | null, floorState: FloorManagerState, enabled: boolean) => void;
    /** The right controller's stick and trigger are the pointer's this frame: the floor manager must ignore them */
    readonly isActive: boolean;
    /** Floor shown on the maquette while pointing (browsed with the stick), null when not pointing */
    readonly shownFloorIdx: number | null;
}

/**
 * @param controllers target ray spaces of the controllers (renderer.xr.getController), the right one is found by its
 *                    'connected' event
 */
export function createMinimapPointer(
    controllers: THREE.XRTargetRaySpace[],
    player: THREE.Group,
    camera: THREE.Camera,
    notify: Notify,
): MinimapPointer {
    let rightController: THREE.Object3D | null = null;
    let rightSource: XRInputSource | null = null;
    const rays = new Map<THREE.Object3D, THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>();

    for (const controller of controllers) {
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
        const ray = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: RAY_IDLE_COLOR, transparent: true, opacity: RAY_IDLE_OPACITY }));
        ray.scale.z = RAY_IDLE_LENGTH;
        ray.visible = false;
        controller.add(ray);
        rays.set(controller, ray);

        controller.addEventListener('connected', (event) => {
            const source = event.data;
            if (source?.handedness === 'right') {
                rightController = controller;
                rightSource = source;
            } else if (rightController === controller) {
                rightController = null;
                rightSource = null;
            }
        });
        controller.addEventListener('disconnected', () => {
            if (rightController !== controller) return;
            rightController = null;
            rightSource = null;
        });
    }

    const raycaster = new THREE.Raycaster();
    raycaster.far = RAY_MAX_DISTANCE;
    const rayOrigin = new THREE.Vector3();
    const rayDirection = new THREE.Vector3();
    const rayQuat = new THREE.Quaternion();

    let isActive = false;
    let shownFloorIdx: number | null = null;
    let triggerWasHeld = false;
    // the trigger went down while pointing: until it's released it stays the pointer's
    let triggerFromPointer = false;
    let browseArmed = true;
    let lastHitAt = -Infinity;

    function stopPointing(minimap: VRMinimap3D | null): void {
        shownFloorIdx = null;
        minimap?.setAimMarker(null);
    }

    return {
        get isActive() { return isActive; },
        get shownFloorIdx() { return shownFloorIdx; },

        update(minimap, map, floorState, enabled) {
            for (const [controller, ray] of rays) ray.visible = enabled && controller === rightController;
            const gamepad = rightSource?.gamepad;
            const triggerHeld = (gamepad?.buttons[0]?.value ?? 0) > TRIGGER_THRESHOLD;
            const triggerPressed = triggerHeld && !triggerWasHeld;
            triggerWasHeld = triggerHeld;
            if (!triggerHeld) triggerFromPointer = false;

            // The floor manager has the trigger (held before pointing): leave it alone until released
            if (!enabled || !rightController || !gamepad || !minimap || !map || map.levels.length === 0 || floorState.triggerHeld) {
                stopPointing(minimap);
                isActive = triggerFromPointer;
                return;
            }

            const ray = rays.get(rightController)!;
            player.updateMatrixWorld(true);
            rightController.getWorldPosition(rayOrigin);
            rightController.getWorldQuaternion(rayQuat);
            rayDirection.set(0, 0, -1).applyQuaternion(rayQuat);
            raycaster.set(rayOrigin, rayDirection);

            if (shownFloorIdx === null) shownFloorIdx = floorState.curFloorIdx;
            minimap.setFloorHighlight(shownFloorIdx, shownFloorIdx !== floorState.curFloorIdx);
            const hit = minimap.pick(raycaster);

            if (!hit) {
                minimap.setAimMarker(null);
                if (performance.now() - lastHitAt > BROWSE_KEEP_MS) shownFloorIdx = null;
                ray.scale.z = RAY_IDLE_LENGTH;
                ray.material.color.setHex(RAY_IDLE_COLOR);
                ray.material.opacity = RAY_IDLE_OPACITY;
                isActive = triggerFromPointer;
                return;
            }

            isActive = true;
            lastHitAt = performance.now();
            ray.scale.z = hit.world.distanceTo(rayOrigin);
            ray.material.color.setHex(RAY_AIM_COLOR);
            ray.material.opacity = RAY_AIM_OPACITY;
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
