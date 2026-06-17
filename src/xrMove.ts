import type * as THREE from 'three';

let _xrManager: THREE.WebGLRenderer['xr'] | null = null;
let _baseRefSpace: XRReferenceSpace | null = null;

export function initXrMove(xrRenderer: THREE.WebGLRenderer['xr']): void {
    _xrManager = xrRenderer;

    xrRenderer.addEventListener('sessionstart', () => {
        _baseRefSpace = xrRenderer.getReferenceSpace();
    });

    xrRenderer.addEventListener('sessionend', () => {
        _baseRefSpace = null;
    });
}

/**
 * deprecated -> use player.position.set()
 * Move the player with his reference space
 * @param x
 * @param y
 * @param z
 */
export function teleportTo(x: number, y: number, z: number): void {
    if (!_xrManager || !_baseRefSpace) {
        // desktop or not in emulator
        return;
    }

    const offsetTransform = new XRRigidTransform({ x: -x, y: -y, z: -z, w: 1 });
    const offsetSpace = _baseRefSpace.getOffsetReferenceSpace(offsetTransform);
    _xrManager.setReferenceSpace(offsetSpace);
}
