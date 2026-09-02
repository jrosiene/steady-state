import type { HemodynamicParams } from './types';

/**
 * Baroreflex controller: compute target HR and SVR from MAP error,
 * then return the rate of change (first-order approach to target).
 *
 * When MAP < setpoint → error > 0 → HR↑, SVR↑ (sympathetic activation)
 * When MAP > setpoint → error < 0 → HR↓, SVR↓ (parasympathetic tone)
 *
 * hrMod is a pharmacologic offset added to the HR target, modeling
 * direct β1 chronotropy. It shifts the target the baroreflex drives toward,
 * rather than fighting the baroreflex (which would produce no net effect).
 *
 * Phenylephrine (pure α1) has no hrMod — its reflex bradycardia emerges
 * automatically: SVR↑ → MAP↑ → negative error → hrTarget↓.
 *
 * Two afferent limbs, not one. The arterial baroreceptors sense pressure; the
 * cardiopulmonary receptors in the atria and ventricles sense filling. Modelling
 * only the arterial limb produced a patient who could bleed for six hours with a
 * completely unremarkable heart rate — because the arterial reflex was defending
 * the pressure successfully, it had no error to act on, and nothing else in the
 * model knew the tank was emptying. That is backwards from the bedside, where a
 * rising heart rate in a patient whose blood pressure is still normal is the
 * earliest sign of hemorrhage there is, and the whole reason the pressure looks
 * fine right up until it does not.
 */

export interface BaroreflexDerivatives {
  dHr: number; // bpm/s
  dSvr: number; // Wood units/s
}

export function computeBaroreflex(
  hr: number,
  svr: number,
  map: number,
  hrMod: number,
  params: HemodynamicParams,
  /**
   * Effective LV end-diastolic volume — the filling the cardiopulmonary
   * receptors are actually sensing, including whatever fluid has been given.
   * Defaults to the patient's own reference, which contributes nothing.
   */
  edv = params.edvRef,
): BaroreflexDerivatives {
  const error = params.mapSetpoint - map;

  // Cardiopulmonary (volume) reflex: unloading the atrial and ventricular stretch
  // receptors withdraws their tonic vagal inhibition, and the heart rate rises
  // before any pressure has been lost. Expressed as a fraction of this patient's
  // own resting volume, so it fires on the deficit rather than on an absolute.
  const fillingDeficit = Math.max(0, (params.edvRef - edv) / Math.max(1, params.edvRef));

  // HR target = arterial baroreflex + volume reflex + pharmacologic chronotropy
  const hrTarget = clamp(
    params.hrBaseline + hrMod + params.gainHr * error + params.gainHrVolume * fillingDeficit,
    params.hrMin,
    params.hrMax,
  );
  const svrTarget = clamp(
    params.svrBaseline + params.gainSvr * error,
    params.svrMin,
    params.svrMax,
  );

  const dHr = (hrTarget - hr) / params.tauHr;
  const dSvr = (svrTarget - svr) / params.tauSvr;

  return { dHr, dSvr };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
