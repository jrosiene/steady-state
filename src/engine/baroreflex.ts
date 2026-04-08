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
): BaroreflexDerivatives {
  const error = params.mapSetpoint - map;

  // HR target = baroreflex component + pharmacologic chronotropic offset
  const hrTarget = clamp(
    params.hrBaseline + hrMod + params.gainHr * error,
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
