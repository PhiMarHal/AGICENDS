#!/usr/bin/env bash
# Rebuild the AGICENDS showreel from source: cue list → soundtrack → picture → mux.
# Requires Node + Playwright (Chromium), Python 3 with numpy/scipy, and an
# ffmpeg with libx264/aac on PATH (or FFMPEG=/path/to/ffmpeg).
set -euo pipefail
cd "$(dirname "$0")"
node render.cjs --cues                        # export the audio cue list from the timeline
python3 audio.py out/cues.json out/soundtrack.wav
node render.cjs --samples "${SAMPLES:-8}"     # 1080p60, motion-blurred, muxed
node render.cjs --samples 16 --stills 14.38 >/dev/null
cp out/stills/t14.380.png poster.png            # committed: the README thumbnail
"${FFMPEG:-ffmpeg}" -loglevel error -y -i out/agicends-showreel.mp4 \
    -vf "fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=full[p];[b][p]paletteuse=dither=none" \
    out/agicends-showreel-preview.gif
echo "done → out/agicends-showreel.mp4, out/agicends-showreel-preview.gif, poster.png"
