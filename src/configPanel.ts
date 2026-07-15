import * as THREE from 'three';
import type { EditModeState } from './editMode.js';
import { EDITABLE_PARAMS, resetToDefaults } from './editMode.js';
import {
    type MapContext,
    selectNextFloor, toggleAxisMode, nudgeVerticalStep, nudgeHorizontal, cancelPreview, hasPendingPreview,
} from './floorAdjust.js';

// Desktop panel (HTML overlay)

export interface DesktopConfigPanel {
    sync: () => void;
    dispose: () => void;
}

/**
 * HTML overlay with two tabs: config sliders + Rebuild, and floor repositioning.
 * Shown/hidden by the caller toggling state.active and calling sync()
 * @param state edit mode state, mutated as the user interacts with the panel
 * @param onRebuildConfig called when the Rebuild button is clicked
 * @param onSaveMap called when the Save map button is clicked
 * @param onConfirmFloorMove called when the floor-move Confirm button is clicked
 * @param getMapContext returns the current floor list + grid size
 */
export function createDesktopConfigPanel(
    state: EditModeState,
    onRebuildConfig: () => void,
    onSaveMap: () => void,
    onConfirmFloorMove: () => void,
    getMapContext: () => MapContext,
): DesktopConfigPanel {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed', top: '8px', right: '8px',
        background: 'rgba(0,0,0,0.82)', color: '#eee',
        fontFamily: 'monospace', fontSize: '12px',
        padding: '10px 14px', borderRadius: '6px',
        border: '1px solid #444', display: 'none',
        minWidth: '260px', zIndex: '1000',
    });

    const title = document.createElement('div');
    title.textContent = '⚙ Edit mode (E pour fermer)';
    Object.assign(title.style, { marginBottom: '8px', color: '#ffee44' });
    panel.appendChild(title);

    // Tabs
    const tabsRow = document.createElement('div');
    Object.assign(tabsRow.style, { display: 'flex', gap: '6px', marginBottom: '8px' });

    function makeTabBtn(text: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = text;
        Object.assign(btn.style, {
            flex: '1', padding: '6px', border: 'none', borderRadius: '4px',
            cursor: 'pointer', fontFamily: 'monospace',
        });
        return btn;
    }
    const configTabBtn = makeTabBtn('Config');
    const floorsTabBtn = makeTabBtn('Étages');
    configTabBtn.addEventListener('click', () => { state.panel = 'config'; sync(); });
    floorsTabBtn.addEventListener('click', () => { state.panel = 'floors'; sync(); });
    tabsRow.appendChild(configTabBtn);
    tabsRow.appendChild(floorsTabBtn);
    panel.appendChild(tabsRow);

    // Save is global — available from either tab
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 Save map';
    Object.assign(saveBtn.style, {
        width: '100%', padding: '6px', marginBottom: '8px',
        background: '#2668a6', color: '#fff', border: 'none',
        borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
    });
    saveBtn.addEventListener('click', onSaveMap);
    panel.appendChild(saveBtn);

    // Config section
    const configSection = document.createElement('div');
    panel.appendChild(configSection);

    const inputs: Partial<Record<string, HTMLInputElement>> = {};
    const valueLabels: Partial<Record<string, HTMLSpanElement>> = {};

    for (const param of EDITABLE_PARAMS) {
        const row = document.createElement('div');
        row.style.marginBottom = '6px';

        const label = document.createElement('label');
        Object.assign(label.style, { display: 'flex', justifyContent: 'space-between' });
        label.textContent = param.label;

        const valueSpan = document.createElement('span');
        valueSpan.textContent = state.config[param.key].toFixed(2);
        label.appendChild(valueSpan);
        row.appendChild(label);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(param.min);
        input.max = String(param.max);
        input.step = String(param.step);
        input.value = String(state.config[param.key]);
        input.style.width = '100%';
        input.addEventListener('input', () => {
            state.config[param.key] = parseFloat(input.value);
            state.isDirty = true;
            valueSpan.textContent = state.config[param.key].toFixed(2);
        });

        row.appendChild(input);
        configSection.appendChild(row);

        inputs[param.key] = input;
        valueLabels[param.key] = valueSpan;
    }

    const rebuildBtn = document.createElement('button');
    rebuildBtn.textContent = 'Rebuild minimap';
    Object.assign(rebuildBtn.style, {
        marginTop: '6px', width: '100%', padding: '6px',
        background: '#2a6', color: '#fff', border: 'none',
        borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
    });
    rebuildBtn.addEventListener('click', onRebuildConfig);
    configSection.appendChild(rebuildBtn);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺ Défauts';
    Object.assign(resetBtn.style, {
        marginTop: '6px', width: '100%', padding: '6px',
        background: '#555', color: '#fff', border: 'none',
        borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
    });
    resetBtn.addEventListener('click', () => { resetToDefaults(state); sync(); });
    configSection.appendChild(resetBtn);

    const configStatus = document.createElement('div');
    Object.assign(configStatus.style, { marginTop: '6px', color: '#888' });
    configSection.appendChild(configStatus);

    // Floors section
    const floorsSection = document.createElement('div');
    floorsSection.style.display = 'none';
    panel.appendChild(floorsSection);

    const floorNavRow = document.createElement('div');
    Object.assign(floorNavRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' });

    function makeSmallBtn(text: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = text;
        Object.assign(btn.style, {
            padding: '6px 10px', background: '#444', color: '#fff', border: 'none',
            borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
        });
        return btn;
    }

    const prevFloorBtn = makeSmallBtn('◀');
    const floorLabel = document.createElement('span');
    Object.assign(floorLabel.style, { flex: '1', textAlign: 'center' });
    const nextFloorBtn = makeSmallBtn('▶');
    prevFloorBtn.addEventListener('click', () => {
        const { levelCount } = getMapContext();
        selectNextFloor(state.floors, levelCount, -1);
        sync();
    });
    nextFloorBtn.addEventListener('click', () => {
        const { levelCount } = getMapContext();
        selectNextFloor(state.floors, levelCount, 1);
        sync();
    });
    floorNavRow.appendChild(prevFloorBtn);
    floorNavRow.appendChild(floorLabel);
    floorNavRow.appendChild(nextFloorBtn);
    floorsSection.appendChild(floorNavRow);

    const axisBtn = document.createElement('button');
    Object.assign(axisBtn.style, {
        width: '100%', padding: '6px', marginBottom: '6px',
        background: '#555', color: '#fff', border: 'none',
        borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
    });
    axisBtn.addEventListener('click', () => { toggleAxisMode(state.floors); sync(); });
    floorsSection.appendChild(axisBtn);

    const nudgeRow = document.createElement('div');
    Object.assign(nudgeRow.style, { display: 'flex', gap: '6px', marginBottom: '6px' });

    // Briefly show the axis line around a click, mirroring the VR "trigger held" gate.
    let flashTimeout: ReturnType<typeof setTimeout> | null = null;
    function flashMoving(): void {
        state.floors.isMoving = true;
        if (flashTimeout) clearTimeout(flashTimeout);
        flashTimeout = setTimeout(() => { state.floors.isMoving = false; }, 400);
    }

    const vNudgeUp = makeSmallBtn('▲ +0.1m');
    const vNudgeDown = makeSmallBtn('▼ -0.1m');
    vNudgeUp.style.flex = '1';
    vNudgeDown.style.flex = '1';
    vNudgeUp.addEventListener('click', () => { nudgeVerticalStep(state.floors, 0.1); flashMoving(); sync(); });
    vNudgeDown.addEventListener('click', () => { nudgeVerticalStep(state.floors, -0.1); flashMoving(); sync(); });

    const hNudgeXMinus = makeSmallBtn('X-');
    const hNudgeXPlus = makeSmallBtn('X+');
    const hNudgeZMinus = makeSmallBtn('Z-');
    const hNudgeZPlus = makeSmallBtn('Z+');
    for (const btn of [hNudgeXMinus, hNudgeXPlus, hNudgeZMinus, hNudgeZPlus]) btn.style.flex = '1';
    hNudgeXMinus.addEventListener('click', () => { nudgeHorizontal(state.floors, { x: -1, z: 0 }, getMapContext().gridSize); flashMoving(); sync(); });
    hNudgeXPlus.addEventListener('click', () => { nudgeHorizontal(state.floors, { x: 1, z: 0 }, getMapContext().gridSize); flashMoving(); sync(); });
    hNudgeZMinus.addEventListener('click', () => { nudgeHorizontal(state.floors, { x: 0, z: -1 }, getMapContext().gridSize); flashMoving(); sync(); });
    hNudgeZPlus.addEventListener('click', () => { nudgeHorizontal(state.floors, { x: 0, z: 1 }, getMapContext().gridSize); flashMoving(); sync(); });

    nudgeRow.appendChild(vNudgeUp);
    nudgeRow.appendChild(vNudgeDown);
    nudgeRow.appendChild(hNudgeXMinus);
    nudgeRow.appendChild(hNudgeXPlus);
    nudgeRow.appendChild(hNudgeZMinus);
    nudgeRow.appendChild(hNudgeZPlus);
    floorsSection.appendChild(nudgeRow);

    const deltaLabel = document.createElement('div');
    Object.assign(deltaLabel.style, { marginBottom: '6px', color: '#aaa' });
    floorsSection.appendChild(deltaLabel);

    const floorActionsRow = document.createElement('div');
    Object.assign(floorActionsRow.style, { display: 'flex', gap: '6px' });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '✓ Confirmer';
    Object.assign(confirmBtn.style, {
        flex: '1', padding: '6px', background: '#2a6', color: '#fff', border: 'none',
        borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
    });
    confirmBtn.addEventListener('click', () => { onConfirmFloorMove(); sync(); });

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕ Annuler';
    Object.assign(cancelBtn.style, {
        flex: '1', padding: '6px', background: '#a33', color: '#fff', border: 'none',
        borderRadius: '4px', cursor: 'pointer', fontFamily: 'monospace',
    });
    cancelBtn.addEventListener('click', () => { cancelPreview(state.floors); sync(); });

    floorActionsRow.appendChild(confirmBtn);
    floorActionsRow.appendChild(cancelBtn);
    floorsSection.appendChild(floorActionsRow);

    document.body.appendChild(panel);

    function sync() {
        panel.style.display = state.active ? 'block' : 'none';

        configTabBtn.style.background = state.panel === 'config' ? '#2668a6' : '#333';
        floorsTabBtn.style.background = state.panel === 'floors' ? '#2668a6' : '#333';
        configSection.style.display = state.panel === 'config' ? 'block' : 'none';
        floorsSection.style.display = state.panel === 'floors' ? 'block' : 'none';

        for (const param of EDITABLE_PARAMS) {
            inputs[param.key]!.value = String(state.config[param.key]);
            valueLabels[param.key]!.textContent = state.config[param.key].toFixed(2);
        }
        configStatus.textContent = state.isRebuilding
            ? 'Reconstruction…'
            : state.isDirty ? 'Modifié — pense à rebuild' : '';

        const { levels } = getMapContext();
        const level = levels[state.floors.selectedFloorIdx];
        if (level) {
            floorLabel.textContent = `Étage ${level.id} — Y=${level.floorY.toFixed(2)}m`;
        }

        const vertical = state.floors.axisMode === 'vertical';
        axisBtn.textContent = vertical ? 'Axe : Vertical (Y)' : 'Axe : Horizontal (X/Z)';
        vNudgeUp.style.display = vertical ? 'block' : 'none';
        vNudgeDown.style.display = vertical ? 'block' : 'none';
        hNudgeXMinus.style.display = vertical ? 'none' : 'block';
        hNudgeXPlus.style.display = vertical ? 'none' : 'block';
        hNudgeZMinus.style.display = vertical ? 'none' : 'block';
        hNudgeZPlus.style.display = vertical ? 'none' : 'block';

        const { x, y, z } = state.floors.previewDelta;
        deltaLabel.textContent = `Δ x=${x.toFixed(2)} y=${y.toFixed(2)} z=${z.toFixed(2)}`;
        confirmBtn.disabled = !hasPendingPreview(state.floors);
        confirmBtn.style.opacity = confirmBtn.disabled ? '0.5' : '1';
    }

    sync();

    return { sync, dispose: () => panel.remove() };
}

// VR panel (canvas texture on a controller grip)

export interface VRConfigPanel {
    mesh: THREE.Mesh;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
}

export function createVRConfigPanel(grip: THREE.XRTargetRaySpace, canvasSize = 256): VRConfigPanel {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = canvasSize;

    const texture = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.15, 0.15),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
    );

    mesh.position.set(0, 0.05, -0.02);
    mesh.rotation.set(-Math.PI / 2.5, 0, 0);
    grip.add(mesh);

    return { mesh, texture, canvas };
}

// Draw the appropriate sub-panel (config tuning or floor repositioning) for the active tab
export function renderConfigPanel(
    state: EditModeState,
    map: MapContext,
    canvas: HTMLCanvasElement,
    canvasSize = 256,
): void {
    if (state.panel === 'config') renderConfigParamsPanel(state, canvas, canvasSize);
    else renderFloorsPanel(state, map, canvas, canvasSize);
}

/**
 * Draw the config-tuning panel: one row per param, selection highlighted,
 * status line at the bottom (rebuilding / dirty / up to date)
 */
function renderConfigParamsPanel(state: EditModeState, canvas: HTMLCanvasElement, canvasSize: number): void {
    const ctx = canvas.getContext('2d')!;
    canvas.width = canvas.height = canvasSize;

    ctx.fillStyle = 'rgba(10,10,10,0.92)';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.fillStyle = '#ffee44';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EDIT MODE — Config', canvasSize / 2, 20);

    const rowH = 42;
    const startY = 42;

    EDITABLE_PARAMS.forEach((param, idx) => {
        const y = startY + idx * rowH;
        const isSelected = idx === state.selectedIdx;

        if (isSelected) {
            ctx.fillStyle = 'rgba(255,200,60,0.2)';
            ctx.fillRect(8, y - 4, canvasSize - 16, rowH - 8);
        }

        ctx.fillStyle = isSelected ? '#ffc83c' : '#ccc';
        ctx.font = `${isSelected ? 'bold ' : ''}11px monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(param.label, 14, y + 12);

        ctx.font = `${isSelected ? 'bold ' : ''}15px monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(state.config[param.key].toFixed(2), canvasSize - 14, y + 12);
    });

    ctx.textAlign = 'center';
    ctx.font = '9px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('droite: stick ↕ sélection · trigger+↔ ajuste', canvasSize / 2, canvasSize - 48);
    ctx.fillText('gauche: stick-clic étages · X save · Y défauts', canvasSize / 2, canvasSize - 38);

    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = state.isRebuilding ? '#ffc83c' : state.isDirty ? '#ff8844' : '#55ff88';
    ctx.fillText(
        state.isRebuilding ? 'Reconstruction…' : state.isDirty ? 'bouton B : rebuild' : 'À jour',
        canvasSize / 2, canvasSize - 12
    );
}

// Draw the floor-repositioning panel: floor list with the active one highlighted, axis + delta info
function renderFloorsPanel(state: EditModeState, map: MapContext, canvas: HTMLCanvasElement, canvasSize: number): void {
    const ctx = canvas.getContext('2d')!;
    canvas.width = canvas.height = canvasSize;

    ctx.fillStyle = 'rgba(10,10,10,0.92)';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.fillStyle = '#ffee44';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EDIT MODE — Étages', canvasSize / 2, 20);

    const rowH = 22;
    const startY = 36;

    map.levels.forEach((level, idx) => {
        // floor 0 (lowest) at the bottom
        const rowFromTop = map.levels.length - 1 - idx;
        const y = startY + rowFromTop * rowH;
        const isSelected = idx === state.floors.selectedFloorIdx;

        if (isSelected) {
            ctx.fillStyle = 'rgba(255,200,60,0.2)';
            ctx.fillRect(8, y - 4, canvasSize - 16, rowH - 4);
        }

        ctx.fillStyle = isSelected ? '#ffc83c' : '#ccc';
        ctx.font = `${isSelected ? 'bold ' : ''}12px monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(`Étage ${level.id}`, 14, y + 12);

        ctx.textAlign = 'right';
        ctx.fillText(`Y=${level.floorY.toFixed(2)}m`, canvasSize - 14, y + 12);
    });

    const infoY = startY + map.levels.length * rowH + 14;

    ctx.textAlign = 'center';
    ctx.fillStyle = '#55ddff';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(
        state.floors.axisMode === 'vertical' ? 'Axe : Vertical (Y)' : 'Axe : Horizontal (X/Z)',
        canvasSize / 2, infoY
    );

    const { x, y, z } = state.floors.previewDelta;
    ctx.fillStyle = '#ccc';
    ctx.font = '11px monospace';
    ctx.fillText(`Δ x=${x.toFixed(2)} y=${y.toFixed(2)} z=${z.toFixed(2)}`, canvasSize / 2, infoY + 18);

    ctx.font = '9px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('droite: stick ↕ sélection · stick-clic axe', canvasSize / 2, canvasSize - 48);
    ctx.fillText('trigger+stick déplace · B confirme', canvasSize / 2, canvasSize - 38);
    ctx.fillText('gauche: stick-clic config · X save · Y annule', canvasSize / 2, canvasSize - 28);

    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = hasPendingPreview(state.floors) ? '#ff8844' : '#55ff88';
    ctx.fillText(hasPendingPreview(state.floors) ? 'bouton B : confirmer' : 'aucun changement', canvasSize / 2, canvasSize - 12);
}
