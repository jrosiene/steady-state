/**
 * How hard a given case bites on this particular night.
 *
 * The same clinical problem is not the same problem twice. A mild urosepsis
 * wants fluids and antibiotics and will forgive you being slow; a severe one is
 * in the unit by midnight or dead by two. Varying this across replays is what
 * stops the ward becoming a memory test — the player has to read the patient in
 * front of them rather than recall what this name did last time.
 */
export type Severity = 'mild' | 'moderate' | 'severe';

/**
 * A note on what severity is allowed to mean here.
 *
 * These are admitted acute-care medicine patients: somebody has already triaged
 * them and judged a general ward appropriate. So severity does not show up as a
 * patient who is visibly peri-arrest at sign-out — their observations at 19:00
 * look like observations a day team would have been willing to leave on the
 * floor. That is precisely why the deterioration is a surprise, and why the
 * charted numbers are worth so little on their own.
 *
 * It is also fine for a severe case to be unsalvageable. Some physiology is not
 * correctable, and a game in which every patient can be saved by finding the
 * right order teaches something false about medicine. What must never happen is
 * a case that is lost before the player can act — the difference being whether
 * the outcome turned on a decision or on a stopwatch.
 */

export const SEVERITIES: readonly Severity[] = ['mild', 'moderate', 'severe'];

/**
 * Multiplier on the size of the physiologic insult.
 *
 * A mild case is a genuine case — it still declares itself and still deserves
 * treatment — but it has enough reserve that a merely adequate response is
 * enough. Severe cases carry roughly twice the insult of mild ones.
 */
export function insultScale(severity: Severity): number {
  switch (severity) {
    case 'mild': return 0.62;
    case 'severe': return 1.3;
    default: return 1.0;
  }
}

/**
 * Multiplier on onset time constants.
 *
 * Severity raises the ceiling on how bad things get; it does not shorten the
 * window in which the player can act. Scaling magnitude and speed together made
 * severe cases unwinnable rather than hard — a severe flash oedema arrested
 * twenty-six minutes after its first page, which no realistic response can beat,
 * and which tests reaction time rather than clinical reasoning.
 *
 * So a severe case takes marginally longer to reach a much worse endpoint, and a
 * mild one unfolds gently. Time to react stays roughly constant; what changes is
 * how much trouble is waiting at the end of it.
 */
export function onsetScale(severity: Severity): number {
  switch (severity) {
    case 'mild': return 1.25;
    case 'severe': return 1.08;
    default: return 1.0;
  }
}

/**
 * Dampened scaling for haemoglobin loss.
 *
 * Oxygen-carrying capacity sits upstream of SvO2, lactate, and the acidosis
 * feedback loop, so it compounds far harder than a preload change of the same
 * nominal size. At full insult scaling a severe bleed reached a haemoglobin no
 * transfusion could catch up with, which turned a hard case into an unwinnable
 * one. Half the deviation keeps a severe bleed genuinely dangerous and still
 * salvageable by someone who transfuses promptly.
 */
export function bloodLossScale(severity: Severity): number {
  return 1 + (insultScale(severity) - 1) * 0.5;
}

/**
 * How much physiologic reserve the patient starts the shift with.
 *
 * Applied to the starting state so severity is visible before anything happens —
 * a severe case is already running a little hot at sign-out, which is exactly the
 * sort of thing a careful player notices on the handoff vitals.
 */
export function reserveScale(severity: Severity): number {
  switch (severity) {
    case 'mild': return 1.08;
    case 'severe': return 0.9;
    default: return 1.0;
  }
}

export function severityLabel(severity: Severity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}
