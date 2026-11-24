import type { MinimapConfig } from './minimap.js';
import {
    type FloorAdjustState, type MapContext, createFloorAdjustState,
    selectNextFloor, toggleAxisMode, nudgeVertical, nudgeHorizontal, cancelPreview, hasPendingPreview,
} from './floorAdjust.js';
import { noFeedback, type Notify } from './feedback.js';

export type ParamCategory = 'general' | 'floors' | 'walls' | 'stairs' | 'rooms';

/** Param groups, shown as collapsible sections (only one open at a time) */
export const PARAM_CATEGORIES: { key: ParamCategory; label: string }[] = [
    { key: 'general', label: 'Général' },
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
    // Smaller cells = finer map but ~1/gridSize² more rays (slower build); radii/areas in cells shrink with it
    { key: 'gridSize', category: 'general', label: 'Grid size (m)', min: 0.05, max: 1.0, step: 0.05 },
    { key: 'normalThreshold', category: 'floors', label: 'Floor normal thr.', min: 0.1, max: 1.0, step: 0.01 },
    { key: 'minFloorGap', category: 'floors', label: 'Min floor gap', min: 0.05, max: 2.0, step: 0.01 },
    { key: 'histoHeightSize', category: 'floors', label: 'Histogram slice', min: 0.02, max: 0.5, step: 0.01 },
    { key: 'minPeakArea', category: 'floors', label: 'Min peak area', min: 0.5, max: 20, step: 0.5 },
    { key: 'floorOpeningRadius', category: 'floors', label: 'Opening radius', min: 0, max: 5, step: 1 },
    // Under 1.0 m furniture becomes walls, over 1.8 m door lintels close the doors
    { key: 'wallScanHeight', category: 'walls', label: 'Wall scan height', min: 1.0, max: 1.8, step: 0.05 },
    // Only matters for tilted or curved walls: too low misses them, too high takes seats and slopes for walls
    { key: 'wallNormalThreshold', category: 'walls', label: 'Wall normal thr.', min: 0.2, max: 0.4, step: 0.05 },
    { key: 'minStairArea', category: 'stairs', label: 'Min stair area', min: 0.05, max: 5, step: 0.05 },
    { key: 'maxStairArea', category: 'stairs', label: 'Max stair area', min: 1, max: 30, step: 0.5 },
    { key: 'maxSlopeDeg', category: 'stairs', label: 'Stair max slope (°)', min: 20, max: 85, step: 1 },
    { key: 'stairFlatTolerance', category: 'stairs', label: 'Stair flat tolerance', min: 0, max: 0.2, step: 0.01 },
    { key: 'maxLandingRun', category: 'stairs', label: 'Max landing run', min: 0.2, max: 5, step: 0.1 },
    { key: 'doorWidth', category: 'rooms', label: 'Door width', min: 0.4, max: 3.0, step: 0.05 },
    { key: 'minRoomArea', category: 'rooms', label: 'Min room area', min: 0.25, max: 20, step: 0.25 },
    { key: 'minRoomWidth', category: 'rooms', label: 'Min room width', min: 0, max: 2.0, step: 0.05 },
    { key: 'corridorMaxWidth', category: 'rooms', label: 'Corridor max width', min: 0.5, max: 5.0, step: 0.1 },
    { key: 'corridorMinElongation', category: 'rooms', label: 'Corridor min elong.', min: 1.5, max: 15, step: 0.5 },
];

export type ConfigAction = 'reset' | 'save';

/** Buttons of the VR panels: the config list's, and the floors panel's cancel */
export type PanelAction = ConfigAction | 'cancelFloorMove';

// How long a VR panel button shows its "done" state after being pressed
const ACTION_FLASH_MS = 2000;

/** One line of the config list: a category header, a param of the open category, or a button under the categories */
export type ConfigRow =
    | { kind: 'category'; category: ParamCategory; label: string; count: number }
    | { kind: 'param'; param: EditableParam }
    | { kind: 'action'; action: ConfigAction; label: string };

export type EditPanel = 'config' | 'floors' | 'minimap3d';

/**
 * @typedef EditModeState
 * @prop active whether the edit mode overlay is currently shown
 * @prop panel which sub-panel is currently shown/controlled: config tuning or floor repositioning
 * @prop openCategory expanded section of the config list (null = all collapsed)
 * @prop selectedRow index into getConfigRows() currently highlighted (VR navigation)
 * @prop selectedByPointer the selection follows the controller's ray: the VR list keeps its scroll (centring the
 *                         selection would move the rows under the ray). The stick centres it
 * @prop listScroll VR config list's scroll, kept by its drawing
 * @prop config live MinimapConfig, mutated in place by the panels
 * @prop defaults original MinimapConfig, used by resetToDefaults
 * @prop isRebuilding a rebuild is in progress (it runs in the background, the config stays editable)
 * @prop buildProgress progress of the running rebuild in [0, 1]
 * @prop buildLabel current step of the running rebuild
 * @prop isDirty config changed since the last rebuild was started
 * @prop floors floor repositioning sub-state
 * @prop actionFlash last VR panel button pressed and when (performance.now()), for its "done" feedback
 */
export interface EditModeState {
    active: boolean;
    panel: EditPanel;
    openCategory: ParamCategory | null;
    selectedRow: number;
    selectedByPointer: boolean;
    listScroll: number;
    config: MinimapConfig;
    defaults: MinimapConfig;
    isRebuilding: boolean;
    buildProgress: number;
    buildLabel: string;
    isDirty: boolean;
    floors: FloorAdjustState;
    actionFlash: { action: PanelAction; at: number } | null;
}

/**
 * @param defaults Config restored by resetToDefaults
 * @param initialConfig Config the panels start from (e.g. the one the loaded map was built with)
 */
export function createEditMode(defaults: MinimapConfig, initialConfig: MinimapConfig = defaults): EditModeState {
    return {
        active: false,
        panel: 'config',
        openCategory: null,
        selectedRow: 0,
        selectedByPointer: false,
        listScroll: 0,
        config: { ...initialConfig },
        defaults: { ...defaults },
        isRebuilding: false,
        buildProgress: 0,
        buildLabel: '',
        isDirty: false,
        floors: createFloorAdjustState(),
        actionFlash: null,
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

export type RebuildAction = 'build' | 'restart' | 'cancel';

/**
 * What the rebuild button does right now: during a rebuild, restart it with the edited config,
 * or stop it when the config didn't change since it started
 */
export function getRebuildAction(state: EditModeState): RebuildAction {
    if (!state.isRebuilding) return 'build';
    return state.isDirty ? 'restart' : 'cancel';
}

/**
 * Visible lines of the config list: every category header, with the params of the open one right below it,
 * then the buttons (as on the desktop panel)
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
    rows.push({ kind: 'action', action: 'reset', label: 'Valeurs par défaut' });
    rows.push({ kind: 'action', action: 'save', label: 'Sauvegarder la carte' });
    return rows;
}

/** The VR panel button was pressed in the last ACTION_FLASH_MS: it shows its "done" state */
export function isActionFlashing(state: EditModeState, action: PanelAction): boolean {
    return state.actionFlash?.action === action && performance.now() - state.actionFlash.at < ACTION_FLASH_MS;
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

/** Set a param from a slider: snapped to its step, within its range */
export function setParamValue(state: EditModeState, param: EditableParam, value: number): void {
    const snapped = param.min + Math.round((value - param.min) / param.step) * param.step;
    const next = Math.min(param.max, Math.max(param.min, snapped));
    if (next === state.config[param.key]) return;
    state.config[param.key] = next;
    state.isDirty = true;
}

export function adjustParam(state: EditModeState, param: EditableParam, delta: number): void {
    const next = state.config[param.key] + delta;
    state.config[param.key] = Math.min(param.max, Math.max(param.min, next));
    state.isDirty = true;
}

const SELECT_THRESHOLD = 0.6;
const ADJUST_THRESHOLD = 0.15;
const SELECT_COOLDOWN_MS = 250;
const TAB_SWITCH_REARM = 0.3;
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
 * What pressing a VR panel button does (with the stick or the controller's ray): reset the config, save the map,
 * cancel the floor move. Feedback in the right hand, the button shows its "done" state
 */
export function createPanelActionPress(
    state: EditModeState,
    onSaveMap: () => void,
    getMapContext: () => MapContext,
    notify: Notify,
): (action: PanelAction) => void {
    return (action) => {
        switch (action) {
            case 'reset':
                resetToDefaults(state);
                notify('right', 'done', 'Valeurs par défaut rétablies');
                break;
            case 'save':
                if (getMapContext().levelCount === 0) {
                    notify('right', 'refused', 'Aucune carte à sauvegarder');
                    return;
                }
                onSaveMap();
                notify('right', 'done', 'Carte sauvegardée');
                break;
            case 'cancelFloorMove':
                if (!hasPendingPreview(state.floors)) {
                    notify('right', 'refused', 'Rien à annuler');
                    return;
                }
                cancelPreview(state.floors);
                notify('right', 'done', 'Déplacement annulé');
                break;
        }
        state.actionFlash = { action, at: performance.now() };
    };
}

/**
 * Controller input for the edit mode, all on the right hand (the left one is for the minimap and moving).
 *  A button             : toggles edit mode on/off (any panel)
 *  stick left/right     : switch tab (config <-> floors), without the trigger
 *  Panel = 'config':
 *    - stick up/down (no trigger)      : move the selection (category headers + params of the open one + buttons)
 *    - stick click                     : open/close the selected category (or the selected param's one),
 *                                        or press the selected button (reset to defaults, save the map to a file)
 *    - stick left/right + trigger held : adjust the selected param's value, or open (→) / close (←) a selected category
 *    - B button                        : rebuild the minimap (raycast), see getRebuildAction
 *  Panel = 'floors':
 *    - stick up/down (no trigger) : select the floor to reposition, or the cancel button under the floors
 *    - stick click                : toggle axis mode (vertical Y <-> horizontal X/Z), or press the cancel button
 *    - trigger + stick            : nudge the selected floor along the active axis (preview only)
 *    - B button                   : confirm bake the preview offset into the map data
 *
 * @param state edit mode state to mutate
 * @param onRebuildConfig called on right B press while panel = 'config'
 * @param onSaveMap called when the save button of the config panel is pressed, with a map to save
 * @param onConfirmFloorMove called on right B press while panel = 'floors'
 * @param getMapContext returns the current floor count + grid size, needed for floor selection/nudging
 * @param notify feedback (vibration, message) of what the input did
 * @param pointerHasTrigger the controller's ray is using the trigger (pointing at the panel): trigger + stick do nothing
 * @return update function to call every frame with the current session + deltaTime
 */
export function createEditModeInputHandler(
    state: EditModeState,
    onRebuildConfig: () => void,
    onSaveMap: () => void,
    onConfirmFloorMove: () => void,
    getMapContext: () => MapContext,
    notify: Notify = noFeedback,
    pointerHasTrigger: () => boolean = () => false,
): (session: XRSession | null, deltaTime: number) => void {
    let prevToggle = false;
    let prevRightB = false;
    let prevRightStickClick = false;
    let tabSwitchArmed = true;
    let lastSelectAt = 0;
    let lastHorizStepAt = 0;
    const press = createPanelActionPress(state, onSaveMap, getMapContext, notify);

    return (session, deltaTime) => {
        if (!session) return;

        const rightGp = findGamepad(session, 'right');
        if (!rightGp) return;

        const [toggled, toggleHeld] = pressedEdge(rightGp, 4, prevToggle);
        if (toggled) {
            state.active = !state.active;
            notify('right', 'tick', state.active ? 'Mode édition' : 'Édition fermée');
        }
        prevToggle = toggleHeld;

        if (!state.active) {
            prevRightB = false;
            prevRightStickClick = false;
            tabSwitchArmed = true;
            return;
        }

        const stickX = rightGp.axes[2] ?? 0;
        const stickY = rightGp.axes[3] ?? 0;
        const triggerHeld = !pointerHasTrigger() && (rightGp.buttons[0]?.value ?? 0) > 0.5;
        const now = performance.now();
        // A diagonal push counts for its main direction only: switching tab while scrolling the list would be a surprise
        const horizontal = Math.abs(stickX) > Math.abs(stickY);

        // Tabs: one switch per push, the stick has to come back near the centre before the next one
        if (!triggerHeld && horizontal && tabSwitchArmed && Math.abs(stickX) > SELECT_THRESHOLD) {
            const panel = stickX > 0 ? 'floors' : 'config';
            if (panel !== state.panel) notify('right', 'tick');
            state.panel = panel;
            tabSwitchArmed = false;
        } else if (Math.abs(stickX) < TAB_SWITCH_REARM) {
            tabSwitchArmed = true;
        }
        const selecting = !triggerHeld && !horizontal && Math.abs(stickY) > SELECT_THRESHOLD && now - lastSelectAt > SELECT_COOLDOWN_MS;

        if (state.panel === 'config') {
            state.floors.isMoving = false;

            const [rebuild, rebuildHeld] = pressedEdge(rightGp, 5, prevRightB);
            if (rebuild) onRebuildConfig();
            prevRightB = rebuildHeld;

            const row = getSelectedRow(state);

            const [stickClick, stickClickHeld] = pressedEdge(rightGp, 3, prevRightStickClick);
            if (stickClick) {
                if (row.kind === 'action') {
                    press(row.action);
                } else {
                    toggleCategory(state, row.kind === 'category' ? row.category : row.param.category);
                    notify('right', 'tick');
                }
            }
            prevRightStickClick = stickClickHeld;

            if (selecting) {
                selectNextRow(state, stickY > 0 ? 1 : -1);
                state.selectedByPointer = false;
                notify('right', 'tick');
                lastSelectAt = now;
            }

            if (triggerHeld && row.kind === 'category' && Math.abs(stickX) > SELECT_THRESHOLD) {
                const open = stickX > 0;
                if ((state.openCategory === row.category) !== open) notify('right', 'tick');
                setCategoryOpen(state, row.category, open);
            } else if (triggerHeld && row.kind === 'param' && Math.abs(stickX) > ADJUST_THRESHOLD) {
                const { param } = row;
                const rangeSpeed = (param.max - param.min) * 0.3; // ~3.3s to cross the full range
                adjustParam(state, param, stickX * rangeSpeed * deltaTime);
            }
        } else {
            const floors = state.floors;
            const [confirm, confirmHeld] = pressedEdge(rightGp, 5, prevRightB);
            if (confirm) onConfirmFloorMove();
            prevRightB = confirmHeld;

            const [stickClick, stickClickHeld] = pressedEdge(rightGp, 3, prevRightStickClick);
            if (stickClick) {
                if (floors.cancelSelected) {
                    press('cancelFloorMove');
                } else {
                    toggleAxisMode(floors);
                    notify('right', 'tick', floors.axisMode === 'vertical' ? 'Axe : vertical' : 'Axe : horizontal');
                }
            }
            prevRightStickClick = stickClickHeld;

            const { levelCount, gridSize } = getMapContext();

            floors.isMoving = triggerHeld;

            if (selecting && levelCount > 0) {
                // The panel lists the floors top floor first, the cancel button under the lowest one. No wrapping:
                // stick up (negative axis value) goes up the list
                const before = `${floors.selectedFloorIdx} ${floors.cancelSelected}`;
                if (stickY < 0) {
                    if (floors.cancelSelected) floors.cancelSelected = false; // back on the floor being moved, its preview kept
                    else if (floors.selectedFloorIdx < levelCount - 1) selectNextFloor(floors, levelCount, 1);
                } else if (!floors.cancelSelected) {
                    if (floors.selectedFloorIdx > 0) selectNextFloor(floors, levelCount, -1);
                    else floors.cancelSelected = true;
                }
                if (`${floors.selectedFloorIdx} ${floors.cancelSelected}` !== before) notify('right', 'tick');
                lastSelectAt = now;
            }

            if (triggerHeld) {
                if (floors.axisMode === 'vertical') {
                    if (Math.abs(stickY) > ADJUST_THRESHOLD) {
                        nudgeVertical(floors, stickY, deltaTime);
                    }
                } else if (now - lastHorizStepAt > HORIZONTAL_STEP_COOLDOWN_MS) {
                    const dx = Math.abs(stickX) > SELECT_THRESHOLD ? Math.sign(stickX) : 0;
                    const dz = Math.abs(stickY) > SELECT_THRESHOLD ? -Math.sign(stickY) : 0;
                    if (dx !== 0 || dz !== 0) {
                        nudgeHorizontal(floors, { x: dx, z: dz }, gridSize);
                        lastHorizStepAt = now;
                    }
                }
            }
        }
    };
}
