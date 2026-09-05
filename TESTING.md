# Validation of the 16-player update

## Automated results

`npm test` in `server/`: **15 tests passed, 0 failed** on Node 24.19.0. The final suite took approximately 10.5 seconds.

Coverage:

- 16 slots with human-over-bot lobby priority and separated starting positions.
- Restitution 1.0, equal-mass momentum exchange, overlap recovery, swept player crossing, and phasing.
- Fixed-step enforcement and a 12-tick held-flap cadence.
- World delta retention across multiple physics steps and explicit clearing after publication.
- Old block/coin cleanup and the bounded play corridor/wall representation.
- Binary encoding of movement, large altitudes, cooldowns, sequence acknowledgements, and permanent powers.
- Input replay, rejection of stale/duplicate/wrong-round inputs, and round-reset history clearing.
- Synthetic 100 ms RTT replay with direction changes and peer collisions.
- Repeated bot-populated rounds, normal all-dead termination, and reset cleanup.
- Real local WebSocket connections across Devils and Angels, including binary snapshots, input acknowledgement, late bot replacement, and abandoned-room reset.
- SQLite execution of consolidated participant insertion and normalized Elo, including exclusion of bots/anonymous opponents.

The modified server, shared modules, Worker stats module, and client inline JavaScript also passed Node syntax checks.

## Synthetic performance probe

One run of the included benchmark with 16 controlled participants produced:

| Scene | Mean physics step | Mean encoding per published snapshot | Mean snapshot payload | Payload per client at 20 Hz |
|---|---:|---:|---:|---:|
| Early world | 0.13 ms | 0.05 ms | 1.07 KB | 21.5 KB/s |
| Around altitude 100,000 | 0.22 ms | 0.09 ms | 3.69 KB | 73.8 KB/s |

These are synthetic observations, not guaranteed production limits. The scene holds player positions to make measurement repeatable in shape, uses generated world content, and excludes sockets/TLS/browser rendering from CPU timing. Procedural randomness and machine load change the exact result. The later scene retained 22 blocks and 151 coins in this run, and no server-side decorative wall segments.

At 16 human recipients those observed payloads correspond to approximately 1.24 and 4.25 GB/hour, excluding transport overhead, initial worlds, and roster messages. With one human and 15 bots there is only one network recipient. Run `npm run benchmark` on your intended host for a local comparison.

## Not verified here

- Native Chromium could not run in this environment; visual layout, touch controls, audio, and actual 60 FPS behavior need desktop/mobile playtesting.
- No production auth/Cloudflare deployment or live D1 database was changed or exercised. SQL behavior was tested using local SQLite.
- The latency test checks bounded replay/acknowledgement behavior, not subjective collision feel. Unknown remote input, packet loss, and high latency can still cause corrections.
- This is a substantial networking revision. Deploy the matching server/client together and playtest before replacing a public instance.
