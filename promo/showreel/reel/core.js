/* =============================================================================
 * AGICENDS showreel · core.js
 * -----------------------------------------------------------------------------
 * Deterministic toolkit for the reel: every visual is a pure function of time,
 * so any frame can be rendered in isolation (parallel workers, motion-blur
 * sub-frames, stills for review).
 *
 *   math / easing / springs      — the motion vocabulary
 *   seeded random                — repeatable "randomness"
 *   vector character renderer    — draws the game's own character parts
 *                                  (client/character.js) as live canvas paths
 *   game primitives              — spikes, blocks, coins, polygons, powerups,
 *                                  cathedral parallax, all ported from the
 *                                  Phaser renderer in client/index.html
 * ===========================================================================*/
(function (global) {
    'use strict';

    const W = 1920, H = 1080, CX = W / 2, CY = H / 2;
    const TAU = Math.PI * 2;
    const BPM = 120, BEAT = 60 / BPM;

    // ── math ───────────────────────────────────────────────────────────────────
    const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
    const lerp = (a, b, t) => a + (b - a) * t;
    const prog = (t, a, b) => clamp((t - a) / (b - a));
    const smooth = (x) => x * x * (3 - 2 * x);
    const mix2 = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

    const E = {
        linear: (x) => x,
        inQuad: (x) => x * x,
        outQuad: (x) => 1 - (1 - x) * (1 - x),
        inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
        inCubic: (x) => x * x * x,
        outCubic: (x) => 1 - Math.pow(1 - x, 3),
        inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
        inQuart: (x) => x * x * x * x,
        outQuart: (x) => 1 - Math.pow(1 - x, 4),
        inOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
        outQuint: (x) => 1 - Math.pow(1 - x, 5),
        inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
        inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
        outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
        inOutExpo: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2),
        inSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
        outSine: (x) => Math.sin((x * Math.PI) / 2),
        inOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
        outBack: (x, s = 1.70158) => 1 + (s + 1) * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2),
        inBack: (x, s = 1.70158) => (s + 1) * x * x * x - s * x * x,
        inOutBack: (x, s = 1.70158 * 1.525) => (x < 0.5
            ? (Math.pow(2 * x, 2) * ((s + 1) * 2 * x - s)) / 2
            : (Math.pow(2 * x - 2, 2) * ((s + 1) * (x * 2 - 2) + s) + 2) / 2),
        outElastic: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (TAU / 3)) + 1),
    };
    const backOut = (s) => (x) => E.outBack(x, s);

    // Damped-spring step response 0→1 (overshoots when z < 1).
    function spring(t, f = 3, z = 0.4) {
        if (t <= 0) return 0;
        const w = TAU * f, wd = w * Math.sqrt(1 - z * z);
        return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
    }
    // Decaying oscillation that starts at 0 — impacts, jolts, wobbles.
    function wobble(t, f = 5, decay = 7) {
        if (t <= 0) return 0;
        return Math.exp(-decay * t) * Math.sin(TAU * f * t);
    }

    // Piecewise keyframes: [[t, v], [t, v, ease], …]; each ease shapes the segment
    // arriving at its key.
    function kf(t, keys) {
        if (t <= keys[0][0]) return keys[0][1];
        for (let i = 1; i < keys.length; i++) {
            const k = keys[i];
            if (t < k[0]) {
                const p = keys[i - 1];
                const e = k[2] || E.inOutCubic;
                return lerp(p[1], k[1], e((t - p[0]) / (k[0] - p[0])));
            }
        }
        return keys[keys.length - 1][1];
    }

    // ── seeded random ─────────────────────────────────────────────────────────
    function rnd(seed) {
        let t = (seed | 0) + 0x6d2b79f5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const rr = (seed, a, b) => a + (b - a) * rnd(seed);
    const rs = (seed) => rnd(seed) * 2 - 1;

    // Deterministic multi-sine shake.
    function shake(t, amp, seed = 1) {
        const x = Math.sin(t * 71.3 + seed) * 0.6 + Math.sin(t * 131.7 + seed * 2.3) * 0.4;
        const y = Math.sin(t * 83.1 + seed * 1.7) * 0.6 + Math.sin(t * 117.9 + seed * 0.7) * 0.4;
        return { x: x * amp, y: y * amp };
    }

    // ── colors ────────────────────────────────────────────────────────────────
    // Strictly the game's palette: pure black/white + the two cathedral greys.
    const C = { K: '#000000', Wh: '#ffffff', far: '#d0d0d0', mid: '#b0b0b0', ghost: '#e4e4e4' };

    // ── fonts ─────────────────────────────────────────────────────────────────
    const FONT_DISPLAY = 'ArchivoReel', FONT_MONO = 'MonoReel';
    async function loadFonts(base) {
        const faces = [
            new FontFace(FONT_DISPLAY, `url(${base}fonts/Archivo-VF.woff2)`, { weight: '100 900', stretch: '62% 125%' }),
            new FontFace(FONT_MONO, `url(${base}fonts/JetBrainsMono-VF.woff2)`, { weight: '400 800' }),
        ];
        await Promise.all(faces.map((f) => f.load()));
        faces.forEach((f) => document.fonts.add(f));
    }
    function font(ctx, size, weight = 900, family = FONT_DISPLAY, stretch = 'normal', spacing = 0) {
        ctx.font = `${Math.round(weight)} ${size}px ${family}`;
        ctx.fontStretch = stretch;
        ctx.letterSpacing = spacing + 'px';
    }

    // Glyph soup for decode/scramble effects (all within the fonts' latin subset).
    const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>?!';
    // Reveal `text` left→right as p goes 0→1; unrevealed cells churn every
    // other frame (keyed on the frame clock so motion-blur sub-frames agree).
    function scramble(text, p, frameT, seed = 0, spread = 0.35) {
        if (p <= 0) return '';
        let out = '';
        const n = text.length;
        const tick = Math.floor(frameT * 30);
        for (let i = 0; i < n; i++) {
            const ch = text[i];
            if (ch === ' ') { out += ' '; continue; }
            const at = (i / Math.max(1, n)) * (1 - spread);
            if (p >= at + spread) out += ch;
            else if (p >= at) out += GLYPHS[Math.floor(rnd(seed * 977 + i * 31 + tick * 7) * GLYPHS.length)];
            else out += '';
        }
        return out;
    }

    // ── shape helpers ─────────────────────────────────────────────────────────
    function polyPath(ctx, cx, cy, r, n, rot = -Math.PI / 2) {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const a = rot + (i * TAU) / n;
            const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }
    // Radius of a regular n-gon (circumradius R, a vertex at angle phi) along
    // direction theta. n = Infinity → circle. Interpolating these per-angle is
    // what gives the reel its liquid polygon morphs.
    function ngonRadius(theta, R, n, phi) {
        if (!isFinite(n)) return R;
        const seg = TAU / n;
        let a = (theta - phi) % seg; if (a < 0) a += seg;
        return (R * Math.cos(Math.PI / n)) / Math.cos(a - Math.PI / n);
    }

    function roundRectPath(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
    }

    // Game block: black rounded square (texture 90px, radius 24).
    function drawBlock(ctx, x, y, s, fill = C.K) {
        ctx.fillStyle = fill;
        roundRectPath(ctx, x - s / 2, y - s / 2, s, s, (s * 24) / 90);
        ctx.fill();
    }
    // Game coin: black triangle, thin white keyline. r = circumradius.
    function drawCoin(ctx, x, y, r, rot = -Math.PI / 2, lw = 2) {
        polyPath(ctx, x, y, r, 3, rot);
        ctx.fillStyle = C.K; ctx.fill();
        ctx.lineWidth = lw; ctx.strokeStyle = C.Wh; ctx.lineJoin = 'miter'; ctx.stroke();
    }
    // Hazard polygons as the game draws them (black fill, white keyline at 0.9r).
    function drawHazard(ctx, kind, x, y, size, angle = 0) {
        const r = size / 2;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
        if (kind === 'pentagon') { polyPath(ctx, 0, 0, r, 5); ctx.fillStyle = C.K; ctx.fill(); }
        else {
            const n = kind === 'hexagon' ? 6 : kind === 'heptagon' ? 7 : 8;
            const off = kind === 'octagon' ? -Math.PI / 8 : -Math.PI / 2;
            polyPath(ctx, 0, 0, r * 0.9, n, off);
            ctx.fillStyle = C.K; ctx.fill();
            ctx.lineWidth = kind === 'heptagon' ? 2 : 3; ctx.strokeStyle = C.Wh; ctx.stroke();
        }
        ctx.restore();
    }

    // Spike line: zig-zag of teeth with a solid black mass below. `top` is the
    // tip line (screen y); teeth can grow (0..1) with a per-tooth stagger fn.
    function drawSpikes(ctx, top, opts = {}) {
        const pitch = opts.pitch || 84, depth = opts.depth || 86;
        const grow = opts.grow || (() => 1);
        const x0 = -pitch * 2, x1 = W + pitch * 2;
        ctx.beginPath();
        ctx.moveTo(x0, H + 4000);
        const n = Math.ceil((x1 - x0) / pitch);
        const phase = opts.phase || 0;
        for (let i = 0; i <= n; i++) {
            const xc = x0 + i * pitch + phase;
            const g = grow(i, xc);
            const jit = opts.jitter ? opts.jitter(i) : 0;
            ctx.lineTo(xc - pitch / 2, top + depth);
            ctx.lineTo(xc, top + depth - depth * g - jit);
        }
        ctx.lineTo(x1 + pitch, top + depth);
        ctx.lineTo(x1 + pitch, H + 4000);
        ctx.closePath();
        ctx.fillStyle = opts.fill || C.K;
        ctx.fill();
    }

    // ── powerup icons (ported from createPowerupTextures, 96-unit design) ─────
    function puMult(ctx) {
        const c = 0, hw = 26, hh = 40;
        ctx.beginPath(); ctx.moveTo(c, -hh); ctx.lineTo(hw, 0); ctx.lineTo(c, hh); ctx.lineTo(-hw, 0); ctx.closePath();
        ctx.fillStyle = C.Wh; ctx.fill(); ctx.lineWidth = 5; ctx.strokeStyle = C.K; ctx.lineJoin = 'round'; ctx.stroke();
        ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-hw, 0); ctx.lineTo(hw, 0);
        ctx.moveTo(-hw * 0.6, -6); ctx.lineTo(0, 8); ctx.lineTo(hw * 0.6, -6); ctx.stroke();
    }
    function puMagnet(ctx, sc = 1) {
        const r = 20 * sc, by = 8 * sc, legTop = -22 * sc;
        const pts = [[-r, legTop]];
        for (let i = 0; i <= 18; i++) { const a = Math.PI * (1 - i / 18); pts.push([r * Math.cos(a), by + r * Math.sin(a)]); }
        pts.push([r, legTop]);
        const line = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); };
        ctx.lineJoin = 'round';
        line(); ctx.lineWidth = 16 * sc; ctx.strokeStyle = C.K; ctx.stroke();
        line(); ctx.lineWidth = 8 * sc; ctx.strokeStyle = C.Wh; ctx.stroke();
        ctx.lineWidth = 3;
        for (const px of [-r, r]) {
            ctx.fillStyle = C.Wh; ctx.fillRect(px - 9 * sc, legTop - 6 * sc, 18 * sc, 11 * sc);
            ctx.strokeStyle = C.K; ctx.strokeRect(px - 9 * sc, legTop - 6 * sc, 18 * sc, 11 * sc);
        }
    }
    function puGhost(ctx) {
        ctx.beginPath(); ctx.arc(0, 0, 40, 0, TAU);
        ctx.fillStyle = C.Wh; ctx.fill(); ctx.lineWidth = 5; ctx.strokeStyle = C.K; ctx.stroke();
        ctx.fillStyle = C.K;
        ctx.beginPath(); ctx.ellipse(-12, -4, 4.5, 13, 0, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.ellipse(12, -4, 4.5, 13, 0, 0, TAU); ctx.fill();
    }
    // Rays: 12 blunt trapezoids. `lens(i)` returns each ray length.
    function rays(ctx, inner, lens, wIn = 7, wOut = 4, lw = 3) {
        for (let i = 0; i < 12; i++) {
            const a = (i * Math.PI) / 6, len = lens(i);
            const ox = Math.cos(a), oy = Math.sin(a), bx = -oy, by = ox;
            ctx.beginPath();
            ctx.moveTo(ox * inner + bx * wIn, oy * inner + by * wIn);
            ctx.lineTo(ox * (inner + len) + bx * wOut, oy * (inner + len) + by * wOut);
            ctx.lineTo(ox * (inner + len) - bx * wOut, oy * (inner + len) - by * wOut);
            ctx.lineTo(ox * inner - bx * wIn, oy * inner - by * wIn);
            ctx.closePath();
            ctx.fillStyle = C.Wh; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = C.K; ctx.lineJoin = 'round'; ctx.stroke();
        }
    }
    function puSun(ctx) {
        rays(ctx, 26, (i) => (i % 2 === 0 ? 18 : 11));
        ctx.beginPath(); ctx.arc(0, 0, 24, 0, TAU);
        ctx.fillStyle = C.Wh; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = C.K; ctx.stroke();
    }
    function drawPowerup(ctx, type, x, y, size, alpha = 1, rot = 0) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(size / 96, size / 96); ctx.globalAlpha *= alpha;
        if (type === 'mult') puMult(ctx);
        else if (type === 'vacuum') puMagnet(ctx);
        else if (type === 'ghost') puGhost(ctx);
        else puSun(ctx);
        ctx.restore();
    }
    // Second Wind halo (drawHalo): breathing, non-rotating. Units: game px at
    // body radius 36 → scaled by r/36.
    function drawHalo(ctx, x, y, r, time, amp = 1) {
        const k = r / 36, t = time * 1000 / 175;
        ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
        rays(ctx, 42, (i) => 16 + 7 * amp * Math.sin(t + (i % 2) * Math.PI), 7, 4, 3 / Math.max(1, k * 0.6));
        ctx.restore();
    }
    // Mult character overlay: split rhombus behind the body.
    function drawMultBig(ctx, x, y, r, pulse) {
        const k = (r / 36) * 0.66;
        ctx.save(); ctx.translate(x, y); ctx.scale(k, k * pulse);
        const w = 38;
        ctx.fillStyle = C.Wh; ctx.strokeStyle = C.K; ctx.lineWidth = 4; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(0, -108); ctx.lineTo(-w, -6); ctx.lineTo(w, -6); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-w, 6); ctx.lineTo(w, 6); ctx.lineTo(0, 108); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
    }

    // ── lemniscate (∞), drawn — not in the fonts' latin subset ────────────────
    function infinityPath(ctx, cx, cy, a, p = 1) {
        ctx.beginPath();
        const steps = 160, end = Math.max(2, Math.floor(steps * p));
        for (let i = 0; i <= end; i++) {
            const tt = (i / steps) * TAU;
            const s = Math.sin(tt), c = Math.cos(tt), d = 1 + s * s;
            const x = cx + (a * c) / d, y = cy + (a * s * c) / d;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
    }

    // ── cathedral parallax (generateBackgroundTexture, widened for 16:9) ──────
    // Bands are the towers; slabs with arched undersides bridge each bay.
    function makeCathedral(opts) {
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = opts.tileH;
        const g = cv.getContext('2d');
        g.fillStyle = opts.fill;
        const bands = opts.bands;
        for (const b of bands) g.fillRect(b.x - b.w / 2, 0, b.w, opts.tileH);
        for (let i = 0; i < bands.length - 1; i++) {
            const a = bands[i], b = bands[i + 1];
            const xs = a.x + a.w / 2, xe = b.x - b.w / 2, mid = (xs + xe) / 2;
            const off = (i % 2) * opts.period * 0.5;
            for (let y = opts.start + off - opts.period; y < opts.tileH + opts.period; y += opts.period) {
                const bottom = y + opts.bridgeH;
                // The slab hangs off the band nearer the centre, like the game.
                const inner = Math.abs(a.x - CX) < Math.abs(b.x - CX) ? xs : xe;
                const outer = inner === xs ? xe : xs;
                const draw = (yy) => {
                    const bb = yy + opts.bridgeH;
                    g.beginPath();
                    g.moveTo(outer, yy); g.lineTo(inner, yy); g.lineTo(inner, bb);
                    g.quadraticCurveTo(mid, bb - opts.curveR, outer, bb);
                    g.closePath(); g.fill();
                };
                draw(y);
                if (bottom > opts.tileH) draw(y - opts.tileH);
            }
        }
        return cv;
    }
    // Draw a vertically-wrapping tile. `offset` is the scroll in screen px.
    function drawTile(ctx, tile, offset, scale = 1, cx = CX, cy = CY) {
        const th = tile.height;
        ctx.save();
        ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-CX, -CY);
        let y0 = ((offset % th) + th) % th - th;
        const span = H / scale + th * 2;
        for (let y = y0 - th; y < span + CY; y += th) ctx.drawImage(tile, 0, y);
        ctx.restore();
    }

    // ── vector character renderer ─────────────────────────────────────────────
    // Parses the SVG markup of each part from client/character.js into Path2D
    // draw ops once, then draws them with per-part transforms each frame so the
    // eyes can blink, ears spring and tails wag — and stay razor sharp at any
    // zoom (the opening shot is ~5x).
    const SVGNS = 'http://www.w3.org/2000/svg';
    function parseTransform(str) {
        let m = new DOMMatrix();
        const re = /(\w+)\s*\(([^)]*)\)/g; let r;
        while ((r = re.exec(str))) {
            const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
            if (r[1] === 'translate') m = m.translate(a[0], a[1] || 0);
            else if (r[1] === 'scale') m = m.scale(a[0], a.length > 1 ? a[1] : a[0]);
            else if (r[1] === 'rotate') {
                if (a.length > 2) m = m.translate(a[1], a[2]).rotate(a[0]).translate(-a[1], -a[2]);
                else m = m.rotate(a[0]);
            }
        }
        return m;
    }
    function parseMarkup(markup) {
        const doc = new DOMParser().parseFromString(`<svg xmlns="${SVGNS}">${markup}</svg>`, 'image/svg+xml');
        const ops = [];
        const walk = (el, m) => {
            for (const c of el.children) {
                let mm = m;
                const tr = c.getAttribute('transform');
                if (tr) mm = m.multiply(parseTransform(tr));
                const tag = c.tagName.toLowerCase();
                if (tag === 'g') { walk(c, mm); continue; }
                const n = (k) => parseFloat(c.getAttribute(k) || '0');
                let path = new Path2D();
                if (tag === 'circle') path.arc(n('cx'), n('cy'), n('r'), 0, TAU);
                else if (tag === 'ellipse') path.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, TAU);
                else if (tag === 'rect') path.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx'));
                else if (tag === 'polygon') {
                    const pts = c.getAttribute('points').trim().split(/[\s,]+/).map(Number);
                    for (let i = 0; i < pts.length; i += 2) (i ? path.lineTo(pts[i], pts[i + 1]) : path.moveTo(pts[i], pts[i + 1]));
                    path.closePath();
                } else if (tag === 'path') path = new Path2D(c.getAttribute('d'));
                else continue;
                ops.push({
                    path, m: mm,
                    fill: c.getAttribute('fill') || '#000',
                    stroke: c.getAttribute('stroke'),
                    lw: parseFloat(c.getAttribute('stroke-width') || '1'),
                    join: c.getAttribute('stroke-linejoin') || 'miter',
                    cap: c.getAttribute('stroke-linecap') || 'butt',
                    miter: parseFloat(c.getAttribute('stroke-miterlimit') || '4'),
                });
            }
        };
        walk(doc.documentElement, new DOMMatrix());
        return ops;
    }
    function colorOf(c, inv) {
        const s = c.toLowerCase();
        const white = s === '#fff' || s === '#ffffff' || s === 'white';
        if (!inv) return white ? C.Wh : C.K;
        return white ? C.K : C.Wh;
    }
    function drawOps(ctx, ops, inv, pxPerUnit) {
        for (const op of ops) {
            ctx.save();
            ctx.transform(op.m.a, op.m.b, op.m.c, op.m.d, op.m.e, op.m.f);
            if (op.fill !== 'none') { ctx.fillStyle = colorOf(op.fill, inv); ctx.fill(op.path); }
            if (op.stroke && op.stroke !== 'none') {
                ctx.lineWidth = Math.max(op.lw, 2.1 / pxPerUnit);
                ctx.lineJoin = op.join; ctx.lineCap = op.cap; ctx.miterLimit = op.miter;
                ctx.strokeStyle = colorOf(op.stroke, inv); ctx.stroke(op.path);
            }
            ctx.restore();
        }
    }

    const partOps = new Map();
    function opsFor(cat, id, key, build) {
        const k = cat + ':' + id + ':' + key;
        if (!partOps.has(k)) partOps.set(k, parseMarkup(build()));
        return partOps.get(k);
    }
    // Tail pivots (viewBox units) — where each tail meets the body.
    const TAIL_PIVOT = { cat: [80, 70], straight: [55, 62], fox: [-76, 70], devil: [84, 52], puff: [-80, 80], lizard: [70, 82], curl: [-70, 76] };

    function charParts(state) {
        const CH = global.Character;
        const P = CH.PARTS;
        const find = (cat) => P[cat].find((p) => p.id === state[cat]) || P[cat][0];
        const body = find('body'), eyes = find('eyes'), pupils = find('pupils'), ears = find('ears'), tail = find('tail');
        const M = CH.METRICS;
        return {
            eyeCx: M.eyeCx, eyeCy: M.eyeCy, bodyR: M.bodyR,
            pupilMax: eyes.pupilMax || { x: 20, y: 12 },
            tailId: tail.id,
            tail: opsFor('tail', tail.id, '', () => tail.render()),
            ears: opsFor('ears', ears.id, '', () => ears.render()),
            pattern: opsFor('body', body.id, '', () => body.pattern || ''),
            eyeL: opsFor('eyes', eyes.id, 'L', () => eyes.render(0, 0, false)),
            eyeR: opsFor('eyes', eyes.id, 'R', () => eyes.render(0, 0, true)),
            pupil: opsFor('pupils', pupils.id, '', () => pupils.render(0, 0)),
            hasEars: ears.id !== 'none', hasTail: tail.id !== 'none',
        };
    }

    const bodyPath = new Path2D(); bodyPath.arc(0, 0, 100, 0, TAU);
    const bodyClip = new Path2D(); bodyClip.arc(0, 0, 99.5, 0, TAU);

    /*  c = {
     *    x, y, r            screen position + body radius (px)
     *    state              character appearance (character.js ids)
     *    look {x,y}         gaze, −1..1 on each axis (drives eyes + pupils)
     *    blinkL, blinkR     eye openness scale (1 open → 0 shut; >1 = wide)
     *    sx, sy, anchor     squash/stretch and its pivot in body units (+100 = feet)
     *    rot                body rotation (rad)
     *    ears, tail         0..1 grow-in for accessories (springs overshoot)
     *    tailAng            extra tail swing (rad)
     *    pupilRot, pupilS   pupil spin (dizzy) / pupil scale
     *    inv                colour inversion (devils)
     *    alpha
     *  } */
    function drawCharacter(ctx, c) {
        const parts = charParts(c.state);
        const k = c.r / 100;
        const inv = !!c.inv;
        ctx.save();
        ctx.translate(c.x, c.y);
        if (c.rot) ctx.rotate(c.rot);
        ctx.scale(k, k);
        if (c.alpha != null && c.alpha < 1) ctx.globalAlpha *= c.alpha;
        const anchor = c.anchor || 0;
        ctx.translate(0, anchor); ctx.scale(c.sx || 1, c.sy || 1); ctx.translate(0, -anchor);

        const px = k * Math.max(0.3, Math.min(c.sx || 1, c.sy || 1));
        // tail (behind)
        const tailS = c.tail == null ? 1 : c.tail;
        if (parts.hasTail && tailS > 0.001) {
            const pv = TAIL_PIVOT[parts.tailId] || [70, 70];
            ctx.save();
            ctx.translate(pv[0], pv[1]);
            ctx.rotate((c.tailAng || 0) * (pv[0] < 0 ? -1 : 1));
            ctx.scale(tailS, tailS);
            ctx.translate(-pv[0], -pv[1]);
            drawOps(ctx, parts.tail, inv, px);
            ctx.restore();
        }
        // ears (behind)
        const earS = c.ears == null ? 1 : c.ears;
        if (parts.hasEars && earS > 0.001) {
            ctx.save();
            ctx.translate(0, -60); ctx.scale(clamp(0.6 + earS * 0.4, 0, 2), earS); ctx.translate(0, 60);
            drawOps(ctx, parts.ears, inv, px);
            ctx.restore();
        }
        // body
        ctx.fillStyle = inv ? C.Wh : C.K;
        ctx.fill(bodyPath);
        if (parts.pattern.length) {
            ctx.save(); ctx.clip(bodyClip);
            drawOps(ctx, parts.pattern, inv, px);
            ctx.restore();
        }
        ctx.lineWidth = Math.max(3, 2.1 / px);
        ctx.strokeStyle = inv ? C.Wh : C.K;
        ctx.stroke(bodyPath);

        // eyes: whites shift a little with gaze, pupils travel inside them
        const look = c.look || { x: 0, y: 0 };
        const shiftX = look.x * 14, shiftY = look.y * 10;
        const pm = parts.pupilMax;
        const eyes = [[-parts.eyeCx, parts.eyeL, c.blinkL == null ? 1 : c.blinkL],
                      [parts.eyeCx, parts.eyeR, c.blinkR == null ? 1 : c.blinkR]];
        for (const [ex, ops, open] of eyes) {
            const ey = parts.eyeCy;
            const s = Math.max(0.035, open);
            ctx.save();
            ctx.translate(ex + shiftX, ey + shiftY);
            ctx.scale(1, s);
            drawOps(ctx, ops, inv, px * Math.min(1, s));
            if (open > 0.18) {
                ctx.translate(look.x * pm.x, look.y * pm.y / Math.max(0.5, s));
                if (c.pupilRot) ctx.rotate(c.pupilRot);
                const ps = c.pupilS == null ? 1 : c.pupilS;
                if (ps !== 1) ctx.scale(ps, ps);
                drawOps(ctx, parts.pupil, inv, px);
            }
            ctx.restore();
        }
        ctx.restore();
    }

    // Particles: deterministic bursts evaluated analytically (no sim state).
    // Each particle: launch dir/speed from seed, drag + gravity closed form.
    function burst(ctx, t, opts) {
        const { x, y, n = 10, seed = 1, speed = [200, 600], life = [0.4, 0.8], size = [6, 12],
                gravity = 900, drag = 3.2, dir = null, spread = TAU, shape = 'square', color = C.K } = opts;
        if (t < 0) return;
        for (let i = 0; i < n; i++) {
            const s = seed * 1000 + i * 17;
            const L = rr(s + 1, life[0], life[1]);
            if (t > L) continue;
            const base = dir == null ? 0 : dir;
            const a = dir == null ? rr(s + 2, 0, TAU) : base + rs(s + 2) * spread / 2;
            const v = rr(s + 3, speed[0], speed[1]);
            // x(t) = v/k (1 − e^{−kt});  y adds gravity in the same drag field
            const e = (1 - Math.exp(-drag * t)) / drag;
            const px = x + Math.cos(a) * v * e;
            const py = y + Math.sin(a) * v * e + (gravity / drag) * (t - e);
            const f = 1 - t / L;
            const sz = rr(s + 4, size[0], size[1]) * (0.35 + 0.65 * f);
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(rr(s + 5, 0, TAU) + t * rs(s + 6) * 10);
            ctx.fillStyle = color;
            if (shape === 'tri') { polyPath(ctx, 0, 0, sz * 0.7, 3); ctx.fill(); }
            else ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
            ctx.restore();
        }
    }

    // Coin/pickup shockwave: white + black rings (game's coin FX, scaled).
    function rings(ctx, t, x, y, scale = 1, lw = 3) {
        const a = prog(t, 0, 0.45), b = prog(t, 0.05, 0.55);
        if (a > 0 && a < 1) {
            ctx.beginPath(); ctx.arc(x, y, (10 + 110 * E.outQuad(a)) * scale, 0, TAU);
            ctx.globalAlpha = 1 - a; ctx.lineWidth = lw; ctx.strokeStyle = C.Wh; ctx.stroke(); ctx.globalAlpha = 1;
        }
        if (b > 0 && b < 1) {
            ctx.beginPath(); ctx.arc(x, y, (10 + 130 * E.outQuad(b)) * scale, 0, TAU);
            ctx.globalAlpha = 1 - b; ctx.lineWidth = lw; ctx.strokeStyle = C.K; ctx.stroke(); ctx.globalAlpha = 1;
        }
    }

    // Numeric integration helper → lookup table (deterministic camera paths).
    function integrate(vfun, t0, t1, dt = 1 / 1000) {
        const n = Math.ceil((t1 - t0) / dt) + 1;
        const tab = new Float64Array(n);
        let y = 0;
        for (let i = 1; i < n; i++) {
            const tm = t0 + (i - 0.5) * dt;
            y += vfun(tm) * dt;
            tab[i] = y;
        }
        return (t) => {
            const f = (clamp(t, t0, t1) - t0) / dt;
            const i = Math.floor(f), fr = f - i;
            if (i >= n - 1) return tab[n - 1];
            return tab[i] + (tab[i + 1] - tab[i]) * fr;
        };
    }

    global.Reel = {
        W, H, CX, CY, TAU, BPM, BEAT, C, E, backOut,
        clamp, lerp, prog, smooth, mix2, spring, wobble, kf, rnd, rr, rs, shake,
        FONT_DISPLAY, FONT_MONO, loadFonts, font, scramble, GLYPHS,
        polyPath, ngonRadius, roundRectPath, drawBlock, drawCoin, drawHazard, drawSpikes,
        drawPowerup, drawHalo, drawMultBig, puMagnet, rays, infinityPath,
        makeCathedral, drawTile, drawCharacter, charParts, burst, rings, integrate,
    };
})(window);
