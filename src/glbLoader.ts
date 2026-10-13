import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

const PLAUSIBLE_HEIGHT_MIN = 2;
const PLAUSIBLE_HEIGHT_MAX = 30;
const PLAUSIBLE_HEIGHT_MID = Math.sqrt(PLAUSIBLE_HEIGHT_MIN * PLAUSIBLE_HEIGHT_MAX);
const MAX_SCALE_POWER = 6;

function computeAutoScale(model: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const rawHeight = size.y || Math.max(size.x, size.z) || 1;

    if (rawHeight >= PLAUSIBLE_HEIGHT_MIN && rawHeight <= PLAUSIBLE_HEIGHT_MAX) return 1;

    const rawScale = PLAUSIBLE_HEIGHT_MID / rawHeight;
    const power = Math.max(-MAX_SCALE_POWER, Math.min(MAX_SCALE_POWER, Math.round(Math.log10(rawScale))));
    return Math.pow(10, power);
}

function showMissingModelBanner(path: string): void {
    const banner = document.createElement('div');
    banner.id = 'missing-model-banner';
    Object.assign(banner.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(25, 30, 45, 0.92)',
        color: '#ffdd55',
        border: '1px solid #ffaa00',
        padding: '10px 18px',
        borderRadius: '8px',
        fontFamily: 'monospace',
        fontSize: '12px',
        zIndex: '10000',
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        maxWidth: '85vw',
        textAlign: 'center',
        lineHeight: '1.5',
    });
    banner.innerHTML = `
        <strong>⚠️ Fichier 3D introuvable :</strong> <code style="color:#fff">${path}</code><br/>
        Génération automatique d'un <strong>bâtiment multi-étages de démonstration</strong> pour tester la minimap 3D.<br/>
        <span style="color:#aaa; font-size:11px;">(Placez votre fichier .glb dans le dossier <code>/models/</code> pour charger votre propre modèle).</span>
    `;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
        marginLeft: '12px',
        background: 'transparent',
        border: 'none',
        color: '#ffaa00',
        cursor: 'pointer',
        fontSize: '14px',
        fontWeight: 'bold',
    });
    closeBtn.onclick = () => banner.remove();
    banner.appendChild(closeBtn);

    document.body.appendChild(banner);
}

/**
 * Creates a procedural 3-story architectural building with floors, rooms, and walls
 * so the application can run and build the 3D minimap immediately even if no GLB file is present.
 */
function createFallbackBuilding(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'fallback-demo-building';

    const floorMat = new THREE.MeshStandardMaterial({ color: 0x8a9ba8, roughness: 0.7 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.9 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x966848, roughness: 0.6 });

    const wallHeight = 2.7;

    const addWall = (x: number, y: number, z: number, w: number, d: number, mat = wallMat) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, wallHeight, d), mat);
        mesh.position.set(x, y + wallHeight * 0.5, z);
        group.add(mesh);
    };

    // --- Étage 0 (Y = 0m, 14m x 12m) ---
    const f0 = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 12), floorMat);
    f0.position.set(0, -0.1, 0);
    group.add(f0);

    // Murs extérieurs avec porte au Sud
    addWall(-7, 0, 0, 0.2, 12); // Ouest
    addWall(7, 0, 0, 0.2, 12);  // Est
    addWall(0, 0, -6, 14, 0.2); // Nord
    addWall(-4.5, 0, 6, 5, 0.2);// Sud Ouest
    addWall(4.5, 0, 6, 5, 0.2); // Sud Est (porte au milieu)

    // Cloisons intérieures (séparation en 3 pièces)
    addWall(0, 0, -1, 0.2, 10);
    addWall(-3.5, 0, 0, 7, 0.2);

    // --- Étage 1 (Y = 3.0m, 14m x 12m) ---
    const f1 = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 12), woodMat);
    f1.position.set(0, 2.9, 0);
    group.add(f1);

    addWall(-7, 3.0, 0, 0.2, 12);
    addWall(7, 3.0, 0, 0.2, 12);
    addWall(0, 3.0, -6, 14, 0.2);
    addWall(0, 3.0, 6, 14, 0.2);
    // Cloisons étage 1
    addWall(2.5, 3.0, 0, 0.2, 8);
    addWall(-2.5, 3.0, 1, 0.2, 6);

    // --- Étage 2 (Terrasse rooftop Y = 6.0m, 10m x 8m) ---
    const f2 = new THREE.Mesh(new THREE.BoxGeometry(10, 0.2, 8), floorMat);
    f2.position.set(0, 5.9, 0);
    group.add(f2);

    // Garde-corps terrasse (hauteur 1.0m)
    const addRailing = (x: number, y: number, z: number, w: number, d: number) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 1.0, d), wallMat);
        mesh.position.set(x, y + 0.5, z);
        group.add(mesh);
    };
    addRailing(-5, 6.0, 0, 0.2, 8);
    addRailing(5, 6.0, 0, 0.2, 8);
    addRailing(0, 6.0, -4, 10, 0.2);
    addRailing(0, 6.0, 4, 10, 0.2);

    return group;
}

export function loadGLB(path: string = "/models/apartment_2_4f7f_in_japan.glb"): Promise<THREE.Group> {
    return new Promise((resolve) => {
        loader.load(
            path,
            (gltf) => {
                const model = gltf.scene;
                model.position.set(0, 0, 0);

                const scale = computeAutoScale(model);
                model.scale.setScalar(scale);
                console.log(`Model loaded successfully from ${path} (auto-scale = ${scale})`);

                resolve(model);
            },
            () => {},
            (error) => {
                console.warn(`[glbLoader] Modèle non trouvé à "${path}":`, error);
                console.info('[glbLoader] Génération d\'un bâtiment de démonstration procédural pour démarrer immédiatement.');
                showMissingModelBanner(path);
                const fallback = createFallbackBuilding();
                resolve(fallback);
            }
        );
    });
}
