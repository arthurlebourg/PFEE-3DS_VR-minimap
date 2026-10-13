import * as THREE from 'three';
import type { SceneMap, FloorLevel } from './minimap.js';

export interface Minimap3DConfig {
    /** Target maximum dimension of the building in meters (12 to 15 cm) */
    targetSize: number;
    /** Slab thickness in world meters */
    slabHeight: number;
    /** Fractional gap between adjacent floor cells for holographic grid aesthetics */
    slabGapRatio: number;
    /** Wall quad height in world meters */
    wallHeight: number;
    /** Position offset relative to the left grip controller */
    wristOffset: THREE.Vector3;
    /** Incline rotation tilting the maquette towards the player's eyes */
    wristRotation: THREE.Euler;
    /** Incline angle (legacy fallback) */
    wristTiltAngle: number;
    /** Color of the active floor slabs */
    activeColor: number;
    /** Opacity of the active floor slabs */
    activeOpacity: number;
    /** Wall color for active floor */
    wallColor: number;
    /** Wall opacity for active floor */
    wallOpacity: number;
    /** Color of the pedestal base plate */
    pedestalColor: number;
    /** Color of the glowing rim on the pedestal */
    pedestalBorderColor: number;
    /** Color of the player 3D marker */
    playerMarkerColor: number;
}

export const DEFAULT_MINIMAP_3D_CONFIG: Minimap3DConfig = {
    targetSize: 0.14,
    slabHeight: 0.05,
    slabGapRatio: 0.04,
    wallHeight: 2.2,
    wristOffset: new THREE.Vector3(-0.22, -0.18, -0.55),
    wristRotation: new THREE.Euler(THREE.MathUtils.degToRad(55), THREE.MathUtils.degToRad(20), 0),
    wristTiltAngle: THREE.MathUtils.degToRad(55),
    activeColor: 0x00f0ff,
    activeOpacity: 0.85,
    wallColor: 0xd0f0ff,
    wallOpacity: 0.55,
    pedestalColor: 0x07111c,
    pedestalBorderColor: 0x00f0ff,
    playerMarkerColor: 0xff3344,
};

export type UpperFloorsMode = 'dim' | 'hide';

export interface Floor3D {
    id: number;
    floorY: number;
    ceilingY: number;
    group: THREE.Group;
    slabsMesh: THREE.Mesh;
    wallsMesh: THREE.Mesh;
    wallEdgesMesh?: THREE.LineSegments;
}

export interface VRMinimap3D {
    root: THREE.Group;
    buildingContainer: THREE.Group;
    pedestalGroup: THREE.Group;
    playerMarker: THREE.Group;
    floors: Floor3D[];
    config: Minimap3DConfig;
    scaleFactor: number;
    update: (playerPos: THREE.Vector3, cameraDir: THREE.Vector3) => void;
    setFloorHighlight: (floorIndex: number, isPreview?: boolean) => void;
    setUpperFloorsMode: (mode: UpperFloorsMode) => void;
    getUpperFloorsMode: () => UpperFloorsMode;
    setWristOffset: (x: number, y: number, z: number) => void;
    setWristTilt: (pitchDegrees: number, yawDegrees?: number) => void;
    setTargetSize: (sizeMeters: number) => void;
    rebuild: (sceneMap: SceneMap) => void;
    attachTo: (newParent: THREE.Object3D) => void;
    setVisible: (visible: boolean) => void;
    dispose: () => void;
}

function pushQuad(
    pos: number[], norm: number[], idx: number[],
    p0: number[], p1: number[], p2: number[], p3: number[],
    n: [number, number, number]
) {
    const base = pos.length / 3;
    pos.push(...p0, ...p1, ...p2, ...p3);
    norm.push(...n, ...n, ...n, ...n);
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

export function buildFloorSlabsGeometry(
    level: FloorLevel,
    sceneBounds: { sceneMinX: number; sceneMinZ: number },
    gridSize: number,
    slabHeight = 0.05,
    slabGapRatio = 0.04
): THREE.BufferGeometry {
    const { sceneMinX, sceneMinZ } = sceneBounds;
    const half = (gridSize * (1 - slabGapRatio)) * 0.5;
    const layers = [{ walkable: level.walkable, y: level.floorY }, ...(level.subLevels?.map(s => ({ walkable: s.walkable, y: s.absoluteY })) ?? [])];
    const pos: number[] = [], norm: number[] = [], idx: number[] = [];

    for (const { walkable, y } of layers) {
        const yTop = y + slabHeight;
        for (let r = 0; r < walkable.length; r++) {
            for (let c = 0; c < (walkable[0]?.length ?? 0); c++) {
                if (!walkable[r]?.[c]) continue;
                const cx = sceneMinX + (c + 0.5) * gridSize;
                const cz = sceneMinZ + (r + 0.5) * gridSize;
                const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;

                pushQuad(pos, norm, idx, [x0, yTop, z0], [x1, yTop, z0], [x1, yTop, z1], [x0, yTop, z1], [0, 1, 0]);
                pushQuad(pos, norm, idx, [x0, y, z0], [x1, y, z0], [x1, yTop, z0], [x0, yTop, z0], [0, 0, -1]);
                pushQuad(pos, norm, idx, [x1, y, z0], [x1, y, z1], [x1, yTop, z1], [x1, yTop, z0], [1, 0, 0]);
                pushQuad(pos, norm, idx, [x1, y, z1], [x0, y, z1], [x0, yTop, z1], [x1, yTop, z1], [0, 0, 1]);
                pushQuad(pos, norm, idx, [x0, y, z1], [x0, y, z0], [x0, yTop, z0], [x0, yTop, z1], [-1, 0, 0]);
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    if (pos.length > 0) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        geo.setIndex(idx);
    }
    return geo;
}

const WALL_DIRS = [
    { bit: 1, dx0: -0.5, dz0: -0.5, dx1: 0.5, dz1: -0.5, n: [0, 0, -1] as [number, number, number] }, // N
    { bit: 2, dx0: 0.5, dz0: -0.5, dx1: 0.5, dz1: 0.5, n: [1, 0, 0] as [number, number, number] },   // E
    { bit: 4, dx0: 0.5, dz0: 0.5, dx1: -0.5, dz1: 0.5, n: [0, 0, 1] as [number, number, number] },   // S
    { bit: 8, dx0: -0.5, dz0: 0.5, dx1: -0.5, dz1: -0.5, n: [-1, 0, 0] as [number, number, number] }, // W
];

export function buildFloorWallsGeometry(
    level: FloorLevel,
    sceneBounds: { sceneMinX: number; sceneMinZ: number },
    gridSize: number,
    slabHeight = 0.05,
    wallHeight = 2.2
): THREE.BufferGeometry {
    if (!level.walls?.length) return new THREE.BufferGeometry();
    const { sceneMinX, sceneMinZ } = sceneBounds;
    const yBot = level.floorY + slabHeight, yTop = level.floorY + wallHeight;
    const pos: number[] = [], norm: number[] = [], idx: number[] = [];

    for (let r = 0; r < level.walls.length; r++) {
        for (let c = 0; c < (level.walls[0]?.length ?? 0); c++) {
            const mask = level.walls[r]?.[c] ?? 0;
            if (!mask || !level.walkable[r]?.[c]) continue;
            const cx = sceneMinX + (c + 0.5) * gridSize;
            const cz = sceneMinZ + (r + 0.5) * gridSize;

            for (const { bit, dx0, dz0, dx1, dz1, n } of WALL_DIRS) {
                if (mask & bit) {
                    const x0 = cx + dx0 * gridSize, z0 = cz + dz0 * gridSize;
                    const x1 = cx + dx1 * gridSize, z1 = cz + dz1 * gridSize;
                    pushQuad(pos, norm, idx, [x0, yBot, z0], [x1, yBot, z1], [x1, yTop, z1], [x0, yTop, z0], n);
                }
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    if (pos.length > 0) {
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
        geo.setIndex(idx);
    }
    return geo;
}

export function buildFloorWallEdgesGeometry(
    level: FloorLevel,
    sceneBounds: { sceneMinX: number; sceneMinZ: number },
    gridSize: number,
    wallHeight = 2.2
): THREE.BufferGeometry {
    if (!level.walls?.length) return new THREE.BufferGeometry();
    const { sceneMinX, sceneMinZ } = sceneBounds;
    const yTop = level.floorY + wallHeight;
    const pos: number[] = [];

    for (let r = 0; r < level.walls.length; r++) {
        for (let c = 0; c < (level.walls[0]?.length ?? 0); c++) {
            const mask = level.walls[r]?.[c] ?? 0;
            if (!mask || !level.walkable[r]?.[c]) continue;
            const cx = sceneMinX + (c + 0.5) * gridSize;
            const cz = sceneMinZ + (r + 0.5) * gridSize;

            for (const { bit, dx0, dz0, dx1, dz1 } of WALL_DIRS) {
                if (mask & bit) {
                    pos.push(cx + dx0 * gridSize, yTop, cz + dz0 * gridSize, cx + dx1 * gridSize, yTop, cz + dz1 * gridSize);
                }
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    if (pos.length > 0) geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return geo;
}

function createPedestal(radius: number, config: Minimap3DConfig) {
    const group = new THREE.Group();
    const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

    const geo = new THREE.CylinderGeometry(radius, radius * 1.03, 0.005, 48);
    const mat = new THREE.MeshBasicMaterial({ color: config.pedestalColor, depthWrite: true, depthTest: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -0.0025;
    mesh.renderOrder = 1;
    group.add(mesh);
    disposables.push(geo, mat);

    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 48; i++) {
        const theta = (i / 48) * Math.PI * 2;
        ringPts.push(new THREE.Vector3(Math.cos(theta) * radius, 0.0006, Math.sin(theta) * radius));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    const ringMat = new THREE.LineBasicMaterial({ color: config.pedestalBorderColor });
    const ring = new THREE.LineLoop(ringGeo, ringMat);
    ring.renderOrder = 2;
    group.add(ring);
    disposables.push(ringGeo, ringMat);

    const naZ = -radius * 0.92, naSize = 0.007;
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0.001, naZ - naSize * 1.2,
        naSize * 0.6, 0.001, naZ + naSize * 0.4,
        -naSize * 0.6, 0.001, naZ + naSize * 0.4
    ], 3));
    arrowGeo.setIndex([0, 1, 2]);
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
    const arrowMesh = new THREE.Mesh(arrowGeo, arrowMat);
    arrowMesh.renderOrder = 2;
    group.add(arrowMesh);
    disposables.push(arrowGeo, arrowMat);

    return { group, disposables };
}

function create3DPlayerMarker(config: Minimap3DConfig) {
    const group = new THREE.Group();
    const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

    const coneGeo = new THREE.ConeGeometry(0.003, 0.008, 12).rotateX(-Math.PI / 2).translate(0, 0.003, -0.003);
    const coneMat = new THREE.MeshBasicMaterial({ color: config.playerMarkerColor, depthTest: true });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.renderOrder = 10;
    group.add(cone);
    disposables.push(coneGeo, coneMat);

    const sphereGeo = new THREE.SphereGeometry(0.0018, 10, 10);
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.y = 0.003;
    sphere.renderOrder = 11;
    group.add(sphere);
    disposables.push(sphereGeo, sphereMat);

    const ringGeo = new THREE.RingGeometry(0.0028, 0.0055, 18).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: config.playerMarkerColor, transparent: true, opacity: 0.85, depthTest: true, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 0.0006;
    ring.renderOrder = 9;
    group.add(ring);
    disposables.push(ringGeo, ringMat);

    const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.001, 0), new THREE.Vector3(0, 0.016, 0)]);
    const beamMat = new THREE.LineBasicMaterial({ color: config.playerMarkerColor, transparent: true, opacity: 0.85, depthTest: true });
    const beam = new THREE.Line(beamGeo, beamMat);
    beam.renderOrder = 12;
    group.add(beam);
    disposables.push(beamGeo, beamMat);

    return { group, disposables };
}

export function createVRMinimap3D(
    parent: THREE.Object3D,
    map: SceneMap,
    userConfig?: Partial<Minimap3DConfig>
): VRMinimap3D {
    const config: Minimap3DConfig = { ...DEFAULT_MINIMAP_3D_CONFIG, ...userConfig };
    const root = new THREE.Group();
    root.name = 'vr-minimap-3d-root';
    root.position.copy(config.wristOffset);
    root.rotation.copy(config.wristRotation);
    parent.add(root);

    const buildingContainer = new THREE.Group();
    const pedestalGroup = new THREE.Group();
    let playerMarker: THREE.Group = new THREE.Group();
    root.add(pedestalGroup, buildingContainer);

    const slabMat = new THREE.MeshBasicMaterial({ color: config.activeColor, transparent: true, opacity: config.activeOpacity, side: THREE.DoubleSide });
    const previewSlabMat = new THREE.MeshBasicMaterial({ color: 0xffb800, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    const wallMat = new THREE.MeshBasicMaterial({ color: config.wallColor, transparent: true, opacity: config.wallOpacity, side: THREE.DoubleSide });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x99ffff, transparent: true, opacity: 0.95 });
    const previewEdgeMat = new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95 });
    const sharedMaterials = [slabMat, previewSlabMat, wallMat, edgeMat, previewEdgeMat];

    let dynamicDisposables: (THREE.BufferGeometry | THREE.Material)[] = [];
    let floors: Floor3D[] = [];
    let scaleFactor = 1, currentHighlightIdx = 0, currentIsPreview = false;
    let centerX = 0, centerZ = 0, minY = 0, pedestalRadius = 0.08;
    let currentMap: SceneMap = map;

    function buildModel(sceneMap: SceneMap) {
        currentMap = sceneMap;
        for (const item of dynamicDisposables) item.dispose();
        dynamicDisposables = [];
        floors = [];
        buildingContainer.clear();
        pedestalGroup.clear();
        if (playerMarker.parent) playerMarker.parent.remove(playerMarker);

        const { minX, maxX, minZ, maxZ } = sceneMap.bounds;
        const sizeX = maxX - minX, sizeZ = maxZ - minZ;
        const maxDim = Math.max(sizeX, sizeZ, 1);
        scaleFactor = config.targetSize / maxDim;

        centerX = (minX + maxX) * 0.5;
        centerZ = (minZ + maxZ) * 0.5;
        minY = sceneMap.levels.length > 0 ? Math.min(...sceneMap.levels.map(l => l.floorY)) : 0;

        buildingContainer.scale.setScalar(scaleFactor);
        buildingContainer.position.set(-centerX * scaleFactor, -minY * scaleFactor + 0.002, -centerZ * scaleFactor);

        pedestalRadius = Math.max(sizeX, sizeZ) * scaleFactor * 0.55 + 0.015;
        const { group: pedGroup, disposables: pedDisposables } = createPedestal(pedestalRadius, config);
        pedestalGroup.add(pedGroup);
        dynamicDisposables.push(...pedDisposables);

        sceneMap.levels.forEach((level) => {
            const floorGroup = new THREE.Group();
            const slabGeo = buildFloorSlabsGeometry(level, sceneMap.sceneBounds, sceneMap.gridSize, config.slabHeight, config.slabGapRatio);
            const slabMesh = new THREE.Mesh(slabGeo, slabMat);
            slabMesh.renderOrder = 5;
            floorGroup.add(slabMesh);
            dynamicDisposables.push(slabGeo);

            const wallGeo = buildFloorWallsGeometry(level, sceneMap.sceneBounds, sceneMap.gridSize, config.slabHeight, config.wallHeight);
            const wallMesh = new THREE.Mesh(wallGeo, wallMat);
            wallMesh.renderOrder = 6;
            floorGroup.add(wallMesh);
            dynamicDisposables.push(wallGeo);

            const edgesGeo = buildFloorWallEdgesGeometry(level, sceneMap.sceneBounds, sceneMap.gridSize, config.wallHeight);
            let wallEdgesMesh: THREE.LineSegments | undefined;
            if (edgesGeo.attributes.position && edgesGeo.attributes.position.count > 0) {
                wallEdgesMesh = new THREE.LineSegments(edgesGeo, edgeMat);
                wallEdgesMesh.renderOrder = 7;
                floorGroup.add(wallEdgesMesh);
                dynamicDisposables.push(edgesGeo);
            }

            buildingContainer.add(floorGroup);
            floors.push({ id: level.id, floorY: level.floorY, ceilingY: level.ceilingY, group: floorGroup, slabsMesh: slabMesh, wallsMesh: wallMesh, wallEdgesMesh });
        });

        const { group: markerGroup, disposables: markerDisposables } = create3DPlayerMarker(config);
        playerMarker = markerGroup;
        root.add(playerMarker);
        dynamicDisposables.push(...markerDisposables);

        applyFloorStyling();
    }

    function applyFloorStyling() {
        floors.forEach((f, idx) => {
            const isActive = idx === currentHighlightIdx;
            if (isActive) {
                f.group.visible = true;
                f.slabsMesh.material = currentIsPreview ? previewSlabMat : slabMat;
                if (f.wallEdgesMesh) f.wallEdgesMesh.material = currentIsPreview ? previewEdgeMat : edgeMat;
                f.group.position.y = -(f.floorY - minY) + (currentIsPreview ? 0.008 / scaleFactor : 0);
            } else {
                f.group.visible = false;
                f.group.position.y = 0;
            }
        });
    }

    buildModel(map);

    const flatDir = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    const instance: VRMinimap3D = {
        root,
        buildingContainer,
        pedestalGroup,
        playerMarker,
        floors,
        config,
        scaleFactor,

        update: (playerPos: THREE.Vector3, cameraDir: THREE.Vector3) => {
            if (!playerMarker) return;
            const localX = (playerPos.x - centerX) * scaleFactor;
            const localZ = (playerPos.z - centerZ) * scaleFactor;
            const localY = (currentIsPreview ? 0.008 : 0) + 0.003;

            const dist = Math.hypot(localX, localZ);
            const maxR = pedestalRadius * 0.93;
            if (dist > maxR && dist > 0.001) {
                const ratio = maxR / dist;
                playerMarker.position.set(localX * ratio, localY, localZ * ratio);
            } else {
                playerMarker.position.set(localX, localY, localZ);
            }

            flatDir.set(cameraDir.x, 0, cameraDir.z).normalize();
            if (flatDir.lengthSq() > 0.001) {
                lookTarget.copy(playerMarker.position).add(flatDir);
                playerMarker.lookAt(lookTarget);
            }
        },

        setFloorHighlight: (floorIndex: number, isPreview = false) => {
            if (currentHighlightIdx === floorIndex && currentIsPreview === isPreview) return;
            currentHighlightIdx = Math.max(0, Math.min(floors.length - 1, floorIndex));
            currentIsPreview = isPreview;
            applyFloorStyling();
        },

        setUpperFloorsMode: () => {},
        getUpperFloorsMode: () => 'hide',

        setWristOffset: (x: number, y: number, z: number) => {
            config.wristOffset.set(x, y, z);
            root.position.copy(config.wristOffset);
        },

        setWristTilt: (pitchDegrees: number, yawDegrees?: number) => {
            const pitchRad = THREE.MathUtils.degToRad(pitchDegrees);
            const yawRad = yawDegrees !== undefined ? THREE.MathUtils.degToRad(yawDegrees) : config.wristRotation.y;
            config.wristRotation.set(pitchRad, yawRad, 0);
            config.wristTiltAngle = pitchRad;
            root.rotation.copy(config.wristRotation);
        },

        setTargetSize: (sizeMeters: number) => {
            if (Math.abs(config.targetSize - sizeMeters) < 0.001) return;
            config.targetSize = sizeMeters;
            buildModel(currentMap);
            instance.scaleFactor = scaleFactor;
        },

        rebuild: (sceneMap: SceneMap) => {
            buildModel(sceneMap);
            instance.scaleFactor = scaleFactor;
        },

        attachTo: (newParent: THREE.Object3D) => {
            if (root.parent) root.parent.remove(root);
            newParent.add(root);
        },

        setVisible: (visible: boolean) => {
            root.visible = visible;
        },

        dispose: () => {
            for (const item of dynamicDisposables) item.dispose();
            for (const mat of sharedMaterials) mat.dispose();
            if (root.parent) root.parent.remove(root);
        },
    };

    return instance;
}
