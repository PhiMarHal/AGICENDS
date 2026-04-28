import { Room, Client } from "@colyseus/core";
import { GameSimulation } from "../simulation/GameSimulation.js";

export class MyRoom extends Room {
  maxClients = 8;

  private sim = new GameSimulation();
  private logTimer = 0;

  onCreate(_options: any) {
    // 60Hz simulation tick.
    this.setSimulationInterval((deltaMs) => this.tick(deltaMs), 1000 / 60);

    this.onMessage("flap", (client) => {
      this.sim.queueFlap(client.sessionId);
    });
  }

  onJoin(client: Client) {
    console.log(`[room] ${client.sessionId} joined`);
    this.sim.addPlayer(client.sessionId);
  }

  onLeave(client: Client) {
    console.log(`[room] ${client.sessionId} left`);
    this.sim.removePlayer(client.sessionId);
  }

  onDispose() {
    console.log("[room] disposed");
  }

  private tick(deltaMs: number) {
    this.sim.step(deltaMs / 1000);

    // Build a snapshot and broadcast to all clients.
    const playerData: Record<string, { x: number; y: number; alive: boolean }> = {};
    for (const [id, p] of this.sim.players) {
      playerData[id] = { x: p.x, y: p.y, alive: p.alive };
    }
    this.broadcast("snapshot", {
      spikeY: this.sim.spikeY,
      hasStarted: this.sim.hasStarted,
      players: playerData,
    });

    // Server-side log once per second for debugging.
    this.logTimer += deltaMs;
    if (this.logTimer >= 1000) {
      this.logTimer = 0;
      const lines: string[] = [`spikeY=${this.sim.spikeY.toFixed(0)}`];
      for (const p of this.sim.players.values()) {
        lines.push(
          `  ${p.id.slice(0, 6)}: x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} vy=${p.vy.toFixed(0)} ${p.alive ? "alive" : "DEAD"}`
        );
      }
      console.log(lines.join("\n"));
    }
  }
}