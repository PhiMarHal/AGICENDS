// Pure physics simulation — no Colyseus, no Phaser, no networking.
// Mirrors the constants from AGISCEND single-player.

export const SIM_CONSTANTS = {
    CANVAS_WIDTH: 720,
    CANVAS_HEIGHT: 1080,
    GRAVITY: 1600,            // pixels/sec^2
    JUMP_FORCE: 650,          // pixels/sec, applied as upward velocity
    HORIZONTAL_SPEED: 400,    // pixels/sec on flap
    MAX_FALL_SPEED: 800,      // velocity clamp
    WALL_THICKNESS: 35,
    FLAP_COOLDOWN_MS: 200,
    HAZARD_BASE_SPEED: 120,   // spike rise speed (pixels/sec)
    START_Y_OFFSET: 200,      // player starts this far above bottom
    SPIKE_INITIAL_OFFSET: 50, // spikes start this far below canvas bottom
};

export interface PlayerState {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    alive: boolean;
    facingRight: boolean;
    lastFlapTime: number;     // server tick time, ms
    flapQueued: boolean;      // input buffered for next tick
    nextFlapDirection: 1 | -1;
}

export class GameSimulation {
    players: Map<string, PlayerState> = new Map();
    spikeY: number;
    elapsedMs: number = 0;
    // Spikes only rise once at least one player has flapped.
    // Mirrors single-player: the chase begins when you commit to playing.
    hasStarted: boolean = false;

    constructor() {
        this.spikeY = SIM_CONSTANTS.CANVAS_HEIGHT + SIM_CONSTANTS.SPIKE_INITIAL_OFFSET;
    }

    addPlayer(id: string): PlayerState {
        const startY = SIM_CONSTANTS.CANVAS_HEIGHT - SIM_CONSTANTS.START_Y_OFFSET;
        const player: PlayerState = {
            id,
            x: SIM_CONSTANTS.CANVAS_WIDTH / 2,
            y: startY,
            vx: 0,
            vy: 0,
            alive: true,
            facingRight: true,
            lastFlapTime: -Infinity,
            flapQueued: false,
            nextFlapDirection: 1,
        };
        this.players.set(id, player);
        return player;
    }

    removePlayer(id: string): void {
        this.players.delete(id);
    }

    queueFlap(id: string): void {
        const p = this.players.get(id);
        if (!p || !p.alive) return;
        p.flapQueued = true;
    }

    step(deltaSeconds: number): void {
        this.elapsedMs += deltaSeconds * 1000;

        // Before the game starts, players are frozen on the start platform.
        // We still process flap inputs (the first one starts the game) but no
        // physics or death checks run.
        if (!this.hasStarted) {
            for (const p of this.players.values()) {
                if (p.flapQueued) {
                    p.flapQueued = false;
                    p.vy = -SIM_CONSTANTS.JUMP_FORCE;
                    p.vx = SIM_CONSTANTS.HORIZONTAL_SPEED * p.nextFlapDirection;
                    p.facingRight = p.nextFlapDirection === 1;
                    p.nextFlapDirection = (p.nextFlapDirection === 1 ? -1 : 1);
                    p.lastFlapTime = this.elapsedMs;
                    this.hasStarted = true;
                }
            }
            return;
        }

        // Game is live: spikes rise, physics runs.
        this.spikeY -= SIM_CONSTANTS.HAZARD_BASE_SPEED * deltaSeconds;

        for (const p of this.players.values()) {
            if (!p.alive) continue;

            if (p.flapQueued) {
                p.flapQueued = false;
                if (this.elapsedMs - p.lastFlapTime >= SIM_CONSTANTS.FLAP_COOLDOWN_MS) {
                    p.vy = -SIM_CONSTANTS.JUMP_FORCE;
                    p.vx = SIM_CONSTANTS.HORIZONTAL_SPEED * p.nextFlapDirection;
                    p.facingRight = p.nextFlapDirection === 1;
                    p.nextFlapDirection = (p.nextFlapDirection === 1 ? -1 : 1);
                    p.lastFlapTime = this.elapsedMs;
                }
            }

            // Apply gravity.
            p.vy += SIM_CONSTANTS.GRAVITY * deltaSeconds;
            if (p.vy > SIM_CONSTANTS.MAX_FALL_SPEED) p.vy = SIM_CONSTANTS.MAX_FALL_SPEED;

            // Integrate position.
            p.x += p.vx * deltaSeconds;
            p.y += p.vy * deltaSeconds;

            // Wall clamp (left/right).
            const minX = SIM_CONSTANTS.WALL_THICKNESS;
            const maxX = SIM_CONSTANTS.CANVAS_WIDTH - SIM_CONSTANTS.WALL_THICKNESS;
            if (p.x < minX) { p.x = minX; p.vx = 0; }
            if (p.x > maxX) { p.x = maxX; p.vx = 0; }

            // Death by spike.
            if (p.y > this.spikeY) {
                p.alive = false;
            }
        }
    }
}