#!/usr/bin/env python3
"""AGICENDS showreel soundtrack, synthesised from scratch.

    python3 audio.py [out/cues.json] [out/soundtrack.wav]

120 BPM in D minor, 15 s, 48 kHz stereo. Every sound effect is placed from
the cue list the picture exports (render.cjs --cues), so the mix is locked to
the animation frame-for-frame. Nothing is sampled: kicks, claps, hats, bass,
supersaw pads, a cathedral organ, a formant "choir", risers, whooshes and all
the game-y blips are built here with numpy/scipy.
"""
import json
import os
import sys

import numpy as np
import scipy.signal as sg
from scipy.ndimage import maximum_filter1d

SR = 48000
DUR = 15.0
N = int(SR * DUR)
BEAT = 0.5
HERE = os.path.dirname(os.path.abspath(__file__))
CUES_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'cues.json')
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'out', 'soundtrack.wav')
rng = np.random.default_rng(2026)


# ── buses ────────────────────────────────────────────────────────────────────
class Bus:
    def __init__(self):
        self.x = np.zeros((2, N))
        self.send = np.zeros((2, N))

    def add(self, t, sig, gain=1.0, pan=0.0, send=0.0):
        sig = np.asarray(sig, dtype=np.float64)
        if sig.ndim == 1:
            p = (np.clip(pan, -1, 1) + 1) * np.pi / 4
            sig = np.vstack([sig * np.cos(p), sig * np.sin(p)]) * np.sqrt(2)
        i = int(round(t * SR))
        if i >= N:
            return
        if i < 0:
            sig = sig[:, -i:]
            i = 0
        n = min(sig.shape[1], N - i)
        self.x[:, i:i + n] += sig[:, :n] * gain
        if send:
            self.send[:, i:i + n] += sig[:, :n] * gain * send


drums, bass, music, sfx = Bus(), Bus(), Bus(), Bus()


# ── helpers ──────────────────────────────────────────────────────────────────
def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def noise(dur):
    return rng.standard_normal(int(dur * SR))


def bp(x, lo, hi, order=2):
    sos = sg.butter(order, [lo, min(hi, SR / 2 - 100)], 'bandpass', fs=SR, output='sos')
    return sg.sosfilt(sos, x)


def hp(x, fc, order=2):
    return sg.sosfilt(sg.butter(order, fc, 'highpass', fs=SR, output='sos'), x)


def lp(x, fc, order=2):
    return sg.sosfilt(sg.butter(order, min(fc, SR / 2 - 100), 'lowpass', fs=SR, output='sos'), x)


def phase(freq):
    return 2 * np.pi * np.cumsum(freq) / SR


def saw_bl(freq):
    """Anti-aliased saw: naive saw at 4x rate, then polyphase decimation."""
    f4 = np.repeat(freq, 4) / 4
    ph = np.cumsum(f4) / SR
    s = 2 * (ph - np.floor(ph + 0.5))
    return sg.resample_poly(s, 1, 4)[:len(freq)]


def svf(x, fc, q=0.7, mode='bp'):
    """Time-varying state-variable filter, trapezoidal (TPT) form: stable for
    any cutoff below Nyquist. 'bp' is normalised to unity gain at the centre."""
    fc = np.broadcast_to(np.asarray(fc, dtype=np.float64), x.shape)
    g = np.tan(np.pi * np.clip(fc, 20, SR * 0.45) / SR)
    k = 1.0 / q
    a1 = 1.0 / (1.0 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
    ic1 = ic2 = 0.0
    out = np.empty_like(x)
    for i in range(len(x)):
        v3 = x[i] - ic2
        v1 = a1[i] * ic1 + a2[i] * v3
        v2 = ic2 + a2[i] * ic1 + a3[i] * v3
        ic1 = 2 * v1 - ic1
        ic2 = 2 * v2 - ic2
        out[i] = k * v1 if mode == 'bp' else v2 if mode == 'lp' else x[i] - k * v1 - v2
    return out


def env_ar(n, a, r, hold=0.0):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), np.exp(-(t - a - hold).clip(0) / r))
    return e


def fade(sig, a=0.005, r=0.02):
    n = len(sig)
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    if na:
        e[:na] = np.linspace(0, 1, na)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return sig * e


# ── instruments ──────────────────────────────────────────────────────────────
def kick(f0=160, f1=45, pd=0.04, ad=0.3, dur=0.55, drive=1.8):
    t = tt(dur)
    f = f1 + (f0 - f1) * np.exp(-t / pd)
    body = np.sin(phase(f)) * np.exp(-t / ad)
    body *= np.minimum(1, t / 0.002)
    click = hp(noise(dur), 2500) * np.exp(-t / 0.003) * 0.35
    return np.tanh((body + click) * drive) / np.tanh(drive)


def clap(dur=0.35):
    t = tt(dur)
    n = bp(noise(dur), 900, 3200)
    e = np.zeros_like(t)
    for d in (0.0, 0.011, 0.022):
        e += np.where(t >= d, np.exp(-(t - d).clip(0) / 0.006), 0)
    e += np.where(t >= 0.03, 0.55 * np.exp(-(t - 0.03).clip(0) / 0.11), 0)
    tone = np.sin(phase(np.full_like(t, 185))) * np.exp(-t / 0.06) * 0.45
    return (n * e * 0.8 + tone)


def hat(open_=False):
    dur = 0.4 if open_ else 0.08
    t = tt(dur)
    metal = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (3140, 4410, 5280, 6630, 7940, 9120)) / 6
    s = hp(noise(dur) * 0.7 + metal * 0.5, 7000)
    return s * np.exp(-t / (0.12 if open_ else 0.018))


def crash(dur=2.4):
    t = tt(dur)
    metal = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6)) for f in rng.uniform(3000, 11000, 24)) / 8
    s = hp(noise(dur) + metal * 0.6, 3500)
    return s * np.exp(-t / 0.7) * np.minimum(1, t / 0.002)


def sub_drop(f0=90, f1=38, dur=1.4):
    t = tt(dur)
    f = f1 + (f0 - f1) * np.exp(-t / 0.25)
    return np.sin(phase(f)) * np.exp(-t / 0.55) * np.minimum(1, t / 0.004)


def impact(big=1.0):
    k = kick(f0=180, f1=38, pd=0.06, ad=0.55, dur=1.2, drive=2.6)
    s = np.zeros(int(1.6 * SR))
    s[:len(k)] += k
    sd = sub_drop()
    s[:len(sd)] += sd * 0.8
    nb = noise(1.0)
    t = tt(1.0)
    nb = svf(nb, 9000 * np.exp(-t / 0.08) + 150, 0.8, 'lp') * np.exp(-t / 0.25)
    s[:len(nb)] += nb * 0.5
    return s * big


def pad(notes, dur, att=0.35, rel=0.5, cutoff=2400, voices=5, detune=14):
    n = int(dur * SR)
    out = np.zeros((2, n))
    t = np.arange(n) / SR
    for m in notes:
        for v in range(voices):
            cents = (v - (voices - 1) / 2) / ((voices - 1) / 2) * detune
            f = mtof(m) * 2 ** (cents / 1200) * (1 + 0.0015 * np.sin(2 * np.pi * (0.3 + v * 0.07) * t + v))
            s = saw_bl(f)
            p = (v / (voices - 1)) * 2 - 1
            out[0] += s * np.cos((p * 0.8 + 1) * np.pi / 4)
            out[1] += s * np.sin((p * 0.8 + 1) * np.pi / 4)
    out = np.vstack([lp(out[0], cutoff), lp(out[1], cutoff)])
    e = np.minimum(1, t / att) * np.minimum(1, (dur - t).clip(0) / rel)
    return out * e / (len(notes) * voices) * 2.2


def organ(notes, dur, att=0.06, rel=0.6):
    t = tt(dur)
    s = np.zeros_like(t)
    vib = 1 + 0.0022 * np.sin(2 * np.pi * 5.6 * t)
    for m in notes:
        f = mtof(m) * vib
        for h, a in ((1, 1.0), (2, 0.62), (3, 0.34), (4, 0.3), (6, 0.14), (8, 0.12), (0.5, 0.35 if m >= 45 else 0.0)):
            s += a * np.sin(phase(f * h) + m)
    e = np.minimum(1, t / att) * np.minimum(1, (dur - t).clip(0) / rel)
    return lp(s, 5200) * e / (len(notes) * 2.4)


def choir(notes, dur, att=0.4, rel=0.6):
    t = tt(dur)
    s = np.zeros_like(t)
    for m in notes:
        for v in range(3):
            f = mtof(m) * (1 + (v - 1) * 0.004) * (1 + 0.004 * np.sin(2 * np.pi * (5 + v * 0.4) * t))
            s += saw_bl(f)
    # "aah" formants
    y = bp(s, 650, 850) * 1.0 + bp(s, 1050, 1250) * 0.6 + bp(s, 2500, 2800) * 0.25
    e = np.minimum(1, t / att) * np.minimum(1, (dur - t).clip(0) / rel)
    return y * e / (len(notes) * 1.2)


def bass_note(m, dur, drive=1.4, cutoff=900, sub=0.8):
    t = tt(dur)
    f = np.full_like(t, mtof(m))
    s = saw_bl(f)
    s = svf(s, cutoff * np.exp(-t / 0.08) + 180, 0.9, 'lp') * 1.6
    s += np.sin(phase(f)) * sub
    s = np.tanh(s * drive)
    return fade(s * np.minimum(1, t / 0.003), 0.002, 0.02)


def pluck(m, dur=0.35, bright=1.0):
    t = tt(dur)
    f = np.full_like(t, mtof(m))
    f *= 1 + 0.03 * np.exp(-t / 0.01)
    tri = 2 * np.abs(2 * ((np.cumsum(f) / SR) % 1) - 1) - 1
    sq = np.sign(np.sin(phase(f)))
    s = tri * 0.7 + sq * 0.25 * bright + np.sin(phase(f * 2)) * 0.3
    s = lp(s, 6000 + 3000 * bright)
    return fade(s * np.exp(-t / 0.12), 0.001, 0.03)


def stab(m, dur=0.22):
    t = tt(dur)
    s = np.zeros_like(t)
    for iv in (0, 7, 12):
        s += saw_bl(np.full_like(t, mtof(m + iv)))
    s = svf(s, 5000 * np.exp(-t / 0.05) + 400, 1.2, 'lp')
    return fade(s * np.exp(-t / 0.09) / 2.2, 0.001, 0.03)


def blip(m, dur=0.09):
    t = tt(dur)
    f = mtof(m) * (1 + 0.5 * np.exp(-t / 0.006))
    s = np.sin(phase(np.full_like(t, 1) * f)) * 0.7 + np.sign(np.sin(phase(np.full_like(t, 1) * f))) * 0.2
    return fade(s * np.exp(-t / 0.045), 0.001, 0.01)


def whoosh(dur, f0, f1, q=1.4, curve=2.0, shape='swell'):
    t = tt(dur)
    u = t / dur
    fc = f0 * (f1 / f0) ** (u ** curve if f1 > f0 else u)
    s = svf(noise(dur), fc, q, 'bp')
    if shape == 'swell':
        e = u ** 2.2 * np.minimum(1, (1 - u) * 30)
    elif shape == 'pass':
        e = np.sin(np.pi * u) ** 1.5
    else:
        e = np.exp(-t / (dur * 0.35)) * np.minimum(1, t / 0.01)
    return s * e


def riser(dur, m0=50, m1=74, gain=1.0):
    t = tt(dur)
    u = t / dur
    f = mtof(m0 + (m1 - m0) * u ** 1.6)
    s = saw_bl(f) * 0.35 + saw_bl(f * 1.5) * 0.2
    s = svf(s, 400 + 7000 * u ** 2, 1.5, 'lp')
    n = whoosh(dur, 400, 9000, 1.2, 1.5)
    return (s + n * 0.8) * u ** 1.8 * gain


def snare_roll(t0, t1, gain=0.6):
    t = t0
    while t < t1 - 1e-6:
        u = (t - t0) / (t1 - t0)
        step = 0.125 if u < 0.5 else 0.0625 if u < 0.8 else 0.03125
        drums.add(t, clap(0.2), gain * (0.25 + 0.75 * u ** 1.5), pan=0.05, send=0.15)
        t += step


def rev_cymbal(dur):
    c = crash(dur + 0.1)[:int(dur * SR)]
    return c[::-1] * np.linspace(0, 1, len(c)) ** 2


def chatter(t0, dur, n, seed, gain=0.18):
    r = np.random.default_rng(seed)
    for k in range(n):
        sfx.add(t0 + dur * k / n, blip(int(r.integers(84, 100)), 0.03), gain, pan=float(r.uniform(-0.6, 0.6)))


def tick(freq=2600, dur=0.018):
    t = tt(dur)
    return np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.004) + hp(noise(dur), 3000) * np.exp(-t / 0.002) * 0.4


def boing(f=210, dur=0.45):
    t = tt(dur)
    fr = f * (1 + 0.28 * np.exp(-t / 0.12) * np.sin(2 * np.pi * 13 * t)) * (1 + 0.5 * np.exp(-t / 0.02))
    return fade(np.sin(phase(fr)) * np.exp(-t / 0.16), 0.001, 0.05)


def chime(ms, gap=0.045, dur=0.6):
    out = np.zeros(int((dur + gap * len(ms)) * SR))
    for k, m in enumerate(ms):
        t = tt(dur)
        f = mtof(m)
        s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2.01 * t) + 0.2 * np.sin(2 * np.pi * f * 3.98 * t)
        s *= np.exp(-t / 0.18)
        i = int(k * gap * SR)
        out[i:i + len(s)] += s
    return fade(out / len(ms) * 1.6, 0.001, 0.05)


# ── score ────────────────────────────────────────────────────────────────────
cues = json.load(open(CUES_PATH))
cue_t = lambda kind: [c['t'] for c in cues if c['kind'] == kind]

D2, D3, D4 = 38, 50, 62
CH = {
    'Dm': [50, 57, 62, 65], 'Bb': [46, 53, 58, 62], 'Gm': [43, 50, 55, 58, 62], 'A': [45, 52, 57, 61, 64],
    'C': [48, 55, 60, 64], 'Dm9': [50, 57, 60, 64, 65, 69],
}

# ---- intro (0–2): organ swell in the dark, heartbeat sub, riser into the drop
music.add(0.0, organ([38, 50, 57, 62], 2.3, att=1.1, rel=0.5), 0.34, send=0.5)
music.add(0.0, pad(CH['Dm'], 2.1, att=1.4, rel=0.3, cutoff=900), 0.28, send=0.4)
for t in (0.1, 1.0):
    bass.add(t, sub_drop(80, 42, 1.0), 0.5)
sfx.add(0.08, whoosh(0.5, 180, 900, 0.9, 1.0, 'pass'), 0.35, send=0.4)
for t in cue_t('dart'):
    sfx.add(t, tick(2800 if t < 0.9 else 3400), 0.35, pan=-0.4 if t < 0.5 else 0.4, send=0.2)
for t in cue_t('blink'):
    sfx.add(t, tick(1800, 0.012) * 0.6, 0.3, send=0.1)
sfx.add(1.0, whoosh(0.7, 5000, 250, 1.1, 1.0, 'decay'), 0.5, send=0.3)
sfx.add(1.0, riser(1.0, 45, 69), 0.42, send=0.25)
snare_roll(1.5, 2.0, 0.5)

# ---- drums
def four(t0, t1, claps=True, hats=True, k_gain=0.95):
    t = t0
    while t < t1 - 1e-6:
        drums.add(t, kick(), k_gain)
        if claps and abs(((t - t0) / BEAT) % 2 - 1) < 1e-6:
            drums.add(t, clap(), 0.55, pan=0.05, send=0.2)
        t += BEAT
    if hats:
        t = t0
        k = 0
        while t < t1 - 1e-6:
            if k % 4 == 2:
                drums.add(t, hat(True), 0.2, pan=0.25, send=0.1)
            else:
                drums.add(t, hat(), 0.13 if k % 2 else 0.2, pan=0.3 if k % 2 else 0.15)
            t += 0.125
            k += 1

KICKS = []
def reg_kicks(t0, t1):
    t = t0
    while t < t1 - 1e-6:
        KICKS.append(t)
        t += BEAT

four(2.0, 3.6); reg_kicks(2.0, 3.6)
four(4.0, 6.0); reg_kicks(4.0, 6.0)
four(6.0, 7.75); reg_kicks(6.0, 7.75)
four(10.0, 11.6); reg_kicks(10.0, 11.6)
# 8.5–9.7: stomp
for t in (8.5, 9.0, 9.25, 9.5):
    drums.add(t, kick(drive=2.4), 1.0); KICKS.append(t)
for t in (9.0, 9.5):
    drums.add(t, clap(), 0.6, send=0.3)
for k in range(10):
    drums.add(8.75 + k * 0.125, hat(k % 2 == 1), 0.14, pan=0.3)
# logo: sparse pulse
for t in (13.0, 14.0):
    drums.add(t, kick(f0=140, ad=0.4), 0.8); KICKS.append(t)
for k in range(12):
    drums.add(12.5 + k * 0.125 + (0.0625 if k % 2 else 0), hat(), 0.08, pan=0.35)
for k in range(8):
    drums.add(13.0 + k * 0.125, hat(k % 2 == 1), 0.1, pan=-0.3)

# crashes / impacts
drums.add(2.0, crash(), 0.35, send=0.3)
drums.add(12.0, crash(3.0), 0.42, send=0.4)
drums.add(10.0, crash(), 0.35, send=0.3)
drums.add(8.5, crash(), 0.38, send=0.3)
sfx.add(8.5, impact(1.0), 0.75, send=0.35); KICKS.append(8.5)
sfx.add(10.0, impact(1.0), 0.8, send=0.35); KICKS.append(10.0)
sfx.add(12.0, impact(1.1), 0.85, send=0.45); KICKS.append(12.0)
sfx.add(4.0, kick(f0=200, ad=0.45, drive=2.2), 0.8, send=0.2); KICKS.append(4.0)
sfx.add(4.0, crash(1.4), 0.2, send=0.3)

# ---- bass lines (8ths, sidechained later)
def bassline(t0, t1, root, step=0.25, pattern=(0, 12, 0, 12), gain=0.5):
    t, k = t0, 0
    while t < t1 - 1e-6:
        m = root + pattern[k % len(pattern)]
        bass.add(t, bass_note(m, step * 0.92, cutoff=1400 if pattern[k % len(pattern)] else 900), gain)
        t += step
        k += 1

bassline(2.0, 3.62, 34)                       # Bb
bassline(4.0, 6.0, 31)                        # G
bassline(6.0, 7.75, 33)                       # A
bassline(8.5, 9.72, 38, 0.25, (0, 0, 12, 0), 0.6)   # low D, darker
bassline(10.0, 11.0, 34, 0.125, (0, 12, 0, 0, 12, 0, 0, 12), 0.5)  # Bb 16ths
bassline(11.0, 11.62, 36, 0.125, (0, 12, 0, 0, 12, 0, 0, 12), 0.5)  # C
bass.add(12.0, bass_note(38, 2.4, drive=1.2, cutoff=500, sub=1.0) * np.linspace(1, 0.4, int(2.4 * SR)), 0.6)

# ---- chords
music.add(2.0, pad(CH['Bb'], 1.65, att=0.02, rel=0.25, cutoff=3200), 0.5, send=0.35)
music.add(4.0, pad(CH['Gm'], 2.0, att=0.02, rel=0.3, cutoff=3000), 0.45, send=0.35)
music.add(6.0, pad(CH['A'], 1.8, att=0.02, rel=0.3, cutoff=3000), 0.45, send=0.35)
music.add(8.0, pad([38, 45, 50], 0.6, att=0.4, rel=0.1, cutoff=600), 0.5, send=0.4)
music.add(8.0, rev_cymbal(0.5), 0.45, send=0.2)
music.add(8.5, pad(CH['Dm'], 1.3, att=0.01, rel=0.3, cutoff=2600), 0.5, send=0.4)
music.add(8.5, choir([62, 65, 69, 74], 1.3, att=0.15, rel=0.3), 0.35, pan=0.35, send=0.6)
music.add(8.5, organ([38, 50, 57], 1.3, att=0.01, rel=0.3), 0.25, pan=-0.3, send=0.4)
music.add(10.0, pad(CH['Bb'], 1.0, att=0.01, rel=0.1, cutoff=3500), 0.45, send=0.3)
music.add(11.0, pad(CH['C'], 0.66, att=0.01, rel=0.1, cutoff=3800), 0.45, send=0.3)
# the logo chord: organ + supersaw + choir, a cathedral in D minor
music.add(12.0, organ([38, 50, 57, 60, 64, 65, 69], 2.5, att=0.01, rel=0.4), 0.52, send=0.7)
music.add(12.0, pad(CH['Dm9'], 2.45, att=0.01, rel=0.4, cutoff=4200, voices=7, detune=18), 0.55, send=0.5)
music.add(12.0, choir([69, 72, 74, 77], 2.45, att=0.3, rel=0.4), 0.3, send=0.8)

# ---- melodic cues
coin_notes = [74, 77, 79, 81, 84, 86]
for c in cues:
    if c['kind'] == 'coin':
        n = coin_notes[c['n'] % len(coin_notes)]
        sfx.add(c['t'], pluck(n, 0.3), 0.36, pan=-0.35 if c['n'] % 2 else 0.35, send=0.25)
        sfx.add(c['t'] + 0.04, pluck(n + 12, 0.2, 0.5), 0.14, pan=0.2, send=0.3)
morph_notes = [69, 72, 74, 77, 79, 81, 86]
for c in cues:
    if c['kind'] == 'morph':
        sfx.add(c['t'], stab(morph_notes[c['n'] - 1] - 12), 0.5, pan=(c['n'] % 2) * 0.4 - 0.2, send=0.25)
        if c['n'] == 6:
            sfx.add(c['t'], chime([86, 89, 93, 98], 0.03, 0.8), 0.35, send=0.5)
for t in cue_t('invert'):
    sfx.add(t - 0.12, whoosh(0.16, 600, 7000, 1.5, 1.0, 'swell'), 0.35, send=0.2)
# 16 counts climbing an A-dominant ladder
ladder = [57, 59, 61, 62, 64, 65, 67, 69, 71, 73, 74, 76, 77, 79, 81, 85]
for c in cues:
    if c['kind'] == 'count':
        sfx.add(c['t'], blip(ladder[c['n']], 0.1), 0.3, pan=-0.6 + 1.2 * (c['n'] % 8) / 7, send=0.2)
sfx.add(7.0, boing(160, 0.4), 0.25, send=0.2)
for k, t in enumerate((7.25, 7.5)):
    sfx.add(t, whoosh(0.12, 3000, 800, 1.5, 1.0, 'pass'), 0.18, pan=-0.5 if k == 0 else 0.5)
sfx.add(7.62, tick(2000, 0.012), 0.2)
sfx.add(7.75, riser(0.25, 60, 84), 0.5)
sfx.add(7.78, whoosh(0.24, 400, 6000, 1.2, 1.2, 'swell'), 0.5, send=0.2)

# typing: onboarding keys
for k, t in enumerate(cue_t('type')):
    sfx.add(t, bp(noise(0.012), 2500 + 300 * (k % 4), 7000) * np.exp(-np.arange(int(0.012 * SR)) / SR / 0.0025), 0.35, pan=-0.2 + 0.4 * (k % 3) / 2)

# face-off stab + hop
sfx.add(9.0, stab(50, 0.3), 0.45, send=0.4)
sfx.add(9.5, boing(190, 0.35), 0.2, send=0.2)
sfx.add(9.62, riser(0.38, 50, 76), 0.55, send=0.25)
sfx.add(9.72, whoosh(0.26, 300, 5000, 1.1, 1.0, 'swell'), 0.5, pan=0.3)
snare_roll(9.75, 10.0, 0.45)

# powerups, vacuum, bonk, death
pu_notes = {'mult': [74, 78, 81], 'vacuum': [72, 76, 79], 'ghost': [69, 72, 76], 'secondWind': [74, 81, 86, 90]}
for c in cues:
    if c['kind'] == 'powerup':
        sfx.add(c['t'], chime(pu_notes[c['type']]), 0.4, pan=0.2, send=0.4)
for c in cues:
    if c['kind'] == 'vcoin':
        sfx.add(c['t'], pluck(81 + c['n'] * 2, 0.12, 0.8), 0.16, pan=-0.3, send=0.2)
for t in cue_t('bonk'):
    sfx.add(t, boing(330, 0.3), 0.35, send=0.2)
    sfx.add(t, tick(900, 0.03), 0.3)
for t in cue_t('death'):
    d = impact(0.8)
    cr = np.round(hp(noise(0.3), 200) * 6) / 6 * np.exp(-np.arange(int(0.3 * SR)) / SR / 0.07)
    sfx.add(t, d, 0.6, send=0.4)
    sfx.add(t, cr, 0.4, send=0.3)
    sfx.add(t, stab(38, 0.4), 0.35, send=0.3)
    drums.add(t, clap(), 0.6, send=0.3)

# whip into the logo
sfx.add(11.62, riser(0.38, 55, 86), 0.6, send=0.2)
sfx.add(11.62, whoosh(0.38, 300, 9000, 1.0, 1.8, 'swell'), 0.6)
snare_roll(11.62, 12.0, 0.5)

# logo lockup
for c in cues:
    if c['kind'] == 'letter':
        sfx.add(c['t'], pluck([62, 65, 69, 72, 74, 77, 81, 86][c['n']], 0.25, 0.7), 0.22, pan=-0.7 + 1.4 * c['n'] / 7, send=0.35)
sfx.add(12.28, whoosh(0.3, 500, 3500, 1.2, 1.0, 'pass'), 0.35, send=0.2)
sfx.add(12.93, kick(f0=120, f1=50, ad=0.2, drive=1.2), 0.5)
sfx.add(12.93, boing(140, 0.5), 0.35, send=0.25)
chatter(13.02, 0.45, 14, 1616)
chatter(13.35, 0.4, 10, 1717, 0.12)
arp = [74, 77, 81, 84, 88, 84, 81, 77]
for k in range(10):
    sfx.add(13.0 + k * 0.125, pluck(arp[k % len(arp)], 0.25, 0.6), 0.16 * (1 - k / 14), pan=0.5 if k % 2 else -0.5, send=0.5)
sfx.add(14.0, impact(0.5), 0.45, send=0.3)
sfx.add(14.0, stab(38, 0.3), 0.3, send=0.3)
sfx.add(14.06, tick(1400, 0.02), 0.25)
# the swallow: everything rushes up, then silence and one last blink
sfx.add(14.44, riser(0.42, 38, 74), 0.7, send=0.3)
sfx.add(14.44, whoosh(0.42, 150, 4000, 0.9, 1.4, 'swell'), 0.6)
sfx.add(14.46, rev_cymbal(0.4), 0.4)
for t in cue_t('blinkEnd'):
    sfx.add(t, tick(1500, 0.015), 0.28, send=0.6)
bass.add(14.86, sub_drop(55, 30, 0.2)[:int(0.14 * SR)] * np.linspace(1, 0, int(0.14 * SR)), 0.4)

# ── mix ──────────────────────────────────────────────────────────────────────
t_axis = np.arange(N) / SR
duck = np.ones(N)
for k in sorted(set(round(x, 4) for x in KICKS)):
    i = int(k * SR)
    seg = t_axis[i:] - k
    duck[i:] = np.minimum(duck[i:], 1 - 0.62 * np.exp(-np.clip(seg, 0, None) / 0.11) * np.minimum(1, seg / 0.004 + 0.2))

def lufs_ish(x):
    y = hp(x.sum(axis=0), 100)
    return 10 * np.log10(np.mean(y ** 2) + 1e-12)
for name, b in (('drums', drums), ('bass', bass), ('music', music), ('sfx', sfx)):
    print(f'  {name:6s} {lufs_ish(b.x):6.1f} dB')

MUSIC_G, BASS_G = 1.6, 0.8
dry = drums.x + bass.x * duck * BASS_G + music.x * (0.35 + 0.65 * duck) * MUSIC_G + sfx.x
send = drums.send + bass.send * BASS_G + music.send * (0.35 + 0.65 * duck) * MUSIC_G + sfx.send

# convolution reverb: decorrelated decaying noise, darkened over time
ir_len = int(2.4 * SR)
ti = np.arange(ir_len) / SR
ir = np.zeros((2, ir_len))
for ch in range(2):
    nz = rng.standard_normal(ir_len)
    early = lp(nz, 9000) * np.exp(-ti / 0.35)
    late = lp(nz, 3500) * np.exp(-ti / 0.9)
    ir[ch] = (early * 0.5 + late) * np.minimum(1, ti / 0.012)
ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
wet = np.vstack([sg.fftconvolve(hp(send[c], 250), ir[c])[:N] for c in range(2)]) * 0.55

mix = dry + wet
mix = hp(mix, 32, 4)

# gentle bus glue + limiter
def limiter(x, thr=0.89, release=0.08, look=0.002):
    peak = np.max(np.abs(x), axis=0)
    w = int(look * SR) * 2 + 1
    peak = maximum_filter1d(peak, w)
    g = np.minimum(1.0, thr / np.maximum(peak, 1e-9))
    a = np.exp(-1 / (release * SR))
    g = sg.lfilter([1 - a], [1, -a], g - 1) + 1          # smooth recovery
    g = np.minimum(g, thr / np.maximum(peak, 1e-9))
    delay = int(look * SR)
    xd = np.concatenate([x[:, delay:], np.zeros((2, delay))], axis=1)
    return xd * g

mix /= np.max(np.abs(mix)) + 1e-9
mix *= 1.15
mix = np.tanh(mix * 0.9) / 0.9
mix = limiter(mix, 0.84)
# loop-friendly edges
mix[:, :int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
mix[:, -int(0.06 * SR):] *= np.linspace(1, 0, int(0.06 * SR)) ** 2

pcm = (np.clip(mix, -1, 1) * 32767).astype('<i2').T
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
import wave
with wave.open(OUT_PATH, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('soundtrack →', OUT_PATH, f'peak {np.max(np.abs(mix)):.3f}')
