# AGICENDS — 16-player multiplayer update

An authoritative Node server, Phaser browser client, and separate Cloudflare auth/stats Worker. Rounds have **16 participant slots**, filled by humans and basic server-controlled bots. No new production npm dependencies were added.

## Run locally

Use **Node.js 24 or newer**. Extract this project so `client`, `server`, and `worker` are sibling folders.

```sh
cd server
npm ci
npm start
```

Open `http://localhost:2567/`. The `.env` file is optional: without it, play is anonymous and results are not recorded. To retain authentication and statistics, use your existing `.env`, or copy `.env.example` to `.env` and supply your existing Worker settings. Never commit real secrets. `PORT` can override 2567.

## What changed

- **16 slots:** the first human READY starts the existing ten-second countdown. Bots fill vacancies; subsequent human READY clicks replace bots. Bots are clearly named `BOT 1`, etc. They use normal flap inputs and obey the same physics, obstacles, stun, powerups, and death rules. They are intentionally simple opponents, not pathfinding AI.
- **No endless refill:** bots fill the lobby, not every death. An abandoned room resets immediately when its last connection leaves. In Angels, a late joiner can replace a bot and enter the normal resurrection queue; otherwise the cap is enforced. Devils late arrivals still spectate.
- **Separated starts:** two rows of eight, 80 units apart horizontally and 140 vertically. Ghost/Second Wind phasing also bypasses player contacts.
- **Player bouncing:** equal-mass, symmetric circle impulses with restitution **1.0**, overlap resolution, deterministic coincident-center handling, and swept detection for players crossing between ticks. Existing obstacle bounce settings remain separate.
- **Shared physics:** `client/simulation.js` is used by both Node and the browser. Prediction includes known obstacles, moving hazards, pickups, and player interactions. The server remains authoritative for results and confirmed deaths.
- **Fixed timing:** 60 Hz physics uses a monotonic accumulator with bounded catch-up; no large variable physics step. Inputs carry a round ID, sequence number, held state, and intended simulation tick. The server acknowledges applied inputs. The client restores authoritative state and replays unacknowledged input, with a bounded prediction horizon and a separate visual correction offset.
- **Independent network frequency:** 20 Hz during play, 10 Hz during countdown, and 1 Hz while idle/over. Simulation steps retain their world changes and events until publication.
- **Compact protocol:** binary snapshots contain 48-byte player records plus a sparse JSON world/events header. Names/appearance are sent in a separate roster only when membership/metadata changes. Snapshot encoding happens once per room, not once per recipient. Scores remain in the compact motion record; the final score table is sent only after round end.
- **Interpolation:** distant players use a continuously advancing interpolation clock. Nearby players use the same predicted timeline as the local player. Unknown remote inputs can still cause corrections, especially at high RTT.
- **Bounded world:** old blocks, coins, and hazards are removed below the spike line; collision queries use vertical spatial buckets. Wall artwork uses a fixed camera-local pool rather than an ever-growing world list.
- **Crowd effects:** particle sprites are pooled with a 128-particle ceiling, off-screen effects are skipped, concurrent coin rings are capped, and skin textures are released between worlds. The result screen displays all 16 places in two columns.
- **Connection handling:** input size/rate limits, stale held-input timeout, WebSocket heartbeat, bounded send queues, and explicit connection-loss UI. Slow clients are disconnected instead of silently losing required world deltas. Reload reconnects them using the normal join/spectator rules.
- **Results:** bots remain anonymous result entries and never become Elo opponents. Elo K is normalized across authenticated opponents; database writes use a small number of SQL statements regardless of room size, with atomic rating deltas. No schema migration is needed for these changes.

## Gameplay choice for bounded memory

The spike line is now capped at **16,000 world units behind the leading live player** (`SIM.MAX_WORLD_SPAN`). This is a deliberate catch-up boundary: an extremely distant straggler can no longer keep arbitrarily old world content alive. Normal nearby play is unaffected; lagging farther than this boundary is lethal under the existing spike rules.

## Files

- `server/server.js`: Express/WebSocket transport, fixed-step scheduling, authentication, result submission.
- `client/simulation.js`: shared authoritative/predicted simulation, collisions, bots, lobby helpers, world deltas.
- `client/protocol.js`: version 2 binary snapshot encoder/decoder and roster definitions.
- `client/prediction.js`: acknowledged input history, authoritative reset/replay, clock lead.
- `client/index.html`: Phaser rendering, controls, menus and HUD.
- `client/character.js`, `client/creator.html`: character appearance system.
- `worker/`: existing Cloudflare auth/stats service; rating/result writing updated in `stats.js`.

## Verify

```sh
cd server
npm test
npm run benchmark
```

The tests exercise circle contacts, high-speed crossing, phasing, fixed flap cadence, bot filling and replacement, round resets, retained world deltas, cleanup, binary round-trips, input replay (including simulated 100 ms RTT), real WebSocket connections across both modes, and SQLite-backed result/Elo queries. The network test takes about 11 seconds because it exercises a real countdown.

`benchmark.cjs` reports synthetic CPU and snapshot payload measurements. It is not a browser FPS test or a promise about a particular hosting machine. Bots do not open WebSocket connections: a room with one human and 15 bots has only one recipient, unlike 16 human players.

## Deployment and remaining validation

Deploy **server + client together**: protocol v2 is incompatible with the old client. Deploy the updated Worker as well to activate normalized Elo and consolidated result writes. This package does not deploy anything or alter your live credentials/database.

Before public release, playtest both modes on desktop and mobile, including simultaneous bounces/deaths, resurrection, custom skins, and long rounds under real latency. Native Chromium could not run in the implementation environment, so browser rendering, touch controls, and sustained 60 FPS are **not certified** by the automated results. Production Cloudflare calls were not exercised; the result SQL was checked against local SQLite.
