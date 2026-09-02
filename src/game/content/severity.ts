import type { Rng } from './rng';

/**
 * How hard a given case bites on this particular night, as a continuous quantity.
 *
 * 0 is the mildest form of the illness that still warrants a page; 1 is as bad as
 * this case gets. Discrete bands were a mistake: three buckets meant every
 * urosepsis at a given label was physiologically the same patient, so the ward
 * had thirty-three possible setups and a returning player could recognize them.
 * A continuous axis gives a genuine spectrum, and — because each insult within a
 * case draws its own value around the case severity — two patients at the same
 * overall severity still present differently.
 */
export type Severity = number;

/** Coarse label, for display and for grouping in tests and calibration. */
export type SeverityBand = 'mild' | 'moderate' | 'severe';

export const SEVERITY_BANDS: readonly SeverityBand[] = ['mild', 'moderate', 'severe'];

export function bandOf(severity: Severity): SeverityBand {
  if (severity < 0.34) return 'mild';
  if (severity < 0.67) return 'moderate';
  return 'severe';
}

/** A representative value for a band, for tests that want to name one. */
export function severityOf(band: SeverityBand): Severity {
  switch (band) {
    case 'mild': return 0.18;
    case 'severe': return 0.85;
    default: return 0.5;
  }
}

/** Clamp to the valid range. */
export function clampSeverity(severity: number): Severity {
  return Math.min(1, Math.max(0, severity));
}

/**
 * Interpolate a physiologic value across the severity range.
 *
 * Archetypes state what a case looks like at its mildest and at its worst; every
 * value in between is real rather than a bucket boundary.
 */
export function lerp(severity: Severity, atMild: number, atSevere: number): number {
  return atMild + (atSevere - atMild) * clampSeverity(severity);
}

/**
 * Multiplier on the size of a physiologic insult.
 *
 * Spans 0.55 to 1.35 across the range, so the worst form of a case carries about
 * two and a half times the insult of the mildest.
 */
export function insultScale(severity: Severity): number {
  // The floor matters: at 0.55 even the mildest form of a case eventually killed
  // an untreated patient, which collapses the bottom of the range into "lethal
  // but slower". A third of full insult leaves room for a case that genuinely
  // does not need rescuing — which the ward needs, or every page is an emergency.
  return lerp(severity, 0.35, 1.35);
}

/**
 * Multiplier on onset time constants.
 *
 * Severity raises the ceiling on how bad things get; it does not shorten the
 * window in which the player can act. Scaling magnitude and speed together made
 * severe cases unwinnable rather than hard — a severe flash edema arrested
 * twenty-six minutes after its first page, which no realistic response beats, and
 * which tests reaction time rather than clinical reasoning.
 */
export function onsetScale(severity: Severity): number {
  return lerp(severity, 1.3, 1.05);
}

/**
 * Dampened scaling for hemoglobin loss.
 *
 * Oxygen-carrying capacity sits upstream of SvO2, lactate, and the acidosis
 * feedback loop, so it compounds far harder than a preload change of the same
 * nominal size. At full insult scaling a severe bleed reached a hemoglobin no
 * transfusion could catch up with.
 */
export function bloodLossScale(severity: Severity): number {
  return 1 + (insultScale(severity) - 1) * 0.5;
}

/**
 * Sample a severity for a case.
 *
 * Drawn from a triangular-ish distribution centred below the midpoint, so most
 * nights are survivable and a genuinely dangerous case is uncommon rather than
 * routine. Averaging two uniforms gives the central tendency without the hard
 * edges of a clamped Gaussian.
 */
export function sampleSeverity(rng: Rng, centre: number, spread: number): Severity {
  const draw = (rng.next() + rng.next()) / 2;
  return clampSeverity(centre + (draw - 0.5) * 2 * spread);
}

/**
 * A severity for one insult within a case.
 *
 * Each axis of a case varies independently around the case severity, so a sepsis
 * can present with marked vasoplegia and modest third-spacing, or the reverse.
 * This is what stops two patients at the same overall severity being the same
 * patient — and it is closer to how illness actually distributes itself.
 */
export function varyAxis(rng: Rng, severity: Severity, spread = 0.16): Severity {
  return clampSeverity(severity + (rng.next() - 0.5) * 2 * spread);
}

export function severityLabel(severity: Severity): string {
  const band = bandOf(severity);
  return `${band.charAt(0).toUpperCase()}${band.slice(1)}`;
}
