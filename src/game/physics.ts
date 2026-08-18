import type { HemodynamicState, HemodynamicParams, Intervention } from '../engine/types';
import { derive, applyInterventions } from '../engine/hemodynamics';
import { computeBaroreflex } from '../engine/baroreflex';
import { rk4Step, clampState, clampEffective } from '../engine/solver';
import { computeVasoactiveToneTargets, computeRvedvTarget } from '../engine/vasoactive';

/**
 * Fixed physics timestep in sim-seconds for the single-patient test bench.
 *
 * 50ms is safe with RK4 for all ODE time constants in this model:
 *   - Fastest: tauHr = 3s → dt/τ = 0.017; RK4 error ≈ O((dt/τ)⁴) ≈ 8×10⁻⁸ per step
 *   - Baroreflex, mediator tones (tauNoTone=300s, tauEt1=600s) are even more stable
 */
export const PHYSICS_DT = 0.05;

/**
 * Coarser timestep used by the shift engine, which integrates many patients
 * concurrently at high time compression.
 *
 * At dt=0.25 the fastest time constant (tauHr = 3s) gives dt/τ = 0.083, so RK4
 * local error is still ≈ O((dt/τ)⁴) ≈ 5×10⁻⁵ per step — far below the resolution
 * of anything the UI displays. The 5× step reduction is what makes simulating a
 * full ward at 120× wall-clock compression affordable.
 */
export const WARD_PHYSICS_DT = 0.25;

/**
 * Advance one patient's hemodynamic state by a single fixed timestep.
 *
 * Key invariant (shared with SimulationLoop): interventions are a READ-ONLY
 * OVERLAY on the base state. ODE targets are computed from the EFFECTIVE state
 * (base + interventions) so feedback loops see the full clinical picture, but
 * only the BASE state variables are integrated. This keeps intervention deltas
 * from compounding across steps while still letting a scenario drive the
 * mediator ODEs.
 */
export function stepPhysics(
  base: HemodynamicState,
  params: HemodynamicParams,
  interventions: Intervention[],
  dt: number,
): HemodynamicState {
  const derivWithOverlay = (
    state: HemodynamicState,
    p: HemodynamicParams,
  ): HemodynamicState => {
    // Apply interventions then clamp — effective state has the full clinical picture
    const effective = clampEffective(applyInterventions(state, interventions), p);
    const derived = derive(effective, p);

    // pH-dependent HR ceiling: H⁺ depresses SA node automaticity in severe acidosis.
    const hrCeilingFraction = Math.max(0, Math.min(1,
      (derived.pH - p.acidosisHrPhFloor) / (p.acidosisHrPhThreshold - p.acidosisHrPhFloor),
    ));
    const hrCeiling = p.hrMin + hrCeilingFraction * (p.hrMax - p.hrMin);
    const pWithHrCeiling = hrCeiling < p.hrMax ? { ...p, hrMax: hrCeiling } : p;

    const { dHr, dSvr } = computeBaroreflex(
      effective.hr, effective.svr, derived.map, effective.hrMod, pWithHrCeiling,
    );

    // Mediator ODEs: targets from effective SpO2/mPAP, but compared against BASE
    // noTone/et1Tone so intervention overlays don't fight (or self-cancel) the ODE.
    const { noToneTarget, et1ToneTarget } = computeVasoactiveToneTargets(
      derived.spO2, derived.mPAP, p,
    );
    const dNoTone = (noToneTarget - state.noTone) / p.tauNoTone;
    const dEt1Tone = (et1ToneTarget - state.et1Tone) / p.tauEt1Tone;

    // RVEDV adapts to effective PVR (afterload) and effective EDV (venous return).
    // Back-calculate pvrEffective from mPAP = rvCo × pvrEff + pcwp.
    const pvrEffective = derived.rvCo > 0
      ? (derived.mPAP - derived.pcwp) / derived.rvCo
      : p.pvrRef;
    const rvedvTarget = computeRvedvTarget(pvrEffective, effective.edv, p.rvedvRef, p);
    const dRvedv = (rvedvTarget - state.rvedv) / p.tauRvAdaptation;

    // Lactate ODE: type A (SvO2/MAP) + type B (noTone/inflammatory).
    // effective.noTone includes sepsis overlays — type B lactate responds to the
    // full inflammatory burden, not just the ODE-integrated base state.
    const lactateTarget = 1
      + p.lactateSvO2Gain * Math.max(0, p.lactateSvO2Threshold - derived.svO2)
      + p.lactateMAPGain * Math.max(0, p.lactateMAPThreshold - derived.map)
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
  return clampState(rk4Step(base, params, dt, derivWithOverlay), params);
}
