import type { HemodynamicParams, HemodynamicState } from './types';
import { DEFAULT_PARAMS, DEFAULT_STATE } from './constants';

/**
 * Box-Muller transform: samples from N(0,1).
 * Using two uniform samples for a proper Gaussian, not a CLT approximation.
 */
function randn(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
}

/** Sample from N(mean, std), clamped to [min, max]. */
function sample(mean: number, std: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, mean + std * randn()));
}

/**
 * Per-variable physiologic coefficient of variation (CV = std/mean).
 * Derived from population physiology literature.
 * CV of ~10% = mild inter-patient spread; ~20% = wide.
 */
const CV = {
  // Systemic
  mapSetpoint: 0.08,
  hrBaseline: 0.12,
  svrBaseline: 0.15,
  gainHr: 0.20,
  gainSvr: 0.20,
  tauHr: 0.20,
  tauSvr: 0.20,
  svMax: 0.10,
  km: 0.15,
  emaxRef: 0.15,
  edvCritBase: 0.10,
  edvBaseline: 0.12,
  cvpBaseline: 0.20,
  // Pulmonary
  rvEmaxRef: 0.15,     // ±~0.075 (0.3–0.7 range)
  pvrBaseline: 0.20,   // ±~0.3 WU  (0.9–2.1 WU range)
  rvedvBaseline: 0.15, // ±~22 mL   (105–195 mL range)
  hgb: 0.10,           // ±~1.5 g/dL (Hgb affects O2 delivery)
} as const;

export interface PatientProfile {
  params: HemodynamicParams;
  initialState: HemodynamicState;
  /** Textual description of how this patient deviates from the population mean. */
  descriptor: string;
}

/**
 * Generate a randomized patient by sampling each physiologic parameter
 * from a Gaussian distribution centered on the population mean.
 *
 * Returned params are safe to pass directly to the engine.
 */
export function samplePatient(): PatientProfile {
  const p = DEFAULT_PARAMS;

  const mapSetpoint = sample(p.mapSetpoint, p.mapSetpoint * CV.mapSetpoint, 70, 110);
  const hrBaseline  = sample(p.hrBaseline,  p.hrBaseline  * CV.hrBaseline,  45, 95);
  const svrBaseline = sample(p.svrBaseline, p.svrBaseline * CV.svrBaseline,  10, 26);
  const gainHr      = sample(p.gainHr,      p.gainHr      * CV.gainHr,       0.8, 2.5);
  const gainSvr     = sample(p.gainSvr,     p.gainSvr     * CV.gainSvr,      0.25, 0.70);
  const tauHr       = sample(p.tauHr,       p.tauHr       * CV.tauHr,        1.5, 5.0);
  const tauSvr      = sample(p.tauSvr,      p.tauSvr      * CV.tauSvr,       4.0, 14.0);
  const svMax       = sample(p.svMax,        p.svMax       * CV.svMax,        90, 170);
  const km          = sample(p.km,           p.km          * CV.km,           50, 120);
  const emaxRef     = sample(p.emaxRef,      p.emaxRef     * CV.emaxRef,      1.2, 3.0);
  const edvCritBase = sample(p.edvCritBase,  p.edvCritBase * CV.edvCritBase,  190, 310);
  const edvBaseline   = sample(DEFAULT_STATE.edv,    DEFAULT_STATE.edv    * CV.edvBaseline,   80, 160);
  const cvpBaseline   = sample(DEFAULT_STATE.cvp,    DEFAULT_STATE.cvp    * CV.cvpBaseline,   2, 10);
  const rvEmaxRef     = sample(p.rvEmaxRef,           p.rvEmaxRef          * CV.rvEmaxRef,     0.3, 0.8);
  const pvrBaseline   = sample(DEFAULT_STATE.pvr,    DEFAULT_STATE.pvr    * CV.pvrBaseline,   0.8, 2.5);
  const rvedvBaseline = sample(DEFAULT_STATE.rvedv,  DEFAULT_STATE.rvedv  * CV.rvedvBaseline, 105, 195);
  const hgb           = sample(p.hgb,                p.hgb                * CV.hgb,           10, 18);

  const params: HemodynamicParams = {
    ...p,
    mapSetpoint,
    hrBaseline,
    svrBaseline,
    gainHr,
    gainSvr,
    tauHr,
    tauSvr,
    svMax,
    km,
    emaxRef,
    edvCritBase,
    rvEmaxRef,
    hgb,
    // RVEDV reference matches the patient's sampled resting RVEDV
    rvedvRef: rvedvBaseline,
    // PVR reference matches the patient's sampled resting PVR
    pvrRef: pvrBaseline,
  };

  const initialState: HemodynamicState = {
    ...DEFAULT_STATE,
    hr: hrBaseline,
    svr: svrBaseline,
    edv: edvBaseline,
    emax: emaxRef,
    cvp: cvpBaseline,
    rvEmax: rvEmaxRef,
    pvr: pvrBaseline,
    rvedv: rvedvBaseline,
    noTone: 0,
    et1Tone: 0,
  };

  const descriptor = buildDescriptor({ mapSetpoint, hrBaseline, svrBaseline, emaxRef, gainHr, gainSvr, tauHr, pvrBaseline, hgb });

  return { params, initialState, descriptor };
}

/** Generate a human-readable summary of notable deviations from population mean. */
function buildDescriptor(sampled: {
  mapSetpoint: number; hrBaseline: number; svrBaseline: number;
  emaxRef: number; gainHr: number; gainSvr: number; tauHr: number;
  pvrBaseline: number; hgb: number;
}): string {
  const p = DEFAULT_PARAMS;
  const notes: string[] = [];
  const pct = (v: number, ref: number) => Math.round(((v - ref) / ref) * 100);

  const mapPct = pct(sampled.mapSetpoint, p.mapSetpoint);
  if (Math.abs(mapPct) >= 6) notes.push(`MAP setpoint ${mapPct > 0 ? 'high' : 'low'} (${sampled.mapSetpoint.toFixed(0)} mmHg)`);

  const hrPct = pct(sampled.hrBaseline, p.hrBaseline);
  if (Math.abs(hrPct) >= 10) notes.push(`resting HR ${hrPct > 0 ? 'high' : 'low'} (${sampled.hrBaseline.toFixed(0)} bpm)`);

  const svrPct = pct(sampled.svrBaseline, p.svrBaseline);
  if (Math.abs(svrPct) >= 12) notes.push(`baseline SVR ${svrPct > 0 ? 'elevated' : 'low'} (${sampled.svrBaseline.toFixed(1)} WU)`);

  const emaxPct = pct(sampled.emaxRef, p.emaxRef);
  if (Math.abs(emaxPct) >= 12) notes.push(`LV contractility ${emaxPct > 0 ? 'hyperdynamic' : 'reduced'} (Emax ${sampled.emaxRef.toFixed(1)})`);

  const gainPct = pct(sampled.gainHr, p.gainHr);
  if (Math.abs(gainPct) >= 15) notes.push(`baroreflex ${gainPct > 0 ? 'brisk' : 'blunted'}`);

  if (sampled.tauHr > p.tauHr * 1.3) notes.push('slow autonomic response');

  const pvrPct = pct(sampled.pvrBaseline, DEFAULT_STATE.pvr);
  if (Math.abs(pvrPct) >= 20) notes.push(`PVR ${pvrPct > 0 ? 'elevated' : 'low'} (${sampled.pvrBaseline.toFixed(1)} WU)`);

  if (sampled.hgb < p.hgb * 0.85) notes.push(`anemia (Hgb ${sampled.hgb.toFixed(1)} g/dL)`);
  if (sampled.hgb > p.hgb * 1.15) notes.push(`polycythemia (Hgb ${sampled.hgb.toFixed(1)} g/dL)`);

  return notes.length > 0 ? notes.join('; ') : 'unremarkable physiology';
}
