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
 * What each button of a controller does in the current context. The single description of the VR controls:
 * keep it in step with the input code (main.ts, editMode.ts, floorManager.ts)
 */
export function getControlHints(hand: Hand, ctx: ControlContext): ControlHints {
    return hand === 'left' ? leftHints(ctx) : rightHints(ctx);
}

function leftHints({ editActive, panel }: ControlContext): ControlHints {
    if (!editActive) {
        return {
            thumbstick: 'Se déplacer · clic : minimap',
            trigger: 'Maintenir : zoom minimap',
            x: 'Descendre',
            y: 'Monter',
        };
    }
    return {
        thumbstick: 'Se déplacer · clic : onglet',
        trigger: 'Maintenir : zoom minimap',
        y: panel === 'config' ? 'Valeurs par défaut' : 'Annuler le déplacement',
    };
}

function rightHints({ editActive, panel, rebuildAction, hasMap }: ControlContext): ControlHints {
    if (!editActive) {
        return {
            thumbstick: '↔ tourner · clic : vue minimap',
            trigger: 'Maintenir + stick ↕ : étage',
            squeeze: 'Grille de debug',
            a: 'Mode édition',
        };
    }
    if (panel === 'config') {
        return {
            thumbstick: '↕ choisir · clic : ouvrir/valider',
            trigger: 'Maintenir + stick ↔ : régler',
            squeeze: 'Grille de debug',
            a: 'Quitter l\'édition',
            b: rebuildAction === 'cancel' ? 'Arrêter le calcul'
                : rebuildAction === 'restart' ? 'Relancer le calcul'
                : hasMap ? 'Recalculer la carte' : 'Calculer la carte',
        };
    }
    return {
        thumbstick: '↕ étage · clic : axe',
        trigger: 'Maintenir + stick : déplacer',
        squeeze: 'Grille de debug',
        a: 'Quitter l\'édition',
        b: 'Confirmer le déplacement',
    };
}
