# AGISCEND Multiplayer — Cheat Sheet

Quick reference for everyday development. Lives at the root of your server project.

## Running the server

From the project folder (the one with `package.json`):

```
npm start
```

Server listens on `ws://localhost:2567`. Auto-restarts when you save a `.ts` file.

Stop it with `Ctrl+C` in the terminal.

If `npm start` fails, try `npm install` first — it pulls down dependencies if anything's missing.

## Project layout

```
server/
├── package.json              # scripts and dependencies
├── tsconfig.json             # TypeScript config (don't touch unless needed)
├── src/
│   ├── index.ts              # server entry point — defines which rooms exist
│   ├── app.config.ts         # Colyseus server config (might be here instead)
│   ├── rooms/
│   │   └── MyRoom.ts         # the room class — handles per-match logic
│   └── simulation/
│       └── GameSimulation.ts # pure physics (no Colyseus, no Phaser)
└── CHEATSHEET.md             # this file
```

## Testing the server (playground)

While the server is running, open in a browser:

```
http://localhost:2567/
```

That's the Colyseus playground. You can:
- Pick a room type and click **Join** to connect as a fake client
- Send messages of any type with any JSON payload
- Watch the message log for what the server broadcasts back
- Open multiple browser tabs to simulate multiple players

**Important:** if you change broadcast behavior on the server, refresh the playground tab. The playground subscribes when it connects, and old subscriptions don't pick up new logic.

## Server logs

The terminal running `npm start` is your main debug window. Anything you `console.log()` from the server shows up there. Keep it visible while testing.

## The two-file mental model

- **`MyRoom.ts`** — the networking layer. Knows about clients, messages, broadcasts. Calls into the simulation. Should stay thin.
- **`GameSimulation.ts`** — the game logic. Knows about physics, players, obstacles. Pure functions and state, no networking. Should grow as features are added.

When something breaks, ask: is this a *physics* bug (simulation) or a *who-told-whom-what* bug (room)? Look in the right file.

## Common commands

| What | Command |
|---|---|
| Start the server | `npm start` |
| Stop the server | `Ctrl+C` in the server terminal |
| Install dependencies (after `git pull` or fresh clone) | `npm install` |
| Add a new package | `npm install <package-name>` |
| Force restart | `Ctrl+C`, then `npm start` |

## Troubleshooting

**Server won't start, says port 2567 in use.** An old server process is still running. On macOS/Linux: `lsof -ti:2567 | xargs kill`. On Windows: `netstat -ano | findstr 2567` to find the PID, then `taskkill /F /PID <pid>`.

**Server starts but immediately crashes with a red error.** Read the first few lines of the stack trace — usually points to a syntax error in a file you just edited. Fix the file, save, the watcher restarts it.

**Edits aren't taking effect.** Look at the server terminal — did it actually print "restarting" or similar after your save? If not, the watcher isn't seeing your save (rare, but happens with some editors). Stop and restart manually.

**Playground shows no messages coming back.** Refresh the playground tab. Old subscription, new server behavior — they don't reconcile automatically.

**TypeScript red squiggles in editor but server runs fine.** Editor is using a cached version of types. Restart your editor's TS server (in VS Code: Ctrl+Shift+P → "TypeScript: Restart TS Server").

## Useful URLs while developing

- `http://localhost:2567/` — playground (test client)
- `http://localhost:2567/monitor` — room monitor (live view of active rooms and connected clients), if enabled in your config

## Conventions for this project

- Server tick rate: **60Hz** (16.6ms per tick)
- Coordinate system: matches single-player AGISCEND (Y increases downward, 720×1080 logical canvas)
- Time in simulation code: seconds for physics constants, milliseconds for cooldowns and timestamps
- Player IDs: Colyseus `sessionId` (a short random string per connection)