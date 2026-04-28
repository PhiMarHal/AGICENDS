// AGISCEND multiplayer client.
// Connects to Colyseus, sends flap inputs, renders authoritative server state.

import * as Phaser from "phaser";
import { Client, Room } from "@colyseus/sdk";

const SERVER_URL = "ws://localhost:2567";
const ROOM_NAME = "my_room"; // must match the name in your server's index.ts / app.config.ts

const CANVAS_WIDTH = 720;
const CANVAS_HEIGHT = 1080;
const WALL_THICKNESS = 35;

const statusEl = document.getElementById("status")!;
function setStatus(text: string) { statusEl.textContent = text; }

// What the server sends us each tick. We don't care about it being a Schema
// object yet — for now we'll just handle plain JSON broadcasts.
type ServerSnapshot = {
  spikeY: number;
  hasStarted: boolean;
  players: Record<string, {
    x: number;
    y: number;
    alive: boolean;
  }>;
};

class GameScene extends Phaser.Scene {
  private room: Room | null = null;
  private mySessionId = "";
  private latestSnapshot: ServerSnapshot | null = null;

  // Visual representations of remote/server state.
  private playerSprites: Map<string, Phaser.GameObjects.Rectangle> = new Map();
  private spikeLine!: Phaser.GameObjects.Rectangle;
  private leftWall!: Phaser.GameObjects.Rectangle;
  private rightWall!: Phaser.GameObjects.Rectangle;

  constructor() {
    super({ key: "GameScene" });
  }

  async create() {
    this.cameras.main.setBackgroundColor("#ffffff");

    // Side walls — purely cosmetic on the client; server enforces clamping.
    this.leftWall = this.add.rectangle(
      WALL_THICKNESS / 2, CANVAS_HEIGHT / 2,
      WALL_THICKNESS, CANVAS_HEIGHT,
      0x000000
    );
    this.rightWall = this.add.rectangle(
      CANVAS_WIDTH - WALL_THICKNESS / 2, CANVAS_HEIGHT / 2,
      WALL_THICKNESS, CANVAS_HEIGHT,
      0x000000
    );

    // Spike "line" — for now just a black bar. Real spikes go in later.
    this.spikeLine = this.add.rectangle(
      CANVAS_WIDTH / 2, CANVAS_HEIGHT + 50,
      CANVAS_WIDTH, 100,
      0x000000
    );

    // Input: any pointer-down sends a flap to the server.
    this.input.on("pointerdown", () => {
      if (this.room) this.room.send("flap");
    });
    this.input.keyboard?.on("keydown-SPACE", () => {
      if (this.room) this.room.send("flap");
    });

    await this.connect();
  }

  private async connect() {
    setStatus("connecting...");
    const client = new Client(SERVER_URL);
    try {
      this.room = await client.joinOrCreate<any>(ROOM_NAME);
      this.mySessionId = this.room.sessionId;
      setStatus(`connected: ${this.mySessionId}`);

      // Server broadcasts a snapshot each tick under message type "snapshot".
      // We store the latest one and apply it during update().
      this.room.onMessage("snapshot", (snap: ServerSnapshot) => {
        this.latestSnapshot = snap;
      });

      this.room.onLeave(() => setStatus("disconnected"));
      this.room.onError((code, msg) => setStatus(`error ${code}: ${msg}`));
    } catch (err) {
      setStatus(`connect failed: ${(err as Error).message}`);
      console.error(err);
    }
  }

  update() {
    if (!this.latestSnapshot) return;
    const snap = this.latestSnapshot;

    // Update spike position.
    this.spikeLine.y = snap.spikeY + 50; // rectangle origin is centered, spike top is at snap.spikeY

    // Reconcile player sprites with server state.
    const seenIds = new Set<string>();
    for (const [id, p] of Object.entries(snap.players)) {
      seenIds.add(id);
      let sprite = this.playerSprites.get(id);
      if (!sprite) {
        const isMe = id === this.mySessionId;
        sprite = this.add.rectangle(p.x, p.y, 60, 60, isMe ? 0x000000 : 0x666666);
        this.playerSprites.set(id, sprite);
      }
      sprite.x = p.x;
      sprite.y = p.y;
      sprite.setAlpha(p.alive ? 1.0 : 0.3);
    }

    // Remove sprites for players no longer in the snapshot (left the room).
    for (const [id, sprite] of this.playerSprites) {
      if (!seenIds.has(id)) {
        sprite.destroy();
        this.playerSprites.delete(id);
      }
    }
  }
}

new Phaser.Game({
  type: Phaser.WEBGL,
  parent: "game-container",
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  backgroundColor: "#ffffff",
  scene: [GameScene],
});