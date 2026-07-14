import type { MinimapConfig } from './minimap.js';

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

/**
 * @typedef EditModeState
 * @prop active whether the edit mode overlay is currently shown
 * @prop selectedIdx index into EDITABLE_PARAMS currently highlighted
 * @prop config live MinimapConfig, mutated in place by the panels
 * @prop defaults original MinimapConfig, used by resetToDefaults
 * @prop isRebuilding a rebuild is in progress
 * @prop isDirty config changed since the last successful rebuild
 */
export interface EditModeState {
    active: boolean;
    selectedIdx: number;
    config: MinimapConfig;
    defaults: MinimapConfig;
    isRebuilding: boolean;
    isDirty: boolean;
}

export function createEditMode(initialConfig: MinimapConfig): EditModeState {
    return {
        active: false,
        selectedIdx: 0,
        config: { ...initialConfig },
        defaults: { ...initialConfig },
        isRebuilding: false,
        isDirty: false,
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
 * Controller input for the edit mode ("hold trigger + push stick" UX):
 *  Right hand
 *  - A/X button                      : toggle edit mode on/off
 *  - B/Y button                      : trigger an explicit rebuild
 *  - stick up/down (no trigger)      : move the selection between params
 *  - stick left/right + trigger held : adjust the selected param's value
 *  Left hand (only while edit mode is active)
 *  - X button                        : save the current map to a file
 *  - Y button                        : reset config to defaults
 *
 * @param state edit mode state to mutate
 * @param onRebuild called once per right B/Y button press while active
 * @param onSave called once per left X button press while active
 * @param onReset called once per left Y button press while active
 * @return update function to call every frame with the current session + deltaTime
 */
export function createEditModeInputHandler(
    state: EditModeState,
    onRebuild: () => void,
    onSave: () => void,
    onReset: () => void,
): (session: XRSession | null, deltaTime: number) => void {
    let prevToggle = false;
    let prevRebuild = false;
    let prevSave = false;
    let prevReset = false;
    let lastSelectAt = 0;

    return (session, deltaTime) => {
        if (!session) return;

        const rightGp = findGamepad(session, 'right');
        if (rightGp) {
            const [toggled, toggleHeld] = pressedEdge(rightGp, 4, prevToggle);
            if (toggled) state.active = !state.active;
            prevToggle = toggleHeld;
        }

        if (!state.active) {
            prevRebuild = false;
            prevSave = false;
            prevReset = false;
            return;
        }

        if (rightGp) {
            const [rebuild, rebuildHeld] = pressedEdge(rightGp, 5, prevRebuild);
            if (rebuild) onRebuild();
            prevRebuild = rebuildHeld;

            const stickX = rightGp.axes[2] ?? 0;
            const stickY = rightGp.axes[3] ?? 0;
            const triggerHeld = (rightGp.buttons[0]?.value ?? 0) > 0.5;

            const now = performance.now();
            if (!triggerHeld && Math.abs(stickY) > SELECT_THRESHOLD && now - lastSelectAt > SELECT_COOLDOWN_MS) {
                selectNextParam(state, stickY > 0 ? 1 : -1);
                lastSelectAt = now;
            }

            if (triggerHeld && Math.abs(stickX) > ADJUST_THRESHOLD) {
                const param = EDITABLE_PARAMS[state.selectedIdx];
                const rangeSpeed = (param.max - param.min) * 0.3; // ~3.3s to cross the full range
                adjustSelectedParam(state, stickX * rangeSpeed * deltaTime);
            }
        }

        const leftGp = findGamepad(session, 'left');
        if (leftGp) {
            const [save, saveHeld] = pressedEdge(leftGp, 4, prevSave);
            if (save) onSave();
            prevSave = saveHeld;

            const [reset, resetHeld] = pressedEdge(leftGp, 5, prevReset);
            if (reset) onReset();
            prevReset = resetHeld;
        }
    };
}
