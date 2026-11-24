import * as THREE from 'three';
import type { HistogramBin } from './minimapBuilder.js';
import { HUD_RENDER_ORDER, type FloorLevel } from './minimap.js';

const BG = 'rgba(10,10,10,0.88)';
const BAR_COLOR = 'rgba(120,160,220,0.85)';
const PEAK_COLOR = 'rgba(90,220,140,0.95)';
const PEAK_LABEL_COLOR = '#8dffb0';
const TEXT_COLOR = '#ccc';

export const HISTOGRAM_CANVAS_WIDTH = 200;
export const HISTOGRAM_CANVAS_HEIGHT = 340;

/**
 * Draw the Y-density histogram used for floor detection with one horizontal bar per slice
 * @param histogram bins computed by the last buildSceneMap call (empty until the first build/rebuild)
 * @param levels current floors used to highlight the bins they were detected from
 */
export function renderHistogram(
    histogram: HistogramBin[],
    levels: FloorLevel[],
    canvas: HTMLCanvasElement,
    width = HISTOGRAM_CANVAS_WIDTH,
    height = HISTOGRAM_CANVAS_HEIGHT,
    pixelRatio = 1,
): void {
    const ctx = canvas.getContext('2d')!;
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#ffee44';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Histogramme Y', width / 2, 18);

    if (histogram.length === 0) {
        ctx.fillStyle = '#888';
        ctx.font = '11px monospace';
        ctx.fillText('Rebuild pour voir', width / 2, height / 2);
        return;
    }

    const maxCount = Math.max(...histogram.map(b => b.count), 1);
    const marginTop = 28, marginBottom = 10, marginLeft = 46, marginRight = 8;
    const plotW = width - marginLeft - marginRight;
    const plotH = height - marginTop - marginBottom;
    const rowH = plotH / histogram.length;
    const sliceSize = histogram.length > 1 ? Math.abs(histogram[1].y - histogram[0].y) : 1;

    histogram.forEach((bin, i) => {
        // bin 0 = lowest Y -> stack from the bottom up
        const y = marginTop + plotH - (i + 1) * rowH;
        const barW = Math.max(1, (bin.count / maxCount) * plotW);
        const isFloor = levels.some(l => Math.abs(l.floorY - bin.y) < sliceSize);

        ctx.fillStyle = isFloor ? PEAK_COLOR : BAR_COLOR;
        ctx.fillRect(marginLeft, y + 1, barW, Math.max(1, rowH - 2));

        if (isFloor) {
            ctx.fillStyle = PEAK_LABEL_COLOR;
            ctx.font = 'bold 9px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`${bin.y.toFixed(2)}m`, marginLeft + barW + 4, y + rowH * 0.75);
        }
    });

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${histogram[histogram.length - 1].y.toFixed(1)}m`, marginLeft - 4, marginTop + 8);
    ctx.fillText(`${histogram[0].y.toFixed(1)}m`, marginLeft - 4, marginTop + plotH);
}

// VR canvas texture on a plane, left of the edit mode panel

/** Canvas pixels per drawing unit in VR: the text stays sharp on the big panel */
export const VR_HISTOGRAM_PIXEL_RATIO = 2;

export interface HistogramHud {
    mesh: THREE.Mesh;
    texture: THREE.CanvasTexture;
    canvas: HTMLCanvasElement;
    dispose: () => void;
}

/**
 * @param parent the plane is added at its origin, the caller places it
 * @param height plane height in metres (the width follows the canvas)
 */
export function createHistogramHud(parent: THREE.Object3D, height: number): HistogramHud {
    const canvas = document.createElement('canvas');
    canvas.width = HISTOGRAM_CANVAS_WIDTH * VR_HISTOGRAM_PIXEL_RATIO;
    canvas.height = HISTOGRAM_CANVAS_HEIGHT * VR_HISTOGRAM_PIXEL_RATIO;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(height * HISTOGRAM_CANVAS_WIDTH / HISTOGRAM_CANVAS_HEIGHT, height),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false })
    );
    mesh.renderOrder = HUD_RENDER_ORDER;
    parent.add(mesh);

    return {
        mesh,
        texture,
        canvas,
        dispose: () => {
            parent.remove(mesh);
            mesh.geometry.dispose();
            (mesh.material as THREE.Material).dispose();
            texture.dispose();
        },
    };
}

// Desktop panel with fixed HTML overlay on the left of the screen

export interface DesktopHistogramPanel {
    canvas: HTMLCanvasElement;
    setVisible: (visible: boolean) => void;
    dispose: () => void;
}

export function createDesktopHistogramPanel(): DesktopHistogramPanel {
    const container = document.createElement('div');
    Object.assign(container.style, {
        position: 'fixed', top: '8px', left: '8px',
        display: 'none', zIndex: '1000',
    });

    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, { display: 'block', borderRadius: '6px', border: '1px solid #444' });
    container.appendChild(canvas);
    document.body.appendChild(container);

    return {
        canvas,
        setVisible: (visible: boolean) => { container.style.display = visible ? 'block' : 'none'; },
        dispose: () => container.remove(),
    };
}
