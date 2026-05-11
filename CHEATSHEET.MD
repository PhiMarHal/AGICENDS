# AGISCENDS — Cheat Sheet

Reference document for everyday development. Lives at the project root.

---

## Project layout

```
AGISCENDS/
├── server/
│   ├── server.js       # the entire server: Express + WebSocket + simulation
│   ├── package.json    # dependencies (express, ws)
│   └── node_modules/   # installed packages — gitignored
├── client/
│   └── index.html      # the entire client: Phaser + WebSocket, plain JS
├── README.md
├── .gitignore
└── CHEATSHEET.md       # this file
```

Two folders, two main files. The server serves the client via Express, so when a player visits `http://yourserver:2567/`, the server responds with `client/index.html`. Same machine, same port, same connection. WebSocket traffic goes over the same port for real-time gameplay.

---

## Running the project

One terminal:

```
cd server
npm start
```

You should see `AGISCENDS server listening on http://localhost:2567/ (tick rate: 60 Hz)`. Open that URL in a browser to play. To stop the server, `Ctrl+C` in the terminal.

The server does **not** auto-restart on file changes. After editing `server.js`, stop and restart manually. After editing `client/index.html`, just refresh the browser tab — the server serves whatever's currently on disk.

To test multiplayer locally, open the same URL in a second browser tab (or a private/incognito window). Each tab is a separate player. To test from another device on your network, find your local IP (e.g. `192.168.1.42`) and visit `http://192.168.1.42:2567/` from that device — the server accepts connections from any host on the LAN by default.

To test with friends over the public internet, see "Internet testing with ngrok" near the bottom of this document.

### First-time setup

```
cd server
npm install
```

Pulls down the two dependencies (express, ws) and their transitive packages.

---

## The architecture in one paragraph

The server is the **authority** for everything that matters: physics, collisions, scoring, world generation, deaths, round lifecycle. It runs a 60 Hz simulation loop, mutating a global `match` state, and broadcasts a snapshot of that state to all connected clients every tick over WebSocket. The client is a thin renderer plus an input forwarder: it sends `{ type: 'flap' }` or `{ type: 'ready' }` messages to the server, and it draws what server snapshots tell it to draw. Two refinements sit on top: the client **predicts its own player's physics locally** so flaps feel instant (without waiting for the server round-trip), and **interpolates other players' positions** so their movement looks smooth despite snapshot jitter.

---

## Round lifecycle

The match cycles through four states, tracked server-side as `match.roundState`:

1. **`waiting`** — idle. No physics, no countdown. The client shows a **THE CITADEL AWAITS** overlay with a READY button. Any player may click READY to trigger the lobby.

2. **`countdown`** — 10-second join lobby. Triggered when the first player clicks READY (`resetMatch` + `beginCountdown` run atomically). The world is freshly generated and players are placed at spawn. A big countdown number ticks down. Any connected player can tap anywhere (or press Space) to join: the server adds them to `readyPlayers`. Players who join get their sprite at spawn immediately (`pendingInRound: true` in the snapshot). When the timer expires, all players in `readyPlayers` get `inRound = true` and the round starts. Max 8 players per round (`SIM.MAX_ROUND_PLAYERS`).

3. **`running`** — normal gameplay. Physics active, spikes rise, polygons spawn, players flap and die. Players who were not in `readyPlayers` when the countdown expired are spectators; they can also spectate by joining mid-round (they never get `inRound`). Dead in-round players transition to spectating 2 seconds after death.

4. **`round_over`** — entered when all `inRound` players are dead. Spikes stop rising, a leaderboard overlay appears (only in-round players shown). Any player clicking READY calls `resetMatch` + `beginCountdown`, returning to `countdown`.

Key server constants governing lifecycle:
- `SIM.READY_COUNTDOWN_SECONDS: 10` — lobby window duration.
- `SIM.MAX_ROUND_PLAYERS: 8` — maximum players who can be `inRound` simultaneously.
- `SIM.MAX_CONNECTIONS: 50` — hard WebSocket cap; connection #51 is rejected with code 1008.

### Spectator system

A connected player is a **spectator** whenever they are not `inRound`. This happens in three cases:
- They connected during or after `running` (never joined a countdown).
- The countdown ended before they clicked READY.
- They were `inRound` but have died (transition 2 seconds post-death).

Spectator behaviour:
- No sprite is created for them; they don't appear on anyone's proximity locator.
- The server sends `leadingPlayerY` and `leadingPlayerId` in every snapshot (the alive `inRound` player with the lowest Y / highest altitude). The spectator's camera lerps toward `leadingPlayerY`.
- The score counter on the spectator's HUD shows the leading player's score, not their own (which is always 0).
- A **Spectating** banner appears below the score counter.
- Client-side physics (`stepMyState`) is suppressed while spectating.

### Starting platform

`spawnStartingPlatform(world)` is called by both `makeMatch` and `resetMatch`. It places a full-width row of blocks at `startY + 160` (160 px below spawn, which is `CANVAS_HEIGHT / 2 + 160 = 700`). Players fall ~85 px before landing. The spike starts at `CANVAS_HEIGHT - SPIKE_INITIAL_OFFSET ≈ 980` and rises at ~80 px/s, so the platform is engulfed in roughly 3.5 seconds.

### Spawn position and camera origin

Players spawn at `x = CANVAS_WIDTH / 2`, `y = CANVAS_HEIGHT - START_Y_OFFSET`. With `START_Y_OFFSET = 540 = CANVAS_HEIGHT / 2`, spawn is at the vertical center of the canvas (`y = 540`). The camera's correct `scrollY` at spawn is therefore **0**. `resetAllVisualState` calls `cameras.main.setScroll(0, 0)` to guarantee this regardless of where the previous round ended.

World chunk generation starts at `lastChunkY = CANVAS_HEIGHT + 200 = 1280`, which is below the visible area. The first `generateChunks` call produces wall segments from y=1280 upward, covering the full viewport and the spawn zone. (If `lastChunkY` were set to spawn Y instead, the bottom half of the initial viewport would have no walls — a bug we fixed.)

---

## Wire format

### Server → client message types

**`welcome`** (once on connect):
```json
{ "type": "welcome", "sessionId": "p1_ab12" }
```
The session ID lets the client identify itself in subsequent snapshots.

**`world_init`** (on connect, and broadcast to all clients on every round reset):
```json
{ "type": "world_init", "blocks": [...], "coins": [...], "sideWallSegments": [...],
  "pentagons": [...], "hexagonPairs": [...], "heptagons": [...], "octagons": [...], "projectiles": [...] }
```
Full snapshot of current world state. The client's `applyWorldInit` wipes all visual state before rebuilding from this. Also resets the camera to scrollY=0 and clears the countdown-ready set.

**`snapshot`** (every tick, per-client):
```json
{
  "type": "snapshot",
  "tServer": 12340,
  "spikeY": 980,
  "hasStarted": true,
  "hazardSpeed": 80,
  "roundState": "running",
  "countdownRemainingMs": 0,
  "readyCount": 3,
  "readyPlayerIds": ["p1_ab12", "p2_cd34", "p3_ef56"],
  "leadingPlayerY": 210,
  "leadingPlayerId": "p2_cd34",
  "myReady": true,
  "finalScores": null,
  "players": {
    "p1_ab12": { "x": 360, "y": 480, "vx": 2.1, "vy": -5.3,
                 "alive": true, "facingRight": true, "score": 42,
                 "stunned": false, "inRound": true, "pendingInRound": false }
  },
  "newBlocks": [...], "removedBlockIds": [...],
  "newCoins": [...], "removedCoinIds": [...],
  "newSideWallSegments": [...], "removedSideWallSegmentIds": [...],
  "newPentagons": [...], "removedPentagonIds": [...],
  "newHexagonPairs": [...], "removedHexagonPairIds": [...],
  "newHeptagons": [...], "removedHeptagonIds": [...],
  "newOctagons": [...], "removedOctagonIds": [...],
  "newProjectiles": [...], "removedProjectileIds": [...],
  "blockScales": { "b_17": 0.7 },
  "pentagonStates": {...}, "hexagonPairStates": {...},
  "heptagonStates": {...}, "octagonStates": {...}, "projectileStates": {...},
  "events": [{ "type": "coin_collected", "x": 200, "y": 400 }]
}
```

Notable per-snapshot fields:

| Field | Notes |
|---|---|
| `players[id].inRound` | `true` only while the round is `running` and the player joined before the countdown ended. |
| `players[id].pendingInRound` | `true` during `countdown` for players already in `readyPlayers`. Clients use this to create sprites before the round starts. |
| `readyPlayerIds` | Array of session IDs currently in `readyPlayers`. Client diffs against a local set each snapshot to fire "[name] joined" notifications. |
| `myReady` | Per-client boolean (injected into the snapshot before sending). `true` if this client is already in `readyPlayers`. Client uses it to suppress the TAP TO JOIN prompt. |
| `leadingPlayerY` / `leadingPlayerId` | World Y and ID of the highest alive `inRound` player. Spectators use these for camera tracking and score display. |
| `finalScores` | Non-null only during `round_over`. Array of `{ id, score }` for `inRound` players only, sorted descending. |
| `blockScales` | Sparse — only blocks whose scale changed this tick. Client persists scale across snapshots. |
| `events` | One-time per-tick events: `coin_collected`, `hit`, `interval_reached`, `death`. `hit` carries `playerId` so the client only shakes camera for own hits. |

### Client → server message types

- **`flap`**: `{ type: 'flap' }`. Honored only during `running`, only if the sending player is `inRound`.
- **`ready`**: `{ type: 'ready' }`. Behavior depends on current `roundState`:
  - `waiting` or `round_over` → `resetMatch()` + `beginCountdown()` (first caller wins; subsequent callers during `round_over` are no-ops until a fresh lobby).
  - `countdown` → player is added to `readyPlayers` if not already present and the round isn't full (`MAX_ROUND_PLAYERS`).
  - `running` — ignored.

---

## Server: `server/server.js`

### Key constants (`SIM` object)

Physics (mirrored in client):
- `GRAVITY`, `JUMP_FORCE`, `HORIZONTAL_SPEED`, `FLAP_COOLDOWN_MS` — core player feel.
- `HAZARD_BASE_SPEED`, `HAZARD_INCREASE` — spike rise speed and per-interval acceleration.
- `WALL_THICKNESS: 35`, `CANVAS_WIDTH: 720`, `CANVAS_HEIGHT: 1080`.
- `START_Y_OFFSET: 540` — spawn is `CANVAS_HEIGHT - START_Y_OFFSET = 540` (vertical center). **Must match client.**

Lifecycle:
- `READY_COUNTDOWN_SECONDS: 10` — duration of the join lobby.
- `MAX_ROUND_PLAYERS: 8` — players who can be `inRound` per round.
- `MAX_CONNECTIONS: 50` — hard cap on WebSocket connections.
- `SPIKE_INITIAL_OFFSET: -100` — spike starts at `CANVAS_HEIGHT - 100 = 980` (just off the bottom).

World generation:
- `BASE_INTERVAL: 5000` — vertical distance between interval barrier rows.
- `EXCLUSION_RADIUS: 200` — no obstacles spawn within this radius above player spawn OR around interval barriers.
- `COIN_HITBOX_MULTIPLIER: 2` — coin pickup radius is doubled for forgiving collection.
- `BLOCK_MIN_DIST: 80`, `COIN_MIN_DIST: 40` — minimum spawn separation.
- `BASE_BLOCK_RATE: 2` — blocks per chunk cycle through 4/6/8/10 across four intervals.
- `STUN_DURATION_MS: 400`, `STUN_KNOCKBACK_BOOST: 2.0` — beam/heptagon stun parameters.

Per-polygon configs live in `SIM.PENTAGON`, `SIM.HEXAGON`, `SIM.HEPTAGON`, `SIM.OCTAGON`.

### World generation

`generateChunks(world, targetY, elapsedMs)` produces one screen-tall chunk at a time until the world extends at least 1.5 screen heights above the highest player. Initial `lastChunkY = CANVAS_HEIGHT + 200` ensures the first call covers the full viewport before anyone can move.

Each chunk:
1. Adds side-wall segments at every `WALL_THICKNESS` pixel step.
2. Spawns interval barrier rows (full block row + coin columns) that fall within the chunk's altitude range.
3. Spawns random blocks (4/6/8/10 per chunk, cycling).
4. Spawns random coins scaled by current interval number.
5. Possibly spawns polygon obstacles via `maybeSpawnPolygonObstacle`.

Block, coin, side-wall, and polygon objects are tracked in `world.blocks`, `world.coins`, etc. Each tick, only the **new** items added that tick are accumulated in `world.newBlocks`, etc., and broadcast incrementally to clients. Removed items are tracked the same way.

### Per-tick delta arrays

The world's `newX` / `removedXIds` arrays are reset at the top of every `step()` call via `resetTickDeltas(world)`. This guarantees that anything generated during this tick goes into a fresh delta and is sent exactly once.

The delta arrays are also reset after sending `world_init` to all clients during a round reset, since `world_init` already carries the full world state — including those arrays in the following snapshot would cause double-spawn.

### Simulation step (`step(match, deltaSeconds)`)

Branches on `match.roundState`:

- **`waiting`**: advance wall clock, return. No physics.
- **`round_over`**: advance wall clock, return. No physics.
- **`countdown`**: generate chunks around start position, tick countdown timer. When timer expires, set `inRound = true` for everyone in `readyPlayers`, set `hasStarted = true`, transition to `running`.
- **`running`**: full simulation. For each alive `inRound` player: apply queued flap if cooldown allows, gravity, position integration, wall clamp + bounce, velocity clamp, coin pickup, block collision (SAT-style with shrink-on-hit), pentagon/hexagon/heptagon/octagon collision, hexagon beam check (stun + knockback boost), projectile collision, spike-line death check.

After the player loop: clean up entities below `match.spikeY + 600`, increment interval index when the highest player crosses it (adjusting `hazardSpeed`), check round-over condition (`hasStarted && anyInRound && !anyInRoundAlive`).

### Session naming

`newSessionId(match)` scans existing player IDs for the smallest unused integer prefix. So a reconnecting player typically gets the same `p1` / `p2` label. Each ID is suffixed with a 4-character random tag so reconnecting players still get a unique full ID for tracking.

---

## Client: `client/index.html`

### Constants block (mirror of server)

The client has its own copy of `SIM` (gravity, jump force, etc.) **for prediction purposes only**. These must match the server's values exactly. If they drift, the client's predicted state diverges from the server and you'll see constant micro-corrections. When changing physics, change both.

The client also has rendering-specific constants:
- `CANVAS_WIDTH: 720`, `CANVAS_HEIGHT: 1080` — Phaser logical canvas size.
- `WORLD_HEIGHT_UP: 10000000` — camera bounds extend this far upward.
- `SIDE_WALL_DISPLAY_SIZE: WALL_THICKNESS * 0.9` — 90% of wall thickness, giving small gaps between tiles.
- `SPIKES_LABEL: '💀'` — proximity indicator label for the spike line.
- `PROXIMITY_TRIANGLE_SIZE: 22`, `PROXIMITY_EDGE_MARGIN: 22`, `PROXIMITY_TEXT_LINE_HEIGHT: 18`, `PROXIMITY_X_CLAMP_MARGIN: 50` — proximity indicator layout.

Round state constants (must match server):
```js
const ROUND_WAITING   = 'waiting';
const ROUND_COUNTDOWN = 'countdown';
const ROUND_RUNNING   = 'running';
const ROUND_OVER      = 'round_over';
```

### Round lifecycle UI

- **`waiting`**: THE CITADEL AWAITS overlay (dark, depth 200+). READY button (280×70) at `y = CANVAS_HEIGHT - 160`. Clicking sends `{ type: 'ready' }`.
- **`countdown`**: Overlay hides. Big countdown number at y=440. TAP TO JOIN prompt (400×100) at `y = CANVAS_HEIGHT - 160`. Any pointer tap or spacebar sends `{ type: 'ready' }` and hides the prompt. When a new player joins, a "[name] joined" text spawns at y=640, holds 1 s, then floats up 80 px while fading over 1 s. Players in `readyPlayerIds` get sprites at spawn (`pendingInRound: true`).
- **`running`**: normal HUD — score at top center, proximity indicators, spectator camera and banner for non-`inRound` players.
- **`round_over`**: GAME OVER overlay with leaderboard (in-round players only) and READY button.

### Player visibility rules

Only players where `p.inRound || p.pendingInRound` get a sprite and proximity locator entry. Pure spectators (`inRound: false`, `pendingInRound: false`) are skipped entirely in the player loop; any stale visual is destroyed on the spot.

### Prediction tuning (your own player)

- `RECONCILE_LERP: 0.15` — per-frame lerp for pulling predicted **position** toward server's authoritative position. Higher = faster corrections (more jitter). Lower = smoother (more rubber-band feel at latency).
- `RECONCILE_VEL_LERP: 0.08` — per-frame lerp for **velocity** corrections.
- `POST_FLAP_VEL_GRACE_MS: 150` — after each local flap, velocity reconciliation is skipped for this many ms, preventing shimmer when the snapshot for a previous flap arrives after a new flap has already been applied.

The flow each frame for *your own* player:
1. Read input (pointer/space). If pressed AND `roundState === 'running'` AND `!isSpectating`, `applyFlapToMyState()` updates predicted vx/vy locally and `sendFlap()` notifies the server.
2. `stepMyState(dt)` runs gravity, position integration, and wall bouncing. Returns early if `isSpectating`. **No obstacle collision** — server is authoritative.
3. `reconcileMyState()` lerps predicted position toward the latest server target.
4. Set sprite/eyes position from predicted state.

### Spectator camera

When `isSpectating` is true (either because `inRound: false` during `running`, or because the death-to-spectate timer fired):
- `cameras.main.stopFollow()` is called.
- Every `update()` frame: `cameras.main.scrollY` lerps toward `spectatorCameraY - CANVAS_HEIGHT / 2` at factor 0.05.
- `spectatorCameraY` is updated every snapshot from `snap.leadingPlayerY`.
- `spectatingPlayerId` (from `snap.leadingPlayerId`) drives the score display.
- A **Spectating** banner (32px bold, depth 100, scrollFactor 0) sits at y=70.

### Interpolation tuning (other players)

- `INTERP_DELAY_MS: 100` — other players rendered 100 ms behind real-time. Larger = smoother, more delayed; smaller = sharper, more vulnerable to jitter.
- `INTERP_BUFFER_MAX_AGE_MS: 500` — drop history older than this.

### Polygon dead-reckoning

Pentagons, heptagons, and projectiles move every frame but server snapshots only update their positions every tick. The client extrapolates each polygon's position using its last known velocity and time-since-last-snapshot, capped at 50 ms. Hexagons don't move (wall-mounted), so they update only on snapshot arrival.

### Visual identity

Texture generation in `generateTextures()`:
- **Player**: 60×60 black filled circle, displayed at scale 1.2.
- **Coin**: 45×45 black filled triangle with 2 px white outline.
- **Block**: 90×90 rounded black square (24 px corner radius).
- **Spike**: 128×128 black filled triangle, used for 16 individual spikes in the spike container.
- **Particle**: 8×8 black square, used for collision burst FX.

---

## Common edits

### Tweaking physics feel

Change values in **both** `server.js` `SIM` and `client/index.html` `SIM`. Restart server, refresh client. Common adjustments:

- Heavier player: increase `GRAVITY`.
- Stronger jumps: increase `JUMP_FORCE`.
- Wider lateral travel per flap: increase `HORIZONTAL_SPEED`.
- Slower spike chase: lower `HAZARD_BASE_SPEED` or `HAZARD_INCREASE`.
- More forgiving flap timing: lower `FLAP_COOLDOWN_MS`.

### Tweaking lobby duration

Change `SIM.READY_COUNTDOWN_SECONDS` in `server.js` (currently 10). Restart server. The client reads this from the `countdownRemainingMs` field of each snapshot automatically.

### Tweaking player cap

- `SIM.MAX_ROUND_PLAYERS` — how many players can be `inRound` simultaneously (default 8).
- `SIM.MAX_CONNECTIONS` — hard WebSocket cap (default 50). Connections beyond this are rejected with code 1008.

### Tweaking visuals

Edit `client/index.html` only. Refresh browser. Common adjustments:

- Colors: edit the `COLORS` object near the top.
- Other player opacity: change `setAlpha(0.65)` calls in `createPlayerVisual`.
- Wall tile separation: change the `0.9` multiplier in `SIDE_WALL_DISPLAY_SIZE`.
- Spike-line indicator label: edit `SPIKES_LABEL`.
- Spectator camera smoothness: change the `0.05` lerp factor in `update()`.
- Death-to-spectate delay: change the `2000` ms argument in the `delayedCall` inside `applySnapshot`.

### Tweaking netcode

- "My own player feels laggy" → increase `RECONCILE_LERP`, or shorten `POST_FLAP_VEL_GRACE_MS`.
- "Other players look choppy" → increase `INTERP_DELAY_MS`. Cost: more visible lag.
- "Other players look too far behind" → decrease `INTERP_DELAY_MS`. Cost: more jitter vulnerability.
- "My own player rubber-bands at high ping" → lower `RECONCILE_LERP` for gentler corrections.

### Adding a new client-to-server input

1. Client: `ws.send(JSON.stringify({ type: 'whatever', ...args }))`.
2. Server: add a branch in `ws.on('message', ...)`.

### Adding a new server-to-client event

1. Server: push to `match.eventsThisTick`: `{ type: 'cool_thing', x, y, ... }`.
2. Client: add `else if (ev.type === 'cool_thing')` in the `applySnapshot` events loop.

### Adding a new polygon obstacle type

1. Server: add to `SIM` (startInterval, spawnRate, size, behavior config). Add `spawnFoo`. Add branch in `maybeSpawnPolygonObstacle`. Add per-tick update loop in `step()`. Add collision handling. Add cleanup pass.
2. Server: add to `buildWorldInit` and `buildSnapshot`.
3. Client: generate texture in `generateTextures`. Add `spawnFooSprite`. Add `fooSprites` map in constructor. Handle `newFoos`, `removedFooIds`, `fooStates` in `applySnapshot`. Add cleanup in `resetAllVisualState`.

---

## Internet testing with ngrok

To play with friends across the internet without setting up DNS or a real server, ngrok creates a temporary public URL that tunnels to your local server.

1. Install ngrok from https://ngrok.com/download. Sign up for a free account to get an auth token.
2. Run `ngrok config add-authtoken <YOUR_TOKEN>` once.
3. Start the AGISCENDS server normally (`cd server && npm start`).
4. In a second terminal, run `ngrok http 2567`. Ngrok prints a "Forwarding" URL like `https://abc123.ngrok-free.app`.
5. Share that URL with your friends.

Things to know:

- **The URL changes every ngrok restart.** Free accounts get a random subdomain.
- **HTTPS works automatically.** The client's WebSocket code uses `wss:` when loaded over `https:`, so this just works.
- **Session length.** Free sessions are limited to 8 hours, 1 agent at a time. Restart to continue; share the new URL.
- **Latency.** ngrok routes through their cloud. Usually fine for testing — the netcode tolerates ~100 ms latency.
- **Bandwidth.** ~5–10 KB JSON per snapshot at 60 Hz per client = ~300–600 KB/sec outbound per player. Fine for 2–4 friends on residential broadband.
- **Firewall/NAT.** ngrok is an outbound tunnel — no port forwarding needed.

---

## Troubleshooting

**Port 2567 in use.** An old server process is still running. macOS/Linux: `lsof -ti:2567 | xargs kill`. Windows: `netstat -ano | findstr 2567` then `taskkill /F /PID <pid>`.

**Browser shows white screen.** Open devtools (F12), check console. Common causes: server not running, Phaser CDN didn't load, JavaScript error in your edits.

**Player doesn't move after joining.** Check that `myState.alive` is being set correctly — if it's initialised to `false` (e.g. because `p.inRound` was `false` at init time), `stepMyState` returns early and the player is frozen despite the server running their physics. The fix is to initialise from `p.alive` directly.

**Walls missing from the bottom half of the screen.** `lastChunkY` in `makeWorld` was set to spawn Y (540) instead of `CANVAS_HEIGHT + 200` (1280). `generateChunks` works upward from `lastChunkY`, so anything below it gets no wall segments on the first call.

---

## Visual artifact bug history

Documented here so we recognise the pattern next time:

1. **Countdown duplicate-spawn**: the `countdown` branch of `step()` returned early without resetting the world's per-tick delta arrays. The first countdown tick populated `newBlocks` via `generateChunks`, and every subsequent tick broadcast the same `newBlocks` again. At 60 Hz × 10 s, every entity got 600 overlapping sprites client-side. Symptoms: coin "trail circles", blocks not visually shrinking when hit. Fix: hoist `resetTickDeltas(world)` to the top of `step()` so all branches start with empty deltas.

2. **Reset double-spawn**: when a round was reset, the next tick called `generateChunks`, populating `newBlocks`. Then the tick loop sent `world_init` to all clients (carrying the full new world), then built and sent a snapshot — whose `newBlocks` still held the same entities just sent in `world_init`. Clients got every block twice. Fix: call `resetTickDeltas(match.world)` immediately after sending `world_init`.

3. **Sparse `blockScales` requires client persistence**: server only sends `blockScales` for blocks whose scale just changed. If you ever loop all blocks and reset their scales client-side, you'll resurrect this bug.

4. **Ghost player / frozen self**: `myState.alive` was initialised from `p.inRound ? p.alive : false`. During `countdown` all players have `inRound: false`, so `myState.alive` started `false` and was never restored to `true`. `stepMyState` returned early forever; the server ran physics and sent score/particles for a player the client rendered frozen at spawn. Fix: always initialise from `p.alive` directly; use `isSpectating` to suppress physics for spectators.

5. **Missing walls below spawn**: `makeWorld` set `lastChunkY = CANVAS_HEIGHT - START_Y_OFFSET = 540`. `generateChunks` works upward, so wall segments below y=540 were never created. The bottom half of the initial viewport had no walls. Fix: `lastChunkY = CANVAS_HEIGHT + 200` so the first call covers from below the spike up through the world.

Pattern: any time the server has both a "full state" message AND a per-tick delta in the same tick, reset the deltas between them. Same applies to any branched `step()` early-return that skips `resetTickDeltas`.