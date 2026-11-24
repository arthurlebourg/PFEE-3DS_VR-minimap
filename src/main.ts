import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadGLB } from './glbLoader.js';
import { createPlayer, updateMovement, placePlayerOnFloor, snapTurn, getFeetY, calibrateEyeHeight, VIRTUAL_EYE_HEIGHT } from './player.js';
import {
    saveSceneMapAsFile, loadSceneMapFromFile,
    type SceneMap, type MinimapConfig, type FloorLevel,
} from './minimap.js';
import { createFloorManager, updateFloorManager, getActiveFloorIdx, syncFloorWithHeight } from './floorManager.js';
import { createVRMinimap3D, MINIMAP_DISPLAY_MODES, type MinimapDisplayMode, type VRMinimap3D } from './minimap3D.ts';
import { initXrMove } from './xrMove.ts';
import { createDebugFloorOverlay, type DebugFloorOverlay } from './debugMinimap.ts';
import { buildSceneMap, type HistogramBin } from './minimapBuilder.js';
import { createEditMode, createEditModeInputHandler, getRebuildAction, setCategoryOpen } from './editMode.js';
import { createDesktopConfigPanel, createVRConfigPanel, renderConfigPanel, VR_PANEL_SIZE, type VRConfigPanel } from './configPanel.js';
import { commitFloorMove, hasPendingPreview, type MapContext } from './floorAdjust.js';
import { createFeedback } from './feedback.js';
import { createMinimapPointer } from './minimapPointer.js';
import { createFloorMoveVisual, type FloorMoveVisual } from './floorAdjustVisuals.js';
import { createHistogramHud, createDesktopHistogramPanel, renderHistogram, VR_HISTOGRAM_PIXEL_RATIO, type HistogramHud } from './histogramPanel.js';
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
renderer.localClippingEnabled = true;
document.body.appendChild(renderer.domElement);

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x121722);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.position.set(3, 10, 10);
scene.add(dirLight);

const defaultConfig: MinimapConfig = {
    gridSize: 0.1,
    minWalkableArea: 1.0,
    normalThreshold: 0.7,
    voxYThr: 0.15,
    minFloorGap: 0.4,
    histoHeightSize: 0.15,
    minPeakArea: 2,
    floorOpeningRadius: 5, // cells, opening by reconstruction: areas with nothing wider than this disk are noise and removed (0 = off)
    // Wall detection
    wallScanHeight: 1.3, // metres above floorY where horizontal rays are fired: above furniture, under door lintels
    wallNormalThreshold: 0.3, // |normal.y| < this => wall (0 = perfectly vertical only)
    // Ground variation connectors
    minStairArea: 0.15, // m², filters out single-cell raycast noise
    maxStairArea: 30, // m², > treat as sub-level, not staircase. Also holds the flat floor around the seed (see maxLandingRun)
    maxSlopeDeg: 60, // °, steepest slope a stair flood climbs: max Y rise per cell = gridSize * tan(maxSlopeDeg)
    stairFlatTolerance: 0.03, // m, |deltaY| under this still counts as a flat step (keep it well under the max rise per cell)
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
let histogram: HistogramBin[] = loadedMap?.histogram ?? [];
const loadingBar = createLoadingBar();

// Hidden at start, 'h' shows it
let debugOverlayVisible = false;
// 'g': only the stairs and their start / arrival cells
let debugStairsOnly = false;
let debugOverlay: DebugFloorOverlay | null = null;

// 3D Volumetric Minimap (Floating HUD anchored in field of view - 100% free hands).
// Created with the first map, rebuilt with each new one
const hudMinimapAnchor = new THREE.Group();
hudMinimapAnchor.name = 'hud-minimap-anchor';
camera.add(hudMinimapAnchor);

// In VR, things held in a hand: the 3D minimap in the left one, the edit mode panels in the right one.
// Moved onto the grip of the controller in that hand once it connects (the controller index doesn't tell the hand)
const handAnchors = { left: new THREE.Group(), right: new THREE.Group() };

// Vibration + short message above the hand for what the VR controls do
const feedback = createFeedback(renderer.xr, scene, handAnchors);

let vrMinimap3D: VRMinimap3D | null = null;
let hudMinimapVisible = true;

function refreshMinimap3D(): void {
    if (!sceneMap) return;
    if (vrMinimap3D) {
        vrMinimap3D.rebuild(sceneMap);
    } else {
        vrMinimap3D = createVRMinimap3D(hudMinimapAnchor, sceneMap);
        if (renderer.xr.isPresenting) vrMinimap3D.attachTo(handAnchors.left, 'hand');
        vrMinimap3D.setGridVisible(debugOverlayVisible);
        vrMinimap3D.setVisible(hudMinimapVisible);
    }
}

function toggleMinimap3D(): void {
    hudMinimapVisible = !hudMinimapVisible;
    hudMinimapAnchor.visible = hudMinimapVisible;
    if (vrMinimap3D) vrMinimap3D.setVisible(hudMinimapVisible);
    feedback.notify('left', 'tick', hudMinimapVisible ? 'Minimap affichée' : 'Minimap masquée');
}

const MINIMAP_DISPLAY_MODE_LABELS: Record<MinimapDisplayMode, string> = {
    solid: 'pleine',
    room: 'pièce',
    roomAndNeighbours: 'pièce + voisines',
};

// solid -> room -> room and neighbours -> solid
function cycleMinimapDisplayMode(): void {
    if (!vrMinimap3D) return;
    const next = MINIMAP_DISPLAY_MODES[(MINIMAP_DISPLAY_MODES.indexOf(vrMinimap3D.getDisplayMode()) + 1) % MINIMAP_DISPLAY_MODES.length];
    vrMinimap3D.setDisplayMode(next);
    console.log(`Minimap 3D display: ${next}`);
    feedback.notify('left', 'tick', `Vue : ${MINIMAP_DISPLAY_MODE_LABELS[next]}`);
}

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

/** The scene's debug grid, and the map cells drawn apart in the 3D minimap with it */
function toggleDebugOverlay(): void {
    debugOverlayVisible = !debugOverlayVisible;
    debugOverlay?.toggle();
    vrMinimap3D?.setGridVisible(debugOverlayVisible);
}

function recreateDebugOverlay(): void {
    debugOverlay?.dispose();
    debugOverlay = sceneMap ? createDebugFloorOverlay(scene, sceneMap) : null;
    if (debugOverlay && !debugOverlayVisible) debugOverlay.toggle();
    debugOverlay?.setStairsOnly(debugStairsOnly);
}

recreateDebugOverlay();
refreshMinimap3D();

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
        built.map.histogram = built.histogram;
        applyMap(built.map, built.histogram);
        feedback.notify('right', 'done', 'Carte prête');
    } catch (e) {
        if (controller.signal.aborted) return; // restarted or cancelled
        console.error('Minimap build failed:', e);
        editMode.isDirty = true;
        feedback.notify('right', 'refused', 'Échec du calcul');
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
    const action = getRebuildAction(editMode);
    feedback.notify('right', 'done', action === 'cancel' ? 'Calcul arrêté' : action === 'restart' ? 'Calcul relancé' : 'Calcul de la carte lancé');
    if (action === 'cancel') cancelBuild();
    else void rebuildMinimap();
}

function applyMap(map: SceneMap, bins: HistogramBin[]): void {
    const isFirstMap = sceneMap === null;

    disposeFloorMoveVisual();
    sceneMap = map;
    histogram = bins;
    recreateDebugOverlay();
    refreshMinimap3D();

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
    if (!hasPendingPreview(editMode.floors)) {
        feedback.notify('right', 'refused', 'Rien à confirmer');
        return;
    }

    commitFloorMove(editMode.floors, level, sceneMap.gridSize);
    feedback.notify('right', 'done', `Étage ${level.id} déplacé`);

    recreateDebugOverlay();
    disposeFloorMoveVisual();
    refreshMinimap3D();
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

const desktopConfigPanel = createDesktopConfigPanel(editMode, rebuildMinimap, cancelBuild, saveMinimap, confirmFloorMove, getMapContext, () => vrMinimap3D);
const editModeInputUpdate = createEditModeInputHandler(editMode, onRebuildButton, saveMinimap, confirmFloorMove, getMapContext, feedback.notify);
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

    return group;
}

// Target ray spaces (where the controllers point), for the minimap pointer's ray
const pointingControllers: THREE.XRTargetRaySpace[] = [];

for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    player.add(controller);
    pointingControllers.push(controller);

    const grip = renderer.xr.getControllerGrip(i);
    grip.add(createControllerVisual());
    player.add(grip);
    grip.addEventListener('connected', (event) => {
        const handedness = event.data?.handedness;
        if (handedness === 'left' || handedness === 'right') grip.add(handAnchors[handedness]);
    });
}

// Right controller pointing at the minimap: browse its floors, go to the pointed spot
const minimapPointer = createMinimapPointer(pointingControllers, player, camera, feedback.notify);

// XR movement
initXrMove(renderer.xr);

// Desktop navigation & initial camera position: around the spawn point, or the model center while there's no map
const initialSpawn = sceneMap?.levels[0]?.spawnPoint ?? modelBounds.getCenter(new THREE.Vector3());
camera.position.set(initialSpawn.x, initialSpawn.y + 2.0, initialSpawn.z + 8);

const desktopControls = new OrbitControls(camera, renderer.domElement);
desktopControls.target.set(initialSpawn.x, initialSpawn.y + 1.0, initialSpawn.z);
desktopControls.enableDamping = true;
desktopControls.dampingFactor = 0.05;

// Spawn is applied on the first frame with a tracked headset pose, the pose isn't known yet at sessionstart
let spawnPending = false;
// Placed without a map (center of the model, on its lowest point) and hasn't moved since
let spawnIsProvisional = false;

renderer.xr.addEventListener('sessionstart', () => {
    desktopControls.enabled = false;
    camera.position.set(0, 0, 0);
    player.rotation.set(0, 0, 0);
    spawnPending = true;
    spawnWaitFrames = 0;
    eyeHeightCalibrated = false;
});

// Headset poses can start before the tracking (at the origin, or emulated): calibrating the eye height on one of
// those puts the eyes too high once the real pose comes. Waits for a tracked pose above SPAWN_MIN_HEAD_Y, at most
// this many frames (with a 'local' reference space the head stays near y = 0)
const SPAWN_MAX_WAIT_FRAMES = 90;
const SPAWN_MIN_HEAD_Y = 0.5;
let spawnWaitFrames = 0;
// Once per session: a later respawn (first map built in VR) keeps the eye height the user started with
let eyeHeightCalibrated = false;

function trySpawn(): void {
    const frame = renderer.xr.getFrame();
    const refSpace = renderer.xr.getReferenceSpace();
    const pose = frame && refSpace ? frame.getViewerPose(refSpace) : null;
    if (!pose) return;
    spawnWaitFrames++;
    const poseIsReal = !pose.emulatedPosition && camera.position.y > SPAWN_MIN_HEAD_Y;
    if (!poseIsReal && spawnWaitFrames < SPAWN_MAX_WAIT_FRAMES) return;
    if (!eyeHeightCalibrated) {
        const headY = calibrateEyeHeight(camera);
        eyeHeightCalibrated = true;
        console.log(`Spawn: headset at y=${headY.toFixed(2)} m in the reference space after ${spawnWaitFrames} frames, taken as eyes ${VIRTUAL_EYE_HEIGHT} m above the floor`);
    }

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

renderer.xr.addEventListener('sessionend', () => {
    desktopControls.enabled = true;
    // the orbit camera is in the player's space: back to the world's
    player.position.set(0, 0, 0);
    player.rotation.set(0, 0, 0);
    camera.position.set(initialSpawn.x, initialSpawn.y + 2.0, initialSpawn.z + 8);
    desktopControls.target.set(initialSpawn.x, initialSpawn.y + 1.0, initialSpawn.z);
});

// 3D minimap: held above the left controller in VR (it follows the hand, not the gaze), HUD of the camera on desktop
renderer.xr.addEventListener('sessionstart', () => {
    hudMinimapAnchor.visible = hudMinimapVisible;
    if (vrMinimap3D) {
        vrMinimap3D.attachTo(handAnchors.left, 'hand');
        vrMinimap3D.setVisible(hudMinimapVisible);
    }
});

renderer.xr.addEventListener('sessionend', () => {
    hudMinimapAnchor.visible = hudMinimapVisible;
    if (vrMinimap3D) {
        vrMinimap3D.attachTo(hudMinimapAnchor, 'head');
        vrMinimap3D.setVisible(hudMinimapVisible);
    }
});

// Edit mode panels (config / floors, and the histogram on their left): placed in front of the user when the edit mode
// opens, then they stay there. In the player's space, so they come along when moving with the stick or turning
const editPanelAnchor = new THREE.Group();
editPanelAnchor.name = 'edit-panel-anchor';
player.add(editPanelAnchor);
const EDIT_PANEL_DISTANCE = 0.55; // m in front of the head
const EDIT_PANEL_BELOW_EYES = 0.2; // m
const EDIT_PANEL_TILT = THREE.MathUtils.degToRad(-15); // facing up towards the eyes
const EDIT_PANEL_GAP = 0.02; // m between the config panel and the histogram
// Panels are redrawn at most this often: a canvas upload per frame costs the headset its framerate
const EDIT_PANEL_REDRAW_MS = 66;
const HISTOGRAM_REDRAW_MS = 250;
let editPanelPlaced = false;
let lastEditPanelDraw = -Infinity;
let lastHistogramDraw = -Infinity;
const headForward = new THREE.Vector3();

/** Put the edit panels in front of the head, at a comfortable reading height, facing it */
function placeEditPanels(): void {
    // camera.position / quaternion: headset pose in the player's space
    headForward.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
    if (headForward.lengthSq() < 1e-6) headForward.set(0, 0, -1);
    headForward.normalize();
    editPanelAnchor.position.copy(camera.position).addScaledVector(headForward, EDIT_PANEL_DISTANCE);
    editPanelAnchor.position.y -= EDIT_PANEL_BELOW_EYES;
    editPanelAnchor.rotation.set(EDIT_PANEL_TILT, Math.atan2(-headForward.x, -headForward.z), 0, 'YXZ');
    editPanelPlaced = true;
}

let vrConfigPanel: VRConfigPanel | null = null;

renderer.xr.addEventListener('sessionstart', () => {
    vrConfigPanel = createVRConfigPanel(editPanelAnchor, 256);
    editPanelPlaced = false;
});

renderer.xr.addEventListener('sessionend', () => {
    if (vrConfigPanel) {
        editPanelAnchor.remove(vrConfigPanel.mesh);
        vrConfigPanel.texture.dispose();
        vrConfigPanel = null;
    }
});

let histogramHud: HistogramHud | null = null;

renderer.xr.addEventListener('sessionstart', () => {
    histogramHud = createHistogramHud(editPanelAnchor, VR_PANEL_SIZE);
    const width = (histogramHud.mesh.geometry as THREE.PlaneGeometry).parameters.width;
    histogramHud.mesh.position.x = -(VR_PANEL_SIZE / 2 + EDIT_PANEL_GAP + width / 2);
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

// Right stick left / right turns the view by steps (smooth turning makes people sick). Not in edit mode, where
// the right stick drives the panels, nor while the trigger is held, where it picks a floor
const SNAP_TURN_ANGLE = THREE.MathUtils.degToRad(30);
const SNAP_TURN_THRESHOLD = 0.7;
const SNAP_TURN_REARM = 0.3; // the stick has to come back near the centre before the next step
let snapTurnArmed = true;

function updateSnapTurn(): void {
    const session = renderer.xr.getSession();
    if (!session || editMode.active || floorState.triggerHeld || minimapPointer.isActive) {
        snapTurnArmed = true;
        return;
    }
    for (const source of session.inputSources) {
        if (source.handedness !== 'right' || !source.gamepad) continue;
        const x = source.gamepad.axes[2] ?? 0;
        if (snapTurnArmed && Math.abs(x) > SNAP_TURN_THRESHOLD) {
            snapTurn(player, camera, x > 0 ? -SNAP_TURN_ANGLE : SNAP_TURN_ANGLE);
            snapTurnArmed = false;
        } else if (Math.abs(x) < SNAP_TURN_REARM) {
            snapTurnArmed = true;
        }
    }
}

// Left grip held: the minimap in the left hand grows (and comes up off the hand), back on release
const MINIMAP_ZOOM_SPEED = 8; // per second, ~0.3 s to zoom in or out
let minimapZoom = 0;
let minimapZoomHeld = false;

function updateMinimapZoom(deltaTime: number): void {
    const session = renderer.xr.getSession();
    let held = false;
    if (session) {
        for (const source of session.inputSources) {
            if (source.handedness === 'left' && source.gamepad) held = (source.gamepad.buttons[1]?.value ?? 0) > 0.5;
        }
    }
    const target = held ? 1 : 0;
    if (held && !minimapZoomHeld) feedback.notify('left', 'tick');
    minimapZoomHeld = held;
    minimapZoom += (target - minimapZoom) * Math.min(1, deltaTime * MINIMAP_ZOOM_SPEED);
    if (Math.abs(target - minimapZoom) < 0.001) minimapZoom = target;
    vrMinimap3D?.setHandZoom(minimapZoom);
}

// left Y / X buttons move the player up / down in absolute terms, not between floors (edit mode included)
const DEBUG_VERTICAL_SPEED = 0.03;
function getDebugVertical(): number {
    const session = renderer.xr.getSession();
    if (!session) return 0;

    for (const source of session.inputSources) {
        if (source.handedness !== 'left' || !source.gamepad) continue;
        const up = source.gamepad.buttons[5]?.pressed ?? false; // Y
        const down = source.gamepad.buttons[4]?.pressed ?? false; // X
        return (up ? 1 : 0) - (down ? 1 : 0);
    }
    return 0;
}

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

    if (!renderer.xr.isPresenting) {
        desktopControls.update();
    }

    if (!floorState.isCoolingDown) {
        const joystick = getVRJoystick();
        if (joystick.x !== 0 || joystick.y !== 0) spawnIsProvisional = false;
        updateMovement(player, camera, joystick);
    }

    const debugVertical = getDebugVertical();
    if (debugVertical !== 0) {
        spawnIsProvisional = false;
        player.position.y += debugVertical * DEBUG_VERTICAL_SPEED;
    }

    updateVRMinimapToggleInput();
    updateSnapTurn();
    updateMinimapZoom(timer.getDelta());

    editModeInputUpdate(renderer.xr.getSession(), timer.getDelta());

    minimapPointer.update(vrMinimap3D, sceneMap, floorState,
        renderer.xr.isPresenting && !editMode.active && hudMinimapVisible && !spawnPending);

    if (!editMode.active && sceneMap && sceneMap.levels.length > 0) {
        // while pointing at the minimap, the right trigger and stick are the pointer's
        if (!minimapPointer.isActive) updateFloorManager(floorState, sceneMap, renderer.xr.getSession(), player, camera, feedback.notify);
        // the floor shown is the one under the feet, whichever way the player got there (stairs, Y / X)
        if (renderer.xr.isPresenting && !spawnPending) {
            const floorBefore = floorState.curFloorIdx;
            syncFloorWithHeight(floorState, sceneMap, getFeetY(player));
            const level = sceneMap.levels[floorState.curFloorIdx];
            if (floorState.curFloorIdx !== floorBefore && level) feedback.notify('left', 'tick', `Étage ${level.id}`);
        }
    }

    if (vrMinimap3D && sceneMap) {
        camera.getWorldDirection(playerDir);
        camera.getWorldPosition(headPos); // headset, not the player origin: they differ by the user's position in the play area
        const pointedFloor = minimapPointer.shownFloorIdx;
        if (editMode.active && editMode.panel === 'floors') {
            vrMinimap3D.setFloorHighlight(editMode.floors.selectedFloorIdx, false);
        } else if (pointedFloor !== null) {
            vrMinimap3D.setFloorHighlight(pointedFloor, pointedFloor !== floorState.curFloorIdx);
        } else {
            vrMinimap3D.setFloorHighlight(getActiveFloorIdx(floorState), floorState.triggerHeld);
        }
        vrMinimap3D.update(headPos, playerDir);
    }

    ensureFloorMoveVisual();

    // Edit panels: placed in front of the user each time the edit mode opens (once the headset pose is known)
    if (!editMode.active) editPanelPlaced = false;
    else if (!editPanelPlaced && renderer.xr.isPresenting && !spawnPending) placeEditPanels();
    editPanelAnchor.visible = editMode.active && editPanelPlaced;

    const now = performance.now();
    if (vrConfigPanel && editPanelAnchor.visible && now - lastEditPanelDraw > EDIT_PANEL_REDRAW_MS) {
        renderConfigPanel(editMode, getMapContext(), vrConfigPanel.canvas, 256);
        vrConfigPanel.texture.needsUpdate = true;
        lastEditPanelDraw = now;
    }

    const levels = sceneMap?.levels ?? [];
    if (histogramHud && editPanelAnchor.visible && now - lastHistogramDraw > HISTOGRAM_REDRAW_MS) {
        renderHistogram(histogram, levels, histogramHud.canvas, undefined, undefined, VR_HISTOGRAM_PIXEL_RATIO);
        histogramHud.texture.needsUpdate = true;
        lastHistogramDraw = now;
    }

    desktopHistogramPanel.setVisible(editMode.active);
    if (editMode.active) renderHistogram(histogram, levels, desktopHistogramPanel.canvas);

    desktopConfigPanel.sync();
    feedback.update(camera);

    renderer.render(scene, camera);
});

// Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Left hand = the minimap, in every mode: stick click shows / hides it, trigger changes its display mode.
// Right grip shows / hides the debug grid of the floors in the scene ('h' on desktop), edit mode included
let lastVRMinimapBtnState = false;
let lastVRDisplayModeBtnState = false;
let lastVRDebugGridBtnState = false;
function updateVRMinimapToggleInput(): void {
    const session = renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
        const gp = source.gamepad;
        if (!gp) continue;
        if (source.handedness === 'left') {
            const stickClicked = gp.buttons[3]?.pressed ?? false;
            if (stickClicked && !lastVRMinimapBtnState) toggleMinimap3D();
            lastVRMinimapBtnState = stickClicked;

            const triggerPressed = gp.buttons[0]?.pressed ?? false;
            if (triggerPressed && !lastVRDisplayModeBtnState) cycleMinimapDisplayMode();
            lastVRDisplayModeBtnState = triggerPressed;
        } else if (source.handedness === 'right') {
            const gripPressed = gp.buttons[1]?.pressed ?? false;
            if (gripPressed && !lastVRDebugGridBtnState) {
                toggleDebugOverlay();
                feedback.notify('right', 'tick', debugOverlayVisible ? 'Grille de debug affichée' : 'Grille de debug masquée');
            }
            lastVRDebugGridBtnState = gripPressed;
        }
    }
}

// Display debug overlay
window.addEventListener('keydown', e => {
    if (e.key === 'h' || e.key === 'H') toggleDebugOverlay();
    if (e.key === 'g' || e.key === 'G') {
        debugStairsOnly = !debugStairsOnly;
        // asked while the overlay is hidden: show it
        if (debugStairsOnly && !debugOverlayVisible) toggleDebugOverlay();
        debugOverlay?.setStairsOnly(debugStairsOnly);
    }
    if (e.key === 'e' || e.key === 'E') {
        editMode.active = !editMode.active;
        desktopConfigPanel.sync();
    }
    if ((e.key === 'r' || e.key === 'R') && editMode.active) void rebuildMinimap();
    if (e.key === 'm' || e.key === 'M') toggleMinimap3D();
    if (e.key === 'v' || e.key === 'V') cycleMinimapDisplayMode();
});
