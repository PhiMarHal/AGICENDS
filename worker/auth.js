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

import { json, safeJson, one, run } from './index.js';

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
// Validation rules:
//   Username: 3–16 chars, [A-Za-z0-9_], case-insensitive uniqueness.
//             Original case is preserved in users.display_name; the
//             lowercased form is the auth_identities.external_id (the
//             login key, so case doesn't affect sign-in).
//   Password: 8–1024 chars, no required character classes.
//             (The 1024 max is a sanity cap, not a security limit —
//             it just prevents someone from posting 10MB of "password".)
//
// Password hashing uses PBKDF2-SHA256 via Workers' built-in crypto.subtle
// (no external dependency). Stored credential format (JSON):
//   { v: 1, salt: <b64>, iterations: 100000, hash: <b64> }
// The `v` tag lets us migrate to higher iteration counts (or a different
// algorithm) later by re-hashing on next sign-in.

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 64;
const PBKDF2_ITERATIONS = 100000;

export async function signupBespoke(request, env) {
    if (env.BESPOKE_SIGNUPS_OPEN !== 'true') {
        return json({ error: 'signups_closed' }, 403);
    }

    const body = await safeJson(request);
    const username = body?.username;
    const password = body?.password;

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return json({
            error: 'invalid_username',
            message: 'Username must be 3–16 characters, letters/digits/underscore only.',
        }, 400);
    }
    if (typeof password !== 'string'
        || password.length < MIN_PASSWORD_LEN
        || password.length > MAX_PASSWORD_LEN) {
        return json({
            error: 'invalid_password',
            message: `Password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters.`,
        }, 400);
    }

    const externalId = username.toLowerCase();

    // Uniqueness check on both axes: the auth_identities lookup key AND
    // users.display_name (which has a UNIQUE NOCASE index, so this also
    // catches a different provider having already claimed the same name).
    const existingIdentity = await one(env,
        'SELECT id FROM auth_identities WHERE provider = ? AND external_id = ?',
        'bespoke', externalId,
    );
    if (existingIdentity) {
        return json({ error: 'username_taken' }, 409);
    }
    const existingName = await one(env,
        'SELECT id FROM users WHERE display_name = ?',
        username,
    );
    if (existingName) {
        return json({ error: 'username_taken' }, 409);
    }

    const credential = await hashPassword(password);
    const nowMs = Date.now();

    // We do two inserts. D1's JS API doesn't expose multi-statement
    // transactions cleanly, so if the second insert fails (very unlikely
    // — same connection, same request, no concurrent writer on this row)
    // we'd leave an orphan users row with no auth_identity. That's
    // recoverable manually and harmless (the user just can't sign in).
    // Not worth the complexity of a batched prepared-statement workaround.
    const insertUser = await run(env,
        'INSERT INTO users(display_name, created_at) VALUES(?, ?)',
        username, nowMs,
    );
    const userId = insertUser.meta.last_row_id;

    await run(env,
        'INSERT INTO auth_identities(user_id, provider, external_id, credential, created_at) VALUES(?, ?, ?, ?, ?)',
        userId, 'bespoke', externalId, credential, nowMs,
    );

    const user = { id: userId, display_name: username };
    const token = await issueSession(env, user);
    return json({ token, user });
}

export async function signinBespoke(request, env) {
    const body = await safeJson(request);
    const username = body?.username;
    const password = body?.password;

    // Generic 401 for ANY input problem — never tell an attacker whether
    // the username exists or whether the password was the wrong part.
    if (typeof username !== 'string' || typeof password !== 'string') {
        return json({ error: 'invalid_credentials' }, 401);
    }

    const externalId = username.toLowerCase();

    const row = await one(env,
        `SELECT ai.credential, u.id AS user_id, u.display_name, u.status
         FROM auth_identities ai
         JOIN users u ON u.id = ai.user_id
         WHERE ai.provider = ? AND ai.external_id = ?`,
        'bespoke', externalId,
    );

    if (!row || !row.credential) {
        return json({ error: 'invalid_credentials' }, 401);
    }

    const ok = await verifyPassword(password, row.credential);
    if (!ok) {
        return json({ error: 'invalid_credentials' }, 401);
    }

    if (row.status !== 'active') {
        return json({ error: 'account_disabled' }, 403);
    }

    const user = { id: row.user_id, display_name: row.display_name };
    const token = await issueSession(env, user);
    return json({ token, user });
}

// ── password hashing helpers (PBKDF2-SHA256 via Web Crypto) ─────────────

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return JSON.stringify({
        v: 1,
        salt: bytesToB64(salt),
        iterations: PBKDF2_ITERATIONS,
        hash: bytesToB64(hash),
    });
}

async function verifyPassword(password, storedJson) {
    let creds;
    try { creds = JSON.parse(storedJson); } catch (_) { return false; }
    if (creds?.v !== 1) return false;

    const salt = b64ToBytes(creds.salt);
    const expected = b64ToBytes(creds.hash);
    const actual = await pbkdf2(password, salt, creds.iterations);

    return constantTimeBytesEqual(actual, expected);
}

async function pbkdf2(password, salt, iterations) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        key,
        256,  // bits → 32-byte hash
    );
    return new Uint8Array(bits);
}

function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function constantTimeBytesEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
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