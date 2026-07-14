import * as THREE from 'three';
import type { SceneMap, FloorLevel } from './minimap.js';
import type { FloorAdjustState } from './floorAdjust.js';
import { buildWalkableMesh } from './debugMinimap.js';

const GHOST_COLOR = 0xf0f0f0;
const LIVE_COLOR = 0xffffff;
const GHOST_OPACITY = 0.3;
const LIVE_OPACITY_MIN = 0.15;
const LIVE_OPACITY_MAX = 0.6;
const BLINK_PERIOD_MS = 2000; // slow blink
const Y_LIFT = 0.06;
const AXIS_COLOR_Y = 0x55ddff;
const AXIS_COLOR_XZ = 0xffaa33;
const AXIS_LINE_HALF_LENGTH = 500;

export interface FloorMoveVisual {
    dispose: () => void;
    update: (state: FloorAdjustState) => void;
}

function createAxisLine(color: number, direction: THREE.Vector3): THREE.Line {
    const from = direction.clone().multiplyScalar(-AXIS_LINE_HALF_LENGTH);
    const to = direction.clone().multiplyScalar(AXIS_LINE_HALF_LENGTH);
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthTest: false });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 999;
    return line;
}

/**
 * Ghost (static, at floor's committed position) + live (blinking, tracks the
 * uncommitted preview offset) walkable-area overlays, plus showing which axis the floor currently moves along
 * Rebuild this whenever the selected floor changes or a move is committed
 */
export function createFloorMoveVisual(scene: THREE.Scene, map: SceneMap, level: FloorLevel): FloorMoveVisual {
    const group = new THREE.Group();
    group.name = 'floor-move-visual';

    const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];

    const ghostMesh = buildWalkableMesh(map, level.walkable, level.floorY + Y_LIFT, GHOST_COLOR, GHOST_OPACITY);
    group.add(ghostMesh);
    disposables.push(ghostMesh.geometry, ghostMesh.material as THREE.Material);

    const liveMesh = buildWalkableMesh(map, level.walkable, level.floorY + Y_LIFT, LIVE_COLOR, LIVE_OPACITY_MAX);
    group.add(liveMesh);
    disposables.push(liveMesh.geometry, liveMesh.material as THREE.Material);

    const origin = new THREE.Vector3(level.spawnPoint.x, level.floorY + 0.3, level.spawnPoint.z);

    const yLine = createAxisLine(AXIS_COLOR_Y, new THREE.Vector3(0, 1, 0));
    const xLine = createAxisLine(AXIS_COLOR_XZ, new THREE.Vector3(1, 0, 0));
    const zLine = createAxisLine(AXIS_COLOR_XZ, new THREE.Vector3(0, 0, 1));
    for (const line of [yLine, xLine, zLine]) {
        line.position.copy(origin);
        group.add(line);
        disposables.push(line.geometry, line.material as THREE.Material);
    }

    scene.add(group);

    function update(state: FloorAdjustState) {
        const { x, y, z } = state.previewDelta;
        liveMesh.position.set(x, y, z);

        const blink = 0.5 + 0.5 * Math.sin((performance.now() / BLINK_PERIOD_MS) * Math.PI * 2);
        (liveMesh.material as THREE.MeshBasicMaterial).opacity = LIVE_OPACITY_MIN + blink * (LIVE_OPACITY_MAX - LIVE_OPACITY_MIN);

        // axis lines follow the floor as it's dragged
        yLine.position.copy(origin).add(new THREE.Vector3(x, y, z));
        xLine.position.copy(yLine.position);
        zLine.position.copy(yLine.position);

        const vertical = state.axisMode === 'vertical';
        yLine.visible = state.isMoving && vertical;
        xLine.visible = state.isMoving && !vertical;
        zLine.visible = state.isMoving && !vertical;
    }

    return {
        update,
        dispose: () => {
            disposables.forEach(d => d.dispose());
            scene.remove(group);
        },
    };
}
