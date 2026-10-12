import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';

/**
 * Dev server endpoint listing the models (models/*.glb) and saved maps (maps/*.json), so the start
 * screen can offer the maps matching a model without downloading it: models are hashed here (SHA-1,
 * same as the client), maps expose the SHA-1 of the model they were built from
 *
 * GET /api/catalog -> Catalog (see src/startScreen.ts)
 */
export function assetCatalog(root = process.cwd()): Plugin {
    const modelsDir = path.join(root, 'models');
    const mapsDir = path.join(root, 'maps');

    // Hashing a model takes a few seconds for the big ones: results are kept until the file changes
    const modelSha1 = createFileCache(sha1File);
    const mapHeader = createFileCache(readMapHeader);

    async function listModels() {
        const files = (await readdirSafe(modelsDir)).filter(f => f.toLowerCase().endsWith('.glb'));
        return Promise.all(files.map(async file => {
            const full = path.join(modelsDir, file);
            const { size } = await stat(full);
            return { file, size, sha1: await modelSha1(full) };
        }));
    }

    async function listMaps() {
        const files = (await readdirSafe(mapsDir)).filter(f => f.toLowerCase().endsWith('.json'));
        const maps = await Promise.all(files.map(async file => {
            const full = path.join(mapsDir, file);
            const { size, mtimeMs } = await stat(full);
            const header = await mapHeader(full);
            return header && { file, size, mtime: mtimeMs, ...header };
        }));
        return maps.filter(m => m !== null);
    }

    const handler: Connect.NextHandleFunction = (req, res, next) => {
        if (req.url?.split('?')[0] !== '/api/catalog') return next();
        Promise.all([listModels(), listMaps()])
            .then(([models, maps]) => {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'no-store');
                res.end(JSON.stringify({ models, maps }));
            })
            .catch(err => {
                res.statusCode = 500;
                res.end(String(err));
            });
    };

    return {
        name: 'asset-catalog',
        configureServer(server) {
            server.middlewares.use(handler);
        },
        configurePreviewServer(server) {
            server.middlewares.use(handler);
        },
    };
}

interface MapHeader {
    modelSha1: string | null;
    levels: number;
    gridSize: number | null;
}

/**
 * Memoize an async per-file computation, invalidated when the file size or mtime changes
 */
function createFileCache<T>(compute: (file: string) => Promise<T>): (file: string) => Promise<T> {
    const cache = new Map<string, { key: string; value: Promise<T> }>();
    return async file => {
        const { size, mtimeMs } = await stat(file);
        const key = `${size}:${mtimeMs}`;
        const hit = cache.get(file);
        if (hit && hit.key === key) return hit.value;

        const value = compute(file);
        cache.set(file, { key, value });
        value.catch(() => cache.delete(file)); // retried on the next request
        return value;
    };
}

async function readdirSafe(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}

function sha1File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha1');
        createReadStream(file)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

/** Fields of a saved SceneMap the start screen needs, null if the file isn't a map */
async function readMapHeader(file: string): Promise<MapHeader | null> {
    try {
        const map = JSON.parse(await readFile(file, 'utf8'));
        if (!map || !Array.isArray(map.levels)) return null;
        return {
            modelSha1: typeof map.modelSha1 === 'string' ? map.modelSha1 : null,
            levels: map.levels.length,
            gridSize: typeof map.gridSize === 'number' ? map.gridSize : null,
        };
    } catch {
        return null;
    }
}
