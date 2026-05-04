// AGISCENDS server.

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

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

    HAZARD_BASE_SPEED: 120,
    HAZARD_INCREASE: 20,
    SPIKE_INITIAL_OFFSET: 50,

    START_Y_OFFSET: 200,
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

// Round state machine values. Kept simple — just two states for now,
// with transitions driven by "all alive players died" and the ready vote.
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
        lastChunkY: SIM.CANVAS_HEIGHT + 200,
        highestGeneratedY: SIM.CANVAS_HEIGHT + 200,
        newBlocks: [], newCoins: [],
        newPentagons: [], newHexagonPairs: [], newHeptagons: [], newOctagons: [],
        newProjectiles: [],
        removedBlockIds: [], removedCoinIds: [],
        removedPentagonIds: [], removedHexagonPairIds: [], removedHeptagonIds: [],
        removedOctagonIds: [], removedProjectileIds: [],
    };
}

function isSpaceClear(world, x, y, minDist) {
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
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
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
    };
}

// Reset an existing player in place — used during round reset so we keep
// the same id (and thus the same WS binding) but wipe gameplay state.
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
}

function makeMatch() {
    return {
        players: new Map(),
        world: makeWorld(),
        spikeY: SIM.CANVAS_HEIGHT + SIM.SPIKE_INITIAL_OFFSET,
        hazardSpeed: SIM.HAZARD_BASE_SPEED,
        elapsedMs: 0,
        hasStarted: false,
        nextIntervalIndex: 0,
        eventsThisTick: [],
        roundState: ROUND_RUNNING,
        pendingWorldInitForAll: false, // set by reset(), consumed by the tick loop
    };
}

function addPlayer(match, id) {
    const p = makePlayer(id);
    match.players.set(id, p);
    return p;
}
function removePlayer(match, id) { match.players.delete(id); }
function queueFlap(match, id) {
    // No flapping during ROUND_OVER — the player is either dead or waiting.
    if (match.roundState !== ROUND_RUNNING) return;
    const p = match.players.get(id);
    if (!p || !p.alive) return;
    if (match.elapsedMs - p.lastStunTime < SIM.STUN_DURATION_MS) return;
    p.flapQueued = true;
}

// Triggered by any client during ROUND_OVER. Wipes the world and resets
// all connected players to start.
function resetMatch(match) {
    match.world = makeWorld();
    match.spikeY = SIM.CANVAS_HEIGHT + SIM.SPIKE_INITIAL_OFFSET;
    match.hazardSpeed = SIM.HAZARD_BASE_SPEED;
    match.elapsedMs = 0;
    match.hasStarted = false;
    match.nextIntervalIndex = 0;
    match.eventsThisTick = [];
    match.roundState = ROUND_RUNNING;
    for (const p of match.players.values()) {
        resetPlayer(p);
    }
    // Tell the next tick to send a fresh world_init to everyone.
    match.pendingWorldInitForAll = true;
}

function highestPlayerY(match) {
    let minY = SIM.CANVAS_HEIGHT;
    for (const p of match.players.values()) {
        if (!p.alive) continue;
        if (p.y < minY) minY = p.y;
    }
    return minY;
}
function altitudeFromY(y) {
    return Math.max(0, Math.floor((SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET) - y));
}

// True if any connected player is still alive. Returns false if zero
// players are connected — used to gate the round-over transition.
function anyAlive(match) {
    for (const p of match.players.values()) {
        if (p.alive) return true;
    }
    return false;
}

// True if any player exists (alive or dead) — distinguishes "no one is
// in the room" from "all dead", which we treat differently.
function anyPlayers(match) {
    return match.players.size > 0;
}

function resolveBlockBounce(p, block, scale, eventsArr) {
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
        eventsArr.push({ type: 'hit', x: p.x, y: p.y });
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
        eventsArr.push({ type: 'hit', x: p.x, y: p.y });
        return true;
    }
    return false;
}

function step(match, deltaSeconds) {
    // Always advance the wall clock so logs are coherent and post-flap
    // grace windows on clients don't run on a frozen timer. But while in
    // ROUND_OVER, skip all simulation work below.
    match.elapsedMs += deltaSeconds * 1000;
    match.eventsThisTick = [];

    if (match.roundState === ROUND_OVER) {
        return;
    }

    const w = match.world;
    w.newBlocks = []; w.newCoins = [];
    w.newPentagons = []; w.newHexagonPairs = []; w.newHeptagons = []; w.newOctagons = [];
    w.newProjectiles = [];
    w.removedBlockIds = []; w.removedCoinIds = [];
    w.removedPentagonIds = []; w.removedHexagonPairIds = []; w.removedHeptagonIds = [];
    w.removedOctagonIds = []; w.removedProjectileIds = [];

    if (!match.hasStarted) {
        for (const p of match.players.values()) {
            if (!p.flapQueued) continue;
            p.flapQueued = false;
            p.vy = -SIM.JUMP_FORCE;
            p.vx = SIM.HORIZONTAL_SPEED * p.nextFlapDirection;
            p.facingRight = p.nextFlapDirection === 1;
            p.nextFlapDirection = (p.nextFlapDirection === 1) ? -1 : 1;
            p.lastFlapTime = match.elapsedMs;
            clampVelocity(p);
            match.hasStarted = true;
        }
        return;
    }

    match.spikeY -= match.hazardSpeed * deltaSeconds;
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
            if (!pl.alive) continue;
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

    for (const p of match.players.values()) {
        if (!p.alive) continue;

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
            match.eventsThisTick.push({ type: 'hit', x: newX, y: newY });
        }
        if (newX > maxX) {
            newX = maxX;
            if (p.vx > 0) p.vx = -p.vx * (1 + SIM.PLAYER_BOUNCE * 0.5);
            match.eventsThisTick.push({ type: 'hit', x: newX, y: newY });
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
            if (resolveBlockBounce(p, block, block.scale, match.eventsThisTick)) {
                block.hits++;
                if (block.hits >= 5) {
                    w.blocks.delete(block.id);
                    w.removedBlockIds.push(block.id);
                } else {
                    block.scale = 1.0 - (block.hits * 0.2);
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
                match.eventsThisTick.push({ type: 'hit', x: p.x, y: p.y });
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
            if (resolveBlockBounce(p, fakeBlock, proj.scale, match.eventsThisTick)) {
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

    // Round-end check: only relevant once at least one player has been
    // playing (hasStarted) and the round is currently RUNNING. We don't
    // want to declare round-over before anyone has flapped.
    if (match.hasStarted && match.roundState === ROUND_RUNNING && anyPlayers(match) && !anyAlive(match)) {
        match.roundState = ROUND_OVER;
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
    const players = {};
    for (const p of match.players.values()) {
        players[p.id] = {
            x: p.x, y: p.y, vx: p.vx, vy: p.vy,
            alive: p.alive, facingRight: p.facingRight, score: p.score,
            stunned: (match.elapsedMs - p.lastStunTime) < SIM.STUN_DURATION_MS,
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

    // Final-scores leaderboard — only meaningful during ROUND_OVER but
    // cheap enough to send always. Sorted descending by score.
    const finalScores = [];
    for (const p of match.players.values()) {
        finalScores.push({ id: p.id, score: p.score });
    }
    finalScores.sort((a, b) => b.score - a.score);

    return {
        type: 'snapshot',
        tServer: match.elapsedMs,
        spikeY: match.spikeY,
        hasStarted: match.hasStarted,
        hazardSpeed: match.hazardSpeed,
        roundState: match.roundState,
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
        blockScales: undefined,
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

let nextSessionNum = 1;
function newSessionId() {
    return 'p' + (nextSessionNum++) + '-' + Math.random().toString(36).slice(2, 6);
}

wss.on('connection', (ws) => {
    const sessionId = newSessionId();
    sessionByWs.set(ws, sessionId);
    sideWallSeenByWs.set(ws, 0);
    addPlayer(match, sessionId);
    console.log(`[server] ${sessionId} joined (${match.players.size} total, round=${match.roundState})`);

    ws.send(JSON.stringify({ type: 'welcome', sessionId }));
    ws.send(JSON.stringify(buildWorldInit(match.world)));
    sideWallSeenByWs.set(ws, match.world.sideWallSegments.length);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'flap') {
            queueFlap(match, sessionId);
        } else if (msg.type === 'ready') {
            // Only honored during ROUND_OVER. First ready wins; subsequent
            // ones during the same over-state are ignored (the resetMatch
            // call flips state to RUNNING).
            if (match.roundState === ROUND_OVER) {
                console.log(`[server] ${sessionId} pressed READY — resetting round`);
                resetMatch(match);
            }
        }
    });

    ws.on('close', () => {
        sessionByWs.delete(ws);
        sideWallSeenByWs.delete(ws);
        removePlayer(match, sessionId);
        console.log(`[server] ${sessionId} left (${match.players.size} total, round=${match.roundState})`);
        // If everyone disconnected during ROUND_OVER, snap back to RUNNING
        // so the next joiner gets a clean start.
        if (match.roundState === ROUND_OVER && !anyPlayers(match)) {
            console.log(`[server] all players gone during ROUND_OVER — auto-resetting`);
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

    // Round reset just happened? Send a fresh world_init to all clients
    // BEFORE the regular snapshot. Clients will wipe their local state and
    // rebuild from scratch, then receive the next snapshot which is the
    // first one of the new round.
    if (match.pendingWorldInitForAll) {
        match.pendingWorldInitForAll = false;
        const initMsg = JSON.stringify(buildWorldInit(match.world));
        for (const ws of wss.clients) {
            if (ws.readyState !== 1) continue;
            ws.send(initMsg);
            sideWallSeenByWs.set(ws, match.world.sideWallSegments.length);
        }
    }

    const snapBase = buildSnapshot(match);
    const blockScales = {};
    for (const b of match.world.blocks.values()) {
        if (b.hits > 0) blockScales[b.id] = b.scale;
    }
    snapBase.blockScales = blockScales;

    const totalSegs = match.world.sideWallSegments.length;
    for (const ws of wss.clients) {
        if (ws.readyState !== 1) continue;
        const seen = sideWallSeenByWs.get(ws) || 0;
        let perClientSnap = snapBase;
        if (totalSegs > seen) {
            const newSegs = match.world.sideWallSegments.slice(seen);
            perClientSnap = Object.assign({}, snapBase, { newSideWallSegments: newSegs });
            sideWallSeenByWs.set(ws, totalSegs);
        }
        ws.send(JSON.stringify(perClientSnap));
    }

    logTimer += deltaMs;
    if (logTimer >= 1000) {
        logTimer = 0;
        if (match.players.size > 0) {
            const w = match.world;
            const lines = [
                `t=${(match.elapsedMs / 1000).toFixed(1)}s round=${match.roundState} spikeY=${match.spikeY.toFixed(0)} hazard=${match.hazardSpeed} interval=${match.nextIntervalIndex} ` +
                `blocks=${w.blocks.size} coins=${w.coins.size} pent=${w.pentagons.size} hex=${w.hexagonPairs.size} ` +
                `hept=${w.heptagons.size} oct=${w.octagons.size} proj=${w.projectiles.size}`
            ];
            for (const p of match.players.values()) {
                lines.push(`  ${p.id}: y=${p.y.toFixed(0)} score=${p.score} ${p.alive ? 'alive' : 'DEAD'}`);
            }
            console.log(lines.join('\n'));
        }
    }
}, TICK_INTERVAL_MS);

server.listen(PORT, () => {
    console.log(`AGISCENDS server listening on http://localhost:${PORT}/`);
    console.log(`Serving client from: ${CLIENT_DIR}`);
});