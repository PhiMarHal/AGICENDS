// AGICENDS auth + stats Worker — entry point.
//
// Every incoming HTTP request lands in the default `fetch` export at the
// bottom of this file. It passes the request to a tiny router, which
// dispatches to handlers in auth.js and stats.js. The response goes back
// through `withCors` so browsers can call us.
//
// This file holds everything generic: the router, the CORS layer, small
// JSON-response and JSON-body helpers, and a few D1 query convenience
// wrappers. Search by §SECTION below.
//
//   §HELPERS    — json, safeJson (used by every handler)
//   §DB         — one, all, run, batch (D1 wrappers)
//   §ROUTER     — tiny method+path matcher
//   §CORS       — withCors, handlePreflight
//   §ROUTES     — every public endpoint, wired to its handler
//   §ENTRY      — the default export Cloudflare calls
//
// Bindings provided by wrangler.toml (available as `env.NAME`):
//   env.DB                       — D1 database
//   env.AUTH_KV                  — KV namespace for short-lived state
//   env.ALLOWED_ORIGINS          — CSV of allowed CORS origins
//   env.BESPOKE_SIGNUPS_OPEN     — "true" | "false"
//   env.WORKER_PUBLIC_URL        — the Worker's own public URL
//
// Secrets (set with `wrangler secret put NAME`, also on `env.NAME`):
//   env.JWT_SECRET                — HMAC key for signing session tokens
//   env.GAME_SERVER_SHARED_SECRET — required header for stat-write endpoints
//   (OAuth client secrets get added later, per provider.)
//
// Note on circular imports: auth.js and stats.js both import the helpers
// below, while this file imports their handlers. That works fine because
// every exported helper is a `function` declaration (hoisted), and the
// imports are only *called* at request time — long after both modules
// have finished evaluating.

import * as auth from './auth.js';
import * as stats from './stats.js';

// ═══════════════════════════════════════════════════════════════════════
// §HELPERS
// ═══════════════════════════════════════════════════════════════════════

export function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...extraHeaders },
    });
}

// Returns parsed JSON body or null if missing / malformed. Handlers
// check for null and respond with a 400 themselves; this stays neutral.
export async function safeJson(request) {
    try {
        return await request.json();
    } catch (_) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// §DB — thin convenience wrappers over D1's prepared-statement API
// ═══════════════════════════════════════════════════════════════════════
//
//   const u = await one(env, 'SELECT id FROM users WHERE id = ?', userId);
//   const rows = await all(env, 'SELECT * FROM matches ORDER BY ended_at DESC LIMIT ?', 20);
//   await run(env, 'INSERT INTO users(display_name, created_at) VALUES(?, ?)', name, Date.now());

export async function one(env, sql, ...binds) {
    return await env.DB.prepare(sql).bind(...binds).first();
}

export async function all(env, sql, ...binds) {
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return results || [];
}

export async function run(env, sql, ...binds) {
    return await env.DB.prepare(sql).bind(...binds).run();
}

// Bound batch — D1 runs all statements in a single transaction.
//   await batch(env, [
//       env.DB.prepare('INSERT INTO matches ...').bind(...),
//       env.DB.prepare('INSERT INTO match_players ...').bind(...),
//   ]);
export async function batch(env, statements) {
    return await env.DB.batch(statements);
}

// ═══════════════════════════════════════════════════════════════════════
// §ROUTER
// ═══════════════════════════════════════════════════════════════════════
//
// Patterns can include `:param` segments — matched values are passed to
// the handler as `params`. Handler signature:
//   (request, env, ctx, params) → Response

class Router {
    constructor() {
        this.routes = []; // { method, regex, paramNames, handler }
    }

    add(method, pattern, handler) {
        const paramNames = [];
        const regexSource = pattern.replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, (m) => {
            paramNames.push(m.slice(1));
            return '([^/]+)';
        });
        this.routes.push({
            method: method.toUpperCase(),
            regex: new RegExp('^' + regexSource + '$'),
            paramNames,
            handler,
        });
        return this;
    }

    get(pattern, handler) { return this.add('GET', pattern, handler); }
    post(pattern, handler) { return this.add('POST', pattern, handler); }

    async handle(request, env, ctx) {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();

        for (const route of this.routes) {
            if (route.method !== method) continue;
            const m = route.regex.exec(url.pathname);
            if (!m) continue;
            const params = {};
            route.paramNames.forEach((name, i) => {
                params[name] = decodeURIComponent(m[i + 1]);
            });
            return await route.handler(request, env, ctx, params);
        }

        return json({ error: 'not_found', path: url.pathname }, 404);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// §CORS
// ═══════════════════════════════════════════════════════════════════════
//
// Allowed origins come from env.ALLOWED_ORIGINS (comma-separated). For
// requests from a listed origin we echo it back and allow credentials.
// Anything else gets the response without CORS headers (the browser will
// then block the JS from reading it — fine for our purposes).

function originAllowed(origin, env) {
    if (!origin) return false;
    const allowed = (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    return allowed.includes(origin);
}

function withCors(response, request, env) {
    const origin = request.headers.get('origin') || '';
    const headers = new Headers(response.headers);

    if (originAllowed(origin, env)) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-allow-credentials', 'true');
        headers.set('vary', 'origin');
    }
    return new Response(response.body, {
        status: response.status,
        headers,
    });
}

function handlePreflight(request, env) {
    const origin = request.headers.get('origin') || '';
    const headers = new Headers();

    if (originAllowed(origin, env)) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-allow-credentials', 'true');
        headers.set('vary', 'origin');
    }
    headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
    headers.set('access-control-allow-headers',
        'content-type,authorization,x-game-server-secret');
    headers.set('access-control-max-age', '86400');

    return new Response(null, { status: 204, headers });
}

// ═══════════════════════════════════════════════════════════════════════
// §ROUTES
// ═══════════════════════════════════════════════════════════════════════

const router = new Router();

// Health / sanity.
router.get('/', () => json({ ok: true, service: 'agicends-auth' }));
router.get('/health', () => json({ ok: true }));

// Session — game server hits /auth/verify on each WebSocket connect.
router.post('/auth/verify', auth.handleVerify);
router.post('/auth/logout', auth.handleLogout);

// Bespoke (username + password).
router.post('/auth/bespoke/signup', auth.signupBespoke);
router.post('/auth/bespoke/signin', auth.signinBespoke);
router.get('/auth/bespoke/exists', auth.bespokeExists);

// Sign In With Ethereum (EIP-4361).
//   nonce   → server gives the client a random nonce to embed in the
//             EIP-4361 message it asks the wallet to sign.
//   verify  → client posts back { message, signature, address }; on
//             success either logs an existing user in OR returns a
//             claim_ticket the client uses to finish account creation.
//   claim   → consumes a claim_ticket + chosen username (+ optional
//             password) and creates the account.
router.get('/auth/wallet/nonce', auth.walletNonce);
router.post('/auth/wallet/verify', auth.walletVerify);
router.post('/auth/wallet/claim', auth.walletClaim);

// /me/* — profile & account-management endpoints for the logged-in user.
// Every one of these requires `Authorization: Bearer <jwt>`; the JWT's
// subject is the only thing they trust (URL never carries a user_id).
router.get('/me/profile', auth.meProfile);
router.get('/me/matches', auth.meMatches);
router.get('/me/match/:id', auth.meMatchDetail);
router.post('/me/set-password', auth.meSetPassword);
router.post('/me/appearance', auth.meAppearance);
router.post('/me/link-wallet/verify', auth.meLinkWalletVerify);
router.post('/me/unlink-wallet', auth.meUnlinkWallet);

// Stats — server-to-server write, public reads.
router.post('/stats/record', stats.recordMatch);
router.get('/stats/user/:id', stats.getUserStats);
router.get('/stats/leaderboard', stats.getLeaderboard);
router.get('/stats/recent', stats.getRecentMatches);

// ═══════════════════════════════════════════════════════════════════════
// §ENTRY
// ═══════════════════════════════════════════════════════════════════════

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return handlePreflight(request, env);
        }

        let response;
        try {
            response = await router.handle(request, env, ctx);
        } catch (err) {
            console.error('Worker error:', err);
            response = json({ error: 'internal_error' }, 500);
        }
        return withCors(response, request, env);
    }
};