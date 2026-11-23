import type { EditPanel, RebuildAction } from './editMode.js';

export type Hand = 'left' | 'right';

/** Buttons of a Touch controller: A / B on the right one, X / Y on the left one */
export type ControllerButton = 'trigger' | 'squeeze' | 'thumbstick' | 'a' | 'b' | 'x' | 'y';

/** What each button does right now, no entry = the button does nothing */
export type ControlHints = Partial<Record<ControllerButton, string>>;

/** What the buttons do depends on */
export interface ControlContext {
    editActive: boolean;
    panel: EditPanel;
    rebuildAction: RebuildAction;
    hasMap: boolean;
}

/**
 * What each button of a controller does in the current context. The single description of the VR controls, for the
 * help shown in the headset: keep it in step with the input code (main.ts, editMode.ts, floorManager.ts)
 */
export function getControlHints(hand: Hand, ctx: ControlContext): ControlHints {
    return hand === 'left' ? leftHints() : rightHints(ctx);
}

// The left hand is the minimap's (and moving), the same in every mode
function leftHints(): ControlHints {
    return {
        thumbstick: 'Se déplacer · clic : minimap',
        trigger: 'Vue minimap (pleine / pièce / voisines)',
        squeeze: 'Maintenir : zoom minimap',
        x: 'Descendre',
        y: 'Monter',
    };
}

// The right hand turns the view, changes floor and drives the edit mode
function rightHints({ editActive, panel, rebuildAction, hasMap }: ControlContext): ControlHints {
    if (!editActive) {
        return {
            thumbstick: '↔ tourner',
            trigger: 'Maintenir + stick ↕ : étage',
            squeeze: 'Grille de debug',
            a: 'Mode édition',
        };
    }
    if (panel === 'config') {
        return {
            thumbstick: '↕ choisir · ↔ onglet · clic : valider',
            trigger: 'Maintenir + stick ↔ : régler',
            squeeze: 'Grille de debug',
            a: 'Quitter l\'édition',
            b: rebuildAction === 'cancel' ? 'Arrêter le calcul'
                : rebuildAction === 'restart' ? 'Relancer le calcul'
                : hasMap ? 'Recalculer la carte' : 'Calculer la carte',
        };
    }
    return {
        thumbstick: '↕ étage · ↔ onglet · clic : axe',
        trigger: 'Maintenir + stick : déplacer',
        squeeze: 'Grille de debug',
        a: 'Quitter l\'édition',
        b: 'Confirmer le déplacement',
    };
}
