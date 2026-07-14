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
 * @prop isRebuilding a rebuild is in progress
 * @prop isDirty config changed since the last successful rebuild
 */
export interface EditModeState {
    active: boolean;
    selectedIdx: number;
    config: MinimapConfig;
    isRebuilding: boolean;
    isDirty: boolean;
}

export function createEditMode(initialConfig: MinimapConfig): EditModeState {
    return {
        active: false,
        selectedIdx: 0,
        config: { ...initialConfig },
        isRebuilding: false,
        isDirty: false,
    };
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

/**
 * Right-controller input for the edit mode ("hold trigger + push stick" UX):
 *  - A/X button                      : toggle edit mode on/off
 *  - B/Y button                      : trigger an explicit rebuild
 *  - stick up/down (no trigger)      : move the selection between params
 *  - stick left/right + trigger held : adjust the selected param's value
 *
 * @param state edit mode state to mutate
 * @param onRebuild called once per B/Y button press while active
 * @return update function to call every frame with the current session + deltaTime
 */
export function createEditModeInputHandler(
    state: EditModeState,
    onRebuild: () => void,
): (session: XRSession | null, deltaTime: number) => void {
    let prevToggle = false;
    let prevRebuild = false;
    let lastSelectAt = 0;

    return (session, deltaTime) => {
        if (!session) return;

        let gp: Gamepad | null = null;
        for (const src of session.inputSources) {
            if (src.handedness === 'right' && src.gamepad) {
                gp = src.gamepad;
                break;
            }
        }
        if (!gp) return;

        const toggleBtn = gp.buttons[4]?.pressed ?? false;
        if (toggleBtn && !prevToggle) state.active = !state.active;
        prevToggle = toggleBtn;

        const rebuildBtn = gp.buttons[5]?.pressed ?? false;
        if (!state.active) {
            prevRebuild = rebuildBtn;
            return;
        }
        if (rebuildBtn && !prevRebuild) onRebuild();
        prevRebuild = rebuildBtn;

        const stickX = gp.axes[2] ?? 0;
        const stickY = gp.axes[3] ?? 0;
        const triggerHeld = (gp.buttons[0]?.value ?? 0) > 0.5;

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
    };
}
