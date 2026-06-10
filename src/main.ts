import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { loadGLB } from './glbLoader.js';
import { createPlayer, updateMovement } from './player.js';
import {
    saveSceneMapAsFile, loadSceneMapFromFile,
    renderMinimap, createVRMinimap,
    type VRMinimap,
} from './minimap.js';
import { createFloorManager, updateFloorManager } from './floorManager.js';
import { initXrMove, teleportTo } from './xrMove.ts';

import { buildSceneMap } from './minimapBuilder.js';

// Patch XRWebGLBinding bug
if ('XRWebGLBinding' in window) delete (window as any).XRWebGLBinding;

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.cameraAutoUpdate = false;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// Scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.position.set(3, 10, 10);
scene.add(dirLight);

// Model
const MODEL_PATH = '/models/apartment_2_4f7f_in_japan.glb';
const MAP_PATH = "/maps/sceneMap.json";
const model = await loadGLB(MODEL_PATH);
scene.add(model);

// SceneMap
const loadingEl = document.createElement('div');
loadingEl.textContent = 'Building minimap…';
Object.assign(loadingEl.style, {
    position: 'fixed', bottom: '80px', right: '16px',
    color: '#fff', fontFamily: 'monospace', fontSize: '12px',
});
document.body.appendChild(loadingEl);

console.log("Minimap existence check")
let sceneMap = await loadSceneMapFromFile(MAP_PATH);
console.log(sceneMap);
if (!sceneMap) {

    sceneMap = await buildSceneMap(scene, {
        gridSize: 1.0,
        minWalkableArea: 1.0,
        normalThreshold: 0.7,
        voxYThr: 1.0,
        minFloorGap: 1.8,
        histogramBinSize: 0.15,
        histogramMinDensity: 0.005,
    });

    saveSceneMapAsFile(sceneMap);
}

loadingEl.remove();

// Player
const player = createPlayer(camera);
scene.add(player);

// Controllers
function createControllerVisual(): THREE.Group {
    const group = new THREE.Group();

    const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.03, 0.1),
        new THREE.MeshStandardMaterial({ color: 0x222222 })
    );
    body.position.set(0, 0, -0.05);
    group.add(body);

    const ray = new THREE.Mesh(
        new THREE.CylinderGeometry(0.002, 0.002, 0.5),
        new THREE.MeshBasicMaterial({ color: 0x88aaff })
    );
    ray.rotation.x = Math.PI / 2;
    ray.position.set(0, 0, -0.3);
    group.add(ray);

    return group;
}

for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    player.add(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(createControllerVisual());
    player.add(grip);
}

// XR movement
initXrMove(renderer.xr);

renderer.xr.addEventListener('sessionstart', () => {
    const spawn = sceneMap!.levels[0].spawnPoint;
    teleportTo(spawn.x, spawn.y, spawn.z);
});

// Minimap
const leftGrip = renderer.xr.getControllerGrip(0);
let vrMinimap: VRMinimap | null = null;

renderer.xr.addEventListener('sessionstart', () => {
    vrMinimap = createVRMinimap(leftGrip, 256);
});

renderer.xr.addEventListener('sessionend', () => {
    if (vrMinimap) {
        leftGrip.remove(vrMinimap.mesh);
        vrMinimap.texture.dispose();
        vrMinimap = null;
    }
});

// Input
function getVRJoystick(): { x: number; y: number } {
    const session = renderer.xr.getSession();
    if (!session) return { x: 0, y: 0 };

    for (const source of session.inputSources) {
        if (source.handedness !== 'left') continue;
        const gp = source.gamepad;
        if (!gp) continue;
        const x = gp.axes[2] ?? 0;
        const y = gp.axes[3] ?? 0;
        if (Math.abs(x) > 0.1 || Math.abs(y) > 0.1) return { x, y };
    }
    return { x: 0, y: 0 };
}

// Floor state
const floorState = createFloorManager(0);

// Main
const playerDir = new THREE.Vector3();
const timer = new THREE.Timer();

renderer.setAnimationLoop(() => {
    timer.update();
    renderer.xr.updateCamera(camera);

    if (!floorState.isCoolingDown) {
        updateMovement(player, camera, getVRJoystick());
    }

    updateFloorManager(floorState, sceneMap!, renderer.xr.getSession());

    if (vrMinimap) {
        camera.getWorldDirection(playerDir);
        const currentFloor = sceneMap!.levels[floorState.curFloorIdx];
        renderMinimap(sceneMap!, currentFloor, player.position, playerDir, vrMinimap.canvas, 256, floorState);
        vrMinimap.texture.needsUpdate = true;
    }

    renderer.render(scene, camera);
});

// Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});