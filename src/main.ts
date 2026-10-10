import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { loadGLB } from './glbLoader.js';
import { createPlayer, updateMovement, placePlayerOnFloor } from './player.js';
import {
    saveSceneMapAsFile, loadSceneMapFromFile,
    renderMinimap, renderMinimapStatus, createVRMinimap,
    type VRMinimap, type SceneMap, type MinimapConfig, type MinimapStatus, type FloorLevel,
} from './minimap.js';
import { createFloorManager, updateFloorManager } from './floorManager.js';
import { initXrMove } from './xrMove.ts';
import { createDebugFloorOverlay, type DebugFloorOverlay } from './debugMinimap.ts';
import { buildSceneMap, type HistogramBin } from './minimapBuilder.js';
import { createEditMode, createEditModeInputHandler, getRebuildAction, setCategoryOpen } from './editMode.js';
import { createDesktopConfigPanel, createVRConfigPanel, renderConfigPanel, type VRConfigPanel } from './configPanel.js';
import { commitFloorMove, type MapContext } from './floorAdjust.js';
import { createFloorMoveVisual, type FloorMoveVisual } from './floorAdjustVisuals.js';
import { createHistogramHud, createDesktopHistogramPanel, renderHistogram, type HistogramHud } from './histogramPanel.js';
import { createLoadingBar } from './loadingBar.js';
import { createStartScreen, type StartSelection } from './startScreen.js';

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

const defaultConfig: MinimapConfig = {
    gridSize: 0.5,
    minWalkableArea: 1.0,
    normalThreshold: 0.7,
    voxYThr: 0.35,
    minFloorGap: 0.4,
    histoHeightSize: 0.15,
    minPeakArea: 2,
    floorOpeningRadius: 2, // cells, opening by reconstruction: areas with nothing wider than this disk are noise and removed (0 = off)
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

// Start screen: pick a model from models/ and one of its maps from maps/ (or none), then load them.
// A failed load goes back to the selection
const MB = 1024 * 1024;
const startScreen = createStartScreen();

async function loadSelection(): Promise<{
    selection: StartSelection;
    model: THREE.Group;
    modelSha1: string | null;
    map: SceneMap | null;
}> {
    for (;;) {
        const selection = await startScreen.waitForSelection();
        try {
            startScreen.setProgress(0, 'Téléchargement du modèle…');
            const { model, sha1 } = await loadGLB(`/models/${encodeURIComponent(selection.modelFile)}`, (loaded, total) => {
                if (total === 0) startScreen.setProgress(null, `Téléchargement du modèle… ${(loaded / MB).toFixed(0)} Mo`);
                else if (loaded < total) startScreen.setProgress(loaded / total, `Téléchargement du modèle… ${(loaded / MB).toFixed(0)} / ${(total / MB).toFixed(0)} Mo`);
                else startScreen.setProgress(null, 'Préparation du modèle…');
            });

            let map: SceneMap | null = null;
            if (selection.mapFile) {
                startScreen.setProgress(null, 'Chargement de la carte…');
                map = await loadSceneMapFromFile(`/maps/${encodeURIComponent(selection.mapFile)}`, sha1);
                if (!map) console.warn(`SceneMap: ${selection.mapFile} couldn't be loaded, building the map instead`);
            }
            return { selection, model, modelSha1: sha1, map };
        } catch (e) {
            startScreen.showError(`Échec du chargement de ${selection.modelFile} : ${e instanceof Error ? e.message : e}`);
        }
    }
}

const { selection, model, modelSha1, map: loadedMap } = await loadSelection();
startScreen.close();
scene.add(model);
const modelBounds = new THREE.Box3().setFromObject(model);

// SceneMap: null until loaded or built. Building runs in the background: the scene is usable meanwhile
let sceneMap: SceneMap | null = loadedMap;
let histogram: HistogramBin[] = [];
let buildError: string | null = null;
const loadingBar = createLoadingBar();

let debugOverlayVisible = true;
let debugOverlay: DebugFloorOverlay | null = sceneMap ? createDebugFloorOverlay(scene, sceneMap) : null;

// Floor state
const floorState = createFloorManager(0);

/** Floor the player is on, null while there's no map (or the map found no floor) */
function currentLevel(): FloorLevel | null {
    return sceneMap?.levels[floorState.curFloorIdx] ?? null;
}

// Edit mode - live minimap config tuning (desktop panel + in-VR panel).
// Starts from the config the current map was built with (a loaded map may differ from defaultConfig);
// params added since that map was saved fall back to defaultConfig.
const editMode = createEditMode(defaultConfig, { ...defaultConfig, ...sceneMap?.config });

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
    if (!sceneMap) return { levelCount: 0, gridSize: editMode.config.gridSize, levels: [] };
    return { levelCount: sceneMap.levels.length, gridSize: sceneMap.gridSize, levels: sceneMap.levels };
}

function recreateDebugOverlay(): void {
    debugOverlay?.dispose();
    debugOverlay = sceneMap ? createDebugFloorOverlay(scene, sceneMap) : null;
    if (debugOverlay && !debugOverlayVisible) debugOverlay.toggle();
}

// Background build: pauses often in VR so the headset keeps its framerate, less on desktop for a faster build
const VR_BUILD_SLICE_MS = 8;
const DESKTOP_BUILD_SLICE_MS = 30;
let buildController: AbortController | null = null;

/**
 * Build the map of the model with the edit mode config, in the background. A build already running
 * is restarted with the current config. The current map stays displayed until the new one is ready
 */
async function rebuildMinimap(): Promise<void> {
    buildController?.abort();
    const controller = new AbortController();
    buildController = controller;

    // the panels keep editing editMode.config during the build
    const config = { ...editMode.config };
    editMode.isRebuilding = true;
    editMode.isDirty = false;
    editMode.buildProgress = 0;
    editMode.buildLabel = '';
    buildError = null;
    loadingBar.set(0, '');
    loadingBar.show();

    try {
        const built = await buildSceneMap(
            model, config,
            (progress, label) => {
                if (buildController !== controller) return;
                editMode.buildProgress = progress;
                editMode.buildLabel = label;
                loadingBar.set(progress, label);
            },
            {
                signal: controller.signal,
                sliceMs: () => renderer.xr.isPresenting ? VR_BUILD_SLICE_MS : DESKTOP_BUILD_SLICE_MS,
            },
        );
        built.map.modelSha1 = modelSha1;
        applyMap(built.map, built.histogram);
    } catch (e) {
        if (controller.signal.aborted) return; // restarted or cancelled
        console.error('Minimap build failed:', e);
        buildError = e instanceof Error ? e.message : String(e);
        editMode.isDirty = true;
    } finally {
        if (buildController === controller) {
            buildController = null;
            editMode.isRebuilding = false;
            loadingBar.hide();
        }
    }
}

/** Stop the running build, the current map (if any) stays */
function cancelBuild(): void {
    if (!buildController) return;
    buildController.abort();
    buildController = null;
    editMode.isRebuilding = false;
    editMode.isDirty = true; // the edited config hasn't been applied
    loadingBar.hide();
}

/** Rebuild button of the VR panel: build, restart with the edited config, or stop */
function onRebuildButton(): void {
    if (getRebuildAction(editMode) === 'cancel') cancelBuild();
    else void rebuildMinimap();
}

function applyMap(map: SceneMap, bins: HistogramBin[]): void {
    const isFirstMap = sceneMap === null;

    disposeFloorMoveVisual();
    sceneMap = map;
    histogram = bins;
    recreateDebugOverlay();

    const lastLevel = Math.max(0, sceneMap.levels.length - 1);
    floorState.curFloorIdx = Math.min(floorState.curFloorIdx, lastLevel);
    floorState.prevFloorIdx = floorState.curFloorIdx;
    editMode.floors.selectedFloorIdx = Math.min(editMode.floors.selectedFloorIdx, lastLevel);

    // The player was placed without knowing the floors: move them to the spawn point, unless they walked away
    if (isFirstMap && spawnIsProvisional && renderer.xr.isPresenting) spawnPending = true;
}

function saveMinimap(): void {
    if (sceneMap) saveSceneMapAsFile(sceneMap, selection.modelFile);
}

function confirmFloorMove(): void {
    if (!sceneMap) return;
    const level = sceneMap.levels[editMode.floors.selectedFloorIdx];
    if (!level) return;

    commitFloorMove(editMode.floors, level, sceneMap.gridSize);

    recreateDebugOverlay();
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

const desktopConfigPanel = createDesktopConfigPanel(editMode, rebuildMinimap, cancelBuild, saveMinimap, confirmFloorMove, getMapContext);
const editModeInputUpdate = createEditModeInputHandler(editMode, onRebuildButton, saveMinimap, confirmFloorMove, getMapContext);
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
// Placed without a map (center of the model, on its lowest point) and hasn't moved since
let spawnIsProvisional = false;

renderer.xr.addEventListener('sessionstart', () => {
    spawnPending = true;
});

function trySpawn(): void {
    const frame = renderer.xr.getFrame();
    const refSpace = renderer.xr.getReferenceSpace();
    if (!frame || !refSpace || !frame.getViewerPose(refSpace)) return;

    const level = currentLevel();
    if (level) {
        placePlayerOnFloor(player, camera, level.spawnPoint.x, level.floorY, level.spawnPoint.z);
        spawnIsProvisional = false;
    } else {
        const center = modelBounds.getCenter(new THREE.Vector3());
        placePlayerOnFloor(player, camera, center.x, modelBounds.min.y, center.z);
        spawnIsProvisional = true;
    }
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

/** Shown on the VR minimap while there's no map to draw */
function getMinimapStatus(): MinimapStatus {
    // B only rebuilds from the config tab of the edit mode
    const rebuildHint = (action: string) => editMode.active && editMode.panel === 'config'
        ? `B : ${action}`
        : `A : edit mode, puis B : ${action}`;

    if (editMode.isRebuilding) {
        return {
            title: 'Calcul de la carte…',
            detail: editMode.buildLabel,
            progress: editMode.buildProgress,
            hints: editMode.active ? ['Paramètres modifiables pendant le calcul', rebuildHint('arrêter / relancer')] : ['A : edit mode (paramètres)'],
        };
    }
    if (buildError) {
        return { title: 'Échec du calcul', detail: buildError, progress: null, hints: [rebuildHint('relancer')] };
    }
    if (sceneMap) {
        return { title: 'Aucun sol détecté', detail: 'Ajuste les paramètres de détection des sols', progress: null, hints: [rebuildHint('recalculer')] };
    }
    return { title: 'Aucune carte', detail: 'Règle les paramètres puis lance le calcul', progress: null, hints: [rebuildHint('calculer')] };
}

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

// No map to start from: build it right away, or open the edit mode first to tune the parameters
// (the grid size, in General, is what makes a build long)
if (!sceneMap) {
    if (selection.autoBuild || selection.mapFile) {
        void rebuildMinimap();
    } else {
        editMode.active = true;
        editMode.panel = 'config';
        setCategoryOpen(editMode, 'general', true);
    }
}

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
        const joystick = getVRJoystick();
        if (joystick.x !== 0 || joystick.y !== 0) spawnIsProvisional = false;
        updateMovement(player, camera, joystick);
    }

    editModeInputUpdate(renderer.xr.getSession(), timer.getDelta());

    if (!editMode.active && sceneMap && sceneMap.levels.length > 0) {
        updateFloorManager(floorState, sceneMap, renderer.xr.getSession(), player, camera);
    }

    if (vrMinimap) {
        const level = currentLevel();
        if (sceneMap && level) {
            camera.getWorldDirection(playerDir);
            camera.getWorldPosition(headPos); // headset, not the player origin: they differ by the user's position in the play area
            renderMinimap(sceneMap, level, headPos, playerDir, vrMinimap.canvas, 256, floorState, showRoomLabels);
        } else {
            renderMinimapStatus(getMinimapStatus(), vrMinimap.canvas, 256);
        }
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

    const levels = sceneMap?.levels ?? [];
    if (histogramHud) {
        histogramHud.mesh.visible = editMode.active;
        if (editMode.active) {
            renderHistogram(histogram, levels, histogramHud.canvas);
            histogramHud.texture.needsUpdate = true;
        }
    }

    desktopHistogramPanel.setVisible(editMode.active);
    if (editMode.active) renderHistogram(histogram, levels, desktopHistogramPanel.canvas);

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
    if (e.key === 'h' || e.key === 'H') {
        debugOverlayVisible = !debugOverlayVisible;
        debugOverlay?.toggle();
    }
    if (e.key === 'l' || e.key === 'L') showRoomLabels = !showRoomLabels;
    if (e.key === 'e' || e.key === 'E') {
        editMode.active = !editMode.active;
        desktopConfigPanel.sync();
    }
    if ((e.key === 'r' || e.key === 'R') && editMode.active) void rebuildMinimap();
});
