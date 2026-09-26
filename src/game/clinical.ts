import type { Snapshot, HemodynamicParams } from '../engine/types';
import type { Vitals, LabValue, LabResult } from './types';
import { SHIFT_START_HOUR } from './types';

/**
 * Arterial compliance (mL/mmHg) used to turn stroke volume into a pulse pressure.
 * PP = SV / C. At SV = 72 mL this gives PP ≈ 45 mmHg, so a MAP of 90 renders as
 * roughly 120/75 — the expected reading for a normal adult.
 */
const ARTERIAL_COMPLIANCE = 1.6;

/**
 * Convert true physiology into the blood pressure a cuff would report.
 *
 * MAP = DBP + PP/3 is the standard clinical approximation, inverted here so the
 * engine's MAP (the physiologically meaningful quantity) drives a systolic and
 * diastolic pair that clinicians can reason about.
 */
export function bloodPressure(snap: Snapshot): { sbp: number; dbp: number } {
  const pp = Math.max(8, snap.sv / ARTERIAL_COMPLIANCE);
  const dbp = snap.map - pp / 3;
  return {
    sbp: Math.round(Math.max(dbp + pp, 0)),
    dbp: Math.round(Math.max(dbp, 0)),
  };
}

/** Engine respiratory rate at rest with a drive of 1. */
const RR_REST = 13;

/**
 * Breaths per minute above a normal resting rate.
 *
 * Read from the engine's ventilation model rather than assembled here. The
 * engine owns the drives — CO2 and metabolic chemoreflexes, the carotid body,
 * J-receptors in a wet or consolidated lung — and a rate computed from them is
 * one that actually moves CO2, so a patient charted at 30 and a PaCO2 on the
 * afternoon gas are the same patient. Negative when the patient is breathing
 * slower than normal, which is the sign that matters in an opioid overdose.
 *
 * This used to be a separate cosmetic formula, which could not produce a
 * slowing rate at all: sedation, narcosis and a tiring patient were invisible
 * to it by construction.
 */
export function respiratoryDrive(snap: Snapshot): number {
  return snap.rr - RR_REST;
}

/**
 * Respiratory rate.
 *
 * `rrOffset` is the part of a given patient's rate the model does not represent
 * — pain, anxiety, deconditioning — carried by the case. It rides on top of a
 * breathing patient and is not added to one who has stopped: the anxious
 * patient's extra four breaths do not survive an opioid overdose.
 */
export function respiratoryRate(snap: Snapshot, rrOffset = 0): number {
  const awake = 1 - snap.cnsDepression;
  return Math.round(Math.max(0, Math.min(45, snap.rr + rrOffset * awake)));
}

/**
 * Core temperature.
 *
 * Fever emerges from the inflammatory mediator tone rather than being scripted,
 * so a patient who becomes septic during the shift also becomes febrile, and a
 * patient whose sepsis is treated defervesces.
 */
export function temperature(snap: Snapshot, offsetC = 0): number {
  return 36.8 + snap.noTone * 2.2 + offsetC;
}

/** Build the vitals a nurse would chart from the patient's true physiology. */
export function chartVitals(
  snap: Snapshot,
  time: number,
  o2Device: string,
  tempOffset = 0,
  rrOffset = 0,
): Vitals {
  const { sbp, dbp } = bloodPressure(snap);
  return {
    time,
    hr: Math.round(snap.hr),
    sbp,
    dbp,
    map: Math.round(snap.map),
    rr: respiratoryRate(snap, rrOffset),
    spo2: Math.round(snap.spO2 * 100),
    tempC: Math.round(temperature(snap, tempOffset) * 10) / 10,
    o2: o2Device,
    ...(snap.afib > 0.5 ? { irregular: true } : {}),
  };
}

// ─── Gestalt ────────────────────────────────────────────────────────────────

/**
 * Severity on one axis of the bedside look: 0 fine, 3 dire.
 */
export type GestaltGrade = 0 | 1 | 2 | 3;

export interface Gestalt {
  /** Work of breathing. */
  wob: GestaltGrade;
  /** Perfusion and mentation. */
  perf: GestaltGrade;
  /**
   * Sedation: drugs and CO2 narcosis. A separate axis because it is a separate
   * failure — a hypoventilating patient is neither working hard to breathe nor
   * poorly perfused, and both of the other axes read them as comfortable. The
   * nurse's word for it is "hard to wake", and it is the only early sign there is.
   */
  sed: GestaltGrade;
  /** Prose description, worst finding first. */
  text: string;
}

/**
 * How the patient looks from the doorway.
 *
 * This is the most valuable thing a nurse can tell you: perfusion, mentation and
 * work of breathing all degrade before a cuff pressure declares itself, and
 * asking is free.
 *
 * Two independent axes, deliberately. An earlier version ran perfusion as an
 * else-chain that always emitted something and then appended the respiratory
 * finding, so a patient whose blood pressure was still holding — the whole point
 * of a compensating patient — was announced as "comfortable, conversant" and only
 * then described as drowning. The reassuring half led the sentence, which is
 * exactly the wrong signal from the channel the game asks players to trust.
 *
 * Rules: the worse axis speaks first, and "comfortable" is reachable only when
 * both axes are clear.
 *
 * `baselineDrive` is the patient's own resting ventilatory drive. Work of
 * breathing is graded against it rather than against an absolute rate, because
 * the COPD patient who lives at 22 is not in distress at 22 and the young patient
 * who lives at 12 is in trouble at 24.
 */
export function assessAppearance(snap: Snapshot, baselineDrive = 0): Gestalt {
  if (snap.cardiovascularStatus === 'arrest') {
    return { wob: 3, perf: 3, sed: 3, text: 'unresponsive, no palpable pulse' };
  }

  // Pulmonary congestion is visible and audible at the bedside long before it is
  // hypoxemic — the patient will not lie flat, and the bases crackle.
  const congested = snap.pcwp > 22;
  const drowning = snap.pcwp > 28;

  // Breaths per minute above this patient's own resting rate. Effort is visible
  // from the doorway before any of it reaches the saturation probe, so grading
  // work of breathing on oxygenation alone reports a struggling patient as
  // comfortable — which is precisely the failure this axis exists to prevent.
  const excess = respiratoryDrive(snap) - baselineDrive;

  const wob: GestaltGrade =
    snap.spO2 < 0.85 || excess >= 15 ? 3 :
    snap.spO2 < 0.90 || drowning || excess >= 9 ? 2 :
    snap.spO2 < 0.93 || congested || excess >= 4 ? 1 :
    0;

  const perf: GestaltGrade =
    snap.map < 55 ? 3 :
    snap.map < 65 ? 2 :
    snap.map < 73 || snap.lactate > 3.5 ? 1 :
    0;

  const sed: GestaltGrade =
    snap.cnsDepression >= 0.85 ? 3 :
    snap.cnsDepression >= 0.6 ? 2 :
    snap.cnsDepression >= 0.35 ? 1 :
    0;

  if (wob === 0 && perf === 0 && sed === 0) {
    return { wob, perf, sed, text: 'comfortable and conversant, no distress' };
  }

  const breathing =
    wob === 3 ? (snap.spO2 < 0.85
      ? 'visibly cyanotic and exhausted, using every accessory muscle'
      : 'exhausted, using every accessory muscle, barely getting a word out') :
    wob === 2 ? (congested
      ? 'fighting for breath, bolt upright, coughing up pink froth'
      : 'working hard to breathe, managing only short phrases') :
    wob === 1 ? (congested
      ? "breathless and won't lie flat, crackles up both bases"
      : 'breathing faster than earlier, still talking in sentences') :
    null;

  const perfusion =
    perf === 3 ? 'mottled to the knees, clammy, barely arousable' :
    perf === 2 ? 'cool and diaphoretic, confused' :
    perf === 1 ? 'pale and tired, slow to answer' :
    null;

  // How much a patient says is a statement about how awake they are as well as
  // how breathless: someone drifting off mid-sentence is not "talking in
  // sentences", however fast they are breathing.
  //
  // And a patient breathing slowly is not "breathing faster than earlier" just
  // because the saturation has started to fall: in hypoventilation the low
  // saturation is the last sign, not a sign of effort. The slowness itself is
  // described with the sedation below.
  const breathingText =
    snap.rr < 10 && wob > 0 ? (snap.spO2 < 0.9 ? 'dusky' : null) :
    sed >= 2 && wob > 0 && wob < 3 && !congested
      ? (wob === 2 ? 'breathing hard and fast' : 'breathing faster than earlier')
      : breathing;

  // Slow breathing is described with the sedation, because that is where the
  // nurse sees it: a patient snoring at eight a minute is not working hard.
  const slow = snap.rr < 8 ? ', breathing slowly and snoring' : snap.rr < 10 ? ', breathing slowly' : '';
  const sedation =
    sed === 3 ? `rousable only to a sternal rub${slow}` :
    sed === 2 ? `very hard to wake, drifts off mid-sentence${slow}` :
    sed === 1 ? `drowsy but rousable to voice${slow}` :
    null;

  // The worse axis leads; ties go to breathing, then sedation, then perfusion.
  const ranked = [
    { grade: wob, text: breathingText, order: 0 },
    { grade: sed, text: sedation, order: 1 },
    { grade: perf, text: perfusion, order: 2 },
  ].sort((a, b) => b.grade - a.grade || a.order - b.order);
  return { wob, perf, sed, text: ranked.map((r) => r.text).filter(Boolean).join('; ') };
}

/** Prose-only convenience wrapper. */
export function describeAppearance(snap: Snapshot, baselineDrive = 0): string {
  return assessAppearance(snap, baselineDrive).text;
}

/**
 * A one-line triage label for the patient board.
 *
 * Restricted to what a monitor actually shows. Lactate is a send-away test, so
 * letting it color the dot would hand the player a result they never ordered —
 * and quietly undo the case where a septic patient looks fine on the numbers.
 */
export function acuityLabel(snap: Snapshot, baselineDrive = 0): 'ok' | 'watch' | 'unstable' | 'critical' {
  if (snap.cardiovascularStatus === 'arrest') return 'critical';
  if (snap.cardiovascularStatus === 'decompensating') return 'critical';
  if (snap.cardiovascularStatus === 'shock') return 'unstable';
  // A monitor shows the rate, so a slow one is visible too — and on a patient
  // whose saturation is being held up by oxygen it is the only number that moves.
  if (snap.rr < 6) return 'unstable';
  if (snap.map < 70 || snap.spO2 < 0.92 || snap.hr > 110 || snap.rr < 9) return 'watch';
  // The respiratory rate is on the monitor too, and it is the number that moves
  // first — a board that ignored it left a working patient showing green.
  if (respiratoryDrive(snap) - baselineDrive >= 6) return 'watch';
  return 'ok';
}

// ─── Labs ───────────────────────────────────────────────────────────────────

/**
 * Resolve a lab panel against the patient's physiology at the moment of the draw.
 *
 * Values that the engine models directly (lactate, pH, bicarbonate, PaO2) are read
 * from the snapshot. Values it does not model are derived from the closest
 * physiologic proxy so results stay internally consistent with the case.
 */
export function resolveLabPanel(
  panel: string,
  snap: Snapshot,
  params: HemodynamicParams,
  drawnAt: number,
  resultedAt: number,
  id: string,
  /**
   * The case's own findings, which take precedence over the generic reading
   * when the physiology behind them is present. See `PatientCase.findings`.
   */
  caseFindings?: (panel: string, snap: Snapshot) => string | null,
): LabResult {
  const base = { id, panel, drawnAt, resultedAt };
  const specific = caseFindings?.(panel, snap) ?? null;

  switch (panel) {
    case 'Lactate':
      return {
        ...base,
        values: [
          v('Lactate', snap.lactate, 'mmol/L', 1, { high: 2.0, critical: snap.lactate > 4 }),
        ],
      };

    case 'VBG': {
      const { pCO2: pvCO2, pH: venousPh } = venousGas(snap, params);
      return {
        ...base,
        values: [
          v('pH', venousPh, '', 2, { low: 7.32, high: 7.42, critical: venousPh < 7.2 }),
          v('pCO₂', pvCO2, 'mmHg', 0, { low: 41, high: 51, critical: pvCO2 > 75 }),
          v('HCO₃', snap.hco3, 'mEq/L', 0, { low: 22, high: 26 }),
          v('Base excess', snap.be, 'mEq/L', 0, { low: -2, high: 2 }),
          v('Lactate', snap.lactate, 'mmol/L', 1, { high: 2.0, critical: snap.lactate > 4 }),
        ],
      };
    }

    case 'ABG':
      return {
        ...base,
        values: [
          v('pH', snap.pH, '', 2, { low: 7.35, high: 7.45, critical: snap.pH < 7.2 }),
          v('PaO₂', snap.paO2, 'mmHg', 0, { low: 80, critical: snap.paO2 < 55 }),
          v('PaCO₂', snap.paCO2, 'mmHg', 0, { low: 35, high: 45, critical: snap.paCO2 > 70 }),
          v('HCO₃', snap.hco3, 'mEq/L', 0, { low: 22, high: 26 }),
          v('SaO₂', snap.spO2 * 100, '%', 0, { low: 94 }),
        ],
      };

    case 'CBC': {
      // Hgb is a parameter (transfusion raises it). WBC tracks inflammatory tone.
      const wbc = 7.5 + snap.noTone * 14;
      return {
        ...base,
        values: [
          v('WBC', wbc, 'K/µL', 1, { low: 4.0, high: 11.0 }),
          v('Hgb', params.hgb, 'g/dL', 1, { low: 12.0, critical: params.hgb < 7 }),
          v('Hct', params.hgb * 3, '%', 1, { low: 36 }),
          v('Platelets', Math.max(20, 240 - snap.noTone * 150), 'K/µL', 0, { low: 150 }),
        ],
      };
    }

    case 'BMP': {
      // Bicarbonate mirrors the acid-base model; creatinine rises with sustained
      // hypoperfusion (acute kidney injury from low renal perfusion pressure).
      const creat = 0.9 + Math.max(0, 75 - snap.map) * 0.022 + Math.max(0, snap.lactate - 2) * 0.06;
      return {
        ...base,
        values: [
          v('Sodium', 138, 'mEq/L', 0, { low: 135, high: 145 }),
          v('Potassium', 4.1 + Math.max(0, 7.35 - snap.pH) * 3.5, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
          v('Chloride', 102, 'mEq/L', 0, { low: 98, high: 107 }),
          v('CO₂', snap.hco3, 'mEq/L', 0, { low: 22, high: 29 }),
          v('BUN', 18 + Math.max(0, 75 - snap.map) * 0.5, 'mg/dL', 0, { low: 7, high: 20 }),
          v('Creatinine', creat, 'mg/dL', 2, { high: 1.2, critical: creat > 2.5 }),
        ],
      };
    }

    case 'Troponin': {
      // Demand ischemia: troponin leaks when coronary perfusion pressure falls or
      // contractility is impaired, so it rises in both MI and prolonged shock.
      const trop = 0.01
        + Math.max(0, 2.0 - snap.emaxEffective) * 0.9
        + Math.max(0, 65 - snap.map) * 0.02;
      return {
        ...base,
        values: [v('Troponin I', trop, 'ng/mL', 2, { high: 0.04, critical: trop > 1.0 })],
      };
    }

    case 'Ascitic fluid': {
      // The neutrophil count is what makes the diagnosis, and it tracks the
      // inflammatory tone that is driving the whole picture.
      const pmn = Math.round(60 + snap.noTone * 1900);
      const infected = pmn >= 250;
      return {
        ...base,
        values: [
          v('Ascitic PMN count', pmn, 'cells/mm³', 0, { high: 250, critical: infected }),
          v('Ascitic albumin', 0.9, 'g/dL', 1),
          v('Serum–ascites albumin gradient', 1.4, 'g/dL', 1, { low: 1.1 }),
        ],
        impression: infected
          ? 'Polymorphs above 250/mm³ — spontaneous bacterial peritonitis. Culture sent. ' +
            'Treat with antibiotics and albumin.'
          : 'Polymorphs below 250/mm³. No evidence of spontaneous bacterial peritonitis. Culture sent.',
      };
    }

    case 'MRI spine': {
      // Weakness is the finding that changes the night, and it tracks the
      // inflammatory burden driving the collection.
      const compressive = snap.noTone > 0.22;
      return {
        ...base,
        values: [],
        impression: compressive
          ? 'L5–S1 discitis with an enlarging anterior epidural abscess causing thecal sac compression. ' +
            'Surgical decompression should be discussed tonight.'
          : 'L5–S1 discitis with an epidural phlegmon, not significantly changed from the prior study. ' +
            'No drainable collection and no cord compression.',
      };
    }

    case 'Blood cultures':
      return {
        ...base,
        values: [],
        // A case that already knows what is growing says so. The generic read is
        // for the patient whose cultures were drawn tonight; a patient admitted
        // three days ago with an organism and sensitivities in the chart should
        // not have the microbiology lab report "no growth to date" back at the
        // one player who thought to look.
        impression: specific ?? (snap.noTone > 0.25
          ? 'Two sets drawn from separate sites. Gram stain pending; preliminary result in 12–24h.'
          : 'Two sets drawn from separate sites. No growth to date.'),
      };

    case 'EKG': {
      const rate = Math.round(snap.hr);
      const rhythm = snap.afib > 0.5
        ? (rate > 110 ? 'Atrial fibrillation with rapid ventricular response'
          : rate < 60 ? 'Atrial fibrillation with slow ventricular response'
          : 'Atrial fibrillation, rate controlled')
        : rate > 100 ? 'Sinus tachycardia' : rate < 60 ? 'Sinus bradycardia' : 'Normal sinus rhythm';
      const strain = snap.mPAP > 30 && snap.rvedv > 190
        ? ' Right axis deviation with S1Q3T3 pattern and anteroseptal T-wave inversions — RV strain.'
        : '';
      const ischemia = snap.emaxEffective < 1.2
        ? ' ST depressions in the lateral leads.'
        : '';
      // A case that can name its own tracing replaces the generic read rather than
      // adding to it: an inferior STEMI reported alongside "S1Q3T3, RV strain"
      // and "ST depressions laterally" is three different diagnoses in one line.
      const electrical = specific
        ? ` ${specific}`
        : `${strain}${ischemia}` || ' No acute ischemic changes.';
      return {
        ...base,
        values: [],
        impression: `${rhythm} at ${rate}.${electrical}`,
      };
    }

    case 'CXR': {
      const edema = snap.pcwp > 22
        ? 'Bilateral perihilar alveolar opacities with Kerley B lines and small effusions — pulmonary edema.'
        : snap.pcwp > 18
          ? 'Mild vascular congestion and cephalization.'
          : null;
      const hyperinflation = snap.qsQt > 0.18 && snap.pcwp < 18
        ? 'Hyperinflated lungs with flattened diaphragms. No focal consolidation.'
        : null;
      // Congestion is an orthogonal axis and coexists with anything — a pneumonia
      // patient in fluid overload has both, and reporting only one is how a player
      // ends up treating half the problem. The parenchymal read is not orthogonal,
      // so a case that names its own is not also told its lungs are clear.
      const parenchyma = specific ?? hyperinflation;
      const readings = [parenchyma, edema].filter(Boolean);
      return {
        ...base,
        values: [],
        impression: readings.length > 0
          ? readings.join(' ')
          : 'Clear lung fields. No consolidation, effusion, or pneumothorax.',
      };
    }

    case 'CT PE protocol': {
      // A large fixed PVR elevation with a normal wedge is the signature of
      // mechanical pulmonary arterial obstruction.
      const pe = snap.pvr > 4 && snap.pcwp < 18;
      return {
        ...base,
        values: [],
        impression: pe
          ? 'Large saddle embolus extending into both main pulmonary arteries. RV:LV diameter ratio 1.4 — right heart strain.'
          : 'No filling defect in the pulmonary arterial tree. No evidence of pulmonary embolism.',
      };
    }

    case 'Bedside echo': {
      const rvStrain = snap.rvedv > 190 && snap.mPAP > 28;
      const lvPoor = snap.emaxEffective < 1.1;
      let impression: string;
      if (rvStrain) {
        impression = 'Severely dilated, hypokinetic right ventricle with septal flattening (D-sign). LV underfilled but hyperdynamic.';
      } else if (lvPoor) {
        impression = 'Globally reduced LV systolic function, visually estimated EF 20–25%. Dilated LV. No pericardial effusion.';
      } else if (snap.edv < 85) {
        impression = 'Small, hyperdynamic, under-filled left ventricle with near-obliteration in systole. IVC collapses fully — volume responsive.';
      } else {
        impression = 'Normal biventricular size and function. No pericardial effusion.';
      }
      return { ...base, values: [], impression };
    }

    default:
      return { ...base, values: [], impression: specific ?? 'Result unavailable.' };
  }
}

/**
 * Venous gas from arterial physiology.
 *
 * Venous PCO2 sits above arterial by the CO2 the tissues add on the way
 * through, which by the Fick principle is VCO2 / CO: about 6 mmHg at a normal
 * output, and wider as flow falls. That widening gap is real and useful — a
 * shocked patient's venous gas looks more acidotic than their arterial one, and
 * a VBG read as if it were an ABG overstates the hypercapnia.
 */
export function venousGas(snap: Snapshot, params: HemodynamicParams): { pCO2: number; pH: number } {
  const gap = VA_CO2_GAP_K * (params.vo2 * params.rq) / Math.max(0.5, snap.co);
  const pCO2 = snap.paCO2 + Math.min(40, gap);
  return { pCO2, pH: 6.1 + Math.log10(snap.hco3 / (0.0307 * pCO2)) };
}

/** mmHg per (mL/min ÷ L/min): 6 mmHg venous–arterial gap at VCO2 200, CO 5. */
const VA_CO2_GAP_K = 0.15;

function v(
  label: string,
  value: number,
  unit: string,
  decimals: number,
  range: { low?: number; high?: number; critical?: boolean } = {},
): LabValue {
  return { label, value, unit, decimals, ...range };
}

/** True when a value falls outside its reference range. */
export function isAbnormal(lv: LabValue): boolean {
  if (lv.low !== undefined && lv.value < lv.low) return true;
  if (lv.high !== undefined && lv.value > lv.high) return true;
  return false;
}

// ─── Clock formatting ───────────────────────────────────────────────────────

/** Format sim-time (seconds since 19:00) as a 24-hour wall clock. */
export function clockTime(simSeconds: number): string {
  const total = SHIFT_START_HOUR * 3600 + simSeconds;
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/** Human-readable staleness, e.g. "14 min ago". */
export function ageLabel(seconds: number): string {
  if (seconds < 90) return 'just now';
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem === 0 ? `${h}h ago` : `${h}h ${rem}m ago`;
}
