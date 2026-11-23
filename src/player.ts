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

// Eye height used when the XR reference space doesn't provide the user's real one
const DEFAULT_EYE_HEIGHT = 1.65;
// Under this, the headset Y isn't a real eye height: the reference space origin is at the head ('local'), not on the floor ('local-floor')
export const MIN_REAL_EYE_HEIGHT = 0.5;

/**
 * Move the player so the headset (not the player origin) stands at (x, z) on the floor at floorY.
 * Uses the headset pose in the reference space, so it works whether the origin is on the real floor
 * (real headset, 'local-floor') or at the head: call it once camera.position holds an XR pose
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
    const eyeHeight = camera.position.y > MIN_REAL_EYE_HEIGHT ? camera.position.y : DEFAULT_EYE_HEIGHT;
    player.position.set(x - head.x, floorY + eyeHeight - head.y, z - head.z);
}

const headOffset = new THREE.Vector3();
const headBefore = new THREE.Vector3();
const headAfter = new THREE.Vector3();

/**
 * Height of the user's feet in the world: the player origin is on the real floor with 'local-floor',
 * at the head with 'local' (then a default eye height is assumed)
 */
export function getFeetY(player: THREE.Group, camera: THREE.Camera): number {
    return camera.position.y > MIN_REAL_EYE_HEIGHT ? player.position.y : player.position.y + camera.position.y - DEFAULT_EYE_HEIGHT;
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
