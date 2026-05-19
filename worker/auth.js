// AGISCENDS authentication — everything auth-related in one file.
//
// Sections (Ctrl+F the §SECTION markers):
//   §JWT                — HS256 sign/verify, no external dependency
//   §SESSIONS           — issueSession, handleVerify, handleLogout, requireAuth
//   §BESPOKE            — signupBespoke, signinBespoke
//   §IDENTITY-HELPERS   — shared user-lookup helpers across providers
//   §ETHEREUM           — Sign In With Ethereum (EIP-4361 / SIWE)
//   §PROFILE            — /me/profile, /me/matches, /me/set-password, /me/link-wallet/verify
//
// All provider handlers funnel through `issueSession(env, user)` to mint a
// JWT, so the session shape is consistent regardless of how the user
// authenticated. Each users row can have multiple auth_identities rows
// pointing at it — a single account can be reached via bespoke
// username/password AND via Ethereum signature, attached over time.

import { json, safeJson, one, all, run } from './index.js';

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
        'SELECT id, display_name, status, mmr FROM users WHERE id = ?',
        payload.sub
    );
    if (!user || user.status !== 'active') {
        return json({ ok: false, error: 'user_unavailable' }, 401);
    }

    return json({
        ok: true,
        user: { id: user.id, display_name: user.display_name, mmr: user.mmr },
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

// Bearer-token check used by every /me/* endpoint. Returns either
// { user } when authenticated or { response } holding a 401 the caller
// should return directly. Caller code looks like:
//
//   const auth = await requireAuth(request, env);
//   if (auth.response) return auth.response;
//   const user = auth.user;
//
// Token comes from `Authorization: Bearer <jwt>`. Anything else — no
// header, wrong scheme, malformed token, expired — returns 401 here.
async function requireAuth(request, env) {
    const header = request.headers.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) {
        return { response: json({ error: 'missing_token' }, 401) };
    }
    const payload = await jwtVerify(m[1], env.JWT_SECRET);
    if (!payload) {
        return { response: json({ error: 'invalid_or_expired' }, 401) };
    }
    const user = await one(env,
        'SELECT id, display_name, status, mmr FROM users WHERE id = ?',
        payload.sub,
    );
    if (!user || user.status !== 'active') {
        return { response: json({ error: 'user_unavailable' }, 401) };
    }
    return { user };
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

    const user = { id: userId, display_name: username, mmr: 1500 };
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
        `SELECT ai.credential, u.id AS user_id, u.display_name, u.status, u.mmr
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

    const user = { id: row.user_id, display_name: row.display_name, mmr: row.mmr };
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
// §IDENTITY-HELPERS — shared user lookup across providers
// ═══════════════════════════════════════════════════════════════════════
//
// An `account` is one row in `users`. The `auth_identities` table holds
// zero-or-more login methods linked to that account. Bespoke username/
// password is `provider='bespoke'`, credential = PBKDF2 hash. Ethereum
// wallet is `provider='ethereum'`, external_id = lowercased address,
// credential = NULL. A user can have both — sign in either way.

// Strip everything not legal in a display_name and trim to the 16-char
// cap. Used to defensively validate user-supplied usernames before
// touching the DB. We don't ever derive a default from provider-supplied
// data (real name, email, ENS handle, etc.) — those are personally
// identifying. Users always pick their own display_name in our flow.
function sanitizeForDisplayName(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

// Look up a user by their (provider, external_id) pair. Returns the
// same shape /auth/verify uses, or null if no such identity is linked.
// Caller decides what to do with null: for the wallet flow it means
// kicking off the username-claim step.
async function findIdentityUser(env, provider, externalId) {
    return await one(env,
        `SELECT u.id, u.display_name, u.status, u.mmr
         FROM auth_identities ai
         JOIN users u ON u.id = ai.user_id
         WHERE ai.provider = ? AND ai.external_id = ?`,
        provider, externalId,
    );
}

// ═══════════════════════════════════════════════════════════════════════
// §ETHEREUM — Sign In With Ethereum (EIP-4361 / SIWE)
// ═══════════════════════════════════════════════════════════════════════
//
// The client proves ownership of an Ethereum address by signing a
// structured message containing a server-issued nonce. We never see a
// private key, never make an RPC call to a node — pure signature math
// with @noble/curves (secp256k1) + @noble/hashes (keccak256).
//
// Flow:
//
//   1. GET  /auth/wallet/nonce
//        → { nonce, statement }
//        Server generates a 32-hex-char random nonce, stashes it in KV
//        with a 10-minute TTL. The client builds the SIWE message
//        locally using this nonce (it's the binding between this
//        signature and our backend).
//
//   2. Client asks the wallet to personal_sign the EIP-4361 message.
//
//   3. POST /auth/wallet/verify { message, signature, address }
//        Server: re-parses the message, validates the nonce against
//        KV (single-use, deleted on read), recovers the signing address
//        from the signature, confirms it matches the claimed address.
//        Then:
//          - If (provider='ethereum', external_id=address) is already
//            linked to a user → issue session, return { token, user }
//          - Else → mint a claim ticket (random 32 hex chars, 10-min
//            TTL in KV holding the verified address), return
//            { claim_ticket }
//
//   4. POST /auth/wallet/claim { ticket, username, password? }
//        Server: validates ticket, validates username & uniqueness,
//        creates the users row, creates the ethereum auth_identity. If
//        a password was supplied, ALSO creates a bespoke auth_identity
//        — that lets the user sign in either way going forward.
//        Returns { token, user }.
//
// What the client signs (EIP-4361 §4):
//
//   ${domain} wants you to sign in with your Ethereum account:
//   ${address}
//
//   ${statement}
//
//   URI: ${uri}
//   Version: 1
//   Chain ID: ${chainId}
//   Nonce: ${nonce}
//   Issued At: ${iso8601}
//
// We don't validate domain/uri/chainId on the server — the nonce
// binding plus signature recovery is sufficient to prove ownership of
// the address and freshness of the request. (We could add domain
// checks for defense in depth later; not necessary for v1.)

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const SIWE_NONCE_TTL_SEC = 600;   // 10 min
const SIWE_CLAIM_TTL_SEC = 600;   // 10 min
const SIWE_STATEMENT = 'Sign in to AGISCENDS.';

// Random 16-byte hex token. Used for both nonces and claim tickets —
// same security properties (single-use, server-only, short TTL).
function randomToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// EIP-191 "personal_sign" message hash. The wallet prepends this magic
// prefix before hashing — we replicate the same prefix server-side so
// our signature verification matches what the wallet actually signed.
function eip191Hash(message) {
    const msgBytes = new TextEncoder().encode(message);
    const prefix = '\x19Ethereum Signed Message:\n' + msgBytes.length;
    const prefixBytes = new TextEncoder().encode(prefix);
    const combined = new Uint8Array(prefixBytes.length + msgBytes.length);
    combined.set(prefixBytes, 0);
    combined.set(msgBytes, prefixBytes.length);
    return keccak_256(combined);
}

// Recover the Ethereum address that produced the signature over the
// given hash. Throws on malformed signature.
//
// Signature layout: 0x<r:32 bytes><s:32 bytes><v:1 byte>
//   v is 27 or 28 in classic Ethereum (or 0/1 in newer wallets); we
//   handle both. The recovery bit (0 or 1) tells secp256k1 which of
//   the two possible public keys produced this signature.
function recoverAddress(messageHash, signatureHex) {
    let hex = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
    if (hex.length !== 130) throw new Error('signature_wrong_length');

    const r = hex.slice(0, 64);
    const s = hex.slice(64, 128);
    const v = parseInt(hex.slice(128, 130), 16);

    let recovery;
    if (v === 0 || v === 1) recovery = v;
    else if (v === 27 || v === 28) recovery = v - 27;
    else throw new Error('invalid_v');

    const sig = secp256k1.Signature.fromCompact(r + s).addRecoveryBit(recovery);
    // recoverPublicKey returns a Point; toRawBytes(false) gives the
    // 65-byte uncompressed form: 0x04 || X || Y. The Ethereum address
    // is the last 20 bytes of keccak256(X || Y).
    const pubKeyPoint = sig.recoverPublicKey(messageHash);
    const uncompressed = pubKeyPoint.toRawBytes(false);
    const addressBytes = keccak_256(uncompressed.slice(1)).slice(-20);
    return '0x' + Array.from(addressBytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Pull the fields we care about out of the EIP-4361 message. We
// validate format loosely — we need the address and nonce; everything
// else is between the wallet UI and the user.
function parseSiweMessage(message) {
    if (typeof message !== 'string') return { addr: null, nonce: null };
    const lines = message.split('\n');
    // Line 0: "${domain} wants you to sign in with your Ethereum account:"
    // Line 1: address
    let addr = null;
    if (lines.length > 1) {
        const candidate = lines[1].trim();
        if (/^0x[a-fA-F0-9]{40}$/.test(candidate)) addr = candidate.toLowerCase();
    }
    let nonce = null;
    for (const line of lines) {
        if (line.startsWith('Nonce: ')) {
            nonce = line.slice('Nonce: '.length).trim();
            break;
        }
    }
    return { addr, nonce };
}

// GET /auth/wallet/nonce
//   → { nonce, statement }
// The client builds its SIWE message using `nonce`. `statement` is the
// human-readable line the wallet displays to the user before they sign.
export async function walletNonce(_request, env) {
    const nonce = randomToken();
    await env.AUTH_KV.put(
        'siwe_nonce:' + nonce,
        '1',                                            // value irrelevant
        { expirationTtl: SIWE_NONCE_TTL_SEC },
    );
    return json({ nonce, statement: SIWE_STATEMENT });
}

// POST /auth/wallet/verify
//   body: { message, signature, address }
//   → 200 { token, user }                  (existing identity → logged in)
//   → 200 { claim_ticket: "..." }          (new identity → pick username)
//   → 4xx { error }
// Run the EIP-4361 signature-verification pipeline used by both
// /auth/wallet/verify (new-or-existing user) and /me/link-wallet/verify
// (logged-in user linking a wallet to their account). Returns either
// { address } with the verified lowercased address, or { error } with a
// machine-readable code. Consumes the nonce on first call — a second
// submission with the same nonce is rejected as expired.
async function verifySiweSubmission(env, body) {
    if (!body
        || typeof body.message !== 'string'
        || typeof body.signature !== 'string'
        || typeof body.address !== 'string') {
        return { error: 'invalid_request' };
    }

    const claimedAddress = body.address.toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(claimedAddress)) {
        return { error: 'invalid_address' };
    }

    const { addr: msgAddr, nonce } = parseSiweMessage(body.message);
    if (!msgAddr || !nonce) return { error: 'malformed_message' };
    if (msgAddr !== claimedAddress) return { error: 'address_mismatch' };

    // Single-use nonce. Delete unconditionally on first read so a
    // captured signature can't be re-submitted.
    const nonceKey = 'siwe_nonce:' + nonce;
    const stored = await env.AUTH_KV.get(nonceKey);
    if (!stored) return { error: 'nonce_invalid_or_expired' };
    await env.AUTH_KV.delete(nonceKey);

    // Recover the signing address and compare.
    let recovered;
    try {
        const hash = eip191Hash(body.message);
        recovered = recoverAddress(hash, body.signature);
    } catch (err) {
        console.error('SIWE signature recovery failed:', err);
        return { error: 'invalid_signature' };
    }
    if (recovered.toLowerCase() !== claimedAddress) {
        return { error: 'signature_mismatch' };
    }

    return { address: claimedAddress };
}

export async function walletVerify(request, env) {
    const body = await safeJson(request);
    const result = await verifySiweSubmission(env, body);
    if (result.error) return json({ error: result.error }, 400);
    const address = result.address;

    // Existing identity? Log in.
    const existing = await findIdentityUser(env, 'ethereum', address);
    if (existing) {
        if (existing.status !== 'active') {
            return json({ error: 'account_disabled' }, 401);
        }
        const token = await issueSession(env, existing);
        return json({ token, user: existing });
    }

    // New identity. Mint a claim ticket holding the verified address;
    // the client uses it to call /auth/wallet/claim with a username.
    const ticket = randomToken();
    await env.AUTH_KV.put(
        'siwe_claim:' + ticket,
        JSON.stringify({ address, created_at: Date.now() }),
        { expirationTtl: SIWE_CLAIM_TTL_SEC },
    );
    return json({ claim_ticket: ticket });
}

// POST /auth/wallet/claim
//   body: { ticket, username, password? }
//   → 200 { token, user }
//   → 4xx { error }
//
// Consumes the claim ticket and creates the account. If `password` is
// supplied, also links a bespoke identity so the user can sign in by
// username/password going forward. Otherwise the user is wallet-only
// (they can add a password later from the profile).
export async function walletClaim(request, env) {
    const body = await safeJson(request);
    if (!body) return json({ error: 'invalid_request' }, 400);

    const ticket = body.ticket;
    const username = body.username;
    const password = body.password;        // may be undefined / "" — both treated as "no password"

    if (typeof ticket !== 'string' || ticket.length === 0) {
        return json({ error: 'invalid_request' }, 400);
    }
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return json({
            error: 'invalid_username',
            message: 'Username must be 3–16 characters, letters/digits/underscore only.',
        }, 400);
    }
    const passwordSupplied = typeof password === 'string' && password.length > 0;
    if (passwordSupplied
        && (password.length < MIN_PASSWORD_LEN || password.length > MAX_PASSWORD_LEN)) {
        return json({
            error: 'invalid_password',
            message: `Password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters.`,
        }, 400);
    }

    // Look up ticket. Don't delete yet — only consume on a successful
    // create. If validation fails downstream the user can retry the
    // claim with a different username without re-signing.
    const ticketKey = 'siwe_claim:' + ticket;
    const ticketRaw = await env.AUTH_KV.get(ticketKey);
    if (!ticketRaw) {
        return json({ error: 'ticket_invalid_or_expired' }, 400);
    }
    let ticketData;
    try { ticketData = JSON.parse(ticketRaw); }
    catch (_) { return json({ error: 'ticket_corrupted' }, 400); }
    const address = ticketData.address;
    if (typeof address !== 'string' || !/^0x[a-f0-9]{40}$/.test(address)) {
        return json({ error: 'ticket_corrupted' }, 400);
    }

    // Pre-flight uniqueness checks. The UNIQUE indexes catch races
    // anyway, but checking first lets us return clean 409s instead of
    // half-creating an orphan users row.
    const bespokeExternalId = username.toLowerCase();

    const nameClash = await one(env,
        'SELECT id FROM users WHERE display_name = ?',
        username,
    );
    if (nameClash) return json({ error: 'username_taken' }, 409);

    const addrClash = await one(env,
        'SELECT id FROM auth_identities WHERE provider = ? AND external_id = ?',
        'ethereum', address,
    );
    if (addrClash) return json({ error: 'identity_already_claimed' }, 409);

    if (passwordSupplied) {
        const bespokeClash = await one(env,
            'SELECT id FROM auth_identities WHERE provider = ? AND external_id = ?',
            'bespoke', bespokeExternalId,
        );
        // A bespoke clash here would only happen if someone snagged the
        // same username between the user starting this flow and now.
        // Same friendly message as the users-name clash.
        if (bespokeClash) return json({ error: 'username_taken' }, 409);
    }

    // Consume the ticket. Past this point we're committed to creating
    // the account or surfacing a 500-class error.
    await env.AUTH_KV.delete(ticketKey);

    const nowMs = Date.now();

    const insertUser = await run(env,
        'INSERT INTO users(display_name, created_at) VALUES(?, ?)',
        username, nowMs,
    );
    const userId = insertUser.meta.last_row_id;

    await run(env,
        'INSERT INTO auth_identities(user_id, provider, external_id, credential, created_at) VALUES(?, ?, ?, ?, ?)',
        userId, 'ethereum', address, null, nowMs,
    );

    if (passwordSupplied) {
        const credential = await hashPassword(password);
        await run(env,
            'INSERT INTO auth_identities(user_id, provider, external_id, credential, created_at) VALUES(?, ?, ?, ?, ?)',
            userId, 'bespoke', bespokeExternalId, credential, nowMs,
        );
    }

    const user = { id: userId, display_name: username, status: 'active', mmr: 1500 };
    const token = await issueSession(env, user);
    return json({ token, user });
}

// ═══════════════════════════════════════════════════════════════════════
// §PROFILE — /me/* endpoints for the logged-in user
// ═══════════════════════════════════════════════════════════════════════
//
// All four take an `Authorization: Bearer <jwt>` header (enforced by
// requireAuth). They operate on the JWT subject, never on a user_id
// taken from the URL — keeps these endpoints uniformly "act as me",
// can't be abused to read or mutate someone else's account.
//
//   GET  /me/profile
//     → { user: {id, display_name, mmr},
//         has_password: bool,
//         wallet_address: "0x..." | null,
//         stats: { devils: {games, wins, best_score}, angels: {games, best_score} } }
//
//   GET  /me/matches?mode=devils|angels&limit=20
//     → { mode, matches: [ {match_id, ended_at, final_score, finishing_rank}, ... ] }
//
//   POST /me/set-password    { current_password?, new_password }
//     If user already has a bespoke identity, `current_password` is
//     required and must match. If they don't (wallet-only account),
//     this attaches a brand-new bespoke identity using their
//     lowercased display_name as the external_id.
//
//   POST /me/link-wallet/verify   { message, signature, address }
//     Runs the same SIWE-signature dance as /auth/wallet/verify, but
//     instead of finding-or-creating a user, attaches the verified
//     address to the current logged-in user. Errors if the wallet is
//     already linked to a different account.

export async function meProfile(request, env) {
    const a = await requireAuth(request, env);
    if (a.response) return a.response;
    const user = a.user;

    // Which login methods does this user have? We only need the
    // identifying bit per provider: for bespoke, presence-or-absence
    // is the answer; for ethereum, we surface the address itself.
    const identities = await all(env,
        'SELECT provider, external_id FROM auth_identities WHERE user_id = ?',
        user.id,
    );
    const hasBespoke = identities.some(i => i.provider === 'bespoke');
    const ethRow = identities.find(i => i.provider === 'ethereum');

    // Per-mode stats. One round trip with a GROUP BY. The CASE-inside-
    // SUM idiom is only meaningful for Devils (Angels doesn't rank
    // players), but it harmlessly returns 0 for Angels rows.
    const statRows = await all(env,
        `SELECT
             m.mode                                              AS mode,
             COUNT(*)                                            AS games,
             COALESCE(SUM(CASE WHEN mp.finishing_rank = 1 THEN 1 ELSE 0 END), 0) AS wins,
             MAX(mp.final_score)                                 AS best_score
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ?
         GROUP BY m.mode`,
        user.id,
    );
    const stats = {
        devils: { games: 0, wins: 0, best_score: null },
        angels: { games: 0, best_score: null },
    };
    for (const r of statRows) {
        if (r.mode === 'devils') {
            stats.devils = { games: r.games, wins: r.wins, best_score: r.best_score };
        } else if (r.mode === 'angels') {
            // wins doesn't apply to Angels (it's co-op), so we omit it.
            stats.angels = { games: r.games, best_score: r.best_score };
        }
    }

    return json({
        user: { id: user.id, display_name: user.display_name, mmr: user.mmr },
        has_password: hasBespoke,
        wallet_address: ethRow ? ethRow.external_id : null,
        stats,
    });
}

export async function meMatches(request, env) {
    const a = await requireAuth(request, env);
    if (a.response) return a.response;
    const user = a.user;

    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') === 'angels' ? 'angels' : 'devils';
    let limit = Number.parseInt(url.searchParams.get('limit'), 10);
    if (!Number.isInteger(limit) || limit <= 0) limit = 20;
    limit = Math.min(limit, 50);

    const matches = await all(env,
        `SELECT m.id AS match_id, m.ended_at,
                mp.final_score, mp.finishing_rank
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id = ? AND m.mode = ?
         ORDER BY m.ended_at DESC
         LIMIT ?`,
        user.id, mode, limit,
    );

    return json({ mode, matches });
}

export async function meSetPassword(request, env) {
    const a = await requireAuth(request, env);
    if (a.response) return a.response;
    const user = a.user;

    const body = await safeJson(request);
    if (!body) return json({ error: 'invalid_request' }, 400);

    const newPassword = body.new_password;
    if (typeof newPassword !== 'string'
        || newPassword.length < MIN_PASSWORD_LEN
        || newPassword.length > MAX_PASSWORD_LEN) {
        return json({
            error: 'invalid_password',
            message: `Password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters.`,
        }, 400);
    }

    // Does this user already have a bespoke identity? Determines
    // whether we UPDATE an existing credential or INSERT a new row.
    const existing = await one(env,
        'SELECT id, credential FROM auth_identities WHERE user_id = ? AND provider = ?',
        user.id, 'bespoke',
    );

    if (existing) {
        // Changing a password — require the current one to prove the
        // session token wasn't lifted off a logged-in device.
        if (typeof body.current_password !== 'string' || body.current_password.length === 0) {
            return json({ error: 'current_password_required' }, 400);
        }
        const ok = await verifyPassword(body.current_password, existing.credential);
        if (!ok) {
            return json({ error: 'invalid_credentials' }, 401);
        }
        const hashed = await hashPassword(newPassword);
        await run(env,
            'UPDATE auth_identities SET credential = ? WHERE id = ?',
            hashed, existing.id,
        );
        return json({ ok: true, action: 'changed' });
    }

    // Wallet-only account adding a password for the first time. The
    // bespoke external_id is the lowercased display_name — which is
    // guaranteed unique by users.display_name's UNIQUE NOCASE index,
    // so the INSERT below won't collide unless something has gone
    // catastrophically wrong.
    const bespokeExternalId = user.display_name.toLowerCase();
    const hashed = await hashPassword(newPassword);
    try {
        await run(env,
            'INSERT INTO auth_identities(user_id, provider, external_id, credential, created_at) VALUES(?, ?, ?, ?, ?)',
            user.id, 'bespoke', bespokeExternalId, hashed, Date.now(),
        );
    } catch (err) {
        if (String(err).includes('UNIQUE')) {
            // Means another bespoke identity already owns this
            // username — shouldn't be possible given the display_name
            // uniqueness invariant, but cover the case defensively.
            return json({ error: 'username_taken' }, 409);
        }
        throw err;
    }
    return json({ ok: true, action: 'added' });
}

export async function meLinkWalletVerify(request, env) {
    const a = await requireAuth(request, env);
    if (a.response) return a.response;
    const user = a.user;

    const body = await safeJson(request);
    const result = await verifySiweSubmission(env, body);
    if (result.error) return json({ error: result.error }, 400);
    const address = result.address;

    // The wallet must not already be linked to anyone. If it's linked
    // to *this* user we surface a distinct error so the client can
    // give a clearer message.
    const existing = await findIdentityUser(env, 'ethereum', address);
    if (existing) {
        if (existing.id === user.id) {
            return json({ error: 'already_linked_to_you' }, 409);
        }
        return json({ error: 'address_linked_elsewhere' }, 409);
    }

    await run(env,
        'INSERT INTO auth_identities(user_id, provider, external_id, credential, created_at) VALUES(?, ?, ?, ?, ?)',
        user.id, 'ethereum', address, null, Date.now(),
    );
    return json({ ok: true, address });
}