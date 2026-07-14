import * as THREE from 'three';
import type { EditModeState } from './editMode.js';
import { EDITABLE_PARAMS } from './editMode.js';

// Desktop panel (HTML overlay)

export interface DesktopConfigPanel {
    sync: () => void;
    dispose: () => void;
}

/**
 * HTML overlay with one slider per editable param + a Rebuild button
 * Shown/hidden by the caller toggling state.active and calling sync()
 * @param state edit mode state, mutated as the user drags sliders
 * @param onRebuild called when the Rebuild button is clicked
 */
export function createDesktopConfigPanel(
    state: EditModeState,
    onRebuild: () => void,
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
    title.textContent = '⚙ Edit mode - config minimap (E pour fermer)';
    Object.assign(title.style, { marginBottom: '8px', color: '#ffee44' });
    panel.appendChild(title);

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
        panel.appendChild(row);

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
    rebuildBtn.addEventListener('click', onRebuild);
    panel.appendChild(rebuildBtn);

    const status = document.createElement('div');
    Object.assign(status.style, { marginTop: '6px', color: '#888' });
    panel.appendChild(status);

    document.body.appendChild(panel);

    function sync() {
        for (const param of EDITABLE_PARAMS) {
            inputs[param.key]!.value = String(state.config[param.key]);
            valueLabels[param.key]!.textContent = state.config[param.key].toFixed(2);
        }
        panel.style.display = state.active ? 'block' : 'none';
        status.textContent = state.isRebuilding
            ? 'Reconstruction…'
            : state.isDirty ? 'Modifié — pense à rebuild' : '';
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

/**
 * Draw the edit mode panel: one row per param, selection highlighted
 * status line at the bottom (rebuilding / dirty / up to date)
 */
export function renderConfigPanel(state: EditModeState, canvas: HTMLCanvasElement, canvasSize = 256): void {
    const ctx = canvas.getContext('2d')!;
    canvas.width = canvas.height = canvasSize;

    ctx.fillStyle = 'rgba(10,10,10,0.92)';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.fillStyle = '#ffee44';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EDIT MODE', canvasSize / 2, 20);

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
    ctx.fillText('stick ↕ sélection · trigger + ↔ ajuste', canvasSize / 2, canvasSize - 28);

    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = state.isRebuilding ? '#ffc83c' : state.isDirty ? '#ff8844' : '#55ff88';
    ctx.fillText(
        state.isRebuilding ? 'Reconstruction…' : state.isDirty ? 'bouton B : rebuild' : 'À jour',
        canvasSize / 2, canvasSize - 12
    );
}
