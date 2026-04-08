import type { HemodynamicParams } from './types';

/**
 * Generic Starling curve parameters — used for both LV and RV.
 * Extracted so both ventricles can share the same math with different tuning.
 */
export interface StarlingConfig {
  svMax: number;
  v0: number;
  km: number;
  emaxRef: number;
  edvCritBase: number;
  overdistensionSteepness: number;
}

/**
 * Ventricular Frank-Starling: compute stroke volume from preload and contractility.
 *
 * Ascending limb (Michaelis-Menten):
 *   SV_base = SVmax × effectiveEDV / (effectiveEDV + Km)
 *
 * Contractility scaling:
 *   SV_scaled = (Emax / EmaxRef) × SV_base
 *
 * Descending limb (overdistension, Gaussian penalty):
 *   edvCrit = edvCritBase × (Emax / EmaxRef)
 *   penalty = exp(−steepness × max(0, EDV − edvCrit)²)
 *
 * The failing ventricle overdistends at lower volumes because edvCrit scales
 * with contractility — this is what makes fluid bolus harmful in cardiogenic shock.
 */
export function computeSVGeneric(
  edv: number,
  emax: number,
  cfg: StarlingConfig,
): number {
  const effectiveEDV = Math.max(0, edv - cfg.v0);
  const svBase = (cfg.svMax * effectiveEDV) / (effectiveEDV + cfg.km);
  // Clamp contractility scale to ≥ 0: negative emax (from extreme stacked interventions)
  // would invert the Starling curve. Physical minimum is zero output (arrested ventricle).
  const contractilityScale = Math.max(0, emax / cfg.emaxRef);
  const svScaled = svBase * contractilityScale;

  // edvCrit scales with contractility; guard against negative values (which would make
  // excess always large and trigger full overdistension penalty at any preload).
  const edvCrit = Math.max(0, cfg.edvCritBase * contractilityScale);
  const excess = Math.max(0, edv - edvCrit);
  const overdistensionPenalty = Math.exp(-cfg.overdistensionSteepness * excess * excess);

  return Math.min(cfg.svMax, Math.max(0, svScaled * overdistensionPenalty));
}

/** LV stroke volume — convenience wrapper using LV params from HemodynamicParams. */
export function computeSV(
  edv: number,
  emax: number,
  params: HemodynamicParams,
): number {
  return computeSVGeneric(edv, emax, {
    svMax: params.svMax,
    v0: params.v0,
    km: params.km,
    emaxRef: params.emaxRef,
    edvCritBase: params.edvCritBase,
    overdistensionSteepness: params.overdistensionSteepness,
  });
}

/** RV stroke volume — uses RV-specific params from HemodynamicParams. */
export function computeRVSV(
  rvedv: number,
  rvEmax: number,
  params: HemodynamicParams,
): number {
  return computeSVGeneric(rvedv, rvEmax, {
    svMax: params.rvSvMax,
    v0: params.rvV0,
    km: params.rvKm,
    emaxRef: params.rvEmaxRef,
    edvCritBase: params.rvEdvCritBase,
    overdistensionSteepness: params.rvOverdistensionSteepness,
  });
}
