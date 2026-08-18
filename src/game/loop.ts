import type { HemodynamicState, HemodynamicParams, Intervention, Snapshot } from '../engine/types';
import { applyInterventions, snapshot } from '../engine/hemodynamics';
import { clampEffective } from '../engine/solver';
import { stepPhysics, PHYSICS_DT } from './physics';
import { SimClock } from './clock';

/**
 * Maximum physics steps per animation frame.
 * At 300x with PHYSICS_DT=0.05: one 16ms frame → 300×0.016 = 4.8 sim-sec → 96 steps.
 * Cap at 100 to prevent any spiral-of-death from tab-away or long frames.
 * Each step = 4 RK4 sub-calls → max 400 derive() calls per frame.
 */
const MAX_STEPS_PER_FRAME = 100;

export interface SimulationState {
  hemodynamics: HemodynamicState;
  params: HemodynamicParams;
  interventions: Intervention[];
  clock: SimClock;
}

export type SnapshotCallback = (snap: Snapshot) => void;

/**
 * The core simulation loop.
 *
 * Key invariant: interventions are a READ-ONLY OVERLAY on the base state.
 * ODE integration uses the EFFECTIVE state (base + interventions) to compute
 * all targets and driving forces, but only integrates the BASE state variables.
 *
 * This ensures:
 *   1. Intervention deltas never accumulate (double-counting prevented).
 *   2. Feedback loops (HPV, noTone, et1Tone, RVEDV) see the full clinical
 *      picture including active interventions/scenarios.
 *   3. When an intervention wears off, the base state reflects only
 *      intrinsic physiology — the system returns to its natural equilibrium.
 */
export class SimulationLoop {
  state: SimulationState;
  private accumulator = 0;
  private rafId: number | null = null;
  private onSnapshot: SnapshotCallback;

  constructor(state: SimulationState, onSnapshot: SnapshotCallback) {
    this.state = state;
    this.onSnapshot = onSnapshot;
  }

  start() {
    this.state.clock.start();
    this.scheduleFrame();
  }

  pause() {
    this.state.clock.pause();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private scheduleFrame() {
    this.rafId = requestAnimationFrame((wallTime) => this.frame(wallTime));
  }

  private frame(wallTimeMs: number) {
    try {
      const simDt = this.state.clock.tick(wallTimeMs);
      this.accumulator += simDt;

      // Cap accumulator to prevent spiral-of-death at high time scales
      this.accumulator = Math.min(this.accumulator, PHYSICS_DT * MAX_STEPS_PER_FRAME);

      // Step physics in fixed increments
      while (this.accumulator >= PHYSICS_DT) {
        this.physicsStep();
        this.accumulator -= PHYSICS_DT;
      }

      // Emit snapshot with intervention overlay for UI display.
      // clampEffective guards against out-of-range values from stacked interventions.
      const effective = clampEffective(
        applyInterventions(this.state.hemodynamics, this.state.interventions),
        this.state.params,
      );
      this.onSnapshot(snapshot(effective, this.state.params));
    } catch (err) {
      // Log the error but keep the RAF loop alive — a single bad frame should not
      // permanently freeze the simulation. State is left unchanged for this frame.
      console.error('[SimulationLoop] frame error:', err);
    }

    // Continue loop regardless of frame errors
    if (this.state.clock.running) {
      this.scheduleFrame();
    }
  }

  private physicsStep() {
    this.state.hemodynamics = stepPhysics(
      this.state.hemodynamics,
      this.state.params,
      this.state.interventions,
      PHYSICS_DT,
    );
  }
}
