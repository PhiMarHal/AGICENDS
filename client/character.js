/* =============================================================================
 * AGICENDS · character.js
 * -----------------------------------------------------------------------------
 * Single source of truth for the flying-creature's appearance, shared by both
 * the in-game renderer and the standalone creator UI. Exposes `window.Character`
 * (also assigned to module.exports if a CommonJS environment is detected).
 *
 * Public API
 *   Character.DEFAULT_STATE                 → the default 5-part appearance
 *   Character.CATEGORIES                    → [{key,label}, …] in picker order
 *   Character.PARTS                         → the raw catalog (read-only use)
 *   Character.validate(state)               → clamp any object to known IDs
 *   Character.buildCharacterSVG(state,layer)→ SVG markup string
 *        layer: 'full'  (default) — body + pattern + ears + tail + eyes + pupils
 *               'body'            — everything EXCEPT pupils (eye-whites baked in)
 *               'pupil'           — a single pupil centred in a small viewBox
 *   Character.openCreator({initial,onSave,onClose})
 *        Mounts the full creator UI in a Shadow DOM overlay. onSave(appearance)
 *        fires with a validated 5-string object; onClose() fires on cancel/Esc.
 *        Returns { close() } so the caller can dismiss it programmatically.
 *
 * An appearance is a plain object: { body, eyes, pupils, ears, tail } — five
 * short strings, each an ID from the matching PARTS category.
 * ===========================================================================*/
(function (global) {
    'use strict';

    // ── shared core (lifted verbatim from the character lab) ────────────────────
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
    function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
    function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
    function easeOutElastic(t) {
        if (t === 0 || t === 1) return t;
        const c4 = (2 * Math.PI) / 3;
        return Math.pow(2, -8 * t) * Math.sin((t * 8 - 0.75) * c4) + 1;
    }

    function starPath(cx, cy, outerR, innerR, points) {
        let path = '';
        for (let i = 0; i < points * 2; i++) {
            const r = i % 2 === 0 ? outerR : innerR;
            const ang = (i * Math.PI) / points - Math.PI / 2;
            const x = cx + Math.cos(ang) * r;
            const y = cy + Math.sin(ang) * r;
            path += (i === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
        }
        return path + 'Z';
    }

    function heartPath(cx, cy, size) {
        const s = size;
        return `M ${cx} ${cy + s * 0.75}
              C ${cx - s * 1.5} ${cy - s * 0.05}, ${cx - s * 0.55} ${cy - s * 1.1}, ${cx} ${cy - s * 0.2}
              C ${cx + s * 0.55} ${cy - s * 1.1}, ${cx + s * 1.5} ${cy - s * 0.05}, ${cx} ${cy + s * 0.75} Z`;
    }

    function spiralPath(cx, cy, maxR) {
        let path = `M ${cx.toFixed(2)} ${cy.toFixed(2)}`;
        const turns = 2.2;
        const steps = 36;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const ang = t * turns * Math.PI * 2;
            const r = t * maxR;
            const x = cx + Math.cos(ang) * r;
            const y = cy + Math.sin(ang) * r;
            path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
        }
        return path;
    }

    // ---- catalog ---------------------------------------------------------------
    const STROKE = 3;
    const BODY_R = 100;
    const EYE_CX = 67;   // |x| offset of each eye from body center (game ratio: 24/36)
    const EYE_CY = -7;   // y offset (game ratio: -4/36 scaled)
    // (Game body effective radius ≈ 36, eye position ±24, eye 42×29 → here we
    //  multiply by 100/36 ≈ 2.78 to get matching ratios in viewBox units.)

    const PARTS = {
        // Body patterns live INSIDE the body, clipped to the body interior.
        // Because the eyes are huge and cover most of the upper half, patterns
        // sit mainly in the lower bowl + top cap, where they remain visible.
        body: [
            { id: 'solid', name: 'SOLID', pattern: '' },
            {
                id: 'spots', name: 'SPOTS',
                pattern: `
            <circle cx="-50" cy="55" r="22" fill="#fff"/>
            <circle cx="42"  cy="68" r="18" fill="#fff"/>
            <circle cx="-12" cy="78" r="11" fill="#fff"/>
            <circle cx="78"  cy="40" r="9"  fill="#fff"/>
            <circle cx="-78" cy="32" r="13" fill="#fff"/>
            <circle cx="22"  cy="40" r="8"  fill="#fff"/>
            <circle cx="-22" cy="-88" r="6" fill="#fff"/>
          `
            },
            {
                id: 'stripes', name: 'STRIPES',
                pattern: `
            <rect x="-90" y="-110" width="22" height="220" fill="#fff"/>
            <rect x="-44" y="-110" width="22" height="220" fill="#fff"/>
            <rect x="2"   y="-110" width="22" height="220" fill="#fff"/>
            <rect x="48"  y="-110" width="22" height="220" fill="#fff"/>
          `
            },
            {
                id: 'half', name: 'HALF',
                pattern: `<rect x="0" y="-110" width="120" height="220" fill="#fff"/>`
            },
            {
                id: 'check', name: 'CHECKERS',
                pattern: `
            <rect x="0"    y="-110" width="120" height="110" fill="#fff"/>
            <rect x="-120" y="0"    width="120" height="110" fill="#fff"/>
          `
            },
            {
                id: 'star', name: 'STAR',
                pattern: `<path d="${starPath(0, 55, 36, 14, 5)}" fill="#fff"/>`
            },
            {
                id: 'crescent', name: 'CRESCENT',
                pattern: `
            <circle cx="-16" cy="0"  r="52" fill="#fff"/>
            <circle cx="6"   cy="-6" r="44" fill="#000"/>
          `
            },
        ],

        // Eye whites — proportions matched to the game. render() returns one eye.
        // Pupils are sized proportionally to their host eye. pupilMax is the clamp
        // for the *additional* pupil offset inside the eye whites.
        eyes: [
            {
                id: 'cat', name: 'CAT',
                render: (cx, cy) =>
                    `<ellipse cx="${cx}" cy="${cy}" rx="58" ry="40" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>`,
                pupilMax: { x: 22, y: 13 }
            },
            {
                id: 'round', name: 'ROUND',
                render: (cx, cy) =>
                    `<circle cx="${cx}" cy="${cy}" r="44" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>`,
                pupilMax: { x: 20, y: 20 }
            },
            {
                id: 'wide', name: 'WIDE',
                render: (cx, cy) =>
                    `<circle cx="${cx}" cy="${cy}" r="55" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>`,
                pupilMax: { x: 28, y: 28 }
            },
            {
                id: 'almond', name: 'ALMOND',
                render: (cx, cy, mirror) =>
                    `<ellipse cx="${cx}" cy="${cy}" rx="55" ry="32" fill="#fff" stroke="#000" stroke-width="${STROKE}" transform="rotate(${mirror ? -12 : 12} ${cx} ${cy})"/>`,
                pupilMax: { x: 20, y: 12 }
            },
            {
                id: 'droopy', name: 'DROOPY',
                // Vertical-reverse of ALMOND, with a more dramatic tilt — outer corners
                // sweep downward like sleepy/sad eyes.
                render: (cx, cy, mirror) =>
                    `<ellipse cx="${cx}" cy="${cy}" rx="58" ry="28" fill="#fff" stroke="#000" stroke-width="${STROKE}" transform="rotate(${mirror ? 20 : -20} ${cx} ${cy})"/>`,
                pupilMax: { x: 20, y: 8 }
            },
            {
                id: 'squint', name: 'SQUINT',
                render: (cx, cy) =>
                    `<ellipse cx="${cx}" cy="${cy}" rx="55" ry="16" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>`,
                pupilMax: { x: 20, y: 3 }
            },
            {
                id: 'diamond', name: 'DIAMOND',
                render: (cx, cy) =>
                    `<polygon points="${cx - 52},${cy} ${cx},${cy - 36} ${cx + 52},${cy} ${cx},${cy + 36}" fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>`,
                pupilMax: { x: 20, y: 14 }
            },
            {
                id: 'oval-tall', name: 'OVAL',
                render: (cx, cy) =>
                    `<ellipse cx="${cx}" cy="${cy}" rx="36" ry="48" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>`,
                pupilMax: { x: 14, y: 22 }
            },
        ],

        // Pupils render at (0,0); the parent <g>'s translate sets position so the
        // per-frame tick() can update offsets cheaply. Sizes follow the game's
        // pupil:eye ratio (slit ≈ 16% wide × 68% tall).
        pupils: [
            { id: 'slit', name: 'SLIT', render: (cx, cy) => `<rect x="${cx - 8}" y="${cy - 26}" width="16" height="52" fill="#000" rx="3"/>` },
            { id: 'dot', name: 'DOT', render: (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="10" fill="#000"/>` },
            { id: 'dot-big', name: 'BIG DOT', render: (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="24" fill="#000"/>` },
            { id: 'heart', name: 'HEART', render: (cx, cy) => `<path d="${heartPath(cx, cy - 3, 22)}" fill="#000"/>` },
            { id: 'star', name: 'STAR', render: (cx, cy) => `<path d="${starPath(cx, cy, 21, 9, 5)}" fill="#000"/>` },
            { id: 'cross', name: 'CROSS', render: (cx, cy) => `<path d="M ${cx - 19} ${cy - 6} h 13 v -13 h 13 v 13 h 13 v 13 h -13 v 13 h -13 v -13 h -13 z" fill="#000"/>` },
            { id: 'diamond', name: 'DIAMOND', render: (cx, cy) => `<polygon points="${cx - 14},${cy} ${cx},${cy - 21} ${cx + 14},${cy} ${cx},${cy + 21}" fill="#000"/>` },
            { id: 'spiral', name: 'SPIRAL', render: (cx, cy) => `<path d="${spiralPath(cx, cy, 22)}" fill="none" stroke="#000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` },
            { id: 'none', name: 'BLANK', render: () => '' },
        ],

        // Ears render BEHIND the body so the attachment is hidden by the body's
        // fill. The body silhouette stays clean; visible portions of each ear sit
        // above the head as line-art (white interior blends with the white stage,
        // black outline carries the shape). Inner-ear details show where they
        // poke above the body's outline.
        ears: [
            { id: 'none', name: 'NONE', render: () => '' },
            {
                id: 'cat', name: 'CAT',
                // The base is a chord of the body circle tilted ~30° so it tucks
                // UNDER the body's curve (both base corners on/inside the perimeter)
                // instead of sticking out past it. Only the two sides + apex show.
                render: () => `
            <polygon points="-85,-50 -100,-118 -35,-79" fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <polygon points="85,-50 100,-118 35,-79" fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <polygon points="-80,-63 -89,-104 -50,-80" fill="#000"/>
            <polygon points="80,-63 89,-104 50,-80" fill="#000"/>
          `
            },
            {
                id: 'bear', name: 'BEAR',
                // Small round ears that overlap the body slightly — the bottom edge
                // is hidden by the body's fill so they read as domes attached to
                // the head. No inner detail (with behind-body rendering it would
                // dominate and look like a second pair of eyes peering over).
                render: () => `
            <circle cx="-58" cy="-100" r="24" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>
            <circle cx="58"  cy="-100" r="24" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>
          `
            },
            {
                id: 'floppy', name: 'FLOPPY',
                // Bigger flaps attached higher up (around the upper-side / eye level)
                // so they hang from the head rather than dangling low under it.
                render: () => `
            <path d="M -74 -60 Q -152 -48 -148 20 Q -144 50 -116 46 Q -94 28 -86 -16 Q -78 -48 -74 -60 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <path d="M  74 -60 Q  152 -48  148 20 Q  144 50  116 46 Q  94 28  86 -16 Q  78 -48  74 -60 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
          `
            },
            {
                id: 'bunny', name: 'BUNNY',
                // Taller, wider — reach near the top of the viewBox.
                render: () => `
            <path d="M -60 -74 Q -70 -154 -36 -158 Q -14 -150 -28 -74 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <path d="M  60 -74 Q  70 -154  36 -158 Q  14 -150  28 -74 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <path d="M -52 -80 Q -58 -140 -40 -146 Q -28 -140 -36 -80 Z" fill="#000"/>
            <path d="M  52 -80 Q  58 -140  40 -146 Q  28 -140  36 -80 Z" fill="#000"/>
          `
            },
            {
                id: 'devil', name: 'HORNS',
                // Like the cat ear, the base is a ~30°-tilted chord of the body
                // circle so it tucks under the curve. Curved horn sweeps out and up
                // to a sharp tip.
                render: () => `
            <path d="M -82 -54 Q -118 -84 -100 -134 Q -78 -104 -38 -80 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <path d="M  82 -54 Q  118 -84  100 -134 Q  78 -104  38 -80 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
          `
            },
            {
                id: 'elf', name: 'ELF',
                // Pointed leaf shapes with an inner ridge line (the concha fold) so
                // they read as distinctly elf/fae ears rather than plain points.
                render: () => `
            <path d="M -84 -32 Q -148 -68 -118 -100 Q -82 -82 -74 -36 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <path d="M  84 -32 Q  148 -68  118 -100 Q  82 -82  74 -36 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
            <path d="M -90 -54 Q -120 -76 -112 -96" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M  90 -54 Q  120 -76  112 -96" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
          `
            },
        ],

        // Tails render BEHIND the body so the attachment is hidden. To break
        // the all-right-side monotony, some tails are mirrored onto the LEFT via
        // a scale(-1, 1) wrapper. Designs that read directionally (the spike row
        // tapering toward its tip, the pitchfork prongs, etc.) work either side.
        tail: [
            { id: 'none', name: 'NONE', render: () => '' },
            {
                id: 'cat', name: 'CAT',
                // Clean tapering S-curve. Right side.
                render: () => `
            <path d="M 70 72
                     C 134 86 162 30 148 -22
                     C 138 -44 110 -36 102 -14
                     C 98 4 90 22 80 72 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
          `
            },
            {
                id: 'straight', name: 'STRAIGHT',
                // Anchored on the lower-back of the body so a wide visible base
                // sits along the body's lower-right perimeter. Sweeps up and out
                // to a sharp tip — reads as a clear tapering "tail" shape.
                render: () => `
            <path d="M 50 70
                     C 110 60 156 4 162 -32
                     Q 172 -48 154 -42
                     C 134 -32 100 -6 70 22
                     C 46 38 38 56 50 70 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
          `
            },
            {
                id: 'fox', name: 'FOX',
                // Bushy egg. Mirrored to the LEFT side for variety.
                render: () => `
            <g transform="scale(-1 1)">
              <path d="M 70 76 Q 96 90 136 80 Q 174 64 168 20 Q 158 -22 124 -12 Q 100 -2 88 28 Q 78 52 70 76 Z"
                    fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
              <path d="M 148 -2 Q 160 8 156 26" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M 132 -4 Q 140 6 134 22" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round"/>
            </g>
          `
            },
            {
                id: 'devil', name: 'FORK',
                // Jagged the full length — a bold zigzag "lightning bolt" drawn as a
                // double-stroked tube (black outer + white inner, like CURL) with
                // sharp mitered corners so every bend is a hard jagged point.
                render: () => {
                    const d = 'M 84 52 L 134 44 L 120 18 L 150 2 L 134 -26 L 150 -50';
                    return `
              <path d="${d}" fill="none" stroke="#000" stroke-width="20" stroke-linejoin="miter" stroke-miterlimit="3" stroke-linecap="round"/>
              <path d="${d}" fill="none" stroke="#fff" stroke-width="13" stroke-linejoin="miter" stroke-miterlimit="3" stroke-linecap="round"/>
            `;
                }
            },
            {
                id: 'puff', name: 'PEARLS',
                // Chain of overlapping circles, growing toward a big puff at the tip.
                // Mirrored to the LEFT to vary the silhouette side.
                render: () => `
            <g transform="scale(-1 1)">
              <circle cx="80"  cy="80" r="8"  fill="#fff" stroke="#000" stroke-width="${STROKE}"/>
              <circle cx="94"  cy="74" r="12" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>
              <circle cx="114" cy="66" r="16" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>
              <circle cx="138" cy="56" r="22" fill="#fff" stroke="#000" stroke-width="${STROKE}"/>
            </g>
          `
            },
            {
                id: 'lizard', name: 'SPIKES',
                // Dragon/stegosaurus tail — curved baseline along the bottom, spike
                // peaks along the top edge, tapering from tip back to body.
                render: () => `
            <path d="M 70 88
                     C 110 102 148 90 162 38
                     L 158 28
                     L 146 -4
                     L 138 30
                     L 124 0
                     L 116 30
                     L 102 6
                     L 94 32
                     L 80 14
                     L 72 32
                     L 68 22
                     C 56 56 62 76 70 88 Z"
                  fill="#fff" stroke="#000" stroke-width="${STROKE}" stroke-linejoin="round"/>
          `
            },
            {
                id: 'curl', name: 'CURL',
                // Spiral via double-stroke (black outer + white inner). Mirrored LEFT.
                render: () => {
                    const d = `M 70 76
                       C 130 92 158 50 156 6
                       C 154 -36 116 -50 96 -28
                       C 80 -10 96 6 112 -2
                       C 124 -8 124 -22 112 -22
                       C 104 -22 102 -14 108 -10
                       C 114 -8 116 -16 110 -16`;
                    return `
              <g transform="scale(-1 1)">
                <path d="${d}" fill="none" stroke="#000" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="${d}" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
              </g>
            `;
                }
            },
        ],
    };

    // ── public data ─────────────────────────────────────────────────────────────
    const DEFAULT_STATE = { body: 'solid', eyes: 'cat', pupils: 'slit', ears: 'none', tail: 'none' };

    const CATEGORIES = [
        { key: 'body', label: 'BODY' },
        { key: 'eyes', label: 'EYES' },
        { key: 'pupils', label: 'PUPILS' },
        { key: 'ears', label: 'EARS' },
        { key: 'tail', label: 'TAIL' },
    ];

    const VIEWBOX = '-160 -160 320 320';
    const SVG_NS = 'http://www.w3.org/2000/svg';

    // Monotonic id so multiple inline SVGs on one page never share a clipPath id.
    let _clipSeq = 0;

    // ── validate ────────────────────────────────────────────────────────────────
    // Returns a brand-new object containing only known catalog IDs. Anything
    // missing or unrecognised falls back to the default for that category. Use
    // this on ANY appearance that came from outside (network, storage, the lab)
    // before rendering or trusting it.
    function validate(stateIn) {
        const src = (stateIn && typeof stateIn === 'object') ? stateIn : {};
        const out = {};
        for (const cat of CATEGORIES) {
            const arr = PARTS[cat.key];
            const want = src[cat.key];
            out[cat.key] = arr.some(p => p.id === want) ? want : DEFAULT_STATE[cat.key];
        }
        return out;
    }

    function partFor(category, state) {
        return PARTS[category].find(p => p.id === state[category]);
    }

    // ── buildCharacterSVG ───────────────────────────────────────────────────────
    // Static render (no animation, no ids needed). Used for the profile preview
    // ('full') and the in-game textures ('body' for the baked sprite, 'pupil' for
    // the separate moving pupil sprite).
    function buildCharacterSVG(stateIn, layer) {
        const state = validate(stateIn);
        layer = layer || 'full';

        const pupilsPart = partFor('pupils', state);

        // A single centred pupil in a compact viewBox — for the game's pupil sprite.
        if (layer === 'pupil') {
            return `<svg viewBox="-40 -40 80 80" xmlns="${SVG_NS}">${pupilsPart.render(0, 0)}</svg>`;
        }

        const bodyPart = partFor('body', state);
        const eyesPart = partFor('eyes', state);
        const earsPart = partFor('ears', state);
        const tailPart = partFor('tail', state);

        const clipId = 'cc-clip-' + (_clipSeq++);
        const overlayL = eyesPart.overlay ? eyesPart.overlay(-EYE_CX, EYE_CY, false) : '';
        const overlayR = eyesPart.overlay ? eyesPart.overlay(EYE_CX, EYE_CY, true) : '';

        // Render order (back → front): tail → ears → body → eye-whites → pupils.
        let inner =
            `<defs><clipPath id="${clipId}"><circle cx="0" cy="0" r="${BODY_R - 0.5}"/></clipPath></defs>` +
            `<g>${tailPart.render()}</g>` +
            `<g>${earsPart.render()}</g>` +
            `<circle cx="0" cy="0" r="${BODY_R}" fill="#000"/>` +
            `<g clip-path="url(#${clipId})">${bodyPart.pattern}</g>` +
            `<circle cx="0" cy="0" r="${BODY_R}" fill="none" stroke="#000" stroke-width="${STROKE}"/>` +
            eyesPart.render(-EYE_CX, EYE_CY, false) +
            eyesPart.render(EYE_CX, EYE_CY, true);

        if (layer !== 'body') {
            inner +=
                `<g transform="translate(${-EYE_CX} ${EYE_CY})">${pupilsPart.render(0, 0)}</g>` +
                `<g transform="translate(${EYE_CX} ${EYE_CY})">${pupilsPart.render(0, 0)}</g>` +
                overlayL + overlayR;
        }

        return `<svg viewBox="${VIEWBOX}" xmlns="${SVG_NS}">${inner}</svg>`;
    }

    // ── openCreator ─────────────────────────────────────────────────────────────
    // Mounts the creator as a full-screen overlay in a Shadow DOM root so its
    // styles are fully isolated from the host page (and vice-versa). The only
    // thing that intentionally crosses the boundary is the web font, loaded once
    // at document level.

    const FONT_HREF = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap';
    function ensureFont() {
        if (typeof document === 'undefined') return;
        if (document.querySelector('link[data-character-font]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = FONT_HREF;
        link.setAttribute('data-character-font', '');
        document.head.appendChild(link);
    }

    const CREATOR_CSS = `
    :host {
      --bg: #0a0a0a; --fg: #f1f1f1; --dim: #525252; --dim2: #8a8a8a;
      --line: #222; --line-hi: #383838; --stage-bg: #ffffff; --accent: #fff;
      position: fixed; inset: 0; z-index: 2147483600;
      display: flex; align-items: flex-start; justify-content: center;
      background: #060606;
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--fg); -webkit-tap-highlight-color: transparent;
      overscroll-behavior: contain;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .cc-scroll {
      width: 100%; max-height: 100%; overflow-y: auto;
      display: flex; flex-direction: column; align-items: center;
      padding: 26px 18px 40px; user-select: none;
    }
    .cc-head { text-align: center; margin-bottom: 18px; }
    .cc-head h1 { font-size: 16px; font-weight: 700; letter-spacing: 0.4em; padding-left: 0.4em; }
    .cc-head .sub { font-size: 9px; color: var(--dim2); margin-top: 8px; letter-spacing: 0.36em; }
    .cc-portrait { position: relative; padding: clamp(20px, 6vw, 34px); margin-bottom: 6px; }
    .cc-marquee { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 4; overflow: visible; }
    .cc-marquee text { fill: var(--fg); font-family: inherit; font-size: 16px; font-weight: 700; letter-spacing: 0.16em; }
    .cc-stage-wrap { position: relative; width: min(340px, 74vw); aspect-ratio: 1; }
    .cc-stage { position: absolute; inset: 0; background: var(--stage-bg); cursor: pointer; overflow: hidden; }
    .cc-stage svg { position: relative; z-index: 1; width: 100%; height: 100%; display: block; }
    .cc-floor { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%);
      width: 58%; height: 16px; border-radius: 50%; z-index: 0;
      background: radial-gradient(ellipse, rgba(0,0,0,0.13), transparent 70%); pointer-events: none; }
    .cc-bracket { position: absolute; width: 13px; height: 13px; border: 1px solid var(--dim); pointer-events: none; z-index: 2; }
    .cc-bracket.tl { top:-1px; left:-1px; border-right:none; border-bottom:none; }
    .cc-bracket.tr { top:-1px; right:-1px; border-left:none; border-bottom:none; }
    .cc-bracket.bl { bottom:-1px; left:-1px; border-right:none; border-top:none; }
    .cc-bracket.br { bottom:-1px; right:-1px; border-left:none; border-top:none; }
    .cc-helper { font-size: 9px; color: var(--dim2); letter-spacing: 0.3em; margin: 6px 0 18px; text-align: center; }
    .cc-controls { width: min(440px, 100%); display: flex; flex-direction: column; }
    .cc-row { display: grid; grid-template-columns: 78px 1fr 56px; align-items: stretch; height: 42px; border-top: 1px solid var(--line); }
    .cc-row:last-child { border-bottom: 1px solid var(--line); }
    .cc-row .lbl { display: flex; align-items: center; padding-left: 4px; font-size: 10px; letter-spacing: 0.3em; color: var(--dim2); }
    .cc-pick { display: grid; grid-template-columns: 38px 1fr 38px; align-items: stretch; height: 100%; }
    .cc-pick .arrow { background: transparent; border: none; color: var(--dim2); cursor: pointer; font: inherit; font-size: 16px;
      display: flex; align-items: center; justify-content: center; transition: color .12s, background .12s; }
    .cc-pick .arrow:hover { color: var(--accent); background: var(--line); }
    .cc-pick .arrow:active { background: var(--fg); color: var(--bg); }
    .cc-val { display: flex; align-items: center; justify-content: center; font-size: 12.5px; font-weight: 500; letter-spacing: 0.18em; transition: opacity .15s; }
    .cc-val.changing { opacity: 0.35; }
    .cc-idx { display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; }
    .cc-actions { display: flex; gap: 8px; margin-top: 22px; flex-wrap: wrap; justify-content: center; }
    .cc-actions button { background: transparent; border: 1px solid var(--line-hi); color: var(--fg); font: inherit; font-size: 11px;
      letter-spacing: 0.26em; padding: 12px 20px; cursor: pointer; transition: all .15s; }
    .cc-actions button:hover { background: var(--fg); color: var(--bg); border-color: var(--fg); }
    .cc-actions button:active { transform: translateY(1px); }
    .cc-actions button.primary { border-color: var(--fg); }
    @media (max-width: 480px) {
      .cc-row { grid-template-columns: 66px 1fr 50px; height: 40px; }
      .cc-row .lbl { font-size: 9.5px; letter-spacing: 0.24em; }
      .cc-val { font-size: 11.5px; letter-spacing: 0.14em; }
      .cc-actions button { padding: 11px 15px; font-size: 10.5px; letter-spacing: 0.22em; }
    }
    `;

    const CREATOR_HTML = `
    <style>${CREATOR_CSS}</style>
    <div class="cc-scroll">
      <div class="cc-head">
        <div class="sub">&nbsp;</div>
      </div>
      <div class="cc-portrait">
        <svg class="cc-marquee" xmlns="${SVG_NS}" viewBox="0 0 400 400" aria-hidden="true">
          <text></text><text></text><text></text><text></text>
        </svg>
        <div class="cc-stage-wrap">
          <span class="cc-bracket tl"></span><span class="cc-bracket tr"></span>
          <span class="cc-bracket bl"></span><span class="cc-bracket br"></span>
          <div class="cc-stage">
            <div class="cc-floor"></div>
            <svg viewBox="${VIEWBOX}" xmlns="${SVG_NS}" preserveAspectRatio="xMidYMid meet">
              <g id="cc-char-group"></g>
            </svg>
          </div>
        </div>
      </div>
      <div class="cc-helper">&nbsp;</div>
      <div class="cc-controls"></div>
      <div class="cc-actions">
        <button class="cc-save primary">SAVE</button>
        <button class="cc-random">RANDOMIZE</button>
        <button class="cc-cancel">CANCEL</button>
      </div>
    </div>
    `;

    function openCreator(opts) {
        opts = opts || {};
        const onSave = typeof opts.onSave === 'function' ? opts.onSave : function () { };
        const onClose = typeof opts.onClose === 'function' ? opts.onClose : function () { };

        ensureFont();

        // Local, isolated copy of the appearance — the caller's object is untouched
        // until they accept the result via onSave.
        const state = validate(opts.initial);

        const host = document.createElement('div');
        host.setAttribute('data-character-creator', '');
        const sroot = host.attachShadow({ mode: 'open' });
        sroot.innerHTML = CREATOR_HTML;
        document.body.appendChild(host);

        const sel = (s) => sroot.querySelector(s);
        const stageEl = sel('.cc-stage');

        // ---- frame text (one static label per side of the portrait) -------------
        const MARQUEE_TEXT = '· SHAPE YOUR SELF ·';
        const MARQUEE_FONT = 16;
        const portraitEl = sel('.cc-portrait');
        const marqueeSvg = sel('.cc-marquee');
        const wrapEl = sel('.cc-stage-wrap');
        const marqueeTexts = marqueeSvg ? Array.from(marqueeSvg.querySelectorAll('text')) : [];

        // Centre a label on each edge, each rotated the natural way for its side:
        // top and bottom read left-to-right, the right side reads downwards and
        // the left side upwards, so every one is right-way-up from its own edge.
        function buildMarquee() {
            if (!portraitEl || !marqueeSvg || marqueeTexts.length !== 4) return;
            const r = portraitEl.getBoundingClientRect();
            const w = Math.round(r.width), h = Math.round(r.height);
            if (!w || !h) return;
            const innerW = wrapEl ? wrapEl.getBoundingClientRect().width : w;
            const band = Math.max(14, (w - innerW) / 2);   // padding band around the stage
            const c = band / 2;                             // its centre line
            marqueeSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
            const place = [
                { x: w / 2, y: c, rot: 0 },    // top
                { x: w - c, y: h / 2, rot: 90 },   // right, reading down
                { x: w / 2, y: h - c, rot: 0 },    // bottom
                { x: c, y: h / 2, rot: -90 },  // left, reading up
            ];
            marqueeTexts.forEach((t, i) => {
                const p = place[i];
                t.textContent = MARQUEE_TEXT;
                t.setAttribute('text-anchor', 'middle');
                t.setAttribute('dominant-baseline', 'central');
                t.setAttribute('font-size', MARQUEE_FONT);
                t.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${p.rot})`);
            });
            // Shrink to fit if the phrase is wider than the edge it sits on.
            const avail = Math.min(w, h) - band * 2;
            const natural = marqueeTexts[0].getComputedTextLength() || 0;
            if (natural > avail && avail > 0) {
                const fs = Math.max(7, MARQUEE_FONT * avail / natural);
                marqueeTexts.forEach(t => t.setAttribute('font-size', fs.toFixed(2)));
            }
        }
        const charGroup = sel('#cc-char-group');
        const controlsRoot = sel('.cc-controls');
        let eyesGroup = null, pupilL = null, pupilR = null;

        // ---- render (animated variant — assigns ids for the tick loop) ----------
        function rebuild() {
            const bodyPart = partFor('body', state);
            const eyesPart = partFor('eyes', state);
            const pupilsPart = partFor('pupils', state);
            const earsPart = partFor('ears', state);
            const tailPart = partFor('tail', state);
            const clipId = 'cc-live-clip';
            const overlayL = eyesPart.overlay ? eyesPart.overlay(-EYE_CX, EYE_CY, false) : '';
            const overlayR = eyesPart.overlay ? eyesPart.overlay(EYE_CX, EYE_CY, true) : '';

            charGroup.innerHTML =
                `<defs><clipPath id="${clipId}"><circle cx="0" cy="0" r="${BODY_R - 0.5}"/></clipPath></defs>` +
                `<g>${tailPart.render()}</g>` +
                `<g>${earsPart.render()}</g>` +
                `<circle cx="0" cy="0" r="${BODY_R}" fill="#000"/>` +
                `<g clip-path="url(#${clipId})">${bodyPart.pattern}</g>` +
                `<circle cx="0" cy="0" r="${BODY_R}" fill="none" stroke="#000" stroke-width="${STROKE}"/>` +
                `<g id="cc-eyes-group">` +
                eyesPart.render(-EYE_CX, EYE_CY, false) +
                eyesPart.render(EYE_CX, EYE_CY, true) +
                `<g id="cc-pupil-left"  transform="translate(${-EYE_CX} ${EYE_CY})">${pupilsPart.render(0, 0)}</g>` +
                `<g id="cc-pupil-right" transform="translate(${EYE_CX} ${EYE_CY})">${pupilsPart.render(0, 0)}</g>` +
                overlayL + overlayR +
                `</g>`;

            eyesGroup = sroot.getElementById('cc-eyes-group');
            pupilL = sroot.getElementById('cc-pupil-left');
            pupilR = sroot.getElementById('cc-pupil-right');
        }

        // ---- animation state ----------------------------------------------------
        const eyeAnim = {
            shift: { current: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
            pupilOff: { current: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
            mouseDir: null, idleDir: { x: 0, y: 0 }, nextIdleAt: 0,
        };
        const EYE_SHIFT_MAX = { x: 17, y: 11 };
        const PUPIL_OFF_MAX = { x: 8, y: 5 };
        const blinkAnim = { amount: 0, state: 'open', nextBlinkAt: 0, phaseStart: 0 };
        const squeezeAnim = {
            active: false, startTime: 0, slant: 0,
            phases: [
                { dur: 120, sx: 0.65, sy: 1.55, angK: 1.0, ease: easeOutCubic },
                { dur: 180, sx: 1.28, sy: 0.80, angK: -0.5, ease: easeInOutQuad },
                { dur: 420, sx: 1.00, sy: 1.00, angK: 0, ease: easeOutElastic },
            ],
            totalDur: 0,
        };
        squeezeAnim.totalDur = squeezeAnim.phases.reduce((a, p) => a + p.dur, 0);
        function triggerSqueeze() {
            // Restart on every click — interrupt any in-progress jump so the
            // player can spam with no downtime.
            squeezeAnim.active = true;
            squeezeAnim.startTime = performance.now();
            squeezeAnim.slant = (Math.random() - 0.5) * 22;
        }

        let running = true;
        let rafId = 0;
        function tick(now) {
            if (!running) return;
            let dirX, dirY;
            if (eyeAnim.mouseDir) {
                dirX = eyeAnim.mouseDir.x; dirY = eyeAnim.mouseDir.y;
            } else {
                if (now >= eyeAnim.nextIdleAt) {
                    eyeAnim.idleDir.x = rand(-1, 1) * 0.55;
                    eyeAnim.idleDir.y = rand(-1, 1) * 0.55;
                    eyeAnim.nextIdleAt = now + rand(1500, 3500);
                }
                dirX = eyeAnim.idleDir.x; dirY = eyeAnim.idleDir.y;
            }

            eyeAnim.shift.target.x = dirX * EYE_SHIFT_MAX.x;
            eyeAnim.shift.target.y = dirY * EYE_SHIFT_MAX.y;
            eyeAnim.pupilOff.target.x = dirX * PUPIL_OFF_MAX.x;
            eyeAnim.pupilOff.target.y = dirY * PUPIL_OFF_MAX.y;
            eyeAnim.shift.current.x += (eyeAnim.shift.target.x - eyeAnim.shift.current.x) * 0.18;
            eyeAnim.shift.current.y += (eyeAnim.shift.target.y - eyeAnim.shift.current.y) * 0.18;
            eyeAnim.pupilOff.current.x += (eyeAnim.pupilOff.target.x - eyeAnim.pupilOff.current.x) * 0.18;
            eyeAnim.pupilOff.current.y += (eyeAnim.pupilOff.target.y - eyeAnim.pupilOff.current.y) * 0.18;

            const eyesPart = partFor('eyes', state);
            const px = clamp(eyeAnim.pupilOff.current.x, -eyesPart.pupilMax.x, eyesPart.pupilMax.x);
            const py = clamp(eyeAnim.pupilOff.current.y, -eyesPart.pupilMax.y, eyesPart.pupilMax.y);
            if (pupilL) pupilL.setAttribute('transform', `translate(${(-EYE_CX + px).toFixed(2)} ${(EYE_CY + py).toFixed(2)})`);
            if (pupilR) pupilR.setAttribute('transform', `translate(${(EYE_CX + px).toFixed(2)} ${(EYE_CY + py).toFixed(2)})`);

            if (blinkAnim.state === 'open') {
                if (now >= blinkAnim.nextBlinkAt) { blinkAnim.state = 'closing'; blinkAnim.phaseStart = now; }
            } else if (blinkAnim.state === 'closing') {
                const t = (now - blinkAnim.phaseStart) / 80;
                blinkAnim.amount = clamp(t, 0, 1);
                if (t >= 1) { blinkAnim.state = 'opening'; blinkAnim.phaseStart = now; }
            } else if (blinkAnim.state === 'opening') {
                const t = (now - blinkAnim.phaseStart) / 120;
                blinkAnim.amount = clamp(1 - t, 0, 1);
                if (t >= 1) { blinkAnim.amount = 0; blinkAnim.state = 'open'; blinkAnim.nextBlinkAt = now + rand(3500, 7000); }
            }
            if (eyesGroup) {
                const blinkScale = 1 - blinkAnim.amount * 0.94;
                const sx = eyeAnim.shift.current.x, sy = eyeAnim.shift.current.y;
                eyesGroup.setAttribute('transform',
                    `translate(${sx.toFixed(2)} ${sy.toFixed(2)}) translate(0 ${EYE_CY}) scale(1 ${blinkScale}) translate(0 ${-EYE_CY})`);
            }

            if (squeezeAnim.active) {
                const elapsed = now - squeezeAnim.startTime;
                if (elapsed >= squeezeAnim.totalDur) {
                    charGroup.removeAttribute('transform');
                    squeezeAnim.active = false;
                } else {
                    let acc = 0, sx = 1, sy = 1, ang = 0, prevSx = 1, prevSy = 1, prevAng = 0;
                    for (let i = 0; i < squeezeAnim.phases.length; i++) {
                        const p = squeezeAnim.phases[i];
                        const endAng = squeezeAnim.slant * p.angK;
                        if (elapsed < acc + p.dur) {
                            const t = p.ease((elapsed - acc) / p.dur);
                            sx = lerp(prevSx, p.sx, t);
                            sy = lerp(prevSy, p.sy, t);
                            ang = lerp(prevAng, endAng, t);
                            break;
                        }
                        acc += p.dur; prevSx = p.sx; prevSy = p.sy; prevAng = endAng;
                    }
                    charGroup.setAttribute('transform', `scale(${sx.toFixed(3)} ${sy.toFixed(3)}) rotate(${ang.toFixed(2)})`);
                }
            }
            rafId = requestAnimationFrame(tick);
        }

        // ---- pickers ------------------------------------------------------------
        function getIndex(c) { return PARTS[c].findIndex(p => p.id === state[c]); }
        function setByIndex(c, idx) {
            const arr = PARTS[c];
            const i = ((idx % arr.length) + arr.length) % arr.length;
            state[c] = arr[i].id;
        }
        function refreshControls() {
            for (const cat of CATEGORIES) {
                const row = sroot.querySelector(`.cc-row[data-category="${cat.key}"]`);
                const arr = PARTS[cat.key];
                const idx = getIndex(cat.key);
                row.querySelector('.cc-val').textContent = arr[idx].name;
                row.querySelector('.cc-idx').textContent =
                    String(idx + 1).padStart(2, '0') + '/' + String(arr.length).padStart(2, '0');
            }
        }
        function step(category, dir) {
            const valEl = sroot.querySelector(`.cc-row[data-category="${category}"] .cc-val`);
            if (valEl) { valEl.classList.add('changing'); setTimeout(() => valEl.classList.remove('changing'), 80); }
            setByIndex(category, getIndex(category) + dir);
            refreshControls();
            rebuild();
        }
        function buildControls() {
            controlsRoot.innerHTML = '';
            for (const cat of CATEGORIES) {
                const row = document.createElement('div');
                row.className = 'cc-row';
                row.dataset.category = cat.key;
                row.innerHTML =
                    `<div class="lbl">${cat.label}</div>` +
                    `<div class="cc-pick">` +
                    `<button class="arrow prev" aria-label="Previous">&lt;</button>` +
                    `<div class="cc-val"></div>` +
                    `<button class="arrow next" aria-label="Next">&gt;</button>` +
                    `</div>` +
                    `<div class="cc-idx"></div>`;
                row.querySelector('.prev').addEventListener('click', () => step(cat.key, -1));
                row.querySelector('.next').addEventListener('click', () => step(cat.key, +1));
                controlsRoot.appendChild(row);
            }
            refreshControls();
        }
        function randomize() {
            for (const cat of CATEGORIES) setByIndex(cat.key, Math.floor(Math.random() * PARTS[cat.key].length));
            refreshControls();
            rebuild();
            triggerSqueeze();
        }

        // ---- input --------------------------------------------------------------
        function onMove(e) {
            const rect = stageEl.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = e.clientX - cx, dy = e.clientY - cy;
            const norm = clamp(Math.hypot(dx, dy) / 240, 0, 1);
            const ang = Math.atan2(dy, dx);
            eyeAnim.mouseDir = { x: Math.cos(ang) * norm, y: Math.sin(ang) * norm };
        }
        function onLeave() { eyeAnim.mouseDir = null; }
        function onKey(e) { if (e.key === 'Escape') cancel(); }

        stageEl.addEventListener('click', triggerSqueeze);
        window.addEventListener('resize', buildMarquee);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseleave', onLeave);
        window.addEventListener('blur', onLeave);
        document.addEventListener('keydown', onKey);

        // ---- teardown / actions -------------------------------------------------
        function teardown() {
            running = false;
            cancelAnimationFrame(rafId);
            window.removeEventListener('resize', buildMarquee);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseleave', onLeave);
            window.removeEventListener('blur', onLeave);
            document.removeEventListener('keydown', onKey);
            if (host.parentNode) host.parentNode.removeChild(host);
        }
        function save() { const result = validate(state); teardown(); onSave(result); }
        function cancel() { teardown(); onClose(); }

        sel('.cc-save').addEventListener('click', save);
        sel('.cc-cancel').addEventListener('click', cancel);
        sel('.cc-random').addEventListener('click', randomize);

        // ---- boot ---------------------------------------------------------------
        buildControls();
        rebuild();
        buildMarquee();
        // glyph metrics can shift once the webfont lands — re-measure then
        requestAnimationFrame(buildMarquee);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildMarquee).catch(() => { });
        blinkAnim.nextBlinkAt = performance.now() + rand(2500, 4500);
        eyeAnim.nextIdleAt = performance.now() + rand(800, 2000);
        rafId = requestAnimationFrame(tick);

        return { close: cancel };
    }

    // ── export ──────────────────────────────────────────────────────────────────
    const Character = {
        DEFAULT_STATE,
        CATEGORIES,
        PARTS,
        validate,
        buildCharacterSVG,
        openCreator,
        // Geometry the in-game renderer needs to place tracked pupils over baked
        // eye-whites. Values are in the character's own viewBox units; the game
        // converts them to on-screen px. pupilViewBox is the size of the 'pupil'
        // layer's viewBox (see buildCharacterSVG, layer 'pupil').
        METRICS: { viewBox: 320, bodyR: BODY_R, eyeCx: EYE_CX, eyeCy: EYE_CY, pupilViewBox: 80 },
    };

    global.Character = Character;
    if (typeof module !== 'undefined' && module.exports) module.exports = Character;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));