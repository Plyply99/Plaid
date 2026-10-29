// Drag previews: the full-screen overlay, the blue drop rectangle, and the
// dwindle/master-stack target calculations used while dragging a window.
//
// Methods are attached to TilingWMExtension.prototype by bootstrap.js.

import St from 'gi://St';

export function _updateDropOverlaySize() {
    const monitors = global.display.get_n_monitors();
    let maxX = 0, maxY = 0;
    for (let i = 0; i < monitors; i++) {
        const geom = global.display.get_monitor_geometry(i);
        maxX = Math.max(maxX, geom.x + geom.width);
        maxY = Math.max(maxY, geom.y + geom.height);
    }
    if (this._dropOverlay) {
        this._dropOverlay.set_position(0, 0);
        this._dropOverlay.set_size(maxX, maxY);
    }
}

export function _updateMoveDragPreview(metaWindow) {
    if (!metaWindow || !this._settings) return;
    const ws = metaWindow.get_workspace();
    if (!ws) return;
    // Click-vs-drag gate: keep the overlay hidden until the pointer
    // actually travelled — a titlebar click must not show a drag preview.
    const [px, py] = global.get_pointer();
    const dx = px - this._grabStartX;
    const dy = py - this._grabStartY;
    const grace = this._grabGrace ?? 10;
    if (Math.hypot(dx, dy) < grace) {
        this._hideDropPreview();
        return;
    }
    if (this._getWorkspaceLayout(ws) === 'floating') {
        this._hideDropPreview();
        return;
    }

    const tiledWindows = this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w));
    if (tiledWindows.length <= 1) {
        this._hideDropPreview();
        return;
    }

    const layout = this._getWorkspaceLayout(ws);
    if (layout === 'dwindle') {
        const leaf = this._computeDwindleDropTarget(ws, px, py);
        if (leaf && leaf.type === 'leaf') {
            this._showDropPreview(leaf._x, leaf._y, leaf._w, leaf._h);
        } else {
            this._hideDropPreview();
        }
    } else {
        const targetIdx = this._computeMasterStackDropTarget(ws, px, py);
        if (targetIdx >= 0) {
            this._showMasterStackPreview(ws, targetIdx);
        } else {
            this._hideDropPreview();
        }
    }
}

export function _showMasterStackPreview(ws, targetIdx) {
    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = ws.get_work_area_for_monitor(monitor);
    if (!workArea) return;

    const area = this._outsideArea(workArea);
    if (!area) return;
    const areaX = area.x;
    const areaY = area.y;
    const areaW = area.w;
    const areaH = area.h;
    const masterRatio = this._getMasterRatio(ws);
    const layout = this._getWorkspaceLayout(ws);

    let rx, ry;
    let rw, rh;

    if (targetIdx === 0) {
        if (layout === 'centered-master-stack') {
            const masterW = Math.floor((areaW - gap * 2) * masterRatio);
            rx = areaX + Math.floor((areaW - masterW) / 2);
            rw = masterW;
        } else {
            rw = Math.floor((areaW - gap) * masterRatio);
            rx = areaX;
        }
        ry = areaY;
        rh = areaH;
    } else {
        if (layout === 'centered-master-stack') {
            const leftCount = Math.ceil((this._getWindowsForWorkspace(ws).filter(w => !this._isFloating(w)).length - 1) / 2);
            const masterW = Math.floor((areaW - gap * 2) * masterRatio);
            const masterX = areaX + Math.floor((areaW - masterW) / 2);
            if (targetIdx <= leftCount) {
                rx = areaX;
                rw = masterX - areaX - gap;
            } else {
                rx = masterX + masterW + gap;
                rw = areaX + areaW - rx;
            }
        } else {
            const masterW = Math.floor((areaW - gap) * masterRatio);
            rx = areaX + masterW + gap;
            rw = areaW - masterW - gap;
        }
        ry = areaY;
        rh = areaH;
    }

    this._showDropPreview(rx, ry, rw, rh);
}

export function _computeDwindleDropTarget(ws, px, py) {
    const tree = this._bspGetTree(ws);
    if (!tree) return null;

    const gap = this._settings.get_int('inside-gap');
    const monitor = global.display.get_primary_monitor();
    const workArea = ws.get_work_area_for_monitor(monitor);
    if (!workArea) return null;

    const area = this._outsideArea(workArea);
    if (!area) return null;
    const ax = area.x;
    const ay = area.y;
    const aw = area.w;
    const ah = area.h;

    // Drop zones live inside the outside-gapped area — a pointer in the
    // outside-gap strip selects nothing.
    if (px < ax || px > ax + aw || py < ay || py > ay + ah)
        return null;

    this._bspTagGeometry(tree, ax, ay, aw, ah, gap);
    return this._bspFindLeafAtPoint(tree, ax, ay, aw, ah, px, py, gap);
}

export function _showDropPreview(x, y, w, h) {
    if (w <= 0 || h <= 0) {
        this._hideDropPreview();
        return;
    }
    if (!this._dropPreview) {
        this._dropPreview = new St.Widget({
            style: 'background-color: rgba(53, 132, 228, 0.15); border: 2px solid #3584e4;',
            reactive: false,
            visible: true,
        });
        this._dropOverlay.add_child(this._dropPreview);
    }
    this._dropPreview.visible = true;
    this._dropPreview.set_position(x, y);
    this._dropPreview.set_size(w, h);
}

export function _hideDropPreview() {
    // Hide, don't destroy — the 16ms grab loop alternates between
    // target/no-target regions; recreating the widget each tick churns
    // allocations and re-layout under a live grab.
    if (this._dropPreview)
        this._dropPreview.visible = false;
}

export function _destroyDropPreview() {
    if (this._dropPreview) {
        this._dropPreview.destroy();
        this._dropPreview = null;
    }
}

export function _destroyDropOverlay() {
    if (this._dropOverlay) {
        this._dropOverlay.destroy();
        this._dropOverlay = null;
    }
}

export const dragPreviewMethods = {
    _updateDropOverlaySize,
    _updateMoveDragPreview,
    _showMasterStackPreview,
    _computeDwindleDropTarget,
    _showDropPreview,
    _hideDropPreview,
    _destroyDropPreview,
    _destroyDropOverlay,
};
