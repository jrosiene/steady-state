import type { HemodynamicParams } from './types';

/**
 * Ventilation and CO2.
 *
 * Until this module existed, arterial PaCO2 was a constant 40 mmHg with a
 * low-output correction bolted on. That made three things impossible:
 *
 *   - Respiratory compensation. A lactate of 10 gave a pH of 7.19, because
 *     nothing breathed the CO2 down. A real patient with that lactate is
 *     Kussmauling at a PaCO2 near Winter's prediction and a pH around 7.30.
 *   - Hypoventilation. Opioids, sedatives, a tiring COPD patient and oxygen in a
 *     CO2 retainer all act on ventilation, and ventilation was not a quantity
 *     the model had.
 *   - The alveolar gas equation. PAO2 = FiO2·(Patm − PH2O) − PaCO2/RQ, so a
 *     patient who hypoventilates desaturates on room air — and supplemental
 *     oxygen hides it. A fixed PaCO2 could not show either half.
 *
 * Structure:
 *   demand   — the chemoreflex and non-chemical drives, as a multiple of rest
 *   capacity — what the respiratory muscles can sustain, which falls in shock
 *   VE       — demand, limited by capacity and scaled down by sedation
 *   pattern  — RR and VT; anatomic dead space makes rapid shallow breathing
 *              wasteful, which is how a tachypneic patient can still retain CO2
 *   VA       — alveolar ventilation, what actually clears CO2
 *
 * PaCO2 itself is integrated from a CO2 mass balance (see `paCO2Derivative`).
 */

/** Converts VCO2 (mL/min, STPD) / VA (L/min, BTPS) to mmHg: PaCO2 = 0.863 × VCO2 / VA. */
export const CO2_CONSTANT = 0.863;

/** Renal bicarbonate retention per mmHg of chronic hypercapnia (mEq/L per mmHg). */
const CHRONIC_HCO3_PER_MMHG = 0.4;

export interface VentilationInputs {
  paCO2: number;
  /** Arterial bicarbonate (mEq/L). */
  hco3: number;
  spO2: number;
  /** Total effective shunt, including edema and low flow. */
  qsQtEffective: number;
  pcwp: number;
  /** Mean PA pressure (mmHg), from the previous tick's circulation. */
  mPAP: number;
  /** Cardiac output (L/min) — respiratory muscles fail when it collapses. */
  co: number;
  /** Sedation / opioid depression of the controller, 0–1. */
  ventDepression: number;
  /** Alveolar dead-space fraction from disease, 0–1. */
  deadSpace: number;
  /** Ventilatory support, 0 spontaneous → 1 controlled mechanical ventilation. */
  ventSupport: number;
  /** Respiratory muscle fatigue, 0–1. */
  respFatigue: number;
  fiO2: number;
  /** Parenchymal shunt before edema/low-flow — the lung units that HPV was protecting. */
  qsQt: number;
}

export interface VentilationResult {
  /** Minute ventilation actually achieved (L/min). */
  ve: number;
  /** What the controller is asking for (L/min), before capacity and sedation. */
  veDemand: number;
  /** Sustainable ventilation the respiratory muscles can deliver (L/min). */
  veCapacity: number;
  /** Alveolar ventilation (L/min). */
  va: number;
  /** Respiratory rate (breaths/min). */
  rr: number;
  /** Tidal volume (L). */
  vt: number;
  /** Total dead-space fraction VD/VT, anatomic plus alveolar. */
  vdVt: number;
  /** The patient's own share of ventilation over their unfatigued capacity. */
  breathingLoad: number;
}

/**
 * Chemoreflex drive as a multiple of resting ventilation.
 *
 * Referenced to the patient's own PaCO2 setpoint and bicarbonate baseline, not
 * to textbook normals. A chronic CO2 retainer has reset central chemoreceptors
 * and a renally compensated bicarbonate; to them 55 mmHg is eupnea, and the
 * controller only responds to what has changed.
 *
 * The CO2 response is a dog-leg: steep above the setpoint (~2 L/min per mmHg in
 * a normal adult), much flatter below it. Without the flat limb a metabolic
 * acidosis could not be compensated — every breath that lowered PaCO2 would be
 * cancelled by an equally strong CO2 brake — and Winter's formula would be
 * unreachable.
 */
export function ventilatoryDemand(
  inp: Pick<VentilationInputs, 'paCO2' | 'hco3' | 'spO2' | 'qsQtEffective' | 'pcwp' | 'mPAP'>,
  params: HemodynamicParams,
): number {
  const co2Error = inp.paCO2 - params.paCO2Setpoint;
  const co2 = co2Error >= 0
    ? params.ventCo2Gain * co2Error
    : params.ventCo2GainLow * co2Error;

  // Peripheral and central response to fixed acid, measured against the
  // bicarbonate the chemoreceptors are adapted to: 24, plus the renal
  // compensation that goes with a chronically raised CO2 setpoint (~0.4 mEq/L
  // per mmHg — the chronic respiratory acidosis rule). So a retainer's
  // compensatory bicarbonate reads as normal, while a patient whose kidneys
  // cannot hold bicarbonate (hco3Baseline below 24) hyperventilates for it, as
  // chronic metabolic acidosis does. Signed: a metabolic alkalosis reduces drive.
  const adaptedHco3 = 24 + CHRONIC_HCO3_PER_MMHG * (params.paCO2Setpoint - 40);
  // Superlinear in the deficit: [H+] rises exponentially as bicarbonate falls,
  // and the chemoreceptors respond to [H+]. A linear term compensated a mild
  // acidosis correctly and a severe one (HCO3 8) ten mmHg short of Winter's.
  const deficit = adaptedHco3 - inp.hco3;
  const metabolic = params.ventMetabolicGain * deficit * (1 + Math.max(0, deficit) / params.ventMetabolicCurvature);

  // Carotid body. Negligible until the saturation is on the steep part of the curve.
  const hypoxic = params.ventHypoxicGain * Math.max(0, params.ventHypoxicSpO2Threshold - inp.spO2);

  // Non-chemical: J-receptors and stretch receptors in a stiff, wet or
  // consolidated lung. This is why pneumonia, PE and pulmonary edema are
  // hypocapnic until the patient tires — the drive is not chemical, so the CO2
  // brake does not switch it off.
  const shunt = params.ventShuntGain * Math.max(0, inp.qsQtEffective - 0.04);
  const edema = params.ventEdemaGain * Math.max(0, inp.pcwp - params.edemaPcwpThreshold);
  // Pulmonary vascular receptors: the hyperventilation of acute PE, which is
  // hypocapnic despite the dead space the clot creates.
  const vascular = params.ventPapGain * Math.max(0, inp.mPAP - 25);

  return Math.max(0, 1 + co2 + metabolic + hypoxic + shunt + edema + vascular);
}

/**
 * Sustainable ventilation.
 *
 * The diaphragm is a muscle with a blood supply. In low-output states it cannot
 * sustain the work the controller asks of it, and a shocked patient who was
 * compensating stops compensating — the mixed metabolic and respiratory acidosis
 * of late shock. Support adds capacity: NIV unloads the muscles, a ventilator
 * replaces them.
 */
export function ventilatoryCapacity(
  co: number,
  ventSupport: number,
  params: HemodynamicParams,
  respFatigue = 0,
  pcwp = 0,
): number {
  return ownCapacity(co, params, respFatigue, pcwp) + ventSupport * params.ventSupportCapacity;
}

/**
 * What the patient's own muscles can sustain, before any support.
 *
 * Three things take it away: a circulation too poor to perfuse the diaphragm,
 * fatigue, and a stiff lung. Interstitial and alveolar edema lower compliance,
 * so every liter of ventilation costs more work and fewer liters are
 * sustainable — the reason a patient in pulmonary edema tires, and the reason
 * offloading the preload makes breathing easier as well as oxygenation better.
 */
function ownCapacity(co: number, params: HemodynamicParams, respFatigue: number, pcwp: number): number {
  const perfusion = Math.max(0, Math.min(1, co / params.ventFatigueCoRef));
  const fresh = 1 - params.fatigueCapacityGain * Math.max(0, Math.min(1, respFatigue));
  const stiffness = 1 + params.edemaComplianceGain * Math.max(0, pcwp - params.edemaPcwpThreshold);
  return (params.veMax * perfusion * fresh) / stiffness;
}

/**
 * Rate of change of respiratory muscle fatigue, per second.
 *
 * The diaphragm can sustain a fraction of its maximal output indefinitely and
 * no more. Above that, fatigue accumulates for as long as the load stays there
 * — at a rate proportional to how far above — and because fatigue lowers
 * capacity, a patient breathing at their limit drifts further above it: the
 * slide that ends in "they are tiring". Below the threshold it recovers, slowly.
 *
 * Without this a patient could breathe at 45 a minute against a stiff lung all
 * night, holding a PaCO2 of 21, and never tire.
 */
export function fatigueRate(breathingLoad: number, respFatigue: number, params: HemodynamicParams): number {
  const excess = breathingLoad - params.fatigueLoadThreshold;
  if (excess > 0) {
    return (excess / params.fatigueLoadRange) * (1 - respFatigue) / params.tauFatigue;
  }
  return -respFatigue / params.tauFatigueRecovery;
}

export function computeVentilation(inp: VentilationInputs, params: HemodynamicParams): VentilationResult {
  const drive = ventilatoryDemand(inp, params);
  const veDemand = params.veRef * drive;
  const veCapacity = ventilatoryCapacity(inp.co, inp.ventSupport, params, inp.respFatigue, inp.pcwp);

  // Sedation acts on the controller; a ventilator does not care how sedated the
  // patient is, so support shields the drive from depression in proportion.
  //
  // CO2 narcosis adds to whatever sedation is on board: well above the patient's
  // own setpoint, CO2 depresses the controller it normally drives.
  const narcosis = params.narcosisGain
    * Math.max(0, inp.paCO2 - params.paCO2Setpoint - params.narcosisThreshold);
  const sedation = Math.min(1, Math.max(0, inp.ventDepression) * params.sedativeSensitivity + narcosis);
  const depression = sedation * (1 - Math.max(0, Math.min(1, inp.ventSupport)));
  const wanted = veDemand * (1 - depression);

  // Sedation also lowers the ceiling. A patient already breathing at their limit
  // is recruiting accessory muscles and holding their upper airway open by
  // effort, and a sedative takes some of both away — which is why a
  // benzodiazepine is dangerous in severe COPD even when the chemoreflex is
  // shouting. Scaling only the demand left such a patient untouched by sedation,
  // because their demand was already above what they could deliver.
  const cappedCapacity = veCapacity * (1 - params.sedationCapacityShare * depression);

  // Smooth minimum, so the transition into fatigue has no kink for the integrator.
  const ve = softMin(wanted, cappedCapacity, 0.5);

  // Breathing pattern. Rate rises less than proportionally with ventilation
  // (tidal volume carries some of it), and J-receptor drive shifts the pattern
  // toward rapid and shallow at any given minute ventilation.
  const shallow = 1
    + params.rrShallowShuntGain * Math.max(0, inp.qsQtEffective - 0.04)
    + params.rrShallowEdemaGain * Math.max(0, inp.pcwp - params.edemaPcwpThreshold);
  const slow = 1 - params.rrDepressionShare * depression;
  const rr = Math.max(0, params.rrRef * Math.pow(Math.max(0, ve) / params.veRef, params.rrVeExponent) * shallow * slow);
  const vt = rr > 0 ? ve / rr : 0;

  // Dead space. Anatomic dead space is a volume per breath, so it costs more of
  // each breath the shallower breathing becomes. Alveolar dead space is disease
  // (emphysema, PE, low output) plus the V/Q cost of oxygen in a patient whose
  // hypoxic vasoconstriction was protecting them: raise the FiO2, release the
  // HPV, and perfusion returns to units that are not ventilated.
  const o2DeadSpace = params.ventO2DeadSpaceGain
    * Math.max(0, inp.qsQt - 0.05)
    * Math.max(0, inp.fiO2 - 0.21);
  const alveolarDs = Math.min(0.8, Math.max(0, inp.deadSpace) + o2DeadSpace);
  const anatomicVent = Math.min(ve, rr * params.vdAnatomic);
  const va = Math.max(0, (ve - anatomicVent) * (1 - alveolarDs));
  const vdVt = ve > 0 ? 1 - va / ve : 1;

  // Load on the patient's own muscles: support carries its share of the work,
  // measured against what they could do fresh, so fatigue feeds back on itself.
  const support = Math.max(0, Math.min(1, inp.ventSupport));
  const fresh = ownCapacity(inp.co, params, 0, inp.pcwp);
  const breathingLoad = fresh > 0 ? (ve * (1 - support)) / fresh : (ve > 0 ? 1 : 0);

  return { ve, veDemand, veCapacity: cappedCapacity, va, rr, vt, vdVt, breathingLoad };
}

/**
 * Depression of consciousness, 0 (alert) to 1 (rousable only to pain or not at all).
 *
 * Drug sedation plus CO2 narcosis. Narcosis is graded against the patient's own
 * setpoint, and starts well below the level at which CO2 begins to suppress
 * breathing: a patient twenty mmHg above their usual is drowsy long before they
 * stop breathing, which is exactly the window in which somebody at the bedside
 * can notice. A retainer at 60 is at their baseline; a healthy adult at 60 is not.
 */
export function cnsDepression(paCO2: number, ventDepression: number, params: HemodynamicParams): number {
  const narcosis = Math.max(0, paCO2 - params.paCO2Setpoint - NARCOSIS_CNS_ONSET) / NARCOSIS_CNS_RANGE;
  return Math.max(0, Math.min(1, Math.max(0, ventDepression) * params.sedativeSensitivity + narcosis));
}

/** mmHg above setpoint at which CO2 begins to cloud consciousness. */
const NARCOSIS_CNS_ONSET = 20;
/** mmHg over which narcosis runs from drowsy to unrousable. */
const NARCOSIS_CNS_RANGE = 50;

/**
 * CO2 mass balance, mmHg per second.
 *
 *   C · dPaCO2/dt = VCO2 − VA · PaCO2 / 0.863
 *
 * C is the effective capacitance of the body's CO2 stores. Written this way
 * rather than as a first-order approach to 0.863·VCO2/VA because apnea (VA = 0)
 * has no steady state: PaCO2 simply climbs, a few mmHg a minute, which is what
 * the apneic patient actually does.
 */
export function paCO2Derivative(paCO2: number, va: number, vco2: number, params: HemodynamicParams): number {
  const eliminated = (va * paCO2) / CO2_CONSTANT; // mL/min
  return (vco2 - eliminated) / params.co2Capacitance / 60;
}

/** Henderson–Hasselbalch. */
export function arterialPh(hco3: number, paCO2: number): number {
  return 6.1 + Math.log10(hco3 / (0.0307 * Math.max(1, paCO2)));
}

function softMin(a: number, b: number, k: number): number {
  // Log-sum-exp form of min; k in L/min sets how sharp the corner is.
  const m = Math.min(a, b);
  return m - k * Math.log(Math.exp(-(a - m) / k) + Math.exp(-(b - m) / k));
}
