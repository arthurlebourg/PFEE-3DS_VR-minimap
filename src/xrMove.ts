import type * as THREE from 'three';
// import type { WebXLRenderer } from 'three';

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

export function teleportTo(x: number, y: number, z: number): void {
    if (!_xrManager || !_baseRefSpace) {
        // desktop or not in emulator
        return;
    }

    const offsetTransform = new XRRigidTransform({ x: -x, y: -y, z: -z, w: 1 });
    const offsetSpace = _baseRefSpace.getOffsetReferenceSpace(offsetTransform);
    _xrManager.setReferenceSpace(offsetSpace);
}

export function isXRActive(xrManager: THREE.WebGLRenderer['xr']): boolean {
    return xrManager.isPresenting;
}