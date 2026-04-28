# AGISCENDS

Multiplayer version of [AGISCEND](https://github.com/your-username/AGISCEND), an arcade ascent game. Up to 8 players per match. Two modes:

- **ANGELS** — cooperative. Players climb the cathedral together, share score, revive each other at intervals.
- **DEVILS** — competitive. Highest score wins. Triangles go to whoever touches them first. No revives.

Authoritative server architecture: physics, scoring, and obstacle generation run on a Node server; clients render and send inputs only.

## Stack

- **Server**: Node.js + Colyseus (`server/`)
- **Client**: Vite + Phaser 3 + Colyseus SDK (`client/`)
- **Shared**: Schema state definitions (`server/src/state/`, imported by both)

## Quick start

Two terminals:

```
cd server && npm start
cd client && npm run dev
```

Open `http://localhost:5173/` in a browser.

See `CHEATSHEET.md` for daily-development reference.

## Status

Work in progress. Currently functional:

- [x] Authoritative server simulation
- [x] Client renders server state
- [x] Multiple players per room
- [x] Schema-based state sync
- [ ] Client-side prediction & interpolation
- [ ] Obstacles (blocks, pentagons, hexagons, heptagons, octagons)
- [ ] Score, coins, intervals
- [ ] ANGELS mode
- [ ] DEVILS mode
- [ ] Production deployment