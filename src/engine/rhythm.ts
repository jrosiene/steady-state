import type { HemodynamicParams } from './types';

/**
 * Cardiac rhythm: what the ventricles actually do with the rate the autonomic
 * system is asking for.
 *
 * In sinus rhythm the answer is trivial — the SA node fires at the baroreflex's
 * chosen rate and the ventricles follow — and `state.hr` has always been that
 * rate. In atrial fibrillation the SA node is irrelevant: hundreds of chaotic
 * atrial impulses reach the AV node, and the ventricular rate is whatever the
 * node lets through. Two things set that:
 *
 *   - Sympathetic tone, which shortens AV-nodal refractoriness. The baroreflex's
 *     chronotropic drive (`state.hr`) is the model's measure of it, so a septic
 *     or bleeding patient in AF runs faster for exactly the reason a patient in
 *     sinus rhythm would — and slowing that rate removes compensation.
 *   - AV-nodal blocking drugs (beta-blockers, diltiazem, digoxin, amiodarone).
 *
 * AF also costs filling twice over: the atrial contraction that tops up the
 * ventricle at end-diastole is gone (the "kick", worth more in a stiff
 * ventricle that fills late), and the irregular short cycles fill badly, so the
 * rate-dependent filling penalty bites harder than the same average rate in
 * sinus rhythm would.
 */

/**
 * Ventricular rate (bpm).
 *
 * `afib` is 0–1 so a conversion or an onset can ramp through the overlay
 * kinetics; in between, the rate is a blend.
 */
export function ventricularRate(
  sinusDrive: number,
  afib: number,
  avBlock: number,
  params: HemodynamicParams,
): number {
  const af = clamp01(afib);
  if (af === 0) return sinusDrive;
  const sympathetic = Math.max(0, sinusDrive - params.hrBaseline);
  const conducted = (params.afRestRate + params.afSympGain * sympathetic) * (1 - clamp01(avBlock));
  // The AV node's own refractory period caps what it can conduct: adult AF
  // without an accessory pathway rarely runs faster than about 170–180.
  const afRate = Math.max(params.afMinRate, Math.min(params.afMaxRate, params.hrMax, conducted));
  return af * afRate + (1 - af) * sinusDrive;
}

/**
 * Fraction of end-diastolic volume retained, given the rhythm and rate.
 *
 * Combines the rate-dependent diastolic filling penalty (which already existed,
 * for sinus tachycardia) with the loss of atrial kick and the steeper filling
 * penalty of an irregular rhythm.
 */
export function fillingFraction(rate: number, afib: number, params: HemodynamicParams): number {
  const af = clamp01(afib);
  const gain = params.filltimeGain * (1 + af * (params.afFillPenaltyMultiplier - 1));
  const rateTerm = Math.max(params.filltimeFloor,
    1 - gain * Math.max(0, rate - params.filltimeHrThreshold) / params.filltimeHrThreshold);
  return rateTerm * (1 - af * params.atrialKickFraction);
}

/**
 * Fraction of stroke output lost to the irregularity of AF (0–0.6).
 *
 * In AF the beats that follow the shortest cycles arrive before the ventricle
 * has filled and eject little or nothing — the pulse deficit between apex and
 * wrist. The loss grows with the ventricular rate (more short cycles) and with
 * ventricular stiffness (a stiff ventricle relaxes slowly and needs the long
 * cycles most). This, rather than the filling-volume penalty, is what makes a
 * fast AF lower cardiac output, and what rate control gives back.
 *
 * Applied to stroke volume rather than to end-diastolic volume on purpose: the
 * Starling curve here is forgiving at low filling, which is right for the
 * slow, sustained volume loss it was calibrated on (hemorrhage) and wrong for a
 * beat that simply comes too early.
 */
export function afStrokeLoss(rate: number, afib: number, params: HemodynamicParams): number {
  const af = clamp01(afib);
  if (af === 0) return 0;
  const stiffness = Math.sqrt(Math.max(0.05, params.lvEdpvrStiffness) / 0.2);
  const loss = params.afPulseDeficitGain * Math.max(0, rate - 80) / 80 * stiffness;
  return af * Math.min(0.6, loss);
}

/**
 * Volume held back in the left atrium by AF (mL), which raises its pressure.
 *
 * Mostly a matter of rate: in a short diastole the atrium cannot empty through
 * the mitral valve, so what the ventricle does not receive stays behind it.
 * Rate control lowers the wedge for exactly this reason. The lost atrial
 * contraction contributes a share as well — without it the atrium empties
 * passively, and less completely.
 */
export function laBackupVolume(
  preload: number,
  rate: number,
  afib: number,
  params: HemodynamicParams,
): number {
  const af = clamp01(afib);
  if (af === 0) return 0;
  const gain = params.filltimeGain * params.afFillPenaltyMultiplier;
  const rateLoss = 1 - Math.max(params.filltimeFloor,
    1 - gain * Math.max(0, rate - params.filltimeHrThreshold) / params.filltimeHrThreshold);
  return af * Math.max(0, preload) * (rateLoss + params.laKickShare * params.atrialKickFraction);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
