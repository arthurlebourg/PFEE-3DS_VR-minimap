import * as THREE from 'three';
import { HUD_RENDER_ORDER } from './minimap.js';

/**
 * Helpers for the VR panels drawn on a canvas (menu, controls help, tutorial): the plane and its canvas, placing it
 * in front of the user, where the controller's ray hits it, clickable areas, text wrapping
 */

export interface CanvasPanel {
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    /** Drawing size, in canvas units (the canvas has pixelRatio times more pixels) */
    width: number;
    height: number;
    /** Clear the canvas and get its context, drawing in canvas units */
    begin: () => CanvasRenderingContext2D;
    /** Upload the drawing */
    commit: () => void;
    dispose: () => void;
}

/**
 * @param widthM / heightM plane size in metres
 * @param width / height drawing size in canvas units (same aspect)
 */
export function createCanvasPanel(widthM: number, heightM: number, width: number, height: number, pixelRatio = 2): CanvasPanel {
    const canvas = document.createElement('canvas');
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(widthM, heightM),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false }),
    );
    mesh.renderOrder = HUD_RENDER_ORDER;
    const ctx = canvas.getContext('2d')!;

    return {
        mesh, width, height,
        begin() {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            return ctx;
        },
        commit() { texture.needsUpdate = true; },
        dispose() {
            mesh.removeFromParent();
            mesh.geometry.dispose();
            mesh.material.dispose();
            texture.dispose();
        },
    };
}

const forward = new THREE.Vector3();

/**
 * Place an object in front of the head, level with the floor whatever the head's pitch, facing the head
 * @param object a child of the player, as the camera: camera.position / quaternion are the headset pose in its space
 * @param tilt radians about its X axis, negative = facing up towards the eyes
 */
export function placeInFrontOfHead(
    object: THREE.Object3D, camera: THREE.Camera,
    { distance, below, tilt }: { distance: number; below: number; tilt: number },
): void {
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    object.position.copy(camera.position).addScaledVector(forward, distance);
    object.position.y -= below;
    object.rotation.set(tilt, Math.atan2(-forward.x, -forward.z), 0, 'YXZ');
}

const hits: THREE.Intersection[] = [];

/** Where a ray hits a panel, in its canvas units from the top left corner; null if it misses (or the panel is hidden) */
export function panelPointAt(panel: CanvasPanel, raycaster: THREE.Raycaster): { x: number; y: number; distance: number; uv: THREE.Vector2 } | null {
    for (let o: THREE.Object3D | null = panel.mesh; o; o = o.parent) if (!o.visible) return null;
    panel.mesh.updateWorldMatrix(true, false);
    hits.length = 0;
    panel.mesh.raycast(raycaster, hits);
    const hit = hits.find(h => h.uv);
    if (!hit?.uv) return null;
    return { x: hit.uv.x * panel.width, y: (1 - hit.uv.y) * panel.height, distance: hit.distance, uv: hit.uv };
}

export interface Region<T> { x: number; y: number; w: number; h: number; target: T }

export function regionAt<T>(regions: Region<T>[], x: number, y: number): Region<T> | undefined {
    return regions.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

/** Split a text in lines no wider than maxWidth with the context's current font */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/** Rounded rectangle path */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}
