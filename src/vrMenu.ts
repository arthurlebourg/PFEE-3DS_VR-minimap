import * as THREE from 'three';
import type { ControllerRay } from './controllerRay.js';
import type { Notify } from './feedback.js';
import { drawControlsHelp, HELP_H, HELP_W } from './controlsHelp.js';
import {
    createCanvasPanel, panelPointAt, placeInFrontOfHead, regionAt, roundRect, type Region,
} from './vrCanvasPanel.js';

/**
 * VR menu, left Menu button (right B outside the edit mode too): controls help, tutorial, change map. In front of
 * the user, driven by the right controller's ray (trigger clicks) or its stick (↕ choose, click). Pressing the same
 * button again closes it
 */

export interface VRMenuActions {
    restartTutorial: () => void;
    /** Leave VR and go back to the model / map choice */
    changeMap: () => void;
}

export interface VRMenu {
    readonly isOpen: boolean;
    open: () => void;
    close: () => void;
    /**
     * Once per frame in VR, after ray.update(). While open the right stick and trigger are the menu's
     * @param rayReady the right controller's ray is usable this frame
     */
    update: (rayReady: boolean) => void;
    dispose: () => void;
}

type MenuItem = 'help' | 'tutorial' | 'changeMap' | 'close';
type MenuTarget = { kind: 'item'; item: MenuItem } | { kind: 'back' };

const MENU_ITEMS: MenuItem[] = ['help', 'tutorial', 'changeMap', 'close'];
const MENU_LABELS: Record<MenuItem, string> = {
    help: 'Aide des contrôles',
    tutorial: 'Revoir le tutoriel',
    changeMap: 'Changer de carte',
    close: 'Fermer',
};
// "Change map" leaves the session: a second click within this delay confirms it
const CONFIRM_MS = 3000;

const PLACEMENT = { distance: 0.6, below: 0.15, tilt: THREE.MathUtils.degToRad(-10) };

const MENU_W = 256, MENU_H = 220;
const ITEM_TOP = 44, ITEM_H = 36, ITEM_GAP = 4;
// The help is wider than the menu: a bit further away, so it fits in the view
const HELP_SIZE_M = 0.8;
const HELP_EXTRA_DISTANCE = 0.15;

const TRIGGER_THRESHOLD = 0.5;
const SELECT_THRESHOLD = 0.6;
const SELECT_REARM = 0.3;

/**
 * @param parent the player: the menu comes along when moving
 * @param camera user camera (its pose in the player's space places the menu)
 */
export function createVRMenu(
    parent: THREE.Object3D,
    camera: THREE.Camera,
    ray: ControllerRay,
    notify: Notify,
    actions: VRMenuActions,
): VRMenu {
    const anchor = new THREE.Group();
    anchor.name = 'vr-menu';
    anchor.visible = false;
    parent.add(anchor);

    const menuPanel = createCanvasPanel(0.3, 0.3 * MENU_H / MENU_W, MENU_W, MENU_H, 3);
    const helpPanel = createCanvasPanel(HELP_SIZE_M, HELP_SIZE_M * HELP_H / HELP_W, HELP_W, HELP_H, 2);
    helpPanel.mesh.position.z = -HELP_EXTRA_DISTANCE;
    anchor.add(menuPanel.mesh, helpPanel.mesh);

    let isOpen = false;
    let view: 'menu' | 'help' = 'menu';
    let selected = 0;
    let confirmUntil = 0;
    let dirty = true;
    let menuRegions: Region<MenuTarget>[] = [];
    let helpRegions: Region<MenuTarget>[] = [];

    let triggerWasHeld = true; // the press that opened the menu isn't a click
    let stickClickWasHeld = true;
    let selectArmed = false;

    function setView(next: 'menu' | 'help'): void {
        view = next;
        menuPanel.mesh.visible = view === 'menu';
        helpPanel.mesh.visible = view === 'help';
        dirty = true;
    }

    function close(): void {
        isOpen = false;
        anchor.visible = false;
        confirmUntil = 0;
    }

    function activate(target: MenuTarget): void {
        if (target.kind === 'back') {
            setView('menu');
            notify('right', 'tick');
            return;
        }
        switch (target.item) {
            case 'help':
                setView('help');
                notify('right', 'tick');
                break;
            case 'tutorial':
                close();
                actions.restartTutorial();
                break;
            case 'changeMap':
                if (performance.now() < confirmUntil) {
                    close();
                    actions.changeMap();
                } else {
                    confirmUntil = performance.now() + CONFIRM_MS;
                    notify('right', 'refused', 'Cliquer encore pour confirmer');
                }
                break;
            case 'close':
                close();
                notify('right', 'tick', 'Menu fermé');
                break;
        }
        dirty = true;
    }

    function drawMenu(): void {
        const ctx = menuPanel.begin();
        menuRegions = [];
        ctx.fillStyle = 'rgba(10,12,18,0.94)';
        roundRect(ctx, 0, 0, MENU_W, MENU_H, 10);
        ctx.fill();

        ctx.fillStyle = '#ffee44';
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Menu', MENU_W / 2, 28);

        const confirming = performance.now() < confirmUntil;
        MENU_ITEMS.forEach((item, i) => {
            const y = ITEM_TOP + i * (ITEM_H + ITEM_GAP);
            const isSelected = i === selected;
            const isConfirm = item === 'changeMap' && confirming;
            menuRegions.push({ x: 14, y, w: MENU_W - 28, h: ITEM_H, target: { kind: 'item', item } });

            ctx.fillStyle = isConfirm ? '#8a4a1c' : isSelected ? '#2668a6' : '#1d2a3a';
            roundRect(ctx, 14, y, MENU_W - 28, ITEM_H, 6);
            ctx.fill();
            if (isSelected) {
                ctx.strokeStyle = '#ffc83c';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            ctx.fillStyle = '#fff';
            ctx.font = `${isSelected ? 'bold ' : ''}14px sans-serif`;
            ctx.fillText(isConfirm ? 'Confirmer : quitter la carte' : MENU_LABELS[item], MENU_W / 2, y + ITEM_H / 2 + 5);
        });

        ctx.fillStyle = '#888';
        ctx.font = '10px sans-serif';
        ctx.fillText('viser + gâchette · stick ↕ + clic · Menu : fermer', MENU_W / 2, MENU_H - 10);
        menuPanel.commit();
    }

    function drawHelp(): void {
        const ctx = helpPanel.begin();
        helpRegions = [];
        drawControlsHelp(ctx);

        // Back to the menu
        const backW = 170, backH = 30, backX = HELP_W - backW - 20, backY = 14;
        helpRegions.push({ x: backX, y: backY, w: backW, h: backH, target: { kind: 'back' } });
        ctx.fillStyle = '#2668a6';
        roundRect(ctx, backX, backY, backW, backH, 6);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('← Retour (clic stick)', backX + backW / 2, backY + 20);
        helpPanel.commit();
    }

    setView('menu');

    return {
        get isOpen() { return isOpen; },

        open() {
            isOpen = true;
            selected = 0;
            confirmUntil = 0;
            triggerWasHeld = true;
            stickClickWasHeld = true;
            selectArmed = false;
            setView('menu');
            placeInFrontOfHead(anchor, camera, PLACEMENT);
            anchor.visible = true;
            notify('right', 'tick');
        },

        close,

        update(rayReady) {
            if (!isOpen) return;
            const gamepad = ray.gamepad;
            const triggerHeld = (gamepad?.buttons[0]?.value ?? 0) > TRIGGER_THRESHOLD;
            const triggerPressed = triggerHeld && !triggerWasHeld;
            triggerWasHeld = triggerHeld;
            const stickClickHeld = gamepad?.buttons[3]?.pressed ?? false;
            const stickClicked = stickClickHeld && !stickClickWasHeld;
            stickClickWasHeld = stickClickHeld;

            // A confirmation running out redraws the button
            if (confirmUntil && performance.now() >= confirmUntil) {
                confirmUntil = 0;
                dirty = true;
            }

            // Stick: ↕ choose (menu), click activates (menu) / goes back (help)
            const stickY = gamepad?.axes[3] ?? 0;
            if (view === 'menu') {
                if (selectArmed && Math.abs(stickY) > SELECT_THRESHOLD) {
                    selected = (selected + (stickY > 0 ? 1 : -1) + MENU_ITEMS.length) % MENU_ITEMS.length;
                    selectArmed = false;
                    dirty = true;
                    notify('right', 'tick');
                } else if (Math.abs(stickY) < SELECT_REARM) {
                    selectArmed = true;
                }
            }
            if (stickClicked) activate(view === 'menu' ? { kind: 'item', item: MENU_ITEMS[selected] } : { kind: 'back' });

            // Ray: hover selects, trigger clicks
            const panel = view === 'menu' ? menuPanel : helpPanel;
            const point = rayReady && isOpen ? panelPointAt(panel, ray.raycaster) : null;
            if (rayReady && isOpen) ray.show(point ? point.distance : null);
            if (point) {
                const region = regionAt(view === 'menu' ? menuRegions : helpRegions, point.x, point.y);
                if (region?.target.kind === 'item') {
                    const index = MENU_ITEMS.indexOf(region.target.item);
                    if (index !== selected) {
                        selected = index;
                        dirty = true;
                    }
                }
                if (triggerPressed && region) activate(region.target);
            }

            if (dirty && isOpen) {
                if (view === 'menu') drawMenu();
                else drawHelp();
                dirty = false;
            }
        },

        dispose() {
            menuPanel.dispose();
            helpPanel.dispose();
            anchor.removeFromParent();
        },
    };
}

