import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { loadGLB } from './glbLoader.js';
import { createPlayer, updateMovement, placePlayerOnFloor } from './player.js';
import {
    saveSceneMapAsFile, loadSceneMapFromFile,
    renderMinimap, createVRMinimap,
    type VRMinimap,
} from './minimap.js';
import { createFloorManager, updateFloorManager } from './floorManager.js';
import { initXrMove, teleportTo } from './xrMove.ts';
import { createDebugFloorOverlay } from './debugMinimap.ts';
import { buildSceneMap, type HistogramBin } from './minimapBuilder.js';
import { createEditMode, createEditModeInputHandler } from './editMode.js';
import { createDesktopConfigPanel, createVRConfigPanel, renderConfigPanel, type VRConfigPanel } from './configPanel.js';
import { commitFloorMove, type MapContext } from './floorAdjust.js';
import { createFloorMoveVisual, type FloorMoveVisual } from './floorAdjustVisuals.js';
import { createHistogramHud, createDesktopHistogramPanel, renderHistogram, type HistogramHud } from './histogramPanel.js';
import { createLoadingBar } from './loadingBar.js';

// Patch XRWebGLBinding bug
if ('XRWebGLBinding' in window) delete (window as any).XRWebGLBinding;

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.cameraAutoUpdate = false;
document.body.appendChild(renderer.domElement);

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
// const MODEL_PATH = '/models/apartment_2_4f7f_in_japan.glb';
// const MODEL_PATH = '/models/plant-3.glb';
// https://sketchfab.com/3d-models/airbus-a380-2370a0adb0a140fe962972effcd08cbb
//const MODEL_PATH = '/models/airbus_a380.glb';
// https://sketchfab.com/3d-models/interactive-architectural-building-model-a3f9604202514c38a4fb7a719fe8af6a
// https://sketchfab.com/3d-models/backrooms-vr-1a5c397f0a43408fa38b09ea5c041149
// const MODEL_PATH = '/models/backrooms_vr.glb';
const MODEL_PATH = '/models/castle_v.glb';
const MAP_PATH = "/maps/sceneMap.json";
const model = await loadGLB(MODEL_PATH);
scene.add(model);

// SceneMap
const loadingBar = createLoadingBar();

const defaultConfig = {
    gridSize: 0.5,
    minWalkableArea: 1.0,
    normalThreshold: 0.7,
    voxYThr: 0.35,
    minFloorGap: 0.4,
    histoHeightSize: 0.15,
    minPeakArea: 2,
    // Wall detection
    wallScanHeight: 1.0, // metres above floorY where horizontal rays are fired
    wallNormalThreshold: 0.3, // |normal.y| < this => wall (0 = perfectly vertical only)
    wallRayLength: 0.25, // max ray length (≈ gridSize * 1.25)
    // Ground variation connectors
    minStairArea: 0.15, // m², filters out single-cell raycast noise
    maxStairArea: 10, // m², > treat as sub-level, not staircase
    stairMaxStepRise: 0.4, // m, max Y rise accepted per grid cell while climbing
    stairFlatTolerance: 0.03, // m, |deltaY| under this still counts as a flat step
    maxLandingRun: 1.2, // m, max consecutive flat run before considering that's a dead end
    // Room segmentation
    doorWidth: 1.0, // openings narrower than this (m) split two rooms
    minRoomArea: 1.5, // rooms smaller than this (m²) are merged into a neighbour
    minRoomWidth: 0.5, // rooms narrower than this everywhere (m) are removed (gaps between two walls)
    corridorMaxWidth: 2.0, // mean width (m) under which a long room...
    corridorMinElongation: 4.0, // ...with length / width above this is a corridor
};

console.log("Minimap existence check")
let sceneMap = await loadSceneMapFromFile(MAP_PATH);
console.log(sceneMap);
let histogram: HistogramBin[] = [];
if (!sceneMap) {
    loadingBar.show();
    const built = await buildSceneMap(model, defaultConfig, loadingBar.set);
    loadingBar.hide();
    sceneMap = built.map;
    histogram = built.histogram;
}

let debugOverlay = createDebugFloorOverlay(scene, sceneMap!);

// Edit mode - live minimap config tuning (desktop panel + in-VR panel)
const editMode = createEditMode(defaultConfig);

let floorMoveVisual: FloorMoveVisual | null = null;
let floorMoveVisualFloorId = -1;

function disposeFloorMoveVisual(): void {
    if (floorMoveVisual) {
        floorMoveVisual.dispose();
        floorMoveVisual = null;
        floorMoveVisualFloorId = -1;
    }
}

function getMapContext(): MapContext {
    return { levelCount: sceneMap!.levels.length, gridSize: sceneMap!.gridSize, levels: sceneMap!.levels };
}

async function rebuildMinimap(): Promise<void> {
    if (editMode.isRebuilding) return;
    editMode.isRebuilding = true;

    loadingBar.show();
    const built = await buildSceneMap(model, editMode.config, loadingBar.set);
    loadingBar.hide();

    // render loop keeps running during the build: swap the old map only once the new one is ready
    debugOverlay.dispose();
    disposeFloorMoveVisual();
    sceneMap = built.map;
    histogram = built.histogram;
    debugOverlay = createDebugFloorOverlay(scene, sceneMap);

    floorState.curFloorIdx = Math.min(floorState.curFloorIdx, sceneMap.levels.length - 1);
    floorState.prevFloorIdx = floorState.curFloorIdx;
    editMode.floors.selectedFloorIdx = Math.min(editMode.floors.selectedFloorIdx, sceneMap.levels.length - 1);

    editMode.isRebuilding = false;
    editMode.isDirty = false;
}

function saveMinimap(): void {
    if (sceneMap) saveSceneMapAsFile(sceneMap);
}

function confirmFloorMove(): void {
    if (!sceneMap) return;
    const level = sceneMap.levels[editMode.floors.selectedFloorIdx];
    if (!level) return;

    commitFloorMove(editMode.floors, level, sceneMap.gridSize);

    debugOverlay.dispose();
    debugOverlay = createDebugFloorOverlay(scene, sceneMap);
    disposeFloorMoveVisual();
}

function ensureFloorMoveVisual(): void {
    if (!sceneMap || !editMode.active || editMode.panel !== 'floors') {
        disposeFloorMoveVisual();
        return;
    }

    const level = sceneMap.levels[editMode.floors.selectedFloorIdx];
    if (!level) return;

    if (!floorMoveVisual || floorMoveVisualFloorId !== level.id) {
        disposeFloorMoveVisual();
        floorMoveVisual = createFloorMoveVisual(scene, sceneMap, level);
        floorMoveVisualFloorId = level.id;
    }

    floorMoveVisual.update(editMode.floors);
}

const desktopConfigPanel = createDesktopConfigPanel(editMode, rebuildMinimap, saveMinimap, confirmFloorMove, getMapContext);
const editModeInputUpdate = createEditModeInputHandler(editMode, rebuildMinimap, saveMinimap, confirmFloorMove, getMapContext);
const desktopHistogramPanel = createDesktopHistogramPanel();

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

// Spawn is applied on the first frame with a tracked headset pose, the pose isn't known yet at sessionstart
let spawnPending = false;

renderer.xr.addEventListener('sessionstart', () => {
    spawnPending = true;
});

function trySpawn(): void {
    const frame = renderer.xr.getFrame();
    const refSpace = renderer.xr.getReferenceSpace();
    if (!frame || !refSpace || !frame.getViewerPose(refSpace)) return;

    const level = sceneMap!.levels[floorState.curFloorIdx];
    placePlayerOnFloor(player, camera, level.spawnPoint.x, level.floorY, level.spawnPoint.z);
    spawnPending = false;
}

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

// Edit mode panel (right grip) — A button toggles, B button rebuilds
const rightGrip = renderer.xr.getControllerGrip(1);
let vrConfigPanel: VRConfigPanel | null = null;

renderer.xr.addEventListener('sessionstart', () => {
    vrConfigPanel = createVRConfigPanel(rightGrip, 256);
});

renderer.xr.addEventListener('sessionend', () => {
    if (vrConfigPanel) {
        rightGrip.remove(vrConfigPanel.mesh);
        vrConfigPanel.texture.dispose();
        vrConfigPanel = null;
    }
});

// Histogram HUD on right grip (just to the left of the edit mode config panel)
let histogramHud: HistogramHud | null = null;

renderer.xr.addEventListener('sessionstart', () => {
    histogramHud = createHistogramHud(rightGrip);
});

renderer.xr.addEventListener('sessionend', () => {
    if (histogramHud) {
        histogramHud.dispose();
        histogramHud = null;
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

// Room / corridor ids on the minimap, toggled with L
let showRoomLabels = true;

// Floor state
const floorState = createFloorManager(0);

// VR button only once everything is set up: entering VR earlier would miss the sessionstart listeners (spawn, minimap...)
document.body.appendChild(VRButton.createButton(renderer));

// Main
const playerDir = new THREE.Vector3();
const headPos = new THREE.Vector3();
const timer = new THREE.Timer();

renderer.setAnimationLoop(() => {
    timer.update();
    renderer.xr.updateCamera(camera);
    if (spawnPending) trySpawn();

    if (!floorState.isCoolingDown) {
        updateMovement(player, camera, getVRJoystick());
    }

    editModeInputUpdate(renderer.xr.getSession(), timer.getDelta());

    if (!editMode.active) {
        updateFloorManager(floorState, sceneMap!, renderer.xr.getSession(), player, camera);
    }

    if (vrMinimap) {
        camera.getWorldDirection(playerDir);
        camera.getWorldPosition(headPos); // headset, not the player origin: they differ by the user's position in the play area
        const currentFloor = sceneMap!.levels[floorState.curFloorIdx];
        renderMinimap(sceneMap!, currentFloor, headPos, playerDir, vrMinimap.canvas, 256, floorState, showRoomLabels);
        vrMinimap.texture.needsUpdate = true;
    }

    ensureFloorMoveVisual();

    if (vrConfigPanel) {
        vrConfigPanel.mesh.visible = editMode.active;
        if (editMode.active) {
            renderConfigPanel(editMode, getMapContext(), vrConfigPanel.canvas, 256);
            vrConfigPanel.texture.needsUpdate = true;
        }
    }

    if (histogramHud) {
        histogramHud.mesh.visible = editMode.active;
        if (editMode.active) {
            renderHistogram(histogram, sceneMap!.levels, histogramHud.canvas);
            histogramHud.texture.needsUpdate = true;
        }
    }

    desktopHistogramPanel.setVisible(editMode.active);
    if (editMode.active) renderHistogram(histogram, sceneMap!.levels, desktopHistogramPanel.canvas);

    desktopConfigPanel.sync();

    renderer.render(scene, camera);
});

// Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Display debug overlay
window.addEventListener('keydown', e => {
    if (e.key === 'h' || e.key === 'H') debugOverlay.toggle();
    if (e.key === 'l' || e.key === 'L') showRoomLabels = !showRoomLabels;
    if (e.key === 'e' || e.key === 'E') {
        editMode.active = !editMode.active;
        desktopConfigPanel.sync();
    }
    if ((e.key === 'r' || e.key === 'R') && editMode.active) rebuildMinimap();
});
