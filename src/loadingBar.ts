export interface LoadingBar {
    /** progress in [0, 1] */
    set(progress: number, label: string): void;
    show(): void;
    hide(): void;
}

/**
 * Desktop loading bar, shown while the minimap is being built in the background
 */
export function createLoadingBar(): LoadingBar {
    const root = document.createElement('div');
    Object.assign(root.style, {
        position: 'fixed', left: '50%', bottom: '80px', transform: 'translateX(-50%)',
        width: '320px', padding: '10px 12px', borderRadius: '6px',
        background: 'rgba(0, 0, 0, 0.7)', color: '#fff',
        fontFamily: 'monospace', fontSize: '12px',
        zIndex: '1000', display: 'none', pointerEvents: 'none',
    });

    const text = document.createElement('div');
    Object.assign(text.style, { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' });
    const label = document.createElement('span');
    const percent = document.createElement('span');
    text.append(label, percent);

    const track = document.createElement('div');
    Object.assign(track.style, { height: '6px', borderRadius: '3px', background: 'rgba(255, 255, 255, 0.2)', overflow: 'hidden' });
    const fill = document.createElement('div');
    Object.assign(fill.style, { height: '100%', width: '0%', background: '#88aaff', transition: 'width 0.1s linear' });
    track.appendChild(fill);

    // The build doesn't block the scene: tell how to change its parameters meanwhile
    const hint = document.createElement('div');
    Object.assign(hint.style, { marginTop: '6px', color: '#aaa' });
    hint.textContent = 'E : edit mode (modifier les paramètres)';

    root.append(text, track, hint);
    document.body.appendChild(root);

    return {
        set(progress, text) {
            const p = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
            fill.style.width = `${p}%`;
            percent.textContent = `${p}%`;
            label.textContent = text;
        },
        show() {
            root.style.display = 'block';
        },
        hide() {
            root.style.display = 'none';
        },
    };
}
