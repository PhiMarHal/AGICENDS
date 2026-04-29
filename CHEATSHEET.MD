# AGISCENDS — Cheat Sheet

Quick reference for everyday development.

## Project layout

```
AGISCENDS/
├── server/
│   ├── server.js       # the whole server: Express + WebSocket + simulation
│   ├── package.json    # dependencies: just express and ws
│   └── node_modules/   # installed packages (gitignored)
├── client/
│   └── index.html      # the whole client: Phaser + WebSocket, plain JS
├── README.md
├── .gitignore
└── CHEATSHEET.md       # this file
```

Two folders. One file in each (plus deps for the server).

## Running

One terminal:

```
cd server
npm start
```

Listens on `http://localhost:2567/`. Open that URL in a browser to play.

The server serves `client/index.html` to anyone who visits — that's why one URL gives you both halves.

Stop with `Ctrl+C`.

After editing `server.js`: `Ctrl+C`, then `npm start` again.

After editing `client/index.html`: just refresh the browser tab.

## First-time setup

```
cd server
npm install
```

(Pulls down `express` and `ws`. ~15 small packages total.)

## Testing multiplayer locally

Open `http://localhost:2567/` in two browser tabs (or one regular + one private/incognito window). Each tab is a separate player.

## What's where

- **Game physics, rules, scoring** → `server/server.js`, the `step()` function and constants in `SIM`.
- **Rendering, input, visuals** → `client/index.html`, the `GameScene` class.
- **Wire format** → JSON snapshots sent every tick. `buildSnapshot()` on server, `update()` on client.

## Common edits

- **Tweak gravity / jump force / spike speed**: change values in `SIM` at top of `server.js`.
- **Change visuals (colors, sprite shapes)**: edit `GameScene` in `index.html`.
- **Add a new game state field**: add it to `buildSnapshot()` on server, read it in client `update()`.
- **Add a new client → server input**: add `ws.send` on client, add a `msg.type === ...` branch in server.

## Dependencies

- `express` — serves the static client
- `ws` — WebSocket server library
- That's it.

## Troubleshooting

**Port 2567 in use.** Old server still running. Kill it: macOS/Linux `lsof -ti:2567 | xargs kill`; Windows `netstat -ano | findstr 2567` then `taskkill /F /PID <pid>`.

**Browser shows white screen.** Open devtools (F12), check console. Common causes: server not running, Phaser CDN didn't load, JavaScript error in your edits.

**"connecting..." forever.** Server isn't running, or it's on a different port. Should be on `localhost:2567`.

**"Cannot GET /" in browser.** Server is running but can't find the client folder. Make sure `client/index.html` exists at the same level as the `server/` folder.