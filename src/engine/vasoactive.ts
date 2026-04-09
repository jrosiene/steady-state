import type { HemodynamicParams } from './types';

/**
 * Vasoactive mediator model — two layers of physiology connecting
 * pulmonary hypertension, hypoxia, and inflammation to systemic hemodynamics.
 *
 * Layer A: Instantaneous algebraic feedback couplings.
 *   Reflexes that operate cycle-to-cycle with no explicit mediator tracking.
 *
 * Layer B: Vasoactive mediator tone ODEs.
 *   noTone  — NO/PGI2-like. Elevated by hypoxemia and inflammation.
 *   et1Tone — Endothelin-1-like. Elevated by pulmonary hypertension.
 *   These drive first-order ODEs and are integrated by the RK4 solver.
 */

// ─── Layer A: Instantaneous feedback couplings ──────────────────────────────

/**
 * Hypoxic Pulmonary Vasoconstriction (HPV).
 *
 * Alveolar PO2 ↓ → pulmonary arteriolar constriction → PVR ↑.
 * This is the OPPOSITE of the systemic response: the lung shunts blood
 * away from hypoxic units to preserve V/Q matching.
 *
 * Kicks in below SpO2 threshold, linear with severity.
 * At SpO2=0.80: +1.95 WU (hpvGain=15, threshold=0.93 → 15 × 0.13 = 1.95 WU)
 */
export function computeHPV(spO2: number, params: HemodynamicParams): number {
  return params.hpvGain * Math.max(0, params.hpvSpO2Threshold - spO2);
}

/**
 * Hypoxic Systemic Vasodilation.
 *
 * Severe peripheral hypoxemia → tissue NO / adenosine release → SVR ↓.
 * Distinct from HPV: systemic arterioles dilate while pulmonary ones constrict.
 * Clinically: the vasodilatory pattern in COPD exacerbation, massive PE,
 * and severe diffuse shunting.
 *
 * At SpO2=0.80: −2.0 WU SVR (hypoxicVasoGain=20, threshold=0.90 → 20 × 0.10)
 */
export function computeHypoxicVasodilation(
  spO2: number,
  params: HemodynamicParams,
): number {
  return params.hypoxicVasoGain * Math.max(0, params.hypoxicVasoSpO2Threshold - spO2);
}

/**
 * RV-LV Ventricular Interdependence (Septal Shift).
 *
 * When RV dilates under elevated afterload (PH, PE), the interventricular
 * septum bows leftward — the "D-sign" on echo. This physically compresses
 * the LV diastolic cavity, reducing effective LV filling volume → SV ↓ → MAP ↓.
 *
 * This is a direct mechanical coupling that does NOT require any mediator.
 * It explains why patients in cor pulmonale or massive PE have low MAP even
 * when their SVR is high (LV is simply underfilled despite full compensation).
 *
 * Significant shift starts at RVEDV > 130% of the resting threshold.
 * At RVEDV=250 mL: penalty = 0.45 × (250−195) = 24.75 mL effective EDV loss
 */
export function computeRVLVInterdependence(
  rvedv: number,
  params: HemodynamicParams,
): number {
  return params.rvlvGain * Math.max(0, rvedv - params.rvlvRvedvThreshold);
}

/**
 * RVEDV equilibrium driven by RV afterload AND venous return.
 *
 * Two independent terms:
 *
 * 1. Afterload (PVR): RV dilates under elevated PVR (Frank-Starling compensation).
 *    At PVR=4 WU (+2.5 above ref): +37 mL → RVEDV ≈ 187 mL (near interdependence threshold)
 *    At PVR=7 WU (+5.5 above ref): +82 mL → RVEDV ≈ 232 mL (cor pulmonale range)
 *
 * 2. Venous return (EDV coupling): both ventricles fill from the same venous reservoir.
 *    EDV deviations from edvRef scale RVEDV proportionally via rvVrGain (≈1.25).
 *    Hemorrhage: EDV=30 → RVEDV target = 150 + 1.25×(30−120) = 37 mL ✓
 *    Volume overload: EDV=160 → RVEDV target = 150 + 1.25×(40) = 200 mL ✓
 *
 * Without this coupling, RVEDV stays at 150 mL during severe hemorrhage while
 * effective EDV drops to 30 mL — a physiologically impossible 5:1 ratio.
 */
export function computeRvedvTarget(
  effectivePVR: number,
  effectiveEDV: number,
  rvedvBaseline: number,
  params: HemodynamicParams,
): number {
  const afterloadTerm = params.rvDilationSensitivity * Math.max(0, effectivePVR - params.pvrRef);
  const venousReturnTerm = params.rvVrGain * (effectiveEDV - params.edvRef);
  return Math.max(params.rvedvMin, rvedvBaseline + afterloadTerm + venousReturnTerm);
}

// ─── Layer B: Vasoactive mediator tone targets ───────────────────────────────

/**
 * Compute the ODE targets for noTone and et1Tone.
 *
 * noTone (NO/PGI2-like tone):
 *   Target driven upward by hypoxemia via iNOS/eNOS activation.
 *   External inflammation (sepsis) modeled as a direct overlay intervention
 *   on the noTone state variable — the ODE handles only the hypoxic component.
 *   Target range: 0 at normal SpO2 → ~0.5 at SpO2=0.80 → ~1.0 at extreme hypoxia.
 *
 * et1Tone (Endothelin-1-like tone):
 *   Target driven by mPAP above a threshold (endothelial stretch/shear
 *   → ET-1 synthesis and release). Self-amplifying: ET-1 raises PVR →
 *   mPAP ↑ → more ET-1 — the mechanism behind progressive PAH remodeling.
 *   Target range: 0 at normal mPAP → ~0.88 at mPAP=40 mmHg.
 *
 * Clinical correlates:
 *   noTone elevated: sepsis (inflammation), COPD exacerbation (hypoxia),
 *                    severe anemia, ARDS
 *   et1Tone elevated: Group I PAH, Group IV CTEPH, any chronic pulmonary
 *                     hypertension with vascular remodeling
 *
 * Why ET-1 antagonists (bosentan, ambrisentan) lower MAP as a side effect:
 *   et1Tone normally provides mild baseline SVR support; blocking it drops
 *   both PVR AND SVR — correctly captured by et1ToneSvrGain.
 */
export function computeVasoactiveToneTargets(
  spO2: number,
  mPAP: number,
  params: HemodynamicParams,
): { noToneTarget: number; et1ToneTarget: number } {
  const noToneTarget = Math.min(
    1,
    params.noToneSpO2Gain * Math.max(0, params.noToneSpO2Threshold - spO2),
  );

  const et1ToneTarget = Math.min(
    1,
    params.et1ToneMpapGain * Math.max(0, mPAP - params.et1ToneMpapThreshold),
  );

  return { noToneTarget, et1ToneTarget };
}
