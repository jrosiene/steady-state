import type {
  DerivedValues,
  HemodynamicParams,
  HemodynamicState,
  Intervention,
  Snapshot,
} from './types';
import { computeSV } from './frank-starling';
import { computeBaroreflex } from './baroreflex';
import { computePCWP, computeRVOutput, computeMPAP } from './pulmonary';
import { computeOxygenation } from './oxygenation';
import {
  computeHPV,
  computeHypoxicVasodilation,
  computeRVLVInterdependence,
  computeRvedvTarget,
  computeVasoactiveToneTargets,
} from './vasoactive';

/**
 * Compute all derived values from the current dynamic state.
 *
 * Two-pass approach for SpO2-dependent feedbacks:
 *   Pass 1: compute SV, CO, preliminary SpO2 using nominal SVR/PVR
 *   Pass 2: apply HPV (PVR boost) and hypoxic vasodilation (SVR drop)
 *            using the preliminary SpO2 → recompute MAP and mPAP
 *
 * SV and CO are invariant across both passes (SV depends on EDV/Emax, not SVR).
 * SpO2 is also invariant (CO doesn't change between passes), so one oxygenation
 * call suffices. Only MAP and mPAP need recalculation in pass 2.
 */
export function derive(
  state: HemodynamicState,
  params: HemodynamicParams,
): DerivedValues {
  // ── Vasoactive tone effects (Layer B: state variables → algebraic corrections) ──
  // These apply before pass 1 since they don't depend on SpO2
  const emaxEffective = Math.max(0.05, state.emax - state.noTone * params.noToneEmaxGain);

  // RV-LV septal interdependence (Layer A: mechanical, no SpO2 dependency)
  const rvlvPenalty = computeRVLVInterdependence(state.rvedv, params);
  const edvEffective = Math.max(params.edvMin, state.edv - rvlvPenalty);

  // ── Pass 1: SV, CO, preliminary oxygenation ──────────────────────────────
  const sv = computeSV(edvEffective, emaxEffective, params);
  const co = (state.hr * sv) / 1000;

  // Oxygenation is CO-dependent but not SVR/PVR-dependent
  const { spO2, paO2, svO2 } = computeOxygenation(state.fiO2, state.qsQt, co, params);

  // ── Pass 2: apply SpO2-driven feedbacks ──────────────────────────────────
  // HPV (Layer A): hypoxemia → pulmonary vasoconstriction
  const hpvBoost = computeHPV(spO2, params);
  // Hypoxic systemic vasodilation (Layer A): severe hypoxemia → peripheral vasodilation
  const hypoxicVasoDelta = computeHypoxicVasodilation(spO2, params);

  // Effective SVR: baroreflex base − noTone vasodilation + et1 vasoconstriction − hypoxic dilation
  const svrEffective = Math.max(
    params.svrMin,
    state.svr
      - state.noTone  * params.noToneSvrGain
      + state.et1Tone * params.et1ToneSvrGain
      - hypoxicVasoDelta,
  );

  // Effective PVR: base + ET-1 constriction − noTone dilation + HPV reflex
  const pvrEffective = Math.max(
    params.pvrMin,
    state.pvr
      + state.et1Tone * params.et1TonePvrGain
      - state.noTone  * params.noTonePvrGain
      + hpvBoost,
  );

  // Final hemodynamics with corrected SVR/PVR
  const map = co * svrEffective + state.cvp;
  const pcwp = computePCWP(edvEffective, emaxEffective, params);
  const { rvSv, rvCo } = computeRVOutput(state.rvedv, state.rvEmax, state.hr, params);
  const mPAP = computeMPAP(rvCo, pvrEffective, pcwp);

  return { sv, co, map, rvSv, rvCo, mPAP, pcwp, spO2, paO2, svO2 };
}

/** Build a full snapshot (state + derived) for the UI layer. */
export function snapshot(
  state: HemodynamicState,
  params: HemodynamicParams,
): Snapshot {
  return { ...state, ...derive(state, params) };
}

/**
 * Compute the derivative of the dynamic state (dState/dt).
 *
 * ODE variables:
 *   hr, svr   — baroreflex (existing)
 *   noTone    — Layer B: NO/PGI2 mediator, driven by SpO2 feedback + intervention overlay
 *   et1Tone   — Layer B: ET-1 mediator, driven by mPAP feedback (self-amplifying loop)
 *   rvedv     — RV volume adapts to afterload (PVR), driving RVLV interdependence
 *
 * All other variables (edv, emax, cvp, hrMod, rvEmax, pvr, qsQt, fiO2) have
 * derivative = 0: they are driven purely by intervention overlays, not intrinsic dynamics.
 */
export function derivative(
  state: HemodynamicState,
  params: HemodynamicParams,
): HemodynamicState {
  const derived = derive(state, params);
  const { map, spO2, mPAP } = derived;

  // Baroreflex
  const { dHr, dSvr } = computeBaroreflex(state.hr, state.svr, map, state.hrMod, params);

  // Vasoactive mediator ODEs (Layer B)
  const { noToneTarget, et1ToneTarget } = computeVasoactiveToneTargets(spO2, mPAP, params);
  const dNoTone  = (noToneTarget  - state.noTone)  / params.tauNoTone;
  const dEt1Tone = (et1ToneTarget - state.et1Tone) / params.tauEt1Tone;

  // RVEDV adapts to effective PVR (RV dilates under high afterload)
  // Use pvrEffective from the derived values path — derived mPAP already accounts for it.
  // Approximate pvrEffective: back-calculate from mPAP = rvCo × pvrEff + pcwp
  const pvrEffective = derived.rvCo > 0
    ? (derived.mPAP - derived.pcwp) / derived.rvCo
    : params.pvrRef;
  const rvedvTarget = computeRvedvTarget(pvrEffective, params.rvedvRef, params);
  const dRvedv = (rvedvTarget - state.rvedv) / params.tauRvAdaptation;

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
    time: 1,
  };
}

/**
 * Compute the effective delta from an intervention at a given sim-time.
 * First-order exponential onset/offset kinetics.
 */
export function interventionEffect(
  intervention: Intervention,
  time: number,
): number {
  const elapsed = time - intervention.startTime;
  if (elapsed < 0) return 0;

  const onsetFraction = 1 - Math.exp(-elapsed / intervention.tauOn);

  if (intervention.stopTime === undefined) {
    return intervention.delta * onsetFraction;
  }

  const elapsedSinceStop = time - intervention.stopTime;
  if (elapsedSinceStop < 0) {
    return intervention.delta * onsetFraction;
  }

  const levelAtStop =
    intervention.delta *
    (1 - Math.exp(-(intervention.stopTime - intervention.startTime) / intervention.tauOn));
  return levelAtStop * Math.exp(-elapsedSinceStop / intervention.tauOff);
}

/**
 * Apply all active interventions to a state, returning a modified copy.
 * Interventions are additive deltas — never stored back into base state.
 */
export function applyInterventions(
  state: HemodynamicState,
  interventions: Intervention[],
): HemodynamicState {
  const modified = { ...state };
  for (const intervention of interventions) {
    const effect = interventionEffect(intervention, state.time);
    modified[intervention.target] =
      (modified[intervention.target] as number) + effect;
  }
  return modified;
}
