import type {
  CardiovascularStatus,
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
  // ── Blood gases — two-pass to resolve pH ↔ Emax ↔ CO circular dependency ──
  //
  // Circular dependency:
  //   pH → acidosisEmaxPenalty → emaxEffective → SV → CO → paCO2eff → pH
  //
  // Resolution: pHPrelim uses constant paCO2 (drives Emax in this tick).
  //             pHFinal uses CO-adjusted paCO2 (returned for display/status).
  //             One-tick lag on the CO2 retention → Emax path is negligible
  //             given that the fastest ODE time constant (tauHr=3s) >> dt (50ms).
  //
  // HCO3 model: pure anion-gap metabolic acidosis, 1:1 stoichiometry.
  //   Henderson-Hasselbalch: pH = 6.1 + log10(HCO3 / (0.0307 × paCO2))
  //   Normal: HCO3=24, paCO2=40 → pH = 7.39 ✓   Lactate=10: HCO3=15 → pH_prelim=7.19 ✓
  const hco3 = Math.max(5, 24 - Math.max(0, state.lactate - 1));
  const be = hco3 - 24;
  const pHPrelim = 6.1 + Math.log10(hco3 / (0.0307 * params.paCO2));

  // ── Vasoactive tone effects (Layer B: state variables → algebraic corrections) ──
  // Acidosis-driven myocardial depression: pH < 7.35 → progressive emax penalty.
  // Mechanism: intracellular acidosis reduces myofilament Ca²⁺ sensitivity and SR function.
  // Combined with noTone depression (septic cardiomyopathy) — independent mechanisms.
  const acidosisEmaxPenalty = Math.max(0, (params.acidosisPhThreshold - pHPrelim) * params.acidosisEmaxGain);
  const emaxEffective = Math.max(0.05,
    state.emax
    - state.noTone * params.noToneEmaxGain
    - acidosisEmaxPenalty,
  );

  // RV-LV septal interdependence (Layer A: mechanical, no SpO2 dependency)
  const rvlvPenalty = computeRVLVInterdependence(state.rvedv, params);
  const edvEffective = Math.max(params.edvMin, state.edv - rvlvPenalty);

  // ── Pass 1: SV, CO, preliminary oxygenation ──────────────────────────────
  const sv = computeSV(edvEffective, emaxEffective, params);
  const co = (state.hr * sv) / 1000;

  // ── CO2 retention: low cardiac output → impaired pulmonary CO2 clearance ──
  // Below co2RetentionCoRef, rising venous pCO2 and V/Q mismatch drive PaCO2 up.
  // Produces mixed metabolic + respiratory acidosis — the clinical pattern of
  // cardiogenic shock, cardiac arrest, and severe hemodynamic failure.
  const paCO2Effective = params.paCO2
    + params.co2RetentionGain * Math.max(0, params.co2RetentionCoRef - co);
  const pH = 6.1 + Math.log10(hco3 / (0.0307 * paCO2Effective));

  // Low-flow pulmonary hypoperfusion: when CO falls below threshold, the V/Q model
  // understates hypoxemia because it assumes adequate pulmonary blood flow.
  // Model as additional effective shunt: insufficient perfusion → SpO2 trends toward SvO2.
  const lowFlowShunt = params.lowFlowQsQtGain * Math.max(0, params.lowFlowCoThreshold - co);
  const effectiveQsQt = Math.min(0.98, state.qsQt + lowFlowShunt);

  // Oxygenation is CO-dependent but not SVR/PVR-dependent
  const { spO2, paO2, svO2 } = computeOxygenation(state.fiO2, effectiveQsQt, co, params);

  // ── Pass 2: apply SpO2-driven feedbacks ──────────────────────────────────
  // HPV (Layer A): hypoxemia → pulmonary vasoconstriction
  const hpvBoost = computeHPV(spO2, params);
  // Hypoxic systemic vasodilation (Layer A): severe hypoxemia → peripheral vasodilation
  const hypoxicVasoDelta = computeHypoxicVasodilation(spO2, params);

  // Acidosis-driven SVR reduction (vasoplegia): pH < 7.3 → direct SVR penalty.
  // Mechanism: H⁺ competes with Ca²⁺ on vascular smooth muscle contractile proteins
  // and reduces α-receptor sensitivity — the baroreflex response is overwhelmed at
  // severe acidosis even when state.svr is at its maximum clamped value.
  const acidosisSvrPenalty = Math.max(0, (params.acidosisSvrPhThreshold - pH) * params.acidosisSvrGain);

  // Effective SVR: baroreflex base − noTone vasodilation + et1 vasoconstriction − hypoxic dilation − acidosis vasoplegia
  const svrEffective = Math.max(
    params.svrMin,
    state.svr
      - state.noTone  * params.noToneSvrGain
      + state.et1Tone * params.et1ToneSvrGain
      - hypoxicVasoDelta
      - acidosisSvrPenalty,
  );

  // Effective PVR: base + ET-1 constriction − noTone dilation + HPV reflex
  const pvrEffective = Math.max(
    params.pvrMin,
    state.pvr
      + state.et1Tone * params.et1TonePvrGain
      - state.noTone  * params.noTonePvrGain
      + hpvBoost,
  );

  // ── Pass 3: afterload-sensitive SV (ESPVR constraint) ────────────────────
  // High arterial pressure raises end-systolic pressure → LV cannot empty fully.
  // Mechanism: ESP ≈ MAP; ESV = ESP/Emax (ESPVR) → SV = EDV − ESV falls.
  // Model as multiplicative penalty above a threshold, scaled by Emax so
  // a stronger ventricle tolerates high afterload better than a failing one.
  // Uses preliminary MAP (co × svrEffective) — one pass is sufficient since
  // the afterload feedback is stabilizing: SV↓ → CO↓ → MAP↓ → less penalty.
  const mapPrelim = co * svrEffective + state.cvp;
  const afterloadExcess = Math.max(0, mapPrelim - params.afterloadMapThreshold);
  const afterloadPenaltyFrac = afterloadExcess / (emaxEffective * params.afterloadSvGain);
  const svFinal = sv * Math.max(0, 1 - afterloadPenaltyFrac);
  const coFinal = (state.hr * svFinal) / 1000;

  // Final hemodynamics with corrected SVR/PVR and afterload-adjusted CO
  const map = coFinal * svrEffective + state.cvp;
  const pcwp = computePCWP(edvEffective, emaxEffective, params);
  const { rvSv, rvCo } = computeRVOutput(state.rvedv, state.rvEmax, state.hr, params);
  const mPAP = computeMPAP(rvCo, pvrEffective, pcwp);

  // ── Cardiovascular failure status ────────────────────────────────────────
  // Composite of perfusion pressure, output, and metabolic reserve.
  // Each tier represents a clinically distinct decision point.
  const cardiovascularStatus: CardiovascularStatus =
    map < 20 || pH < 6.9 ? 'arrest' :
    map < 35 || co < 1.0 || pH < 7.1 ? 'decompensating' :
    map < 50 || co < 2.0 || pH < 7.2 ? 'shock' :
    'compensated';

  return { emaxEffective, sv: svFinal, co: coFinal, map, rvSv, rvCo, mPAP, pcwp, spO2, paO2, svO2, pH, hco3, be, cardiovascularStatus };
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
  const { map, spO2, mPAP, svO2, pH } = derived;

  // pH-dependent HR ceiling: H⁺ directly depresses SA node automaticity and
  // desensitizes β-adrenergic receptors. Despite maximum sympathetic drive,
  // HR cannot be sustained above a pH-dependent ceiling in severe acidosis.
  // Linear interpolation: at acidosisHrPhThreshold (7.1) → full hrMax
  //                       at acidosisHrPhFloor (6.8) → hrMin (agonal)
  const hrCeilingFraction = Math.max(0, Math.min(1,
    (pH - params.acidosisHrPhFloor) / (params.acidosisHrPhThreshold - params.acidosisHrPhFloor),
  ));
  const hrCeiling = params.hrMin + hrCeilingFraction * (params.hrMax - params.hrMin);
  const paramsWithHrCeiling = hrCeiling < params.hrMax
    ? { ...params, hrMax: hrCeiling }
    : params;

  // Baroreflex (with pH-adjusted hrMax)
  const { dHr, dSvr } = computeBaroreflex(state.hr, state.svr, map, state.hrMod, paramsWithHrCeiling);

  // Vasoactive mediator ODEs (Layer B)
  const { noToneTarget, et1ToneTarget } = computeVasoactiveToneTargets(spO2, mPAP, params);
  const dNoTone  = (noToneTarget  - state.noTone)  / params.tauNoTone;
  const dEt1Tone = (et1ToneTarget - state.et1Tone) / params.tauEt1Tone;

  // Lactate ODE: three independent drivers.
  // 1. SvO2 deficit: type A — anaerobic metabolism when O2 delivery < demand
  // 2. MAP deficit: type A — microvascular maldistribution at low perfusion pressure
  // 3. noTone: type B — cytopathic hypoxia in sepsis; cells can't use O2 even when SvO2 is normal
  //    This is why septic lactate doesn't correlate with SvO2 the way hemorrhagic shock does.
  //    Uses state.noTone (which is the effective noTone after interventions in this call path).
  const lactateTarget = 1
    + params.lactateSvO2Gain  * Math.max(0, params.lactateSvO2Threshold - svO2)
    + params.lactateMAPGain   * Math.max(0, params.lactateMAPThreshold  - map)
    + params.lactateNoToneGain * state.noTone;
  const tauLactate = lactateTarget > state.lactate ? params.tauLactateRise : params.tauLactateClear;
  const dLactate = (lactateTarget - state.lactate) / tauLactate;

  // RVEDV adapts to effective PVR (afterload) and effective EDV (venous return coupling).
  // Back-calculate pvrEffective from mPAP = rvCo × pvrEff + pcwp.
  const pvrEffective = derived.rvCo > 0
    ? (derived.mPAP - derived.pcwp) / derived.rvCo
    : params.pvrRef;
  const rvedvTarget = computeRvedvTarget(pvrEffective, state.edv, params.rvedvRef, params);
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
    lactate: dLactate,
    time: 1,
  };
}

/**
 * Compute the effective delta from an intervention at a given sim-time.
 *
 * Bolus kinetics — Bateman absorption-elimination model:
 *   C(t) = delta × [exp(−ke×t) − exp(−ka×t)] / [exp(−ke×tMax) − exp(−ka×tMax)]
 *   where ka = 1/tauOn  (absorption/distribution rate)
 *         ke = ln2/eliminationHalfLife  (elimination rate)
 *         tMax = ln(ka/ke)/(ka−ke)  (time of peak effect)
 *   Normalization ensures peak effect = delta.
 *
 * Infusion/scenario kinetics — first-order onset, exponential elimination:
 *   while running: delta × (1 − exp(−elapsed/tauOn))
 *   after stop:    levelAtStop × exp(−ke × elapsedSinceStop)
 *
 * Hook: pass clearanceMultiplier > 1 (e.g. renal/hepatic impairment) to
 * stretch eliminationHalfLife without mutating the intervention record.
 */
export function interventionEffect(
  intervention: Intervention,
  time: number,
  clearanceMultiplier = 1.0,
): number {
  const elapsed = time - intervention.startTime;
  if (elapsed < 0) return 0;

  const ke = Math.LN2 / (intervention.eliminationHalfLife * clearanceMultiplier);

  // ── Bolus: Bateman absorption-elimination, normalized to peak = delta ────
  if (intervention.kind === 'bolus') {
    const ka = 1 / intervention.tauOn;
    if (ka <= ke) {
      // Pathological case (absorption slower than elimination — never happens in practice).
      // Fall back to simple elimination from peak.
      return intervention.delta * Math.exp(-ke * elapsed);
    }
    // tMax where d/dt [exp(-ke×t) - exp(-ka×t)] = 0
    const tMax = Math.log(ka / ke) / (ka - ke);
    const peakNorm = Math.exp(-ke * tMax) - Math.exp(-ka * tMax);
    const current  = Math.exp(-ke * elapsed) - Math.exp(-ka * elapsed);
    return intervention.delta * (current / peakNorm);
  }

  // ── Infusion / scenario: onset then elimination ──────────────────────────
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
  return levelAtStop * Math.exp(-ke * elapsedSinceStop);
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
