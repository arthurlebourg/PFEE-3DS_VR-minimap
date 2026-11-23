import * as THREE from 'three';
import { HUD_RENDER_ORDER } from './minimap.js';
import type { Hand } from './controlHints.js';

/**
 * Feedback of the VR controls: a vibration in the hand that pressed, and for what changes something a short
 * message above that hand ("Carte sauvegardée", "Vue : pièce", "Étage 2")
 *  tick    : light, for moving through a list, switching a tab, a display toggle
 *  done    : an action went through
 *  refused : nothing to do (no map to save, no floor above...)
 */
export type FeedbackLevel = 'tick' | 'done' | 'refused';

/** Give feedback in a hand: vibration, and the message if any */
export type Notify = (hand: Hand, level: FeedbackLevel, message?: string) => void;

export const noFeedback: Notify = () => {};

// intensity in [0, 1], durations in ms
const HAPTICS: Record<FeedbackLevel, { intensity: number; duration: number; repeat: number }> = {
    tick: { intensity: 0.2, duration: 12, repeat: 1 },
    done: { intensity: 0.6, duration: 60, repeat: 1 },
    refused: { intensity: 0.45, duration: 35, repeat: 2 },
};
const REPEAT_GAP_MS = 90;

const MESSAGE_COLORS: Record<FeedbackLevel, string> = { tick: '#9fd8ff', done: '#55ff88', refused: '#ff8844' };

const MESSAGE_W = 0.12; // m
const MESSAGE_H = 0.024;
const CANVAS_W = 512;
const CANVAS_H = Math.round(CANVAS_W * MESSAGE_H / MESSAGE_W);
// Above the hand, in world metres: over the minimap (left hand) and the edit panels (right hand)
const MESSAGE_HEIGHT_ABOVE_HAND = 0.2;
const MESSAGE_FADE_IN_MS = 100;
const MESSAGE_HOLD_MS = 1400;
const MESSAGE_FADE_OUT_MS = 400;
const FONT_SIZES = [52, 44, 38, 32]; // px, the first one the text fits in

/** Bits of the haptic APIs browsers have: pulse() on Quest, playEffect() on Chrome */
interface HapticActuatorLike {
    pulse?: (intensity: number, duration: number) => Promise<boolean>;
    playEffect?: (type: string, params: { duration: number; strongMagnitude: number; weakMagnitude: number }) => Promise<unknown>;
}

interface HandMessage {
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    canvas: HTMLCanvasElement;
    texture: THREE.CanvasTexture;
    shownAt: number;
}

export interface Feedback {
    notify: Notify;
    /** Once per frame: places the messages above the hands, facing the head, and fades them */
    update: (camera: THREE.Camera) => void;
}

/**
 * @param xr renderer.xr: feedback only while in VR
 * @param scene the messages are placed in world space (they don't turn with the controller)
 * @param handAnchors object following each hand's controller
 */
export function createFeedback(
    xr: THREE.WebGLRenderer['xr'],
    scene: THREE.Object3D,
    handAnchors: Record<Hand, THREE.Object3D>,
): Feedback {
    const messages: Record<Hand, HandMessage> = { left: createMessage(), right: createMessage() };
    const handPos = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();

    function createMessage(): HandMessage {
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(MESSAGE_W, MESSAGE_H),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
        );
        mesh.renderOrder = HUD_RENDER_ORDER + 5; // over the panels and the minimap
        mesh.visible = false;
        mesh.frustumCulled = false;
        scene.add(mesh);
        return { mesh, canvas, texture, shownAt: -Infinity };
    }

    function vibrate(hand: Hand, level: FeedbackLevel): void {
        const session = xr.getSession();
        if (!session) return;
        const source = [...session.inputSources].find(s => s.handedness === hand && s.gamepad);
        const gamepad = source?.gamepad as (Gamepad & { hapticActuators?: readonly HapticActuatorLike[] }) | undefined;
        const actuator: HapticActuatorLike | undefined | null = gamepad?.hapticActuators?.[0] ?? (gamepad?.vibrationActuator as HapticActuatorLike | null | undefined);
        if (!actuator) return;

        const { intensity, duration, repeat } = HAPTICS[level];
        const play = () => {
            if (actuator.pulse) void actuator.pulse(intensity, duration).catch(() => {});
            else void actuator.playEffect?.('dual-rumble', { duration, strongMagnitude: intensity, weakMagnitude: intensity }).catch(() => {});
        };
        for (let i = 0; i < repeat; i++) {
            if (i === 0) play();
            else setTimeout(play, i * (duration + REPEAT_GAP_MS));
        }
    }

    function show(hand: Hand, level: FeedbackLevel, text: string): void {
        const message = messages[hand];
        const ctx = message.canvas.getContext('2d')!;
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        const radius = CANVAS_H / 2;
        ctx.beginPath();
        ctx.roundRect(3, 3, CANVAS_W - 6, CANVAS_H - 6, radius - 3);
        ctx.fillStyle = 'rgba(12,16,24,0.9)';
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = MESSAGE_COLORS[level];
        ctx.stroke();

        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const maxWidth = CANVAS_W - 2 * radius;
        for (const size of FONT_SIZES) {
            ctx.font = `bold ${size}px sans-serif`;
            if (ctx.measureText(text).width <= maxWidth) break;
        }
        ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2 + 2, maxWidth);
        message.texture.needsUpdate = true;
        message.shownAt = performance.now();
    }

    return {
        notify(hand, level, text) {
            if (!xr.isPresenting) return;
            vibrate(hand, level);
            if (text) show(hand, level, text);
        },

        update(camera) {
            const now = performance.now();
            camera.getWorldQuaternion(headQuat);
            for (const hand of ['left', 'right'] as const) {
                const { mesh, shownAt } = messages[hand];
                const age = now - shownAt;
                const anchor = handAnchors[hand];
                const lifetime = MESSAGE_FADE_IN_MS + MESSAGE_HOLD_MS + MESSAGE_FADE_OUT_MS;
                mesh.visible = xr.isPresenting && age < lifetime && !!anchor.parent;
                if (!mesh.visible) continue;

                mesh.material.opacity = age < MESSAGE_FADE_IN_MS ? age / MESSAGE_FADE_IN_MS
                    : age < MESSAGE_FADE_IN_MS + MESSAGE_HOLD_MS ? 1
                    : 1 - (age - MESSAGE_FADE_IN_MS - MESSAGE_HOLD_MS) / MESSAGE_FADE_OUT_MS;
                anchor.getWorldPosition(handPos);
                mesh.position.set(handPos.x, handPos.y + MESSAGE_HEIGHT_ABOVE_HAND, handPos.z);
                mesh.quaternion.copy(headQuat);
            }
        },
    };
}
