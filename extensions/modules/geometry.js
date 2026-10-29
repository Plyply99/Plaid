// Plaid — work-area / slot geometry helpers.
//
// Instance methods live on this subsystem class.


export class Geometry {
    constructor(core) {
        this.core = core;
    }

    isValidWorkArea(workArea) {
        // mutter can return a garbage rect from get_work_area_for_monitor
        // while monitors are mid-reconfiguration (the login race:
        // 9x 'get_logical_monitor_from_number' assertions → a (5,4,1,1)-class
        // rect passed the old width===0 guard and drove a false 1x1-slot
        // retile that floated Firefox at login). A healthy work area is
        // never under ~100px on either axis — reject anything smaller so
        // placements/slots/restores can never act on a degenerate rect.
        return !!(workArea &&
            Number.isFinite(workArea.x + workArea.y + workArea.width + workArea.height) &&
            workArea.width >= 100 && workArea.height >= 100);
    }

    outsideArea(workArea) {
        // The tiling area: the work area inset by the per-edge OUTSIDE gaps
        // (spacing between windows and the screen edges) — the same rect
        // whether one window or many (the multi-window layouts tile inside
        // it; the single-window placement IS it).
        if (!this.core._settings) return null;
        if (!this.isValidWorkArea(workArea)) return null;
        const top = this.core._settings.get_int('outside-gap-top');
        const bottom = this.core._settings.get_int('outside-gap-bottom');
        const left = this.core._settings.get_int('outside-gap-left');
        const right = this.core._settings.get_int('outside-gap-right');
        return {
            x: workArea.x + left,
            y: workArea.y + top,
            w: Math.max(1, workArea.width - left - right),
            h: Math.max(1, workArea.height - top - bottom),
        };
    }

    singleWindowRect(workArea) {
        return this.outsideArea(workArea);
    }

    minClampSlot(r, win, areaW, areaH) {
        if (!r) return r;
        const min = this.core.bsp.getWindowMinSize(win);
        if (min.w > 0 && r.w < min.w) r.w = Math.min(min.w, areaW);
        if (min.h > 0 && r.h < min.h) r.h = Math.min(min.h, areaH);
        return r;
    }

    bgAppRealToDisplay(realIdx) {
        const parkingIdx = this.core._backgroundAppParkingWs ?
            this.wsIndex(this.core._backgroundAppParkingWs) : -1;
        // No parking workspace => no reserved slot => identity mapping. A
        // bare `realIdx > -1` is always true and would shift every label
        // down by one.
        return parkingIdx >= 0 && realIdx > parkingIdx ? realIdx - 1 : realIdx;
    }

    wsIndex(ws) {
        if (!ws) return -1;
        // Scan for identity instead of calling ws.index(): during shell teardown
        // the workspace object can already be disposed, and Mutter asserts on
        // meta_workspace_index() for it.
        const wm = global.workspace_manager;
        for (let i = 0; i < wm.get_n_workspaces(); i++) {
            if (wm.get_workspace_by_index(i) === ws) return i;
        }
        return -1;
    }

}
