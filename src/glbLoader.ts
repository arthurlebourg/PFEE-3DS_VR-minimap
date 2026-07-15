import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// glTF format is supposed to be 1 unit = 1 meter but not every exporter respects that
// We fall back to a heuristic to snap the scale to the nearest power of 10
const PLAUSIBLE_HEIGHT_MIN = 2;   // a single low room
const PLAUSIBLE_HEIGHT_MAX = 30;  // a tall multi-floors building
const PLAUSIBLE_HEIGHT_MID = Math.sqrt(PLAUSIBLE_HEIGHT_MIN * PLAUSIBLE_HEIGHT_MAX);
const MAX_SCALE_POWER = 6; // clamp so a degenerate/flat bounding box can't produce an absurd scale

// Guess a uniform scale factor that brings the model's raw bounding box into a plausible real world size
function computeAutoScale(model: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const rawHeight = size.y || Math.max(size.x, size.z) || 1;

    if (rawHeight >= PLAUSIBLE_HEIGHT_MIN && rawHeight <= PLAUSIBLE_HEIGHT_MAX) return 1;

    const rawScale = PLAUSIBLE_HEIGHT_MID / rawHeight;
    const power = Math.max(-MAX_SCALE_POWER, Math.min(MAX_SCALE_POWER, Math.round(Math.log10(rawScale))));
    return Math.pow(10, power);
}

export function loadGLB(path: string = "/models/apartment_2_4f7f_in_japan.glb"): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
        loader.load(path, (gltf) =>
            {
                const model = gltf.scene;
                model.position.set(0, 0, 0);

                const scale = computeAutoScale(model);
                model.scale.setScalar(scale);
                console.log(`Model loaded successfully (auto-scale = ${scale})`);

                resolve(model);
            },
            // log progress details disabled
            (xhr) => { /* console.log((xhr.loaded / xhr.total * 100) + '%'); */ },
            (error) => { console.error('Error loading model (check file path):', error); }
        );
    });
}
