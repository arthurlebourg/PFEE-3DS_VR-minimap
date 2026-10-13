// Catalog served by the dev server (vitePlugins/assetCatalog.ts)

export interface CatalogModel {
    file: string;
    size: number;
    sha1: string;
}

/**
 * @typedef CatalogMap a saved map in maps/
 * @prop mtime last modification, ms since epoch
 * @prop modelSha1 SHA-1 of the model it was built from
 */
export interface CatalogMap {
    file: string;
    size: number;
    mtime: number;
    modelSha1: string | null;
    levels: number;
    gridSize: number | null;
}

interface Catalog {
    models: CatalogModel[];
    maps: CatalogMap[];
}

/**
 * @typedef StartSelection what the user chose to launch
 * @prop modelFile file in models/
 * @prop mapFile file in maps/, null = build the map in the scene
 * @prop autoBuild without a map: start building right away (false = open the edit mode first)
 */
export interface StartSelection {
    modelFile: string;
    mapFile: string | null;
    autoBuild: boolean;
}

export interface StartScreen {
    /** Resolves when the user launches; call again after showError to let them pick again */
    waitForSelection(): Promise<StartSelection>;
    /** Switch to the loading view. progress in [0, 1], null = indeterminate */
    setProgress(progress: number | null, label: string): void;
    /** Back to the selection, with an error message */
    showError(message: string): void;
    close(): void;
}

const STORAGE_KEY = 'vr-minimap:start-selection';

function modelBaseName(file: string): string {
    return file.replace(/\.glb$/i, '');
}

/**
 * Maps of a model: built from it (same SHA-1) or named after it, most recent first
 */
function mapsFor(model: CatalogModel, maps: CatalogMap[]): CatalogMap[] {
    const base = modelBaseName(model.file).toLowerCase();
    return maps
        .filter(map => map.modelSha1 === model.sha1 || map.file.toLowerCase().startsWith(base))
        .sort((a, b) => b.mtime - a.mtime);
}

function loadStoredSelection(): Partial<StartSelection> {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
        return {};
    }
}

function storeSelection(selection: StartSelection): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
    } catch {
        // storage unavailable (private mode...): the selection just isn't remembered
    }
}

function formatSize(bytes: number): string {
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} Mo` : `${Math.ceil(bytes / 1024)} Ko`;
}

function formatDate(ms: number): string {
    return new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// Big targets and text: the screen is also used from the headset browser, with a controller pointer
const STYLE = `
.ss-root { position: fixed; inset: 0; z-index: 2000; overflow-y: auto; background: #0d0f14; color: #e8e8e8;
    font: 16px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; }
.ss-card { box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
.ss-title { margin: 0 0 4px; font-size: 28px; color: #ffee44; }
.ss-subtitle { margin: 0 0 28px; color: #9aa0aa; }
.ss-section { margin-bottom: 28px; }
.ss-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.ss-section-title { margin: 0; font-size: 18px; }
.ss-list { display: flex; flex-direction: column; gap: 8px; }
.ss-option { display: flex; align-items: center; gap: 14px; min-height: 60px; padding: 10px 16px; box-sizing: border-box;
    border: 2px solid #2b3040; border-radius: 10px; background: #161a23; cursor: pointer; }
.ss-option:hover { border-color: #4a5470; }
.ss-option:has(input:checked) { border-color: #88aaff; background: #1b2235; }
.ss-option:has(input:focus-visible) { outline: 3px solid #ffee44; outline-offset: 2px; }
.ss-option input { width: 22px; height: 22px; margin: 0; flex: none; accent-color: #88aaff; }
.ss-option-body { flex: 1; min-width: 0; }
.ss-option-name { font-weight: 600; overflow-wrap: anywhere; }
.ss-option-meta { color: #9aa0aa; font-size: 14px; }
.ss-badge { flex: none; padding: 2px 10px; border-radius: 999px; background: #2b3040; color: #c9d3ff; font-size: 13px; }
.ss-check { display: flex; align-items: flex-start; gap: 12px; margin-top: 12px; padding: 12px 16px; border-radius: 10px;
    background: #161a23; cursor: pointer; }
.ss-check input { width: 22px; height: 22px; margin: 0; flex: none; accent-color: #88aaff; }
.ss-hint { color: #9aa0aa; font-size: 14px; }
.ss-hint code { color: #c9d3ff; }
.ss-error { margin-bottom: 20px; padding: 12px 16px; border-radius: 10px; background: #3a1717; color: #ffb3b3; }
.ss-button { min-height: 48px; padding: 0 20px; border: none; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer; }
.ss-button:focus-visible { outline: 3px solid #ffee44; outline-offset: 2px; }
.ss-button:disabled { cursor: not-allowed; opacity: 0.5; }
.ss-launch { width: 100%; min-height: 64px; background: #2a6; color: #fff; font-size: 20px; }
.ss-refresh { min-height: 40px; padding: 0 14px; background: #2b3040; color: #e8e8e8; font-size: 14px; }
.ss-loading { display: flex; flex-direction: column; gap: 14px; padding-top: 18vh; }
.ss-loading-label { display: flex; justify-content: space-between; gap: 12px; color: #c9cdd6; }
.ss-track { height: 10px; border-radius: 5px; background: #2b3040; overflow: hidden; }
.ss-fill { height: 100%; width: 0%; background: #88aaff; transition: width 0.1s linear; }
.ss-fill.is-indeterminate { width: 30%; animation: ss-slide 1.2s ease-in-out infinite; }
@keyframes ss-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) { .ss-fill.is-indeterminate { animation: none; width: 100%; opacity: 0.4; } }
`;

/**
 * Full-page screen shown before the scene: pick a model from models/, then one of its saved maps
 * from maps/ (or none, to build it in the scene), then follow the model download
 */
export function createStartScreen(): StartScreen {
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = el('div', 'ss-root');
    const card = el('div', 'ss-card');
    root.appendChild(card);
    document.body.appendChild(root);

    let catalog: Catalog | null = null;
    let catalogError: string | null = null;
    let errorMessage: string | null = null;
    const stored = loadStoredSelection();
    let modelFile: string | null = stored.modelFile ?? null;
    let mapFile: string | null = stored.mapFile ?? null;
    let autoBuild = stored.autoBuild ?? true;
    let resolveSelection: ((selection: StartSelection) => void) | null = null;

    // loading view, built on the first setProgress
    let loadingFill: HTMLDivElement | null = null;
    let loadingText: HTMLSpanElement | null = null;
    let loadingPercent: HTMLSpanElement | null = null;

    async function fetchCatalog(): Promise<void> {
        catalog = null;
        catalogError = null;
        renderSelection();
        try {
            const res = await fetch('/api/catalog');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            catalog = await res.json() as Catalog;
            catalog.models.sort((a, b) => a.file.localeCompare(b.file));
        } catch (e) {
            console.error('Catalog unavailable:', e);
            catalogError = 'Impossible de lister les modèles : le catalogue n\'est servi que par le serveur de dev (npm run dev).';
        }
        renderSelection();
    }

    /** Keep the selection valid for the current catalog: known model, map of that model */
    function normalizeSelection(): CatalogMap[] {
        if (!catalog) return [];
        if (!catalog.models.some(m => m.file === modelFile)) modelFile = catalog.models[0]?.file ?? null;
        const model = catalog.models.find(m => m.file === modelFile);
        if (!model) return [];

        const maps = mapsFor(model, catalog.maps);
        if (mapFile !== null && !maps.some(m => m.file === mapFile)) mapFile = null;
        return maps;
    }

    function selectModel(file: string): void {
        modelFile = file;
        // default to the most recent map of the new model
        const model = catalog!.models.find(m => m.file === file)!;
        mapFile = mapsFor(model, catalog!.maps)[0]?.file ?? null;
        renderSelection();
    }

    function renderSelection(): void {
        // the list is rebuilt on every choice: give the focus back to the same control
        const focused = document.activeElement instanceof HTMLInputElement && card.contains(document.activeElement)
            ? { name: document.activeElement.name, value: document.activeElement.value }
            : null;
        renderSelectionContent();
        if (focused) {
            const inputs = card.querySelectorAll<HTMLInputElement>(`input[name="${focused.name}"]`);
            [...inputs].find(input => input.value === focused.value)?.focus();
        }
    }

    function renderSelectionContent(): void {
        card.replaceChildren();
        loadingFill = loadingText = loadingPercent = null;

        card.append(
            el('h1', 'ss-title', 'VR Minimap'),
            el('p', 'ss-subtitle', 'Choisis un modèle et la carte à charger. Sans carte, elle est calculée une fois dans la scène, pendant que tu peux déjà te déplacer et régler ses paramètres.'),
        );

        if (errorMessage) card.appendChild(el('div', 'ss-error', errorMessage));

        if (catalogError) {
            card.appendChild(el('div', 'ss-error', catalogError));
            return;
        }
        if (!catalog) {
            card.appendChild(el('p', 'ss-hint', 'Analyse des modèles… (les gros fichiers prennent quelques secondes la première fois)'));
            return;
        }

        const modelMaps = normalizeSelection();

        // 1. Model
        const modelSection = el('section', 'ss-section');
        const modelHead = el('div', 'ss-section-head');
        modelHead.appendChild(el('h2', 'ss-section-title', '1. Modèle'));
        const refreshBtn = el('button', 'ss-button ss-refresh', '↻ Actualiser');
        refreshBtn.type = 'button';
        refreshBtn.addEventListener('click', () => { errorMessage = null; void fetchCatalog(); });
        modelHead.appendChild(refreshBtn);
        modelSection.appendChild(modelHead);

        if (catalog.models.length === 0) {
            const hint = el('p', 'ss-hint');
            hint.append('Aucun modèle trouvé : ajoute des fichiers ', el('code', '', '.glb'), ' dans le dossier ', el('code', '', 'models/'), '.');
            modelSection.appendChild(hint);
            card.appendChild(modelSection);
            return;
        }

        const modelList = el('div', 'ss-list');
        modelList.setAttribute('role', 'radiogroup');
        for (const model of catalog.models) {
            const mapCount = mapsFor(model, catalog.maps).length;
            const option = radioOption('ss-model', model.file, model.file === modelFile, () => selectModel(model.file));
            option.body.append(
                el('div', 'ss-option-name', modelBaseName(model.file)),
                el('div', 'ss-option-meta', formatSize(model.size)),
            );
            option.label.appendChild(el('span', 'ss-badge', mapCount === 0 ? 'aucune carte' : `${mapCount} carte${mapCount > 1 ? 's' : ''}`));
            modelList.appendChild(option.label);
        }
        modelSection.appendChild(modelList);
        card.appendChild(modelSection);

        // 2. Map
        const mapSection = el('section', 'ss-section');
        const mapHead = el('div', 'ss-section-head');
        mapHead.appendChild(el('h2', 'ss-section-title', '2. Carte'));
        mapSection.appendChild(mapHead);

        const mapList = el('div', 'ss-list');
        mapList.setAttribute('role', 'radiogroup');

        const noMap = radioOption('ss-map', '', mapFile === null, () => { mapFile = null; renderSelection(); });
        noMap.body.append(
            el('div', 'ss-option-name', 'Aucune — calculer la carte dans la scène'),
            el('div', 'ss-option-meta', 'Le calcul tourne en arrière-plan, les paramètres restent modifiables (edit mode : E / bouton A)'),
        );
        mapList.appendChild(noMap.label);

        for (const map of modelMaps) {
            const option = radioOption('ss-map', map.file, map.file === mapFile, () => { mapFile = map.file; renderSelection(); });
            const details = [
                `${map.levels} étage${map.levels > 1 ? 's' : ''}`,
                map.gridSize !== null ? `grille ${map.gridSize.toFixed(2)} m` : null,
                formatDate(map.mtime),
            ].filter(Boolean).join(' · ');
            option.body.append(
                el('div', 'ss-option-name', map.file),
                el('div', 'ss-option-meta', details),
            );
            mapList.appendChild(option.label);
        }
        mapSection.appendChild(mapList);

        if (mapFile === null) {
            const check = el('label', 'ss-check');
            const input = el('input');
            input.type = 'checkbox';
            input.checked = autoBuild;
            input.addEventListener('change', () => { autoBuild = input.checked; });
            const text = el('div');
            text.append(
                el('div', 'ss-option-name', 'Lancer le calcul dès l\'arrivée dans la scène'),
                el('div', 'ss-hint', 'Décoché : la scène s\'ouvre en edit mode pour régler les paramètres avant le premier calcul (utile quand il est long).'),
            );
            check.append(input, text);
            mapSection.appendChild(check);
        }

        const saveHint = el('p', 'ss-hint');
        saveHint.append(
            'Les cartes sauvegardées (💾 Save map / bouton X) sont téléchargées sous le nom ',
            el('code', '', `${modelBaseName(modelFile!)}_sceneMap.json`),
            ' : place-les dans ', el('code', '', 'maps/'), ' pour les retrouver ici.',
        );
        mapSection.appendChild(saveHint);
        card.appendChild(mapSection);

        const launchBtn = el('button', 'ss-button ss-launch', 'Lancer ▶');
        launchBtn.type = 'button';
        launchBtn.disabled = resolveSelection === null;
        launchBtn.addEventListener('click', () => {
            if (!resolveSelection || !modelFile) return;
            const selection: StartSelection = { modelFile, mapFile, autoBuild };
            storeSelection(selection);
            const resolve = resolveSelection;
            resolveSelection = null;
            errorMessage = null;
            resolve(selection);
        });
        card.appendChild(launchBtn);
    }

    function radioOption(name: string, value: string, checked: boolean, onSelect: () => void) {
        const label = el('label', 'ss-option');
        const input = el('input');
        input.type = 'radio';
        input.name = name;
        input.value = value;
        input.checked = checked;
        input.addEventListener('change', () => { if (input.checked) onSelect(); });
        const body = el('div', 'ss-option-body');
        label.append(input, body);
        return { label, body };
    }

    function renderLoading(): void {
        card.replaceChildren();
        const view = el('div', 'ss-loading');
        view.appendChild(el('h1', 'ss-title', modelFile ? modelBaseName(modelFile) : 'Chargement'));

        const labelRow = el('div', 'ss-loading-label');
        loadingText = el('span');
        loadingPercent = el('span');
        labelRow.append(loadingText, loadingPercent);

        const track = el('div', 'ss-track');
        track.setAttribute('role', 'progressbar');
        loadingFill = el('div', 'ss-fill');
        track.appendChild(loadingFill);

        view.append(labelRow, track);
        card.appendChild(view);
    }

    void fetchCatalog();

    return {
        waitForSelection() {
            return new Promise(resolve => {
                resolveSelection = resolve;
                renderSelection();
            });
        },
        setProgress(progress, label) {
            if (!loadingFill) renderLoading();
            loadingText!.textContent = label;
            loadingFill!.classList.toggle('is-indeterminate', progress === null);
            if (progress === null) {
                loadingFill!.style.width = '';
                loadingPercent!.textContent = '';
            } else {
                const p = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
                loadingFill!.style.width = `${p}%`;
                loadingPercent!.textContent = `${p} %`;
            }
        },
        showError(message) {
            errorMessage = message;
            renderSelection();
        },
        close() {
            root.remove();
            style.remove();
        },
    };
}
