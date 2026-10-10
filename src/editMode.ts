import type { MinimapConfig } from './minimap.js';
import {
    type FloorAdjustState, type MapContext, createFloorAdjustState,
    selectNextFloor, toggleAxisMode, nudgeVertical, nudgeHorizontal, cancelPreview,
} from './floorAdjust.js';

export type ParamCategory = 'floors' | 'walls' | 'stairs' | 'rooms';

/** Param groups, shown as collapsible sections (only one open at a time) */
export const PARAM_CATEGORIES: { key: ParamCategory; label: string }[] = [
    { key: 'floors', label: 'Détection des sols' }, // not 'Étages': that's the floor repositioning tab
    { key: 'walls', label: 'Murs' },
    { key: 'stairs', label: 'Escaliers' },
    { key: 'rooms', label: 'Pièces & couloirs' },
];

/**
 * @typedef EditableParam
 * @prop key MinimapConfig field this param controls
 * @prop category Section the param is listed under
 * @prop label Human-readable name shown in the panels
 * @prop min/max/step Slider / stick adjustment range
 */
export interface EditableParam {
    key: keyof MinimapConfig;
    category: ParamCategory;
    label: string;
    min: number;
    max: number;
    step: number;
}

export const EDITABLE_PARAMS: EditableParam[] = [
    { key: 'normalThreshold', category: 'floors', label: 'Floor normal thr.', min: 0.1, max: 1.0, step: 0.01 },
    { key: 'minFloorGap', category: 'floors', label: 'Min floor gap', min: 0.05, max: 2.0, step: 0.01 },
    { key: 'histoHeightSize', category: 'floors', label: 'Histogram slice', min: 0.02, max: 0.5, step: 0.01 },
    { key: 'minPeakArea', category: 'floors', label: 'Min peak area', min: 0.5, max: 20, step: 0.5 },
    { key: 'floorOpeningRadius', category: 'floors', label: 'Opening radius', min: 0, max: 5, step: 1 },
    { key: 'wallScanHeight', category: 'walls', label: 'Wall scan height', min: 0.1, max: 3.0, step: 0.05 },
    { key: 'wallNormalThreshold', category: 'walls', label: 'Wall normal thr.', min: 0.05, max: 0.9, step: 0.05 },
    { key: 'wallRayLength', category: 'walls', label: 'Wall ray length', min: 0.05, max: 1.0, step: 0.05 },
    { key: 'minStairArea', category: 'stairs', label: 'Min stair area', min: 0.05, max: 5, step: 0.05 },
    { key: 'maxStairArea', category: 'stairs', label: 'Max stair area', min: 1, max: 30, step: 0.5 },
    { key: 'stairMaxStepRise', category: 'stairs', label: 'Stair max step rise', min: 0.02, max: 0.5, step: 0.01 },
    { key: 'stairFlatTolerance', category: 'stairs', label: 'Stair flat tolerance', min: 0, max: 0.2, step: 0.01 },
    { key: 'maxLandingRun', category: 'stairs', label: 'Max landing run', min: 0.2, max: 5, step: 0.1 },
    { key: 'doorWidth', category: 'rooms', label: 'Door width', min: 0.4, max: 3.0, step: 0.05 },
    { key: 'minRoomArea', category: 'rooms', label: 'Min room area', min: 0.25, max: 20, step: 0.25 },
    { key: 'minRoomWidth', category: 'rooms', label: 'Min room width', min: 0, max: 2.0, step: 0.05 },
    { key: 'corridorMaxWidth', category: 'rooms', label: 'Corridor max width', min: 0.5, max: 5.0, step: 0.1 },
    { key: 'corridorMinElongation', category: 'rooms', label: 'Corridor min elong.', min: 1.5, max: 15, step: 0.5 },
];

/** One line of the config list: a category header, or a param of the open category */
export type ConfigRow =
    | { kind: 'category'; category: ParamCategory; label: string; count: number }
    | { kind: 'param'; param: EditableParam };

export type EditPanel = 'config' | 'floors';

/**
 * @typedef EditModeState
 * @prop active whether the edit mode overlay is currently shown
 * @prop panel which sub-panel is currently shown/controlled: config tuning or floor repositioning
 * @prop openCategory expanded section of the config list (null = all collapsed)
 * @prop selectedRow index into getConfigRows() currently highlighted (VR navigation)
 * @prop config live MinimapConfig, mutated in place by the panels
 * @prop defaults original MinimapConfig, used by resetToDefaults
 * @prop isRebuilding a rebuild is in progress
 * @prop isDirty config changed since the last successful rebuild
 * @prop floors floor repositioning sub-state
 */
export interface EditModeState {
    active: boolean;
    panel: EditPanel;
    openCategory: ParamCategory | null;
    selectedRow: number;
    config: MinimapConfig;
    defaults: MinimapConfig;
    isRebuilding: boolean;
    isDirty: boolean;
    floors: FloorAdjustState;
}

export function createEditMode(initialConfig: MinimapConfig): EditModeState {
    return {
        active: false,
        panel: 'config',
        openCategory: null,
        selectedRow: 0,
        config: { ...initialConfig },
        defaults: { ...initialConfig },
        isRebuilding: false,
        isDirty: false,
        floors: createFloorAdjustState(),
    };
}

/**
 * Restore config to the values EditMode was created with. Does not rebuild
 * on its own — the caller still has to trigger a rebuild to apply it.
 */
export function resetToDefaults(state: EditModeState): void {
    state.config = { ...state.defaults };
    state.isDirty = true;
}

/**
 * Visible lines of the config list: every category header, with the params of the open one right below it
 */
export function getConfigRows(state: EditModeState): ConfigRow[] {
    const rows: ConfigRow[] = [];
    for (const { key, label } of PARAM_CATEGORIES) {
        const params = EDITABLE_PARAMS.filter(p => p.category === key);
        rows.push({ kind: 'category', category: key, label, count: params.length });
        if (state.openCategory === key) {
            for (const param of params) rows.push({ kind: 'param', param });
        }
    }
    return rows;
}

export function getSelectedRow(state: EditModeState): ConfigRow {
    const rows = getConfigRows(state);
    return rows[Math.min(state.selectedRow, rows.length - 1)];
}

export function selectNextRow(state: EditModeState, dir: 1 | -1): void {
    const n = getConfigRows(state).length;
    state.selectedRow = (state.selectedRow + dir + n) % n;
}

/**
 * Open (closing any other) or close a category; the selection moves to its header so it doesn't jump around
 */
export function setCategoryOpen(state: EditModeState, category: ParamCategory, open: boolean): void {
    state.openCategory = open ? category : state.openCategory === category ? null : state.openCategory;
    state.selectedRow = getConfigRows(state).findIndex(row => row.kind === 'category' && row.category === category);
}

export function toggleCategory(state: EditModeState, category: ParamCategory): void {
    setCategoryOpen(state, category, state.openCategory !== category);
}

export function adjustParam(state: EditModeState, param: EditableParam, delta: number): void {
    const next = state.config[param.key] + delta;
    state.config[param.key] = Math.min(param.max, Math.max(param.min, next));
    state.isDirty = true;
}

const SELECT_THRESHOLD = 0.6;
const ADJUST_THRESHOLD = 0.15;
const SELECT_COOLDOWN_MS = 250;
const HORIZONTAL_STEP_COOLDOWN_MS = 220;

function findGamepad(session: XRSession, handedness: XRHandedness): Gamepad | null {
    for (const src of session.inputSources) {
        if (src.handedness === handedness && src.gamepad) return src.gamepad;
    }
    return null;
}

/** Edge-triggered button helper: returns true only on the press frame. */
function pressedEdge(gp: Gamepad, buttonIdx: number, prev: boolean): [fired: boolean, pressed: boolean] {
    const pressed = gp.buttons[buttonIdx]?.pressed ?? false;
    return [pressed && !prev, pressed];
}

/**
 * Controller input for the edit mode.
 *  Right hand — A/X toggles edit mode on/off (any panel).
 *  Left hand (only while edit mode is active):
 *    - stick click : switch panel (config <-> floors)
 *    - X button    : save the current map to a file
 *    - Y button    : contextual — reset config to defaults, or cancel the pending floor move
 *  Right hand, panel = 'config':
 *    - stick up/down (no trigger)      : move the selection (category headers + params of the open one)
 *    - stick click                     : open/close the selected category (or the selected param's one)
 *    - stick left/right + trigger held : adjust the selected param's value, or open (→) / close (←) a selected category
 *    - B/Y button                      : rebuild the minimap (raycast)
 *  Right hand, panel = 'floors':
 *    - stick up/down (no trigger) : select the floor to reposition
 *    - stick click                : toggle axis mode (vertical Y <-> horizontal X/Z)
 *    - trigger + stick            : nudge the selected floor along the active axis (preview only)
 *    - B/Y button                 : confirm bake the preview offset into the map data
 *
 * @param state edit mode state to mutate
 * @param onRebuildConfig called on right B/Y press while panel = 'config'
 * @param onSaveMap called on left X press while active
 * @param onConfirmFloorMove called on right B/Y press while panel = 'floors'
 * @param getMapContext returns the current floor count + grid size, needed for floor selection/nudging
 * @return update function to call every frame with the current session + deltaTime
 */
export function createEditModeInputHandler(
    state: EditModeState,
    onRebuildConfig: () => void,
    onSaveMap: () => void,
    onConfirmFloorMove: () => void,
    getMapContext: () => MapContext,
): (session: XRSession | null, deltaTime: number) => void {
    let prevToggle = false;
    let prevPanelSwitch = false;
    let prevRightB = false;
    let prevRightStickClick = false;
    let prevLeftX = false;
    let prevLeftY = false;
    let lastSelectAt = 0;
    let lastHorizStepAt = 0;

    return (session, deltaTime) => {
        if (!session) return;

        const rightGp = findGamepad(session, 'right');
        const leftGp = findGamepad(session, 'left');

        if (rightGp) {
            const [toggled, toggleHeld] = pressedEdge(rightGp, 4, prevToggle);
            if (toggled) state.active = !state.active;
            prevToggle = toggleHeld;
        }

        if (!state.active) {
            prevRightB = false;
            prevRightStickClick = false;
            prevLeftX = false;
            prevLeftY = false;
            prevPanelSwitch = false;
            return;
        }

        if (leftGp) {
            const [switchPanel, switchHeld] = pressedEdge(leftGp, 3, prevPanelSwitch);
            if (switchPanel) state.panel = state.panel === 'config' ? 'floors' : 'config';
            prevPanelSwitch = switchHeld;

            const [save, saveHeld] = pressedEdge(leftGp, 4, prevLeftX);
            if (save) onSaveMap();
            prevLeftX = saveHeld;

            const [secondary, secondaryHeld] = pressedEdge(leftGp, 5, prevLeftY);
            if (secondary) {
                if (state.panel === 'config') resetToDefaults(state);
                else cancelPreview(state.floors);
            }
            prevLeftY = secondaryHeld;
        }

        if (!rightGp) return;

        const stickX = rightGp.axes[2] ?? 0;
        const stickY = rightGp.axes[3] ?? 0;
        const triggerHeld = (rightGp.buttons[0]?.value ?? 0) > 0.5;
        const now = performance.now();

        if (state.panel === 'config') {
            state.floors.isMoving = false;

            const [rebuild, rebuildHeld] = pressedEdge(rightGp, 5, prevRightB);
            if (rebuild) onRebuildConfig();
            prevRightB = rebuildHeld;

            const row = getSelectedRow(state);
            const rowCategory = row.kind === 'category' ? row.category : row.param.category;

            const [categoryToggle, categoryToggleHeld] = pressedEdge(rightGp, 3, prevRightStickClick);
            if (categoryToggle) toggleCategory(state, rowCategory);
            prevRightStickClick = categoryToggleHeld;

            if (!triggerHeld && Math.abs(stickY) > SELECT_THRESHOLD && now - lastSelectAt > SELECT_COOLDOWN_MS) {
                selectNextRow(state, stickY > 0 ? 1 : -1);
                lastSelectAt = now;
            }

            if (triggerHeld && row.kind === 'category' && Math.abs(stickX) > SELECT_THRESHOLD) {
                setCategoryOpen(state, row.category, stickX > 0);
            } else if (triggerHeld && row.kind === 'param' && Math.abs(stickX) > ADJUST_THRESHOLD) {
                const { param } = row;
                const rangeSpeed = (param.max - param.min) * 0.3; // ~3.3s to cross the full range
                adjustParam(state, param, stickX * rangeSpeed * deltaTime);
            }
        } else {
            const [confirm, confirmHeld] = pressedEdge(rightGp, 5, prevRightB);
            if (confirm) onConfirmFloorMove();
            prevRightB = confirmHeld;

            const [axisToggle, axisHeld] = pressedEdge(rightGp, 3, prevRightStickClick);
            if (axisToggle) toggleAxisMode(state.floors);
            prevRightStickClick = axisHeld;

            const { levelCount, gridSize } = getMapContext();

            state.floors.isMoving = triggerHeld;

            if (!triggerHeld && Math.abs(stickY) > SELECT_THRESHOLD && now - lastSelectAt > SELECT_COOLDOWN_MS) {
                // stick up (negative axis value) selects the next floor up
                selectNextFloor(state.floors, levelCount, stickY < 0 ? 1 : -1);
                lastSelectAt = now;
            }

            if (triggerHeld) {
                if (state.floors.axisMode === 'vertical') {
                    if (Math.abs(stickY) > ADJUST_THRESHOLD) {
                        nudgeVertical(state.floors, stickY, deltaTime);
                    }
                } else if (now - lastHorizStepAt > HORIZONTAL_STEP_COOLDOWN_MS) {
                    const dx = Math.abs(stickX) > SELECT_THRESHOLD ? Math.sign(stickX) : 0;
                    const dz = Math.abs(stickY) > SELECT_THRESHOLD ? -Math.sign(stickY) : 0;
                    if (dx !== 0 || dz !== 0) {
                        nudgeHorizontal(state.floors, { x: dx, z: dz }, gridSize);
                        lastHorizStepAt = now;
                    }
                }
            }
        }
    };
}
