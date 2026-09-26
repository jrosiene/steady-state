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
import { afStrokeLoss, fillingFraction, laBackupVolume, ventricularRate } from './rhythm';
import { arterialPh, cnsDepression, computeVentilation, fatigueRate, paCO2Derivative } from './ventilation';
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
  // ── Blood gases ──────────────────────────────────────────────────────────
  //
  // PaCO2 is a state variable (integrated CO2 mass balance), so pH is known
  // before anything else and there is no circular dependency to break: the old
  // two-pass pH ↔ Emax ↔ CO resolution existed only because PaCO2 was being
  // computed from cardiac output inside this function.
  //
  // HCO3: the patient's own renal baseline, titrated 1:1 by lactate above 1.
  //   Normal: HCO3=24, PaCO2=40 → pH 7.39.
  //   Lactate 10 → HCO3 15; compensated to PaCO2 ~30 → pH ~7.31 (Winter's 30.5 ± 2).
  const acidLoad = Math.max(0, state.lactate - 1);
  const hco3 = Math.max(5, params.hco3Baseline - acidLoad);
  const be = hco3 - 24;
  const pH = arterialPh(hco3, state.paCO2);

  // The metabolic component of the acidosis, expressed as the pH this acid load
  // would produce at a normal PaCO2 — equivalently, a base deficit.
  //
  // The myocardial, vascular and SA-node penalties below are keyed to this, not
  // to the arterial pH, and the distinction is deliberate. Respiratory acidosis
  // of the same pH is far better tolerated: CO2 drives sympathetic output that
  // offsets its direct negative inotropy, which is why permissive hypercapnia to
  // a pH of 7.20 is routine ICU practice and a lactic acidosis to the same pH is
  // a patient in trouble. Keying the penalties to arterial pH put a narcotized
  // patient with a PaCO2 of 75 into cardiogenic shock; keying them to the base
  // deficit leaves the metabolic failure spiral exactly as it was calibrated,
  // and lets hypercapnia kill the way it actually does — through narcosis,
  // apnea and hypoxemia (see ventilation.ts).
  //
  // Referenced to 24 rather than to this patient's own baseline bicarbonate, so
  // a compensated CO2 retainer's extra bicarbonate is not counted as reserve.
  const pHMetabolic = arterialPh(Math.max(5, 24 - acidLoad), 40);

  // The pH the acidosis penalties act on: the metabolic component, plus whatever
  // part of the respiratory component exceeds what the body tolerates.
  //
  // The respiratory component is the pH drop caused by CO2 above this patient's
  // own setpoint, log10(PaCO2 / setpoint) — isolated explicitly, so a chronic
  // renal acidosis or a retainer's compensated bicarbonate does not leak into it.
  // Permissive hypercapnia is safe to a drop of about 0.2 (PaCO2 ~63 in a normal
  // adult); beyond that CO2 does depress the myocardium and blunt the response to
  // catecholamines. A PaCO2 of 60 costs nothing; 125 in a retainer at 55 does.
  const respiratoryDrop = Math.log10(Math.max(1, state.paCO2) / params.paCO2Setpoint);
  const pHPenalty = pHMetabolic - Math.max(0, respiratoryDrop - params.respiratoryAcidosisTolerance);

  // ── Vasoactive tone effects (Layer B: state variables → algebraic corrections) ──
  // Acidosis-driven myocardial depression: pH < 7.35 → progressive emax penalty.
  // Mechanism: intracellular acidosis reduces myofilament Ca²⁺ sensitivity and SR function.
  // Combined with noTone depression (septic cardiomyopathy) — independent mechanisms.
  const acidosisEmaxPenalty = Math.max(0, (params.acidosisPhThreshold - pHPenalty) * params.acidosisEmaxGain);
  const emaxEffective = Math.max(0.05,
    state.emax
    - state.noTone * params.noToneEmaxGain
    - acidosisEmaxPenalty,
  );

  // RV-LV septal interdependence (Layer A: mechanical, no SpO2 dependency)
  const rvlvPenalty = computeRVLVInterdependence(state.rvedv, params);

  // Rate-dependent diastolic filling.
  //
  // Diastole is what shortens when the heart speeds up, so past roughly 110 the
  // ventricle has progressively less time to fill and the volume it starts from
  // falls. This is the mechanism by which tachycardia stops being a rescue — the
  // reason compensated shock becomes uncompensated shock rather than continuing
  // indefinitely, and the reason rate control helps a poorly-filling ventricle.
  //
  // Its absence let the volume reflex fully compensate a class III hemorrhage:
  // heart rate rose, stroke volume held, cardiac output came out normal, and a
  // patient thirty-five per cent down on volume ran a blood pressure of 99 all
  // night. A fast heart and a full one are not the same heart.
  //
  // Rhythm: in AF the ventricles beat at what the AV node conducts, not at the
  // sinus drive, and filling loses the atrial kick on top of the rate penalty.
  // Every use of heart rate below is this ventricular rate.
  const hr = ventricularRate(state.hr, state.afib, state.avBlock, params);
  const filling = fillingFraction(hr, state.afib, params);
  const edvEffective = Math.max(params.edvMin, (state.edv - rvlvPenalty) * filling);

  // ── Pass 1: SV, CO, preliminary oxygenation ──────────────────────────────
  //
  // Series-circulation constraint. The two ventricles are in series, so the left
  // can only eject what the right delivers through the lungs: sustained LV output
  // cannot exceed sustained RV output. Without this the model lets a completely
  // failed RV (rvCo → 0) coexist with a normal cardiac output and blood pressure,
  // which is exactly the state a massive PE or RV infarct should not survive.
  //
  // RV output depends only on rvedv, rvEmax and hr, so it can be computed here
  // with no circular dependency on anything downstream.
  // The RV loses its atrial kick too (the rate term is shared diastole).
  const rvKick = 1 - Math.max(0, Math.min(1, state.afib)) * params.atrialKickFraction;
  const { rvSv, rvCo } = computeRVOutput(state.rvedv * rvKick, state.rvEmax, hr, params);

  const svLv = computeSV(edvEffective, emaxEffective, params)
    * (1 - afStrokeLoss(hr, state.afib, params));
  const sv = Math.min(svLv, rvSv);
  const co = (hr * sv) / 1000;

  // Low-flow pulmonary hypoperfusion: when CO falls below threshold, the V/Q model
  // understates hypoxemia because it assumes adequate pulmonary blood flow.
  // Model as additional effective shunt: insufficient perfusion → SpO2 trends toward SvO2.
  const lowFlowShunt = params.lowFlowQsQtGain * Math.max(0, params.lowFlowCoThreshold - co);

  // Hydrostatic pulmonary edema → shunt.
  // PCWP depends only on EDV and Emax, so it is available before gas exchange.
  // Once capillary hydrostatic pressure exceeds plasma oncotic pressure, fluid
  // floods alveoli that remain perfused — anatomically true shunt, not V/Q mismatch.
  // This is the coupling that makes cardiogenic pulmonary edema hypoxemic, and that
  // makes preload reduction (diuresis, nitrates, PEEP) restore oxygenation.
  //
  // Left-atrial backup in AF. The volume AF keeps out of the ventricle does not
  // vanish: it stays in the left atrium, whose pressure rises — which is why AF
  // with a fast rate floods the lungs of a stiff ventricle even as the
  // ventricle itself is underfilled. Scaled by chamber stiffness, so a normal
  // heart barely notices and an HFpEF heart does. AF only: sinus tachycardia's
  // filling penalty was calibrated without it, on hemorrhage.
  const laBackup = params.laBackupGain * (params.lvEdpvrStiffness / 0.2)
    * laBackupVolume(state.edv - rvlvPenalty, hr, state.afib, params);
  const pcwp = Math.min(params.pcwpMax, computePCWP(edvEffective, emaxEffective, params) + laBackup);
  const edemaShunt = params.edemaQsQtGain * Math.max(0, pcwp - params.edemaPcwpThreshold);

  const effectiveQsQt = Math.min(0.98, state.qsQt + lowFlowShunt + edemaShunt);

  // Oxygenation is CO-dependent but not SVR/PVR-dependent
  const { spO2, paO2, svO2 } = computeOxygenation(state.fiO2, effectiveQsQt, co, params, state.paCO2);


  // ── Pass 2: apply SpO2-driven feedbacks ──────────────────────────────────
  // HPV (Layer A): hypoxemia → pulmonary vasoconstriction
  const hpvBoost = computeHPV(spO2, params);
  // Hypoxic systemic vasodilation (Layer A): severe hypoxemia → peripheral vasodilation
  const hypoxicVasoDelta = computeHypoxicVasodilation(spO2, params);

  // Acidosis-driven SVR reduction (vasoplegia): pH < 7.3 → direct SVR penalty.
  // Mechanism: H⁺ competes with Ca²⁺ on vascular smooth muscle contractile proteins
  // and reduces α-receptor sensitivity — the baroreflex response is overwhelmed at
  // severe acidosis even when state.svr is at its maximum clamped value.
  const acidosisSvrPenalty = Math.max(0, (params.acidosisSvrPhThreshold - pHPenalty) * params.acidosisSvrGain);

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
  const coFinal = (hr * svFinal) / 1000;

  // ── Pass 4: afterload-sensitive RV output ────────────────────────────────
  //
  // The mirror of the ESPVR constraint above, for the other ventricle. The right
  // ventricle is a thin-walled volume pump built for a low-resistance circuit; it
  // tolerates a volume load well and a pressure load badly, which is the whole
  // reason pulmonary hypertension is a disease.
  //
  // Without this the RV had no afterload sensitivity at all: raising pulmonary
  // vascular resistance changed the pressure the model reported and nothing else,
  // so a pulmonary hypertensive crisis produced no fall in cardiac output and
  // pulmonary hypertension could not be written as a case. Note the division by
  // rvEmax — a hypertrophied RV that has adapted over years tolerates a mean
  // pressure that would stop a normal one, which is why a chronic patient walks
  // around at 55 mmHg and an acute pulmonary embolus at 40 mmHg is in shock.
  const mPAPPrelim = computeMPAP(coFinal, pvrEffective, pcwp);
  const rvAfterloadExcess = Math.max(0, mPAPPrelim - params.rvAfterloadMpapThreshold);
  const rvPenaltyFrac = rvAfterloadExcess
    / (Math.max(0.05, state.rvEmax) * params.rvAfterloadSvGain);
  const rvSvLoaded = rvSv * Math.max(0, 1 - rvPenaltyFrac);

  // Series constraint again, now that the RV has been asked to do it for real.
  const svLoaded = Math.min(svFinal, rvSvLoaded);
  const coLoaded = (hr * svLoaded) / 1000;

  // Final hemodynamics with corrected SVR/PVR and afterload-adjusted output
  const map = coLoaded * svrEffective + state.cvp;

  // Pulmonary artery pressure is driven by the flow that actually crosses the
  // lung, which is the circulating cardiac output — not by the right ventricle's
  // isolated pumping capacity.
  //
  // Using `rvCo` here meant a dilated RV sitting on the flat part of its Starling
  // curve reported an output of eleven liters a minute while the series
  // constraint held the real circulation at five, and mPAP came out at 120 mmHg
  // — a pulmonary pressure above the systemic one, which is not a state a body
  // can be in. It also made pulmonary hypertension impossible to write as a case:
  // any baseline severe enough to be worth simulating diverged immediately.
  const mPAP = computeMPAP(coLoaded, pvrEffective, pcwp);

  // ── Ventilation ──────────────────────────────────────────────────────────
  // What the patient is breathing now, given the gas tensions they have. The
  // PaCO2 this produces is not returned here; ventilation sets the *rate of
  // change* of PaCO2, which the integrator carries (see paCO2Derivative).
  // Computed last because it needs the final circulation (mPAP, delivered CO)
  // and nothing else in this function depends on it.
  const vent = computeVentilation({
    paCO2: state.paCO2,
    hco3,
    spO2,
    qsQtEffective: effectiveQsQt,
    pcwp,
    mPAP,
    co: coLoaded,
    ventDepression: state.ventDepression,
    deadSpace: state.deadSpace,
    ventSupport: state.ventSupport,
    respFatigue: state.respFatigue,
    fiO2: state.fiO2,
    qsQt: state.qsQt,
  }, params);

  // ── Cardiovascular failure status ────────────────────────────────────────
  // Composite of perfusion pressure, output, and metabolic reserve.
  // Each tier represents a clinically distinct decision point.
  // Status reads the worse of arterial and metabolic pH: a patient whose PaCO2
  // has run to 150 is arresting whatever their lactate says.
  const pHStatus = Math.min(pH, pHMetabolic);
  const cardiovascularStatus: CardiovascularStatus =
    map < 20 || pHStatus < 6.9 ? 'arrest' :
    map < 35 || coLoaded < 1.0 || pHStatus < 7.1 ? 'decompensating' :
    map < 50 || coLoaded < 2.0 || pHStatus < 7.2 ? 'shock' :
    'compensated';

  return {
    emaxEffective, sv: svLoaded, co: coLoaded, map, rvSv, rvCo, mPAP, pcwp,
    qsQtEffective: effectiveQsQt, spO2, paO2, svO2, pH, pHMetabolic, pHPenalty, hco3, be, cardiovascularStatus,
    ve: vent.ve, veDemand: vent.veDemand, veCapacity: vent.veCapacity, va: vent.va,
    rr: vent.rr, vt: vent.vt, vdVt: vent.vdVt,
    cnsDepression: cnsDepression(state.paCO2, state.ventDepression, params),
    breathingLoad: vent.breathingLoad,
    hrEffective: hr,
  };
}

/**
 * The same state with PaCO2 at the value this patient's ventilation holds.
 *
 * PaCO2 is integrated, so a case that starts from the population default of 40
 * would spend its first few minutes drifting to its own equilibrium — a
 * pneumonia breathing itself down to 34, a retainer up to 50 — and the vitals
 * charted at sign-out would not be the vitals at 19:05. Solving for the steady
 * state up front starts every patient where they actually live.
 *
 * The CO2 balance falls with PaCO2 across the physiologic range (more CO2
 * means both more drive and more CO2 per breath), but not everywhere: far
 * enough up, alveolar O2 runs out on room air, the circulation fails and
 * ventilation stops, and the balance turns positive again. So this scans up
 * from a low PaCO2 for the FIRST crossing — the equilibrium a living patient
 * sits at — and bisects within that bracket.
 */
export function withSteadyPaCO2(state: HemodynamicState, params: HemodynamicParams): HemodynamicState {
  const vco2 = params.vo2 * params.rq;
  const balance = (paCO2: number) =>
    paCO2Derivative(paCO2, derive({ ...state, paCO2 }, params).va, vco2, params);
  let lo = 15;
  if (balance(lo) <= 0) return { ...state, paCO2: lo };
  for (let hi = lo + 2; hi <= 120; hi += 2) {
    if (balance(hi) > 0) { lo = hi; continue; }
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (balance(mid) > 0) lo = mid; else hi = mid;
    }
    return { ...state, paCO2: (lo + hi) / 2 };
  }
  // No equilibrium below 120: leave the case's own value and let it declare itself.
  return state;
}

/** Build a full snapshot (state + derived) for the UI layer. */
export function snapshot(
  state: HemodynamicState,
  params: HemodynamicParams,
): Snapshot {
  const derived = derive(state, params);
  // The pulse the patient has. In sinus rhythm this is state.hr; in AF it is
  // the conducted ventricular rate, which is what a monitor or a nurse counts.
  return { ...state, ...derived, hr: derived.hrEffective };
}

/**
 * The derivative of the dynamic state, dState/dt — the one place it is defined.
 *
 * Takes both the BASE state (what is being integrated) and the EFFECTIVE state
 * (base + intervention overlays, clamped). The distinction is the model's key
 * invariant:
 *
 *   - Everything the body SENSES is read from the effective state: MAP, SpO2,
 *     mPAP, filling, gas tensions. A patient on a fluid bolus has the bolus in
 *     their ventricle, and their receptors know it.
 *   - Everything the body REGULATES is compared against the base state: the
 *     patient's own HR and SVR tone, and the mediator ODEs. Comparing a
 *     controller against the effective value puts the drug inside the loop,
 *     where an integrating controller cancels it exactly — which once made
 *     every vasopressor in the game inert. Sensing the effective pressure while
 *     regulating intrinsic tone gives the finite-gain opposition a real reflex
 *     shows: delta / (1 + gainSvr × CO) of a pressor survives.
 *
 * ODE variables: hr, svr (baroreflex); noTone, et1Tone (mediators); rvedv (RV
 * adaptation); lactate; paCO2 (CO2 mass balance); respFatigue. Everything else has zero
 * derivative and is moved only by overlays.
 *
 * This used to exist three times — here, in the bench loop, and in the ward's
 * physics step — and the copies had drifted (different PVR back-calculation,
 * different filling signal to the baroreflex). One definition, called by all.
 */
export function overlayDerivative(
  base: HemodynamicState,
  effective: HemodynamicState,
  p: HemodynamicParams,
): HemodynamicState {
  const derived = derive(effective, p);

  // pH-dependent HR ceiling: H⁺ depresses SA node automaticity and desensitizes
  // β-receptors, so in severe acidosis no amount of sympathetic drive holds a rate.
  // Linear from full hrMax at acidosisHrPhThreshold to hrMin at acidosisHrPhFloor.
  const hrCeilingFraction = Math.max(0, Math.min(1,
    (derived.pHPenalty - p.acidosisHrPhFloor) / (p.acidosisHrPhThreshold - p.acidosisHrPhFloor),
  ));
  const hrCeiling = p.hrMin + hrCeilingFraction * (p.hrMax - p.hrMin);
  const pWithHrCeiling = hrCeiling < p.hrMax ? { ...p, hrMax: hrCeiling } : p;

  // Baroreflex: senses effective MAP and filling, regulates intrinsic (base) tone.
  // Filling has no self-cancelling loop (HR does not feed back into EDV here), so
  // the volume limb reads the effective EDV — including any fluid given, which is
  // why resuscitating a hypovolemic patient brings their heart rate down.
  const { dHr, dSvr } = computeBaroreflex(
    base.hr, base.svr, derived.map, effective.hrMod, pWithHrCeiling, effective.edv,
  );

  // Mediator ODEs: targets from effective SpO2/mPAP, relaxation of BASE tone.
  const { noToneTarget, et1ToneTarget } = computeVasoactiveToneTargets(derived.spO2, derived.mPAP, p);
  const dNoTone = (noToneTarget - base.noTone) / p.tauNoTone;
  const dEt1Tone = (et1ToneTarget - base.et1Tone) / p.tauEt1Tone;

  // RVEDV adapts to effective PVR (afterload) and effective EDV (venous return),
  // back-calculated from mPAP = CO × PVR + PCWP, which is how mPAP is formed.
  const pvrEffective = derived.co > 0 ? (derived.mPAP - derived.pcwp) / derived.co : p.pvrRef;
  const rvedvTarget = computeRvedvTarget(pvrEffective, effective.edv, p.rvedvRef, p);
  const dRvedv = (rvedvTarget - base.rvedv) / p.tauRvAdaptation;

  // Lactate: type A (SvO2 deficit, low perfusion pressure) + type B (inflammatory
  // tone, from the effective state so sepsis overlays count). Septic lactate does
  // not track SvO2 the way hemorrhagic lactate does, and this is why.
  const lactateTarget = 1
    + p.lactateSvO2Gain * Math.max(0, p.lactateSvO2Threshold - derived.svO2)
    + p.lactateMAPGain * Math.max(0, p.lactateMAPThreshold - derived.map)
    + p.lactateNoToneGain * effective.noTone;
  const tauLactate = lactateTarget > base.lactate ? p.tauLactateRise : p.tauLactateClear;
  const dLactate = (lactateTarget - base.lactate) / tauLactate;

  // CO2 mass balance: production (VO2 × RQ) against alveolar clearance.
  const dPaCO2 = paCO2Derivative(effective.paCO2, derived.va, p.vo2 * p.rq, p);

  // Respiratory muscle fatigue accumulates while the load is above what the
  // muscles can sustain and recovers only once it is below — cumulative, like a
  // task-failure curve, rather than settling at a partial level. See fatigueRate.
  const dFatigue = fatigueRate(derived.breathingLoad, base.respFatigue, p);

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
    paCO2: dPaCO2,
    ventDepression: 0,
    deadSpace: 0,
    ventSupport: 0,
    respFatigue: dFatigue,
    afib: 0,
    avBlock: 0,
    time: 1,
  };
}

/**
 * dState/dt for a state with no overlays (or one already folded in).
 * Equivalent to overlayDerivative(state, state, params).
 */
export function derivative(
  state: HemodynamicState,
  params: HemodynamicParams,
): HemodynamicState {
  return overlayDerivative(state, state, params);
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
