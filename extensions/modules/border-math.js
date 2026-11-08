// Plaid — border gradient geometry and colour math.
//
// Instance methods live on this subsystem class.

const BORDER_SEG_STEP = 12;
const BORDER_CORNER_MIN_SEGS = 8;
const BORDER_CORNER_SEG_STEP = 4;


export class BorderMath {
    constructor(core) {
        this.core = core;
    }

    hexToRgb(hex) {
        const h = (hex || '').replace('#', '');
        const v = parseInt(h, 16);
        if (isNaN(v) || h.length < 6) return { r: 0.5, g: 0.5, b: 0.5 };
        return {
            r: ((v >> 16) & 255) / 255,
            g: ((v >> 8) & 255) / 255,
            b: (v & 255) / 255,
        };
    }

    buildBorderSegments(border, w = border.width, h = border.height) {
        const info = border._plaidBorder;
        if (!info) return [];
        const key = `${w}x${h}x${info.radius}x${info.width}`;
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

    // The stroke's rounded rect in a w x h border: inset half the stroke, the
    // radius clamped to it (the same rect buildBorderSegments walks). Null
    // when the stroke fills the border.
    borderPath(info, w, h) {
        const bw = info.width;
        const pw = w - bw, ph = h - bw;
        if (pw <= 0 || ph <= 0) return null;
        return { x: bw / 2, y: bw / 2, pw, ph, r: Math.min(Math.max(0, info.radius), pw / 2, ph / 2) };
    }

    // The line a static gradient runs along, in border pixels: its colour at a
    // point is borderGradientPos's (vertical y/h, horizontal x/w, diagonal
    // (x+y)/(w+h)), clamped at the ends.
    borderGradientLine(w, h, direction) {
        if (direction === 'horizontal') return [0, 0, w, 0];
        if (direction === 'diagonal') return [0, 0, (w + h) / 2, (w + h) / 2];
        return [0, 0, 0, h];
    }

    // The four strips a w x h gradient border is drawn in: top and bottom the
    // full width, left and right the rows between. Each reaches as deep as a
    // corner (clamped radius plus stroke, plus one antialiased pixel); on a
    // border under two corners deep they meet, and no pixel is in two strips.
    borderStripRects(info, w, h) {
        const bw = info?.width ?? 0;
        const r = Math.max(0, Math.min(info?.radius ?? 0, (w - bw) / 2, (h - bw) / 2));
        const depth = Math.ceil(r + bw) + 1;
        const t = Math.max(0, Math.min(depth, Math.floor(h / 2)));
        const bottom = Math.max(t, h - depth);
        const s = Math.max(0, Math.min(depth, Math.floor(w / 2)));
        const right = Math.max(s, w - depth);
        const mid = bottom - t;
        return [
            { x: 0, y: 0, w, h: t },
            { x: 0, y: bottom, w, h: h - bottom },
            { x: 0, y: t, w: s, h: mid },
            { x: right, y: t, w: w - right, h: mid },
        ];
    }

    // Per segment, its run's colour: a run is the segments in a row that round
    // to one 8-bit colour, drawn in its first segment's exact colour. A strip
    // starting mid-run draws it in that colour too.
    borderRuns(segs, w, h, info, animated, theta) {
        const list = [];
        let run = null;
        for (const seg of segs) {
            const p = { x: (seg.x0 + seg.x1) / 2, y: (seg.y0 + seg.y1) / 2 };
            const gpos = this.borderGradientPos(w, h, p, info.direction, animated, theta, w / 2, h / 2);
            const c = this.lerpRgb(info.color1, info.color2, gpos);
            const key = (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255);
            if (!run || run.key !== key) run = { key, c };
            list.push(run);
        }
        return list;
    }

    borderGradientPos(w, h, p, direction, animated, theta, cx, cy) {
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

    lerpRgb(c1, c2, t) {
        const k = Math.max(0, Math.min(1, t));
        return {
            r: c1.r + (c2.r - c1.r) * k,
            g: c1.g + (c2.g - c1.g) * k,
            b: c1.b + (c2.b - c1.b) * k,
        };
    }

    borderRotationMs(speed) {
        if (speed <= 0) return 0;
        return 22000 - speed * 2000;
    }

    // Rotation after which the gradient's colour moves by one 8-bit level: the
    // position is a triangle wave of slope 1/pi, so the widest channel difference
    // d changes a level every pi / d. Infinity for equal colours.
    gradientThetaStep(c1, c2) {
        const d = Math.max(Math.abs(c2.r - c1.r), Math.abs(c2.g - c1.g), Math.abs(c2.b - c1.b)) * 255;
        return d >= 1 ? Math.PI / d : Infinity;
    }

    // True when a gradient last drawn at angle `drawn` is at least `step`
    // behind `theta`, the wrap at 2*pi included.
    gradientStale(drawn, theta, step) {
        if (!(step < Infinity)) return false;
        if (drawn === undefined) return true;
        const d = Math.abs(theta - drawn) % (Math.PI * 2);
        return Math.min(d, Math.PI * 2 - d) >= step;
    }

}
