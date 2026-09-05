# AGICENDS auth + stats Worker

Cloudflare Worker handling all authentication (bespoke username+password,
plus Sign In With Ethereum) and persistent match-result storage for
AGICENDS. The game server (`server.js`) stays focused on gameplay; it
talks to this Worker over HTTPS to verify session tokens and record
match results.

## Architecture in one paragraph

Bespoke signup/signin posts username+password directly to this Worker
and gets a JWT. Sign In With Ethereum is a three-step exchange: the
client gets a nonce, has the user's wallet sign an EIP-4361 message
including that nonce, and posts the signature back to be verified by
ecrecover server-side. Either way, the client stores the resulting JWT
and sends it when connecting to the game's WebSocket. The game server,
on each WebSocket connect, POSTs the JWT to this Worker's `/auth/verify`
endpoint and gets back the user info (or a 401). At round end, the game
server POSTs the result to `/stats/record`, authenticated with a
server-to-server shared secret.

A single account can have both a bespoke identity and an Ethereum
identity attached — they're separate rows in `auth_identities` pointing
at the same `users` row. Users can sign in either way once linked.

## File map

| File              | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `wrangler.toml`   | Deployment config: D1 binding, KV binding, env vars             |
| `schema.sql`      | D1 tables: users, auth_identities, matches, match_players       |
| `package.json`    | npm dependencies — `@noble/curves`, `@noble/hashes` for SIWE    |
| `index.js`        | Entry, router, CORS, JSON helpers, D1 helpers, route wiring     |
| `auth.js`         | JWT + sessions + bespoke + Ethereum                             |
| `stats.js`        | Match recording + stat queries                                  |

Each of `index.js` and `auth.js` is organised by `§SECTION` markers — search for `§ROUTES`, `§ETHEREUM`, etc. to jump around.

## One-time setup

### 1. Install wrangler

`wrangler` is Cloudflare's CLI for Workers.

```sh
npm install -g wrangler
wrangler login
```

### 2. Create the D1 database

```sh
wrangler d1 create agiscends
```

Copy the printed `database_id` into `wrangler.toml` (replace
`REPLACE_AFTER_CREATING_DB`).

### 3. Create the KV namespace

```sh
wrangler kv namespace create AUTH_KV
```

Copy the printed `id` into `wrangler.toml` (replace
`REPLACE_AFTER_CREATING_KV`).

(If that command name fails on your wrangler version, try
`wrangler kv:namespace create AUTH_KV` — the colon-syntax is the older
form.)

### 4. Apply the database schema

```sh
# Remote (production):
wrangler d1 execute agiscends --file=./schema.sql --remote

# And/or local (for `wrangler dev`):
wrangler d1 execute agiscends --file=./schema.sql --local
```

### 5. Set the two required secrets

```sh
# Used to sign session tokens. Any high-entropy random string.
# Generate one with: openssl rand -base64 48
wrangler secret put JWT_SECRET

# Required header on /stats/record so only the game server can write.
# Generate one with: openssl rand -base64 32
wrangler secret put GAME_SERVER_SHARED_SECRET
```

OAuth provider secrets get added the same way later, per provider.

### 6. Edit `wrangler.toml` `[vars]`

Update `ALLOWED_ORIGINS` to include your domain(s):

```
ALLOWED_ORIGINS = "http://localhost:2567,https://agicends.example.com"
```

### 7. Sign In With Ethereum

No setup required — SIWE is trustless. The Worker doesn't talk to an
external service; it verifies signatures locally using `@noble/curves`
and `@noble/hashes` (pulled in as dependencies via `npm install`). The
flow is:

1. Client GETs `/auth/wallet/nonce` — gets a random nonce.
2. Client asks the wallet (MetaMask, Rabby, Coinbase Wallet, etc.) to
   sign an EIP-4361 message containing that nonce.
3. Client POSTs `/auth/wallet/verify` with `{ message, signature,
   address }`. Worker recovers the address from the signature and
   compares.
4. If this address is already linked to a user → session token.
   Otherwise → claim ticket, and the client prompts for a username
   (+ optional password) before POSTing `/auth/wallet/claim`.

The first time you deploy this, run `npm install` in the `worker/`
directory so wrangler can bundle the noble libraries.

## Running locally

```sh
npm run dev
```

This launches the Worker on `http://localhost:8787` against a local D1
copy. Try:

```sh
curl http://localhost:8787/health
# → {"ok":true}
```

## Deploying

```sh
npm run deploy
```

After deploy, your Worker is live at
`https://agiscends-auth.<your-account>.workers.dev` (or a custom
subdomain if you configure one).

## Wiring the game server to this Worker

Once deployed, `server.js` needs to (a) verify session tokens on each
WebSocket connect and (b) POST match results at round end. We'll add
those calls directly to `server.js` once the first auth provider is
working end-to-end.

The Worker URL the game server will need:
`https://<your-worker-name>.workers.dev` (or your custom subdomain).

## 16-player update

`stats.js` now inserts participants through `json_each` in one SQL statement and applies rating deltas atomically. Elo K is normalized over authenticated human opponents, so adding bots or increasing the cap does not multiply rating swings. Bots are anonymous result rows and are excluded from Elo. Deploy this Worker update alongside the game update; no schema change is required.
