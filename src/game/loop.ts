import type { HemodynamicState, HemodynamicParams, Intervention, Snapshot } from '../engine/types';
import { derive, applyInterventions, snapshot } from '../engine/hemodynamics';
import { computeBaroreflex } from '../engine/baroreflex';
import { rk4Step, clampState, clampEffective } from '../engine/solver';
import { computeVasoactiveToneTargets, computeRvedvTarget } from '../engine/vasoactive';
import { SimClock } from './clock';

/**
 * Fixed physics timestep in sim-seconds.
 *
 * 50ms is safe with RK4 for all ODE time constants in this model:
 *   - Fastest: tauHr = 3s → dt/τ = 0.017; RK4 error ≈ O((dt/τ)⁴) ≈ 8×10⁻⁸ per step
 *   - Baroreflex, mediator tones (tauNoTone=300s, tauEt1=600s) are even more stable
 * 5× fewer steps per frame vs 10ms — meaningful CPU savings at high time scales.
 */
const PHYSICS_DT = 0.05; // 50ms sim-time

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
    const base = this.state.hemodynamics;
    const interventions = this.state.interventions;
    const params = this.state.params;

    /**
     * Derivative function for RK4 integration.
     *
     * Crucially, ODE targets (noToneTarget, et1ToneTarget, rvedvTarget) are
     * computed from the EFFECTIVE state (base + interventions), so that:
     *   - A COPD scenario raising qsQt → effective SpO2 drops → noTone rises
     *   - A PAH scenario raising pvr → effective mPAP rises → et1Tone rises
     *   - Any PVR elevation → RVEDV target rises → RVLV interdependence develops
     *
     * But the ODEs compare against the BASE state variable (state.noTone, etc.),
     * not the effective, so intervention overlays on those variables don't fight
     * the ODE (e.g. a noTone sepsis overlay doesn't suppress the hypoxic component).
     */
    const derivWithOverlay = (
      state: HemodynamicState,
      p: HemodynamicParams,
    ): HemodynamicState => {
      // Apply interventions then clamp — effective state has full clinical picture
      const effective = clampEffective(applyInterventions(state, interventions), p);

      // Full derive from effective state: MAP, SpO2, mPAP all reflect interventions
      const derived = derive(effective, p);

      // pH-dependent HR ceiling: H⁺ depresses SA node automaticity in severe acidosis.
      const hrCeilingFraction = Math.max(0, Math.min(1,
        (derived.pH - p.acidosisHrPhFloor) / (p.acidosisHrPhThreshold - p.acidosisHrPhFloor),
      ));
      const hrCeiling = p.hrMin + hrCeilingFraction * (p.hrMax - p.hrMin);
      const pWithHrCeiling = hrCeiling < p.hrMax ? { ...p, hrMax: hrCeiling } : p;

      // Baroreflex driven by effective MAP and HR (with pH-adjusted hrMax)
      const { dHr, dSvr } = computeBaroreflex(
        effective.hr, effective.svr, derived.map, effective.hrMod, pWithHrCeiling,
      );

      // Vasoactive mediator ODEs: targets from effective SpO2/mPAP,
      // but compared against BASE noTone/et1Tone so interventions don't self-cancel
      const { noToneTarget, et1ToneTarget } = computeVasoactiveToneTargets(
        derived.spO2, derived.mPAP, p,
      );
      const dNoTone  = (noToneTarget  - state.noTone)  / p.tauNoTone;
      const dEt1Tone = (et1ToneTarget - state.et1Tone) / p.tauEt1Tone;

      // RVEDV adapts to effective PVR (afterload) and effective EDV (venous return coupling).
      // Back-calculate pvrEffective from mPAP = rvCo × pvrEff + pcwp.
      const pvrEffective = derived.rvCo > 0
        ? (derived.mPAP - derived.pcwp) / derived.rvCo
        : p.pvrRef;
      const rvedvTarget = computeRvedvTarget(pvrEffective, effective.edv, p.rvedvRef, p);
      const dRvedv = (rvedvTarget - state.rvedv) / p.tauRvAdaptation;

      // Lactate ODE: type A (SvO2/MAP) + type B (noTone/inflammatory).
      // effective.noTone includes sepsis overlays — type B lactate responds to the full
      // inflammatory burden, not just the base state's ODE-integrated noTone.
      const lactateTarget = 1
        + p.lactateSvO2Gain  * Math.max(0, p.lactateSvO2Threshold - derived.svO2)
        + p.lactateMAPGain   * Math.max(0, p.lactateMAPThreshold  - derived.map)
        + p.lactateNoToneGain * effective.noTone;
      const tauLactate = lactateTarget > state.lactate ? p.tauLactateRise : p.tauLactateClear;
      const dLactate = (lactateTarget - state.lactate) / tauLactate;

      return {
        hr: dHr,
        svr: dSvr,
        edv: 0,
        emax: 0,
        cvp: 0,
        hrMod: 0,
        rvEmax: 0,
        pvr: 0,
        rvedv: dRvedv,
        qsQt: 0,
        fiO2: 0,
        noTone: dNoTone,
        et1Tone: dEt1Tone,
        lactate: dLactate,
        time: 1,
      };
    };

    // Integrate the BASE state — interventions are never baked in
    const next = rk4Step(base, params, PHYSICS_DT, derivWithOverlay);
    this.state.hemodynamics = clampState(next, params);
  }
}
