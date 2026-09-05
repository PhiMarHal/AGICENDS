// AGICENDS server.

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

const Sim = require('../client/simulation.js');
const Protocol = require('../client/protocol.js');
const ROUND_WAITING='waiting', ROUND_COUNTDOWN='countdown', ROUND_RUNNING='running', ROUND_OVER='round_over';
const { SIM, makeMatch, addPlayer, removePlayer, resetMatch, beginCountdown,
    buildWorldInit, buildSnapshot, resetTickDeltas, step, applyDevilsScoreTiebreakers } = Sim;

const PORT = Number(process.env.PORT || 2567);
const TICK_RATE_HZ = 60;
const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const app = express();
app.use(express.static(CLIENT_DIR));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1024, perMessageDeflate: false });

// Two concurrent matches, one per mode. Players are routed by the
// `?mode=` query parameter on the WebSocket URL. Devils and Angels
// run independently — separate worlds, separate scores, separate
// readiness lobbies. Empty matches still tick, but the cost is trivial.
const matches = {};
for (const mode of ['devils', 'angels']) {
    const m = makeMatch();
    m.mode = mode;
    m.onRoundOver = m => recordMatchResults(m).catch(err=>console.error('[stats]',err));
    m.clients = new Set();     // WS connections currently in this match
    matches[mode] = m;
}

const sessionByWs = new Map();


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
            signal: AbortSignal.timeout(5000),
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (data && data.ok && data.user) {
            return { id: data.user.id, display_name: data.user.display_name, mmr: data.user.mmr, appearance: data.user.appearance || null };
        }
    } catch (err) {
        console.warn('[auth] verify error:', err.message);
    }
    return null;
}

// Break exact-score ties among Devils players by giving later-diers a
// small bonus over earlier-diers (+0, +1, +2, … within a tie group, in
// ascending order of deathTime). For simultaneous deaths within a tie,
// the secondary sort puts later-joiners earlier in the tiebreak order
// — which means earlier-joiners end up last and get the largest boost.
// That's the "small reward for sticking it out from round start" rule.
//
// Iterates until no ties remain. A +1 bump can land on an adjacent
// player's score, requiring another pass to break the new tie. With
// the current scoring (+4 per interval crossed) cascades are very
// rare, but the loop ensures correctness regardless.
//
// Operates on a scoreFor Map<player, score> so we never mutate the
// player.score field on the live state — the round-over UI is still
// driving off match.players for a couple of seconds after this runs.
// POSTs the results of a finished round to the Worker's /stats/record.
// Builds the player list from match.players (anyone with inRound=true),
// computes ranks from scores, and fires the request without awaiting it
// from the caller's perspective. Errors are logged and swallowed.
async function recordMatchResults(match) {
    if (!AUTH_WORKER_URL || !GAME_SERVER_SHARED_SECRET) return;

    const isAngels = match.mode === 'angels';
    const inRoundPlayers = [];
    for (const p of match.players.values()) {
        if (p.inRound) inRoundPlayers.push(p);
    }
    if (inRoundPlayers.length === 0) return;

    // Per-player final score. Angels: every player shares the team
    // score, no tiebreaker (it's co-op — ties are the point). Devils:
    // per-player score, tiebreak runs to make every score unique.
    const scoreFor = new Map();
    for (const p of inRoundPlayers) {
        scoreFor.set(p, Math.round((isAngels ? match.teamScore : p.score) || 0));
    }
    if (!isAngels) {
        applyDevilsScoreTiebreakers(inRoundPlayers, scoreFor);
    }

    const players = [];
    for (const p of inRoundPlayers) {
        const entry = {
            display_name: p.displayName || p.id,
            final_score: scoreFor.get(p),
            finishing_rank: 0,        // filled in below after sorting
        };
        if (p.userId) entry.user_id = p.userId;
        players.push(entry);
    }

    // Standard competition ranking: ties share a rank, the next rank
    // skips by however many tied. e.g. 100, 80, 80, 50 → 1, 2, 2, 4.
    // After the Devils tiebreaker above, ties are only possible in
    // Angels (where every score equals match.teamScore and they all
    // get rank=1) — which is the desired co-op behaviour.
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
            signal: AbortSignal.timeout(10000),
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-game-server-secret': GAME_SERVER_SHARED_SECRET,
            },
            body: JSON.stringify({
                mode: match.mode,
                ended_at: Date.now(),
                players,
            }),
        });
        if (res.ok) {
            const data = await res.json();
            console.log(`[stats] match recorded (id=${data.match_id}, ${players.length} player(s))`);
            // Broadcast on every successful record so clients can refresh
            // the leaderboard panel and (for authed players in Devils) see
            // their MMR change. Empty changes are fine — applyMmrUpdate
            // gracefully no-ops if the local user isn't represented.
            if (data.mmr_changes !== undefined) {
                const msg = JSON.stringify({ type: 'mmr_update', changes: data.mmr_changes || {} });
                for (const client of match.clients) {
                    if (client.readyState === 1) client.send(msg);
                }
            }
        } else {
            console.warn(`[stats] record failed: ${res.status} ${await res.text()}`);
        }
    } catch (err) {
        console.warn('[stats] network error recording match:', err.message);
    }
}

wss.on('connection', async (ws, request) => {
    // Reject if we've hit the hard connection cap across all matches.
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

    // Route to the requested match. Unknown / missing mode falls back
    // to devils so older clients that don't send ?mode= keep working
    // unchanged during the rollout.
    let mode = reqUrl.searchParams.get('mode');
    if (mode !== 'angels' && mode !== 'devils') mode = 'devils';
    const match = matches[mode];

    const authedUser = await verifyAuthToken(token);
    if (ws.readyState !== 1) return;

    const sessionId = newSessionId(match);
    sessionByWs.set(ws, sessionId);
    match.clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.inputWindow = Date.now(); ws.inputCount = 0;
    const player = addPlayer(match, sessionId);
    if (authedUser) {
        player.userId = authedUser.id;
        player.displayName = authedUser.display_name;
        player.appearance = authedUser.appearance;
    }

    console.log(`[server] ${sessionId} joined ${mode} as ${authedUser ? authedUser.display_name : 'anon'} (${match.players.size} total, round=${match.roundState})`);

    ws.send(JSON.stringify({
        type: 'welcome', protocol: Protocol.VERSION,
        sessionId,
        mode,
        user: authedUser ? { id: authedUser.id, display_name: authedUser.display_name, mmr: authedUser.mmr } : null,
    }));
    ws.send(JSON.stringify({type:'roster', players:Protocol.rosterOf(match)}));
    ws.send(JSON.stringify(buildWorldInit(match.world)));

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (!msg || typeof msg !== 'object') return;
        const now = Date.now();
        if (now - ws.inputWindow >= 1000) { ws.inputWindow = now; ws.inputCount = 0; }
        if (++ws.inputCount > 80) { ws.close(1008, 'Input rate exceeded'); return; }
        if (msg.type === 'ping') {
            if (typeof msg.t === 'number') ws.send(JSON.stringify({type:'pong',t:msg.t}));
        } else if (msg.type === 'input') {
            const p = match.players.get(sessionId);
            if (Sim.enqueueInput(match, p, msg)) p.lastInputReceived = match.elapsedMs;

        } else if (msg.type === 'ready') {
            if (match.roundState === ROUND_WAITING) {
                // First player to click READY boots the new round: rebuild world
                // and open a 10-s lobby window for others to join.
                resetMatch(match);
                beginCountdown(match, sessionId);
                Sim.fillLobby(match);

            } else if (match.roundState === ROUND_COUNTDOWN) {
                // Join the upcoming round during the open lobby window.
                Sim.joinLobby(match, sessionId);

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
                Sim.fillLobby(match);

            } else if (match.roundState === ROUND_RUNNING && match.mode === 'angels') {
                // Mid-round join in Angels: absorb the player into the team
                // as a dead participant. They sit at the back of the
                // resurrection queue (latest deathTime) and get rezzed at
                // the next interval crossing after all earlier deaths.
                // They appear on the game-over scoreboard and get the team
                // score recorded. Devils mode silently ignores ready during
                // RUNNING (no fallthrough).
                if (!Sim.joinAngels(match, match.players.get(sessionId))) {
                    ws.send(JSON.stringify({type:'join_rejected',reason:'This round is full.'}));
                }
            }
        }
    });

    ws.on('close', () => {
        sessionByWs.delete(ws);

        match.clients.delete(ws);
        if (match.clients.size === 0) {
            // Bots never keep an abandoned match simulating forever.
            resetMatch(match); removePlayer(match, sessionId); return;
        }

        const p = match.players.get(sessionId);

        if (p && match.roundState === ROUND_RUNNING && p.inRound) {
            // Player committed to this round — keep them in match.players so
            // they appear on the game-over scoreboard and get recorded in
            // stats. Kill them now (no resurrection in Angels) and tag them
            // disconnected so cleanup can find them later. This prevents the
            // "switch mode / close tab to avoid a loss" exploit.
            p.alive = false; p.inputHeld = false;
            if (p.deathTime == null) p.deathTime = match.elapsedMs;
            p.disconnected = true;
            console.log(`[server] ${sessionId} disconnected mid-${match.mode} (committed as dead participant)`);
            return;
        }

        removePlayer(match, sessionId);
        if (match.roundState === 'countdown') Sim.fillLobby(match);
        console.log(`[server] ${sessionId} left ${match.mode} (${match.players.size} total, round=${match.roundState})`);

        if (match.roundState === ROUND_OVER) {
            // Auto-reset only if no *real* (non-ghost) players remain. Ghosts
            // will be cleaned up by resetMatch when that fires.
            let hasReal = false;
            for (const q of match.players.values()) {
                if (!q.disconnected && !q.isBot) { hasReal = true; break; }
            }
            if (!hasReal) {
                console.log(`[server] all ${match.mode} players gone during ROUND_OVER — auto-resetting`);
                resetMatch(match);
            }
        }
    });

    ws.on('error', (err) => console.warn(`[server] ws error for ${sessionId}:`, err.message));
});

// Monotonic accumulator; simulation and publication have independent frequencies.
// A long event-loop stall gets at most five recovery steps, never one enormous step.
const { performance } = require('node:perf_hooks');
let lastTickTime = performance.now(), accumulator = 0;
const MAX_QUEUED_BYTES = 128 * 1024;
function sendBounded(ws, payload) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_QUEUED_BYTES) { ws.terminate(); return; }
    ws.send(payload);
}
function publish(match) {
    const roster = JSON.stringify({type:'roster',players:Protocol.rosterOf(match)});
    if (match.lastRoster !== roster) {
        match.lastRoster = roster;
        for (const ws of match.clients) sendBounded(ws, roster);
    }
    if (match.pendingWorldInitForAll) {
        match.pendingWorldInitForAll = false;
        const init = JSON.stringify(buildWorldInit(match.world));
        for (const ws of match.clients) sendBounded(ws, init);
        resetTickDeltas(match.world);
    }
    // Serialize once; all recipients get the same motion/world packet.
    const snapshot = buildSnapshot(match);
    snapshot.movedCoins = [...new Map(snapshot.movedCoins.map(c=>[c.id,c])).values()];
    const payload = Protocol.encode(snapshot);
    for (const ws of match.clients) sendBounded(ws, payload);
    resetTickDeltas(match.world); match.eventsThisTick = [];
}
const timer = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(now - lastTickTime, 250); lastTickTime = now;
    let steps = 0;
    while (accumulator >= TICK_INTERVAL_MS && steps < 5) {
        accumulator -= TICK_INTERVAL_MS; steps++;
        for (const match of Object.values(matches)) {
            if (!match.clients.size) continue;
            for (const p of match.players.values()) {
                if (!p.isBot && p.inputHeld && match.elapsedMs-(p.lastInputReceived||0)>1000) p.inputHeld=false;
            }
            step(match);
            const every = match.roundState === 'running' ? 3 : match.roundState === 'countdown' ? 6 : 60;
            if (match.tick % every === 0 || match.pendingWorldInitForAll || match.roundState !== match.lastPublishedState) {
                publish(match); match.lastPublishedState = match.roundState;
            }
        }
    }
    if (steps === 5 && accumulator >= TICK_INTERVAL_MS) accumulator %= TICK_INTERVAL_MS;
}, 4);
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive=false; ws.ping();
    }
}, 15000);
wss.on('close',()=>{clearInterval(timer);clearInterval(heartbeat);});
server.listen(PORT, () => console.log(`AGICENDS: http://localhost:${server.address().port}/ — 60 Hz physics, 20 Hz play snapshots, 16 slots`));
