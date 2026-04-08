import type { HemodynamicParams } from './types';
import { computeRVSV } from './frank-starling';

/**
 * Pulmonary circuit: RV Starling, PCWP (LV filling pressure), mPAP.
 *
 * Coupling model (Option A — algebraic):
 *   RVCO and LVCO are assumed equal at steady state (conservation of flow).
 *   RVEDV and LVEDV are independently controllable — scenarios drive them.
 *   PCWP reflects LV filling pressure via the LV EDPVR.
 *   mPAP = RVCO × PVR + PCWP  (mirrors systemic: MAP = CO × SVR + CVP)
 *
 * PH classification via this model:
 *   Class I  (PAH):       PVR↑, PCWP normal → mPAP↑ from resistive component
 *   Class II (LV disease): LV emax↓ / EDV↑ → PCWP↑ → mPAP↑ from backpressure
 *   Class III (hypoxic):  PVR↑ from HPV (scenario-driven qsQt/pvr)
 *   Class IV (CTEPH):     PVR↑ (mechanical obstruction), can be acute or chronic
 */

/**
 * LV end-diastolic pressure ≈ PCWP.
 *
 * Linear EDPVR: LVEDP = (EDV − V0) × stiffness / emax
 *
 * Dividing by emax captures two key pathologies:
 *   - Diastolic failure (stiff LV, high emax in HFpEF): LVEDP elevated for given EDV
 *   - Systolic failure (dilated LV, low emax in HFrEF): LVEDP elevated because EDV is high
 *
 * Floor at 2 mmHg to prevent physiologically impossible values.
 */
export function computePCWP(
  edv: number,
  emax: number,
  params: HemodynamicParams,
): number {
  const lvedp = (Math.max(0, edv - params.v0) * params.lvEdpvrStiffness) / emax;
  return Math.max(2, lvedp);
}

/**
 * RV cardiac output.
 * Returns { rvSv (mL), rvCo (L/min) }.
 */
export function computeRVOutput(
  rvedv: number,
  rvEmax: number,
  hr: number,
  params: HemodynamicParams,
): { rvSv: number; rvCo: number } {
  const rvSv = computeRVSV(rvedv, rvEmax, params);
  const rvCo = (hr * rvSv) / 1000;
  return { rvSv, rvCo };
}

/**
 * Mean pulmonary artery pressure.
 * mPAP = RVCO × PVR + PCWP
 *
 * Analogous to MAP = CO × SVR + CVP.
 *
 * Clinical thresholds:
 *   Normal: mPAP < 20 mmHg
 *   Borderline: 20–24 mmHg
 *   PH: mPAP ≥ 25 mmHg
 *   Severe PH: mPAP ≥ 45 mmHg
 */
export function computeMPAP(
  rvCo: number,
  pvr: number,
  pcwp: number,
): number {
  return rvCo * pvr + pcwp;
}

/**
 * Pulmonary arterial compliance index (informational, not used in ODE).
 * Normal transpulmonary gradient (TPG) = mPAP - PCWP < 12 mmHg.
 * Elevated TPG indicates intrinsic vascular disease vs passive congestion.
 */
export function computeTPG(mPAP: number, pcwp: number): number {
  return mPAP - pcwp;
}
