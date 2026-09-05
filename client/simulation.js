// Shared authoritative/predicted simulation. No rendering or network dependencies.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AGSim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';
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
    // How long an unusable flap intent is held before being discarded. Long
    // enough to bridge the cooldown, short enough that a stale tap never fires
    // noticeably later than the player pressed it.
    FLAP_BUFFER_MS: 120,

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

    // ── Powerups ────────────────────────────────────────────────────────
    // One powerup spawns per interval band; a player collects it by touching
    // it (like a coin). Effects are per-player; re-collecting refreshes the
    // timer, and different effects stack. Durations are in ms.
    POWERUP_SIZE: 40,                  // pickup hitbox / render size (world units)
    POWERUP_PICK_MULT: 1.4,            // pickup-radius leniency around POWERUP_SIZE
    POWERUP_TYPES: ['mult', 'vacuum', 'ghost', 'secondWind'],
    POWERUP_DURATIONS: { mult: 16000, vacuum: 16000, ghost: 8000, secondWind: 64000 },
    MULT_FACTOR: 4,                    // triangle worth 4 * MULT_FACTOR while Mult active
    VACUUM_RADIUS: 360,                // = CANVAS_WIDTH / 2; coins within are pulled in
    VACUUM_PULL_SPEED: 900,            // px/s coins move toward the player
    SECOND_WIND_LAUNCH_VY: -1800,      // strong upward launch when a spike hit is saved
    SECOND_WIND_GHOST_MS: 2000,        // no-collision window after the save (also the spent-icon linger)

    // Countdown seen by players once they click READY (10 s lobby window).
    READY_COUNTDOWN_SECONDS: 10,

    // Maximum participants per round. Extra connected clients spectate.
    MAX_ROUND_PLAYERS: 16,

    // Hard cap on simultaneous WebSocket connections (players + spectators).
    // Connections beyond this are rejected immediately.
    MAX_CONNECTIONS: 80,
    PLAYER_RESTITUTION: 1.0,
    MAX_WORLD_SPAN: 16000,
    STEP_MS: 1000 / 60,

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
        powerups: new Map(),
        pentagons: new Map(),
        hexagonPairs: new Map(),
        heptagons: new Map(),
        octagons: new Map(),
        projectiles: new Map(),
        sideWallSegments: [],
        intervalAltitudes,
        generatedIntervalBarriers: new Set(),
        lastChunkY: SIM.CANVAS_HEIGHT + 200,      // below screen → walls cover full viewport
        lastWallChunkY: SIM.CANVAS_HEIGHT + 200,  // independent tracker for walls only
        highestGeneratedY: SIM.CANVAS_HEIGHT + 200,
        newBlocks: [], newCoins: [],
        newPowerups: [], movedCoins: [],
        newPentagons: [], newHexagonPairs: [], newHeptagons: [], newOctagons: [],
        newProjectiles: [],
        removedBlockIds: [], removedCoinIds: [],
        removedPowerupIds: [],
        removedPentagonIds: [], removedHexagonPairIds: [], removedHeptagonIds: [],
        removedOctagonIds: [], removedProjectileIds: [],
        dirtyBlockScales: new Set(),
    };
}

function resetTickDeltas(world) {
    world.newBlocks = []; world.newCoins = [];
    world.newPowerups = []; world.movedCoins = [];
    world.newPentagons = []; world.newHexagonPairs = []; world.newHeptagons = []; world.newOctagons = [];
    world.newProjectiles = [];
    world.removedBlockIds = []; world.removedCoinIds = [];
    world.removedPowerupIds = [];
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

function spawnPowerup(world, x, y, type) {
    const pu = { id: newId('pu'), x, y, type };
    world.powerups.set(pu.id, pu);
    world.newPowerups.push(pu);
    return pu;
}

// One powerup per interval band, dropped anywhere in the band above its
// barrier row (random x within the walls, random type).
function spawnPowerupInBand(world, yLo, yHi) {
    const minX = SIM.WALL_THICKNESS + SIM.POWERUP_SIZE;
    const maxX = SIM.CANVAS_WIDTH - SIM.WALL_THICKNESS - SIM.POWERUP_SIZE;
    const type = SIM.POWERUP_TYPES[Math.floor(Math.random() * SIM.POWERUP_TYPES.length)];
    for (let a = 0; a < 30; a++) {
        const x = randIntBetween(minX, maxX);
        const y = randIntBetween(yLo, yHi);
        if (isSpaceClear(world, x, y, SIM.BLOCK_MIN_DIST)) {
            spawnPowerup(world, x, y, type);
            return;
        }
    }
    spawnPowerup(world, randIntBetween(minX, maxX), Math.floor((yLo + yHi) / 2), type);
}

// Normal per-interval spawn: somewhere in the band above the new barrier.
function spawnIntervalPowerup(world, intervalY) {
    spawnPowerupInBand(world, intervalY - SIM.BASE_INTERVAL + 120, intervalY - 120);
}

// True if player p currently has `type` active (expiry in the future).
function hasPower(p, type, nowMs) {
    return !!(p.activePowerups && p.activePowerups[type] > nowMs);
}

// No-collision state: the Ghost powerup, or the brief window granted right
// after a Second Wind save.
function isGhosting(p, nowMs) {
    return hasPower(p, 'ghost', nowMs) || (p.secondWindGhostUntil || 0) > nowMs;
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

// Generate side-wall segments far enough up to cover everything above
// `targetY` (smaller y = higher on screen). Tracked separately from
// chunk content so we can pre-fill the visible viewport at world-init
// time without spawning blocks/coins yet — the staged-reveal we want
// for the mode picker.
function generateSideWallsUpTo(world, targetY) {
    world.lastWallChunkY = Math.min(world.lastWallChunkY, targetY);
}

// Spawn the row of blocks players land on at the very start of each round.
// Placed 160 px below the spawn Y so players have a soft landing without
// immediately being on top of the platform.
function spawnStartingPlatform(world) {
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    spawnFullRowOfBlocks(world, startY + 160);
    // Also pre-generate enough side walls to cover the visible viewport
    // so the world looks structurally complete from the moment a client
    // connects. generateChunks's normal flow will extend walls upward
    // as the player climbs.
    generateSideWallsUpTo(world, -SIM.CANVAS_HEIGHT * 0.5);
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

        // Walls are tracked independently of chunks, so the shared helper
        // can be safely called once per chunk — it'll skip any wall range
        // already filled in by the world-init pre-pass.
        generateSideWallsUpTo(world, chunkTop);

        for (let i = 0; i < world.intervalAltitudes.length; i++) {
            const intervalAlt = world.intervalAltitudes[i];
            if (intervalAlt >= chunkBottomAltitude && intervalAlt <= chunkTopAltitude) {
                if (!world.generatedIntervalBarriers.has(intervalAlt)) {
                    world.generatedIntervalBarriers.add(intervalAlt);
                    const intervalY = startY - intervalAlt;
                    const intervalNumber = i + 1;
                    spawnFullRowOfBlocks(world, intervalY);
                    spawnIntervalCoinColumns(world, intervalY - SIM.OBSTACLE_SIZE, intervalNumber);
                    spawnIntervalPowerup(world, intervalY);
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
        netId: 0, isBot: false, inputHeld: false, inputSeq: 0, inputQueue: [],
        userId: null,         // set by connection handler if the client authenticated
        displayName: null,    // ditto
        appearance: null,     // set by connection handler if the client authenticated
        x: SIM.CANVAS_WIDTH / 2,
        y: SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET,
        vx: 0, vy: 0,
        alive: true,
        facingRight: true,
        score: 0,
        lastFlapTime: -Infinity,
        flapQueued: false,
        flapQueuedAt: 0,
        nextFlapDirection: 1,
        lastStunTime: -Infinity,
        inRound: false,   // true only for players who clicked READY before countdown ended
        activePowerups: { mult: 0, vacuum: 0, ghost: 0, secondWind: 0 },  // expiry (elapsedMs)
        secondWindGhostUntil: 0,  // brief no-collision window after a Second Wind save
    };
}

function resetPlayer(p) {
    p.inputHeld = false; p.inputSeq = 0; p.inputQueue = [];
    p.x = SIM.CANVAS_WIDTH / 2;
    p.y = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.facingRight = true;
    p.score = 0;
    p.lastFlapTime = -Infinity;
    p.flapQueued = false;
    p.flapQueuedAt = 0;
    p.nextFlapDirection = 1;
    p.lastStunTime = -Infinity;
    p.inRound = false;
    p.deathTime = null;          // match.elapsedMs at moment of death; null while alive
    p.roundJoinIndex = null;     // 0-based order of this player in match.readyPlayers at
    // round start; used as a tertiary tiebreaker when two
    // Devils players die at the same elapsedMs with the same
    // score. Earlier joiner (lower index) wins.
    p.activePowerups = { mult: 0, vacuum: 0, ghost: 0, secondWind: 0 };
    p.secondWindGhostUntil = 0;
}

function makeMatch() {
    const world = makeWorld();
    spawnStartingPlatform(world);
    return {
        players: new Map(),
        tick: 0, roundId: 0, nextNetId: 1,
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
        teamScore: 0,              // Angels: shared score across the team. Unused in Devils.
    };
}

function addPlayer(match, id) {
    const p = makePlayer(id);
    if (match.nextNetId > 65535) match.nextNetId = 1;
    const used = new Set([...match.players.values()].map(q=>q.netId));
    while (used.has(match.nextNetId)) match.nextNetId++;
    p.netId = match.nextNetId++;
    match.players.set(id, p);
    return p;
}
function removePlayer(match, id) { match.players.delete(id); match.readyPlayers.delete(id); }

// Single point for crediting score during play. Devils: only the scorer
// gains points. Angels: the team gains points, every individual player's
// `score` field stays 0 — display + recording read match.teamScore.
function awardScore(match, scorer, amount) {
    if (match.mode === 'angels') {
        match.teamScore += amount;
    } else {
        scorer.score += amount;
    }
}

function queueFlap(match, id) {
    if (match.roundState !== ROUND_RUNNING) return;
    const p = match.players.get(id);
    if (!p || !p.alive || !p.inRound) return;
    if (match.elapsedMs - p.lastStunTime + 1e-6 < SIM.STUN_DURATION_MS) return;
    // Held state is renewed by fixed simulation steps; network messages carry
    // transitions and occasional heartbeats, independent of rendering FPS.
    p.flapQueuedAt = match.elapsedMs;
    p.flapQueued = true;
}

function resetMatch(match) {
    const world = makeWorld();
    spawnStartingPlatform(world);
    match.world = world;
    match.spikeY = SIM.CANVAS_HEIGHT + SIM.SPIKE_INITIAL_OFFSET;
    match.hazardSpeed = SIM.HAZARD_BASE_SPEED;
    match.elapsedMs = 0; match.tick = 0; match.roundId++;
    match.hasStarted = false;
    match.nextIntervalIndex = 0;
    match.eventsThisTick = [];
    match.roundState = ROUND_WAITING;
    match.countdownEndsAtMs = Infinity;
    match.readyPlayers = new Set();
    match.teamScore = 0;
    // Drop any ghosts left over from the previous round (mid-round
    // disconnects). They appeared on the GAME OVER scoreboard but they
    // shouldn't carry over into the fresh round.
    for (const [id, p] of match.players) {
        if (p.disconnected || p.isBot) match.players.delete(id);
    }
    match.nextNetId = 1;
    for (const p of match.players.values()) {
        p.netId = match.nextNetId++;
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
    let dx = p.x - cx, dy = p.y - cy;
    let distSq = dx * dx + dy * dy;
    const r = SIM.PLAYER_RADIUS;
    if (distSq < r * r) {
        let dist = Math.sqrt(distSq), nx, ny;
        if (dist < 0.00001) {
            const edges=[{d:p.x-left,nx:-1,ny:0},{d:right-p.x,nx:1,ny:0},{d:p.y-top,nx:0,ny:-1},{d:bottom-p.y,nx:0,ny:1}];
            edges.sort((a,b)=>a.d-b.d);nx=edges[0].nx;ny=edges[0].ny;dist=-edges[0].d;
        } else {nx=dx/dist;ny=dy/dist;}
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

function step(match, deltaSeconds = SIM.STEP_MS / 1000) {
    if (Math.abs(deltaSeconds - SIM.STEP_MS / 1000) > 1e-8) throw new Error("Simulation requires a fixed 60 Hz step");
    match.tick++;
    match.elapsedMs = match.tick * SIM.STEP_MS;
    if (match.prediction) { match.eventsThisTick = []; resetTickDeltas(match.world); }

    // Nothing to simulate while waiting for players to ready up or while
    // showing the post-round scoreboard.
    if (match.roundState === ROUND_WAITING || match.roundState === ROUND_OVER) {
        return;
    }

    if (match.roundState === ROUND_COUNTDOWN) {
        const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
        generateChunks(match.world, startY - SIM.CANVAS_HEIGHT * 1.5, match.elapsedMs);

        if (match.elapsedMs >= match.countdownEndsAtMs) {
            // Snapshot round-join order from readyPlayers' insertion
            // order (JS Sets preserve insertion order, so iterating
            // gives us the chronological sequence of READY clicks).
            // The index becomes a stable tertiary tiebreaker for the
            // exact-same-tick exact-same-score death scenario in
            // recordMatchResults below.
            let joinIdx = 0;
            const joinIndexById = new Map();
            for (const id of match.readyPlayers) joinIndexById.set(id, joinIdx++);

            // Assign participation based on who clicked READY in time.
            for (const [id, p] of match.players) {
                p.inRound = match.readyPlayers.has(id);
                p.roundJoinIndex = joinIndexById.has(id) ? joinIndexById.get(id) : null;
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
    // Bound the retained play corridor even when leaders and stragglers diverge.
    match.spikeY = Math.min(match.spikeY, highY + SIM.MAX_WORLD_SPAN);
    if (!match.prediction) generateChunks(match.world, highY - SIM.CANVAS_HEIGHT * 1.5, match.elapsedMs);
    for (const p of match.players.values()) {
        p.previousX = p.x; p.previousY = p.y;
        if (!match.prediction && p.isBot) updateBot(match, p);
        applyQueuedInputs(match, p);
        if (p.inputHeld) queueFlap(match, p.id);
    }

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

    const spatial = makeSpatialIndex(w);

    // Only simulate physics for players who are in the round.
    for (const p of match.players.values()) {
        if (!p.inRound || !p.alive) continue;

        const stunned = (match.elapsedMs - p.lastStunTime + 1e-6) < SIM.STUN_DURATION_MS;
        if (p.flapQueued) {
            // Hold the intent until it can actually be used. Clearing it on a
            // tick where the cooldown had not yet elapsed threw a real input
            // away and forced a wait for the next message to arrive. Because
            // client sends and server ticks both run at ~60 Hz but are not
            // synchronised, some tick windows received two messages (one lost
            // to the boolean) and some received none, and each miss cost a full
            // tick — which is what made the flap interval wander between 200
            // and 260 ms instead of holding at the 200 ms cooldown.
            const ready = match.elapsedMs - p.lastFlapTime + 1e-6 >= SIM.FLAP_COOLDOWN_MS;
            const stale = match.elapsedMs - p.flapQueuedAt > SIM.FLAP_BUFFER_MS;
            if (ready || stunned || stale) {
                p.flapQueued = false;
            }
            if (!stunned && ready) {
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

        // Vacuum — pull nearby coins toward the player (streamed via movedCoins
        // so other clients see them move too). Runs before pickup so a pulled
        // coin can be collected the same tick it reaches the player.
        if (hasPower(p, 'vacuum', match.elapsedMs)) {
            const vr2 = SIM.VACUUM_RADIUS * SIM.VACUUM_RADIUS;
            const vstep = SIM.VACUUM_PULL_SPEED * deltaSeconds;
            for (const coin of spatial.near("coins", p.y, 400)) {
                const dx = p.x - coin.x, dy = p.y - coin.y;
                const d2 = dx * dx + dy * dy;
                if (d2 < vr2 && d2 > 1) {
                    const d = Math.sqrt(d2);
                    const move = Math.min(vstep, d);
                    coin.x += (dx / d) * move;
                    coin.y += (dy / d) * move;
                    w.movedCoins.push({ id: coin.id, x: coin.x, y: coin.y });
                }
            }
        }

        const coinPickRadiusSq = ((SIM.PLAYER_RADIUS + SIM.OBSTACLE_SIZE * SIM.COIN_HITBOX_MULTIPLIER * 0.5) ** 2);
        for (const coin of spatial.near("coins", p.y, 400)) {
            const dx = p.x - coin.x, dy = p.y - coin.y;
            if (dx * dx + dy * dy < coinPickRadiusSq) {
                w.coins.delete(coin.id);
                w.removedCoinIds.push(coin.id);
                // Mult: each triangle is worth 4 * MULT_FACTOR while active.
                awardScore(match, p, hasPower(p, 'mult', match.elapsedMs) ? 4 * SIM.MULT_FACTOR : 4);
                match.eventsThisTick.push({ type: 'coin_collected', x: coin.x, y: coin.y, by: p.id });
            }
        }

        // Powerup pickup — touch to collect; activates / refreshes the effect.
        const puPickRadiusSq = (SIM.PLAYER_RADIUS + SIM.POWERUP_SIZE * SIM.POWERUP_PICK_MULT * 0.5) ** 2;
        for (const pu of spatial.near("powerups", p.y, 100)) {
            const dx = p.x - pu.x, dy = p.y - pu.y;
            if (dx * dx + dy * dy < puPickRadiusSq) {
                w.powerups.delete(pu.id);
                w.removedPowerupIds.push(pu.id);
                // Second Wind is permanent until consumed by a spike hit; the
                // others run on a timer.
                p.activePowerups[pu.type] = pu.type === 'secondWind'
                    ? Infinity
                    : match.elapsedMs + (SIM.POWERUP_DURATIONS[pu.type] || 16000);
                match.eventsThisTick.push({ type: 'powerup_collected', x: pu.x, y: pu.y, by: p.id, power: pu.type });
            }
        }

        // Ghost (and the brief window after a Second Wind save) passes through
        // every obstacle below. Boundary walls, coin/powerup pickup and the
        // spike wall are handled outside this block and still apply.
        if (!isGhosting(p, match.elapsedMs)) {
            for (const block of spatial.near("blocks", p.y, 100)) {
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

            for (const pent of spatial.near("pentagons", p.y, 160)) {
                resolveCircleBounce(p, pent.x, pent.y, SIM.PENTAGON.size / 2, match.eventsThisTick);
            }

            for (const pair of spatial.near("hexagonPairs", p.y, 100)) {
                resolveCircleBounce(p, pair.leftX, pair.y, SIM.HEXAGON.size / 2, match.eventsThisTick);
                resolveCircleBounce(p, pair.rightX, pair.y, SIM.HEXAGON.size / 2, match.eventsThisTick);
            }

            for (const pair of spatial.near("hexagonPairs", p.y, 100)) {
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

            for (const h of spatial.near("heptagons", p.y, 100)) {
                resolveCircleBounce(p, h.x, h.y, SIM.HEPTAGON.size / 2, match.eventsThisTick, true, match);
            }

            for (const o of spatial.near("octagons", p.y, 120)) {
                resolveCircleBounce(p, o.x, o.y, SIM.OCTAGON.size / 2, match.eventsThisTick);
            }

            for (const proj of spatial.near("projectiles", p.y, 100)) {
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
        }  // end if(!isGhosting): obstacle collisions skipped while Ghosting / Second-Wind window

    }

    resolvePlayerContacts(match, deltaSeconds);
    for (const p of match.players.values()) {
        if (!p.inRound || !p.alive || isGhosting(p, match.elapsedMs)) continue;
        for (const block of spatial.near('blocks', p.y, 100)) resolveBlockBounce(p,block,block.scale,[],w);
        const left=SIM.WALL_THICKNESS+SIM.PLAYER_RADIUS, right=SIM.CANVAS_WIDTH-left;
        if(p.x<left){p.x=left;if(p.vx<0)p.vx=-p.vx;}
        if(p.x>right){p.x=right;if(p.vx>0)p.vx=-p.vx;}
    }
    for (const p of match.players.values()) {
        if (!p.inRound || !p.alive) continue;
        if (p.y > match.spikeY) {
            if (hasPower(p, 'secondWind', match.elapsedMs)) {
                // Consume Second Wind: launch clear instead of dying, with a
                // brief no-collision window (like Ghost) to escape the spike.
                p.activePowerups.secondWind = 0;
                p.vy = SIM.SECOND_WIND_LAUNCH_VY;
                p.y = match.spikeY - SIM.PLAYER_RADIUS - 1;  // nudge above the spike line
                p.secondWindGhostUntil = match.elapsedMs + SIM.SECOND_WIND_GHOST_MS;
                // Ignore player input briefly (exactly like hexagon rays /
                // heptagon hits) so flaps can't bleed off the launch — the
                // player is guaranteed the full upward boost.
                p.lastStunTime = match.elapsedMs;
                match.eventsThisTick.push({ type: 'second_wind', x: p.x, y: p.y, playerId: p.id });
            } else {
                p.alive = false;
                p.deathTime = match.elapsedMs;
                match.eventsThisTick.push({ type: 'death', playerId: p.id });
            }
        }
    }

    const cleanupY = match.spikeY + 600;
    for (const b of w.blocks.values()) {
        if (b.y > cleanupY) { w.blocks.delete(b.id); w.removedBlockIds.push(b.id); }
    }
    for (const c of w.coins.values()) {
        if (c.y > cleanupY) { w.coins.delete(c.id); w.removedCoinIds.push(c.id); }
    }
    for (const pu of w.powerups.values()) {
        if (pu.y > cleanupY) { w.powerups.delete(pu.id); w.removedPowerupIds.push(pu.id); }
    }
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
    while (!match.prediction && match.nextIntervalIndex < match.world.intervalAltitudes.length &&
        highAltitude >= match.world.intervalAltitudes[match.nextIntervalIndex]) {
        match.nextIntervalIndex++;
        const intervalNumber = match.nextIntervalIndex;
        if (intervalNumber % 4 === 0) {
            const cycle = Math.floor(intervalNumber / 4);
            match.hazardSpeed = SIM.HAZARD_BASE_SPEED + (cycle * SIM.HAZARD_INCREASE);
        }
        match.eventsThisTick.push({ type: 'interval_reached', n: intervalNumber });

        // ── Catch-up powerup ────────────────────────────────────────────
        // When the leader breaches a new wall, drop a bonus powerup somewhere
        // in the interval just completed. Players close behind have little of
        // that band left to sweep; players far back traverse all of it and are
        // likely to find it — a self-scaling rubber-band. Always fires, even
        // solo: the bonus invites a risky dive back down past the rising spikes,
        // or tempts the leader to break off the climb to grab it.
        {
            const refStartY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
            const crossedWallY = refStartY - match.world.intervalAltitudes[intervalNumber - 1];
            const prevAlt = intervalNumber >= 2 ? match.world.intervalAltitudes[intervalNumber - 2] : 0;
            const prevWallY = refStartY - prevAlt;
            spawnPowerupInBand(match.world, crossedWallY + 100, prevWallY - 100);
        }

        // ── Angels rolling resurrection ─────────────────────────────────
        // First-time crossing of any interval brings back the player who
        // died earliest. The newly-alive player materializes right on the
        // crossing player ("resurrector") with zero velocity — no invuln,
        // no ready-up. They're back in the fight immediately.
        //
        // If multiple intervals are crossed in a single tick (rare but
        // possible on a hard flap), each iteration of this while loop
        // rezzes one player, in death-order. That feels right: the chain
        // gets longer, the rewards stack.
        if (match.mode === 'angels') {
            let deadEarliest = null;
            for (const q of match.players.values()) {
                if (!q.inRound) continue;
                if (q.alive) continue;
                if (q.deathTime == null || q.disconnected) continue;
                if (!deadEarliest || q.deathTime < deadEarliest.deathTime) deadEarliest = q;
            }
            if (deadEarliest) {
                // Fixed spawn: centered horizontally, 40 px above the
                // interval that was just crossed. Gives the revived player
                // a clean fresh-spawn feeling rather than dropping them
                // wherever the current leader happens to be.
                const justCrossedAltitude = match.world.intervalAltitudes[intervalNumber - 1];
                const refStartY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
                const intervalY = refStartY - justCrossedAltitude;
                deadEarliest.alive = true;
                deadEarliest.x = SIM.CANVAS_WIDTH / 2;
                deadEarliest.y = intervalY - 80;
                deadEarliest.vx = 0;
                deadEarliest.vy = 0;
                deadEarliest.deathTime = null;
                deadEarliest.lastStunTime = -Infinity;
                match.eventsThisTick.push({
                    type: 'resurrected',
                    playerId: deadEarliest.id,
                });
            }
        }
    }

    // Round over when all participants are dead (or none remain connected).
    if (!match.prediction && match.hasStarted && match.roundState === ROUND_RUNNING) {
        if (!anyInRound(match) || !anyInRoundAlive(match)) {
            match.roundState = ROUND_OVER;
            match.roundOverAtMs = Date.now();   // gates how soon ready clicks are accepted
            // Fire-and-forget — runs in parallel with the next tick.
            // Never blocks the game loop, even on slow networks.
            if (match.onRoundOver) match.onRoundOver(match);
        }
    }
}

function buildWorldInit(world) {
    return {
        type: 'world_init',
        blocks: Array.from(world.blocks.values()),
        coins: Array.from(world.coins.values()),
        powerups: Array.from(world.powerups.values()),
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
    const angelsTeamScore = match.mode === 'angels' ? match.teamScore : null;

    // Build the resurrection queue ordering for dead in-round Angels
    // players so each gets a queuePosition (1 = next to be revived).
    // Disconnected ghosts are excluded — they don't get revived.
    const queueByPlayer = new Map();
    if (match.mode === 'angels') {
        const dead = [];
        for (const p of match.players.values()) {
            if (!p.inRound || p.alive || p.disconnected || p.deathTime == null) continue;
            dead.push(p);
        }
        dead.sort((a, b) => a.deathTime - b.deathTime);
        for (let i = 0; i < dead.length; i++) {
            queueByPlayer.set(dead[i].id, i + 1);
        }
    }

    for (const p of match.players.values()) {
        const pu = {};
        for (const t of SIM.POWERUP_TYPES) {
            if (t === 'secondWind') {
                // Held: a permanent flag. Just spent: linger as a countdown over
                // the no-collision window so the HUD icon pulses out (8x, like the
                // other icons' final seconds). hasPower stays false once spent.
                if (p.activePowerups.secondWind === Infinity) pu.secondWind = true;
                else if (p.secondWindGhostUntil > match.elapsedMs) pu.secondWind = (p.secondWindGhostUntil - match.elapsedMs) / 1000;
                continue;
            }
            const exp = p.activePowerups[t] || 0;
            if (exp === Infinity) pu[t] = true;                  // permanent
            else { const rem = exp - match.elapsedMs; if (rem > 0) pu[t] = rem / 1000; }
        }
        const entry = {
            netId: p.netId, isBot: p.isBot, inputHeld: p.inputHeld, inputSeq: p.inputSeq,
            lastFlapTime: p.lastFlapTime, nextFlapDirection: p.nextFlapDirection,
            lastStunTime: p.lastStunTime, flapQueued: p.flapQueued, flapQueuedAt: p.flapQueuedAt,
            activePowerups: p.activePowerups, secondWindGhostUntil: p.secondWindGhostUntil,
            displayName: p.displayName,   // null for anon; client falls back to p.id
            appearance: p.appearance,     // null = default look; client renders accordingly
            x: p.x, y: p.y, vx: p.vx, vy: p.vy,
            alive: p.alive, facingRight: p.facingRight,
            score: angelsTeamScore != null ? angelsTeamScore : p.score,
            stunned: (match.elapsedMs - p.lastStunTime + 1e-6) < SIM.STUN_DURATION_MS,
            inRound: p.inRound,
            pendingInRound: !p.inRound && match.readyPlayers.has(p.id),
            powerups: pu,   // { type: remainingSeconds } for each active effect
            phasing: isGhosting(p, match.elapsedMs),  // true while ignoring collisions (Ghost or post-Second-Wind window)
        };
        const qp = queueByPlayer.get(p.id);
        if (qp != null) entry.queuePosition = qp;
        players[p.id] = entry;
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
        octagonStates[o.id] = { pulseScale: o.pulseScale, pulseTimer: o.pulseTimer, lastShotTime: o.lastShotTime };
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
    // In Angels every in-round player shares the team score, which yields
    // dense rank=1 across the team after the sort below.
    //
    // Devils-only: at ROUND_OVER, apply the same score tiebreaker
    // used by recordMatchResults so the client's victory screen
    // matches what's recorded to Profile / leaderboard. During play
    // (RUNNING) the live scoreboard keeps showing raw scores — the
    // tiebreak is a finalization step, not a live-display step.
    const isAngelsMode = match.mode === 'angels';
    const inRoundList = [];
    const scoreFor = new Map();
    for (const p of match.players.values()) {
        if (!p.inRound) continue;
        inRoundList.push(p);
        scoreFor.set(p, isAngelsMode ? match.teamScore : p.score);
    }
    if (match.roundState === ROUND_OVER && !isAngelsMode) {
        applyDevilsScoreTiebreakers(inRoundList, scoreFor);
    }
    const finalScores = inRoundList.map(p => ({
        id: p.id,
        displayName: p.displayName,
        score: scoreFor.get(p),
    }));
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
        type: 'snapshot', tick: match.tick, roundId: match.roundId, mode: match.mode,
        nextIntervalIndex: match.nextIntervalIndex,
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
        finalScores: match.roundState === ROUND_OVER ? finalScores : [],
        players,
        newBlocks: match.world.newBlocks,
        newCoins: match.world.newCoins,
        newPowerups: match.world.newPowerups,
        movedCoins: match.world.movedCoins,
        newPentagons: match.world.newPentagons,
        newHexagonPairs: match.world.newHexagonPairs,
        newHeptagons: match.world.newHeptagons,
        newOctagons: match.world.newOctagons,
        newProjectiles: match.world.newProjectiles,
        removedBlockIds: match.world.removedBlockIds,
        removedCoinIds: match.world.removedCoinIds,
        removedPowerupIds: match.world.removedPowerupIds,
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


function applyDevilsScoreTiebreakers(players, scoreFor) {
    let didMutate;
    do {
        didMutate = false;
        const byScore = new Map();
        for (const p of players) {
            const s = scoreFor.get(p);
            if (!byScore.has(s)) byScore.set(s, []);
            byScore.get(s).push(p);
        }
        for (const group of byScore.values()) {
            if (group.length < 2) continue;
            group.sort((a, b) => {
                // Primary: earlier deathTime first (gets original score).
                if (a.deathTime !== b.deathTime) return a.deathTime - b.deathTime;
                // Secondary: later joinIndex first, so the earliest joiner
                // sorts last in the tiebreak order and is rewarded.
                if (a.roundJoinIndex !== b.roundJoinIndex) return b.roundJoinIndex - a.roundJoinIndex;
                // Tertiary fallback for full determinism if both deathTime
                // and joinIndex coincide — shouldn't happen in practice
                // since joinIndex is unique within a round, but defensive.
                return a.id.localeCompare(b.id);
            });
            const base = scoreFor.get(group[0]);
            for (let i = 1; i < group.length; i++) {
                const after = base + i;
                if (scoreFor.get(group[i]) !== after) {
                    scoreFor.set(group[i], after);
                    didMutate = true;
                }
            }
        }
    } while (didMutate);
}


function makeSpatialIndex(world) {
    const buckets = {};
    for (const name of ['coins','powerups','blocks','pentagons','hexagonPairs','heptagons','octagons','projectiles']) {
        const index = buckets[name] = new Map();
        for (const obj of world[name].values()) {
            const key = Math.floor(obj.y / 256);
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(obj);
        }
    }
    return { *near(name, y, radius) {
        for (let k = Math.floor((y-radius)/256); k <= Math.floor((y+radius)/256); k++) {
            for (const obj of buckets[name].get(k) || []) if (world[name].has(obj.id)) yield obj;
        }
    }};
}

function applyInput(p, command, nowMs) {
    if (command.seq <= p.inputSeq) return;
    p.inputSeq = command.seq;
    const press = command.held && !p.inputHeld;
    p.inputHeld = command.held;
    if (press) { p.flapQueued = true; p.flapQueuedAt = nowMs; }
}
function enqueueInput(match, p, command) {
    if (!p || p.isBot || !Number.isSafeInteger(command.seq) || command.seq <= p.inputSeq ||
        command.seq > 0xffffffff || typeof command.held !== 'boolean' ||
        command.roundId !== match.roundId || !Number.isSafeInteger(command.tick)) return false;
    if (p.inputQueue.length >= 32 || p.inputQueue.some(c => c.seq === command.seq)) return false;
    // A client may schedule a short way ahead, never arbitrarily backdate physics.
    const tick = Math.max(match.tick + 1, Math.min(command.tick, match.tick + 12));
    p.inputQueue.push({ seq: command.seq, held: command.held, tick });
    p.inputQueue.sort((a,b) => a.tick-b.tick || a.seq-b.seq);
    return true;
}
function applyQueuedInputs(match, p) {
    while (p.inputQueue && p.inputQueue.length && p.inputQueue[0].tick <= match.tick) {
        applyInput(p, p.inputQueue.shift(), match.elapsedMs);
    }
}

function spreadLobby(match) {
    const ready = [...match.readyPlayers].map(id=>match.players.get(id)).filter(Boolean);
    ready.forEach((p,i) => {
        const col=i%8, row=Math.floor(i/8);
        p.x=80+col*80; p.y=540-row*140;
        p.vx=0; p.vy=0;
        p.nextFlapDirection=col<4 ? 1 : -1;
    });
}
function fillLobby(match) {
    // Humans always take precedence. Bots are reserved slots, not connections.
    for (const [id,p] of match.players) if (p.isBot) removePlayer(match,id);
    let n=1;
    while (match.readyPlayers.size < SIM.MAX_ROUND_PLAYERS) {
        const p=addPlayer(match, 'bot-'+n);
        p.isBot=true; p.displayName='BOT '+n;
        p.botPhase=n*0.71; p.botNextDecision=0;
        match.readyPlayers.add(p.id); n++;
    }
    spreadLobby(match);
}
function joinLobby(match, id) {
    if (match.readyPlayers.has(id)) return true;
    const bot=[...match.players.values()].find(p=>p.isBot && match.readyPlayers.has(p.id));
    if (match.readyPlayers.size >= SIM.MAX_ROUND_PLAYERS && !bot) return false;
    if (bot) removePlayer(match,bot.id);
    match.readyPlayers.add(id); fillLobby(match); return true;
}
function joinAngels(match, p) {
    if (!p || p.inRound) return false;
    const participants=[...match.players.values()].filter(q=>q.inRound);
    if (participants.length >= SIM.MAX_ROUND_PLAYERS) {
        const bot=participants.filter(q=>q.isBot).sort((a,b)=>Number(a.alive)-Number(b.alive))[0];
        if (!bot) return false;
        removePlayer(match,bot.id);
    }
    p.inRound=true; p.alive=false; p.deathTime=match.elapsedMs;
    p.roundJoinIndex=match.nextNetId; return true;
}
function updateBot(match, p) {
    if (!p.inRound || !p.alive) { p.inputHeld=false; return; }
    if (match.elapsedMs < (p.botNextDecision || 0)) return;
    p.botNextDecision=match.elapsedMs+80;
    // Ordinary inputs: no teleporting, invulnerability, or extra forces.
    const phase=(p.botPhase||0);
    const period=270+Math.floor(phase*31)%150;
    let held=((match.elapsedMs+phase*120)%period)<period-65;
    if (match.spikeY-p.y < 420 || p.vy > 320) held=true;
    if ((p.x<100 && p.nextFlapDirection<0) || (p.x>620 && p.nextFlapDirection>0)) {
        if (p.vy < -100) held=false;
    }
    applyInput(p,{seq:p.inputSeq+1,held},match.elapsedMs);
}

function resolvePlayerContacts(match, dt) {
    const ps=[...match.players.values()].filter(p=>p.inRound && p.alive && !isGhosting(p,match.elapsedMs));
    const diameter=SIM.PLAYER_RADIUS*2;
    for (let pass=0; pass<3; pass++) for (let i=0;i<ps.length;i++) for(let j=i+1;j<ps.length;j++) {
        const a=ps[i], b=ps[j];
        let dx=b.x-a.x, dy=b.y-a.y, dist=Math.hypot(dx,dy);
        let remaining=0;
        if (dist>=diameter && pass===0) {
            // Swept circle test catches high-speed players crossing between ticks.
            const sx=b.previousX-a.previousX, sy=b.previousY-a.previousY;
            const mx=dx-sx, my=dy-sy, A=mx*mx+my*my;
            const B=2*(sx*mx+sy*my), C=sx*sx+sy*sy-diameter*diameter;
            const disc=B*B-4*A*C;
            if (!(A>1e-9 && C>0 && disc>=0)) continue;
            const t=(-B-Math.sqrt(disc))/(2*A);
            if(t<0 || t>1) continue;
            a.x=a.previousX+(a.x-a.previousX)*t; a.y=a.previousY+(a.y-a.previousY)*t;
            b.x=b.previousX+(b.x-b.previousX)*t; b.y=b.previousY+(b.y-b.previousY)*t;
            dx=b.x-a.x;dy=b.y-a.y;dist=Math.hypot(dx,dy); remaining=(1-t)*dt;
        } else if(dist>=diameter) continue;
        // Deterministic normal even for exact coincidence (including resurrection).
        const nx=dist>1e-8?dx/dist:1, ny=dist>1e-8?dy/dist:0;
        const separation=Math.max(0,diameter-dist+0.01)*0.5;
        a.x-=nx*separation;a.y-=ny*separation;b.x+=nx*separation;b.y+=ny*separation;
        const approaching=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;
        if(approaching<0) {
            const impulse=-(1+SIM.PLAYER_RESTITUTION)*approaching/2;
            a.vx-=impulse*nx;a.vy-=impulse*ny;b.vx+=impulse*nx;b.vy+=impulse*ny;
            clampVelocity(a);clampVelocity(b);
            if(pass===0 && -approaching>80) match.eventsThisTick.push({type:'player_hit',x:(a.x+b.x)/2,y:(a.y+b.y)/2});
        }
        if(remaining) {a.x+=a.vx*remaining;a.y+=a.vy*remaining;b.x+=b.vx*remaining;b.y+=b.vy*remaining;}
        for(const p of [a,b]) p.x=Math.max(65,Math.min(655,p.x));
    }
}

const WORLD_MAPS=['blocks','coins','powerups','pentagons','hexagonPairs','heptagons','octagons','projectiles'];
function worldFromInit(init) {
    const w=makeWorld();
    for(const key of WORLD_MAPS) w[key]=new Map((init[key]||[]).map(v=>[v.id,{...v}]));
    return w;
}
function applyWorldDelta(w,snap) {
    const names={blocks:'Blocks',coins:'Coins',powerups:'Powerups',pentagons:'Pentagons',hexagonPairs:'HexagonPairs',heptagons:'Heptagons',octagons:'Octagons',projectiles:'Projectiles'};
    const singular={blocks:'Block',coins:'Coin',powerups:'Powerup',pentagons:'Pentagon',hexagonPairs:'HexagonPair',heptagons:'Heptagon',octagons:'Octagon',projectiles:'Projectile'};
    for(const key of WORLD_MAPS) {
        for(const v of snap['new'+names[key]]||[]) w[key].set(v.id,{...v});
        for(const id of snap['removed'+singular[key]+'Ids']||[]) w[key].delete(id);
    }
    for(const [id,scale] of Object.entries(snap.blockScales||{})) {
        const b=w.blocks.get(id);if(b) {b.scale=scale;b.hits=Math.round((1-scale)*5);}
    }
    for(const v of snap.movedCoins||[]) if(w.coins.has(v.id)) Object.assign(w.coins.get(v.id),v);
    for(const [key,states] of [['pentagons','pentagonStates'],['hexagonPairs','hexagonPairStates'],['heptagons','heptagonStates'],['octagons','octagonStates'],['projectiles','projectileStates']]) {
        for(const [id,v] of Object.entries(snap[states]||{})) if(w[key].has(id)) {
            Object.assign(w[key].get(id),v);
            if(key==='projectiles') w[key].get(id).hits=Math.round((1-v.scale)*5);
        }
    }
}
function predictionMatch(snap,world) {
    const m=makeMatch();m.prediction=true;m.tick=snap.tick;m.elapsedMs=snap.tServer;
    m.roundId=snap.roundId;m.mode=snap.mode;m.roundState=snap.roundState;m.hasStarted=snap.hasStarted;
    m.spikeY=snap.spikeY;m.hazardSpeed=snap.hazardSpeed;m.nextIntervalIndex=snap.nextIntervalIndex;
    m.world=makeWorld();
    for(const key of WORLD_MAPS) m.world[key]=new Map([...world[key]].map(([id,v])=>[id,{...v}]));
    for(const [id,p] of Object.entries(snap.players)) {
        m.players.set(id,{...makePlayer(id),...p,activePowerups:{...p.activePowerups},inputQueue:[]});
    }
    return m;
}
return {SIM,makeMatch,makePlayer,addPlayer,removePlayer,resetMatch,beginCountdown,joinLobby,joinAngels,fillLobby,
    buildWorldInit,buildSnapshot,resetTickDeltas,step,applyDevilsScoreTiebreakers,enqueueInput,applyInput,
    resolvePlayerContacts,makeSpatialIndex,generateChunks,worldFromInit,applyWorldDelta,predictionMatch,spreadLobby};

});
