import * as THREE from 'three';
import { loadGLB } from './glbLoader.js';

// Runs the floor-detection raycast off the main thread so the launch phase
// doesn't freeze the page. Reloads the GLB here (via loadGLB, same transform as
// the main thread) because a THREE.Scene can't be transferred across threads.
self.onmessage = async (e: MessageEvent<{ modelPath: string; gridSize: number; normalThreshold: number }>) => {
    const { modelPath, gridSize, normalThreshold } = e.data;

    const model = await loadGLB(modelPath);
    const scene = new THREE.Scene();
    scene.add(model);

    const box = new THREE.Box3().setFromObject(scene);
    const { min, max } = box;
    const cols = Math.ceil((max.x - min.x) / gridSize);
    const rows = Math.ceil((max.z - min.z) / gridSize);

    const raycaster = new THREE.Raycaster();
    const downDir = new THREE.Vector3(0, -1, 0);
    const normalMat = new THREE.Matrix3();
    const rayOriginY = max.y + 1;

    const allHits: { r: number; c: number; y: number }[] = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const x = min.x + (c + 0.5) * gridSize;
            const z = min.z + (r + 0.5) * gridSize;

            raycaster.set(new THREE.Vector3(x, rayOriginY, z), downDir);
            const intersects = raycaster.intersectObject(scene, true);

            for (const hit of intersects) {
                if (!hit.face)
                    continue;

                normalMat.getNormalMatrix(hit.object.matrixWorld);
                const worldNormal = hit.face.normal.clone().applyMatrix3(normalMat).normalize();
                if (worldNormal.y > normalThreshold) {
                    allHits.push({ r, c, y: hit.point.y });
                }
            }
        }
    }

    (self as unknown as Worker).postMessage(allHits);
};
