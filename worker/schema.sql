-- AGISCENDS auth + stats schema.
--
-- D1 is SQLite under the hood, so anything you'd write for SQLite works.
-- Apply this file with:
--   wrangler d1 execute agiscends --file=./schema.sql --remote
--
-- Each CREATE statement is idempotent (IF NOT EXISTS), so re-applying is
-- safe — though if you later change a column type, you'll need a migration
-- (we'll cross that bridge when we get there).

-- ── users ──────────────────────────────────────────────────────────────
-- One row per registered player account. `display_name` is the public
-- handle shown in-game and on leaderboards; it's unique case-insensitively
-- (so "AlphaPlayer" and "alphaplayer" can't both exist).
--
-- status:
--   'active'    — normal account
--   'disabled'  — soft-banned / suspended; login still works at the DB
--                 level but /auth/verify returns 401 for these.
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name    TEXT    NOT NULL COLLATE NOCASE,
    status          TEXT    NOT NULL DEFAULT 'active',
    mmr             INTEGER NOT NULL DEFAULT 1500,             -- pairwise-Elo skill rating
    created_at      INTEGER NOT NULL                          -- unix epoch ms
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_name
    ON users(display_name);

-- ── auth_identities ────────────────────────────────────────────────────
-- One row per (provider, external_id) tuple. A single user can have
-- multiple rows here (e.g. they sign up bespoke, later link Twitter).
-- For v1 we won't expose linking in the UI, but the schema supports it.
--
-- provider:
--   'bespoke'    — username+password; external_id = lowercased username
--                  (kept separate from display_name so renames don't break
--                  login); credential = JSON {salt, iterations, hash}
--   'twitter'    — external_id = Twitter user id; credential = NULL
--   'google'     — external_id = Google `sub`;    credential = NULL
--   'farcaster'  — external_id = FID;             credential = NULL
CREATE TABLE IF NOT EXISTS auth_identities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT    NOT NULL,
    external_id     TEXT    NOT NULL,
    credential      TEXT,                                     -- nullable; bespoke only
    created_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider_external
    ON auth_identities(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_auth_identities_user
    ON auth_identities(user_id);

-- ── matches ────────────────────────────────────────────────────────────
-- One row per finished match.
-- mode: 'angels' (co-op) | 'devils' (competitive) | NULL (legacy/unknown)
CREATE TABLE IF NOT EXISTS matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mode            TEXT,
    started_at      INTEGER,                                  -- unix epoch ms
    ended_at        INTEGER NOT NULL                          -- unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches(ended_at);

-- ── match_players ──────────────────────────────────────────────────────
-- One row per (match, participant). user_id is NULL for anonymous
-- players. display_name is a snapshot: if the player later renames their
-- account, the historical match record keeps the original name.
CREATE TABLE IF NOT EXISTS match_players (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    display_name    TEXT    NOT NULL,
    final_score     INTEGER NOT NULL,
    finishing_rank  INTEGER NOT NULL                          -- 1 = winner
);

CREATE INDEX IF NOT EXISTS idx_match_players_match ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_match_players_user  ON match_players(user_id);