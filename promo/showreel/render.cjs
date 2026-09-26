#!/usr/bin/env node
/* AGICENDS showreel renderer.
 *
 *   node render.cjs                       full render → out/agicends-showreel.mp4
 *   node render.cjs --stills 0.5,2.3,4.6  PNG stills (seconds) → out/stills/
 *   node render.cjs --cues                write out/cues.json only
 *
 * Options: --samples N (motion-blur sub-frames, default 6), --workers N,
 *          --from S --to S (partial range), --video-only
 *
 * Needs Playwright (Chromium) and an ffmpeg with libx264 + aac on PATH (or set
 * FFMPEG=/path/to/ffmpeg). The soundtrack is produced by audio.py from the
 * cue list this script exports.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');

function loadPlaywright() {
    try { return require('playwright'); } catch (e) { /* fall through */ }
    const globalRoot = execFileSync('npm', ['root', '-g']).toString().trim();
    return require(path.join(globalRoot, 'playwright'));
}
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);

const ROOT = __dirname;
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SAMPLES = +opt('samples', 6);
const WORKERS = +opt('workers', Math.max(1, require('os').cpus().length));
const PAGE_URL = 'file://' + path.join(ROOT, 'showreel.html') + '?render=1';

async function openPage(browser) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', (e) => console.error('[page]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
    await page.goto(PAGE_URL);
    await page.evaluate(() => window.ready);
    return page;
}
const decode = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

(async () => {
    const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--disable-gpu-vsync'] });
    const first = await openPage(browser);
    const meta = await first.evaluate(() => ({ fps: REEL.FPS, frames: REEL.FRAMES, dur: REEL.DUR, cues: REEL.cues }));
    fs.writeFileSync(path.join(OUT, 'cues.json'), JSON.stringify(meta.cues, null, 1));
    console.log(`cues: ${meta.cues.length} → out/cues.json`);
    if (flag('cues')) { await browser.close(); return; }

    const stills = opt('stills', null);
    if (stills) {
        const dir = path.join(OUT, 'stills');
        fs.mkdirSync(dir, { recursive: true });
        for (const s of stills.split(',').map(Number)) {
            const f = Math.round(s * meta.fps);
            const png = decode(await first.evaluate(([f, n]) => renderFrameData(f, n), [f, SAMPLES]));
            const name = path.join(dir, `t${s.toFixed(3).padStart(6, '0')}.png`);
            fs.writeFileSync(name, png);
            console.log('still', name);
        }
        await browser.close();
        return;
    }

    const from = Math.round(+opt('from', 0) * meta.fps);
    const to = Math.min(meta.frames, Math.round(+opt('to', meta.dur) * meta.fps));
    const pages = [first];
    for (let i = 1; i < WORKERS; i++) pages.push(await openPage(browser));

    const videoPath = path.join(OUT, flag('video-only') || from > 0 || to < meta.frames ? 'video-partial.mp4' : 'video.mp4');
    const ff = spawn(FFMPEG, [
        '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(meta.fps), '-c:v', 'png', '-i', '-',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation', '-pix_fmt', 'yuv420p',
        '-x264-params', 'keyint=60:min-keyint=60', '-movflags', '+faststart', videoPath,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });

    const done = new Map();
    let next = from, write = from;
    const t0 = Date.now();
    const flush = async () => {
        while (done.has(write)) {
            const buf = done.get(write); done.delete(write);
            if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
            write++;
            if (write % 30 === 0) {
                const el = (Date.now() - t0) / 1000, rate = (write - from) / el;
                process.stdout.write(`\rframe ${write}/${to}  ${rate.toFixed(1)} fps  eta ${((to - write) / rate).toFixed(0)}s   `);
            }
        }
    };
    await Promise.all(pages.map(async (page) => {
        while (next < to) {
            const f = next++;
            const png = decode(await page.evaluate(([f, n]) => renderFrameData(f, n), [f, SAMPLES]));
            done.set(f, png);
            await flush();
        }
    }));
    await flush();
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    console.log(`\nvideo → ${path.relative(ROOT, videoPath)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    await browser.close();

    // mux the soundtrack (audio.py) onto the full-length picture
    const wav = path.join(OUT, 'soundtrack.wav');
    if (path.basename(videoPath) === 'video.mp4' && fs.existsSync(wav)) {
        const final = path.join(OUT, 'agicends-showreel.mp4');
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', videoPath, '-i', wav, '-map', '0:v', '-map', '1:a',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', final]);
        console.log('final →', path.relative(ROOT, final));
    }
})().catch((e) => { console.error(e); process.exit(1); });
