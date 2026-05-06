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

To test multiplayer locally, open the same URL in a second browser tab (or a private/incognito window). Each tab is a separate player. To test from another device on your network, find your local IP (e.g. `192.168.1.42`) and visit `http://192.168.1.42:2567/` from your phone — the server accepts connections from any host on the LAN by default.

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

Each match cycles through three states, tracked server-side as `match.roundState`:

1. **`countdown`** — fresh world has been generated, players are at start position, no gravity, no spike rise, flap input ignored. A big number ticks down on the client (`COUNTDOWN_SECONDS`, currently 3 for testing — bump up for release). When the timer reaches 0, transitions to running.
2. **`running`** — normal gameplay. Spikes rise, polygons spawn, players flap and die.
3. **`round_over`** — entered when all currently-connected players are dead. Spikes stop rising, leaderboard overlay appears on each client showing all player scores ranked descending. Each client has a READY button. The first ready vote received calls `resetMatch`, which wipes the world and transitions back to countdown. Subsequent ready votes during the same round-over are ignored.

The first match starts in countdown, not running, so the first player to connect gets the same grace period as everyone else after a reset.

If all players disconnect during round-over, the server auto-resets so the next joiner gets a clean room.

---

## Wire format

Three message types from server to client:

- **`welcome`** (sent once on connect): `{ type, sessionId }`. The session ID lets the client identify itself in subsequent snapshots.
- **`world_init`** (sent on connect AND on every round reset to all clients): `{ type, blocks, coins, sideWallSegments, pentagons, hexagonPairs, heptagons, octagons, projectiles }`. Full snapshot of current world state. The client's `applyWorldInit` detects existing visual state (from a previous round) and wipes everything before rebuilding.
- **`snapshot`** (sent every tick to every client): `{ type, tServer, spikeY, hasStarted, hazardSpeed, roundState, countdownRemainingMs, finalScores, players, ...newX/removedX deltas, blockScales, pentagonStates, hexagonPairStates, heptagonStates, octagonStates, projectileStates, events }`.
  - `players` is keyed by session ID with `{ x, y, vx, vy, alive, facingRight, score, stunned }`.
  - `newX` / `removedXIds` arrays carry per-tick deltas for blocks, coins, side walls, polygons, projectiles.
  - `blockScales` is sparse — only contains blocks whose scale just changed this tick (the client persists scale across snapshots).
  - The `polygonStates` maps carry per-tick position/velocity for moving polygons (pentagons, heptagons, projectiles) and animation state for the hexagon firing cycle.
  - `events` is an array of one-time things this tick (`coin_collected`, `hit`, `interval_reached`, `death`) that the client uses to trigger FX. The `hit` events carry a `playerId` so the client only camera-shakes for own hits.

Two message types from client to server:

- **`flap`**: `{ type: 'flap' }`. Server only honors during `running`.
- **`ready`**: `{ type: 'ready' }`. Server only honors during `round_over`. First one received resets the match.

---

## Server: `server/server.js`

### Constants block (`SIM`)

These are the numbers that define the game's feel. Most match single-player AGISCEND exactly:

- `GRAVITY: 1600` — pixels/second² downward acceleration.
- `JUMP_FORCE: 650` — upward velocity applied on each flap.
- `HORIZONTAL_SPEED: 400` — horizontal velocity applied on each flap (alternates left/right per flap).
- `MAX_FALL_SPEED: 800` — terminal velocity; gravity stops accumulating beyond this.
- `MAX_VX: 800`, `MAX_VY: 2000` — single global velocity caps applied after every flap, gravity step, and bounce. Without these, multi-bounce sequences (wall + block at the same time) stack speed exponentially and the player tunnels out of the playable area. We chose `MAX_VY: 2000` over the single-player `2400` because the 35 px walls vs 33 px/tick at 2000 vy gives us a safety margin against tunneling. Clipping through beams at extreme speeds is acceptable expression of skill; clipping through walls is not.
- `WALL_THICKNESS: 35` — width of the side walls and side-wall collision band.
- `OBSTACLE_SIZE: 45` — used for spacing calculations and as the coin display size.
- `BLOCK_RENDER_SIZE: 90` — the actual rendered size of obstacle blocks.
- `FLAP_COOLDOWN_MS: 200` — minimum time between flaps from the same player.
- `HAZARD_BASE_SPEED: 120` — initial spike rise rate in pixels/second.
- `HAZARD_INCREASE: 20` — added to spike speed each time the player crosses a multiple-of-4 interval. Doubled from single-player's 10 to compensate for the bigger world (more players, more chaos).
- `SPIKE_INITIAL_OFFSET: 50` — how far below the canvas the spike top edge starts.
- `START_Y_OFFSET: 200` — how far above canvas bottom the player spawns.
- `PLAYER_RADIUS: 30` — radius of the player's circular collision body.
- `PLAYER_BOUNCE: 2.0` — bounce coefficient on collisions. Reflected velocity = incoming velocity × `(1 + bounce)` for blocks, or × `(1 + bounce × 0.5)` for walls.
- `BASE_INTERVAL: 5000` — vertical distance in pixels between interval barrier rows.
- `EXCLUSION_RADIUS: 200` — no obstacles spawn within this distance of an interval barrier row.
- `COIN_HITBOX_MULTIPLIER: 2` — coin pickup radius is doubled relative to the visual size for forgiving collection.
- `BLOCK_MIN_DIST: 80`, `COIN_MIN_DIST: 40` — minimum spawn separation when placing random items in a chunk.
- `BASE_BLOCK_RATE: 2` — blocks per chunk are calculated as `BASE_BLOCK_RATE × (1 + blockCyclePosition)` where cycle position is 1–4. Rotates through 4, 6, 8, 10 blocks per chunk across each set of four intervals.
- `STUN_DURATION_MS: 400` — after hitting a beam or heptagon, flapping is disabled for this long.
- `STUN_KNOCKBACK_BOOST: 2.0` — beam/heptagon hits also multiply the bounce velocity by this much.
- `COUNTDOWN_SECONDS: 3` — pre-round grace window. Set to 10 for production.

Per-polygon configs live in `SIM.PENTAGON`, `SIM.HEXAGON`, `SIM.HEPTAGON`, `SIM.OCTAGON`. Each carries `startInterval` (which interval they begin spawning at), `spawnRate` (per-interval count range), `size`, and type-specific behavior parameters (firing duration, beam height, swarm count, projectile speed, etc.).

### World generation

Server generates the world incrementally as the highest player rises. The function `generateChunks(world, targetY, elapsedMs)` produces one screen-tall chunk at a time until the world extends at least 1.5 screen heights above the highest player. During countdown, this is called with the start position so the first round looks fully populated when the player can act. During running, it's called each tick with the current highest player y.

Each chunk:
1. Adds side-wall segments at every `WALL_THICKNESS` pixel step (for visual rendering on the client).
2. Spawns any interval barrier rows (full row of blocks + coin columns above) that fall within this chunk's altitude range.
3. Spawns a number of random blocks based on the current cycle position (4 / 6 / 8 / 10).
4. Spawns a number of random coins scaled by the current interval number (8 × interval per full interval).
5. Possibly spawns one or more polygons via `maybeSpawnPolygonObstacle`, gated by each polygon type's `startInterval`.

Block, coin, side-wall, and polygon objects are tracked in `world.blocks`, `world.coins`, etc. Each tick, only the **new** items added that tick are accumulated in `world.newBlocks`, `world.newCoins`, etc., and broadcast incrementally to clients. Removed items (collected coins, destroyed blocks, off-screen polygons) are tracked the same way.

### Per-tick delta arrays

The world's `newX` / `removedXIds` arrays are reset at the top of every `step()` call via `resetTickDeltas(world)`. This guarantees that anything generated during this tick goes into a fresh delta and is sent exactly once. Critical for the countdown phase: without this reset, the same `newBlocks` populated by countdown's first generateChunks call would re-broadcast every tick for the entire countdown duration, causing clients to spawn duplicate sprites for every entity (see "Visual artifact bug history" further down).

The delta arrays are also reset after sending `world_init` to all clients during a round reset, since `world_init` already carries the full world state — including those arrays again in the snapshot would cause the same double-spawn bug, just on the reset tick instead of every countdown tick.

### Simulation step (`step(match, deltaSeconds)`)

Branches on `match.roundState`:

- **`round_over`**: advance the wall clock, return.
- **`countdown`**: generate chunks around the start position, tick the countdown timer, transition to running when timer expires.
- **`running`**: full simulation. For each alive player: apply queued flap if cooldown allows, gravity, position integration, wall clamp + bounce, velocity clamp, coin pickup, block collision (SAT-style with shrink-on-hit), pentagon/hexagon/heptagon/octagon collision, hexagon beam check (with stun + knockback boost), projectile collision, spike-line death check.

After the player loop, the server cleans up entities below `match.spikeY + 600`, increments `match.nextIntervalIndex` if the highest player has crossed it (and adjusts `hazardSpeed`), and checks the round-over condition (`hasStarted && roundState === RUNNING && anyPlayers && !anyAlive`).

### Session naming

`newSessionId(match)` scans existing player IDs for the smallest unused integer prefix and reuses it. So a player who refreshes their browser will likely get the same `p1` / `p2` label they had before, and player numbers stay tight even across many reconnects. Each ID is suffixed with a 4-character random tag so reconnecting players still get a unique full ID for tracking purposes.

---

## Client: `client/index.html`

### Constants block (mirror of server)

The client has its own copy of `SIM` (gravity, jump force, etc.) **for prediction purposes only**. These must match the server's values exactly. If they drift, the client's predicted state diverges from the server and you'll see constant micro-corrections in your own player. When changing physics, change both.

The client also has rendering-specific constants:

- `CANVAS_WIDTH: 720`, `CANVAS_HEIGHT: 1080` — Phaser logical canvas size.
- `WORLD_HEIGHT_UP: 10000000` — camera bounds extend this far upward to support long ascents without the camera-stop bug.
- `SIDE_WALL_DISPLAY_SIZE: WALL_THICKNESS * 0.9` — side wall segments render at 90% of the wall thickness, giving a small gap between adjacent stacked tiles.
- `SPIKES_LABEL: '💀'` — emoji used on the proximity indicator for the spike line.
- `PROXIMITY_TRIANGLE_SIZE: 22`, `PROXIMITY_EDGE_MARGIN: 22`, `PROXIMITY_TEXT_LINE_HEIGHT: 18`, `PROXIMITY_X_CLAMP_MARGIN: 50` — proximity indicator layout.

### Prediction tuning (your own player)

- `RECONCILE_LERP: 0.15` — per-frame lerp factor for pulling predicted **position** toward the server's authoritative position. Higher = corrections snap into place faster (more responsive but visible jitter on disagreement). Lower = smoother corrections (rubber-bandy at high latency).
- `RECONCILE_VEL_LERP: 0.08` — per-frame lerp factor for **velocity** corrections. Lower than position because velocity disagreements are usually transient.
- `POST_FLAP_VEL_GRACE_MS: 150` — after each local flap, velocity reconciliation is **skipped** for this many milliseconds. Prevents shimmer during continuous flapping when the server's snapshot for the previous flap arrives after the new flap has already been applied locally.

We tried more sophisticated reconciliation strategies (deadband, snap-to-server-on-large-disagreement, full client-side collision) earlier in development. All of them produced harsher visual artifacts than this simple lerp, so we reverted. The precision-vs-smoothness tradeoff is real; we're choosing smoothness.

The flow each frame for *your own* player:
1. Read input (pointer/space). If held AND `roundState === 'running'`, `applyFlapToMyState()` updates predicted vx/vy locally and `sendFlap()` notifies the server.
2. `stepMyState(dt)` runs gravity, position integration, and wall bouncing on the predicted state. **No obstacle collision** — the server is the authority for collisions.
3. `reconcileMyState()` lerps predicted position toward the latest server target. Velocity also lerped, but skipped during the post-flap grace window.
4. Set sprite/eyes position from the predicted state.

### Interpolation tuning (other players)

- `INTERP_DELAY_MS: 100` — other players are rendered 100 ms behind real-time. Their sprite is positioned by interpolating between the two server snapshots that bracket "render time = `latestServerTime - INTERP_DELAY_MS`". Larger = smoother, more visibly delayed; smaller = sharper, more vulnerable to jitter.
- `INTERP_BUFFER_MAX_AGE_MS: 500` — drop snapshot history older than this.

### Polygon dead-reckoning

Pentagons, heptagons, and projectiles move every frame, but server snapshots only update their positions every tick. To smooth visual motion, the client extrapolates each polygon's position using its last known velocity and the time since the last snapshot, capped at 50 ms. Hexagons don't move (they're wall-mounted) so they update only on snapshot arrival.

### Round lifecycle UI

- During `countdown`: a big number in the center of the screen ticks down from `COUNTDOWN_SECONDS`, then briefly shows "GO!" before disappearing. Each new number gets a small pulse-in animation.
- During `running`: normal HUD — score in top center, proximity indicators on screen edges for off-screen players and the spike line.
- During `round_over`: full-screen overlay with "GAME OVER" title, leaderboard listing every connected player's session ID and final score (with `(you)` marker for self), and a READY button. Clicking READY sends the message and changes the button to "WAITING..." for visual feedback.

When `world_init` arrives mid-conversation (after a server-side reset), the client calls `resetAllVisualState` to wipe all sprites, interp buffers, latest data caches, and overlays before applying the fresh world.

### Proximity indicators

Pool-based reusable indicators that show off-screen players and the spike line on the screen edges. Each indicator is a triangle (white fill, black outline) plus two text lines. Layout:

- Target above the visible area → triangle at top of screen pointing up, distance line below it, then name line.
- Target below the visible area → triangle at bottom pointing down, name line above it, then distance line, then triangle.
- Spike line uses 💀 instead of a player name.

### Visual identity (preserved 1:1 from single-player)

Texture generation in `generateTextures()`:
- Player: 60×60 black filled circle, displayed at scale 1.2.
- Coin: 45×45 black filled triangle with 2 px white outline.
- Block: 90×90 rounded black square (24 px corner radius).
- Spike: 128×128 black filled triangle, used as the texture for 16 individual spikes in the spike container.
- Particle: 8×8 black square, used for collision burst FX.
- Polygons: pentagon (filled black, 240 px), hexagon (black with white outline, 100 px), heptagon (black with white outline, 64 px), octagon (black with white outline, 135 px). Each generated procedurally using the corresponding number of vertices on a circle.
- Proximity triangle: 22×22 white filled triangle with black outline.
- Background: two cathedral-arches patterns generated procedurally as canvas textures (1024×2048, transparent canvas with gray architecture drawn directly — no per-pixel post-processing pass), used as TileSprites at scroll factors 0.1 and 0.3 for parallax.

Player visuals are a Phaser image (the body) plus a container with two ellipse "eye whites" with black outlines and two narrow rectangle "slit pupils." Eyes look toward the player's velocity, with smoothing over multiple frames. Other players render at 0.65 alpha to be visually distinct from yourself.

The spike container holds a 50,000 px-tall black background rectangle (the "abyss" — covers ~150 seconds of post-death watching at max spike speed) plus 16 individual spike triangles that undulate using `sin((time / 200) + idx) * 10` for the shimmering effect.

### Music

21-track shuffled playlist hosted at `https://agiscend.loiyaa.com/assets/track_NN.mp3`. Music starts on the first flap (must be after a user gesture per browser autoplay rules). 4 seconds of silence between tracks. Pauses on tab visibility change, resumes when the tab is visible again.

### FX hooks

Triggered by server events:
- `coin_collected` → dual expanding shockwaves (white + black, slightly delayed) at the coin position. Shown to all clients.
- `hit` → 10 black particles burst from the contact point. Shown to all clients. Camera shake **only for own hits** — checked via `ev.playerId === mySessionId`.
- `interval_reached` → screen flash white for 300 ms.

Triggered by client-side detection:
- Flap squish-stretch animation (chained Phaser tween: stretch → counter-squish → settle with elastic ease).
- Score popup tween when score increases.
- Remote players' flap juice fires when their interpolated `vx` changes sign — visually correct timing relative to the rendered position.

---

## Common edits

### Tweaking physics feel

Change values in **both** `server.js` `SIM` and `client/index.html` `SIM`. Restart server, refresh client. Common adjustments:

- Make the player heavier: increase `GRAVITY`.
- Stronger jumps: increase `JUMP_FORCE`.
- Wider lateral travel per flap: increase `HORIZONTAL_SPEED`.
- Slow down the spike chase: lower `HAZARD_BASE_SPEED` or `HAZARD_INCREASE`.
- More forgiving flap timing: lower `FLAP_COOLDOWN_MS`.

### Tweaking countdown duration

Change `SIM.COUNTDOWN_SECONDS` in `server.js` (currently 3 for testing). Restart server. Client picks it up automatically via the `countdownRemainingMs` field of each snapshot.

### Tweaking visuals

Edit `client/index.html` only. Refresh browser. Common adjustments:

- Change colors: edit the `COLORS` object near the top.
- Make other players more/less visible: change the `setAlpha(0.65)` calls in `createPlayerVisual`.
- Wall tile separation: change the `0.9` multiplier in `SIDE_WALL_DISPLAY_SIZE`.
- Change the spike-line indicator label: edit `SPIKES_LABEL`.

### Tweaking netcode

If gameplay feels off:
- "My own player feels laggy" → increase `RECONCILE_LERP`, or shorten `POST_FLAP_VEL_GRACE_MS`.
- "Other players look choppy" → increase `INTERP_DELAY_MS`. The cost is more visible lag.
- "Other players look too far behind" → decrease `INTERP_DELAY_MS`. The cost is more vulnerability to network jitter.
- "My own player rubber-bands at high ping" → lower `RECONCILE_LERP` for gentler corrections.

### Adding a new client-to-server input

1. Client: send a new message type via `ws.send(JSON.stringify({ type: 'whatever', ...args }))`.
2. Server: add a branch in `ws.on('message', ...)` to handle it.

### Adding a new server-to-client event

1. Server: push to `match.eventsThisTick` with a `type` and any data: `{ type: 'cool_thing', x, y, ... }`.
2. Client: in the `applySnapshot` events loop, add an `else if (ev.type === 'cool_thing')` branch that triggers your visual or audio response.

### Adding a new polygon obstacle type

1. Server: add a new entry to `SIM` with `startInterval`, `spawnRate`, `size`, and any behavior config. Add a `spawnFooSprite` function. Add a branch in `maybeSpawnPolygonObstacle`. Add a per-tick update loop in `step()`. Add collision handling in the player loop. Add cleanup in the cleanup pass.
2. Server: add to `buildWorldInit` and `buildSnapshot`.
3. Client: generate the texture in `generateTextures`. Add `spawnFooSprite`. Add `fooSprites` map in the constructor. Handle `newFoos`, `removedFooIds`, and `fooStates` in `applySnapshot`. Add cleanup in `resetAllVisualState`.

---

## Internet testing with ngrok

To play with friends across the internet without setting up DNS or a real server, ngrok creates a temporary public URL that tunnels to your local server.

1. Install ngrok from https://ngrok.com/download. Sign up for a free account to get an auth token.
2. Run `ngrok config add-authtoken <YOUR_TOKEN>` once.
3. Start the AGISCENDS server normally (`cd server && npm start`). Confirm it works at `http://localhost:2567/`.
4. In a second terminal, run `ngrok http 2567`. Ngrok prints a "Forwarding" URL like `https://abc123.ngrok-free.app -> http://localhost:2567`.
5. Share the `https://abc123.ngrok-free.app` URL with your friends. They paste it in their browser and connect.

A few things to know:

- **The URL changes every time you restart ngrok.** Free ngrok sessions get a random subdomain. If you want a stable URL, the paid tier offers reserved domains.
- **HTTPS works automatically.** ngrok presents a real TLS certificate to the browser and decrypts the traffic before forwarding to your local server. The client's WebSocket code already uses `wss:` when the page is loaded over `https:`, so this just works.
- **Session length on the free tier.** Sessions are limited to 8 hours and 1 ngrok agent at a time per account. For longer testing, restart the agent and share the new URL.
- **Latency.** ngrok routes traffic through their cloud, so your friends will have higher ping than direct connections. Usually fine for testing — the netcode is built to tolerate ~100 ms latency. If you see noticeable rubber-banding, that's the prediction reconciliation doing its job over a slower link.
- **Bandwidth.** The server sends roughly one snapshot per tick per client (~5–10 KB JSON each at 60 Hz, so ~300–600 KB/sec per connected client). Through ngrok this counts against your upstream. For 2–4 friends testing together, this is fine on residential broadband. For more or longer sessions, consider deploying to a real server.
- **Firewall / NAT.** ngrok doesn't need any port forwarding because it's an outbound tunnel from your machine. As long as your local server runs and your machine has internet, friends can connect.

When you're done, `Ctrl+C` the ngrok terminal to close the tunnel.

---

## Troubleshooting

**Port 2567 in use.** An old server process is still running. macOS/Linux: `lsof -ti:2567 | xargs kill`. Windows: `netstat -ano | findstr 2567` then `taskkill /F /PID <pid>`.

**Browser shows white screen.** Open devtools (F12), check console. Common causes: server not running, Phaser CDN didn't load, JavaScript error in your edits. Status text in the top-left corner usually tells you the connection state.

**"connecting..." forever.** Server isn't running, or it's on a different port. Should be on `localhost:2567`. Check the server terminal.

**Other players' sprites stutter.** `INTERP_DELAY_MS` may be too low for current network conditions. Try increasing it to 150 or 200.

**Edits to server aren't taking effect.** Did you restart the server? It does not auto-reload. `Ctrl+C` then `npm start`.

**Friend on another device can't connect (LAN).** Make sure their device is on the same network and that your firewall isn't blocking incoming connections on port 2567. On Windows, the first time you run the server, you may get a Windows Defender prompt asking to allow Node.js network access — say yes.

**Server crashes silently.** Re-run `npm start`. If it crashes again, the terminal will show a red stack trace pointing at the offending line.

**Visual glitches at the start of a round (ghost blocks/coins, no collision on them).** This was a real bug that's now fixed — the server was double-broadcasting world contents on round reset, causing the client to spawn duplicate orphan sprites. If you see this again after major server changes, look for a path where world_init and a snapshot's `newBlocks` delta both carry the same entity in the same tick. The fix is to clear `world.newBlocks`/etc. immediately after sending world_init.

**Mobile performance feels rough.** Known but not yet investigated in depth. The cathedral background generation and the high snapshot rate are both candidates. Postponed until other features stabilize.

---

## Visual artifact bug history (for future reference)

Three related bugs have come and gone in this codebase, all rooted in the same family: per-tick delta arrays getting re-broadcast or under-broadcast. Documented here so we recognize the pattern next time:

1. **Countdown duplicate-spawn**: the COUNTDOWN branch of `step()` returned early without resetting the world's per-tick delta arrays. The first countdown tick populated `newBlocks` via `generateChunks`, and every subsequent tick broadcast the same `newBlocks` again. At 60Hz × 10s, every entity got 600 overlapping sprites client-side. Symptoms: coin "trail circles", blocks not visually shrinking when hit. Fix: hoist `resetTickDeltas(world)` to the top of `step()` so all branches start with empty deltas.

2. **Reset double-spawn**: when a round was reset via `resetMatch`, the next tick called `generateChunks`, populating `newBlocks`/etc. Then the tick loop sent `world_init` to all clients (carrying the full new world), then built and sent a snapshot — whose `newBlocks` still held the same entities just sent in `world_init`. Clients got every block twice: once from `world_init`, once from the snapshot delta. Symptoms: ghost blocks/coins around the start that you can see but not collide with. Fix: call `resetTickDeltas(match.world)` immediately after sending `world_init` so the snapshot built afterward has empty deltas.

3. **Sparse `blockScales` requires client persistence**: server only sends `blockScales` for blocks whose scale just changed, not for every damaged block every tick. The client must keep the previously-applied scale on screen for blocks not in the current snapshot's `blockScales`. The current `applySnapshot` only iterates the keys present, so it just works — but if you ever loop over all blocks and reset their scales, you'll resurrect this bug.

Pattern: any time the server has both an "I'm sending you the full state" message AND a "here's what changed" delta in the same tick, you must reset the deltas between them. Same pattern for any branched `step()` early-return.