# AGISCENDS

Multiplayer version of [AGISCEND](https://github.com/your-username/AGISCEND), an arcade ascent game. Up to 8 players per match. Two modes are planned:

- **ANGELS** — cooperative. Players climb the cathedral together, share score, revive each other at intervals.
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

## Status

Functional:

- [x] Authoritative server simulation at 60 Hz
- [x] WebSocket wire protocol with client-side prediction + interpolation
- [x] Multiple players per room
- [x] Side walls, blocks, coins, intervals, score
- [x] Pentagons (rotating drifting obstacles)
- [x] Hexagons (paired beam-firing obstacles)
- [x] Heptagons (wall-bouncing swarm obstacles)
- [x] Octagons (immobile shooters firing block projectiles)
- [x] Round lifecycle: countdown → running → round-over → ready vote → reset
- [x] Leaderboard on round-over screen
- [x] Off-screen proximity indicators (other players + spike line)
- [x] Music (21-track shuffled playlist with silence between tracks)

Backlog:

- [ ] ANGELS mode (cooperative, shared score, interval revives)
- [ ] DEVILS mode (competitive, highest-score wins)
- [ ] Lobby with explicit start-game vote, 60-second join window
- [ ] Real player names instead of session IDs
- [ ] Spectator camera (currently freezes on dead player position)
- [ ] Production deployment (DNS, HTTPS via reverse proxy, persistent service)
- [ ] Mobile performance investigation