import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

// glTF format is supposed to be 1 unit = 1 meter but not every exporter respects that
// We fall back to a heuristic to snap the scale to the nearest power of 10
const PLAUSIBLE_HEIGHT_MIN = 2;   // a single low room
const PLAUSIBLE_HEIGHT_MAX = 30;  // a tall multi-floors building
const PLAUSIBLE_HEIGHT_MID = Math.sqrt(PLAUSIBLE_HEIGHT_MIN * PLAUSIBLE_HEIGHT_MAX);
const MAX_SCALE_POWER = 6; // clamp so a degenerate/flat bounding box can't produce an absurd scale

// Guess a uniform scale factor that brings the model's raw bounding box into a plausible real world size
function computeAutoScale(model: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const rawHeight = size.y || Math.max(size.x, size.z) || 1;

    if (rawHeight >= PLAUSIBLE_HEIGHT_MIN && rawHeight <= PLAUSIBLE_HEIGHT_MAX) return 1;

    const rawScale = PLAUSIBLE_HEIGHT_MID / rawHeight;
    const power = Math.max(-MAX_SCALE_POWER, Math.min(MAX_SCALE_POWER, Math.round(Math.log10(rawScale))));
    return Math.pow(10, power);
}

/**
 * SHA-1 of the file content, hex encoded. null when unavailable (crypto.subtle needs a secure context: https or localhost)
 */
async function sha1Hex(buffer: ArrayBuffer): Promise<string | null> {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-1', buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Download a file, reporting progress when the server sends its size
 * @param onProgress Called with the received and total byte counts (total = 0 when unknown)
 */
async function fetchWithProgress(path: string, onProgress: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    if (!res.body) return res.arrayBuffer();

    // Written in place when the size is known: big models (hundreds of MB) aren't held twice in memory
    let bytes = new Uint8Array(total);
    let loaded = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.length > bytes.length) {
            // unknown or wrong Content-Length (e.g. compressed response): grow
            const grown = new Uint8Array(Math.max(bytes.length * 2, loaded + value.length));
            grown.set(bytes.subarray(0, loaded));
            bytes = grown;
        }
        bytes.set(value, loaded);
        loaded += value.length;
        onProgress(loaded, total);
    }

    return loaded === bytes.length ? bytes.buffer : bytes.buffer.slice(0, loaded);
}

/**
 * Load a GLB model, along with the SHA-1 of its file (used to check a saved map belongs to this model)
 * @param path Model URL
 * @param onDownloadProgress Called while the file downloads, with the received and total byte counts (total = 0 when unknown)
 */
export async function loadGLB(
    path: string,
    onDownloadProgress: (loaded: number, total: number) => void = () => { },
): Promise<{ model: THREE.Group; sha1: string | null }> {
    try {
        // Fetched once: the same bytes are hashed then parsed
        const buffer = await fetchWithProgress(path, onDownloadProgress);

        // Hash before parsing, in case the parser takes ownership of the buffer
        const sha1 = await sha1Hex(buffer);
        const gltf = await loader.parseAsync(buffer, THREE.LoaderUtils.extractUrlBase(path));

        const model = gltf.scene;
        model.position.set(0, 0, 0);

        const scale = computeAutoScale(model);
        model.scale.setScalar(scale);
        console.log(`Model loaded successfully (auto-scale = ${scale}, sha1 = ${sha1 ?? 'unavailable'})`);

        return { model, sha1 };
    } catch (error) {
        console.error('Error loading model (check file path):', error);
        throw error;
    }
}
