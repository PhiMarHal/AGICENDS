# AGISCENDS

Multiplayer arcade ascent game. Up to 8 players per match. Two modes are planned:

- **ANGELS** — cooperative. Players climb the citadel together, share score, revive each other at intervals.
- **DEVILS** — competitive. Highest score wins. Triangles go to whoever touches them first. No revives.

Authoritative server architecture: physics, scoring, collisions, and obstacle generation run on a Node server; clients render and send inputs only.

## Stack

- **Server**: plain Node.js + Express + `ws` (`server/server.js`). Single file, no build step.
- **Client**: plain HTML + Phaser 3 from CDN, plain JS (`client/index.html`). Single file, no build step.
- **No shared module**: server and client maintain mirror copies of the physics constants. Match the values when changing physics.

The server serves the client over Express on port 2567. WebSocket traffic uses the same port. One process, one URL.

## Quick start

One terminal:

```
cd server
npm install   # first time only
npm start
```

Open `http://localhost:2567/` in a browser. Open additional tabs (or visit from a phone on the same LAN at `http://<your-ip>:2567/`) to test multiplayer.

See `CHEATSHEET.md` for daily-development reference.

## How a round works

1. Anyone arriving sees **THE CITADEL AWAITS** overlaid on the game world. A READY button sits at the bottom.
2. The first player to click READY opens a **10-second lobby**. A countdown number ticks down on screen; other players can tap anywhere (or press Space) to join. A "[name] joined" notification floats up for each joiner.
3. When the timer hits 0, the round starts immediately for everyone who joined. Late-comers become **spectators** — their camera follows the leading player automatically.
4. Play continues until all in-round players are dead, then a **GAME OVER** leaderboard appears with a READY button to start the next round.

Players who die mid-round transition to spectator view 2 seconds after death. The spectator camera follows the leading player and shows that player's score.

## Status

Functional:

- [x] Authoritative server simulation at 60 Hz
- [x] WebSocket wire protocol with client-side prediction + interpolation
- [x] Up to 8 players per round (hard cap); up to 50 WebSocket connections (spectators welcome)
- [x] Side walls, blocks, coins, intervals, score
- [x] Pentagons (rotating drifting obstacles)
- [x] Hexagons (paired beam-firing obstacles)
- [x] Heptagons (wall-bouncing swarm obstacles)
- [x] Octagons (immobile shooters firing block projectiles)
- [x] 4-state round lifecycle: waiting → countdown lobby → running → round-over
- [x] Ready/lobby system with 10-second join window and "[name] joined" notifications
- [x] Leaderboard on round-over screen
- [x] Off-screen proximity indicators (other players + spike line)
- [x] Music (21-track shuffled playlist with silence between tracks)
- [x] Spectator camera (follows leading player; activates on join-miss or 2 s after death)
- [x] Spectator score display (shows spectated player's live score)
- [x] Sprites visible during countdown lobby (ready players appear at spawn before round starts)
- [x] Camera snaps to spawn on each round reset

Backlog:

- [ ] ANGELS mode (cooperative, shared score, interval revives)
- [ ] DEVILS mode (competitive, highest-score wins)
- [ ] Real player names instead of session IDs
- [ ] Production deployment (DNS, HTTPS via reverse proxy, persistent service)
- [ ] Mobile performance investigation