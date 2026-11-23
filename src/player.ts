import * as THREE from 'three';

const direction = new THREE.Vector3();
const right = new THREE.Vector3();

export function createPlayer(camera: THREE.Camera): THREE.Group {
    const player = new THREE.Group();
    player.add(camera);
    return player;
}

export function updateMovement(
    player: THREE.Group,
    camera: THREE.Camera,
    joystick: { x: number; y: number }
): void {
    const speed = 0.05;

    camera.getWorldDirection(direction);
    direction.y = 0;
    direction.normalize();

    right.crossVectors(direction, camera.up).normalize();

    player.position.addScaledVector(direction, -joystick.y * speed);
    player.position.addScaledVector(right, joystick.x * speed);
}

/**
 * Height of the eyes above the virtual floor, the same at every session: the headset's own floor isn't reliable
 * (seated user, floor calibrated wrong, 'local' reference space with its origin at the head), it gave a different
 * height at each session. Crouching and standing up still move the view, relative to this
 */
export const VIRTUAL_EYE_HEIGHT = 1.65;

/**
 * Height of the virtual floor in the player's space (the reference space): the headset height at calibration
 * minus VIRTUAL_EYE_HEIGHT. 0 when the reference space origin is on the floor and the user is VIRTUAL_EYE_HEIGHT tall
 */
let floorOffsetY = 0;

/**
 * Take the current headset height as standing at VIRTUAL_EYE_HEIGHT. Once per session, at the spawn:
 * call it once camera.position holds an XR pose
 * @return headset height in the reference space, for logs
 */
export function calibrateEyeHeight(camera: THREE.Camera): number {
    floorOffsetY = camera.position.y - VIRTUAL_EYE_HEIGHT;
    return camera.position.y;
}

/**
 * Move the player so the headset (not the player origin) stands at (x, z) on the floor at floorY,
 * the eyes VIRTUAL_EYE_HEIGHT above it if the user stands as at the calibration
 * @param player Player group, parent of the camera
 * @param camera XR camera, its position = headset pose relative to the player
 */
export function placePlayerOnFloor(
    player: THREE.Group,
    camera: THREE.Camera,
    x: number,
    floorY: number,
    z: number,
): void {
    // headset offset from the player origin, turned by the player's snap turns
    const head = headOffset.copy(camera.position).applyQuaternion(player.quaternion);
    player.position.set(x - head.x, floorY - floorOffsetY, z - head.z);
}

const headOffset = new THREE.Vector3();
const headBefore = new THREE.Vector3();
const headAfter = new THREE.Vector3();

/** Height of the user's feet (the virtual floor under them) in the world, crouching doesn't change it */
export function getFeetY(player: THREE.Group): number {
    return player.position.y + floorOffsetY;
}

/**
 * Turn the player about the vertical through the headset (not the play area origin), so the view turns in place
 * @param angle radians, positive = to the left
 */
export function snapTurn(player: THREE.Group, camera: THREE.Camera, angle: number): void {
    camera.getWorldPosition(headBefore);
    player.rotation.y += angle;
    player.updateMatrixWorld(true);
    camera.getWorldPosition(headAfter);
    player.position.x += headBefore.x - headAfter.x;
    player.position.z += headBefore.z - headAfter.z;
}
