// AGISCENDS server.
// Plain Node.js, no framework. Uses Express to serve the static client,
// and the `ws` library for WebSocket connections.
//
// Run from the server/ folder with: npm start
// Open: http://localhost:2567/

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

// ============================================================================
// Game simulation
// ============================================================================

const SIM = {
    CANVAS_WIDTH: 720,
    CANVAS_HEIGHT: 1080,
    GRAVITY: 1600,            // px/s^2
    JUMP_FORCE: 650,          // px/s, applied as upward velocity
    HORIZONTAL_SPEED: 400,    // px/s on flap
    MAX_FALL_SPEED: 800,
    WALL_THICKNESS: 35,
    FLAP_COOLDOWN_MS: 200,
    HAZARD_BASE_SPEED: 120,   // spike rise speed (px/s)
    START_Y_OFFSET: 200,
    SPIKE_INITIAL_OFFSET: 50,
};

function makePlayer(id) {
    return {
        id,
        x: SIM.CANVAS_WIDTH / 2,
        y: SIM.CANVAS_HEIGHT - SIM.START_Y_OFFSET,
        vx: 0,
        vy: 0,
        alive: true,
        facingRight: true,
        lastFlapTime: -Infinity,
        flapQueued: false,
        nextFlapDirection: 1,
    };
}

function makeSimulation() {
    return {
        players: new Map(),
        spikeY: SIM.CANVAS_HEIGHT + SIM.SPIKE_INITIAL_OFFSET,
        elapsedMs: 0,
        hasStarted: false,
    };
}

function addPlayer(sim, id) {
    const p = makePlayer(id);
    sim.players.set(id, p);
    return p;
}

function removePlayer(sim, id) {
    sim.players.delete(id);
}

function queueFlap(sim, id) {
    const p = sim.players.get(id);
    if (!p || !p.alive) return;
    p.flapQueued = true;
}

function step(sim, deltaSeconds) {
    sim.elapsedMs += deltaSeconds * 1000;

    // Pre-start: process flap inputs only; nothing moves.
    if (!sim.hasStarted) {
        for (const p of sim.players.values()) {
            if (!p.flapQueued) continue;
            p.flapQueued = false;
            p.vy = -SIM.JUMP_FORCE;
            p.vx = SIM.HORIZONTAL_SPEED * p.nextFlapDirection;
            p.facingRight = p.nextFlapDirection === 1;
            p.nextFlapDirection = (p.nextFlapDirection === 1) ? -1 : 1;
            p.lastFlapTime = sim.elapsedMs;
            sim.hasStarted = true;
        }
        return;
    }

    // Live: spikes rise, physics runs.
    sim.spikeY -= SIM.HAZARD_BASE_SPEED * deltaSeconds;

    for (const p of sim.players.values()) {
        if (!p.alive) continue;

        if (p.flapQueued) {
            p.flapQueued = false;
            if (sim.elapsedMs - p.lastFlapTime >= SIM.FLAP_COOLDOWN_MS) {
                p.vy = -SIM.JUMP_FORCE;
                p.vx = SIM.HORIZONTAL_SPEED * p.nextFlapDirection;
                p.facingRight = p.nextFlapDirection === 1;
                p.nextFlapDirection = (p.nextFlapDirection === 1) ? -1 : 1;
                p.lastFlapTime = sim.elapsedMs;
            }
        }

        p.vy += SIM.GRAVITY * deltaSeconds;
        if (p.vy > SIM.MAX_FALL_SPEED) p.vy = SIM.MAX_FALL_SPEED;

        p.x += p.vx * deltaSeconds;
        p.y += p.vy * deltaSeconds;

        const minX = SIM.WALL_THICKNESS;
        const maxX = SIM.CANVAS_WIDTH - SIM.WALL_THICKNESS;
        if (p.x < minX) { p.x = minX; p.vx = 0; }
        if (p.x > maxX) { p.x = maxX; p.vx = 0; }

        if (p.y > sim.spikeY) {
            p.alive = false;
        }
    }
}

function buildSnapshot(sim) {
    const players = {};
    for (const p of sim.players.values()) {
        players[p.id] = {
            x: p.x,
            y: p.y,
            vx: p.vx,
            vy: p.vy,
            alive: p.alive,
            facingRight: p.facingRight,
        };
    }
    return {
        type: 'snapshot',
        spikeY: sim.spikeY,
        hasStarted: sim.hasStarted,
        tServer: sim.elapsedMs,
        players,
    };
}

// ============================================================================
// Server
// ============================================================================

const PORT = 2567;
const TICK_RATE_HZ = 60;
const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;

// Serve the sibling client/ folder. __dirname is the server/ folder this file lives in.
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const app = express();
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const sim = makeSimulation();
const sessionByWs = new Map();

let nextSessionNum = 1;
function newSessionId() {
    return 'p' + (nextSessionNum++) + '-' + Math.random().toString(36).slice(2, 6);
}

wss.on('connection', (ws) => {
    const sessionId = newSessionId();
    sessionByWs.set(ws, sessionId);
    addPlayer(sim, sessionId);
    console.log(`[server] ${sessionId} joined (${sim.players.size} total)`);

    ws.send(JSON.stringify({ type: 'welcome', sessionId }));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        if (msg.type === 'flap') {
            queueFlap(sim, sessionId);
        }
    });

    ws.on('close', () => {
        sessionByWs.delete(ws);
        removePlayer(sim, sessionId);
        console.log(`[server] ${sessionId} left (${sim.players.size} total)`);
    });

    ws.on('error', (err) => {
        console.warn(`[server] ws error for ${sessionId}:`, err.message);
    });
});

function broadcastToAll(messageStr) {
    for (const client of wss.clients) {
        if (client.readyState === 1 /* OPEN */) {
            client.send(messageStr);
        }
    }
}

let lastTickTime = Date.now();
let logTimer = 0;
setInterval(() => {
    const now = Date.now();
    const deltaMs = now - lastTickTime;
    lastTickTime = now;

    step(sim, deltaMs / 1000);

    const snapshot = buildSnapshot(sim);
    broadcastToAll(JSON.stringify(snapshot));

    logTimer += deltaMs;
    if (logTimer >= 1000) {
        logTimer = 0;
        if (sim.players.size > 0) {
            const lines = [`spikeY=${sim.spikeY.toFixed(0)}`];
            for (const p of sim.players.values()) {
                lines.push(
                    `  ${p.id}: x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} vy=${p.vy.toFixed(0)} ${p.alive ? 'alive' : 'DEAD'}`
                );
            }
            console.log(lines.join('\n'));
        }
    }
}, TICK_INTERVAL_MS);

server.listen(PORT, () => {
    console.log(`AGISCENDS server listening on http://localhost:${PORT}/`);
    console.log(`Serving client from: ${CLIENT_DIR}`);
});