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

You should see `AGISCENDS server listening on http://localhost:2567/`. Open that URL in a browser to play. To stop the server, `Ctrl+C` in the terminal.

The server does **not** auto-restart on file changes. After editing `server.js`, stop and restart manually. After editing `client/index.html`, just refresh the browser tab — the server serves whatever's currently on disk.

To test multiplayer locally, open the same URL in a second browser tab (or a private/incognito window). Each tab is a separate player. To test from another device on your network, find your local IP (e.g. `192.168.1.42`) and visit `http://192.168.1.42:2567/` from your phone — the server accepts connections from any host on the LAN by default.

### First-time setup

```
cd server
npm install
```

Pulls down the two dependencies and their transitive packages. ~15 small packages, mostly Express and ws internals.

---

## The architecture in one paragraph

The server is the **authority** for everything that matters: physics, collisions, scoring, world generation, deaths. It runs a 60 Hz simulation loop, mutating a global `match` state, and broadcasts a snapshot of that state to all connected clients every tick over WebSocket. The client is a thin renderer plus an input forwarder: it sends `{ type: 'flap' }` messages to the server when the player presses, and it draws what server snapshots tell it to draw. Two refinements sit on top: the client **predicts its own player's physics locally** so flaps feel instant (without waiting for the server round-trip), and **interpolates other players' positions** so their movement looks smooth despite snapshot jitter.

---

## Server: `server/server.js`

### Constants block (`SIM`)

These are the numbers that define the game's feel. Most match single-player AGISCEND exactly:

- `GRAVITY: 1600` — pixels/second² downward acceleration.
- `JUMP_FORCE: 650` — upward velocity applied on each flap.
- `HORIZONTAL_SPEED: 400` — horizontal velocity applied on each flap (alternates left/right per flap).
- `MAX_FALL_SPEED: 800` — terminal velocity; gravity stops accumulating beyond this.
- `MAX_VX`, `MAX_VY_UP`, `MAX_VY_DOWN` — hard velocity caps applied after every flap, gravity step, and bounce. Without these, multi-bounce sequences (wall + block at the same time) stack speed exponentially and the player tunnels out of the playable area. Mirrors single-player's `setMaxVelocity(800, 2400)`.
- `WALL_THICKNESS: 35` — width of the side walls and side-wall collision band.
- `OBSTACLE_SIZE: 45` — used for spacing calculations during interval-row generation and as the coin display size.
- `BLOCK_RENDER_SIZE: 90` — the actual rendered size of obstacle blocks (the rounded black squares scattered through the level).
- `FLAP_COOLDOWN_MS: 200` — minimum time between flaps from the same player. Naturally rate-limits continuous-press input on both sides.
- `HAZARD_BASE_SPEED: 120` — initial spike rise rate in pixels/second.
- `HAZARD_INCREASE: 10` — added to spike speed each time the player crosses a multiple-of-4 interval.
- `SPIKE_INITIAL_OFFSET: 50` — how far below the canvas the spike top edge starts.
- `START_Y_OFFSET: 200` — how far above canvas bottom the player spawns.
- `PLAYER_RADIUS: 30` — radius of the player's circular collision body.
- `PLAYER_BOUNCE: 2.0` — bounce coefficient on collisions. Reflected velocity = incoming velocity × `(1 + bounce)` for blocks, or × `(1 + bounce × 0.5)` for walls.
- `BASE_INTERVAL: 5000` — vertical distance in pixels between interval barrier rows.
- `EXCLUSION_RADIUS: 200` — no obstacles spawn within this distance of an interval barrier row.
- `COIN_HITBOX_MULTIPLIER: 2` — coin pickup radius is doubled relative to the visual size for forgiving collection.
- `BLOCK_MIN_DIST`, `COIN_MIN_DIST` — minimum spawn separation when placing random obstacles/coins in a chunk.
- `BASE_BLOCK_RATE: 2` — blocks per chunk are calculated as `BASE_BLOCK_RATE × (1 + blockCyclePosition)` where cycle position is 1–4. Rotates through 4, 6, 8, 10 blocks per chunk across each set of four intervals.

### World generation

Server generates the world incrementally as the highest player rises. The function `generateChunks(world, targetY)` produces one screen-tall chunk at a time until the world extends at least 1.5 screen heights above the highest player. Each chunk:

1. Adds side-wall segments at every `WALL_THICKNESS` pixel step (for visual rendering on the client).
2. Spawns any interval barrier rows (full row of blocks + coin columns above) that fall within this chunk's altitude range.
3. Spawns a number of random blocks based on the current cycle position (4 / 6 / 8 / 10).
4. Spawns a number of random coins scaled by the current interval number (8 × interval per full interval).

Block, coin, and side-wall objects are tracked in `world.blocks` (Map), `world.coins` (Map), and `world.sideWallSegments` (array). Each tick, only the **new** items added that tick are accumulated in `newBlocksThisTick`, `newCoinsThisTick`, etc., and broadcast incrementally to clients. Removed items (collected coins, destroyed blocks) are tracked the same way.

### Simulation step (`step(match, deltaSeconds)`)

Once per tick, for each alive player:

1. Apply queued flap input if cooldown allows.
2. Add gravity to vertical velocity.
3. Integrate position from velocity.
4. Wall clamp + bounce reflection on left/right walls.
5. Apply velocity caps via `clampVelocity()`.
6. Coin pickup: any coin within `(PLAYER_RADIUS + OBSTACLE_SIZE × 2 / 2)` is collected.
7. Block collision: SAT-style check against each block's AABB; on contact, push player out, reflect velocity along contact normal, increment block hit count. Blocks shrink 20% per hit, destroyed at 5 hits.
8. Spike death: if `p.y > match.spikeY`, set `alive = false`.

After the loop, the server checks if the highest player has crossed the next interval altitude and increments `match.nextIntervalIndex`, increasing hazard speed when crossing multiples of 4.

### Wire format

Server sends three message types:

- **`welcome`** (sent once on connect): `{ type, sessionId }`. The session ID lets the client identify itself in subsequent snapshots.
- **`world_init`** (sent once on connect): `{ type, blocks, coins, sideWallSegments }`. Full snapshot of the current world state so the client can render existing obstacles when they join mid-match.
- **`snapshot`** (sent every tick to every client): `{ type, tServer, spikeY, hasStarted, hazardSpeed, players, newBlocks, newCoins, removedBlockIds, removedCoinIds, newSideWallSegments, blockScales, events }`. Players is keyed by session ID with `{ x, y, vx, vy, alive, facingRight, score }`. Events is an array of one-time things this tick (`coin_collected`, `hit`, `interval_reached`) that the client uses to trigger FX.

The client sends one type:

- **`flap`**: `{ type: 'flap' }`. The server handles direction choice, cooldown, and effect.

---

## Client: `client/index.html`

### Constants block (mirror of server)

The client has its own copy of `SIM` (gravity, jump force, etc.) **for prediction purposes only**. These must match the server's values exactly. If they drift, the client's predicted state diverges from the server and you'll see constant micro-corrections in your own player. When changing physics, change both.

The client also has rendering-specific constants:

- `CANVAS_WIDTH: 720`, `CANVAS_HEIGHT: 1080` — Phaser logical canvas size.
- `SIDE_WALL_DISPLAY_SIZE: WALL_THICKNESS * 0.9` — side wall segments render at 90% of the wall thickness, giving a small gap between adjacent stacked tiles. The rounded corner radius of the block texture scales with display size, producing the "stacked tiles" look. Tweak this if you want walls to look more solid (toward 1.0) or more dotted (toward 0.7).

### Prediction tuning (your own player)

- `RECONCILE_LERP: 0.15` — per-frame lerp factor for pulling predicted **position** toward the server's authoritative position. Higher = corrections snap into place faster (more responsive but visible jitter on disagreement). Lower = smoother corrections (rubber-bandy at high latency). 0.15 is a good middle ground.

- `RECONCILE_VEL_LERP: 0.08` — per-frame lerp factor for **velocity** corrections. Lower than position because velocity disagreements are usually transient (the next snapshot resolves them anyway), and aggressive correction interferes with the predicted physics integration.

- `POST_FLAP_VEL_GRACE_MS: 150` — after each local flap, velocity reconciliation is **skipped** for this many milliseconds. This prevents the shimmer that would otherwise occur during continuous flapping: the flap toggles `vx` from +400 to -400 every ~200ms, but the server's snapshot for the previous flap arrives ~16-100ms after the new flap was already applied locally, so the lerp would briefly pull toward stale data. The window covers the round-trip for a single flap. Increase if you have noisy continuous-flap shimmer at higher latency, decrease if you notice velocity drift not getting corrected.

The flow each frame for *your own* player:

1. Read input (pointer/space). If held, `applyFlapToMyState()` updates predicted vx/vy locally and `sendFlap()` notifies the server. Both happen on the same frame.
2. `stepMyState(dt)` runs gravity, position integration, and wall bouncing on the predicted state. Same physics as the server.
3. `reconcileMyState()` lerps predicted position toward the latest server target. Velocity also lerped, but skipped during the post-flap grace window.
4. Set sprite/eyes position from the predicted state.

### Interpolation tuning (other players)

- `INTERP_DELAY_MS: 100` — other players are rendered 100 ms behind real-time. Their sprite is positioned by interpolating between the two server snapshots that bracket "render time = `latestServerTime - INTERP_DELAY_MS`". The 100 ms buffer absorbs network jitter and lets each frame find a clean bracketing pair regardless of when snapshots actually arrived. Larger = smoother, more visibly delayed; smaller = sharper, more vulnerable to jitter.

- `INTERP_BUFFER_MAX_AGE_MS: 500` — drop snapshot history older than this. Buffer cleanup. 500 ms is plenty of headroom.

The flow each frame for *each other* player:

1. When a snapshot arrives, push the player's data to their `interpBuffers` entry.
2. In `update()`, call `updateRemotePlayerVisuals()`. For each remote player, compute `renderTime = latestServerTime - 100`, walk the buffer to find the two surrounding samples, lerp position and velocity.
3. Set sprite/eyes position from the interpolated sample. Detect flap (vx sign flip) using the *interpolated* vx so squish-stretch fires at the visually correct moment.

### Visual identity (preserved 1:1 from single-player)

Texture generation in `generateTextures()`:
- Player: 60×60 black filled circle, displayed at scale 1.2.
- Coin: 45×45 black filled triangle with 2 px white outline.
- Block: 90×90 rounded black square (24 px corner radius). Same texture is used at full size for obstacles and at 90% × wall thickness for side wall segments.
- Spike: 128×128 black filled triangle, used as the texture for 16 individual spikes in the spike container.
- Particle: 8×8 black square, used for collision burst FX.
- Background: two cathedral-arches patterns generated procedurally as canvas textures, used as TileSprites at scroll factors 0.1 and 0.3 for parallax.

Player visuals are a Phaser image (the body) plus a container with two ellipse "eye whites" with black outlines and two narrow rectangle "slit pupils." Eyes look toward the player's velocity, with smoothing over multiple frames for an organic feel. Other players render at 0.65 alpha to be visually distinct from yourself.

The spike container holds a tall black background rectangle plus 16 individual spike triangles that undulate using `sin((time / 200) + idx) * 10` for the shimmering effect at the leading edge.

### FX hooks

Triggered by server events:
- `coin_collected` → dual expanding shockwaves (white + black, slightly delayed) at the coin position.
- `hit` → camera shake + 10 black particles bursting from the contact point.
- `interval_reached` → screen flash white for 300 ms.

Triggered by client-side detection:
- Flap squish-stretch animation (chained Phaser tween: stretch → counter-squish → settle with elastic ease).
- Score popup tween when score increases.

---

## Common edits

### Tweaking physics feel

Change values in **both** `server.js` `SIM` and `client/index.html` `SIM`. Restart server, refresh client. Common adjustments:

- Make the player heavier: increase `GRAVITY`.
- Stronger jumps: increase `JUMP_FORCE`.
- Wider lateral travel per flap: increase `HORIZONTAL_SPEED`.
- Slow down the spike chase: lower `HAZARD_BASE_SPEED`.
- More forgiving flap timing: lower `FLAP_COOLDOWN_MS`.

### Tweaking visuals

Edit `client/index.html` only. Refresh browser. Common adjustments:

- Change colors: edit the `COLORS` object near the top.
- Make other players more/less visible: change the `setAlpha(0.65)` calls in `createPlayerVisual()`.
- Wall tile separation: change `SIDE_WALL_DISPLAY_SIZE` multiplier.

### Tweaking netcode

If gameplay feels off:
- "My own player feels laggy" → increase `RECONCILE_LERP`, or shorten `POST_FLAP_VEL_GRACE_MS`.
- "Other players look choppy" → increase `INTERP_DELAY_MS`. The cost is more visible lag.
- "Other players look too far behind" → decrease `INTERP_DELAY_MS`. The cost is more vulnerability to network jitter (occasional position pops).
- "My own player rubber-bands at high ping" → lower `RECONCILE_LERP` for gentler corrections.

### Adding a new client-to-server input

1. Client: send a new message type via `ws.send(JSON.stringify({ type: 'whatever', ...args }))`.
2. Server: add a branch in `ws.on('message', ...)` to handle it.

### Adding a new server-to-client event

1. Server: push to `match.eventsThisTick` with a `type` and any data: `{ type: 'cool_thing', x, y, ... }`.
2. Client: in the `applySnapshot` events loop, add an `else if (ev.type === 'cool_thing')` branch that triggers your visual or audio response.

---

## Troubleshooting

**Port 2567 in use.** An old server process is still running. macOS/Linux: `lsof -ti:2567 | xargs kill`. Windows: `netstat -ano | findstr 2567` then `taskkill /F /PID <pid>`.

**Browser shows white screen.** Open devtools (F12), check console. Common causes: server not running, Phaser CDN didn't load, JavaScript error in your edits. Status text in the corner usually tells you the connection state.

**"connecting..." forever.** Server isn't running, or it's on a different port. Should be on `localhost:2567`. Check the server terminal.

**Other players' sprites stutter.** `INTERP_DELAY_MS` may be too low for current network conditions. Try increasing it to 150 or 200.

**Edits to server aren't taking effect.** Did you restart the server? It does not auto-reload. `Ctrl+C` then `npm start`.

**Friend on another device can't connect.** Make sure their device is on the same network and that your firewall isn't blocking incoming connections on port 2567. On Windows, the first time you run the server, you may get a Windows Defender prompt asking to allow Node.js network access — say yes.

**Server crashes silently.** Re-run `npm start`. If it crashes again, the terminal will show a red stack trace pointing at the offending line.

---

## What's deferred (backlog)

Features not yet implemented:
- Pentagons (rotating moving obstacles)
- Hexagons (paired laser-firing obstacles)
- Heptagons (wall-bouncing swarm obstacles)
- Octagons (immobile shooters firing block projectiles)
- Spike warning UI (the !/⚠ symbols when the chase gets close)
- Music
- Lobby system (start-game vote, 60-second countdown, spectator mode for joining mid-match)
- ANGELS mode (cooperative, shared score, interval revives)
- DEVILS mode (competitive, highest-score-wins)
- Production deployment (DNS, HTTPS via reverse proxy, persistent service)

These will arrive in future iterations as separate work passes.