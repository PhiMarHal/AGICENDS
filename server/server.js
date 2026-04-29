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

    // Hard velocity caps — match single-player's setMaxVelocity(horizontalSpeed*2, 2400).
    // These prevent runaway bounce-stacking when a player hits multiple walls/blocks
    // in quick succession.
    MAX_VX: 800,
    MAX_VY_UP: 2400,
    MAX_VY_DOWN: 2400,

    WALL_THICKNESS: 35,
    OBSTACLE_SIZE: 45,
    BLOCK_RENDER_SIZE: 90,
    FLAP_COOLDOWN_MS: 200,

    HAZARD_BASE_SPEED: 120,
    HAZARD_INCREASE: 10,
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
};

// Apply velocity caps. Called after any operation that modifies velocity:
// flaps, gravity, bounces. This is what keeps the simulation stable.
function clampVelocity(p) {
    if (p.vx > SIM.MAX_VX) p.vx = SIM.MAX_VX;
    if (p.vx < -SIM.MAX_VX) p.vx = -SIM.MAX_VX;
    if (p.vy > SIM.MAX_VY_DOWN) p.vy = SIM.MAX_VY_DOWN;
    if (p.vy < -SIM.MAX_VY_UP) p.vy = -SIM.MAX_VY_UP;
}

function randBetween(min, max) { return Math.random() * (max - min) + min; }
function randIntBetween(min, max) { return Math.floor(randBetween(min, max + 1)); }

let nextObstacleId = 1;
function newObstacleId() { return 'o' + (nextObstacleId++); }
let nextCoinId = 1;
function newCoinId() { return 'c' + (nextCoinId++); }

function makeWorld() {
    const intervalAltitudes = [];
    for (let n = 1; n <= 100; n++) intervalAltitudes.push(n * SIM.BASE_INTERVAL);
    return {
        blocks: new Map(),
        coins: new Map(),
        sideWallSegments: [],
        intervalAltitudes,
        generatedIntervalBarriers: new Set(),
        lastChunkY: SIM.CANVAS_HEIGHT + 200,
        highestGeneratedY: SIM.CANVAS_HEIGHT + 200,
        newBlocksThisTick: [],
        newCoinsThisTick: [],
        removedBlockIdsThisTick: [],
        removedCoinIdsThisTick: [],
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
    const startY = SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET;
    for (const intervalAlt of world.intervalAltitudes) {
        const intervalY = startY - intervalAlt;
        if (Math.abs(y - intervalY) < SIM.EXCLUSION_RADIUS) return false;
    }
    return true;
}

function spawnBlock(world, x, y) {
    const block = { id: newObstacleId(), x, y, hits: 0, scale: 1.0 };
    world.blocks.set(block.id, block);
    world.newBlocksThisTick.push(block);
    return block;
}

function spawnCoin(world, x, y) {
    const coin = { id: newCoinId(), x, y };
    world.coins.set(coin.id, coin);
    world.newCoinsThisTick.push(coin);
    return coin;
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
        const x = startX + i * (blockSize + gap);
        spawnBlock(world, x, y);
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
            const coinY = baseY - (row + 1) * coinSpacing;
            spawnCoin(world, colX, coinY);
        }
    }
}

function generateChunks(world, targetY) {
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
    };
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
    };
}

function addPlayer(match, id) {
    const p = makePlayer(id);
    match.players.set(id, p);
    return p;
}
function removePlayer(match, id) { match.players.delete(id); }
function queueFlap(match, id) {
    const p = match.players.get(id);
    if (!p || !p.alive) return;
    p.flapQueued = true;
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

function step(match, deltaSeconds) {
    match.elapsedMs += deltaSeconds * 1000;
    match.world.newBlocksThisTick = [];
    match.world.newCoinsThisTick = [];
    match.world.removedBlockIdsThisTick = [];
    match.world.removedCoinIdsThisTick = [];
    match.eventsThisTick = [];

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
    generateChunks(match.world, highY - SIM.CANVAS_HEIGHT * 1.5);

    for (const p of match.players.values()) {
        if (!p.alive) continue;

        if (p.flapQueued) {
            p.flapQueued = false;
            if (match.elapsedMs - p.lastFlapTime >= SIM.FLAP_COOLDOWN_MS) {
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
        for (const coin of match.world.coins.values()) {
            const dx = p.x - coin.x, dy = p.y - coin.y;
            if (dx * dx + dy * dy < coinPickRadiusSq) {
                match.world.coins.delete(coin.id);
                match.world.removedCoinIdsThisTick.push(coin.id);
                p.score += 4;
                match.eventsThisTick.push({ type: 'coin_collected', coinId: coin.id, x: coin.x, y: coin.y, by: p.id });
            }
        }

        for (const block of match.world.blocks.values()) {
            const halfSize = (SIM.BLOCK_RENDER_SIZE * block.scale) / 2;
            const left = block.x - halfSize;
            const right = block.x + halfSize;
            const top = block.y - halfSize;
            const bottom = block.y + halfSize;
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
                block.hits++;
                if (block.hits >= 5) {
                    match.world.blocks.delete(block.id);
                    match.world.removedBlockIdsThisTick.push(block.id);
                } else {
                    block.scale = 1.0 - (block.hits * 0.2);
                }
                match.eventsThisTick.push({ type: 'hit', x: p.x, y: p.y });
            }
        }

        if (p.y > match.spikeY) {
            p.alive = false;
            match.eventsThisTick.push({ type: 'death', playerId: p.id });
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
}

function buildWorldInit(world) {
    return {
        type: 'world_init',
        blocks: Array.from(world.blocks.values()),
        coins: Array.from(world.coins.values()),
        sideWallSegments: world.sideWallSegments,
    };
}

function buildSnapshot(match) {
    const players = {};
    for (const p of match.players.values()) {
        players[p.id] = {
            x: p.x, y: p.y, vx: p.vx, vy: p.vy,
            alive: p.alive, facingRight: p.facingRight, score: p.score,
        };
    }
    return {
        type: 'snapshot',
        tServer: match.elapsedMs,
        spikeY: match.spikeY,
        hasStarted: match.hasStarted,
        hazardSpeed: match.hazardSpeed,
        players,
        newBlocks: match.world.newBlocksThisTick,
        newCoins: match.world.newCoinsThisTick,
        removedBlockIds: match.world.removedBlockIdsThisTick,
        removedCoinIds: match.world.removedCoinIdsThisTick,
        newSideWallSegments: [],
        events: match.eventsThisTick,
        blockScales: undefined,
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
    console.log(`[server] ${sessionId} joined (${match.players.size} total)`);

    ws.send(JSON.stringify({ type: 'welcome', sessionId }));
    ws.send(JSON.stringify(buildWorldInit(match.world)));
    sideWallSeenByWs.set(ws, match.world.sideWallSegments.length);

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'flap') queueFlap(match, sessionId);
    });

    ws.on('close', () => {
        sessionByWs.delete(ws);
        sideWallSeenByWs.delete(ws);
        removePlayer(match, sessionId);
        console.log(`[server] ${sessionId} left (${match.players.size} total)`);
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
            const lines = [
                `t=${(match.elapsedMs / 1000).toFixed(1)}s  spikeY=${match.spikeY.toFixed(0)}  hazard=${match.hazardSpeed}  blocks=${match.world.blocks.size}  coins=${match.world.coins.size}  interval=${match.nextIntervalIndex}`
            ];
            for (const p of match.players.values()) {
                lines.push(`  ${p.id}: y=${p.y.toFixed(0)} vx=${p.vx.toFixed(0)} vy=${p.vy.toFixed(0)} score=${p.score} ${p.alive ? 'alive' : 'DEAD'}`);
            }
            console.log(lines.join('\n'));
        }
    }
}, TICK_INTERVAL_MS);

server.listen(PORT, () => {
    console.log(`AGISCENDS server listening on http://localhost:${PORT}/`);
    console.log(`Serving client from: ${CLIENT_DIR}`);
});