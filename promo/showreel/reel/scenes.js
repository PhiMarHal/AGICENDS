/* =============================================================================
 * AGICENDS showreel · scenes.js
 * -----------------------------------------------------------------------------
 * 15 s @ 120 BPM (one bar = 2 s). Seven shots, each landing on the grid:
 *
 *   01 AWAKEN     0.0  eyes open in the dark → whip-zoom reveal of the cathedral
 *   02 ASCEND     2.0  flap physics, coin arpeggio, parallax → snap-zoom into a coin
 *   03 GEOMETRY   4.0  3→4→5→6→7→8→∞ sided morph on eighth notes → the circle wakes up
 *   04 SIXTEEN    6.0  one becomes sixteen (the game's two-rows-of-eight start)
 *   05 DEVIL/ANGEL 8.0 "WHO ARE YOU TODAY?" → split-screen face-off
 *   06 SPIKES     10.0 the black floods back as the spike line; a physics chase
 *   07 AGICENDS   12.0 logo lockup; the spikes swallow everything but the eyes
 *
 * The last frame (eyes closing in the dark) loops into the first.
 * Audio cues are recorded into window.CUES so the soundtrack is built from the
 * exact same numbers as the picture.
 * ===========================================================================*/
(function (global) {
    'use strict';
    const R = global.Reel;
    const { W, H, CX, CY, TAU, C, E, clamp, lerp, prog, spring, wobble, kf, rnd, rr, rs, shake, font,
        FONT_DISPLAY: FD, FONT_MONO: FM } = R;

    const CUES = [];
    const cue = (t, kind, extra = {}) => CUES.push(Object.assign({ t: +t.toFixed(4), kind }, extra));

    const HERO = { body: 'solid', eyes: 'cat', pupils: 'slit', ears: 'none', tail: 'none' };
    const ROSTER = [
        { body: 'spots', eyes: 'round', pupils: 'dot', ears: 'bear', tail: 'none' },
        { body: 'solid', eyes: 'almond', pupils: 'slit', ears: 'cat', tail: 'cat' },
        { body: 'stripes', eyes: 'wide', pupils: 'dot-big', ears: 'bunny', tail: 'puff' },
        HERO,
        { body: 'half', eyes: 'diamond', pupils: 'diamond', ears: 'elf', tail: 'straight' },
        { body: 'check', eyes: 'droopy', pupils: 'heart', ears: 'floppy', tail: 'none' },
        { body: 'solid', eyes: 'squint', pupils: 'dot', ears: 'devil', tail: 'devil' },
        { body: 'star', eyes: 'oval-tall', pupils: 'star', ears: 'none', tail: 'fox' },
        { body: 'crescent', eyes: 'round', pupils: 'cross', ears: 'cat', tail: 'curl' },
        { body: 'solid', eyes: 'wide', pupils: 'spiral', ears: 'none', tail: 'lizard' },
        { body: 'spots', eyes: 'almond', pupils: 'heart', ears: 'bunny', tail: 'none' },
        { body: 'stripes', eyes: 'cat', pupils: 'star', ears: 'bear', tail: 'cat' },
        { body: 'solid', eyes: 'oval-tall', pupils: 'dot-big', ears: 'elf', tail: 'puff' },
        { body: 'half', eyes: 'round', pupils: 'slit', ears: 'floppy', tail: 'straight' },
        { body: 'check', eyes: 'diamond', pupils: 'dot', ears: 'devil', tail: 'fox' },
        { body: 'star', eyes: 'droopy', pupils: 'diamond', ears: 'cat', tail: 'lizard' },
    ];
    const HERO_I = 3;
    const DEVIL = { body: 'solid', eyes: 'almond', pupils: 'slit', ears: 'devil', tail: 'devil' };
    const ANGEL = { body: 'solid', eyes: 'round', pupils: 'dot-big', ears: 'none', tail: 'none' };

    // Squash & stretch after a flap at dt: stretched on the impulse, then a
    // damped recoil. Returns {sx, sy} with rough volume preservation.
    function flapSS(dt, amt = 0.32) {
        if (dt < 0) return { sx: 1, sy: 1 };
        const sy = 1 + amt * Math.exp(-8 * dt) * Math.cos(TAU * 3.2 * dt);
        return { sx: 1 / Math.sqrt(sy), sy };
    }
    function landSS(dt, amt = 0.3) {
        if (dt < 0) return { sx: 1, sy: 1 };
        const sy = 1 - amt * Math.exp(-9 * dt) * Math.cos(TAU * 3.4 * dt);
        return { sx: 1 / Math.sqrt(sy), sy };
    }
    const tri = (p) => (p <= 0 || p >= 1 ? 0 : 1 - Math.abs(p * 2 - 1));   // 0→1→0
    const blinkAt = (t, t0, d = 0.14) => 1 - E.inOutSine(tri(prog(t, t0, t0 + d)));

    // ─────────────────────────────────────────────────────────────────────────
    // Cathedral tiles (far = #d0d0d0 @0.3 parallax, mid = #b0b0b0 @0.55)
    // ─────────────────────────────────────────────────────────────────────────
    let TILE_FAR, TILE_MID, DOTGRID;
    const TILES = {};
    function buildTiles() {
        const k = 0.703;   // the game's own texture→screen scale (720/1024)
        TILE_FAR = R.makeCathedral({
            fill: C.far, tileH: Math.round(680 * k) * 4, period: Math.round(680 * k), start: 200 * k,
            bridgeH: 240 * k, curveR: 320 * k,
            bands: [-1180, -885, -590, -295, 0, 295, 590, 885, 1180].map((o, i) => ({ x: CX + o, w: o === 0 ? 169 : 84 })),
        });
        TILE_MID = R.makeCathedral({
            fill: C.mid, tileH: Math.round(1200 * k) * 2, period: Math.round(1200 * k), start: 0,
            bridgeH: 240 * k, curveR: 320 * k,
            bands: [-1290, -645, 0, 645, 1290].map((o) => ({ x: CX + o, w: o === 0 ? 112 : 84 })),
        });
        const blurTile = (tile, px) => {
            const th = tile.height;
            const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = th * 3;
            const g = tmp.getContext('2d'); for (let k = 0; k < 3; k++) g.drawImage(tile, 0, k * th);
            const out = document.createElement('canvas'); out.width = W; out.height = th;
            const o = out.getContext('2d'); o.filter = `blur(${px}px)`; o.drawImage(tmp, 0, -th);
            return out;
        };
        TILES.soft = [blurTile(TILE_FAR, 5), blurTile(TILE_MID, 2)];
        TILES.deep = [blurTile(TILE_FAR, 16), blurTile(TILE_MID, 10)];
        TILES.sharp = [TILE_FAR, TILE_MID];
        DOTGRID = document.createElement('canvas');
        DOTGRID.width = W; DOTGRID.height = H;
        const g = DOTGRID.getContext('2d');
        g.fillStyle = '#c8c8c8';
        for (let y = 12; y < H; y += 48) for (let x = 24; x < W; x += 48) { g.beginPath(); g.arc(x, y, 1.7, 0, TAU); g.fill(); }
    }

    // Camera: world point `x,y` sits at screen centre (+ shake), zoom z, roll rot.
    function camApply(ctx, cam) {
        ctx.translate(CX + (cam.sx || 0), CY + (cam.sy || 0));
        if (cam.rot) ctx.rotate(cam.rot);
        ctx.scale(cam.z, cam.z);
        ctx.translate(-cam.x, -cam.y);
    }
    function toScreen(cam, x, y) {
        const dx = (x - cam.x) * cam.z, dy = (y - cam.y) * cam.z;
        const c = Math.cos(cam.rot || 0), s = Math.sin(cam.rot || 0);
        return { x: CX + (cam.sx || 0) + dx * c - dy * s, y: CY + (cam.sy || 0) + dx * s + dy * c };
    }
    // Parallax layer: scroll + zoom attenuated by depth factor f.
    function drawLayer(ctx, tile, cam, f) {
        const z = 1 + (cam.z - 1) * f;
        const off = -cam.y * f, offX = -(cam.x - CX) * f;
        const th = tile.height;
        ctx.save();
        ctx.translate(CX + (cam.sx || 0) * f, CY + (cam.sy || 0) * f);
        if (cam.rot) ctx.rotate(cam.rot);
        ctx.scale(z, z);
        ctx.translate(-CX + offX, -CY + off);
        const lo = CY - off - CY / z - 200, hi = CY - off + CY / z + 200;
        for (let k = Math.floor(lo / th); k <= Math.floor(hi / th); k++) ctx.drawImage(tile, 0, k * th);
        ctx.restore();
    }
    function drawBackdrop(ctx, cam, look = 'soft', veil = 0) {
        ctx.fillStyle = C.Wh; ctx.fillRect(0, 0, W, H);
        const [far, mid] = TILES[look];
        drawLayer(ctx, far, cam, 0.3);
        drawLayer(ctx, mid, cam, 0.55);
        if (veil > 0) { ctx.fillStyle = `rgba(255,255,255,${veil})`; ctx.fillRect(0, 0, W, H); }
    }
    // Side walls: columns of small rounded blocks, world-anchored.
    function drawWalls(ctx, cam) {
        const s = 31.5, step = 35;
        const top = cam.y - (CY + 300) / cam.z, bot = cam.y + (CY + 300) / cam.z;
        ctx.fillStyle = C.K;
        for (let y = Math.floor(top / step) * step; y < bot; y += step) {
            for (const x of [17.5, W - 17.5]) { R.roundRectPath(ctx, x - s / 2, y - s / 2, s, s, s * 24 / 90); ctx.fill(); }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHOT 01–02 · AWAKEN → ASCEND (shared world)
    // ─────────────────────────────────────────────────────────────────────────
    const AB = {};
    function buildAB() {
        const G = 2600, V = 2400, FL = [2.0, 2.5, 3.0];
        AB.FL = FL;
        AB.hero = (t) => {
            let y = 0, vy = 0, last = 2.0;
            if (t > 2.0) {
                for (let i = 0; i < FL.length; i++) {
                    const tf = FL[i]; if (t < tf) break;
                    if (i > 0) { const d = tf - last; y += vy * d + 0.5 * G * d * d; vy += G * d; }
                    vy = -V; last = tf;
                }
                const d = t - last; y = y + vy * d + 0.5 * G * d * d; vy = vy + G * d;
            }
            const sway = Math.sin(Math.PI * (t - 2.0) * 1.0) * 120 * clamp((t - 2.0) * 3);
            const bob = t < 2 ? Math.sin(t * 5.2) * 5 * prog(t, 1.4, 1.7) : 0;
            return { x: CX + sway, y: y + bob, vy };
        };
        // camera follow: critically damped spring toward hero (sampled @1 kHz)
        const dt = 1 / 1000, n = Math.ceil(2.6 / dt) + 1, tab = new Float64Array(n);
        let cy = -20, cv = 0; const w = 13;
        for (let i = 0; i < n; i++) {
            const t = 1.6 + i * dt;
            const hh = AB.hero(t);
            const target = hh.y - 150 + Math.min(0, hh.vy) * 0.1;
            tab[i] = cy;
            const a = w * w * (target - cy) - 2 * w * cv;
            cv += a * dt; cy += cv * dt;
        }
        AB.follow = (t) => {
            if (t <= 1.6) return -20;
            const f = (t - 1.6) / dt, i = Math.min(n - 2, Math.floor(f));
            return lerp(tab[i], tab[i + 1], f - i);
        };
        // coins collected on eighth notes; the 7th is the one we dive into
        AB.coinT = [2.25, 2.5, 2.75, 3.0, 3.25, 3.5];
        AB.coins = AB.coinT.map((t, i) => { const h = AB.hero(t); return { x: h.x, y: h.y - 10, t, i }; });
        const h35 = AB.hero(3.5);
        AB.bigCoin = { x: CX + 40, y: h35.y - 760 };
        AB.coinT.forEach((t, i) => cue(t, 'coin', { n: i }));
        FL.forEach((t) => cue(t, 'flap'));
        // world dressing (x, y, size); kept off the hero's lane
        AB.blocks = [
            [330, -230, 90], [420, -230, 90], [1560, -40, 90], [1650, -560, 90], [1560, -560, 90], [260, -900, 90],
            [1480, -1320, 90], [430, -1700, 90], [520, -1700, 90], [1700, -2080, 90], [300, -2450, 90],
            [1580, -2820, 90], [1490, -2820, 90], [520, -3150, 90], [1650, -3500, 90], [260, -3700, 90],
            [1300, 180, 90], [640, 120, 90],
        ];
        AB.haz = [
            { k: 'pentagon', x: 560, y: -1150, s: 110, spin: 1.4 },
            { k: 'heptagon', x: 1440, y: -760, s: 120, spin: -0.9 },
            { k: 'octagon', x: 380, y: -2250, s: 130, spin: 0.7 },
            { k: 'pentagon', x: 1480, y: -3000, s: 100, spin: -1.6 },
            { k: 'heptagon', x: 360, y: -300, s: 100, spin: 1.1 },
        ];
        AB.hexPair = { lx: 1210, rx: 1720, y: -1960, fire: 2.9 };
        cue(1.0, 'whoosh_out');
        cue(0.1, 'eyes_open'); cue(0.37, 'dart'); cue(0.6, 'dart'); cue(0.8, 'blink'); cue(1.0, 'dart');
        cue(3.62, 'zoom_in');
    }

    function camAB(t) {
        const hero = AB.hero(t);
        let cam = { x: CX, y: -6, z: 1, rot: 0 };
        if (t < 1.0) {
            cam.z = lerp(5.2, 5.55, E.inOutSine(t / 1.0));
            cam.x = CX; cam.y = -6.3;
        } else if (t < 1.7) {
            const p = prog(t, 1.0, 1.62);
            const e = E.inOutQuart(p);
            cam.z = Math.exp(lerp(Math.log(5.55), 0, e));
            cam.y = lerp(-6.3, -20, e);
            cam.rot = kf(t, [[1.0, 0], [1.32, -0.075, E.outCubic], [1.75, 0, E.outBack]]);
        } else {
            cam.y = AB.follow(t);
        }
        if (t >= 3.6) {
            // snap-zoom into the big coin: log-zoom 1→10, coin glides to centre
            const p = prog(t, 3.6, 4.0);
            const e = E.inOutExpo(p);
            const z = Math.exp(lerp(0, Math.log(10), e));
            const base = { x: CX, y: AB.follow(t), z: 1, rot: 0 };
            const s0 = toScreen(base, AB.bigCoin.x, AB.bigCoin.y);
            const e2 = E.inOutCubic(p);
            const sx = lerp(s0.x, CX, e2), sy = lerp(s0.y, CY, e2);
            cam = { x: AB.bigCoin.x - (sx - CX) / z, y: AB.bigCoin.y - (sy - CY) / z, z, rot: 0 };
        }
        const sh = shake(t, 3.2 * Math.exp(-8 * Math.max(0, t - 2.0)) * (t >= 2.0 ? 1 : 0), 3);
        cam.sx = sh.x; cam.sy = sh.y;
        return cam;
    }

    function drawShotAB(ctx, t, ft) {
        const cam = camAB(t);
        const hero = AB.hero(t);
        const heroScreen = toScreen(cam, hero.x, hero.y);

        // 01: black void, the white world bleeds in from behind the body
        const revealR = t < 1.0 ? 0 : 90 * cam.z * (1 + 16 * E.inCubic(prog(t, 1.04, 1.5)));
        const fullWhite = t >= 1.5;
        ctx.fillStyle = C.K; ctx.fillRect(0, 0, W, H);
        ctx.save();
        if (!fullWhite) { ctx.beginPath(); ctx.arc(heroScreen.x, heroScreen.y, Math.max(0, revealR), 0, TAU); ctx.clip(); }
        if (revealR > 0 || fullWhite) {
            drawBackdrop(ctx, cam, t < 1.5 ? 'sharp' : 'soft');
            drawWordsB(ctx, t, cam);
            ctx.save(); camApply(ctx, cam);
            drawWalls(ctx, cam);
            for (const [x, y, s] of AB.blocks) R.drawBlock(ctx, x, y, s);
            for (const h of AB.haz) R.drawHazard(ctx, h.k, x_(h, t), h.y + Math.sin(t * 2 + h.x) * 12, h.s, h.spin * t);
            drawHexPair(ctx, AB.hexPair, t);
            // spikes far below (the threat, established)
            ctx.restore();
            const sp = toScreen(cam, 0, 430);
            if (cam.z < 3) {
                ctx.save();
                ctx.translate(CX, sp.y); ctx.scale(cam.z, cam.z); ctx.translate(-CX, 0);
                R.drawSpikes(ctx, 0, { pitch: 42, depth: 43, jitter: (i) => Math.sin(t * 6 + i) * 3 });
                ctx.restore();
            }
            ctx.save(); camApply(ctx, cam);
            // coins
            for (const c of AB.coins) {
                if (t < c.t) {
                    R.drawCoin(ctx, c.x, c.y + Math.sin(t * 4 + c.i) * 4, 23, -Math.PI / 2 + Math.sin(t * 3 + c.i) * 0.12);
                } else if (t < c.t + 0.7) {
                    const d = t - c.t;
                    const p = prog(d, 0, 0.12);
                    if (p < 1) { ctx.globalAlpha = 1 - p; R.drawCoin(ctx, c.x, c.y, 23 * (1 + 0.8 * p), -Math.PI / 2 + p * 2); ctx.globalAlpha = 1; }
                    R.rings(ctx, d, c.x, c.y, 0.75, 3);
                    R.burst(ctx, d, { x: c.x, y: c.y, n: 7, seed: 40 + c.i, speed: [260, 620], life: [0.3, 0.55], size: [12, 18], gravity: 500, shape: 'tri' });
                }
            }
            if (t > 3.62) {
                ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.fillStyle = `rgba(255,255,255,${E.inCubic(prog(t, 3.64, 3.97))})`; ctx.fillRect(0, 0, W, H);
                ctx.restore();
            }
            const bc = AB.bigCoin;
            const spinBig = t < 3.6 ? Math.sin(t * 3) * 0.1 : (TAU / 3) * E.inOutExpo(prog(t, 3.6, 4.0));
            R.drawCoin(ctx, bc.x, bc.y + (t < 3.6 ? Math.sin(t * 4) * 5 : 0), 23, -Math.PI / 2 + spinBig);
            // flap puffs
            for (const tf of AB.FL) {
                const d = t - tf;
                if (d >= 0 && d < 0.7) {
                    const hp = AB.hero(tf);
                    R.burst(ctx, d, { x: hp.x, y: hp.y + 70, n: 12, seed: 7 + tf * 10, dir: Math.PI / 2, spread: 1.9, speed: [240, 760], life: [0.35, 0.6], size: [8, 14], gravity: 300, drag: 4 });
                }
            }
            // hero
            let ss = { sx: 1, sy: 1 };
            if (t < 2.0) {
                const a = E.inOutSine(prog(t, 1.62, 1.97));
                ss = { sx: 1 + 0.14 * a, sy: 1 - 0.2 * a };
            } else {
                const lastF = AB.FL.filter((f) => f <= t).pop();
                ss = flapSS(t - lastF, 0.34);
            }
            const tremble = t > 1.62 && t < 2.0 ? Math.sin(t * 190) * 2.5 * prog(t, 1.62, 1.95) : 0;
            drawCharacter(ctx, {
                x: hero.x + tremble, y: hero.y, r: 90, state: HERO, sx: ss.sx, sy: ss.sy,
                ...eyesAB(t),
            });
            ctx.restore();
        }
        ctx.restore();

        // the eyes in the void (before the world exists they are all we see)
        if (!fullWhite) {
            ctx.save(); camApply(ctx, cam);
            drawCharacter(ctx, { x: hero.x, y: hero.y, r: 90, state: HERO, ...eyesAB(t), body: false });
            ctx.restore();
        }

        // score (02)
        if (t >= 2.0 && t < 3.75) {
            const n = AB.coinT.filter((c) => c <= t).length;
            const last = AB.coinT.filter((c) => c <= t).pop();
            const bump = last != null ? 0.35 * Math.exp(-14 * (t - last)) : 0;
            const a = prog(t, 2.0, 2.12) * (1 - prog(t, 3.6, 3.72));
            ctx.save();
            ctx.globalAlpha = a;
            ctx.translate(CX, 128 - 40 * (1 - E.outBack(prog(t, 2.0, 2.2))));
            ctx.scale(1 + bump, 1 + bump);
            font(ctx, 112, 900, FD, 'normal');
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 14; ctx.strokeStyle = C.Wh; ctx.lineJoin = 'round';
            ctx.strokeText(String(n), 0, 0);
            ctx.fillStyle = C.K; ctx.fillText(String(n), 0, 0);
            ctx.restore();
        }
    }
    const x_ = (h, t) => h.x + Math.sin(t * 1.3 + h.y) * 20;

    function eyesAB(t) {
        const open = t < 0.1 ? 0.0 : E.outBack(prog(t, 0.1, 0.34), 2.6);
        let lx = kf(t, [[0, 0], [0.36, 0], [0.45, -1.35, E.outExpo], [0.58, -1.35], [0.67, 1.35, E.outExpo], [0.97, 1.35], [1.06, 0, E.outExpo]]);
        let ly = kf(t, [[0, 0.1], [0.97, 0.1], [1.06, -1, E.outExpo]]);
        let bl = open * blinkAt(t, 0.78, 0.13);
        if (t > 1.6 && t < 2.0) bl *= lerp(1, 0.55, E.inOutSine(prog(t, 1.62, 1.95)));
        if (t >= 2.0) { bl = lerp(1.12, 1, prog(t, 2.0, 2.4)) * blinkAt(t, 3.08, 0.12); lx = Math.sin(t * 4) * 0.3; ly = -0.85; }
        return { look: { x: lx, y: ly }, blinkL: bl, blinkR: bl, pupilS: t > 0.97 && t < 2 ? 1.12 : 1 };
    }

    function drawHexPair(ctx, hp, t) {
        R.drawHazard(ctx, 'hexagon', hp.lx, hp.y, 90, 0);
        R.drawHazard(ctx, 'hexagon', hp.rx, hp.y, 90, 0);
        const d = t - hp.fire;
        const on = d > 0 && d < 0.5;
        const charge = clamp(1 - Math.abs(d + 0.25) / 0.25);   // warning flicker before firing
        const bx = hp.lx + 45, bw = hp.rx - hp.lx - 90;
        if (on) {
            const hgt = 25 * (1 + 0.5 * Math.exp(-12 * d)) * (1 - prog(d, 0.4, 0.5));
            ctx.fillStyle = C.Wh; ctx.fillRect(bx, hp.y - hgt / 2, bw, hgt);
            ctx.lineWidth = 2; ctx.strokeStyle = C.K; ctx.strokeRect(bx, hp.y - hgt / 2, bw, hgt);
        } else if (charge > 0) {
            ctx.setLineDash([10, 10]); ctx.lineDashOffset = -t * 300;
            ctx.lineWidth = 2; ctx.strokeStyle = C.K; ctx.globalAlpha = charge;
            ctx.beginPath(); ctx.moveTo(bx, hp.y); ctx.lineTo(bx + bw, hp.y); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
    }

    // parallax outline words behind the action
    function drawWordsB(ctx, t, cam) {
        if (t < 1.9 || t > 3.9) return;
        const words = [['FLAP', 500, 2.42], ['CLIMB', 1420, 3.02]];
        for (const [w, x, t0] of words) {
            const y = CY + (AB.follow(t0) - cam.y) * 0.5 * cam.z;
            if (y < -300 || y > H + 300) continue;
            ctx.save();
            ctx.translate(CX + (x - CX) * (1 + (cam.z - 1) * 0.5), y);
            ctx.scale(1 + (cam.z - 1) * 0.5, 1 + (cam.z - 1) * 0.5);
            font(ctx, 170, 900, FD, 'expanded');
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 3.5; ctx.strokeStyle = C.K; ctx.lineJoin = 'miter';
            ctx.strokeText(w, 0, 0);
            ctx.restore();
        }
    }

    // wrapper so every shot draws characters through one place
    function drawCharacter(ctx, c) {
        if (c.body === false) {
            // eyes-only pass: draw on a black body-less stage (used in the void)
            const tmp = Object.assign({}, c);
            delete tmp.body;
            R.drawCharacter(ctx, tmp);
            return;
        }
        R.drawCharacter(ctx, c);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHOT 03 · GEOMETRY
    // ─────────────────────────────────────────────────────────────────────────
    const GEO = {
        hits: [4.0, 4.25, 4.5, 4.75, 5.0, 5.25, 5.5],
        n: [3, 4, 5, 6, 7, 8, Infinity],
        names: ['COIN', 'BLOCK', 'PENTAGON', 'HEXAGON', 'HEPTAGON', 'OCTAGON', 'YOU'],
        R: 230,
    };
    GEO.hits.forEach((t, i) => i > 0 && cue(t, 'morph', { n: i }));
    cue(5.0, 'invert'); cue(5.5, 'invert');

    function geoState(t) {
        let k = 0;
        for (let i = 0; i < GEO.hits.length; i++) if (t >= GEO.hits[i]) k = i;
        const m = k === 0 ? 1 : R.backOut(2.2)(prog(t, GEO.hits[k], GEO.hits[k] + 0.2));
        let spin = 0;
        for (let i = 1; i < GEO.hits.length; i++) spin += (Math.PI / 5) * E.outExpo(prog(t, GEO.hits[i], GEO.hits[i] + 0.32));
        spin += (t - 4.0) * 0.18;
        const phi = -Math.PI / 2 + spin;
        return { k, m, phi };
    }
    function ngonMorph(ctx, cx, cy, Rr, nA, nB, m, phi, scale = 1) {
        ctx.beginPath();
        const S = 240;
        for (let i = 0; i <= S; i++) {
            const th = (i / S) * TAU;
            const r = lerp(R.ngonRadius(th, Rr, nA, phi), R.ngonRadius(th, Rr, nB, phi), m) * scale;
            const x = cx + Math.cos(th) * r, y = cy + Math.sin(th) * r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
    }

    function drawShotC(ctx, t, ft) {
        ctx.fillStyle = C.Wh; ctx.fillRect(0, 0, W, H);
        const { k, m, phi } = geoState(t);
        const inA = E.outCubic(prog(t, 4.0, 4.3));
        const out = E.inCubic(prog(t, 5.62, 5.92));
        // designer's artboard
        ctx.globalAlpha = inA * (1 - out) * 0.9;
        ctx.drawImage(DOTGRID, 0, 0);
        ctx.globalAlpha = 1;

        const sc = 1 + 0.14 * wobble(t - GEO.hits[k], 3.2, 8);
        const nA = k === 0 ? 3 : GEO.n[k - 1], nB = GEO.n[k];
        const isCircle = t >= 5.5;

        // echoes of the previous forms
        for (let i = 1; i <= k; i++) {
            const d = t - GEO.hits[i];
            if (d > 0.55) continue;
            const p = E.outCubic(prog(d, 0, 0.55));
            const ph = geoState(GEO.hits[i] - 0.001).phi;
            ngonMorph(ctx, CX, CY, GEO.R, GEO.n[i - 1], GEO.n[i - 1], 0, ph, 1 + 0.9 * p);
            ctx.globalAlpha = (1 - p) * 0.85; ctx.lineWidth = 3 * (1 - p) + 1; ctx.strokeStyle = C.K; ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // construction: dial ring + ticks + radial guides + vertex handles
        const ringP = E.outCubic(prog(t, 4.02, 4.4)) * (1 - E.inCubic(prog(t, 5.5, 5.78)));
        if (ringP > 0.001) {
            const RR = 340;
            ctx.lineWidth = 1.5; ctx.strokeStyle = C.mid;
            ctx.beginPath(); ctx.arc(CX, CY, RR, -Math.PI / 2, -Math.PI / 2 + TAU * ringP); ctx.stroke();
            const rot = (t - 4) * -0.25;
            for (let i = 0; i < 72; i++) {
                const a = rot + (i / 72) * TAU;
                if ((i / 72) > ringP) continue;
                const len = i % 6 === 0 ? 14 : 7;
                ctx.beginPath();
                ctx.moveTo(CX + Math.cos(a) * RR, CY + Math.sin(a) * RR);
                ctx.lineTo(CX + Math.cos(a) * (RR + len), CY + Math.sin(a) * (RR + len));
                ctx.stroke();
            }
            if (isFinite(nB)) {
                ctx.save();
                ctx.setLineDash([5, 7]); ctx.lineDashOffset = -t * 40;
                ctx.strokeStyle = C.K; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.55 * ringP;
                for (let v = 0; v < nB; v++) {
                    const a = phi + (v * TAU) / nB;
                    ctx.beginPath(); ctx.moveTo(CX, CY);
                    ctx.lineTo(CX + Math.cos(a) * (RR + 30), CY + Math.sin(a) * (RR + 30)); ctx.stroke();
                }
                ctx.restore();
                // tick markers on the ring at each vertex angle
                ctx.strokeStyle = C.K; ctx.lineWidth = 3;
                for (let v = 0; v < nB; v++) {
                    const a = phi + (v * TAU) / nB;
                    ctx.beginPath();
                    ctx.moveTo(CX + Math.cos(a) * (RR - 10), CY + Math.sin(a) * (RR - 10));
                    ctx.lineTo(CX + Math.cos(a) * (RR + 24), CY + Math.sin(a) * (RR + 24)); ctx.stroke();
                }
            }
            // centre crosshair
            ctx.strokeStyle = C.K; ctx.lineWidth = 1.5; ctx.globalAlpha = ringP;
            ctx.beginPath(); ctx.moveTo(CX - 12, CY); ctx.lineTo(CX + 12, CY); ctx.moveTo(CX, CY - 12); ctx.lineTo(CX, CY + 12); ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // THE SHAPE
        if (!isCircle || t < 5.52) {
            ngonMorph(ctx, CX, CY, GEO.R, nA, nB, m, phi, sc);
            ctx.fillStyle = C.K; ctx.fill();
        }
        // vertex handles (bezier-editor anchors) pop in on every hit
        if (isFinite(nB) && ringP > 0.001) {
            for (let v = 0; v < nB; v++) {
                const a = phi + (v * TAU) / nB;
                const r = R.ngonRadius(a, GEO.R, nB, phi) * sc;
                const s = 15 * clamp(spring(t - GEO.hits[k] - v * 0.012, 4, 0.35), 0, 1.6) * ringP;
                if (s <= 0.2) continue;
                const x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
                ctx.fillStyle = C.Wh; ctx.fillRect(x - s / 2, y - s / 2, s, s);
                ctx.lineWidth = 2; ctx.strokeStyle = C.K; ctx.strokeRect(x - s / 2, y - s / 2, s, s);
            }
            // interior-angle readout near the top vertex
            const ang = (180 * (nB - 2)) / nB;
            const a = phi;
            const x = CX + Math.cos(a) * (GEO.R * sc + 44), y = CY + Math.sin(a) * (GEO.R * sc + 44);
            font(ctx, 20, 700, FM); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = C.K; ctx.globalAlpha = ringP;
            const txt = (Math.round(ang * 10) / 10) + '°';
            ctx.fillText(R.scramble(txt, prog(t, GEO.hits[k], GEO.hits[k] + 0.14), ft, k + 3, 0.5), x, y);
            ctx.globalAlpha = 1;
        }

        // the circle wakes up — it was the hero all along
        if (t >= 5.5) drawHeroGeo(ctx, t);

        // odometer numeral (left) — outline type, masked roll
        drawOdometer(ctx, t, k, inA, out);
        // name ticker (right)
        drawTicker(ctx, t, k, ft, inA, out);
    }

    function heroGeoPose(t) {
        // 5.5 wake → 6.0 dives to its slot in the grid
        const slot = slotPos(HERO_I);
        const p = E.inBack(prog(t, 5.86, 6.0), 1.4);
        const x = lerp(CX, slot.x, p), y = lerp(CY, slot.y, p);
        const r = lerp(GEO.R * (1 + 0.14 * wobble(t - 5.5, 3.2, 8)), 62, p) * (1 + 0.05 * E.inOutSine(tri(prog(t, 5.78, 5.9))));
        const open = E.outBack(prog(t, 5.53, 5.7), 2.4) * blinkAt(t, 5.84, 0.1);
        const lx = kf(t, [[5.5, 0], [5.66, 0.9, E.outExpo], [5.76, 0.9], [5.82, 0, E.outExpo]]);
        const ly = kf(t, [[5.5, 0], [5.66, -0.1], [5.82, 0.15, E.outExpo]]);
        return { x, y, r, open, look: { x: lx, y: ly } };
    }
    function drawHeroGeo(ctx, t) {
        const h = heroGeoPose(t);
        drawCharacter(ctx, { x: h.x, y: h.y, r: h.r, state: HERO, blinkL: h.open, blinkR: h.open, look: h.look });
    }

    function drawOdometer(ctx, t, k, inA, out) {
        const x = 390, y = CY, boxH = 480;
        ctx.save();
        ctx.beginPath(); ctx.rect(x - 330, y - boxH / 2, 660, boxH); ctx.clip();
        const roll = k === 0 ? 1 : E.outExpo(prog(t, GEO.hits[k], GEO.hits[k] + 0.22));
        const drawN = (i, dy, a) => {
            if (i < 0) return;
            ctx.save(); ctx.translate(x, y + dy);
            ctx.globalAlpha = a;
            if (i === 6) {
                const p = E.outCubic(prog(t, 5.5, 5.85));
                ctx.lineWidth = 4; ctx.strokeStyle = C.K; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
                R.infinityPath(ctx, 0, 0, 200, p); ctx.stroke();
            } else {
                font(ctx, 430, 900, FD, 'semi-condensed');
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.lineWidth = 3.5; ctx.strokeStyle = C.K; ctx.lineJoin = 'miter';
                ctx.strokeText('0' + GEO.n[i], 0, 10);
            }
            ctx.restore();
        };
        const slide = (1 - inA) * 200 + out * -520;
        const a = inA * (1 - out);
        drawN(k, (1 - roll) * boxH + slide, a);
        if (k > 0 && roll < 1) drawN(k - 1, -roll * boxH + slide, a);
        ctx.restore();
        // caption
        font(ctx, 17, 700, FM, 'normal', 3); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = C.K; ctx.globalAlpha = inA * (1 - out);
        ctx.fillText('SIDES', x - 250, y - boxH / 2 - 14);
        ctx.globalAlpha = 1;
    }

    function drawTicker(ctx, t, k, ft, inA, out) {
        const x = 1400, lh = 74;
        const kk = k === 0 ? 0 : (k - 1) + E.outExpo(prog(t, GEO.hits[k], GEO.hits[k] + 0.22));
        ctx.save();
        ctx.translate((1 - inA) * 140 + out * 260, 0);
        font(ctx, 17, 700, FM, 'normal', 3); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = C.K; ctx.globalAlpha = inA * (1 - out);
        ctx.fillText('FORM', x, CY - 240 - 14);
        for (let i = 0; i < GEO.names.length; i++) {
            const d = i - kk;
            const yy = CY + d * lh;
            const ad = Math.abs(d);
            if (ad > 3.2) continue;
            const act = clamp(1 - ad);
            ctx.globalAlpha = clamp(1 - ad / 3.2) * inA * (1 - out);
            font(ctx, 40, lerp(500, 800, act), FM, 'normal', 2);
            ctx.fillStyle = act > 0.5 ? C.K : C.mid;
            let s = GEO.names[i];
            if (i === k) s = R.scramble(s, prog(t, GEO.hits[k], GEO.hits[k] + 0.16), ft, 50 + i, 0.4);
            ctx.textBaseline = 'middle';
            ctx.fillText(s, x + 44 * act, yy);
        }
        // marker: a coin pointing at the active row
        ctx.globalAlpha = inA * (1 - out);
        R.polyPath(ctx, x + 8, CY, 13, 3, 0); ctx.fillStyle = C.K; ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHOT 04 · SIXTEEN
    // ─────────────────────────────────────────────────────────────────────────
    function slotPos(i) {
        const c = i % 8, r = Math.floor(i / 8);
        return { x: CX + (c - 3.5) * 212, y: r === 0 ? 430 : 700, c, r };
    }
    const D = {};
    function buildD() {
        const hs = slotPos(HERO_I);
        const order = ROSTER.map((_, i) => i).filter((i) => i !== HERO_I)
            .sort((a, b) => Math.hypot(slotPos(a).x - hs.x, slotPos(a).y - hs.y) - Math.hypot(slotPos(b).x - hs.x, slotPos(b).y - hs.y));
        D.land = new Array(16);
        D.launch = new Array(16);
        D.land[HERO_I] = 6.0; D.launch[HERO_I] = 5.86;
        order.forEach((idx, j) => {
            const land = 6.0 + (j + 1) * 0.0625;
            const s = slotPos(idx);
            const dist = Math.hypot(s.x - hs.x, s.y - hs.y);
            D.land[idx] = land;
            D.launch[idx] = Math.max(6.0, land - (0.2 + dist * 0.00018));
        });
        for (let j = 0; j < 16; j++) cue(6.0 + j * 0.0625, 'count', { n: j });
        cue(7.0, 'hop');
        cue(7.8, 'launch');
    }

    function poseD(i, t) {
        const s = slotPos(i), hs = slotPos(HERO_I);
        const land = D.land[i], launch = D.launch[i];
        let x = s.x, y = s.y, r = 62, sx = 1, sy = 1, visible = t >= launch || i === HERO_I;
        let acc = 1, open = 1, anchor = 100;
        if (i !== HERO_I && t < land) {
            const u = prog(t, launch, land);
            const e = E.outCubic(u);
            const dist = Math.hypot(s.x - hs.x, s.y - hs.y);
            x = lerp(hs.x, s.x, e);
            y = lerp(hs.y, s.y, e) - (80 + dist * 0.22) * 4 * u * (1 - u);
            r = lerp(30, 62, E.outBack(u));
            sy = 1 + 0.25 * Math.sin(Math.PI * u); sx = 1 / Math.sqrt(sy);
            acc = 0; open = 1;
        } else {
            const dt = t - land;
            const l = landSS(dt, 0.3); sx = l.sx; sy = l.sy;
            acc = spring(dt - 0.02, 3.3, 0.3);
            open = E.outBack(prog(dt, 0.02, 0.16), 2);
        }
        // unison hop on the downbeat (7.0)
        const hp = prog(t, 7.0, 7.32);
        if (hp > 0 && hp < 1) { y -= 70 * 4 * hp * (1 - hp); const f = flapSS(t - 7.0, 0.22); sx *= f.sx; sy *= f.sy; }
        if (t >= 7.32) { const l = landSS(t - 7.32, 0.2); sx *= l.sx; sy *= l.sy; }
        // choreography: look left (col wave), look right, blink wave, look up
        const c = s.c, rr_ = s.r;
        const lx = kf(t, [[7.24 + c * 0.018, 0], [7.34 + c * 0.018, -1, E.outExpo], [7.48 + (7 - c) * 0.018, -1], [7.58 + (7 - c) * 0.018, 1, E.outExpo], [7.72, 1], [7.8, 0, E.outExpo]]);
        const ly = kf(t, [[7.72, 0], [7.8, -1, E.outExpo]]);
        open *= blinkAt(t, 7.6 + (c + rr_ * 2) * 0.016, 0.12);
        // launch out of frame (7.8+), stagger from centre outward
        const lt = 7.8 + Math.abs(c - 3.5) * 0.012 + rr_ * 0.02;
        if (t > lt) {
            const d = t - lt;
            y -= 9000 * d * d + 1300 * d;
            const f = flapSS(d, 0.45); sx *= f.sx; sy *= f.sy; anchor = 0;
        }
        return { x, y, r, sx, sy, anchor, visible, acc, open, look: { x: lx, y: ly } };
    }

    function drawShotD(ctx, t, ft) {
        ctx.fillStyle = C.Wh; ctx.fillRect(0, 0, W, H);
        // counter behind everything
        const n = D.land.filter((l) => l <= t).length;
        if (n > 0) {
            const last = Math.max(...D.land.filter((l) => l <= t));
            const punch = 1 + 0.045 * wobble(t - last, 4, 10) + (n === 16 ? 0.06 * wobble(t - 6.94, 2.5, 5) : 0);
            ctx.save();
            ctx.translate(CX, 570);
            ctx.scale(punch, punch);
            font(ctx, 800, 900, FD, 'expanded', -10);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#e8e8e8';
            ctx.fillText(String(n).padStart(2, '0'), 0, 20);
            ctx.restore();
        }
        // characters
        const order = ROSTER.map((_, i) => i).sort((a, b) => D.land[b] - D.land[a]);
        for (const i of order) {
            const p = poseD(i, t);
            if (!p.visible) continue;
            if (t < 6.0 && i !== HERO_I) continue;
            if (p.y < -300) continue;
            drawCharacter(ctx, {
                x: p.x, y: p.y, r: p.r, state: ROSTER[i], sx: p.sx, sy: p.sy, anchor: p.anchor,
                ears: p.acc, tail: p.acc, blinkL: p.open, blinkR: p.open, look: p.look,
                tailAng: 0.25 * wobble(t - D.land[i] - 0.05, 2.2, 3.5),
            });
        }
        // PLAYERS
        const word = 'PLAYERS';
        font(ctx, 78, 900, FD, 'expanded', 14);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const full = ctx.measureText(word).width;
        let xx = CX - full / 2;
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 860, W, 120); ctx.clip();
        for (let i = 0; i < word.length; i++) {
            const pre = ctx.measureText(word.slice(0, i)).width;
            const p = E.outExpo(prog(t, 6.98 + i * 0.028, 7.3 + i * 0.028));
            const q = E.inCubic(prog(t, 7.84, 7.98));
            ctx.fillStyle = C.K;
            ctx.fillText(word[i], xx + pre, 955 + (1 - p) * 110 - q * 0);
        }
        ctx.restore();
        font(ctx, 17, 700, FM, 'normal', 3); ctx.textAlign = 'center';
        ctx.fillStyle = C.K; ctx.globalAlpha = prog(t, 7.1, 7.3);
        ctx.fillText(R.scramble('PER ROUND', prog(t, 7.1, 7.4), ft, 91), CX, 850);
        ctx.globalAlpha = 1;

        // the dark rises from below and takes the frame
        const top = lerp(H + 10, -10, E.inCubic(prog(t, 7.82, 8.0)));
        if (top < H) { ctx.fillStyle = C.K; ctx.fillRect(0, top, W, H - top + 10); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHOT 05 · DEVIL / ANGEL
    // ─────────────────────────────────────────────────────────────────────────
    const QUESTION = 'WHO ARE YOU TODAY?';
    for (let i = 0; i < QUESTION.length; i++) if (QUESTION[i] !== ' ') cue(8.03 + i / 60, 'type');
    cue(8.5, 'slam'); cue(9.0, 'faceoff'); cue(9.5, 'hop2'); cue(9.72, 'sweep');

    function seamE(t) {
        let x = 960 + 1500 * (1 - spring(t - 8.5, 2.3, 0.42));
        x += 80 * wobble(t - 9.0, 2.2, 5);
        x += lerp(0, 2600, E.inExpo(prog(t, 9.7, 9.96)));
        const ang = 0.2 + 0.06 * wobble(t - 9.0, 2.0, 4) - 0.12 * wobble(t - 9.5, 2.6, 5);
        return { x, ang };
    }
    function seamPoly(ctx, s, right = true) {
        const tn = Math.tan(s.ang);
        const xt = s.x - tn * CY, xb = s.x + tn * CY;
        ctx.beginPath();
        if (right) { ctx.moveTo(xt, -10); ctx.lineTo(W + 3000, -10); ctx.lineTo(W + 3000, H + 10); ctx.lineTo(xb, H + 10); }
        else { ctx.moveTo(-3000, -10); ctx.lineTo(xt, -10); ctx.lineTo(xb, H + 10); ctx.lineTo(-3000, H + 10); }
        ctx.closePath();
    }

    function drawShotE(ctx, t, ft) {
        ctx.fillStyle = C.K; ctx.fillRect(0, 0, W, H);
        const s = seamE(t);
        const split = t >= 8.5;
        const panelDX = s.x - 960;

        if (split) {
            // white (ANGEL) panel
            ctx.save(); seamPoly(ctx, s, true); ctx.fillStyle = C.Wh; ctx.fill(); ctx.restore();

            // ambient particles, clipped to their halves
            ctx.save(); seamPoly(ctx, s, false); ctx.clip();
            for (let i = 0; i < 26; i++) {
                const sd = 300 + i * 13, per = rr(sd, 1.1, 2.0);
                const ph = ((t - 8.5) / per + rnd(sd + 1)) % 1;
                const x = rr(sd + 2, 40, 900) + Math.sin(t * 3 + i) * 14, y = H + 30 - ph * (H + 80);
                const sz = rr(sd + 3, 4, 9) * (0.6 + 0.4 * Math.sin(t * 20 + i));
                ctx.fillStyle = C.Wh; ctx.globalAlpha = 0.85 * prog(t, 8.5, 8.8);
                ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
            }
            ctx.restore();
            ctx.save(); seamPoly(ctx, s, true); ctx.clip();
            for (let i = 0; i < 18; i++) {
                const sd = 700 + i * 11, per = rr(sd, 1.6, 2.6);
                const ph = ((t - 8.5) / per + rnd(sd + 1)) % 1;
                const x = rr(sd + 2, 1000, 1880) + panelDX + Math.sin(t * 2 + i) * 20, y = H + 30 - ph * (H + 80);
                ctx.globalAlpha = 0.9 * prog(t, 8.5, 8.8);
                R.polyPath(ctx, x, y, rr(sd + 3, 6, 11), 3, -Math.PI / 2 + Math.sin(t + i));
                ctx.fillStyle = C.K; ctx.fill();
            }
            ctx.restore();
            ctx.globalAlpha = 1;

            // characters
            const exit = (d) => (d > 0 ? -(12000 * d * d + 1400 * d) : 0);
            const bob = (ph) => Math.sin((t - 8.5) * 5 + ph) * 8;
            const hop = (t0) => { const p = prog(t, t0, t0 + 0.32); return -60 * 4 * p * (1 - p); };
            const dEx = t - 9.72, aEx = t - 9.76;
            // DEVIL (inverted colours) on black
            {
                const pop = spring(t - 8.5, 2.6, 0.38);
                const f = flapSS(t - 9.5, 0.25), fx = flapSS(dEx, 0.5);
                const open = lerp(1, 0.52, E.outExpo(prog(t, 9.0, 9.12))) * blinkAt(t, 9.3, 0.12);
                drawCharacter(ctx, {
                    x: 500, y: 490 + bob(0) + hop(9.5) + exit(dEx), r: 150 * lerp(0.4, 1, pop), state: DEVIL, inv: true,
                    sx: f.sx * fx.sx, sy: f.sy * fx.sy,
                    ears: spring(t - 8.56, 3, 0.3), tail: spring(t - 8.62, 2.6, 0.35),
                    tailAng: 0.35 * wobble(t - 9.0, 3, 4) + Math.sin(t * 4) * 0.06,
                    blinkL: open, blinkR: open,
                    look: { x: kf(t, [[8.5, 0.2], [9.0, 0.2], [9.1, 1, E.outExpo]]), y: kf(t, [[9.0, 0.15], [9.1, 0.25, E.outExpo], [9.72, 0.25], [9.8, -1, E.outExpo]]) },
                });
            }
            // ANGEL on white, riding the panel, wearing the Second Wind halo
            {
                const x = 1420 + panelDX, y = 490 + bob(2) + hop(9.5) + exit(aEx);
                const pulse = 1 + 0.9 * Math.exp(-6 * Math.max(0, t - 9.0)) * (t > 9.0 ? 1 : 0);
                const haloIn = E.outBack(prog(t, 8.58, 8.85), 2);
                if (haloIn > 0.01) {
                    ctx.save(); ctx.translate(x, y); ctx.scale(haloIn, haloIn); ctx.translate(-x, -y);
                    R.drawHalo(ctx, x, y, 150, t, pulse);
                    ctx.restore();
                }
                const f = flapSS(t - 9.5, 0.25), fx = flapSS(aEx, 0.5);
                const open = lerp(1, 1.12, E.outExpo(prog(t, 9.0, 9.1))) * blinkAt(t, 9.25, 0.12);
                drawCharacter(ctx, {
                    x, y, r: 150, state: ANGEL, sx: f.sx * fx.sx, sy: f.sy * fx.sy,
                    blinkL: open, blinkR: open,
                    look: { x: kf(t, [[8.5, -0.2], [9.0, -0.2], [9.1, -1, E.outExpo]]), y: kf(t, [[9.72, 0], [9.8, -1, E.outExpo]]) },
                });
            }

            // words
            const word = (w, cx, color, t0, dx) => {
                font(ctx, 124, 900, FD, 'expanded', 6);
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                const full = ctx.measureText(w).width;
                ctx.save();
                ctx.beginPath(); ctx.rect(cx - 600 + dx, 800, 1200, 140); ctx.clip();
                for (let i = 0; i < w.length; i++) {
                    const pre = ctx.measureText(w.slice(0, i)).width;
                    const p = E.outExpo(prog(t, t0 + i * 0.03, t0 + 0.34 + i * 0.03));
                    const q = E.inCubic(prog(t, 9.7 + i * 0.015, 9.86 + i * 0.015));
                    ctx.fillStyle = color;
                    ctx.fillText(w[i], cx - full / 2 + pre + dx, 912 + (1 - p) * 130 + q * 130);
                }
                ctx.restore();
            };
            word('DEVIL', 500, C.Wh, 8.56, 0);
            word('ANGEL', 1420, C.K, 8.62, panelDX);
            const sub = (txt, cx, color, t0, seed) => {
                font(ctx, 19, 700, FM, 'normal', 4); ctx.textAlign = 'center'; ctx.fillStyle = color;
                ctx.globalAlpha = 1 - prog(t, 9.7, 9.8);
                ctx.fillText(R.scramble(txt, prog(t, t0, t0 + 0.38), ft, seed), cx, 972);
                ctx.globalAlpha = 1;
            };
            sub('EVERY SOUL FOR ITSELF', 500, C.Wh, 8.72, 5);
            sub('NO SOUL LEFT BEHIND', 1420 + panelDX, C.K, 8.78, 6);
        }

        // the question (onboarding type) — with a difference blend it reads on both halves
        {
            const n = clamp(Math.floor((t - 8.03) * 60) + 1, 0, QUESTION.length);
            const mv = E.outExpo(prog(t, 8.36, 8.56));
            const sz = lerp(64, 30, mv), y = lerp(CY, 104, mv);
            ctx.save();
            ctx.globalCompositeOperation = 'difference';
            font(ctx, sz, 700, FM, 'normal', lerp(6, 5, mv));
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            const fullW = ctx.measureText(QUESTION).width;
            let shown = QUESTION.slice(0, n);
            const outP = prog(t, 9.68, 9.9);
            if (outP > 0) shown = R.scramble(QUESTION, 1 - outP, ft, 77, 0.6);
            const x0 = CX - fullW / 2;
            ctx.fillStyle = C.Wh;
            ctx.fillText(shown, x0, y);
            const typing = n < QUESTION.length;
            const cursorOn = typing || (Math.floor((t - 8.0) / 0.125) % 2 === 0);
            if (cursorOn && t < 9.68) {
                const cw = ctx.measureText(shown).width;
                ctx.fillRect(x0 + cw + sz * 0.12, y - sz * 0.5, sz * 0.55, sz);
            }
            // the onboarding "or", riding the seam
            if (split) {
                const pp = E.outBack(prog(t, 8.6, 8.8), 2) * (1 - prog(t, 9.7, 9.8));
                font(ctx, 38 * pp, 500, FM, 'normal', 2);
                ctx.textAlign = 'center';
                ctx.fillText('or', s.x, CY + 30);
            }
            ctx.restore();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHOT 06 · THE SPIKES  (deterministic physics chase)
    // ─────────────────────────────────────────────────────────────────────────
    const F = { VC: 640, R: 44, dt: 1 / 480, t0: 9.9, t1: 12.35 };
    F.camN = (t) => -F.VC * (t - 10);                               // nominal camera (bots steer by this)
    F.extra = R.integrate((t) => 9800 * E.inExpo(prog(t, 11.62, 12.0)), 11.5, 12.4);
    F.cam = (t) => F.camN(t) - F.extra(t);
    F.spikeBase = (t) => {
        let y = lerp(-20, 820, E.outExpo(prog(t, 9.98, 10.34)));
        y -= 26 * prog(t, 10.34, 11.7);
        for (const b of [10.5, 11.0, 11.5]) y -= 26 * Math.max(0, wobble(t - b, 2.2, 7));
        return y;
    };
    F.spikeScreen = (t) => F.spikeBase(t) + F.extra(t);
    F.PU = [
        { t: 10.5, who: 10, type: 'mult', label: 'MULT ×2' },
        { t: 10.75, who: 0, type: 'vacuum', label: 'VACUUM' },
        { t: 11.0, who: 13, type: 'ghost', label: 'GHOST' },
        { t: 11.25, who: HERO_I, type: 'secondWind', label: 'SECOND WIND' },
    ];
    F.DOOMED = 9;

    function simF(bonkT) {
        const N = 16, Rr = F.R, dt = F.dt;
        const steps = Math.ceil((F.t1 - F.t0) / dt) + 1;
        const X = [], Y = [], flaps = [];
        const b = [];
        for (let i = 0; i < N; i++) {
            const c = i % 8, row = Math.floor(i / 8);
            const sx = CX + (c - 3.5) * 205 + rs(i * 7 + 1) * 40;
            const sy = 250 + row * 230 + rs(i * 7 + 2) * 60;
            b.push({
                x: sx, y: F.camN(F.t0) + (sy - CY), vx: rs(i * 7 + 3) * 120, vy: -500 - rr(i * 7 + 4, 0, 300),
                target: 240 + rnd(i * 7 + 5) * 330, tx: sx, cool: 0, alive: true, stunned: false,
            });
            X.push(new Float32Array(steps)); Y.push(new Float32Array(steps)); flaps.push([]);
        }
        let death = null;
        for (let s = 0; s < steps; s++) {
            const t = F.t0 + s * dt;
            for (let i = 0; i < N; i++) { X[i][s] = b[i].x; Y[i][s] = b[i].y; }
            for (let i = 0; i < N; i++) {
                const p = b[i];
                if (!p.alive) continue;
                // wander target x every ~0.6 s
                const seg = Math.floor((t - F.t0) / 0.6);
                p.tx = clamp(CX + (i % 8 - 3.5) * 205 + rs(i * 131 + seg * 17) * 190, 120, W - 120);
                const screenY = CY + (p.y - F.camN(t));
                if (i === F.DOOMED && t >= bonkT && !p.stunned) { p.stunned = true; p.vy = 380; p.vx += 260; }
                const want = !p.stunned && screenY > p.target && p.vy > -260 && t >= p.cool;
                if (want) { p.vy = -1180; p.cool = t + 0.2; flaps[i].push(t); }
                p.vy += 2600 * dt;
                p.vx += ((p.tx - p.x) * 3.2 - p.vx * 2.2) * dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                if (p.x < 35 + Rr) { p.x = 35 + Rr; p.vx = Math.abs(p.vx); }
                if (p.x > W - 35 - Rr) { p.x = W - 35 - Rr; p.vx = -Math.abs(p.vx); }
                if (i === F.DOOMED && !death && t > 10.4 && screenY + Rr * 0.55 > F.spikeBase(t)) { death = t; p.alive = false; }
            }
            // equal-mass elastic contacts (restitution 1.0, like the game)
            for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
                const a = b[i], c = b[j];
                if (!a.alive || !c.alive) continue;
                if ((i === 13 || j === 13) && t >= 11.0) continue;   // ghost phases through
                const dx = c.x - a.x, dy = c.y - a.y, d2 = dx * dx + dy * dy, min = 2 * Rr;
                if (d2 < min * min && d2 > 1e-6) {
                    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
                    const rel = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
                    if (rel < 0) { a.vx += rel * nx; a.vy += rel * ny; c.vx -= rel * nx; c.vy -= rel * ny; }
                    const push = (min - d) / 2;
                    a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
                }
            }
        }
        return { X, Y, flaps, death, steps };
    }
    function buildF() {
        // find the bonk time that makes the doomed bot hit the spikes on beat 23 (11.5 s)
        let lo = 10.7, hi = 11.4, best = null;
        for (let it = 0; it < 22; it++) {
            const mid = (lo + hi) / 2;
            const sim = simF(mid);
            if (sim.death == null || sim.death > 11.5) hi = mid; else lo = mid;
            best = sim; best.bonk = mid;
        }
        F.sim = simF(lo); F.sim.bonk = lo;
        F.pos = (i, t) => {
            const f = (clamp(t, F.t0, F.t1) - F.t0) / F.dt;
            const s = Math.min(F.sim.steps - 2, Math.floor(f)), fr = f - s;
            return { x: lerp(F.sim.X[i][s], F.sim.X[i][s + 1], fr), y: lerp(F.sim.Y[i][s], F.sim.Y[i][s + 1], fr) };
        };
        F.lastFlap = (i, t) => { let l = -9; for (const f of F.sim.flaps[i]) if (f <= t) l = f; return l; };
        // powerups sit exactly where their collector will be
        for (const pu of F.PU) { const p = F.pos(pu.who, pu.t); pu.x = p.x; pu.y = p.y; cue(pu.t, 'powerup', { type: pu.type }); }
        // vacuum coins: a loose ring around the collector
        const v = F.PU[1];
        F.vcoins = [];
        for (let k = 0; k < 7; k++) {
            const a = (k / 7) * TAU + 0.4, d = 170 + (k % 3) * 60;
            F.vcoins.push({ x: v.x + Math.cos(a) * d, y: v.y + Math.sin(a) * d * 0.8, k, t0: 10.77 + k * 0.035, t1: 10.95 + k * 0.035 });
        }
        F.vcoins.forEach((c) => cue(c.t1, 'vcoin', { n: c.k }));
        cue(9.98, 'spikes'); cue(F.sim.bonk, 'bonk'); cue(F.sim.death || 11.5, 'death'); cue(11.62, 'whip');
    }

    function drawShotF(ctx, t, ft) {
        const camY = F.cam(t);
        const sh1 = shake(t, 22 * Math.exp(-7 * Math.max(0, t - 10.0)) * (t >= 10.0 ? 1 : 0), 11);
        const dT = F.sim.death || 11.5;
        const sh2 = shake(t, 16 * Math.exp(-9 * Math.max(0, t - dT)) * (t >= dT ? 1 : 0), 17);
        const cam = { x: CX, y: camY, z: 1, rot: 0.012 * wobble(t - 10.0, 2, 4), sx: sh1.x + sh2.x, sy: sh1.y + sh2.y };
        drawBackdrop(ctx, cam, 'soft');
        ctx.save(); camApply(ctx, cam);
        drawWalls(ctx, cam);
        // a couple of hazards drifting through the space
        R.drawHazard(ctx, 'octagon', 300, F.camN(10.6) - 380, 120, t * 0.8);
        R.drawHazard(ctx, 'heptagon', 1640, F.camN(11.2) - 420, 110, -t * 1.1);
        R.drawHazard(ctx, 'pentagon', 1250, F.camN(11.9) - 520, 100, t * 1.5);

        // powerups (before pickup) + pickup rings
        for (const pu of F.PU) {
            if (t < pu.t) {
                const pulse = 1 + 0.12 * Math.sin(t * TAU / 1.4);
                ctx.save();
                ctx.globalAlpha = pu.type === 'ghost' ? 0.55 + 0.35 * Math.sin(t * 6) : 1;
                R.drawPowerup(ctx, pu.type, pu.x, pu.y, 70 * pulse);
                ctx.restore();
            } else {
                const d = t - pu.t;
                const p = prog(d, 0, 0.15);
                if (p < 1) R.drawPowerup(ctx, pu.type, pu.x, pu.y, 70 * (1 + p), 1 - p);
                if (d < 0.7) {
                    const q = F.pos(pu.who, t);
                    R.rings(ctx, d, q.x, q.y, 1.2, 4);
                }
            }
        }
        // vacuum coins
        for (const c of F.vcoins) {
            if (t < c.t0) R.drawCoin(ctx, c.x, c.y, 20, -Math.PI / 2);
            else if (t < c.t1) {
                const q = F.pos(0, t), u = E.inCubic(prog(t, c.t0, c.t1));
                const x = lerp(c.x, q.x, u), y = lerp(c.y, q.y, u);
                R.drawCoin(ctx, x, y, 20 * (1 - 0.5 * u), -Math.PI / 2 + u * 6);
            } else if (t < c.t1 + 0.4) {
                const q = F.pos(0, c.t1);
                R.burst(ctx, t - c.t1, { x: q.x, y: q.y, n: 5, seed: 900 + c.k, speed: [200, 480], life: [0.25, 0.4], size: [10, 15], gravity: 300, shape: 'tri' });
            }
        }

        // bots
        for (let i = 0; i < 16; i++) {
            const p = F.pos(i, t);
            const isDoomed = i === F.DOOMED;
            if (isDoomed && t >= dT) continue;
            const lf = F.lastFlap(i, t);
            const f = flapSS(t - lf, 0.28);
            const puOf = (type) => F.PU.find((u) => u.type === type && u.who === i && t >= u.t);
            const mult = puOf('mult'), vac = puOf('vacuum'), gh = puOf('ghost'), sw = puOf('secondWind');
            const sy_ = CY + (p.y - camY);
            if (sy_ < -200 || sy_ > H + 200) continue;
            if (mult) R.drawMultBig(ctx, p.x, p.y, F.R, (1 + 0.2 * Math.sin(t * 1000 / 175)) * E.outBack(prog(t, mult.t, mult.t + 0.25)));
            if (sw) {
                const k = E.outBack(prog(t, sw.t, sw.t + 0.3), 2);
                ctx.save(); ctx.translate(p.x, p.y); ctx.scale(k, k); ctx.translate(-p.x, -p.y);
                R.drawHalo(ctx, p.x, p.y, F.R, t, 1);
                ctx.restore();
            }
            const stunned = isDoomed && t >= F.sim.bonk;
            const vyish = clamp((t - lf) * 2 - 0.4, -1, 1);
            drawCharacter(ctx, {
                x: p.x, y: p.y, r: F.R, state: ROSTER[i], sx: f.sx, sy: f.sy,
                alpha: gh ? 0.5 + 0.12 * Math.sin(t * 40) : 1,
                look: stunned ? { x: 0, y: 0 } : { x: Math.sin(t * 3 + i) * 0.5, y: lerp(-1, 0.6, (vyish + 1) / 2) * (i === HERO_I ? 0.5 : 1) },
                pupilRot: stunned ? (t - F.sim.bonk) * 22 : 0,
                blinkL: blinkAt(t, 10.2 + rnd(i * 3) * 1.4, 0.12), blinkR: blinkAt(t, 10.2 + rnd(i * 3) * 1.4, 0.12),
                tailAng: Math.sin(t * 9 + i) * 0.12,
            });
            if (vac) {
                const mp = (1 + 0.16 * Math.sin(t * 1000 / 175)) * E.outBack(prog(t, vac.t, vac.t + 0.25));
                ctx.save(); ctx.translate(p.x - 68 * F.R / 36, p.y); ctx.scale(0.65 * mp * F.R / 36, 0.65 * mp * F.R / 36); R.puMagnet(ctx); ctx.restore();
                ctx.save(); ctx.translate(p.x + 68 * F.R / 36, p.y); ctx.scale(-0.65 * mp * F.R / 36, 0.65 * mp * F.R / 36); R.puMagnet(ctx); ctx.restore();
            }
            // bonk stars on the doomed one
            if (isDoomed && t >= F.sim.bonk && t < F.sim.bonk + 0.5) {
                R.burst(ctx, t - F.sim.bonk, { x: p.x, y: p.y - 30, n: 8, seed: 555, speed: [300, 600], life: [0.25, 0.45], size: [10, 16], gravity: 0, shape: 'tri' });
            }
        }
        // death: shockwave + debris
        if (t >= dT && t < dT + 1.2) {
            const p = F.pos(F.DOOMED, dT);
            const d = t - dT;
            R.rings(ctx, d, p.x, p.y, 2.4, 6);
            R.burst(ctx, d, { x: p.x, y: p.y, n: 34, seed: 1234, dir: -Math.PI / 2, spread: 2.6, speed: [500, 1400], life: [0.5, 1.0], size: [10, 20], gravity: 1600, drag: 2.2 });
        }
        ctx.restore();

        // spike line — the black of the devil panel, now with teeth
        const top = F.spikeScreen(t);
        if (top < H + 200) {
            const g = (i, xc) => E.outBack(prog(t, 10.02 + Math.abs(xc - CX) / W * 0.22, 10.2 + Math.abs(xc - CX) / W * 0.22), 2.2);
            ctx.save(); ctx.translate(cam.sx * 0.5, cam.sy * 0.5);
            R.drawSpikes(ctx, top, { pitch: 84, depth: 90, grow: g, jitter: (i) => (Math.sin(t * 11 + i * 1.7) * 3 + Math.sin(t * 7 + i) * 2) });
            ctx.restore();
        }

        // powerup labels (screen space)
        for (const pu of F.PU) {
            const d = t - pu.t;
            if (d < 0 || d > 0.62) continue;
            const q = F.pos(pu.who, t);
            const sx = q.x, sy = CY + (q.y - camY);
            const pop = E.outBack(prog(d, 0, 0.16), 2.4) * (1 - E.inBack(prog(d, 0.48, 0.62)));
            font(ctx, 22, 800, FM, 'normal', 3);
            const txt = R.scramble(pu.label, prog(d, 0.02, 0.2), ft, 300 + pu.who);
            const w = ctx.measureText(pu.label).width + 28;
            const lx = sx + (sx > CX ? -w - 70 : 70), ly = sy - 70;
            ctx.save(); ctx.translate(lx + w / 2, ly); ctx.scale(pop, pop);
            ctx.fillStyle = C.K; R.roundRectPath(ctx, -w / 2, -21, w, 42, 21); ctx.fill();
            ctx.fillStyle = C.Wh; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(txt, 0, 1);
            ctx.restore();
        }

        // ALIVE counter
        {
            const alive = t >= dT ? 15 : 16;
            const a = prog(t, 10.2, 10.4) * (1 - prog(t, 11.7, 11.85));
            font(ctx, 26, 800, FM, 'normal', 5);
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            let s = `ALIVE ${alive}/16`;
            if (t >= dT && t < dT + 0.12) s = R.scramble(s, prog(t, dT, dT + 0.12), ft, 404, 0.5);
            ctx.globalAlpha = a;
            const w = ctx.measureText(`ALIVE 16/16`).width + 40;
            ctx.fillStyle = C.K; R.roundRectPath(ctx, CX - w / 2, 92, w, 48, 24); ctx.fill();
            ctx.fillStyle = C.Wh; ctx.fillText(s, CX, 117);
            ctx.globalAlpha = 1;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SHOT 07 · AGICENDS
    // ─────────────────────────────────────────────────────────────────────────
    const G = { word: 'AGICENDS', size: 230, base: 612 };
    function buildG(ctx) {
        font(ctx, G.size, 900, FD, 'ultra-expanded');
        ctx.letterSpacing = '0px';
        G.full = ctx.measureText(G.word).width;
        G.x0 = CX - G.full / 2;
        G.letters = [];
        for (let i = 0; i < G.word.length; i++) {
            const a = ctx.measureText(G.word.slice(0, i)).width;
            const b = ctx.measureText(G.word.slice(0, i + 1)).width;
            G.letters.push({ ch: G.word[i], cx: G.x0 + (a + b) / 2, w: b - a });
        }
        const mI = ctx.measureText('I');
        G.cap = mI.actualBoundingBoxAscent;
        G.iX = G.letters[2].cx;
        G.iTop = G.base - G.cap;
        for (let i = 0; i < 8; i++) cue(12.0 + i * 0.045, 'letter', { n: i });
        cue(12.0, 'logo'); cue(12.3, 'heroflap'); cue(12.93, 'land'); cue(13.02, 'tagline');
        cue(14.0, 'lurch'); cue(14.46, 'surge'); cue(14.84, 'blinkEnd');
    }
    G.camV = R.integrate((t) => 9800 * Math.exp(-11 * Math.max(0, t - 12.0)), 12.0, 15.0);

    function heroG(t) {
        const land = 12.93;
        let x, y, sx = 1, sy = 1, anchor = 100;
        const rest = { x: G.iX, y: G.iTop - 52 };
        if (t < land) {
            // launch from below, overshoot above the I, drop onto it
            const u = prog(t, 12.28, land);
            x = lerp(G.iX - 360, rest.x, E.outCubic(u));
            const yA = H + 140, yPeak = rest.y - 260;
            const tp = 0.62;
            y = u < tp ? lerp(yA, yPeak, E.outQuad(u / tp)) : lerp(yPeak, rest.y, E.inQuad((u - tp) / (1 - tp)));
            const f = flapSS(t - 12.3, 0.4); sx = f.sx; sy = f.sy; anchor = 0;
        } else {
            x = rest.x; y = rest.y;
            const l = landSS(t - land, 0.34); sx = l.sx; sy = l.sy;
        }
        // squash on the I is shared with the letter itself
        let open = 1 * blinkAt(t, 13.86, 0.12);
        if (t > 14.0) open *= lerp(1, 1.18, E.outExpo(prog(t, 14.0, 14.1)));
        if (t > 14.6) open = lerp(open, 0, E.inOutSine(prog(t, 14.8, 14.92)));
        const lx = kf(t, [[13.3, 0], [13.36, -1, E.outExpo], [13.62, -1], [13.68, 1, E.outExpo], [13.94, 1], [14.0, 0, E.outExpo]]);
        const ly = kf(t, [[12.3, -1], [12.8, -0.6], [12.95, 0.2, E.outExpo], [14.0, 0.2], [14.06, 1, E.outExpo], [14.3, 1], [14.38, 0, E.outExpo]]);
        return { x, y, sx, sy, anchor, open, look: { x: lx, y: ly } };
    }

    function drawShotG(ctx, t, ft) {
        const off = G.camV(t);   // camera still coasting up from the whip
        const cam = { x: CX, y: -off - 900, z: 1, rot: 0 };
        const push = E.inOutCubic(prog(t, 14.42, 14.95));
        const h = heroG(t);
        const z = lerp(1, 2.7, push) * (1 + 0.035 * E.inOutSine(prog(t, 12.4, 14.45)));   // end-card drift
        const sh = shake(t, 5 * Math.exp(-10 * Math.max(0, t - 12.93)) * (t > 12.93 ? 1 : 0) + 6 * prog(t, 14.45, 14.7) * (1 - prog(t, 14.75, 14.9)), 21);

        ctx.save();
        // push-in toward the hero's eyes for the ending
        ctx.translate(lerp(CX, CX, push) + sh.x, CY + sh.y);
        ctx.scale(z, z);
        ctx.translate(-lerp(CX, h.x, push), -lerp(CY, h.y, push));

        drawBackdrop(ctx, cam, t < 12.12 ? 'soft' : 'deep', 0.42 * E.inOutSine(prog(t, 12.0, 12.5)));
        drawWalls(ctx, { x: CX, y: cam.y, z: 1 });

        // letters rise out of the ground line, variable weight inflating 250→900
        const squashI = t > 12.93 ? 1 - 0.14 * Math.exp(-9 * (t - 12.93)) * Math.cos(TAU * 3.4 * (t - 12.93)) : 1;
        ctx.save();
        ctx.beginPath(); ctx.rect(-200, -1000, W + 400, G.base + 1000 + 26); ctx.clip();
        for (let i = 0; i < G.letters.length; i++) {
            const L = G.letters[i];
            const t0 = 12.0 + i * 0.045;
            const p = prog(t, t0, t0 + 0.5);
            const e = E.outBack(p, 1.3);
            const vel = p < 1 ? (1 - p) : 0;
            const wgt = lerp(250, 900, E.outCubic(p));
            const dy = (1 - e) * (G.cap + 120);
            ctx.save();
            ctx.translate(L.cx, G.base + dy);
            const syL = (1 + 0.28 * vel * vel) * (i === 2 ? squashI : 1);
            ctx.scale(1 / Math.sqrt(syL), syL);
            font(ctx, G.size, wgt, FD, 'ultra-expanded');
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = C.K;
            ctx.fillText(L.ch, 0, 0);
            ctx.restore();
        }
        ctx.restore();
        // ground rule + tagline
        const lineP = E.outExpo(prog(t, 12.98, 13.4));
        ctx.fillStyle = C.K;
        ctx.fillRect(CX - (G.full / 2) * lineP, G.base + 30, G.full * lineP, 4);
        font(ctx, 29, 800, FM, 'normal', 11);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(R.scramble('16 PLAYERS · ONE WAY UP', prog(t, 13.02, 13.5), ft, 1616), CX + 5, G.base + 96);
        font(ctx, 17, 700, FM, 'normal', 6);
        ctx.fillStyle = C.K; ctx.globalAlpha = prog(t, 13.35, 13.55);
        ctx.fillText(R.scramble('DEVILS · ANGELS · ONE CATHEDRAL', prog(t, 13.35, 13.8), ft, 1717), CX + 3, G.base + 140);
        ctx.globalAlpha = 1;

        // spikes: catch up from below, hover, lurch, then swallow the frame
        const top = kf(t, [[12.0, H + 260], [12.55, 912, E.outCubic], [14.0, 900, E.inOutSine], [14.1, 868, E.outExpo], [14.44, 886, E.inOutSine], [14.86, -500, E.inExpo]]);
        R.drawSpikes(ctx, top, { pitch: 84, depth: 90, jitter: (i) => Math.sin(t * 9 + i * 1.3) * 3 });

        // the hero, perched on the I (the dot this I never had)
        drawCharacter(ctx, {
            x: h.x, y: h.y, r: 52, state: HERO, sx: h.sx, sy: h.sy, anchor: h.anchor,
            blinkL: h.open, blinkR: h.open, look: h.look,
        });
        if (t >= 12.3 && t < 12.9) {
            const d = t - 12.3;
            R.burst(ctx, d, { x: G.iX - 360, y: H + 60, n: 10, seed: 88, dir: Math.PI / 2, spread: 1.8, speed: [200, 500], life: [0.3, 0.5], size: [8, 12], gravity: 200 });
        }
        ctx.restore();

        // final blackout after the eyes shut
        if (t > 14.9) { ctx.fillStyle = C.K; ctx.fillRect(0, 0, W, H); }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HUD — reel chrome, difference-blended so it reads on black and white
    // ─────────────────────────────────────────────────────────────────────────
    const CHAPTERS = [
        [0.0, '01', 'AWAKEN'], [2.0, '02', 'ASCEND'], [4.0, '03', 'GEOMETRY'], [6.0, '04', 'SIXTEEN'],
        [8.0, '05', 'DEVIL / ANGEL'], [10.0, '06', 'THE SPIKES'], [12.0, '07', 'AGICENDS'],
    ];
    function drawHUD(ctx, ft) {
        const a = prog(ft, 0.3, 0.5) * (1 - prog(ft, 14.4, 14.6));
        if (a <= 0) return;
        const on = prog(ft, 0.3, 0.75), off = prog(ft, 14.4, 14.6);
        ctx.save();
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = C.Wh; ctx.strokeStyle = C.Wh;
        const m = 44;
        // crop marks
        ctx.lineWidth = 2;
        const L = 26 * E.outCubic(on) * (1 - off);
        for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
            ctx.beginPath(); ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y); ctx.stroke();
        }
        font(ctx, 16, 700, FM, 'normal', 3);
        ctx.textBaseline = 'middle';
        const sp = (s, seed) => (on < 1 || off > 0 ? R.scramble(s, off > 0 ? 1 - off : on, ft, seed) : s);
        ctx.textAlign = 'left';
        ctx.fillText(sp('AGICENDS', 1), m + 40, m + 12);
        font(ctx, 16, 500, FM, 'normal', 3);
        ctx.fillText(sp('SHOWREEL · MMXXVI', 2), m + 40 + 128, m + 12);
        // timecode
        const f = Math.floor(ft * 60 + 1e-6);
        const tc = `00:00:${String(Math.floor(f / 60)).padStart(2, '0')}:${String(f % 60).padStart(2, '0')}`;
        ctx.textAlign = 'right';
        font(ctx, 16, 700, FM, 'normal', 3);
        ctx.fillText(sp(tc, 3), W - m - 40, m + 12);
        // chapter
        let ci = 0; for (let i = 0; i < CHAPTERS.length; i++) if (ft >= CHAPTERS[i][0]) ci = i;
        const [c0, num, name] = CHAPTERS[ci];
        const cp = prog(ft, c0, c0 + 0.28);
        ctx.textAlign = 'left';
        font(ctx, 16, 700, FM, 'normal', 3);
        ctx.fillText(sp(num + ' / 07', 4), m + 40, H - m - 12);
        font(ctx, 16, 500, FM, 'normal', 3);
        ctx.fillText(sp(R.scramble(name, ci === 0 ? 1 : cp, ft, 9 + ci), 5), m + 40 + 116, H - m - 12);
        // beat meter: four cells per bar
        const beat = Math.floor(ft / 0.5 + 1e-6);
        const inBeat = (ft / 0.5) - beat;
        for (let i = 0; i < 4; i++) {
            const x = W - m - 40 - (3 - i) * 22 - 120, y = H - m - 12;
            const act = beat % 4 === i;
            const s = act ? 10 + 6 * (1 - inBeat) : 10;
            if (act) ctx.fillRect(x - s / 2, y - s / 2, s, s);
            else { ctx.lineWidth = 1.5; ctx.strokeRect(x - 4.5, y - 4.5, 9, 9); }
        }
        ctx.textAlign = 'right';
        ctx.fillText(sp('120 BPM', 6), W - m - 40, H - m - 12);
        ctx.restore();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // master
    // ─────────────────────────────────────────────────────────────────────────
    function drawScene(ctx, t, ft) {
        ctx.save();
        if (t < 4.0) drawShotAB(ctx, t, ft);
        else if (t < 6.0) drawShotC(ctx, t, ft);
        else if (t < 8.0) drawShotD(ctx, t, ft);
        else if (t < 10.0) drawShotE(ctx, t, ft);
        else if (t < 12.0) drawShotF(ctx, t, ft);
        else drawShotG(ctx, t, ft);
        ctx.restore();

        // inversion wipes (difference circles) + impact frames
        ctx.save();
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = C.Wh;
        for (const w0 of [5.0, 5.5]) {
            const p = prog(t, w0, w0 + 0.15);
            if (p > 0 && t < 6.0) { ctx.beginPath(); ctx.arc(CX, CY, 1250 * E.outCubic(p), 0, TAU); ctx.fill(); }
        }
        const dT = (F.sim && F.sim.death) || 11.5;
        for (const f0 of [8.5, 10.0, dT]) {
            if (ft >= f0 - 1e-6 && ft < f0 + 2 / 60 - 1e-6) ctx.fillRect(0, 0, W, H);
        }
        ctx.restore();
    }

    function build(ctx) {
        buildTiles();
        buildAB();
        buildD();
        buildF();
        buildG(ctx);
        CUES.sort((a, b) => a.t - b.t);
        return CUES;
    }

    global.ReelScenes = { build, drawScene, drawHUD, CUES, DUR: 15 };
})(window);
