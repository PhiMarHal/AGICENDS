// AGISCENDS server.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── auth + stats integration ────────────────────────────────────────────
// When both env vars are set, this server talks to the Cloudflare Worker
// at AUTH_WORKER_URL to (a) verify session tokens on WebSocket connect
// and (b) post match results at round end. Both must be set in
// production:
//   AUTH_WORKER_URL              — e.g. https://agiscends-auth.foo.workers.dev
//   GAME_SERVER_SHARED_SECRET    — must equal the secret of the same name
//                                  set in the Worker via `wrangler secret put`
// In local dev, leave them unset — everyone plays anonymously and no
// results get posted. The integration is fully bypassed when AUTH_WORKER_URL
// is missing, so there's nothing else to disable.
const AUTH_WORKER_URL = process.env.AUTH_WORKER_URL || null;
const GAME_SERVER_SHARED_SECRET = process.env.GAME_SERVER_SHARED_SECRET || null;
if (AUTH_WORKER_URL) {
    console.log(`[auth] integration enabled, worker = ${AUTH_WORKER_URL}`);
    if (!GAME_SERVER_SHARED_SECRET) {
        console.warn('[auth] GAME_SERVER_SHARED_SECRET not set — token verification will work, but match results will not be recorded.');
    }
} else {
    console.log('[auth] integration disabled — anonymous-only, no stat recording.');
}

const SIM = {
    CANVAS_WIDTH: 720,
    CANVAS_HEIGHT: 1080,

    GRAVITY: 1600,
    JUMP_FORCE: 650,
    HORIZONTAL_SPEED: 400,
    MAX_FALL_SPEED: 800,

    MAX_VX: 800,
    MAX_VY: 2000,

    WALL_THICKNESS: 35,
    OBSTACLE_SIZE: 45,
    BLOCK_RENDER_SIZE: 90,
    FLAP_COOLDOWN_MS: 200,

    HAZARD_BASE_SPEED: 80,
    HAZARD_INCREASE: 5,
    HAZARD_CHASE_BONUS: 200,
    HAZARD_CHASE_THRESHOLD: 1200,
    SPIKE_INITIAL_OFFSET: -100,

    // Players spawn at vertical center of the canvas — no singleplayer bottom-bias.
    // World generation also anchors from this point upward.
    START_Y_OFFSET: 540,           // was 200; now = CANVAS_HEIGHT / 2

    PLAYER_RADIUS: 30,
    PLAYER_BOUNCE: 2.0,

    BASE_INTERVAL: 5000,
    EXCLUSION_RADIUS: 200,

    COIN_HITBOX_MULTIPLIER: 2,

    BLOCK_MIN_DIST: 80,
    COIN_MIN_DIST: 40,
    BASE_BLOCK_RATE: 2,

    STUN_DURATION_MS: 400,
    STUN_KNOCKBACK_BOOST: 2.0,

    // Countdown seen by players once they click READY (10 s lobby window).
    READY_COUNTDOWN_SECONDS: 10,

    // Maximum participants per round. Extra connected clients spectate.
    MAX_ROUND_PLAYERS: 8,

    // Hard cap on simultaneous WebSocket connections (players + spectators).
    // Connections beyond this are rejected immediately.
    MAX_CONNECTIONS: 50,

    PENTAGON: {
        startInterval: 5,
        spawnRate: [2, 4],
        size: 240,
        moveSpeed: 80,
        rotationRange: 60,
        rotationSpeed: 0.001,
    },
    HEXAGON: {
        startInterval: 9,
        spawnRate: [2, 4],
        size: 100,
        fireDuration: 2000,
        rechargeDuration: 1000,
        spinDuration: 500,
        beamHeight: 36,
        beamPulseAmplitude: 5,
    },
    HEPTAGON: {
        startInterval: 13,
        spawnRate: [2, 4],
        size: 64,
        bounceSpeed: 400,
        fallSpeed: 186,
        swarmCount: 7,
    },
    OCTAGON: {
        startInterval: 17,
        spawnRate: [4, 8],
        size: 135,
        shootInterval: 2000,
        projectileSpeed: 300,
        range: 1000,
    },
};

const ROUND_WAITING = 'waiting';     // idle: waiting for first READY press
const ROUND_COUNTDOWN = 'countdown';   // 10-s lobby window after first READY
const ROUND_RUNNING = 'running';
const ROUND_OVER = 'round_over';

function clampVelocity(p) {
    if (p.vx > SIM.MAX_VX) p.vx = SIM.MAX_VX;
    if (p.vx < -SIM.MAX_VX) p.vx = -SIM.MAX_VX;
    if (p.vy > SIM.MAX_VY) p.vy = SIM.MAX_VY;
    if (p.vy < -SIM.MAX_VY) p.vy = -SIM.MAX_VY;
}

function randBetween(min, max) { return Math.random() * (max - min) + min; }
function randIntBetween(min, max) { return Math.floor(randBetween(min, max + 1)); }

let nextEntityId = 1;
function newId(prefix) { return prefix + (nextEntityId++); }

function makeWorld() {
    const intervalAltitudes = [];
    for (let n = 1; n <= 100; n++) intervalAltitudes.push(n * SIM.BASE_INTERVAL);
    // lastChunkY must sit *below* the visible canvas so generateChunks covers
    // the full viewport on its first call. Using CANVAS_HEIGHT + 200 matches
    // the pre-refactor value and ensures wall segments exist from the bottom of
    // the screen all the way up through the player-spawn area.
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    return {
        blocks: new Map(),
        coins: new Map(),
        pentagons: new Map(),
        hexagonPairs: new Map(),
        heptagons: new Map(),
        octagons: new Map(),
        projectiles: new Map(),
        sideWallSegments: [],
        intervalAltitudes,
        generatedIntervalBarriers: new Set(),
        lastChunkY: SIM.CANVAS_HEIGHT + 200,      // below screen → walls cover full viewport
        highestGeneratedY: SIM.CANVAS_HEIGHT + 200,
        newBlocks: [], newCoins: [],
        newPentagons: [], newHexagonPairs: [], newHeptagons: [], newOctagons: [],
        newProjectiles: [],
        removedBlockIds: [], removedCoinIds: [],
        removedPentagonIds: [], removedHexagonPairIds: [], removedHeptagonIds: [],
        removedOctagonIds: [], removedProjectileIds: [],
        dirtyBlockScales: new Set(),
    };
}

function resetTickDeltas(world) {
    world.newBlocks = []; world.newCoins = [];
    world.newPentagons = []; world.newHexagonPairs = []; world.newHeptagons = []; world.newOctagons = [];
    world.newProjectiles = [];
    world.removedBlockIds = []; world.removedCoinIds = [];
    world.removedPentagonIds = []; world.removedHexagonPairIds = []; world.removedHeptagonIds = [];
    world.removedOctagonIds = []; world.removedProjectileIds = [];
    world.dirtyBlockScales = new Set();
}

function isSpaceClear(world, x, y, minDist) {
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;

    // Keep a clear launch zone: no random blocks within EXCLUSION_RADIUS above spawn.
    if (y >= startY - SIM.EXCLUSION_RADIUS) return false;

    const minDistSq = minDist * minDist;
    for (const b of world.blocks.values()) {
        const dx = x - b.x, dy = y - b.y;
        if (dx * dx + dy * dy < minDistSq) return false;
    }
    const halfSq = minDistSq * 0.5;
    for (const c of world.coins.values()) {
        const dx = x - c.x, dy = y - c.y;
        if (dx * dx + dy * dy < halfSq) return false;
    }
    for (const p of world.pentagons.values()) {
        const dx = x - p.x, dy = y - p.y;
        const d = minDist + SIM.PENTAGON.size / 2;
        if (dx * dx + dy * dy < d * d) return false;
    }
    for (const h of world.heptagons.values()) {
        const dx = x - h.x, dy = y - h.y;
        const d = minDist + SIM.HEPTAGON.size / 2;
        if (dx * dx + dy * dy < d * d) return false;
    }
    for (const o of world.octagons.values()) {
        const dx = x - o.x, dy = y - o.y;
        const d = minDist + SIM.OCTAGON.size / 2;
        if (dx * dx + dy * dy < d * d) return false;
    }
    for (const intervalAlt of world.intervalAltitudes) {
        const intervalY = startY - intervalAlt;
        if (Math.abs(y - intervalY) < SIM.EXCLUSION_RADIUS) return false;
    }
    return true;
}

function spawnBlock(world, x, y) {
    const block = { id: newId('b'), x, y, hits: 0, scale: 1.0 };
    world.blocks.set(block.id, block);
    world.newBlocks.push(block);
    return block;
}
function spawnCoin(world, x, y) {
    const coin = { id: newId('c'), x, y };
    world.coins.set(coin.id, coin);
    world.newCoins.push(coin);
    return coin;
}

function spawnPentagon(world, x, y, spawnTime) {
    const p = {
        id: newId('pent'),
        x, y,
        vx: 0, vy: SIM.PENTAGON.moveSpeed,
        angle: 0,
        spawnTime,
    };
    world.pentagons.set(p.id, p);
    world.newPentagons.push(p);
    return p;
}

function spawnHexagonPair(world, y, spawnTime) {
    const wt = SIM.WALL_THICKNESS;
    const pair = {
        id: newId('hex'),
        leftX: wt,
        rightX: SIM.CANVAS_WIDTH - wt,
        y,
        spawnTime,
        state: 'recharging',
        leftAngle: 0,
        rightAngle: 0,
        beamActive: false,
        beamHeight: SIM.HEXAGON.beamHeight,
    };
    world.hexagonPairs.set(pair.id, pair);
    world.newHexagonPairs.push(pair);
    return pair;
}

function spawnHeptagonSwarm(world, x, y, spawnTime) {
    const size = SIM.HEPTAGON.size;
    const wt = SIM.WALL_THICKNESS;
    const minX = wt + size / 2;
    const maxX = SIM.CANVAS_WIDTH - wt - size / 2;
    const direction = Math.random() > 0.5 ? 1 : -1;

    for (let i = 0; i < SIM.HEPTAGON.swarmCount; i++) {
        const offsetX = randIntBetween(-128, 128);
        const offsetY = randIntBetween(-128, 128);
        const sx = Math.max(minX, Math.min(maxX, x + offsetX));
        const sy = y + offsetY;
        const h = {
            id: newId('hept'),
            x: sx, y: sy,
            vx: SIM.HEPTAGON.bounceSpeed * direction,
            vy: SIM.HEPTAGON.fallSpeed,
            angle: 0,
            bounceLeftX: minX,
            bounceRightX: maxX,
            spawnTime,
        };
        world.heptagons.set(h.id, h);
        world.newHeptagons.push(h);
    }
}

function spawnOctagon(world, x, y, spawnTime) {
    const o = {
        id: newId('oct'),
        x, y,
        lastShotTime: spawnTime,
        pulseScale: 1.0,
        pulseTimer: 0,
    };
    world.octagons.set(o.id, o);
    world.newOctagons.push(o);
    return o;
}

function spawnProjectile(world, x, y, vx, vy) {
    const p = {
        id: newId('proj'),
        x, y, vx, vy,
        hits: 0, scale: 1.0,
    };
    world.projectiles.set(p.id, p);
    world.newProjectiles.push(p);
    return p;
}

function spawnFullRowOfBlocks(world, y) {
    const width = SIM.CANVAS_WIDTH;
    const wallThick = SIM.WALL_THICKNESS;
    const blockSize = SIM.OBSTACLE_SIZE;
    const gap = 64;
    const playableWidth = width - (wallThick * 2);
    const blocksCount = Math.floor((playableWidth + gap) / (blockSize + gap));
    const totalBlocksWidth = (blocksCount * blockSize) + ((blocksCount - 1) * gap);
    const startX = wallThick + (playableWidth - totalBlocksWidth) / 2 + blockSize / 2;
    for (let i = 0; i < blocksCount; i++) {
        spawnBlock(world, startX + i * (blockSize + gap), y);
    }
}

// Spawn the row of blocks players land on at the very start of each round.
// Placed 160 px below the spawn Y so players have a soft landing without
// immediately being on top of the platform.
function spawnStartingPlatform(world) {
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    spawnFullRowOfBlocks(world, startY + 160);
}

function spawnIntervalCoinColumns(world, baseY, intervalNumber) {
    const width = SIM.CANVAS_WIDTH;
    const wallThick = SIM.WALL_THICKNESS;
    const coinSize = SIM.OBSTACLE_SIZE;
    const coinSpacing = coinSize + 20;
    const numColumns = intervalNumber;
    const playableWidth = width - (wallThick * 2);
    const columnPositions = [];
    if (numColumns === 1) columnPositions.push(width / 2);
    else {
        const spacing = playableWidth / (numColumns + 1);
        for (let c = 0; c < numColumns; c++) columnPositions.push(wallThick + spacing * (c + 1));
    }
    for (const colX of columnPositions) {
        for (let row = 0; row < 4; row++) {
            spawnCoin(world, colX, baseY - (row + 1) * coinSpacing);
        }
    }
}

function maybeSpawnPolygonObstacle(world, intervalNumber, chunkTop, chunkBottom, minX, maxX, elapsedMs) {
    const screensPerInterval = SIM.BASE_INTERVAL / SIM.CANVAS_HEIGHT;
    const types = [
        { name: 'pentagon', cfg: SIM.PENTAGON },
        { name: 'hexagon', cfg: SIM.HEXAGON },
        { name: 'heptagon', cfg: SIM.HEPTAGON },
        { name: 'octagon', cfg: SIM.OCTAGON },
    ];
    for (const { name, cfg } of types) {
        if (intervalNumber < cfg.startInterval) continue;
        const [minSpawn, maxSpawn] = cfg.spawnRate;
        const countThisInterval = randBetween(minSpawn, maxSpawn);
        const spawnChance = countThisInterval / screensPerInterval;
        if (Math.random() >= spawnChance) continue;

        const size = cfg.size;
        const aMinX = minX + size / 2;
        const aMaxX = maxX - size / 2;
        const rx = randIntBetween(aMinX, aMaxX);
        const ry = randIntBetween(chunkTop, chunkBottom);

        const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
        let bad = false;
        for (const intervalAlt of world.intervalAltitudes) {
            const intervalY = startY - intervalAlt;
            if (Math.abs(ry - intervalY) < SIM.EXCLUSION_RADIUS) { bad = true; break; }
        }
        if (bad) continue;

        if (name === 'pentagon') spawnPentagon(world, rx, ry, elapsedMs);
        else if (name === 'hexagon') spawnHexagonPair(world, ry, elapsedMs);
        else if (name === 'heptagon') spawnHeptagonSwarm(world, rx, ry, elapsedMs);
        else if (name === 'octagon') spawnOctagon(world, rx, ry, elapsedMs);
    }
}

function generateChunks(world, targetY, elapsedMs) {
    const wallThick = SIM.WALL_THICKNESS;
    const screenHeight = SIM.CANVAS_HEIGHT;
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    const width = SIM.CANVAS_WIDTH;

    while (world.lastChunkY > targetY) {
        const chunkBottom = world.lastChunkY;
        const chunkTop = chunkBottom - screenHeight;
        const chunkBottomAltitude = Math.max(0, startY - chunkBottom);
        const chunkTopAltitude = Math.max(0, startY - chunkTop);

        for (let y = chunkBottom; y > chunkTop; y -= wallThick) {
            world.sideWallSegments.push({ y });
        }

        for (let i = 0; i < world.intervalAltitudes.length; i++) {
            const intervalAlt = world.intervalAltitudes[i];
            if (intervalAlt >= chunkBottomAltitude && intervalAlt <= chunkTopAltitude) {
                if (!world.generatedIntervalBarriers.has(intervalAlt)) {
                    world.generatedIntervalBarriers.add(intervalAlt);
                    const intervalY = startY - intervalAlt;
                    const intervalNumber = i + 1;
                    spawnFullRowOfBlocks(world, intervalY);
                    spawnIntervalCoinColumns(world, intervalY - SIM.OBSTACLE_SIZE, intervalNumber);
                }
            }
        }

        let intervalsPassed = 0;
        for (let i = 0; i < world.intervalAltitudes.length; i++) {
            if (chunkTopAltitude > world.intervalAltitudes[i]) intervalsPassed++;
            else break;
        }
        const intervalNumber = intervalsPassed + 1;
        const blockCyclePosition = ((intervalNumber - 1) % 4) + 1;
        const blocksPerScreen = SIM.BASE_BLOCK_RATE + (SIM.BASE_BLOCK_RATE * blockCyclePosition);
        const screensPerInterval = SIM.BASE_INTERVAL / screenHeight;
        const totalCoinsForInterval = 8 * intervalNumber;
        const coinsPerScreen = totalCoinsForInterval / screensPerInterval;

        const minX = wallThick + 10;
        const maxX = width - wallThick - 10;

        let blocksSpawned = 0, blockAttempts = 0;
        while (blocksSpawned < blocksPerScreen && blockAttempts < 100) {
            blockAttempts++;
            const rx = randIntBetween(minX, maxX);
            const ry = randIntBetween(chunkTop, chunkBottom);
            if (isSpaceClear(world, rx, ry, SIM.BLOCK_MIN_DIST)) {
                spawnBlock(world, rx, ry);
                blocksSpawned++;
            }
        }

        const coinsToSpawn = Math.round(coinsPerScreen);
        let coinsSpawned = 0, coinAttempts = 0;
        while (coinsSpawned < coinsToSpawn && coinAttempts < 100) {
            coinAttempts++;
            const rx = randIntBetween(minX, maxX);
            const ry = randIntBetween(chunkTop, chunkBottom);
            if (isSpaceClear(world, rx, ry, SIM.COIN_MIN_DIST)) {
                spawnCoin(world, rx, ry);
                coinsSpawned++;
            }
        }

        maybeSpawnPolygonObstacle(world, intervalNumber, chunkTop, chunkBottom, minX, maxX, elapsedMs);

        world.lastChunkY = chunkTop;
        world.highestGeneratedY = chunkTop;
    }
}

function makePlayer(id) {
    return {
        id,
        userId: null,         // set by connection handler if the client authenticated
        displayName: null,    // ditto
        x: SIM.CANVAS_WIDTH / 2,
        y: SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET,
        vx: 0, vy: 0,
        alive: true,
        facingRight: true,
        score: 0,
        lastFlapTime: -Infinity,
        flapQueued: false,
        nextFlapDirection: 1,
        lastStunTime: -Infinity,
        inRound: false,   // true only for players who clicked READY before countdown ended
    };
}

function resetPlayer(p) {
    p.x = SIM.CANVAS_WIDTH / 2;
    p.y = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.facingRight = true;
    p.score = 0;
    p.lastFlapTime = -Infinity;
    p.flapQueued = false;
    p.nextFlapDirection = 1;
    p.lastStunTime = -Infinity;
    p.inRound = false;
}

function makeMatch() {
    const world = makeWorld();
    spawnStartingPlatform(world);
    return {
        players: new Map(),
        world,
        spikeY: SIM.CANVAS_HEIGHT + SIM.SPIKE_INITIAL_OFFSET,
        hazardSpeed: SIM.HAZARD_BASE_SPEED,
        elapsedMs: 0,
        hasStarted: false,
        nextIntervalIndex: 0,
        eventsThisTick: [],
        roundState: ROUND_WAITING,
        countdownEndsAtMs: Infinity,
        pendingWorldInitForAll: false,
        readyPlayers: new Set(),   // session IDs that clicked READY for this round
    };
}

function addPlayer(match, id) {
    const p = makePlayer(id);
    match.players.set(id, p);
    return p;
}
function removePlayer(match, id) { match.players.delete(id); }

function queueFlap(match, id) {
    if (match.roundState !== ROUND_RUNNING) return;
    const p = match.players.get(id);
    if (!p || !p.alive || !p.inRound) return;
    if (match.elapsedMs - p.lastStunTime < SIM.STUN_DURATION_MS) return;
    p.flapQueued = true;
}

function resetMatch(match) {
    const world = makeWorld();
    spawnStartingPlatform(world);
    match.world = world;
    match.spikeY = SIM.CANVAS_HEIGHT + SIM.SPIKE_INITIAL_OFFSET;
    match.hazardSpeed = SIM.HAZARD_BASE_SPEED;
    match.elapsedMs = 0;
    match.hasStarted = false;
    match.nextIntervalIndex = 0;
    match.eventsThisTick = [];
    match.roundState = ROUND_WAITING;
    match.countdownEndsAtMs = Infinity;
    match.readyPlayers = new Set();
    for (const p of match.players.values()) {
        resetPlayer(p);
    }
    match.pendingWorldInitForAll = true;
}

// Start a 10-second lobby countdown. The caller has already reset the match
// (world rebuilt, elapsedMs = 0). This just sets the window and registers the
// first ready player.
function beginCountdown(match, firstSessionId) {
    match.roundState = ROUND_COUNTDOWN;
    match.countdownEndsAtMs = match.elapsedMs + SIM.READY_COUNTDOWN_SECONDS * 1000;
    match.readyPlayers.add(firstSessionId);
    console.log(`[server] ${firstSessionId} clicked READY — ${SIM.READY_COUNTDOWN_SECONDS}s lobby countdown started`);
}

function highestPlayerY(match) {
    let minY = SIM.CANVAS_HEIGHT;
    for (const p of match.players.values()) {
        if (!p.inRound || !p.alive) continue;
        if (p.y < minY) minY = p.y;
    }
    return minY;
}

function lowestAlivePlayerY(match) {
    let maxY = -Infinity;
    for (const p of match.players.values()) {
        if (!p.inRound || !p.alive) continue;
        if (p.y > maxY) maxY = p.y;
    }
    return maxY;
}

function altitudeFromY(y) {
    return Math.max(0, Math.floor((SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET) - y));
}

function anyAlive(match) {
    for (const p of match.players.values()) {
        if (p.alive) return true;
    }
    return false;
}
function anyPlayers(match) {
    return match.players.size > 0;
}
function anyInRound(match) {
    for (const p of match.players.values()) {
        if (p.inRound) return true;
    }
    return false;
}
function anyInRoundAlive(match) {
    for (const p of match.players.values()) {
        if (p.inRound && p.alive) return true;
    }
    return false;
}

function resolveBlockBounce(p, block, scale, eventsArr, world) {
    const halfSize = (SIM.BLOCK_RENDER_SIZE * scale) / 2;
    const left = block.x - halfSize, right = block.x + halfSize;
    const top = block.y - halfSize, bottom = block.y + halfSize;
    const cx = Math.max(left, Math.min(p.x, right));
    const cy = Math.max(top, Math.min(p.y, bottom));
    const dx = p.x - cx, dy = p.y - cy;
    const distSq = dx * dx + dy * dy;
    const r = SIM.PLAYER_RADIUS;
    if (distSq < r * r && distSq > 0.0001) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist, ny = dy / dist;
        const overlap = r - dist;
        p.x += nx * overlap;
        p.y += ny * overlap;
        const vDotN = p.vx * nx + p.vy * ny;
        if (vDotN < 0) {
            const bounce = SIM.PLAYER_BOUNCE;
            p.vx -= (1 + bounce) * vDotN * nx;
            p.vy -= (1 + bounce) * vDotN * ny;
            clampVelocity(p);
        }
        eventsArr.push({ type: 'hit', x: p.x, y: p.y, playerId: p.id });
        return true;
    }
    return false;
}

function resolveCircleBounce(p, cx, cy, cr, eventsArr, stunBoost = false, match = null) {
    const dx = p.x - cx, dy = p.y - cy;
    const distSq = dx * dx + dy * dy;
    const minDist = SIM.PLAYER_RADIUS + cr;
    if (distSq < minDist * minDist && distSq > 0.0001) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist, ny = dy / dist;
        const overlap = minDist - dist;
        p.x += nx * overlap;
        p.y += ny * overlap;
        const vDotN = p.vx * nx + p.vy * ny;
        if (vDotN < 0) {
            const bounce = SIM.PLAYER_BOUNCE;
            p.vx -= (1 + bounce) * vDotN * nx;
            p.vy -= (1 + bounce) * vDotN * ny;
            if (stunBoost) {
                p.vx *= SIM.STUN_KNOCKBACK_BOOST;
                p.vy *= SIM.STUN_KNOCKBACK_BOOST;
                if (match) p.lastStunTime = match.elapsedMs;
            }
            clampVelocity(p);
        }
        eventsArr.push({ type: 'hit', x: p.x, y: p.y, playerId: p.id });
        return true;
    }
    return false;
}

function step(match, deltaSeconds) {
    match.elapsedMs += deltaSeconds * 1000;
    match.eventsThisTick = [];
    resetTickDeltas(match.world);

    // Nothing to simulate while waiting for players to ready up or while
    // showing the post-round scoreboard.
    if (match.roundState === ROUND_WAITING || match.roundState === ROUND_OVER) {
        return;
    }

    if (match.roundState === ROUND_COUNTDOWN) {
        const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
        generateChunks(match.world, startY - SIM.CANVAS_HEIGHT * 1.5, match.elapsedMs);

        if (match.elapsedMs >= match.countdownEndsAtMs) {
            // Assign participation based on who clicked READY in time.
            for (const [id, p] of match.players) {
                p.inRound = match.readyPlayers.has(id);
            }

            if (!anyInRound(match)) {
                // Edge case: everyone disconnected before countdown finished.
                match.roundState = ROUND_WAITING;
                console.log('[server] countdown ended with no ready players — back to waiting');
            } else {
                match.roundState = ROUND_RUNNING;
                match.hasStarted = true;   // physics start immediately; no "wait for first flap"
                console.log(`[server] countdown ended — ${match.readyPlayers.size} player(s) in round`);
            }
        }
        return;
    }

    // ── ROUND_RUNNING ────────────────────────────────────────────────────────

    const w = match.world;

    // Spike movement
    const lastAliveY = lowestAlivePlayerY(match);
    const spikeGap = match.spikeY - lastAliveY;
    const effectiveHazardSpeed = match.hazardSpeed +
        (spikeGap > SIM.HAZARD_CHASE_THRESHOLD ? SIM.HAZARD_CHASE_BONUS : 0);
    match.spikeY -= effectiveHazardSpeed * deltaSeconds;

    const highY = highestPlayerY(match);
    generateChunks(match.world, highY - SIM.CANVAS_HEIGHT * 1.5, match.elapsedMs);

    for (const pent of w.pentagons.values()) {
        pent.y += pent.vy * deltaSeconds;
        const elapsed = match.elapsedMs - pent.spawnTime;
        pent.angle = Math.sin(elapsed * SIM.PENTAGON.rotationSpeed) * SIM.PENTAGON.rotationRange;
    }

    const totalCycle = SIM.HEXAGON.rechargeDuration + SIM.HEXAGON.fireDuration;
    for (const pair of w.hexagonPairs.values()) {
        const cycleTime = (match.elapsedMs - pair.spawnTime) % totalCycle;
        if (cycleTime < SIM.HEXAGON.rechargeDuration - SIM.HEXAGON.spinDuration) {
            pair.state = 'recharging';
            pair.leftAngle = 0; pair.rightAngle = 0;
            pair.beamActive = false;
        } else if (cycleTime < SIM.HEXAGON.rechargeDuration) {
            pair.state = 'spinning';
            const spinProgress = (cycleTime - (SIM.HEXAGON.rechargeDuration - SIM.HEXAGON.spinDuration)) / SIM.HEXAGON.spinDuration;
            const spinAngle = spinProgress * spinProgress * 720;
            pair.leftAngle = spinAngle; pair.rightAngle = -spinAngle;
            pair.beamActive = false;
        } else {
            pair.state = 'firing';
            const fireProgress = (cycleTime - SIM.HEXAGON.rechargeDuration) / SIM.HEXAGON.fireDuration;
            pair.leftAngle = 720 + fireProgress * 180;
            pair.rightAngle = -720 - fireProgress * 180;
            pair.beamActive = true;
            const pulseProgress = fireProgress * 4 * Math.PI * 2;
            pair.beamHeight = SIM.HEXAGON.beamHeight + Math.sin(pulseProgress) * SIM.HEXAGON.beamPulseAmplitude;
        }
    }

    for (const h of w.heptagons.values()) {
        h.x += h.vx * deltaSeconds;
        h.y += h.vy * deltaSeconds;
        if (h.x <= h.bounceLeftX) {
            h.x = h.bounceLeftX;
            h.vx = SIM.HEPTAGON.bounceSpeed;
        } else if (h.x >= h.bounceRightX) {
            h.x = h.bounceRightX;
            h.vx = -SIM.HEPTAGON.bounceSpeed;
        }
        h.angle += 120 * deltaSeconds;
    }

    for (const o of w.octagons.values()) {
        if (o.pulseTimer > 0) {
            o.pulseTimer -= deltaSeconds * 1000;
            const t = 1 - (o.pulseTimer / 400);
            o.pulseScale = 1.0 + Math.sin(t * Math.PI * 2) * 0.2;
            if (o.pulseTimer <= 0) {
                o.pulseTimer = 0;
                o.pulseScale = 1.0;
            }
        }
        if (match.elapsedMs - o.lastShotTime < SIM.OCTAGON.shootInterval) continue;

        let target = null;
        let bestDistSq = SIM.OCTAGON.range * SIM.OCTAGON.range;
        for (const pl of match.players.values()) {
            if (!pl.inRound || !pl.alive) continue;
            if (pl.y <= o.y) continue;
            const dx = pl.x - o.x, dy = pl.y - o.y;
            const dsq = dx * dx + dy * dy;
            if (dsq < bestDistSq) { bestDistSq = dsq; target = pl; }
        }
        if (!target) continue;

        o.lastShotTime = match.elapsedMs;
        o.pulseTimer = 400;
        const dx = target.x - o.x, dy = target.y - o.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0) {
            spawnProjectile(w, o.x, o.y,
                (dx / dist) * SIM.OCTAGON.projectileSpeed,
                (dy / dist) * SIM.OCTAGON.projectileSpeed);
        }
    }

    for (const proj of w.projectiles.values()) {
        proj.x += proj.vx * deltaSeconds;
        proj.y += proj.vy * deltaSeconds;
    }

    // Only simulate physics for players who are in the round.
    for (const p of match.players.values()) {
        if (!p.inRound || !p.alive) continue;

        const stunned = (match.elapsedMs - p.lastStunTime) < SIM.STUN_DURATION_MS;
        if (p.flapQueued) {
            p.flapQueued = false;
            if (!stunned && match.elapsedMs - p.lastFlapTime >= SIM.FLAP_COOLDOWN_MS) {
                p.vy = -SIM.JUMP_FORCE;
                p.vx = SIM.HORIZONTAL_SPEED * p.nextFlapDirection;
                p.facingRight = p.nextFlapDirection === 1;
                p.nextFlapDirection = (p.nextFlapDirection === 1) ? -1 : 1;
                p.lastFlapTime = match.elapsedMs;
            }
        }

        p.vy += SIM.GRAVITY * deltaSeconds;
        if (p.vy > SIM.MAX_FALL_SPEED) p.vy = SIM.MAX_FALL_SPEED;

        let newX = p.x + p.vx * deltaSeconds;
        let newY = p.y + p.vy * deltaSeconds;

        const minX = SIM.WALL_THICKNESS + SIM.PLAYER_RADIUS;
        const maxX = SIM.CANVAS_WIDTH - SIM.WALL_THICKNESS - SIM.PLAYER_RADIUS;
        if (newX < minX) {
            newX = minX;
            if (p.vx < 0) p.vx = -p.vx * (1 + SIM.PLAYER_BOUNCE * 0.5);
            match.eventsThisTick.push({ type: 'hit', x: newX, y: newY, playerId: p.id });
        }
        if (newX > maxX) {
            newX = maxX;
            if (p.vx > 0) p.vx = -p.vx * (1 + SIM.PLAYER_BOUNCE * 0.5);
            match.eventsThisTick.push({ type: 'hit', x: newX, y: newY, playerId: p.id });
        }
        p.x = newX;
        p.y = newY;
        clampVelocity(p);

        const coinPickRadiusSq = ((SIM.PLAYER_RADIUS + SIM.OBSTACLE_SIZE * SIM.COIN_HITBOX_MULTIPLIER * 0.5) ** 2);
        for (const coin of w.coins.values()) {
            const dx = p.x - coin.x, dy = p.y - coin.y;
            if (dx * dx + dy * dy < coinPickRadiusSq) {
                w.coins.delete(coin.id);
                w.removedCoinIds.push(coin.id);
                p.score += 4;
                match.eventsThisTick.push({ type: 'coin_collected', x: coin.x, y: coin.y, by: p.id });
            }
        }

        for (const block of w.blocks.values()) {
            if (resolveBlockBounce(p, block, block.scale, match.eventsThisTick, w)) {
                block.hits++;
                if (block.hits >= 5) {
                    w.blocks.delete(block.id);
                    w.removedBlockIds.push(block.id);
                } else {
                    block.scale = 1.0 - (block.hits * 0.2);
                    w.dirtyBlockScales.add(block.id);
                }
            }
        }

        for (const pent of w.pentagons.values()) {
            resolveCircleBounce(p, pent.x, pent.y, SIM.PENTAGON.size / 2, match.eventsThisTick);
        }

        for (const pair of w.hexagonPairs.values()) {
            resolveCircleBounce(p, pair.leftX, pair.y, SIM.HEXAGON.size / 2, match.eventsThisTick);
            resolveCircleBounce(p, pair.rightX, pair.y, SIM.HEXAGON.size / 2, match.eventsThisTick);
        }

        for (const pair of w.hexagonPairs.values()) {
            if (!pair.beamActive) continue;
            const halfBeam = pair.beamHeight / 2;
            const beamLeft = pair.leftX + SIM.HEXAGON.size / 2;
            const beamRight = pair.rightX - SIM.HEXAGON.size / 2;
            const beamTop = pair.y - halfBeam;
            const beamBottom = pair.y + halfBeam;
            const cx = Math.max(beamLeft, Math.min(p.x, beamRight));
            const cy = Math.max(beamTop, Math.min(p.y, beamBottom));
            const dx = p.x - cx, dy = p.y - cy;
            const distSq = dx * dx + dy * dy;
            const r = SIM.PLAYER_RADIUS;
            if (distSq < r * r && distSq > 0.0001) {
                const dist = Math.sqrt(distSq);
                const nx = dx / dist, ny = dy / dist;
                const overlap = r - dist;
                p.x += nx * overlap;
                p.y += ny * overlap;
                const vDotN = p.vx * nx + p.vy * ny;
                if (vDotN < 0) {
                    p.vx -= (1 + SIM.PLAYER_BOUNCE) * vDotN * nx;
                    p.vy -= (1 + SIM.PLAYER_BOUNCE) * vDotN * ny;
                    p.vx *= SIM.STUN_KNOCKBACK_BOOST;
                    p.vy *= SIM.STUN_KNOCKBACK_BOOST;
                    clampVelocity(p);
                    p.lastStunTime = match.elapsedMs;
                }
                match.eventsThisTick.push({ type: 'hit', x: p.x, y: p.y, playerId: p.id });
            }
        }

        for (const h of w.heptagons.values()) {
            resolveCircleBounce(p, h.x, h.y, SIM.HEPTAGON.size / 2, match.eventsThisTick, true, match);
        }

        for (const o of w.octagons.values()) {
            resolveCircleBounce(p, o.x, o.y, SIM.OCTAGON.size / 2, match.eventsThisTick);
        }

        for (const proj of w.projectiles.values()) {
            const fakeBlock = { x: proj.x, y: proj.y };
            if (resolveBlockBounce(p, fakeBlock, proj.scale, match.eventsThisTick, w)) {
                proj.hits++;
                if (proj.hits >= 5) {
                    w.projectiles.delete(proj.id);
                    w.removedProjectileIds.push(proj.id);
                } else {
                    proj.scale = 1.0 - (proj.hits * 0.2);
                }
            }
        }

        if (p.y > match.spikeY) {
            p.alive = false;
            match.eventsThisTick.push({ type: 'death', playerId: p.id });
        }
    }

    const cleanupY = match.spikeY + 600;
    for (const pent of w.pentagons.values()) {
        if (pent.y > cleanupY) { w.pentagons.delete(pent.id); w.removedPentagonIds.push(pent.id); }
    }
    for (const pair of w.hexagonPairs.values()) {
        if (pair.y > cleanupY) { w.hexagonPairs.delete(pair.id); w.removedHexagonPairIds.push(pair.id); }
    }
    for (const h of w.heptagons.values()) {
        if (h.y > cleanupY) { w.heptagons.delete(h.id); w.removedHeptagonIds.push(h.id); }
    }
    for (const o of w.octagons.values()) {
        if (o.y > cleanupY) { w.octagons.delete(o.id); w.removedOctagonIds.push(o.id); }
    }
    for (const proj of w.projectiles.values()) {
        if (proj.y > cleanupY || proj.x < -200 || proj.x > SIM.CANVAS_WIDTH + 200) {
            w.projectiles.delete(proj.id);
            w.removedProjectileIds.push(proj.id);
        }
    }

    const highAltitude = altitudeFromY(highestPlayerY(match));
    while (match.nextIntervalIndex < match.world.intervalAltitudes.length &&
        highAltitude >= match.world.intervalAltitudes[match.nextIntervalIndex]) {
        match.nextIntervalIndex++;
        const intervalNumber = match.nextIntervalIndex;
        if (intervalNumber % 4 === 0) {
            const cycle = Math.floor(intervalNumber / 4);
            match.hazardSpeed = SIM.HAZARD_BASE_SPEED + (cycle * SIM.HAZARD_INCREASE);
        }
        match.eventsThisTick.push({ type: 'interval_reached', n: intervalNumber });
    }

    // Round over when all participants are dead (or none remain connected).
    if (match.hasStarted && match.roundState === ROUND_RUNNING) {
        if (!anyInRound(match) || !anyInRoundAlive(match)) {
            match.roundState = ROUND_OVER;
            match.roundOverAtMs = Date.now();   // gates how soon ready clicks are accepted
            // Fire-and-forget — runs in parallel with the next tick.
            // Never blocks the game loop, even on slow networks.
            recordMatchResults(match).catch(err =>
                console.error('[stats] unexpected error:', err)
            );
        }
    }
}

function buildWorldInit(world) {
    return {
        type: 'world_init',
        blocks: Array.from(world.blocks.values()),
        coins: Array.from(world.coins.values()),
        pentagons: Array.from(world.pentagons.values()),
        hexagonPairs: Array.from(world.hexagonPairs.values()),
        heptagons: Array.from(world.heptagons.values()),
        octagons: Array.from(world.octagons.values()),
        projectiles: Array.from(world.projectiles.values()),
        sideWallSegments: world.sideWallSegments,
    };
}

function buildSnapshot(match) {
    // All connected players are sent (inRound flag tells client who is
    // participating). Spectators stay at spawn position with alive=false.
    const players = {};
    for (const p of match.players.values()) {
        players[p.id] = {
            displayName: p.displayName,   // null for anon; client falls back to p.id
            x: p.x, y: p.y, vx: p.vx, vy: p.vy,
            alive: p.alive, facingRight: p.facingRight, score: p.score,
            stunned: (match.elapsedMs - p.lastStunTime) < SIM.STUN_DURATION_MS,
            inRound: p.inRound,
            pendingInRound: !p.inRound && match.readyPlayers.has(p.id),
        };
    }

    const pentagonStates = {};
    for (const pent of match.world.pentagons.values()) {
        pentagonStates[pent.id] = { x: pent.x, y: pent.y, angle: pent.angle };
    }
    const hexagonPairStates = {};
    for (const pair of match.world.hexagonPairs.values()) {
        hexagonPairStates[pair.id] = {
            state: pair.state,
            leftAngle: pair.leftAngle, rightAngle: pair.rightAngle,
            beamActive: pair.beamActive, beamHeight: pair.beamHeight,
        };
    }
    const heptagonStates = {};
    for (const h of match.world.heptagons.values()) {
        heptagonStates[h.id] = { x: h.x, y: h.y, vx: h.vx, vy: h.vy, angle: h.angle };
    }
    const octagonStates = {};
    for (const o of match.world.octagons.values()) {
        octagonStates[o.id] = { pulseScale: o.pulseScale };
    }
    const projectileStates = {};
    for (const proj of match.world.projectiles.values()) {
        projectileStates[proj.id] = { x: proj.x, y: proj.y, vx: proj.vx, vy: proj.vy, scale: proj.scale };
    }

    const blockScales = {};
    if (match.world.dirtyBlockScales) {
        for (const id of match.world.dirtyBlockScales) {
            const b = match.world.blocks.get(id);
            if (b) blockScales[id] = b.scale;
        }
    }

    // Only include round participants in the final scoreboard.
    const finalScores = [];
    for (const p of match.players.values()) {
        if (!p.inRound) continue;
        finalScores.push({ id: p.id, displayName: p.displayName, score: p.score });
    }
    finalScores.sort((a, b) => b.score - a.score);

    let countdownRemainingMs = 0;
    if (match.roundState === ROUND_COUNTDOWN) {
        countdownRemainingMs = Math.max(0, match.countdownEndsAtMs - match.elapsedMs);
    }

    // For spectators: let clients know where the action is so they can pan camera.
    let leadingPlayerY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    let leadingPlayerId = null;
    for (const p of match.players.values()) {
        if (p.inRound && p.alive && p.y < leadingPlayerY) {
            leadingPlayerY = p.y;
            leadingPlayerId = p.id;
        }
    }

    return {
        type: 'snapshot',
        tServer: match.elapsedMs,
        spikeY: match.spikeY,
        hasStarted: match.hasStarted,
        hazardSpeed: match.hazardSpeed,
        roundState: match.roundState,
        countdownRemainingMs,
        readyCount: match.readyPlayers.size,
        readyPlayerIds: Array.from(match.readyPlayers),
        leadingPlayerY,
        leadingPlayerId,
        finalScores,
        players,
        newBlocks: match.world.newBlocks,
        newCoins: match.world.newCoins,
        newPentagons: match.world.newPentagons,
        newHexagonPairs: match.world.newHexagonPairs,
        newHeptagons: match.world.newHeptagons,
        newOctagons: match.world.newOctagons,
        newProjectiles: match.world.newProjectiles,
        removedBlockIds: match.world.removedBlockIds,
        removedCoinIds: match.world.removedCoinIds,
        removedPentagonIds: match.world.removedPentagonIds,
        removedHexagonPairIds: match.world.removedHexagonPairIds,
        removedHeptagonIds: match.world.removedHeptagonIds,
        removedOctagonIds: match.world.removedOctagonIds,
        removedProjectileIds: match.world.removedProjectileIds,
        newSideWallSegments: [],
        blockScales,
        pentagonStates, hexagonPairStates, heptagonStates, octagonStates, projectileStates,
        events: match.eventsThisTick,
    };
}

const PORT = 2567;
const TICK_RATE_HZ = 60;
const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const app = express();
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const match = makeMatch();
const sessionByWs = new Map();
const sideWallSeenByWs = new Map();

function newSessionId(match) {
    const usedNumbers = new Set();
    for (const id of match.players.keys()) {
        const m = id.match(/^p(\d+)-/);
        if (m) usedNumbers.add(parseInt(m[1], 10));
    }
    let n = 1;
    while (usedNumbers.has(n)) n++;
    const suffix = Math.random().toString(36).slice(2, 6);
    return 'p' + n + '-' + suffix;
}

// ── auth + stats helpers ────────────────────────────────────────────────

// POSTs a JWT to the Worker's /auth/verify endpoint. Returns
// { id, display_name } on success, or null on any failure (no token,
// integration disabled, network error, invalid/expired token, etc).
// All failure modes collapse to "play as anonymous" — never throws.
async function verifyAuthToken(token) {
    if (!AUTH_WORKER_URL || !token) return null;
    try {
        const res = await fetch(`${AUTH_WORKER_URL}/auth/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (data && data.ok && data.user) {
            return { id: data.user.id, display_name: data.user.display_name };
        }
    } catch (err) {
        console.warn('[auth] verify error:', err.message);
    }
    return null;
}

// POSTs the results of a finished round to the Worker's /stats/record.
// Builds the player list from match.players (anyone with inRound=true),
// computes ranks from scores, and fires the request without awaiting it
// from the caller's perspective. Errors are logged and swallowed.
async function recordMatchResults(match) {
    if (!AUTH_WORKER_URL || !GAME_SERVER_SHARED_SECRET) return;

    const players = [];
    for (const p of match.players.values()) {
        if (!p.inRound) continue;
        const entry = {
            display_name: p.displayName || p.id,
            final_score: Math.round(p.score || 0),
            finishing_rank: 0,        // filled in below after sorting
        };
        if (p.userId) entry.user_id = p.userId;
        players.push(entry);
    }
    if (players.length === 0) return;

    // Standard competition ranking: ties share a rank, the next rank
    // skips by however many tied. e.g. 100, 80, 80, 50 → 1, 2, 2, 4.
    players.sort((a, b) => b.final_score - a.final_score);
    let rank = 1;
    for (let i = 0; i < players.length; i++) {
        if (i > 0 && players[i].final_score < players[i - 1].final_score) {
            rank = i + 1;
        }
        players[i].finishing_rank = rank;
    }

    try {
        const res = await fetch(`${AUTH_WORKER_URL}/stats/record`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-game-server-secret': GAME_SERVER_SHARED_SECRET,
            },
            body: JSON.stringify({
                mode: 'devils',       // competitive; will branch when angels (co-op) lands
                ended_at: Date.now(),
                players,
            }),
        });
        if (res.ok) {
            const data = await res.json();
            console.log(`[stats] match recorded (id=${data.match_id}, ${players.length} player(s))`);
        } else {
            console.warn(`[stats] record failed: ${res.status} ${await res.text()}`);
        }
    } catch (err) {
        console.warn('[stats] network error recording match:', err.message);
    }
}

wss.on('connection', async (ws, request) => {
    // Reject if we've hit the hard connection cap.
    if (wss.clients.size > SIM.MAX_CONNECTIONS) {
        ws.close(1008, 'Server full');
        return;
    }

    // Token may be passed as ?token=<jwt> on the WebSocket URL. If the
    // verify call fails or no token is provided, the player just stays
    // anonymous — same behaviour as before this integration existed.
    // The await here adds one HTTP round-trip to Cloudflare to the
    // connection latency (~50-100ms typically); the game tolerates it
    // since players don't expect instant readiness.
    const reqUrl = new URL(request.url, 'http://localhost');
    const token = reqUrl.searchParams.get('token');
    const authedUser = await verifyAuthToken(token);

    const sessionId = newSessionId(match);
    sessionByWs.set(ws, sessionId);
    sideWallSeenByWs.set(ws, 0);
    const player = addPlayer(match, sessionId);
    if (authedUser) {
        player.userId = authedUser.id;
        player.displayName = authedUser.display_name;
    }
    console.log(`[server] ${sessionId} joined as ${authedUser ? authedUser.display_name : 'anon'} (${match.players.size} total, round=${match.roundState})`);

    ws.send(JSON.stringify({
        type: 'welcome',
        sessionId,
        user: authedUser ? { id: authedUser.id, display_name: authedUser.display_name } : null,
    }));
    ws.send(JSON.stringify(buildWorldInit(match.world)));
    sideWallSeenByWs.set(ws, match.world.sideWallSegments.length);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'flap') {
            queueFlap(match, sessionId);

        } else if (msg.type === 'ready') {
            if (match.roundState === ROUND_WAITING) {
                // First player to click READY boots the new round: rebuild world
                // and open a 10-s lobby window for others to join.
                resetMatch(match);
                beginCountdown(match, sessionId);

            } else if (match.roundState === ROUND_COUNTDOWN) {
                // Join the upcoming round during the open lobby window.
                if (!match.readyPlayers.has(sessionId) &&
                    match.readyPlayers.size < SIM.MAX_ROUND_PLAYERS) {
                    match.readyPlayers.add(sessionId);
                    console.log(`[server] ${sessionId} joined lobby (${match.readyPlayers.size}/${SIM.MAX_ROUND_PLAYERS} ready)`);
                }

            } else if (match.roundState === ROUND_OVER) {
                // Same as ROUND_WAITING: the clicking player triggers a fresh
                // round; others have 10 s to also click READY.
                //
                // But: enforce a minimum delay since ROUND_OVER so a savvy
                // client (one that bypasses the UI) can't skip the score
                // reveal and force an instant restart on the rest of us.
                // The client shows a visible 4-second countdown in place of
                // the READY button; this gate matches it exactly. An honest
                // UI click lands right when the server starts accepting.
                const MIN_ROUND_OVER_TO_READY_MS = 4000;
                const sinceOver = Date.now() - (match.roundOverAtMs || 0);
                if (sinceOver < MIN_ROUND_OVER_TO_READY_MS) {
                    // Ignore silently — log at debug volume if you want.
                    return;
                }
                resetMatch(match);
                beginCountdown(match, sessionId);
            }
        }
    });

    ws.on('close', () => {
        sessionByWs.delete(ws);
        sideWallSeenByWs.delete(ws);
        removePlayer(match, sessionId);
        console.log(`[server] ${sessionId} left (${match.players.size} total, round=${match.roundState})`);
        if (match.roundState === ROUND_OVER && !anyPlayers(match)) {
            console.log('[server] all players gone during ROUND_OVER — auto-resetting');
            resetMatch(match);
        }
    });

    ws.on('error', (err) => console.warn(`[server] ws error for ${sessionId}:`, err.message));
});

let lastTickTime = Date.now();
let logTimer = 0;

setInterval(() => {
    const now = Date.now();
    const deltaMs = now - lastTickTime;
    lastTickTime = now;

    step(match, deltaMs / 1000);

    if (match.pendingWorldInitForAll) {
        match.pendingWorldInitForAll = false;
        const initMsg = JSON.stringify(buildWorldInit(match.world));
        for (const ws of wss.clients) {
            if (ws.readyState !== 1) continue;
            ws.send(initMsg);
            sideWallSeenByWs.set(ws, match.world.sideWallSegments.length);
        }
        resetTickDeltas(match.world);
    }

    const snapBase = buildSnapshot(match);

    const totalSegs = match.world.sideWallSegments.length;
    for (const ws of wss.clients) {
        if (ws.readyState !== 1) continue;
        const sid = sessionByWs.get(ws);
        const seen = sideWallSeenByWs.get(ws) || 0;

        // Per-client additions: new side-wall segments + whether this client has
        // clicked READY for the current round (lets the client dim its own button).
        const perClientExtras = {
            myReady: sid ? match.readyPlayers.has(sid) : false,
        };

        if (totalSegs > seen) {
            perClientExtras.newSideWallSegments = match.world.sideWallSegments.slice(seen);
            sideWallSeenByWs.set(ws, totalSegs);
        }

        const perClientSnap = Object.assign({}, snapBase, perClientExtras);
        ws.send(JSON.stringify(perClientSnap));
    }

    logTimer += deltaMs;
    if (logTimer >= 1000) {
        logTimer = 0;
        if (match.players.size > 0) {
            const w = match.world;
            const lines = [
                `t=${(match.elapsedMs / 1000).toFixed(1)}s round=${match.roundState} ` +
                `spikeY=${match.spikeY.toFixed(0)} hazard=${match.hazardSpeed} ` +
                `interval=${match.nextIntervalIndex} ready=${match.readyPlayers.size} ` +
                `blocks=${w.blocks.size} coins=${w.coins.size} pent=${w.pentagons.size} ` +
                `hex=${w.hexagonPairs.size} hept=${w.heptagons.size} oct=${w.octagons.size} ` +
                `proj=${w.projectiles.size}`
            ];
            for (const p of match.players.values()) {
                lines.push(`  ${p.id}: y=${p.y.toFixed(0)} score=${p.score} ` +
                    `${p.inRound ? (p.alive ? 'alive' : 'DEAD') : 'spectating'}`);
            }
            console.log(lines.join('\n'));
        }
    }
}, TICK_INTERVAL_MS);

server.listen(PORT, () => {
    console.log(`AGISCENDS server listening on http://localhost:${PORT}/ (tick rate: ${TICK_RATE_HZ} Hz)`);
    console.log(`Serving client from: ${CLIENT_DIR}`);
});