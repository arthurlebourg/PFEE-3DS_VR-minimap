import { getControlHints, type ControlContext, type ControllerButton, type Hand } from './controlHints.js';
import { roundRect, wrapText } from './vrCanvasPanel.js';

/**
 * Controls help: both Touch controllers drawn apart, each button linked by a line to what it does, the left
 * controller's on its left, the right one's on its right. Under them, what changes in the edit mode
 */

export const HELP_W = 960;
export const HELP_H = 540;

/** Buttons shown in the help: the controls' ones, plus the right controller's system (Meta) button */
type HelpButton = ControllerButton | 'system';

const BUTTON_NAMES: Record<Hand, Partial<Record<HelpButton, string>>> = {
    left: { thumbstick: 'Stick gauche', trigger: 'Gâchette gauche', squeeze: 'Grip gauche', x: 'X', y: 'Y', menu: 'Menu ☰' },
    right: { thumbstick: 'Stick droit', trigger: 'Gâchette droite', squeeze: 'Grip droit', a: 'A', b: 'B', system: 'Bouton Meta' },
};
const BUTTON_COLORS: Record<HelpButton, string> = {
    thumbstick: '#6fb3ff', trigger: '#c49bff', squeeze: '#7fd68f',
    a: '#ffb27a', b: '#ffb27a', x: '#ffb27a', y: '#ffb27a', menu: '#ffe07a', system: '#999',
};

const NORMAL_CONTEXT: ControlContext = { editActive: false, panel: 'config', rebuildAction: 'build', hasMap: true };
const EDIT_CONTEXT: ControlContext = { editActive: true, panel: 'config', rebuildAction: 'build', hasMap: true };
const EDIT_FLOORS_CONTEXT: ControlContext = { editActive: true, panel: 'floors', rebuildAction: 'build', hasMap: true };

// Drawing of the left controller, front three-quarter view, in its own units (the right one is its mirror)
const CTRL_W = 150;
const CTRL_SCALE = 1.1;
// Buttons' centres on the drawing. The right controller has A / B / Meta where the left one has X / Y / Menu
const LEFT_ANCHORS: Partial<Record<HelpButton, [number, number]>> = {
    thumbstick: [50, 86], y: [82, 106], menu: [28, 113], x: [60, 118], trigger: [108, 146], squeeze: [58, 170],
};
const MIRRORED: Partial<Record<HelpButton, HelpButton>> = { x: 'a', y: 'b', menu: 'system' };

// Layout
const CTRL_TOP = 66;
const LEFT_CTRL_X = 300; // left edge of the left controller's drawing
const CTRL_GAP = 40; // between the two drawings
const LABEL_COL_W = 260;
const LABEL_MARGIN = 20; // canvas edge to the label columns
const LABELS_TOP = 70, LABELS_BOTTOM = 382;

/** Draw the controller body (ring, handle, face, trigger, grip, stick, buttons), mirrored for the right hand */
function drawControllerBody(ctx: CanvasRenderingContext2D, left: number, top: number, hand: Hand): void {
    ctx.save();
    ctx.translate(left, top);
    if (hand === 'right') {
        ctx.translate(CTRL_W * CTRL_SCALE, 0);
        ctx.scale(-CTRL_SCALE, CTRL_SCALE);
    } else {
        ctx.scale(CTRL_SCALE, CTRL_SCALE);
    }
    const outline = '#9aa4b2', body = '#353b45', dark = '#23272e';
    ctx.lineJoin = 'round';

    // tracking ring, behind the face
    ctx.beginPath();
    ctx.ellipse(94, 62, 52, 46, -0.35, 0, Math.PI * 2);
    ctx.lineWidth = 13;
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.lineWidth = 9;
    ctx.strokeStyle = body;
    ctx.stroke();

    // trigger, peeking out in front under the face
    ctx.beginPath();
    ctx.ellipse(104, 144, 12, 21, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = outline;
    ctx.stroke();

    // handle
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(78, 120);
    ctx.lineTo(42, 262);
    ctx.lineWidth = 54;
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.lineWidth = 50;
    ctx.strokeStyle = body;
    ctx.stroke();

    // face plate
    ctx.beginPath();
    ctx.ellipse(62, 100, 50, 31, -0.25, 0, Math.PI * 2);
    ctx.fillStyle = '#3e4550';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = outline;
    ctx.stroke();

    // grip button, on the side of the handle
    ctx.beginPath();
    ctx.arc(58, 170, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#3e4550';
    ctx.fill();
    ctx.stroke();

    // thumbstick
    ctx.beginPath();
    ctx.arc(50, 86, 15, 0, Math.PI * 2);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(50, 86, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#5a626e';
    ctx.fill();

    // face buttons and the small oval one (Menu on the left, Meta on the right)
    for (const [x, y] of [[60, 118], [82, 106]]) {
        ctx.beginPath();
        ctx.arc(x, y, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = dark;
        ctx.fill();
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(28, 113, 7, 4, -0.25, 0, Math.PI * 2);
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/** Buttons' centres on the canvas */
function controllerAnchors(left: number, top: number, hand: Hand): Partial<Record<HelpButton, [number, number]>> {
    const anchors: Partial<Record<HelpButton, [number, number]>> = {};
    for (const [button, [x, y]] of Object.entries(LEFT_ANCHORS) as [HelpButton, [number, number]][]) {
        const name = hand === 'right' ? MIRRORED[button] ?? button : button;
        const canvasX = hand === 'right' ? left + (CTRL_W - x) * CTRL_SCALE : left + x * CTRL_SCALE;
        anchors[name] = [canvasX, top + y * CTRL_SCALE];
    }
    return anchors;
}

const LETTER_BUTTONS: HelpButton[] = ['x', 'y', 'a', 'b'];

/** The face buttons with their letter, over the label lines (which end under them) */
function drawButtonLetters(ctx: CanvasRenderingContext2D, anchors: Partial<Record<HelpButton, [number, number]>>): void {
    ctx.textAlign = 'center';
    for (const button of LETTER_BUTTONS) {
        const anchor = anchors[button];
        if (!anchor) continue;
        ctx.beginPath();
        ctx.arc(anchor[0], anchor[1], 8.5 * CTRL_SCALE, 0, Math.PI * 2);
        ctx.fillStyle = '#23272e';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = BUTTON_COLORS[button];
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(button.toUpperCase(), anchor[0], anchor[1] + 4);
    }
}

/**
 * Labels of one controller's buttons, in a column beside it, top to bottom in the order of the buttons' heights,
 * each joined to its button by a line
 */
function drawLabels(
    ctx: CanvasRenderingContext2D, hand: Hand, anchors: Partial<Record<HelpButton, [number, number]>>,
    texts: Partial<Record<HelpButton, string>>,
): void {
    const colX = hand === 'left' ? LABEL_MARGIN : HELP_W - LABEL_MARGIN - LABEL_COL_W;
    const align: CanvasTextAlign = hand === 'left' ? 'right' : 'left';
    const textX = hand === 'left' ? colX + LABEL_COL_W : colX;

    const labels = (Object.keys(texts) as HelpButton[])
        .filter(button => anchors[button] && texts[button])
        .sort((a, b) => anchors[a]![1] - anchors[b]![1])
        .map(button => {
            ctx.font = '13px sans-serif';
            const lines = wrapText(ctx, texts[button]!, LABEL_COL_W);
            return { button, lines, height: 18 + lines.length * 16 };
        });
    const total = labels.reduce((sum, l) => sum + l.height, 0);
    const gap = labels.length > 1 ? Math.max(6, (LABELS_BOTTOM - LABELS_TOP - total) / (labels.length - 1)) : 0;

    let y = LABELS_TOP;
    for (const { button, lines, height } of labels) {
        const [ax, ay] = anchors[button]!;
        const titleY = y + 13;

        // line from the button to the label
        const lineEndX = hand === 'left' ? colX + LABEL_COL_W + 8 : colX - 8;
        ctx.strokeStyle = 'rgba(159,216,255,0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(lineEndX, titleY - 4);
        ctx.stroke();
        if (!LETTER_BUTTONS.includes(button)) {
            ctx.beginPath();
            ctx.arc(ax, ay, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#ffee44';
            ctx.fill();
        }

        ctx.textAlign = align;
        ctx.fillStyle = BUTTON_COLORS[button];
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(BUTTON_NAMES[hand][button] ?? button, textX, titleY);
        ctx.fillStyle = '#e8e8e8';
        ctx.font = '13px sans-serif';
        lines.forEach((line, i) => ctx.fillText(line, textX, titleY + 18 + i * 16));
        y += height + gap;
    }
}

/** Under the controllers: what the right hand does in the edit mode */
function drawEditModeSection(ctx: CanvasRenderingContext2D, top: number): void {
    const edit = getControlHints('right', EDIT_CONTEXT);
    const floors = getControlHints('right', EDIT_FLOORS_CONTEXT);
    const rows: [string, string][] = [
        ['Stick droit', `Config : ${edit.thumbstick} — Étages : ${floors.thumbstick}`],
        ['Gâchette droite', `${edit.trigger}`],
        ['B', `Config : ${edit.b} — Étages : ${floors.b}`],
    ];

    ctx.strokeStyle = '#333a44';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LABEL_MARGIN, top);
    ctx.lineTo(HELP_W - LABEL_MARGIN, top);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffee44';
    ctx.font = 'bold 15px sans-serif';
    ctx.fillText('En mode édition (A) · la main droite pilote les panneaux', LABEL_MARGIN, top + 24);

    let y = top + 46;
    for (const [name, text] of rows) {
        ctx.fillStyle = '#9fd8ff';
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(name, LABEL_MARGIN, y);
        ctx.fillStyle = '#e8e8e8';
        ctx.font = '13px sans-serif';
        const lines = wrapText(ctx, text, HELP_W - 2 * LABEL_MARGIN - 130);
        lines.forEach((line, i) => ctx.fillText(line, LABEL_MARGIN + 130, y + i * 16));
        y += Math.max(1, lines.length) * 16 + 6;
    }
}

/** Draw the whole controls help on a HELP_W × HELP_H canvas (title row left free on the right for a button) */
export function drawControlsHelp(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = 'rgba(10,12,18,0.95)';
    roundRect(ctx, 0, 0, HELP_W, HELP_H, 14);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('Contrôles', LABEL_MARGIN, 36);
    ctx.fillStyle = '#888';
    ctx.font = '13px sans-serif';
    ctx.fillText('Main gauche : minimap et déplacement · main droite : vue, étages, réglages', LABEL_MARGIN + 120, 35);

    const rightCtrlX = LEFT_CTRL_X + CTRL_W * CTRL_SCALE + CTRL_GAP;
    const sides: [Hand, number][] = [['left', LEFT_CTRL_X], ['right', rightCtrlX]];
    for (const [hand, left] of sides) {
        drawControllerBody(ctx, left, CTRL_TOP, hand);
        const anchors = controllerAnchors(left, CTRL_TOP, hand);
        const texts: Partial<Record<HelpButton, string>> = { ...getControlHints(hand, NORMAL_CONTEXT) };
        if (hand === 'right') texts.system = 'Menu du casque (hors application)';
        drawLabels(ctx, hand, anchors, texts);
        drawButtonLetters(ctx, anchors);
    }

    drawEditModeSection(ctx, 400);
}
