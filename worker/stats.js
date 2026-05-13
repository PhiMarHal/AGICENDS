// AGISCENDS match-result storage.
//
//   POST /stats/record         — server-to-server write (requires header
//                                `X-Game-Server-Secret: <shared secret>`)
//     body: {
//         mode,             // 'angels' | 'devils' | null
//         started_at,       // unix epoch ms (optional)
//         ended_at,         // unix epoch ms
//         players: [
//             { user_id?, display_name, final_score, finishing_rank }
//         ]
//     }
//     → 200 { ok: true, match_id: <new id> }
//
//   GET /stats/user/:id        — public; aggregate stats + recent matches
//                                for one user. 404 if no such user.
//
//   GET /stats/recent          — public; most recent matches with all
//                                their players. Optional ?limit=N
//                                (default 20, max 100).

import { json, safeJson, one, all, run } from './index.js';

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 100;
const USER_RECENT_MATCHES = 10;

// ─── POST /stats/record ────────────────────────────────────────────────

export async function recordMatch(request, env) {
    const provided = request.headers.get('x-game-server-secret');
    if (!provided || provided !== env.GAME_SERVER_SHARED_SECRET) {
        return json({ error: 'unauthorized' }, 401);
    }

    const body = await safeJson(request);
    const validation = validateMatchBody(body);
    if (validation.error) {
        return json({ error: validation.error, message: validation.message }, 400);
    }
    const { mode, started_at, ended_at, players } = validation.match;

    // Insert the matches row first so we have its id for the players.
    // D1's JS API doesn't easily let us reference last_insert_rowid()
    // across statements in a single batch, so we do this in two steps
    // and clean up the orphan matches row if the players batch fails.
    const matchInsert = await run(env,
        'INSERT INTO matches(mode, started_at, ended_at) VALUES(?, ?, ?)',
        mode, started_at, ended_at,
    );
    const matchId = matchInsert.meta.last_row_id;

    const playerStmts = players.map(p =>
        env.DB.prepare(
            `INSERT INTO match_players(match_id, user_id, display_name,
                                       final_score, finishing_rank)
             VALUES(?, ?, ?, ?, ?)`
        ).bind(
            matchId,
            p.user_id ?? null,
            p.display_name,
            p.final_score,
            p.finishing_rank,
        )
    );

    try {
        await env.DB.batch(playerStmts);
    } catch (err) {
        // Roll back the matches row so we don't leave an orphan.
        console.error('match_players batch failed, rolling back match', matchId, err);
        try { await run(env, 'DELETE FROM matches WHERE id = ?', matchId); }
        catch (_) { /* best-effort */ }
        return json({ error: 'players_insert_failed' }, 500);
    }

    return json({ ok: true, match_id: matchId });
}

// Returns { error, message } on failure or { match } on success.
// We validate strictly even though this is a trusted endpoint — bugs
// in the game server are easier to spot when the Worker rejects them
// than when they silently corrupt the DB.
function validateMatchBody(body) {
    if (!body || typeof body !== 'object') {
        return { error: 'invalid_body', message: 'Body must be a JSON object.' };
    }
    const { mode, started_at, ended_at, players } = body;

    if (mode != null && typeof mode !== 'string') {
        return { error: 'invalid_body', message: 'mode must be a string or null.' };
    }
    if (started_at != null && (typeof started_at !== 'number' || started_at <= 0)) {
        return { error: 'invalid_body', message: 'started_at must be a positive number (unix ms) or null.' };
    }
    if (typeof ended_at !== 'number' || ended_at <= 0) {
        return { error: 'invalid_body', message: 'ended_at is required (positive number, unix ms).' };
    }
    if (!Array.isArray(players) || players.length === 0) {
        return { error: 'invalid_body', message: 'players must be a non-empty array.' };
    }

    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!p || typeof p !== 'object') {
            return { error: 'invalid_body', message: `players[${i}] must be an object.` };
        }
        if (p.user_id != null && (!Number.isInteger(p.user_id) || p.user_id <= 0)) {
            return { error: 'invalid_body', message: `players[${i}].user_id must be a positive integer or omitted.` };
        }
        if (typeof p.display_name !== 'string'
            || p.display_name.length === 0
            || p.display_name.length > 64) {
            return { error: 'invalid_body', message: `players[${i}].display_name must be a 1–64 character string.` };
        }
        if (!Number.isInteger(p.final_score)) {
            return { error: 'invalid_body', message: `players[${i}].final_score must be an integer.` };
        }
        if (!Number.isInteger(p.finishing_rank) || p.finishing_rank < 1) {
            return { error: 'invalid_body', message: `players[${i}].finishing_rank must be a positive integer.` };
        }
    }

    return {
        match: {
            mode: mode ?? null,
            started_at: started_at ?? null,
            ended_at,
            players,
        },
    };
}

// ─── GET /stats/user/:id ───────────────────────────────────────────────

export async function getUserStats(_request, env, _ctx, params) {
    const userId = Number.parseInt(params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
        return json({ error: 'invalid_user_id' }, 400);
    }

    const user = await one(env,
        'SELECT id, display_name FROM users WHERE id = ?',
        userId,
    );
    if (!user) {
        return json({ error: 'user_not_found' }, 404);
    }

    // Aggregate stats. COALESCE the SUM so an empty result returns 0
    // rather than null. MAX and AVG stay nullable — null is the truthful
    // answer for "best score" when there are no matches.
    const agg = await one(env,
        `SELECT
            COUNT(*)                                            AS matches_played,
            COALESCE(SUM(CASE WHEN finishing_rank = 1 THEN 1 ELSE 0 END), 0) AS wins,
            MAX(final_score)                                    AS best_score,
            AVG(final_score)                                    AS avg_score
         FROM match_players
         WHERE user_id = ?`,
        userId,
    );

    const recent = await all(env,
        `SELECT m.id AS match_id, m.mode, m.ended_at,
                mp.final_score, mp.finishing_rank
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ?
         ORDER BY m.ended_at DESC
         LIMIT ?`,
        userId, USER_RECENT_MATCHES,
    );

    return json({
        user: { id: user.id, display_name: user.display_name },
        stats: {
            matches_played: agg.matches_played || 0,
            wins: agg.wins || 0,
            best_score: agg.best_score,
            avg_score: agg.avg_score,
        },
        recent_matches: recent,
    });
}

// ─── GET /stats/recent ─────────────────────────────────────────────────

export async function getRecentMatches(request, env) {
    const url = new URL(request.url);
    let limit = Number.parseInt(url.searchParams.get('limit'), 10);
    if (!Number.isInteger(limit) || limit <= 0) {
        limit = DEFAULT_RECENT_LIMIT;
    }
    limit = Math.min(limit, MAX_RECENT_LIMIT);

    // Single query: join the N most recent matches with all their
    // players. We group flat rows by match_id in JS afterward.
    const rows = await all(env,
        `SELECT
            m.id AS match_id, m.mode, m.started_at, m.ended_at,
            mp.user_id, mp.display_name, mp.final_score, mp.finishing_rank
         FROM matches m
         JOIN match_players mp ON mp.match_id = m.id
         WHERE m.id IN (
            SELECT id FROM matches ORDER BY ended_at DESC LIMIT ?
         )
         ORDER BY m.ended_at DESC, mp.finishing_rank ASC`,
        limit,
    );

    const matchesById = new Map();
    for (const r of rows) {
        let m = matchesById.get(r.match_id);
        if (!m) {
            m = {
                id: r.match_id,
                mode: r.mode,
                started_at: r.started_at,
                ended_at: r.ended_at,
                players: [],
            };
            matchesById.set(r.match_id, m);
        }
        m.players.push({
            user_id: r.user_id,
            display_name: r.display_name,
            final_score: r.final_score,
            finishing_rank: r.finishing_rank,
        });
    }

    return json({ matches: Array.from(matchesById.values()) });
}