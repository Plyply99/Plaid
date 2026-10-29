// Drag previews: the full-screen overlay, the blue drop rectangle, and the
// dwindle/master-stack target calculations used while dragging a window.
//
// Methods live on this subsystem class.

import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';


export class DragPreview {
    constructor(core) {
        this.core = core;
    }

    updateDropOverlaySize() {
        const monitors = global.display.get_n_monitors();
        let maxX = 0, maxY = 0;
        for (let i = 0; i < monitors; i++) {
            const geom = global.display.get_monitor_geometry(i);
            maxX = Math.max(maxX, geom.x + geom.width);
            maxY = Math.max(maxY, geom.y + geom.height);
        }
        if (this.core._dropOverlay) {
            this.core._dropOverlay.set_position(0, 0);
            this.core._dropOverlay.set_size(maxX, maxY);
        }
    }

    updateMoveDragPreview(metaWindow) {
        if (!metaWindow || !this.core._settings) return;
        const ws = metaWindow.get_workspace();
        if (!ws) return;
        // Click-vs-drag gate: keep the overlay hidden until the pointer
        // actually travelled — a titlebar click must not show a drag preview.
        const [px, py] = global.get_pointer();
        const dx = px - this.core._grabStartX;
        const dy = py - this.core._grabStartY;
        const grace = this.core._grabGrace ?? 10;
        if (Math.hypot(dx, dy) < grace) {
            this.hideDropPreview();
            return;
        }
        if (this.core.windows.getWorkspaceLayout(ws) === 'floating') {
            this.hideDropPreview();
            return;
        }

        const tiledWindows = this.core.windows.getWindowsForWorkspace(ws).filter(w => !this.core.windows.isFloating(w));
        if (tiledWindows.length <= 1) {
            this.hideDropPreview();
            return;
        }

        const layout = this.core.windows.getWorkspaceLayout(ws);
        if (layout === 'dwindle') {
            const leaf = this.computeDwindleDropTarget(ws, px, py);
            if (leaf && leaf.type === 'leaf') {
                this.showDropPreview(leaf._x, leaf._y, leaf._w, leaf._h);
            } else {
                this.hideDropPreview();
            }
        } else {
            const targetIdx = this.core.layouts.computeMasterStackDropTarget(ws, px, py);
            if (targetIdx >= 0) {
                this.showMasterStackPreview(ws, targetIdx);
            } else {
                this.hideDropPreview();
            }
        }
    }

    showMasterStackPreview(ws, targetIdx) {
        const gap = this.core._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return;

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return;
        const areaX = area.x;
        const areaY = area.y;
        const areaW = area.w;
        const areaH = area.h;
        const masterRatio = this.core.layouts.getMasterRatio(ws);
        const layout = this.core.windows.getWorkspaceLayout(ws);

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
                const leftCount = Math.ceil((this.core.windows.getWindowsForWorkspace(ws).filter(w => !this.core.windows.isFloating(w)).length - 1) / 2);
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

        this.showDropPreview(rx, ry, rw, rh);
    }

    computeDwindleDropTarget(ws, px, py) {
        const tree = this.core.bsp.bspGetTree(ws);
        if (!tree) return null;

        const gap = this.core._settings.get_int('inside-gap');
        const monitor = global.display.get_primary_monitor();
        const workArea = ws.get_work_area_for_monitor(monitor);
        if (!workArea) return null;

        const area = this.core.geometry.outsideArea(workArea);
        if (!area) return null;
        const ax = area.x;
        const ay = area.y;
        const aw = area.w;
        const ah = area.h;

        // Drop zones live inside the outside-gapped area — a pointer in the
        // outside-gap strip selects nothing.
        if (px < ax || px > ax + aw || py < ay || py > ay + ah)
            return null;

        this.core.bsp.bspTagGeometry(tree, ax, ay, aw, ah, gap);
        return this.core.bsp.bspFindLeafAtPoint(tree, ax, ay, aw, ah, px, py, gap);
    }

    showDropPreview(x, y, w, h) {
        if (w <= 0 || h <= 0) {
            this.hideDropPreview();
            return;
        }
        if (!this.core._dropPreview) {
            this.core._dropPreview = new St.Widget({
                style: 'background-color: rgba(53, 132, 228, 0.15); border: 2px solid #3584e4;',
                reactive: false,
                visible: true,
            });
            this.core._dropOverlay.add_child(this.core._dropPreview);
        }
        this.core._dropPreview.visible = true;
        this.core._dropPreview.set_position(x, y);
        this.core._dropPreview.set_size(w, h);
    }

    hideDropPreview() {
        // Hide, don't destroy — the 16ms grab loop alternates between
        // target/no-target regions; recreating the widget each tick churns
        // allocations and re-layout under a live grab.
        if (this.core._dropPreview)
            this.core._dropPreview.visible = false;
    }

    destroyDropPreview() {
        if (this.core._dropPreview) {
            this.core._dropPreview.destroy();
            this.core._dropPreview = null;
        }
    }

    destroyDropOverlay() {
        if (this.core._dropOverlay) {
            this.core._dropOverlay.destroy();
            this.core._dropOverlay = null;
        }
    }

    init() {
        if (this.core._dropOverlay) return;
        this.core._dropOverlay = new St.Widget({
            reactive: false,
            visible: true,
        });
        Main.layoutManager.uiGroup.add_child(this.core._dropOverlay);
    }

    destroy() {
        this.destroyDropPreview();
        this.destroyDropOverlay();
    }
}
