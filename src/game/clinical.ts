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

/**
 * Ventilatory drive above rest, in breaths per minute.
 *
 * Four drives, matching how the receptors actually behave:
 *   - Metabolic acidosis → Kussmaul compensation, scaled off the bicarbonate
 *     deficit (Winter's-formula territory).
 *   - Hypoxemia → carotid body drive once SpO2 falls below ~92%.
 *   - Shunt load → the patient breathes harder to *defend* gas exchange. This is
 *     the term whose absence let a bronchospastic patient be charted at a resting
 *     rate: the model only saw the saturation, which is the outcome of the effort,
 *     and never the effort itself. Respiratory rate is the first vital sign to
 *     move in airway and parenchymal disease precisely because it moves before
 *     the saturation is allowed to fall.
 *   - Pulmonary congestion → J-receptor drive. A wet lung is stiff, and the
 *     patient breathes shallow and fast well before the number comes down.
 */
export function respiratoryDrive(snap: Snapshot): number {
  const metabolic = Math.max(0, 24 - snap.hco3) * 1.1;
  const hypoxic = Math.max(0, 0.92 - snap.spO2) * 90;
  const shunt = Math.max(0, snap.qsQtEffective - 0.04) * 55;
  const congestion = Math.max(0, snap.pcwp - 18) * 0.45;
  return metabolic + hypoxic + shunt + congestion;
}

/**
 * Respiratory rate.
 *
 * `rrOffset` is the chronic part of a given patient's rate — the COPD patient who
 * lives at 20 — and is carried by the case rather than derived, because nothing
 * in the model represents their years of remodelling.
 */
export function respiratoryRate(snap: Snapshot, rrOffset = 0): number {
  return Math.round(Math.min(45, 13 + rrOffset + respiratoryDrive(snap)));
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
    return { wob: 3, perf: 3, text: 'unresponsive, no palpable pulse' };
  }

  // Pulmonary congestion is visible and audible at the bedside long before it is
  // hypoxaemic — the patient will not lie flat, and the bases crackle.
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

  if (wob === 0 && perf === 0) {
    return { wob, perf, text: 'comfortable and conversant, no distress' };
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
    perf === 3 ? 'mottled to the knees, clammy, barely rousable' :
    perf === 2 ? 'cool and diaphoretic, confused' :
    perf === 1 ? 'pale and tired, slow to answer' :
    null;

  // The worse axis leads; ties go to breathing, which is the more visible.
  const parts = wob >= perf ? [breathing, perfusion] : [perfusion, breathing];
  return { wob, perf, text: parts.filter(Boolean).join('; ') };
}

/** Prose-only convenience wrapper. */
export function describeAppearance(snap: Snapshot, baselineDrive = 0): string {
  return assessAppearance(snap, baselineDrive).text;
}

/**
 * A one-line triage label for the patient board.
 *
 * Restricted to what a monitor actually shows. Lactate is a send-away test, so
 * letting it colour the dot would hand the player a result they never ordered —
 * and quietly undo the case where a septic patient looks fine on the numbers.
 */
export function acuityLabel(snap: Snapshot, baselineDrive = 0): 'ok' | 'watch' | 'unstable' | 'critical' {
  if (snap.cardiovascularStatus === 'arrest') return 'critical';
  if (snap.cardiovascularStatus === 'decompensating') return 'critical';
  if (snap.cardiovascularStatus === 'shock') return 'unstable';
  if (snap.map < 70 || snap.spO2 < 0.92 || snap.hr > 110) return 'watch';
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
): LabResult {
  const base = { id, panel, drawnAt, resultedAt };

  switch (panel) {
    case 'Lactate':
      return {
        ...base,
        values: [
          v('Lactate', snap.lactate, 'mmol/L', 1, { high: 2.0, critical: snap.lactate > 4 }),
        ],
      };

    case 'VBG':
      return {
        ...base,
        values: [
          v('pH', snap.pH, '', 2, { low: 7.32, high: 7.42, critical: snap.pH < 7.2 }),
          v('pCO₂', params.paCO2 + params.co2RetentionGain * Math.max(0, params.co2RetentionCoRef - snap.co), 'mmHg', 0, { low: 41, high: 51 }),
          v('HCO₃', snap.hco3, 'mEq/L', 0, { low: 22, high: 26 }),
          v('Base excess', snap.be, 'mEq/L', 0, { low: -2, high: 2 }),
          v('Lactate', snap.lactate, 'mmol/L', 1, { high: 2.0, critical: snap.lactate > 4 }),
        ],
      };

    case 'ABG':
      return {
        ...base,
        values: [
          v('pH', snap.pH, '', 2, { low: 7.35, high: 7.45, critical: snap.pH < 7.2 }),
          v('PaO₂', snap.paO2, 'mmHg', 0, { low: 80, critical: snap.paO2 < 55 }),
          v('PaCO₂', params.paCO2 + params.co2RetentionGain * Math.max(0, params.co2RetentionCoRef - snap.co), 'mmHg', 0, { low: 35, high: 45 }),
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

    case 'Blood cultures':
      return {
        ...base,
        values: [],
        impression: snap.noTone > 0.25
          ? 'Two sets drawn from separate sites. Gram stain pending; preliminary result in 12–24h.'
          : 'Two sets drawn from separate sites. No growth to date.',
      };

    case 'EKG': {
      const rate = Math.round(snap.hr);
      const rhythm = rate > 100 ? 'Sinus tachycardia' : rate < 60 ? 'Sinus bradycardia' : 'Normal sinus rhythm';
      const strain = snap.mPAP > 30 && snap.rvedv > 190
        ? ' Right axis deviation with S1Q3T3 pattern and anteroseptal T-wave inversions — RV strain.'
        : '';
      const ischemia = snap.emaxEffective < 1.2
        ? ' ST depressions in the lateral leads.'
        : '';
      return {
        ...base,
        values: [],
        impression: `${rhythm} at ${rate}.${strain}${ischemia}${!strain && !ischemia ? ' No acute ischemic changes.' : ''}`,
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
      return {
        ...base,
        values: [],
        impression: edema ?? hyperinflation ?? 'Clear lung fields. No consolidation, effusion, or pneumothorax.',
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
      return { ...base, values: [], impression: 'Result unavailable.' };
  }
}

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
