# AGICENDS development reference

This reference supersedes the original 8-player protocol notes. See README.md for setup and behavior changes.

## Commands (Node 24+)

```sh
cd server
npm ci
npm start
npm test
npm run benchmark
```

The game runs at localhost:2567. Optional `.env` retains the existing `AUTH_WORKER_URL` and `GAME_SERVER_SHARED_SECRET` settings. Worker commands remain in `worker/README.md`.

## Main tuning points

| Setting | Location | Value |
|---|---|---|
| Round cap | `client/simulation.js` → `SIM.MAX_ROUND_PLAYERS` | 16 |
| Player restitution | `SIM.PLAYER_RESTITUTION` | 1.0 |
| Environment bounce | `SIM.PLAYER_BOUNCE` | 2.0 |
| Circle radius | `SIM.PLAYER_RADIUS` | 30 |
| Physics step | `SIM.STEP_MS` | 1000/60 ms |
| World catch-up bound | `SIM.MAX_WORLD_SPAN` | 16000 units |
| Global real connections | `SIM.MAX_CONNECTIONS` | 80 (bots excluded) |
| Play publication interval | `server.js`, `every` | 3 physics ticks |
| Input timing lead | `client/prediction.js` | measured RTT, bounded |
| Distant-player interpolation | `index.html`, `INTERP_DELAY_MS` | 75 ms |
| Particle ceiling | `index.html`, `spawnParticles` | 128 |

`spreadLobby()` defines the two-row start layout; changing the cap further needs layout/HUD review. `fillLobby()` runs on human readiness changes, not on deaths. `updateBot()` drives ordinary held-input state; it does not bypass collisions or provide hidden buffs.

## Network contract

1. Server sends JSON `welcome` (protocol version 2), `roster`, and `world_init`.
2. Subsequent `roster` messages replace metadata when it changes. World initialization resets the client prediction history and visuals.
3. Binary snapshots have a 12-byte header, a UTF-8 JSON world/event section, and 48 bytes per player. All numbers are little endian. The codec owns these offsets; change both ends together.
4. Client sends JSON `{type:'input', roundId, seq, tick, held}` on transitions and every 250 ms while running. Inputs are processed at fixed ticks; a future scheduling window and sequence validation are enforced server-side.
5. Snapshots acknowledge each player's last applied input sequence. The browser replays remaining inputs and simulates known peers/world on the shared core. The visual correction offset never modifies authoritative/predicted physics state.
6. `ping`/`pong` JSON measures RTT. WebSocket control ping/pong verifies liveness. `ready` preserves round lifecycle behavior. `join_rejected` explains a full Angels round.

World deltas and events must only be cleared **after publication**, or after a complete replacement world has been sent. Never drop intermediate delta batches to reduce bandwidth. A slow connection is terminated when its pending send queue exceeds the bound; it must reconnect with a new full world.

## Simulation changes

Add physics in the shared module. Shared replay must not invoke server-only APIs, regenerate random world chunks, finalize stats, or resurrect players speculatively. `match.prediction` suppresses these authority-only transitions. Dynamic obstacle state needed by replay belongs in snapshots; new static objects belong in world initialization/deltas.

Always preserve tick-aligned cooldowns, deterministic contact order, fixed-step integration, and input sequence handling. Add meaningful regression cases under `server/test/` for changes affecting these behaviors.

## Release checks

- Run `npm test`; inspect `npm run benchmark` as a synthetic comparison only.
- Test a complete round and reset in both modes, including ghost powerups and Angels revival.
- Check touch/keyboard release, hidden tabs, packet stalls, and reconnect behavior.
- Confirm 16-position results are readable on phones.
- Measure actual frame times on target devices and RTT/correction behavior on a regional host.
- Publish matching client/server versions and the updated Worker; retain your private `.env` separately.
