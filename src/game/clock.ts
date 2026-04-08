/**
 * Simulation clock — manages the relationship between wall-clock time
 * and simulation time, supporting time compression for long scenarios.
 */
export class SimClock {
  /** Ratio of sim-time to wall-time. 1.0 = real-time, 60 = 1 min/sec. */
  timeScale: number;
  /** Whether the simulation is currently advancing. */
  running: boolean;

  private lastWallTime: number | null = null;

  constructor(timeScale = 1.0) {
    this.timeScale = timeScale;
    this.running = false;
  }

  /** Call once per frame with the current wall-clock time (ms, from performance.now()). */
  tick(wallTimeMs: number): number {
    if (!this.running || this.lastWallTime === null) {
      this.lastWallTime = wallTimeMs;
      return 0;
    }

    const wallDt = (wallTimeMs - this.lastWallTime) / 1000; // seconds
    this.lastWallTime = wallTimeMs;

    // Cap wall-dt to prevent spiral of death after tab-away
    const cappedWallDt = Math.min(wallDt, 0.1);
    return cappedWallDt * this.timeScale;
  }

  start() {
    this.running = true;
    this.lastWallTime = null; // reset so next tick doesn't get a huge dt
  }

  pause() {
    this.running = false;
  }

  setTimeScale(scale: number) {
    this.timeScale = Math.max(0.1, Math.min(scale, 3600));
  }
}
