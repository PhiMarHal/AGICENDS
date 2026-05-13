// AGISCENDS authentication — everything auth-related in one file.
//
// Sections (Ctrl+F the §SECTION markers):
//   §JWT        — HS256 sign/verify, no external dependency
//   §SESSIONS   — issueSession, handleVerify, handleLogout
//   §BESPOKE    — signupBespoke, signinBespoke (stub)
//   §TWITTER    — twitterStart, twitterCallback (stub)
//   §GOOGLE     — googleStart, googleCallback (stub)
//   §FARCASTER  — farcasterVerify (stub)
//
// All provider handlers share two contracts:
//   1. On success, they call `issueSession(env, user)` to mint a JWT.
//   2. The result is returned either as JSON (bespoke, farcaster) or as
//      a redirect back to the game with the token in the URL fragment
//      (twitter, google) — to be implemented per provider.

import { json, safeJson, one } from './index.js';

// ═══════════════════════════════════════════════════════════════════════
// §JWT — minimal HS256 JSON Web Tokens
// ═══════════════════════════════════════════════════════════════════════
//
// We sign session tokens here. The signing secret lives only in this
// Worker (env.JWT_SECRET) — the game server doesn't have it; it asks us
// via /auth/verify. One secret in one place.
//
// If we ever want offline verification by the game server, we'd switch
// to an asymmetric scheme (RS256/ES256). Not needed for now.
//
// Token format (standard JWT):
//   base64url(header).base64url(payload).base64url(signature)

const JWT_HEADER_B64 = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
);

async function jwtSign(payload, secret) {
    const payloadB64 = b64urlEncode(
        new TextEncoder().encode(JSON.stringify(payload))
    );
    const signingInput = JWT_HEADER_B64 + '.' + payloadB64;
    const sigB64 = await hmacSha256(signingInput, secret);
    return signingInput + '.' + sigB64;
}

// Returns the parsed payload on success, or null on any failure
// (malformed, bad signature, expired). Callers treat null as
// "no valid session" and respond 401.
async function jwtVerify(token, secret) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;

    const expected = await hmacSha256(h + '.' + p, secret);
    if (!constantTimeEqual(expected, s)) return null;

    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    } catch (_) {
        return null;
    }

    if (typeof payload.exp === 'number'
        && payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
    }
    return payload;
}

async function hmacSha256(input, secret) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sigBuf = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(input)
    );
    return b64urlEncode(new Uint8Array(sigBuf));
}

function b64urlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// ═══════════════════════════════════════════════════════════════════════
// §SESSIONS
// ═══════════════════════════════════════════════════════════════════════

const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;

// Build and sign a session token for the given user.
// Token payload: { sub: <user.id>, name: <user.display_name>, iat, exp }
//
// Every auth provider funnels through this one place so the JWT shape
// stays consistent.
async function issueSession(env, user, ttlSeconds = ONE_WEEK_SECONDS) {
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
        sub: user.id,
        name: user.display_name,
        iat: nowSec,
        exp: nowSec + ttlSeconds,
    };
    return await jwtSign(payload, env.JWT_SECRET);
}

// POST /auth/verify
//   body: { token: "..." }
//   →  200 { ok: true, user: { id, display_name } }
//      401 { ok: false, error: "invalid_or_expired" | "user_unavailable" }
//      400 { ok: false, error: "missing_token" }
//
// This is the endpoint the game server hits on each WebSocket connect.
// We re-fetch the user so disabled accounts are rejected immediately,
// without waiting for token expiry.
export async function handleVerify(request, env) {
    const body = await safeJson(request);
    const token = body?.token;
    if (!token) return json({ ok: false, error: 'missing_token' }, 400);

    const payload = await jwtVerify(token, env.JWT_SECRET);
    if (!payload) {
        return json({ ok: false, error: 'invalid_or_expired' }, 401);
    }

    const user = await one(env,
        'SELECT id, display_name, status FROM users WHERE id = ?',
        payload.sub
    );
    if (!user || user.status !== 'active') {
        return json({ ok: false, error: 'user_unavailable' }, 401);
    }

    return json({
        ok: true,
        user: { id: user.id, display_name: user.display_name },
    });
}

// POST /auth/logout
//   Stateless tokens — there's nothing to invalidate server-side. We
//   return 200 so clients can clear their local token and consider
//   themselves logged out. (If we later want true revocation, we'd add
//   a token-blocklist KV write here.)
export async function handleLogout(_request, _env) {
    return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════
// §BESPOKE — username + password
// ═══════════════════════════════════════════════════════════════════════
//
// Endpoints:
//   POST /auth/bespoke/signup   { username, password } → { token, user }
//   POST /auth/bespoke/signin   { username, password } → { token, user }
//
// Password hashing will use PBKDF2-SHA256 via Workers' built-in
// crypto.subtle (no dependency). Stored credential format:
//   { v: 1, salt: <b64>, iterations: 600000, hash: <b64> }
// where `v` is a version tag so we can rotate the algorithm later.

export async function signupBespoke(_request, env) {
    if (env.BESPOKE_SIGNUPS_OPEN !== 'true') {
        return json({ error: 'signups_closed' }, 403);
    }
    // TODO: validate username, check uniqueness, hash password, insert
    //       user + auth_identity, issue session.
    return json({ error: 'not_implemented' }, 501);
}

export async function signinBespoke(_request, _env) {
    // TODO: look up auth_identity by lowercased username, verify password
    //       against stored hash, issue session.
    return json({ error: 'not_implemented' }, 501);
}

// ═══════════════════════════════════════════════════════════════════════
// §TWITTER — OAuth 2.0 with PKCE
// ═══════════════════════════════════════════════════════════════════════
//
//   GET /auth/twitter/start
//     Generates a state + PKCE verifier, stashes them in KV (10 min TTL),
//     redirects the browser to Twitter's authorize URL.
//
//   GET /auth/twitter/callback?code=...&state=...
//     Twitter sends the browser here after approval. We exchange the
//     code for an access token, fetch the user's profile, find or create
//     a matching user row (provider='twitter', external_id=Twitter user
//     id), issue a session, and redirect the browser back to the game.
//
// Required env (set later):
//   env.TWITTER_CLIENT_ID
//   env.TWITTER_CLIENT_SECRET
// And in wrangler.toml:
//   TWITTER_CALLBACK_URL = "https://<worker-public-url>/auth/twitter/callback"
//   (must match exactly what's registered on the Twitter Developer portal)

export async function twitterStart(_request, _env) {
    // TODO: generate state + PKCE verifier, store in KV, redirect to
    //       https://twitter.com/i/oauth2/authorize?...
    return json({ error: 'not_implemented' }, 501);
}

export async function twitterCallback(_request, _env) {
    // TODO: validate state, exchange code for token, fetch profile,
    //       upsert auth_identity, issue session, redirect to game.
    return json({ error: 'not_implemented' }, 501);
}

// ═══════════════════════════════════════════════════════════════════════
// §GOOGLE — OAuth 2.0
// ═══════════════════════════════════════════════════════════════════════
//
//   GET /auth/google/start
//     Generates a state nonce, stashes in KV (10 min TTL), redirects to
//     Google's authorize URL.
//
//   GET /auth/google/callback?code=...&state=...
//     Google sends the browser here after consent. We exchange the code
//     for an id_token, verify it, pull out `sub` (Google's stable user
//     id), find or create a matching user row (provider='google',
//     external_id=sub), issue a session.
//
// Required env (set later):
//   env.GOOGLE_CLIENT_ID
//   env.GOOGLE_CLIENT_SECRET
// And in wrangler.toml:
//   GOOGLE_CALLBACK_URL = "https://<worker-public-url>/auth/google/callback"
//   (must match what's registered in Google Cloud Console → Credentials)

export async function googleStart(_request, _env) {
    // TODO: generate state, store in KV, redirect to
    //       https://accounts.google.com/o/oauth2/v2/auth?...
    return json({ error: 'not_implemented' }, 501);
}

export async function googleCallback(_request, _env) {
    // TODO: validate state, exchange code for tokens, verify id_token,
    //       upsert auth_identity, issue session, redirect to game.
    return json({ error: 'not_implemented' }, 501);
}

// ═══════════════════════════════════════════════════════════════════════
// §FARCASTER — Sign In With Farcaster (SIWF)
// ═══════════════════════════════════════════════════════════════════════
//
// Unlike Twitter/Google, SIWF is NOT a redirect flow. The browser shows
// a QR code (or button on mobile), the user signs a message in the
// Warpcast app with their Farcaster signer key, the proof is sent here,
// and we verify it against the Farcaster on-chain registry.
//
//   POST /auth/farcaster/verify
//     body: { message, signature, fid, nonce, domain }
//     We:
//       1. Re-derive the SIWE-style message and check the signature
//       2. Query the Farcaster ID Registry contract to confirm the FID
//          belongs to the signing key
//       3. Find or create a matching user row (provider='farcaster',
//          external_id=fid), issue a session.
//
// Honestly more involved than Twitter/Google — signature recovery + an
// Optimism RPC call. We'll do this one last.

export async function farcasterVerify(_request, _env) {
    // TODO: verify signature, check FID ownership on Optimism, upsert
    //       auth_identity, issue session.
    return json({ error: 'not_implemented' }, 501);
}