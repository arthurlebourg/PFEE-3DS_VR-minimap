import * as THREE from 'three';
import type { Notify } from './feedback.js';
import { createCanvasPanel, placeInFrontOfHead, roundRect, wrapText } from './vrCanvasPanel.js';

/**
 * First-launch tutorial in VR, 3 steps: move, the minimap, the menu and the edit mode. Each step is done by doing
 * what it says. A card in front of the user; done once per browser (the menu can replay it)
 */

export interface TutorialStep {
    title: string;
    text: string;
    /** Called when the step shows: reset what isDone watches, so what was done before doesn't count */
    onStart?: () => void;
    /** Polled every frame while the step is shown */
    isDone: () => boolean;
}

export interface Tutorial {
    readonly isRunning: boolean;
    /** From the first step, even when it was done before */
    restart: () => void;
    /**
     * Once per frame in VR
     * @param canShow the headset pose is known (the card is placed from it)
     * @param hidden a panel is in front (menu, edit mode): the card waits behind
     */
    update: (canShow: boolean, hidden: boolean) => void;
}

const STORAGE_KEY = 'vr-minimap:tutorialDone';
const PLACEMENT = { distance: 0.75, below: 0.05, tilt: THREE.MathUtils.degToRad(-5) };
const CARD_W = 420, CARD_H = 170;

function wasDone(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function rememberDone(): void {
    try {
        localStorage.setItem(STORAGE_KEY, '1');
    } catch {
        // private window or blocked storage: it'll show again next time
    }
}

/** @param parent the player: the card comes along when moving */
export function createTutorial(parent: THREE.Object3D, camera: THREE.Camera, steps: TutorialStep[], notify: Notify): Tutorial {
    const anchor = new THREE.Group();
    anchor.name = 'vr-tutorial';
    anchor.visible = false;
    parent.add(anchor);
    const card = createCanvasPanel(0.42, 0.17, CARD_W, CARD_H, 2);
    anchor.add(card.mesh);

    let stepIdx = wasDone() ? steps.length : 0;
    let placedStep = -1;

    function draw(): void {
        const step = steps[stepIdx];
        const ctx = card.begin();
        ctx.fillStyle = 'rgba(10,12,18,0.93)';
        roundRect(ctx, 0, 0, CARD_W, CARD_H, 12);
        ctx.fill();
        ctx.strokeStyle = '#2668a6';
        ctx.lineWidth = 3;
        roundRect(ctx, 1.5, 1.5, CARD_W - 3, CARD_H - 3, 11);
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.fillStyle = '#9fd8ff';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(`TUTORIEL · ÉTAPE ${stepIdx + 1}/${steps.length}`, 18, 26);
        ctx.fillStyle = '#ffee44';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText(step.title, 18, 54);

        ctx.fillStyle = '#eee';
        ctx.font = '15px sans-serif';
        wrapText(ctx, step.text, CARD_W - 36).forEach((line, i) => ctx.fillText(line, 18, 82 + i * 20));

        ctx.fillStyle = '#888';
        ctx.font = 'italic 11px sans-serif';
        ctx.fillText('Fais-le pour passer à la suite', 18, CARD_H - 14);
        card.commit();
    }

    return {
        get isRunning() { return stepIdx < steps.length; },

        restart() {
            stepIdx = 0;
            placedStep = -1;
        },

        update(canShow, hidden) {
            if (stepIdx >= steps.length || !canShow) {
                anchor.visible = false;
                return;
            }
            // Placed in front of the user at each new step, where they now look
            if (placedStep !== stepIdx) {
                placeInFrontOfHead(anchor, camera, PLACEMENT);
                draw();
                steps[stepIdx].onStart?.();
                placedStep = stepIdx;
            }
            anchor.visible = !hidden;

            if (!steps[stepIdx].isDone()) return;
            stepIdx++;
            if (stepIdx < steps.length) {
                notify('right', 'done', `Étape ${stepIdx}/${steps.length} réussie`);
            } else {
                anchor.visible = false;
                rememberDone();
                notify('right', 'done', 'Tutoriel terminé · B : menu et aide');
            }
        },
    };
}
