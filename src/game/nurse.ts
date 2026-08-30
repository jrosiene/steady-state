import type { Snapshot } from '../engine/types';
import type { PatientRuntime, Vitals } from './types';
import { assessAppearance, describeAppearance, respiratoryRate } from './clinical';

/**
 * Questions the player can put to the nurse.
 *
 * These exist because the numbers are not the whole picture. A nurse's gestalt —
 * how the patient looks, whether they are making urine, whether something has
 * changed — is often available well before a vital sign crosses a threshold, and
 * asking is free. The game rewards players who ask.
 */
export const NURSE_QUESTIONS: { id: string; text: string }[] = [
  { id: 'look', text: 'How does the patient look to you?' },
  { id: 'mental', text: "What's their mental status?" },
  { id: 'breathing', text: 'How is their breathing?' },
  { id: 'urine', text: 'Are they making urine?' },
  { id: 'access', text: 'What IV access do they have?' },
  { id: 'meds', text: 'What are they on right now?' },
  { id: 'callback', text: 'Call me back if anything changes.' },
];

/**
 * The nurse's answer, generated from the patient's true physiology.
 *
 * This is the one channel that always reflects reality, which is what makes it
 * valuable: charted vitals go stale, but asking how someone looks does not.
 */
export function answerQuestion(
  questionId: string,
  patient: PatientRuntime,
  snap: Snapshot,
): string {
  const inIcu = patient.location === 'icu';
  const v = patient.case.voice;

  switch (questionId) {
    case 'look':
      return capitalise(`${describeAppearance(snap, patient.case.baselineDrive)}.`);

    case 'mental':
      if (snap.cardiovascularStatus === 'arrest') return 'Unresponsive. No pulse.';
      if (snap.map < 55) {
        return `Barely rousable — I get a groan when I press on a nail bed, and that ${v.is} about it.`;
      }
      if (snap.map < 65) {
        return `Confused. ${v.Subj} ${v.verb('keep')} asking me what year it is and trying to climb out of bed.`;
      }
      if (snap.lactate > 4) {
        return `Drowsy. ${v.Subj} ${v.verb('wake')} to voice but ${v.verb('drift')} straight back off.`;
      }
      return 'Alert and oriented. Same as earlier.';

    case 'breathing': {
      // Answered from work of breathing, not from the saturation.
      //
      // This branch used to key entirely off SpO2 and wedge pressure, so a patient
      // in frank bronchospasm — breathing 30, holding 96% because of the effort —
      // came back as "easy, no distress". The saturation is the *result* of the
      // work; reporting it as though it were the work is how a nurse's answer ends
      // up contradicting what the nurse can plainly see.
      const rr = respiratoryRate(snap, patient.case.rrOffset);
      const grade = assessAppearance(snap, patient.case.baselineDrive).wob;
      const sat = `sat ${pct(snap.spO2)}% on ${patient.o2Device}`;
      const wet = snap.pcwp > 22
        ? ` Crackles up both bases, and ${v.subj} ${v.isnt} tolerating lying flat.`
        : '';

      if (grade === 3) {
        return `Terrible — ${sat}, rate of ${rr}, using every accessory muscle ${v.subj} ${v.has}.${wet}`;
      }
      if (grade === 2) {
        if (snap.pcwp > 28) {
          return `${v.Subj} ${v.is} drowning. ${capitalise(sat)}, rate of ${rr}, pink frothy sputum, and bolt upright.`;
        }
        return `Laboured. ${capitalise(sat)}, but ${v.subj} ${v.is} breathing ${rr} and only managing short phrases.${wet}`;
      }
      if (grade === 1) {
        if (snap.pcwp > 22) return `Wet. ${capitalise(sat)}, rate of ${rr}.${wet}`;
        return `Faster than earlier — ${rr}, ${sat}. Not distressed, but not comfortable either.`;
      }
      return `Easy, ${rr} and ${sat}. No distress.`;
    }

    case 'urine':
      // Urine output tracks renal perfusion pressure — an early, sensitive marker
      // that is available on the floor without any monitor at all.
      if (snap.map < 55) {
        return `Nothing in the bag for the last few hours. I don't think ${v.subj} ${v.is} making any.`;
      }
      if (snap.map < 65) return "Very little — maybe 15 mL an hour, and it's dark.";
      if (snap.map < 75) return 'Slowing down a bit. Maybe 25 mL an hour.';
      return 'Yes, good output. Nothing concerning.';

    case 'access':
      return inIcu
        ? `${v.Subj} ${v.has} a central line in the right IJ and an arterial line. Good access.`
        : 'Two peripherals — a 20 in the left forearm and a 22 in the hand. The 22 is positional.';

    case 'meds': {
      const running = activeTreatmentLabels(patient);
      if (running.length === 0) {
        return 'Nothing running at the moment besides maintenance fluids.';
      }
      return `Right now: ${running.join(', ')}.`;
    }

    case 'callback':
      return patient.monitored
        ? `Will do. ${v.Subj} ${v.is} on the monitor so I'll see any change straight away.`
        : `Of course. I'll lay eyes on ${v.obj} again shortly and let you know.`;

    default:
      return 'Sorry, not sure what you mean.';
  }
}

/** Human-readable names of the interventions currently doing something. */
function activeTreatmentLabels(patient: PatientRuntime): string[] {
  const seen = new Set<string>();
  for (const iv of patient.interventions) {
    if (iv.category !== 'treatment') continue;
    if (iv.stopTime !== undefined) continue;
    // Strip the mechanism suffix used internally, e.g. "Norepinephrine (SVR)".
    const base = iv.label.replace(/\s*\(.*\)$/, '').replace(/^O2:\s*/, 'oxygen by ');
    seen.add(base);
  }
  return [...seen];
}

// ─── Nurse-initiated concern ────────────────────────────────────────────────

export interface VitalsConcern {
  urgent: boolean;
  text: string;
}

/**
 * Decide whether a freshly-taken set of vitals is worth paging about.
 *
 * The nurse only knows what they have just measured. On an unmonitored floor
 * patient this is the only route by which a silent deterioration reaches the
 * player — which is precisely why the interval between checks matters so much.
 */
export function vitalsConcern(v: Vitals, snap: Snapshot, baselineDrive = 0): VitalsConcern | null {
  const problems: string[] = [];
  let urgent = false;

  if (snap.cardiovascularStatus === 'arrest') {
    return { urgent: true, text: 'I have no pulse — I need help in here now!' };
  }

  if (v.map < 55 || v.sbp < 80) {
    problems.push(`BP ${v.sbp}/${v.dbp}`);
    urgent = true;
  } else if (v.map < 65 || v.sbp < 90) {
    problems.push(`BP ${v.sbp}/${v.dbp}`);
  }

  if (v.spo2 < 88) {
    problems.push(`sat ${v.spo2}%${v.o2 === 'RA' ? ' on room air' : ` on ${v.o2}`}`);
    urgent = true;
  } else if (v.spo2 < 92) {
    problems.push(`sat ${v.spo2}% on ${v.o2}`);
  }

  if (v.hr > 130) {
    problems.push(`heart rate ${v.hr}`);
    urgent = true;
  } else if (v.hr > 115 || v.hr < 45) {
    problems.push(`heart rate ${v.hr}`);
  }

  if (v.rr > 30) {
    problems.push(`respiratory rate ${v.rr}`);
    urgent = true;
  }

  if (v.tempC >= 38.5) {
    problems.push(`temp ${v.tempC.toFixed(1)}`);
  }

  if (problems.length === 0) return null;

  const gestalt = describeAppearance(snap, baselineDrive);
  const lead = urgent
    ? 'I need you to know about this one'
    : 'Just flagging this';

  return {
    urgent,
    text: `${lead} — ${problems.join(', ')}. ${capitalise(gestalt)}.`,
  };
}

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
