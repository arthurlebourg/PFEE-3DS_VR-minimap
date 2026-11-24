import * as THREE from 'three';

/**
 * The right controller's aiming ray, shared by what it points at (the minimap, the edit panels): its pose as a
 * raycaster each frame, its gamepad, and the line drawn along it
 */

const RAY_IDLE_LENGTH = 0.4; // m, drawn while pointing at nothing
const RAY_IDLE_OPACITY = 0.3;
const RAY_AIM_OPACITY = 0.95;
const RAY_IDLE_COLOR = 0x88aaff;
const RAY_AIM_COLOR = 0xffee44;
const RAY_MAX_DISTANCE = 2; // m, what it points at is within reach

export interface ControllerRay {
    /**
     * Once per frame, first: takes the right controller's pose and hides the line (pointers show it again).
     * @return false without a right controller
     */
    update: (player: THREE.Object3D) => boolean;
    readonly raycaster: THREE.Raycaster;
    /** Ray start, world space */
    readonly origin: THREE.Vector3;
    readonly gamepad: Gamepad | null;
    /** Draw the line: short and faint pointing at nothing, up to the hit (highlighted) aiming at something */
    show: (hitDistance: number | null) => void;
}

/** @param controllers target ray spaces (renderer.xr.getController), the right one is found by its 'connected' event */
export function createControllerRay(controllers: THREE.XRTargetRaySpace[]): ControllerRay {
    let rightController: THREE.XRTargetRaySpace | null = null;
    let rightSource: XRInputSource | null = null;
    const lines = new Map<THREE.Object3D, THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>>();

    for (const controller of controllers) {
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
        const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: RAY_IDLE_COLOR, transparent: true, opacity: RAY_IDLE_OPACITY }));
        line.visible = false;
        controller.add(line);
        lines.set(controller, line);

        controller.addEventListener('connected', (event) => {
            if (event.data?.handedness === 'right') {
                rightController = controller;
                rightSource = event.data;
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
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const quat = new THREE.Quaternion();

    return {
        raycaster,
        origin,
        get gamepad() { return rightSource?.gamepad ?? null; },

        update(player) {
            for (const line of lines.values()) line.visible = false;
            if (!rightController || !rightSource?.gamepad) return false;
            player.updateMatrixWorld(true);
            rightController.getWorldPosition(origin);
            rightController.getWorldQuaternion(quat);
            direction.set(0, 0, -1).applyQuaternion(quat);
            raycaster.set(origin, direction);
            return true;
        },

        show(hitDistance) {
            const line = rightController ? lines.get(rightController) : undefined;
            if (!line) return;
            line.visible = true;
            const aiming = hitDistance !== null;
            line.scale.z = aiming ? hitDistance : RAY_IDLE_LENGTH;
            line.material.color.setHex(aiming ? RAY_AIM_COLOR : RAY_IDLE_COLOR);
            line.material.opacity = aiming ? RAY_AIM_OPACITY : RAY_IDLE_OPACITY;
        },
    };
}
