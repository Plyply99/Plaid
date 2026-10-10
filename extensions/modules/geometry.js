// Plaid — work-area / slot geometry helpers.
//
// Instance methods attached to TilingWMExtension.prototype in extension.js.

export function _isValidWorkArea(workArea) {
    // mutter can return a garbage rect from get_work_area_for_monitor
    // while monitors are mid-reconfiguration (the 2026-10-04 login race:
    // 9x 'get_logical_monitor_from_number' assertions → a (5,4,1,1)-class
    // rect passed the old width===0 guard and drove a false 1x1-slot
    // retile that floated Firefox at login). A healthy work area is
    // never under ~100px on either axis — reject anything smaller so
    // placements/slots/restores can never act on a degenerate rect.
    return !!(workArea &&
        Number.isFinite(workArea.x + workArea.y + workArea.width + workArea.height) &&
        workArea.width >= 100 && workArea.height >= 100);
}

export function _outsideArea(workArea) {
    // The tiling area: the work area inset by the per-edge OUTSIDE gaps
    // (spacing between windows and the screen edges) — the same rect
    // whether one window or many (the multi-window layouts tile inside
    // it; the single-window placement IS it).
    if (!this._settings) return null;
    if (!this._isValidWorkArea(workArea)) return null;
    const top = this._settings.get_int('outside-gap-top');
    const bottom = this._settings.get_int('outside-gap-bottom');
    const left = this._settings.get_int('outside-gap-left');
    const right = this._settings.get_int('outside-gap-right');
    return {
        x: workArea.x + left,
        y: workArea.y + top,
        w: Math.max(1, workArea.width - left - right),
        h: Math.max(1, workArea.height - top - bottom),
    };
}

export function _singleWindowRect(workArea) {
    return this._outsideArea(workArea);
}

export function _minClampSlot(r, win, areaW, areaH) {
    if (!r) return r;
    const min = this._getWindowMinSize(win);
    if (min.w > 0 && r.w < min.w) r.w = Math.min(min.w, areaW);
    if (min.h > 0 && r.h < min.h) r.h = Math.min(min.h, areaH);
    return r;
}

export function _bgAppRealToDisplay(realIdx) {
    const parkingIdx = this._backgroundAppParkingWs ?
        this._wsIndex(this._backgroundAppParkingWs) : -1;
    // No parking workspace => no reserved slot => identity mapping. A
    // bare `realIdx > -1` is always true and would shift every label
    // down by one (2026-10-05 audit).
    return parkingIdx >= 0 && realIdx > parkingIdx ? realIdx - 1 : realIdx;
}

export const geometryMethods = {
    _isValidWorkArea,
    _outsideArea,
    _singleWindowRect,
    _minClampSlot,
    _bgAppRealToDisplay,
};
