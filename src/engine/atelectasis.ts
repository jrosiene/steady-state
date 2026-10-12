import type { HemodynamicParams } from './types';

/**
 * Atelectasis: lung that has collapsed but could be reopened.
 *
 * Everything else the model calls shunt (`qsQt`) is a fixed property of the
 * disease — consolidation, edema, a hole between the circulations — and only
 * treating the disease changes it. Collapsed alveoli are different: they open
 * with pressure and close again without it, over tens of minutes, and that is
 * most of the gas-exchange problem in obesity. The abdomen and the chest wall
 * push the diaphragm up, functional residual capacity falls below the volume
 * at which dependent airways close, and the bases collapse — more lying flat,
 * more asleep, more with shallow breaths that never sigh, and more on high
 * oxygen, whose nitrogen-free gas is absorbed out of a closed unit entirely.
 *
 * So the compartment has a target, set by how prone the patient is and how
 * they are breathing, and moves toward it with time: collapse is slow,
 * recruitment faster. End-expiratory pressure — PEEP, CPAP, the EPAP of BiPAP
 * — holds units open, and sitting up does the same by letting the diaphragm
 * fall; both enter as `peep`, in cmH2O, posture as its pressure equivalent.
 */

/** Tidal volume of quiet breathing at rest (L): veRef / rrRef. */
function restingVt(params: HemodynamicParams): number {
  return params.veRef / params.rrRef;
}

/** Fraction of recruitable lung held open by an end-expiratory pressure. */
export function recruitedFraction(peep: number, params: HemodynamicParams): number {
  const p = Math.max(0, peep);
  return p / (p + params.peepHalfRecruit);
}

/**
 * The shunt fraction this patient's atelectasis is heading toward.
 *
 * Zero for a patient who is not prone to it, whatever they are doing: a lean
 * adult on an opioid breathes shallowly without losing their bases.
 */
export function atelectasisTarget(
  vt: number,
  ve: number,
  /** CNS depression or sleep, whichever is deeper: either abolishes sighs. */
  cnsDepression: number,
  fiO2: number,
  peep: number,
  params: HemodynamicParams,
): number {
  if (params.atelectasisProne <= 0) return 0;
  // Sedation and sleep abolish the periodic sigh that reopens closing units.
  const sighs = params.atelectasisSighGain * Math.max(0, Math.min(1, cnsDepression));
  // Small breaths, or few of them: rapid shallow breathing and an opioid's slow
  // breathing both leave the bases less expanded than a resting adult's.
  const shallow = params.atelectasisShallowGain
    * Math.max(0, 1 - vt / restingVt(params), 1 - ve / params.veRef);
  // Absorption: a closing unit full of oxygen empties itself into the blood.
  const absorption = params.atelectasisAbsorptionGain * Math.max(0, fiO2 - 0.5) / 0.5;
  const prone = params.atelectasisProne * (1 + sighs + shallow) * (1 + absorption);
  return Math.min(0.5, prone * (1 - recruitedFraction(peep, params)));
}

/** d(atelectasis)/dt, per second. */
export function atelectasisDerivative(
  atelectasis: number,
  target: number,
  params: HemodynamicParams,
): number {
  const tau = target > atelectasis ? params.tauAtelectasisCollapse : params.tauAtelectasisOpen;
  return (target - atelectasis) / tau;
}
