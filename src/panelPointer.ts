import * as THREE from 'three';
import type { ControllerRay } from './controllerRay.js';
import type { PanelRegion, PanelTarget } from './configPanel.js';
import { getConfigRows, setParamValue, toggleCategory, type EditModeState, type PanelAction } from './editMode.js';
import { selectFloor, toggleAxisMode } from './floorAdjust.js';
import type { Notify } from './feedback.js';

/**
 * The right controller's ray on the VR edit panel, as a mouse: what it points at is selected (config list), the
 * trigger clicks (tabs, categories, buttons, floors, axis), held on a param it drags the value along its bar.
 * The stick keeps working too
 */

const TRIGGER_THRESHOLD = 0.5;
const CURSOR_RADIUS = 0.004; // m

export interface PanelPointer {
    /**
     * Once per frame in VR, after ray.update() and before the edit mode input
     * @param panel the panel's plane, null when it isn't shown
     * @param regions its clickable areas, from its last drawing
     * @param canvasSize the panel's drawing size (the regions' units)
     */
    update: (panel: THREE.Mesh | null, regions: PanelRegion[], canvasSize: number) => void;
    /** The trigger is the pointer's (pointing at the panel, or dragging): the edit mode's trigger + stick must ignore it */
    readonly hasTrigger: boolean;
}

/**
 * @param press what the panel's buttons do (shared with the stick input)
 * @param requestRedraw the panel changed: draw it now rather than at its next throttled redraw
 */
export function createPanelPointer(
    ray: ControllerRay,
    state: EditModeState,
    press: (action: PanelAction) => void,
    notify: Notify,
    requestRedraw: () => void,
): PanelPointer {
    const cursor = new THREE.Mesh(
        new THREE.CircleGeometry(CURSOR_RADIUS, 16),
        new THREE.MeshBasicMaterial({ color: 0xffee44, depthTest: false, transparent: true }),
    );
    cursor.renderOrder = 1100; // over the panel
    cursor.visible = false;

    const hits: THREE.Intersection[] = [];
    let hasTrigger = false;
    let triggerWasHeld = false;
    // trigger went down on the panel: it stays the pointer's until released
    let triggerFromPanel = false;
    // param row being dragged (trigger held on its row)
    let dragging: { index: number; x0: number; x1: number } | null = null;

    function regionAt(regions: PanelRegion[], x: number, y: number): PanelRegion | undefined {
        return regions.find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    }

    function dragTo(x: number): void {
        if (!dragging) return;
        const row = getConfigRows(state)[dragging.index];
        if (row?.kind !== 'param') return;
        const t = THREE.MathUtils.clamp((x - dragging.x0) / (dragging.x1 - dragging.x0), 0, 1);
        const before = state.config[row.param.key];
        setParamValue(state, row.param, row.param.min + t * (row.param.max - row.param.min));
        if (state.config[row.param.key] !== before) requestRedraw();
    }

    function click(target: PanelTarget, x: number): void {
        switch (target.kind) {
            case 'tab':
                if (state.panel !== target.panel) notify('right', 'tick');
                state.panel = target.panel;
                break;
            case 'configRow': {
                const row = getConfigRows(state)[target.index];
                if (!row) return;
                state.selectedRow = target.index;
                state.selectedByPointer = true;
                if (row.kind === 'category') {
                    toggleCategory(state, row.category);
                    notify('right', 'tick');
                } else if (row.kind === 'action') {
                    press(row.action);
                } else if (target.slider) {
                    dragging = { index: target.index, ...target.slider };
                    dragTo(x);
                }
                break;
            }
            case 'floor':
                if (state.floors.selectedFloorIdx !== target.index) notify('right', 'tick');
                selectFloor(state.floors, target.index);
                break;
            case 'cancelFloorMove':
                press('cancelFloorMove');
                break;
            case 'axis':
                toggleAxisMode(state.floors);
                notify('right', 'tick', state.floors.axisMode === 'vertical' ? 'Axe : vertical' : 'Axe : horizontal');
                break;
        }
        requestRedraw();
    }

    return {
        get hasTrigger() { return hasTrigger; },

        update(panel, regions, canvasSize) {
            const triggerHeld = (ray.gamepad?.buttons[0]?.value ?? 0) > TRIGGER_THRESHOLD;
            const triggerPressed = triggerHeld && !triggerWasHeld;
            triggerWasHeld = triggerHeld;
            if (!triggerHeld) {
                triggerFromPanel = false;
                dragging = null;
            }

            if (cursor.parent !== panel) {
                cursor.removeFromParent();
                panel?.add(cursor);
            }

            hits.length = 0;
            if (panel && ray.gamepad) {
                panel.updateWorldMatrix(true, false);
                panel.raycast(ray.raycaster, hits); // a single plane: no sorting needed
            }
            const hit = hits.find(h => h.uv);
            if (!panel || !hit?.uv) {
                cursor.visible = false;
                if (panel) ray.show(null);
                hasTrigger = triggerFromPanel;
                return;
            }

            hasTrigger = true;
            ray.show(hit.distance);
            const { uv } = hit;
            const size = (panel.geometry as THREE.PlaneGeometry).parameters.width;
            cursor.position.set((uv.x - 0.5) * size, (uv.y - 0.5) * size, 0.001);
            cursor.visible = true;

            // canvas units, from the top left corner
            const x = uv.x * canvasSize;
            const y = (1 - uv.y) * canvasSize;

            if (dragging) {
                dragTo(x);
                return;
            }

            const region = regionAt(regions, x, y);
            // the config list's selection follows the pointer, as the stick's does
            if (region?.target.kind === 'configRow' && state.selectedRow !== region.target.index) {
                state.selectedRow = region.target.index;
                state.selectedByPointer = true;
                requestRedraw();
            }

            if (triggerPressed) {
                triggerFromPanel = true;
                if (region) click(region.target, x);
            }
        },
    };
}
