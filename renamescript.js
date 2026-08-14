#!/usr/bin/env node
/*
 * AGISCENDS -> AGICENDS rename.
 *
 * Run from the repository root:
 *   node renamescript.js --dry-run     show what would change
 *   node renamescript.js               apply
 *
 * Renames the game everywhere it is cosmetic, and refuses to touch the places
 * where the string is load-bearing:
 *
 *   1. The D1 database name — `wrangler d1 execute agiscends`, `d1 create
 *      agiscends`, `database_name = "agiscends"`. D1 databases cannot be
 *      renamed in place; the stable handle is database_id. Rewriting these
 *      breaks `npm run db:apply`.
 *
 *   2. `name = "agiscends-auth"` in wrangler.toml. Changing it does not rename
 *      the Worker — it deploys a NEW one, leaves the old live, and does not
 *      carry over secrets.
 *
 *   3. Any *.workers.dev hostname. The live Worker URL is hardcoded in the
 *      game client (AUTH_WORKER_URL) and in .env. A renamed host does not
 *      exist, and auth breaks instantly.
 *
 *   4. The localStorage key 'agiscends_auth_token'. Renaming it strands every
 *      logged-in player's token under the old key and signs them all out.
 *
 * Nothing in the database needs touching — no table, column, or stored value
 * contains the game name.
 *
 * MUSIC_BASE_URL points at agiscend.loiyaa.com — the SINGLEPLAYER name, no
 * trailing S — so the pattern never matches it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const SELF = path.basename(__filename);

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set(['package-lock.json', SELF]);

// A line matching any of these is left exactly as it is.
const PROTECTED = [
    /d1\s+execute\s+agiscends/i,
    /d1\s+create\s+agiscends/i,
    /database_name\s*=\s*["']agiscends["']/i,
    /name\s*=\s*["']agiscends-auth["']/i,
    /workers\.dev/i,
    /agiscends_auth_token/i,
];

function isProtected(line) {
    return PROTECTED.some((re) => re.test(line));
}

// Cases handled separately rather than a blanket case-insensitive replace, and
// AGISCENDS before AGISCEND so the singleplayer name is never double-hit.
function rename(line) {
    return line
        .split('AGISCENDS').join('AGICENDS')
        .split('Agiscends').join('Agicends')
        .split('agiscends').join('agicends');
}

const HAS_NAME = /agiscends/i;

let filesChanged = 0;
let linesChanged = 0;
let linesProtected = 0;
let filesScanned = 0;

function walk(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.warn(`  (skipped unreadable directory ${dir}: ${err.code})`);
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full);
        } else if (entry.isFile()) {
            if (SKIP_FILES.has(entry.name)) continue;
            processFile(full);
        }
    }
}

function processFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return;                       // unreadable; leave it alone
    }
    if (text.includes('\u0000')) return;   // binary
    filesScanned++;
    if (!HAS_NAME.test(text)) return;

    // Split keeping line terminators, so CRLF vs LF is preserved untouched.
    const lines = text.split(/(?<=\n)/);
    let touched = false;
    const rel = path.relative(ROOT, file) || file;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!HAS_NAME.test(line)) continue;

        if (isProtected(line)) {
            linesProtected++;
            if (DRY_RUN) console.log(`  SKIP  ${rel}\n        ${line.trimEnd()}`);
            continue;
        }

        const next = rename(line);
        if (next !== line) {
            lines[i] = next;
            touched = true;
            linesChanged++;
            if (DRY_RUN) {
                console.log(`  EDIT  ${rel}`);
                console.log(`        - ${line.trimEnd()}`);
                console.log(`        + ${next.trimEnd()}`);
            }
        }
    }

    if (!touched) return;
    filesChanged++;
    if (!DRY_RUN) fs.writeFileSync(file, lines.join(''), 'utf8');
}

walk(ROOT);

console.log('');
if (DRY_RUN) console.log('DRY RUN — nothing written.');
console.log(`files scanned:    ${filesScanned}`);
console.log(`files changed:    ${filesChanged}`);
console.log(`lines rewritten:  ${linesChanged}`);
console.log(`lines protected:  ${linesProtected}`);

console.log(`
────────────────────────────────────────────────────────────────────────
STILL TO DO BY HAND
────────────────────────────────────────────────────────────────────────

1. Worker name stays "agiscends-auth" in wrangler.toml. Renaming deploys a
   NEW Worker and leaves the old one running. If you want it anyway:
     a. Edit  name = "agicends-auth"
     b. Re-set BOTH secrets — they do NOT transfer:
          wrangler secret put JWT_SECRET
          wrangler secret put GAME_SERVER_SHARED_SECRET
        Use the SAME JWT_SECRET value, or every logged-in user is signed out.
     c. wrangler deploy
     d. Update AUTH_WORKER_URL in .env AND in client/index.html
     e. Update WORKER_PUBLIC_URL in wrangler.toml
     f. Delete the old Worker in the Cloudflare dashboard
   Doing nothing here is a perfectly good option — the name is not visible
   to players.

2. The D1 database stays named "agiscends". Nothing depends on it matching
   the game name.

3. Folder and repo names are not touched — this script edits file CONTENTS
   only. Rename those yourself, and update the tree diagram in CHEATSHEET.

4. GitHub repo rename: the old URL redirects, but the old name is released
   immediately. Make a placeholder repo if you want to hold it. Then:
     git remote set-url origin git@github.com:<you>/AGICENDS.git
`);