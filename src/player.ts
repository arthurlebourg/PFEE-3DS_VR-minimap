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
const MIN_REAL_EYE_HEIGHT = 0.5;

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
    const head = camera.position;
    const eyeHeight = head.y > MIN_REAL_EYE_HEIGHT ? head.y : DEFAULT_EYE_HEIGHT;
    player.position.set(x - head.x, floorY + eyeHeight - head.y, z - head.z);
}
