import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

export function loadGLB(path: string = "/models/apartment_2_4f7f_in_japan.glb"): Promise<THREE.Group> {
    return new Promise((resolve, reject) => {
        loader.load(path, (gltf) =>
            {
                const model = gltf.scene;
                model.position.set(0, 0, 0);
                model.scale.set(1, 1, 1);
                console.log('Model loaded successfully');
                resolve(model);
                // scene.add(model);
            },
            // log progress details disabled
            (xhr) => { /* console.log((xhr.loaded / xhr.total * 100) + '%'); */ },
            (error) => { console.error('Error loading model (check file path):', error); }
        );
    });
}
