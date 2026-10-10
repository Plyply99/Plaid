// Plaid — border gradient geometry and colour math.
//
// Instance methods attached to TilingWMExtension.prototype in extension.js.

const BORDER_SEG_STEP = 12;
const BORDER_CORNER_MIN_SEGS = 8;
const BORDER_CORNER_SEG_STEP = 4;

export function _hexToRgb(hex) {
    const h = (hex || '').replace('#', '');
    const v = parseInt(h, 16);
    if (isNaN(v) || h.length < 6) return { r: 0.5, g: 0.5, b: 0.5 };
    return {
        r: ((v >> 16) & 255) / 255,
        g: ((v >> 8) & 255) / 255,
        b: (v & 255) / 255,
    };
}

export function _buildBorderSegments(border) {
    const info = border._plaidBorder;
    if (!info) return [];
    const w = border.width;
    const h = border.height;
    const key = `${w}x${h}x${info.radius}`;
    if (border._plaidSegs && border._plaidSegKey === key)
        return border._plaidSegs;

    const bw = info.width;
    const pathX = bw / 2;
    const pathY = bw / 2;
    const pathW = w - bw;
    const pathH = h - bw;
    if (pathW <= 0 || pathH <= 0) return [];

    const r = Math.min(Math.max(0, info.radius), pathW / 2, pathH / 2);
    const segs = [];
    const add = (x0, y0, x1, y1) => segs.push({ x0, y0, x1, y1 });
    const straight = (x0, y0, x1, y1) => {
        const len = Math.hypot(x1 - x0, y1 - y0);
        const n = Math.max(1, Math.ceil(len / BORDER_SEG_STEP));
        for (let i = 0; i < n; i++) {
            const a = i / n;
            const b = (i + 1) / n;
            add(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a,
                x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
        }
    };
    const arc = (cxp, cyp, a0, a1) => {
        const n = Math.max(BORDER_CORNER_MIN_SEGS, Math.ceil(Math.abs(a1 - a0) * r / BORDER_CORNER_SEG_STEP));
        for (let i = 0; i < n; i++) {
            const a = a0 + (a1 - a0) * (i / n);
            const b = a0 + (a1 - a0) * ((i + 1) / n);
            add(cxp + Math.cos(a) * r, cyp + Math.sin(a) * r,
                cxp + Math.cos(b) * r, cyp + Math.sin(b) * r);
        }
    };

    if (r <= 0) {
        straight(pathX, pathY, pathX + pathW, pathY);
        straight(pathX + pathW, pathY, pathX + pathW, pathY + pathH);
        straight(pathX + pathW, pathY + pathH, pathX, pathY + pathH);
        straight(pathX, pathY + pathH, pathX, pathY);
    } else {
        const top = pathY + r;
        const bottom = pathY + pathH - r;
        const left = pathX + r;
        const right = pathX + pathW - r;
        straight(left, pathY, right, pathY);
        arc(right, top, -Math.PI / 2, 0);
        straight(pathX + pathW, top, pathX + pathW, bottom);
        arc(right, bottom, 0, Math.PI / 2);
        straight(right, pathY + pathH, left, pathY + pathH);
        arc(left, bottom, Math.PI / 2, Math.PI);
        straight(pathX, bottom, pathX, top);
        arc(left, top, Math.PI, Math.PI * 1.5);
    }

    border._plaidSegs = segs;
    border._plaidSegKey = key;
    return segs;
}

export function _borderGradientPos(w, h, p, direction, animated, theta, cx, cy) {
    if (animated) {
        const ang = Math.atan2(p.y - cy, p.x - cx);
        const g = ((ang - theta) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
        return g < 0.5 ? g * 2 : (1 - g) * 2;
    }
    if (direction === 'horizontal')
        return Math.max(0, Math.min(1, p.x / w));
    if (direction === 'diagonal')
        return Math.max(0, Math.min(1, (p.x + p.y) / (w + h)));
    return Math.max(0, Math.min(1, p.y / h));
}

export function _lerpRgb(c1, c2, t) {
    const k = Math.max(0, Math.min(1, t));
    return {
        r: c1.r + (c2.r - c1.r) * k,
        g: c1.g + (c2.g - c1.g) * k,
        b: c1.b + (c2.b - c1.b) * k,
    };
}

export function _borderRotationMs(speed) {
    if (speed <= 0) return 0;
    return 22000 - speed * 2000;
}

export const borderMathMethods = {
    _hexToRgb,
    _buildBorderSegments,
    _borderGradientPos,
    _lerpRgb,
    _borderRotationMs,
};
