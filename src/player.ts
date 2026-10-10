import * as THREE from 'three';

const direction = new THREE.Vector3();
const right = new THREE.Vector3();

export function createPlayer(camera : THREE.Camera): THREE.Group
{
    const player = new THREE.Group();

    player.add(camera);

    return player;
}

export function updateMovement(player : THREE.Group, camera : THREE.Camera, joystick : { x: number, y: number })
{
    const speed = 0.05;

    camera.getWorldDirection(direction);

    direction.y = 0;
    direction.normalize();

    right.crossVectors(direction, camera.up).normalize();

    player.position.addScaledVector(direction, -joystick.y * speed);
    player.position.addScaledVector(right, joystick.x * speed);
}