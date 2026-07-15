import type { MinimapConfig } from './minimap.js';
import {
    type FloorAdjustState, type MapContext, createFloorAdjustState,
    selectNextFloor, toggleAxisMode, nudgeVertical, nudgeHorizontal, cancelPreview,
} from './floorAdjust.js';

/**
 * @typedef EditableParam
 * @prop key MinimapConfig field this param controls
 * @prop label Human-readable name shown in the panels
 * @prop min/max/step Slider / stick adjustment range
 */
export interface EditableParam {
    key: keyof MinimapConfig;
    label: string;
    min: number;
    max: number;
    step: number;
}

// Floor-detection params only (the ones that currently need live tuning)
export const EDITABLE_PARAMS: EditableParam[] = [
    { key: 'normalThreshold', label: 'Normal threshold', min: 0.1, max: 1.0, step: 0.01 },
    { key: 'minFloorGap', label: 'Min floor gap', min: 0.05, max: 2.0, step: 0.01 },
    { key: 'histoHeightSize', label: 'Histogram slice', min: 0.02, max: 0.5, step: 0.01 },
    { key: 'minPeakArea', label: 'Min peak area', min: 0.5, max: 20, step: 0.5 },
];

export type EditPanel = 'config' | 'floors';

/**
 * @typedef EditModeState
 * @prop active whether the edit mode overlay is currently shown
 * @prop panel which sub-panel is currently shown/controlled: config tuning or floor repositioning
 * @prop selectedIdx index into EDITABLE_PARAMS currently highlighted
 * @prop config live MinimapConfig, mutated in place by the panels
 * @prop defaults original MinimapConfig, used by resetToDefaults
 * @prop isRebuilding a rebuild is in progress
 * @prop isDirty config changed since the last successful rebuild
 * @prop floors floor repositioning sub-state
 */
export interface EditModeState {
    active: boolean;
    panel: EditPanel;
    selectedIdx: number;
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
        selectedIdx: 0,
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

export function selectNextParam(state: EditModeState, dir: 1 | -1): void {
    const n = EDITABLE_PARAMS.length;
    state.selectedIdx = (state.selectedIdx + dir + n) % n;
}

export function adjustSelectedParam(state: EditModeState, delta: number): void {
    const param = EDITABLE_PARAMS[state.selectedIdx];
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
 *    - stick up/down (no trigger)      : move the param selection
 *    - stick left/right + trigger held : adjust the selected param's value
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

            if (!triggerHeld && Math.abs(stickY) > SELECT_THRESHOLD && now - lastSelectAt > SELECT_COOLDOWN_MS) {
                selectNextParam(state, stickY > 0 ? 1 : -1);
                lastSelectAt = now;
            }

            if (triggerHeld && Math.abs(stickX) > ADJUST_THRESHOLD) {
                const param = EDITABLE_PARAMS[state.selectedIdx];
                const rangeSpeed = (param.max - param.min) * 0.3; // ~3.3s to cross the full range
                adjustSelectedParam(state, stickX * rangeSpeed * deltaTime);
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
