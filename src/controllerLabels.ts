import * as THREE from 'three';
import type { XRControllerModel } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { HUD_RENDER_ORDER } from './minimap.js';
import type { ControllerButton, ControlHints, Hand } from './controlHints.js';

/**
 * Labels on the controllers: next to each button, what it does now, with a line to the button.
 * Shown while the user looks at the controller, the button under the finger (touched) highlighted
 */

// Buttons of each controller, top to bottom: the order of the labels when they're stacked
const HAND_BUTTONS: Record<Hand, ControllerButton[]> = {
    left: ['y', 'x', 'thumbstick', 'trigger', 'squeeze'],
    right: ['b', 'a', 'thumbstick', 'trigger', 'squeeze'],
};

// WebXR input profile component of each button, to find it in the controller model
const COMPONENT_IDS: Record<ControllerButton, string> = {
    trigger: 'xr-standard-trigger',
    squeeze: 'xr-standard-squeeze',
    thumbstick: 'xr-standard-thumbstick',
    a: 'a-button',
    b: 'b-button',
    x: 'x-button',
    y: 'y-button',
};

// 'xr-standard' gamepad mapping
const GAMEPAD_INDEX: Record<ControllerButton, number> = { trigger: 0, squeeze: 1, thumbstick: 3, a: 4, b: 5, x: 4, y: 5 };

// Rough button positions in grip space (right hand, X mirrored for the left), while the controller model isn't
// loaded (it comes from a CDN: offline, these stay)
const FALLBACK_ANCHORS: Record<ControllerButton, [number, number, number]> = {
    thumbstick: [-0.008, 0.012, -0.035],
    a: [0.012, 0.012, -0.025],
    b: [0.014, 0.016, -0.04],
    x: [0.012, 0.012, -0.025],
    y: [0.014, 0.016, -0.04],
    trigger: [0, -0.02, -0.045],
    squeeze: [-0.015, -0.015, -0.01],
};

// World up in grip space for a controller held naturally (the grip's -Z runs up along the handle, +Y towards the user)
const GRIP_UP = new THREE.Vector3(0, 1, -1).normalize();

const LABEL_W = 0.085; // m
const LABEL_H = 0.016;
const CANVAS_W = 512;
const CANVAS_H = Math.round(CANVAS_W * LABEL_H / LABEL_W);
// Grip X distance from a button to its label's centre, outwards (left of the left controller, right of the right one)
const LABEL_SIDE_OFFSET = 0.075;
// Min distance between two stacked labels, along GRIP_UP
const LABEL_MIN_GAP = LABEL_H + 0.003;

// Shown while the controller is within this angle of the gaze and this close to the head
const SHOW_MAX_ANGLE = THREE.MathUtils.degToRad(35);
const SHOW_MAX_DISTANCE = 0.8;
const FADE_SPEED = 8; // per second

const FONT_SIZES = [34, 30, 26, 22]; // px, the first one the text fits in

interface ButtonLabel {
    button: ControllerButton;
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    canvas: HTMLCanvasElement;
    texture: THREE.CanvasTexture;
    line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    /** Button position, grip space */
    anchor: THREE.Vector3;
    /** Label centre, grip space */
    slot: THREE.Vector3;
    /** text + highlight last drawn on the canvas */
    drawnKey: string;
}

/** Bits of the WebXR input profiles' MotionController this module reads (typed `unknown` by three) */
interface MotionControllerLike {
    components: Record<string, { rootNodeName?: string; visualResponses?: Record<string, { valueNode?: THREE.Object3D }> }>;
}

export interface ControllerLabels {
    /** The input source the grip now tracks (from its 'connected' event), null once disconnected */
    setInputSource: (source: XRInputSource | null) => void;
    /**
     * Once per frame in VR
     * @param getHints what the buttons of a hand do now
     * @param camera user camera, holding the headset pose
     */
    update: (getHints: (hand: Hand) => ControlHints, camera: THREE.Camera, deltaTime: number) => void;
    dispose: () => void;
}

/**
 * @param grip controller grip space the labels follow
 * @param model controller model on that grip: the labels point at its buttons once it's loaded
 */
export function createControllerLabels(grip: THREE.Object3D, model: XRControllerModel | null): ControllerLabels {
    const group = new THREE.Group();
    group.name = 'controller-labels';
    group.visible = false;
    grip.add(group);

    let source: XRInputSource | null = null;
    let hand: Hand | null = null;
    let labels: ButtonLabel[] = [];
    let laidOutFromModel = false;
    let opacity = 0;

    const tmpGrip = new THREE.Vector3();
    const tmpHead = new THREE.Vector3();
    const tmpGaze = new THREE.Vector3();
    const gripQuat = new THREE.Quaternion();
    const headQuat = new THREE.Quaternion();
    const faceHead = new THREE.Quaternion();
    const right = new THREE.Vector3();

    function disposeLabels(): void {
        for (const label of labels) {
            group.remove(label.mesh, label.line);
            label.mesh.geometry.dispose();
            label.mesh.material.dispose();
            label.texture.dispose();
            label.line.geometry.dispose();
            label.line.material.dispose();
        }
        labels = [];
    }

    function createLabel(button: ControllerButton): ButtonLabel {
        const canvas = document.createElement('canvas');
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(LABEL_W, LABEL_H),
            new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
        );
        mesh.renderOrder = HUD_RENDER_ORDER + 2;

        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x9fd8ff, transparent: true, depthTest: false, depthWrite: false }));
        line.renderOrder = HUD_RENDER_ORDER + 1;
        line.frustumCulled = false;

        group.add(line, mesh);
        return { button, mesh, canvas, texture, line, anchor: new THREE.Vector3(), slot: new THREE.Vector3(), drawnKey: '' };
    }

    /** Position of a button in the loaded controller model, grip space; null while it isn't loaded */
    function modelAnchor(button: ControllerButton, out: THREE.Vector3): THREE.Vector3 | null {
        const motionController = model?.motionController as MotionControllerLike | null | undefined;
        if (!model || !motionController || model.children.length === 0) return null;
        const component = motionController.components[COMPONENT_IDS[button]];
        if (!component) return null;
        const node = (component.rootNodeName ? model.getObjectByName(component.rootNodeName) : undefined)
            ?? Object.values(component.visualResponses ?? {}).find(response => response.valueNode)?.valueNode;
        if (!node) return null;
        node.updateWorldMatrix(true, false);
        return model.worldToLocal(node.getWorldPosition(out));
    }

    /** Anchor each label on its button and stack them outwards, top to bottom, without overlaps */
    function layout(): void {
        if (!hand) return;
        const side = hand === 'left' ? -1 : 1;
        laidOutFromModel = true;
        for (const label of labels) {
            if (!modelAnchor(label.button, label.anchor)) {
                const [x, y, z] = FALLBACK_ANCHORS[label.button];
                label.anchor.set(x * side, y, z);
                laidOutFromModel = false;
            }
            label.slot.copy(label.anchor);
            label.slot.x += side * LABEL_SIDE_OFFSET;
        }
        const stacked = [...labels].sort((a, b) => b.slot.dot(GRIP_UP) - a.slot.dot(GRIP_UP));
        for (let i = 1; i < stacked.length; i++) {
            const overlap = LABEL_MIN_GAP - (stacked[i - 1].slot.dot(GRIP_UP) - stacked[i].slot.dot(GRIP_UP));
            if (overlap > 0) stacked[i].slot.addScaledVector(GRIP_UP, -overlap);
        }
    }

    function draw(label: ButtonLabel, text: string, highlighted: boolean): void {
        const key = `${highlighted ? 1 : 0}${text}`;
        if (key === label.drawnKey) return;
        label.drawnKey = key;

        const ctx = label.canvas.getContext('2d')!;
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        const radius = CANVAS_H / 2;
        ctx.beginPath();
        ctx.roundRect(2, 2, CANVAS_W - 4, CANVAS_H - 4, radius - 2);
        ctx.fillStyle = highlighted ? 'rgba(38,104,166,0.95)' : 'rgba(12,16,24,0.88)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = highlighted ? '#ffee44' : 'rgba(159,216,255,0.45)';
        ctx.stroke();

        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const maxWidth = CANVAS_W - 2 * radius;
        for (const size of FONT_SIZES) {
            ctx.font = `bold ${size}px sans-serif`;
            if (ctx.measureText(text).width <= maxWidth) break;
        }
        ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2 + 1, maxWidth);
        label.texture.needsUpdate = true;
    }

    return {
        setInputSource(newSource) {
            source = newSource;
            const newHand = newSource?.handedness === 'left' || newSource?.handedness === 'right' ? newSource.handedness : null;
            if (newHand === hand) return;
            disposeLabels();
            hand = newHand;
            if (hand) labels = HAND_BUTTONS[hand].map(createLabel);
            laidOutFromModel = false;
            layout();
        },

        update(getHints, camera, deltaTime) {
            if (!hand || !grip.visible) {
                group.visible = false;
                opacity = 0;
                return;
            }

            // Looking at the controller: close to the head and near the centre of the view
            grip.getWorldPosition(tmpGrip);
            camera.getWorldPosition(tmpHead);
            camera.getWorldDirection(tmpGaze);
            const toGrip = tmpGrip.sub(tmpHead);
            const distance = toGrip.length();
            const looking = distance < SHOW_MAX_DISTANCE && distance > 1e-4 && toGrip.angleTo(tmpGaze) < SHOW_MAX_ANGLE;

            opacity += ((looking ? 1 : 0) - opacity) * Math.min(1, deltaTime * FADE_SPEED);
            if (!looking && opacity < 0.02) opacity = 0;
            group.visible = opacity > 0;
            if (!group.visible) return;

            if (!laidOutFromModel) layout();

            // Labels face the head: the camera orientation expressed in grip space
            grip.getWorldQuaternion(gripQuat);
            camera.getWorldQuaternion(headQuat);
            faceHead.copy(gripQuat).invert().multiply(headQuat);
            right.set(1, 0, 0).applyQuaternion(faceHead);
            const side = hand === 'left' ? -1 : 1;

            const hints = getHints(hand);
            const gamepad = source?.gamepad;
            for (const label of labels) {
                const text = hints[label.button];
                label.mesh.visible = label.line.visible = !!text;
                if (!text) continue;

                const gpButton = gamepad?.buttons[GAMEPAD_INDEX[label.button]];
                draw(label, text, !!(gpButton?.touched || gpButton?.pressed));

                label.mesh.position.copy(label.slot);
                label.mesh.quaternion.copy(faceHead);
                label.mesh.material.opacity = opacity;

                // from the button to the label's edge on the controller's side
                const positions = label.line.geometry.attributes.position as THREE.BufferAttribute;
                positions.setXYZ(0, label.anchor.x, label.anchor.y, label.anchor.z);
                positions.setXYZ(1,
                    label.slot.x - right.x * side * LABEL_W / 2,
                    label.slot.y - right.y * side * LABEL_W / 2,
                    label.slot.z - right.z * side * LABEL_W / 2);
                positions.needsUpdate = true;
                label.line.material.opacity = opacity * 0.8;
            }
        },

        dispose() {
            disposeLabels();
            grip.remove(group);
        },
    };
}
