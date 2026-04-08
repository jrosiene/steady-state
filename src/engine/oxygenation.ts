import type { HemodynamicParams } from './types';

/**
 * Gas exchange and oxygenation.
 *
 * Model: Two-compartment shunt (Riley model).
 *
 *   Mixed arterial saturation = ideal capillary × (1 − Qs/Qt) + mixed venous × (Qs/Qt)
 *
 * This is the saturation-weighted mixing approximation. It's slightly less
 * accurate than content-based mixing at extreme shunts, but clinically adequate
 * for teaching and avoids the iterative solve required for the full model.
 *
 * Key teaching properties preserved:
 *   - High shunt fraction → SpO2 falls despite normal alveolar PO2
 *   - Supplemental O2 fixes dead space/low V/Q but NOT true shunt (SpO2 plateaus)
 *   - SvO2 falls when CO drops (Fick) → amplifies shunt effect in low-output states
 */

const ATMOSPHERIC_PRESSURE = 760; // mmHg
const WATER_VAPOR_PRESSURE = 47;  // mmHg at 37°C

/**
 * Alveolar PO2 from the simplified alveolar gas equation.
 *   PAO2 = FiO2 × (Patm − PH2O) − PaCO2 / RQ
 */
export function computeAlveolarPO2(
  fiO2: number,
  params: HemodynamicParams,
): number {
  return (
    fiO2 * (ATMOSPHERIC_PRESSURE - WATER_VAPOR_PRESSURE) -
    params.paCO2 / params.rq
  );
}

/**
 * Oxygen saturation from PO2 via the Hill equation (oxygen-hemoglobin dissociation curve).
 *   SpO2 = PO2^n / (PO2^n + P50^n)
 *
 * Parameters: P50 = 26.8 mmHg, n = 2.7 (standard conditions).
 */
export function hillSaturation(pO2: number, params: HemodynamicParams): number {
  if (pO2 <= 0) return 0;
  const pN = Math.pow(pO2, params.hillN);
  const p50N = Math.pow(params.p50, params.hillN);
  return pN / (pN + p50N);
}

/**
 * PO2 from saturation — inverse Hill equation.
 *   PO2 = P50 × (sat / (1 − sat))^(1/n)
 *
 * Used to convert final SpO2 back to a displayable PaO2.
 * Clamped away from 0 and 1 to avoid numeric issues.
 */
export function hillPO2(sat: number, params: HemodynamicParams): number {
  const clamped = Math.min(0.9999, Math.max(0.0001, sat));
  return params.p50 * Math.pow(clamped / (1 - clamped), 1 / params.hillN);
}

/**
 * Mixed venous O2 saturation estimated from the Fick equation.
 *
 *   VO2 = CO × Hgb × 1.34 × (SaO2 − SvO2) × 10
 *   SvO2 = SaO2 − VO2 / (CO × Hgb × 1.34 × 10)
 *
 * Units: CO in L/min, Hgb in g/dL, VO2 in mL/min.
 * 1.34 mL O2/g Hgb (Hüfner's constant).
 * ×10 converts dL → L.
 *
 * Uses the ideal (pre-shunt) SaO2 as the approximation for arterial saturation
 * in the Fick equation — accurate for shunt fractions < ~30%.
 */
export function computeSvO2(
  co: number,
  saO2Ideal: number,
  params: HemodynamicParams,
): number {
  const o2DeliveryCapacity = co * params.hgb * 1.34 * 10; // mL O2/min at full saturation
  if (o2DeliveryCapacity <= 0) return 0.3; // extreme fallback
  const svO2 = saO2Ideal - params.vo2 / o2DeliveryCapacity;
  return Math.min(saO2Ideal - 0.05, Math.max(0.1, svO2));
}

/**
 * Compute full oxygenation state.
 *
 * Returns: { spO2, paO2, svO2 }
 *
 * Two-step:
 *   1. Ideal capillary saturation from alveolar PO2 (what V/Q-matched lung delivers)
 *   2. Shunt mixing: SpO2 = SaO2_ideal × (1 − Qs/Qt) + SvO2 × (Qs/Qt)
 *
 * Clinical validation:
 *   Room air, no shunt: SpO2 ≈ 97.2%  (PAO2≈99 mmHg)
 *   30% shunt, room air: SpO2 ≈ 88–91% (not correctable with O2 alone)
 *   30% shunt, 100% FiO2: SpO2 ≈ 91–92% (O2 barely moves it — key teaching point)
 */
export function computeOxygenation(
  fiO2: number,
  qsQt: number,
  co: number,
  params: HemodynamicParams,
): { spO2: number; paO2: number; svO2: number } {
  const pAlvO2 = computeAlveolarPO2(fiO2, params);
  const saO2Ideal = hillSaturation(pAlvO2, params);
  const svO2 = computeSvO2(co, saO2Ideal, params);

  // Two-compartment shunt mixing (saturation-weighted)
  const spO2 = saO2Ideal * (1 - qsQt) + svO2 * qsQt;
  const paO2 = hillPO2(spO2, params);

  return { spO2, paO2, svO2 };
}
