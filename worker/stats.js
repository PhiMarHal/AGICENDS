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
//
//   GET /stats/user/:id        — public; aggregate stats for one user
//   GET /stats/recent          — public; most recent N matches
//
// All three are stubs for now. We'll fill them in once auth is wired up
// end-to-end and the game server is actually posting results.

import { json } from './index.js';

export async function recordMatch(request, env) {
    const provided = request.headers.get('x-game-server-secret');
    if (!provided || provided !== env.GAME_SERVER_SHARED_SECRET) {
        return json({ error: 'unauthorized' }, 401);
    }

    // TODO: parse body, insert into matches + match_players in a batch.
    return json({ error: 'not_implemented' }, 501);
}

export async function getUserStats(_request, _env, _ctx, _params) {
    // TODO: SELECT count, avg(score), best score, recent matches for user.
    return json({ error: 'not_implemented' }, 501);
}

export async function getRecentMatches(_request, _env) {
    // TODO: SELECT recent N matches with their match_players joined in.
    return json({ error: 'not_implemented' }, 501);
}