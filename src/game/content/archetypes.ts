import type {
  CaseEvent, CodeStatus, HandoffSeverity, InheritedMed, InterventionSpec,
  LabValue, PriorLab, Setting,
} from '../types';
import type { Snapshot } from '../../engine/types';
import type { Rng } from './rng';
import type { Voice } from './voice';
import { bloodLossScale, insultScale, lerp, onsetScale, varyAxis, type Severity } from './severity';

const MIN = 60;
const HOUR = 3600;

/**
 * Everything an archetype needs to know about the person it has been assigned to.
 * The clinical content is written against this rather than against a fixed
 * patient, which is the whole point of the split.
 */
export interface ArchetypeContext {
  /** Continuous, 0 (mildest form worth paging about) to 1 (as bad as it gets). */
  severity: Severity;
  rng: Rng;
  voice: Voice;
  name: string;
  room: string;
  age: number;
  /** Sim-time at which this case first declares itself. */
  declareAt: number;
}

/** The raw material of a handoff, before quality is applied to it. */
export interface HandoffDraft {
  severityCall: HandoffSeverity;
  summary: string;
  todo: string[];
  /** Everything a conscientious day team would have written down. */
  contingencies: string[];
  /**
   * Guidance that is confidently wrong. Used when the handoff is merely adequate:
   * a day team who has anchored on the wrong diagnosis writes fluent, specific,
   * misleading advice, which is more dangerous than writing nothing.
   */
  misleading?: string;
}

export interface CaseArchetype {
  /** Stable identifier. Tests reference this, never a patient name. */
  id: string;
  label: string;
  /**
   * How much trouble this case can cause, used to compose a balanced ward.
   * 'benign' never deteriorates; 'critical' can kill within the shift.
   */
  tier: 'benign' | 'ward' | 'critical';
  ageRange: [number, number];
  /**
   * Which service this case turns up on. Omitted means both.
   *
   * `academic` cases are not harder community cases — they are diseases a
   * community hospital transfers out rather than admits, and they carry their own
   * physiology and their own traps.
   */
  setting?: Setting;
  /**
   * How often this case turns up, relative to others in its tier. Default 1.
   *
   * For diseases that are real but uncommon as an overnight event. A patient with
   * pulmonary arterial hypertension whose right ventricle fails for the first time
   * on your shift is a night you remember, not a night you have regularly.
   */
  weight?: number;
  /** Sim-seconds from declaring to the last scripted beat. */
  span: number;
  admissionDx: string;
  hiddenDx: string;
  teachingPoint: string;
  history(ctx: ArchetypeContext): string[];
  codeStatus?(ctx: ArchetypeContext): CodeStatus;
  baseline(ctx: ArchetypeContext): {
    stateOverrides?: Record<string, number>;
    paramOverrides?: Record<string, number>;
    tempOffset?: number;
    /**
     * The non-pulmonary part of this patient's resting respiratory rate — pain,
     * frailty, deconditioning, anxiety.
     *
     * Deliberately not the pulmonary part: shunt and congestion drive ventilation
     * in the model now, so an archetype that sets a baseline `qsQt` is already
     * getting the tachypnoea that goes with it. Carrying both counted the lung
     * twice and handed patients over at rates the day team would not have.
     */
    rrOffset?: number;
  };
  script(ctx: ArchetypeContext): CaseEvent[];
  /**
   * What this case shows on a diagnostic study, once the physiology is there.
   *
   * Gated on the snapshot rather than on the diagnosis, so a film taken before
   * the lung drops is genuinely clear and one taken after shows the collapse.
   *
   * `atHandover` is the patient's own physiology at 19:00 — the comparison film.
   * Findings that describe a *change* have to be written against it rather than
   * against an absolute, because a patient admitted with a drained pneumothorax
   * or a treated pneumonia does not start from a normal lung.
   */
  findings?(
    ctx: ArchetypeContext,
    atHandover: Snapshot,
  ): (panel: string, snap: Snapshot) => string | null;
  handoff(ctx: ArchetypeContext): HandoffDraft;
  /** What the day team already has running. */
  medications?(ctx: ArchetypeContext): InheritedMed[];
  /** Results the day team already has, from earlier today. */
  priorLabs?(ctx: ArchetypeContext): PriorLab[];
  expectedOrders: string[];
  contraindicatedOrders?: string[];
}

// ─── Scaling helpers ────────────────────────────────────────────────────────

/**
 * Scale an insult by the case's severity, with its own draw around it.
 *
 * Each insult varies independently, so a sepsis can arrive with marked vasoplegia
 * and modest third-spacing, or the reverse, at the same overall severity. That
 * per-axis spread is what makes two instances of the same archetype present as
 * different patients rather than the same one twice.
 */
function insult(ctx: ArchetypeContext, spec: InterventionSpec): InterventionSpec {
  const axis = varyAxis(ctx.rng, ctx.severity);
  return {
    ...spec,
    delta: spec.delta * insultScale(axis),
    tauOn: spec.tauOn * onsetScale(axis),
  };
}

/**
 * A starting value interpolated across the severity range.
 * Archetypes state the mildest and worst forms; everything between is real.
 */
function bySeverity(ctx: ArchetypeContext, atMild: number, atSevere: number): number {
  return lerp(ctx.severity, atMild, atSevere);
}

/** As `bySeverity`, rounded — for volumes and rates that are charted as integers. */
function bySeverityInt(ctx: ArchetypeContext, atMild: number, atSevere: number): number {
  return Math.round(bySeverity(ctx, atMild, atSevere));
}

/** A result the day team already has, timed relative to the start of the shift. */
function prior(panel: string, minutesBefore: number, values: LabValue[], impression?: string): PriorLab {
  return { panel, minutesBefore, values, impression };
}

/** One analyte on an inherited result. */
function pv(
  label: string,
  value: number,
  unit: string,
  decimals = 1,
  range: { low?: number; high?: number; critical?: boolean } = {},
): LabValue {
  return { label, value, unit, decimals, ...range };
}

/** Jitter a scripted time so repeat plays don't share a metronome. */
function jitter(ctx: ArchetypeContext, base: number, spread = 8 * MIN): number {
  return Math.max(0, base + ctx.rng.int(-spread, spread));
}

// ─── The library ────────────────────────────────────────────────────────────

export const ARCHETYPES: CaseArchetype[] = [
  {
    id: 'urosepsis',
    label: 'Urosepsis',
    tier: 'critical',
    ageRange: [66, 89],
    span: 3 * HOUR,
    admissionDx: 'Pyelonephritis, on ceftriaxone',
    hiddenDx: 'Gram-negative urosepsis progressing to septic shock',
    teachingPoint:
      'Septic shock is a distributive problem: the cardiac output is high and the vascular tone is gone. ' +
      'Fluids and source control reverse it; waiting for the blood pressure to declare itself does not. ' +
      'Antibiotics take hours to work, so the clock that matters starts at the first abnormal vital sign.',
    history: (ctx) => ctx.rng.sample(
      ['Type 2 diabetes', 'CKD stage 3', 'Recurrent UTIs', 'Hypertension', 'Previous urosepsis', 'Neurogenic bladder'],
      3,
    ),
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(78, 90),
        svr: 15.5,
        edv: ctx.rng.int(102, 114),
        noTone: bySeverity(ctx, 0.05, 0.21),
      },
      rrOffset: 4,
      tempOffset: bySeverity(ctx, 0, 0.28),
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          // The fever is real at the moment it is charted, so this one goes out on
          // schedule; what it must not do is claim a patient who looks unwell.
          page: `Sorry to bother you — ${ctx.name} in ${ctx.room} has spiked a temperature. ` +
            `Observations are otherwise not far off, but ${v.subj} ${v.verb('seem')} a bit flat to me.`,
          interventions: [
            insult(ctx, { label: 'Sepsis: inflammatory tone', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.25, tauOn: 900, eliminationHalfLife: 36000 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 80 * MIN),
          pageWhen: { axis: 'perf', grade: 1 },
          page: (g) => g.perf >= 2
            ? `${v.Subj} ${v.is} confused now — ${v.subj} ${v.isnt} sure where ${v.subj} ${v.is}. ` +
              `The pressure is down and the heart rate is up. I'm worried about ${v.obj}.`
            : g.perf >= 1
            ? `${v.Subj} ${v.verb('look')} washed out and ${v.subj} ${v.is} slower to answer than earlier. ` +
              `The pressure has drifted down a little. Nothing dramatic, but it is not the direction I want.`
            : `${v.Subj} ${v.verb('seem')} a bit brighter than earlier and the observations are reasonable. ` +
              `Still not eating, though.`,
          interventions: [
            insult(ctx, { label: 'Sepsis: vasoplegia', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.28, tauOn: 1200, eliminationHalfLife: 36000 }),
            insult(ctx, { label: 'Sepsis: third-spacing', category: 'scenario', kind: 'scenario', target: 'edv', delta: -22, tauOn: 1800, eliminationHalfLife: 36000 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 170 * MIN),
          pageWhen: { axis: 'perf', grade: 2 },
          page: (g) => g.perf >= 3
            ? `${v.Subj} ${v.is} mottled up to the knees and barely rousable. I need someone up here.`
            : g.perf >= 2
            ? `${v.Subj} ${v.is} cold to the elbows and I can barely get a pressure sitting ${v.obj} up. ` +
              `Can you come and look at ${v.obj}?`
            : `I'm still not happy with ${v.obj}. ${v.Subj} ${v.is} quiet in ${v.obj}self and the ` +
              `pressure has not come back up. Nothing alarming on the numbers.`,
          interventions: [
            insult(ctx, { label: 'Sepsis: progression', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.3, tauOn: 1800, eliminationHalfLife: 36000 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary: `Pyelonephritis, day 2 of ceftriaxone. Afebrile most of today, eating and drinking. Likely home tomorrow.`,
      todo: ['Chase the urine culture in the morning.'],
      contingencies: [
        `If ${ctx.voice.subj} ${ctx.voice.verb('spike')} again, send cultures and a lactate before the next antibiotic dose.`,
        `${ctx.voice.Subj} ${ctx.voice.has} CKD — be careful with the aminoglycosides, but do not let that delay fluids.`,
      ],
    }),
    medications: (ctx) => [
      { name: 'Ceftriaxone', detail: '1 g IV daily', since: `day ${ctx.rng.int(2, 3)} of 7` },
      { name: 'Paracetamol', detail: '1 g orally every 6 hours as needed', since: 'admission' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily — VTE prophylaxis', since: 'admission' },
      { name: 'Maintenance fluids', detail: 'saline at 75 mL/h', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 540, [
        pv('WBC', bySeverity(ctx, 12.8, 17.4), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 11.6, 'g/dL', 1, { low: 12 }),
        pv('Platelets', 268, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('BMP', 540, [
        pv('Creatinine', bySeverity(ctx, 1.3, 1.9), 'mg/dL', 2, { high: 1.1 }),
        pv('Urea', bySeverityInt(ctx, 24, 38), 'mg/dL', 0, { high: 20 }),
        pv('Sodium', 136, 'mEq/L', 0, { low: 135, high: 145 }),
      ]),
      prior('Urine culture', 2160, [], 'Escherichia coli, >10⁵ cfu/mL. Sensitive to ceftriaxone and nitrofurantoin; resistant to trimethoprim.'),
    ],
    expectedOrders: ['vitals-now', 'lab-lactate', 'lab-cultures', 'ceftriaxone', 'ns-1000', 'transfer-icu'],
    contraindicatedOrders: ['furosemide', 'trazodone'],
  },

  {
    id: 'pneumonia-sepsis',
    label: 'Pneumonia with sepsis',
    tier: 'critical',
    ageRange: [58, 84],
    span: 3 * HOUR,
    admissionDx: 'Community-acquired pneumonia',
    hiddenDx: 'Progressive pneumonia with septic shock and worsening hypoxaemia',
    teachingPoint:
      'Sepsis from the lung is two problems at once: vasodilatory shock and a widening shunt. ' +
      'Treating only the oxygenation leaves the perfusion failing, and treating only the perfusion ' +
      'leaves a patient who tires and needs a tube. Escalate for both.',
    history: (ctx) => ctx.rng.sample(
      ['COPD', 'Type 2 diabetes', 'Current smoker', 'Alcohol use disorder', 'Previous pneumonia', 'Atrial fibrillation'],
      3,
    ),
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(84, 96),
        svr: 15,
        edv: ctx.rng.int(100, 112),
        qsQt: bySeverity(ctx, 0.06, 0.14),
        // Warm sepsis at handover, but a patient a day team would leave on a
        // ward: the inflammatory tone the case adds is what takes them off it.
        noTone: bySeverity(ctx, 0.06, 0.18),
      },
      rrOffset: 4,
      tempOffset: 0.3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'either', grade: 1 },
          page: (g) => g.wob >= 2 || g.perf >= 2
            ? `${ctx.name} in ${ctx.room} is working harder to breathe and the saturations have come down. ` +
              `${v.Subj} ${v.is} warm to touch and the pressure is softer than it was.`
            : g.wob >= 1 || g.perf >= 1
            ? `${ctx.name} in ${ctx.room} is breathing a bit faster than earlier and ${v.is} warm to touch. ` +
              `Saturations are holding for now. Wanted you to know before it gets away from us.`
            : `${ctx.name} in ${ctx.room} is warm to touch and hasn't eaten this evening. ` +
              `Observations are unremarkable, but ${v.subj} ${v.verb('seem')} off to me.`,
          interventions: [
            insult(ctx, { label: 'Pneumonia: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.12, tauOn: 1800, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'Pneumonia: sepsis', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.3, tauOn: 1800, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 110 * MIN),
          pageWhen: { axis: 'either', grade: 2 },
          page: (g) => g.perf >= 2
            ? `Getting worse. ${v.Subj} ${v.verb('look')} exhausted and I can barely get a pressure.`
            : g.wob >= 2
            ? `Getting worse — ${v.subj} ${v.is} tiring with the breathing and only managing short sentences now.`
            : `Still febrile and the oxygen requirement has not come down. ${v.Subj} ${v.verb('look')} tired, ` +
              `but ${v.subj} ${v.is} holding ${v.poss} own for the moment.`,
          interventions: [
            insult(ctx, { label: 'Sepsis: progression', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.28, tauOn: 2400, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'Pneumonia: shunt↑↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.07, tauOn: 2400, eliminationHalfLife: 43200 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: ctx.rng.chance(0.5) ? 'watcher' : 'stable',
      summary: 'Community-acquired pneumonia, day 2 of antibiotics. Oxygen requirement has crept up through the afternoon.',
      todo: ['Repeat the inflammatory markers in the morning.'],
      contingencies: [
        'If the oxygen requirement climbs further, get a gas and think about non-invasive ventilation early.',
        'If the pressure softens, this is sepsis until proven otherwise — fluids and a lactate, do not wait for the morning.',
      ],
    }),
    findings: (_ctx, atHandover) => (panel, snap) => {
      if (panel !== 'CXR') return null;
      // They were admitted with a pneumonia, so the film is never clean; what the
      // study answers is whether it has spread since the last one.
      const spread = snap.qsQtEffective - atHandover.qsQtEffective;
      if (spread > 0.06) return 'Dense multilobar consolidation with air bronchograms and a moderate parapneumonic effusion — progressed from the admission film.';
      if (spread > 0.02) return 'Right lower lobe consolidation with air bronchograms, more confluent than on admission.';
      return 'Right lower lobe consolidation with air bronchograms, unchanged from the admission film.';
    },
    medications: (ctx) => [
      { name: ctx.rng.pick(['Ceftriaxone and azithromycin', 'Co-amoxiclav and clarithromycin']), detail: 'IV, community-acquired pneumonia cover', since: `day ${ctx.rng.int(1, 3)} of 5` },
      { name: 'Paracetamol', detail: '1 g orally every 6 hours as needed', since: 'admission' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 480, [
        pv('WBC', bySeverity(ctx, 14.2, 21.6), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 12.1, 'g/dL', 1, { low: 12 }),
        pv('Platelets', 244, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('Lactate', 420, [pv('Lactate', bySeverity(ctx, 1.8, 2.9), 'mmol/L', 1, { high: 2.0 })]),
      prior('Blood cultures', 1200, [], 'No growth to date, 12 hours.'),
    ],
    expectedOrders: ['vitals-now', 'lab-lactate', 'ceftriaxone', 'ns-1000', 'o2-nc6', 'transfer-icu'],
    contraindicatedOrders: ['furosemide', 'morphine-comfort'],
  },

  {
    id: 'adhf-mislabelled',
    label: 'Decompensated heart failure, labelled COPD',
    tier: 'critical',
    ageRange: [62, 86],
    span: 2 * HOUR,
    admissionDx: 'COPD exacerbation',
    hiddenDx: 'Acute decompensated heart failure with flash pulmonary oedema — mislabelled as COPD',
    teachingPoint:
      'The admission diagnosis is a hypothesis, not a fact. This is cardiogenic pulmonary oedema: a high wedge ' +
      'floods alveoli and creates true shunt, which is why oxygen alone barely helps. Preload reduction — nitrates, ' +
      'diuresis, positive pressure — fixes the oxygenation because it fixes the pressure. A fluid bolus makes it worse.',
    history: (ctx) => [
      'COPD',
      ctx.rng.pick(['Prior anterior MI (EF 30%)', 'Ischaemic cardiomyopathy (EF 25%)', 'Prior inferior MI (EF 35%)']),
      ...ctx.rng.sample(['Hypertension', 'Atrial fibrillation', 'Type 2 diabetes', 'Chronic kidney disease'], 2),
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(82, 94),
        svr: 16.5,
        emax: bySeverity(ctx, 1.45, 1.16),
        edv: bySeverityInt(ctx, 142, 158),
        qsQt: 0.05,
      },
      // Eccentric remodelling: a chronically dilated ventricle lives at volumes
      // that would flatten a normal one, so its overdistension threshold is raised.
      // It scales with severity because the more advanced the cardiomyopathy, the
      // more dilated and the more volume-tolerant the ventricle already is — without
      // that, a severe case starts further up the curve and falls off it immediately.
      paramOverrides: { edvCritBase: bySeverity(ctx, 370, 490) },
      rrOffset: 6,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${ctx.name} in ${ctx.room} is short of breath. The saturations are down and ${v.subj} ${v.isnt} ` +
              `tolerating lying flat. Sounds junky in both bases to me.`
            : g.wob >= 1
            ? `${ctx.name} in ${ctx.room} has asked for another pillow and ${v.isnt} settling. ` +
              `Breathing faster than earlier, and it sounds junky at both bases.`
            : `${ctx.name} in ${ctx.room} has asked for another pillow and ${v.isnt} settling. ` +
              `Observations are fine. It sounds a little junky at the bases to me.`,
          interventions: [
            // Severity is deliberately NOT applied to the contractility hit.
            // Filling pressure goes as EDV/emax, so scaling both compounds into a
            // squared effect: a severe case reached a wedge of 50 against 35 for a
            // moderate one and became unsurvivable however fast it was treated.
            // Scaling volume alone is also the truer mechanism — flash oedema is a
            // preload and afterload redistribution event, not an acute loss of
            // contractility.
            { label: 'ADHF: contractility↓', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.3, tauOn: 1800 * onsetScale(ctx.severity), eliminationHalfLife: 36000 },
            insult(ctx, { label: 'ADHF: volume overload', category: 'scenario', kind: 'scenario', target: 'edv', delta: 34, tauOn: 2400, eliminationHalfLife: 36000 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 80 * MIN),
          pageWhen: { axis: 'wob', grade: 2 },
          page: (g) => g.wob >= 3
            ? `Worse — bolt upright, and ${v.subj} ${v.is} coughing up pink froth. I've put ${v.obj} on a non-rebreather.`
            : g.wob >= 2
            ? `Worse — ${v.subj} ${v.verb('want')} to sit right forward and ${v.subj} can't finish a sentence. ` +
              `I've turned the oxygen up.`
            : `${v.Subj} ${v.is} propped right up on four pillows now and ${v.subj} ${v.verb('say')} ${v.subj} ` +
              `${v.verb('breathe')} easier that way. The numbers are much the same.`,
          interventions: [
            insult(ctx, { label: 'Flash oedema', category: 'scenario', kind: 'scenario', target: 'edv', delta: 26, tauOn: 900, eliminationHalfLife: 36000 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `COPD exacerbation, day 1 of prednisone and scheduled nebulisers. Now needing 2L, which is new for ${ctx.voice.obj} — ` +
        `normally on room air at home. Net positive ${ctx.rng.real(1.8, 3.1).toFixed(1)} litres since admission.`,
      todo: ['Scheduled nebulisers are due at 22:00 and 04:00.', 'Morning chest film if no better.'],
      contingencies: [
        'The weight is up and the oxygen requirement is new — if the chest film looks wet, treat the heart rather than the airways.',
      ],
      misleading: 'If the saturations drop, turn the oxygen up and give a PRN nebuliser.',
    }),
    findings: () => (panel) =>
      panel === 'CXR' ? 'Cardiomegaly with an enlarged cardiac silhouette.' : null,
    medications: (ctx) => [
      { name: 'Furosemide', detail: `${ctx.rng.pick(['40 mg', '80 mg'])} IV twice daily`, since: 'day 2 of admission' },
      { name: ctx.rng.pick(['Bisoprolol', 'Carvedilol', 'Metoprolol succinate']), detail: 'oral, continued at home dose', since: 'home medication' },
      { name: 'Ramipril', detail: '5 mg orally daily', since: 'home medication' },
      { name: 'Spironolactone', detail: '25 mg orally daily', since: 'home medication' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('BNP', 600, [pv('NT-proBNP', bySeverityInt(ctx, 1800, 6200), 'pg/mL', 0, { high: 300, critical: true })]),
      prior('BMP', 600, [
        pv('Creatinine', bySeverity(ctx, 1.2, 1.7), 'mg/dL', 2, { high: 1.1 }),
        pv('Potassium', 3.9, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
        pv('Sodium', bySeverityInt(ctx, 137, 132), 'mEq/L', 0, { low: 135, high: 145 }),
      ]),
      prior('Troponin', 600, [pv('Troponin I', 0.06, 'ng/mL', 2, { high: 0.04 })]),
    ],
    expectedOrders: ['nitro', 'furosemide', 'bipap', 'img-cxr', 'img-echo', 'sit-up'],
    contraindicatedOrders: ['ns-500', 'ns-1000', 'prbc'],
  },

  {
    id: 'pulmonary-embolism',
    label: 'Pulmonary embolism',
    tier: 'critical',
    ageRange: [38, 74],
    span: 50 * MIN,
    admissionDx: 'Post-operative, day 2 — pain control',
    hiddenDx: 'Massive pulmonary embolism with right ventricular failure',
    teachingPoint:
      'Sudden hypoxaemia with hypotension and a clear chest is obstructive shock until proven otherwise. ' +
      'The failing ventricle is the right one: pressure-overloaded, dilating, bowing the septum into the LV. ' +
      'Volume makes RV failure worse. The treatment is to unload it — anticoagulation, and lysis if unstable.',
    history: (ctx) => [
      ctx.rng.pick(['Obesity', 'Recent long-haul travel', 'Previous DVT', 'Active malignancy']),
      ...ctx.rng.sample(['Osteoarthritis', 'Hypertension', 'Smoker', 'Hormone therapy', 'Immobility'], 2),
    ],
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(74, 86), svr: 14.5, edv: ctx.rng.int(120, 134) },
      rrOffset: 3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          // A pulmonary embolus loads the RV in minutes, so this one arrives fast —
          // but it still waits for the patient rather than for the clock.
          pageWhen: { axis: 'either', grade: 1, by: 10 * MIN },
          page: (g) => g.wob >= 2 || g.perf >= 2
            ? `Rapid one — ${ctx.room} just got back from the bathroom and ${v.subj} can't catch ${v.poss} breath. ` +
              `Saturations have dropped right off and the heart rate is up. ${v.Subj} ${v.verb('say')} it hurts to breathe in.`
            : `${ctx.room} came back from the bathroom short of breath and ${v.subj} ${v.is} not settling. ` +
              `Breathing faster than ${v.poss} usual, and ${v.subj} ${v.verb('say')} it hurts to breathe in.`,
          interventions: [
            insult(ctx, { label: 'PE: PVR↑', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 5.5, tauOn: 240, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'PE: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.22, tauOn: 240, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 45 * MIN, 5 * MIN),
          pageWhen: { axis: 'either', grade: 2 },
          page: (g) => g.perf >= 2
            ? `The pressure is dropping. ${v.Subj} ${v.is} grey, and ${v.subj} ${v.verb('keep')} telling me ${v.subj} ${v.is} going to die.`
            : g.wob >= 2
            ? `${v.Subj} ${v.is} working much harder now and the oxygen is not touching it. ` +
              `${v.Subj} ${v.verb('keep')} telling me ${v.subj} ${v.is} going to die.`
            : `${v.Subj} ${v.is} no better and ${v.subj} ${v.verb('keep')} telling me ${v.subj} ${v.is} going to die. ` +
              `I can't put my finger on it from the observations, but ${v.subj} ${v.is} frightened.`,
          interventions: [
            insult(ctx, { label: 'PE: clot propagation', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 2.2, tauOn: 2400, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'PE: RV failure', category: 'scenario', kind: 'scenario', target: 'rvEmax', delta: -0.1, tauOn: 2400, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    handoff: () => ({
      severityCall: 'stable',
      summary: `Day 2 after surgery. Routine recovery. Was for discharge today, held back for pain control.`,
      todo: [
        'Oxycodone is written as required — nothing else outstanding.',
        `Enoxaparin has been held since yesterday because of the wound haematoma. Surgery to review in the morning.`,
      ],
      contingencies: [
        'Prophylaxis has been off for 24 hours. If anything acute happens to the chest overnight, think embolus first.',
      ],
    }),
    findings: () => (panel, snap) => {
      if (panel !== 'EKG') return null;
      // Before the RV is frankly strained the only electrical sign is the rate
      // and some anterior T-wave change — which is exactly why a normal-looking
      // EKG does not exclude this and the CT does.
      if (snap.mPAP > 22 && snap.mPAP <= 30) return 'T-wave inversion in V1–V3.';
      return null;
    },
    medications: () => [
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily — prophylactic dose only', since: 'admission' },
      { name: 'Paracetamol', detail: '1 g orally every 6 hours as needed', since: 'admission' },
      { name: 'Oxycodone', detail: '5 mg orally every 4 hours as needed', since: 'admission' },
    ],
    priorLabs: () => [
      prior('CBC', 660, [
        pv('WBC', 8.4, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 12.8, 'g/dL', 1, { low: 12 }),
        pv('Platelets', 232, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('BMP', 660, [
        pv('Creatinine', 0.9, 'mg/dL', 2, { high: 1.1 }),
        pv('Sodium', 139, 'mEq/L', 0, { low: 135, high: 145 }),
      ]),
    ],
    expectedOrders: ['o2-nrb', 'img-echo', 'heparin', 'transfer-icu', 'thrombolysis', 'img-ctpe'],
    contraindicatedOrders: ['ns-1000', 'furosemide'],
  },

  {
    id: 'gi-bleed',
    label: 'Upper GI bleed',
    tier: 'critical',
    ageRange: [45, 82],
    span: 3 * HOUR,
    admissionDx: 'Upper GI bleed — melaena',
    hiddenDx: 'Rebleeding peptic ulcer causing haemorrhagic shock',
    teachingPoint:
      'Haemorrhagic shock is a volume problem, and the only definitive treatments are blood and haemostasis. ' +
      'A vasopressor raises the pressure by squeezing an empty tank — the number improves while the tissue perfusion ' +
      'does not. Tachycardia and a narrowing pulse pressure precede hypotension by a long way.',
    history: (ctx) => [
      ctx.rng.pick(['Peptic ulcer disease', 'Previous variceal bleed', 'H. pylori, untreated']),
      ...ctx.rng.sample(['Daily NSAIDs for back pain', 'Alcohol use disorder', 'Anticoagulated for AF', 'Cirrhosis', 'Aspirin'], 2),
    ],
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(90, 100), svr: 13, edv: ctx.rng.int(100, 110) },
      paramOverrides: { hgb: bySeverity(ctx, 10.9, 8.7) },
      rrOffset: 4,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.room} has had another melaenic stool, a big one. ${v.Subj} ${v.is} a bit tachycardic but the pressure is holding.`,
          interventions: [
            insult(ctx, { label: 'GI bleed: volume loss', category: 'scenario', kind: 'scenario', target: 'edv', delta: -20, tauOn: 900, eliminationHalfLife: 86400 }),
          ],
          hgbDelta: -1.2 * bloodLossScale(ctx.severity),
        },
        {
          at: jitter(ctx, ctx.declareAt + 160 * MIN),
          urgent: true,
          page: (g) => `${v.Subj} ${v.is} bleeding again — the bed is soaked and it's frank blood this time. ` +
            (g.perf >= 2 ? `${v.Subj} ${v.is} pale and clammy.`
              : g.perf >= 1 ? `${v.Subj} ${v.verb('look')} washed out and the heart rate is up.`
              : `${v.Subj} ${v.verb('look')} well enough in ${v.obj}self, but that was a lot of blood.`),
          interventions: [
            // A rebleeding ulcer oozes over hours. Blood takes half an hour to
            // arrive from the bank, and the player needs a patient when it does.
            insult(ctx, { label: 'GI rebleed', category: 'scenario', kind: 'scenario', target: 'edv', delta: -34, tauOn: 4500, eliminationHalfLife: 86400 }),
          ],
          hgbDelta: -2.2 * bloodLossScale(ctx.severity),
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Upper GI bleed, presumed peptic ulcer. Two units in the emergency department, haemoglobin came up and has held all afternoon. ` +
        `Pantoprazole infusion running. GI plan to scope in the morning.`,
      todo: [
        'Repeat haemoglobin at 06:00.',
        'Nil by mouth from midnight for the endoscopy.',
        `${ctx.voice.Subj} ${ctx.voice.has} two large-bore cannulae — please keep them patent.`,
      ],
      contingencies: [
        'If there is another large melaena or frank blood, send a crossmatch and transfuse to a haemoglobin of 7.',
        'If the heart rate climbs or the pressure drops, call the GI fellow overnight rather than waiting for the morning list — do not sit on it.',
        `${ctx.voice.Subj} will not tolerate being scoped on the ward. If bleeding actively, ${ctx.voice.subj} ${ctx.voice.verb('need')} a monitored bed first.`,
      ],
    }),
    medications: () => [
      { name: 'Pantoprazole', detail: '8 mg/h continuous infusion', since: 'admission' },
      { name: 'Ondansetron', detail: '4 mg IV every 8 hours as needed', since: 'admission' },
      { name: 'Maintenance fluids', detail: 'saline at 100 mL/h', since: 'admission' },
      { name: 'Nil by mouth', detail: 'from midnight, for endoscopy', since: 'day team instruction' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 300, [
        pv('WBC', 9.2, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 10.9, 8.7), 'g/dL', 1, { low: 12, critical: true }),
        pv('Platelets', 196, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('CBC', 720, [
        pv('WBC', 9.0, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 11.4, 9.6), 'g/dL', 1, { low: 12 }),
        pv('Platelets', 204, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('Type and screen', 900, [], 'Group O positive. Antibody screen negative. Two units crossmatched and held.'),
    ],
    expectedOrders: ['lab-cbc', 'prbc', 'consult-gi', 'ns-1000', 'transfer-icu'],
    contraindicatedOrders: ['norepi', 'furosemide'],
  },

  {
    id: 'acs-cardiogenic',
    label: 'Acute coronary syndrome',
    tier: 'critical',
    ageRange: [48, 78],
    span: HOUR,
    admissionDx: 'Chest pain — rule out acute coronary syndrome',
    hiddenDx: 'Anterior STEMI with cardiogenic shock',
    teachingPoint:
      'Cardiogenic shock is a pump problem: low output, high filling pressures, and pulmonary oedema together. ' +
      'The distinguishing feature from sepsis is that the patient is cold and congested rather than warm and dry. ' +
      'Fluid worsens it; the definitive treatment is reperfusion, and every minute of delay costs myocardium.',
    history: (ctx) => ctx.rng.sample(
      ['Hyperlipidaemia', 'Hypertension', 'Family history of premature CAD', 'Type 2 diabetes', 'Ex-smoker', 'Peripheral vascular disease'],
      3,
    ),
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(68, 80), svr: 17, edv: ctx.rng.int(120, 132) },
      rrOffset: 2,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: (g) => `${ctx.room} woke up with crushing chest pain — ${v.subj} ${v.verb('say')} it's worse than what brought ${v.obj} in. ` +
            (g.perf >= 1 ? `${v.Subj} ${v.is} diaphoretic and grey.`
              : `${v.Subj} ${v.is} sweaty with it. Observations are holding so far.`),
          interventions: [
            insult(ctx, { label: 'STEMI: contractility↓', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.95, tauOn: 600, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 60 * MIN, 6 * MIN),
          pageWhen: { axis: 'either', grade: 1 },
          page: (g) => g.perf >= 2
            ? `The pressure is down and ${v.subj} ${v.is} short of breath on top of the pain now.`
            : g.wob >= 1 || g.perf >= 1
            ? `The pain is not settling and ${v.subj} ${v.is} short of breath on top of it now.`
            : `The pain is still there and the morphine has not touched it. Observations unchanged.`,
          interventions: [
            insult(ctx, { label: 'STEMI: infarct extension', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.45, tauOn: 900, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    handoff: () => ({
      severityCall: 'stable',
      summary: `Chest pain, two negative troponins, unremarkable EKG on arrival. Pain free since the emergency department. Stress test booked for the morning.`,
      todo: ['Nil by mouth from midnight for the stress test.'],
      contingencies: [
        'Two negative troponins rule out very little at this stage. If the pain returns, repeat the EKG immediately and cycle the troponin — do not wait for the stress test.',
      ],
      misleading: 'If the pain comes back, repeat the EKG.',
    }),
    // The infarct is on the EKG from the moment the muscle starts dying, which is
    // the whole basis of the time-critical decision this case is built around.
    // Read off contractility rather than off the label, so a tracing taken before
    // the event is correctly unremarkable and one taken after is not.
    findings: () => (panel, snap) => {
      if (panel !== 'EKG') return null;
      if (snap.emaxEffective < 1.55) {
        return 'ST elevation of 3–4 mm in II, III and aVF with reciprocal depression in I and aVL — inferior STEMI.';
      }
      if (snap.emaxEffective < 1.85) {
        return 'Hyperacute T waves inferiorly with a millimetre of ST elevation in III — early, and evolving.';
      }
      return null;
    },
    medications: () => [
      { name: 'Aspirin', detail: '81 mg orally daily', since: 'home medication' },
      { name: 'Atorvastatin', detail: '80 mg orally at night', since: 'admission' },
      { name: 'Metoprolol', detail: '25 mg orally twice daily', since: 'admission' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily — prophylactic dose', since: 'admission' },
      { name: 'Glyceryl trinitrate', detail: '0.4 mg sublingual as needed for chest pain', since: 'admission' },
    ],
    priorLabs: () => [
      prior('Troponin', 720, [pv('Troponin I', 0.03, 'ng/mL', 2, { high: 0.04 })]),
      prior('Troponin', 360, [pv('Troponin I', 0.04, 'ng/mL', 2, { high: 0.04 })]),
      prior('EKG', 720, [], 'Normal sinus rhythm at 78. No acute ischaemic changes. No comparison available.'),
      prior('Lipid panel', 720, [
        pv('LDL', 168, 'mg/dL', 0, { high: 100 }),
        pv('HDL', 34, 'mg/dL', 0, { low: 40 }),
      ]),
    ],
    expectedOrders: ['img-ekg', 'lab-trop', 'aspirin', 'consult-cards', 'transfer-icu', 'img-echo'],
    contraindicatedOrders: ['ns-1000', 'ns-500'],
  },

  {
    id: 'copd-exacerbation',
    label: 'COPD exacerbation',
    tier: 'ward',
    ageRange: [56, 82],
    span: 30 * MIN,
    admissionDx: 'COPD exacerbation',
    hiddenDx: 'COPD exacerbation with acute bronchospasm — the admission diagnosis is correct',
    teachingPoint:
      'Not every deterioration is a hidden diagnosis. This is bronchospasm, the obvious treatment is the right one, ' +
      'and the skill being tested is recognising that quickly and not spending the night working it up. ' +
      'Note the baseline saturation: chasing a normal number in someone who lives at 90% causes harm.',
    history: (ctx) => [
      ctx.rng.pick(['Severe COPD (FEV1 34%)', 'Severe COPD (FEV1 28%)', 'COPD with chronic bronchitis']),
      ctx.rng.pick(['50 pack-year smoking history', '40 pack-year smoking history', 'Ex-smoker, 30 pack-years']),
      'Home O2 2L',
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(82, 92),
        svr: 14,
        edv: ctx.rng.int(108, 120),
        qsQt: bySeverity(ctx, 0.09, 0.17),
        pvr: 2.4,
      },
      rrOffset: 3,
      tempOffset: 0.2,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${ctx.name} is wheezing all over and using ${v.poss} accessory muscles. ` +
              `${v.Subj} can only get out a few words at a time.`
            : g.wob >= 1
            ? `${ctx.name} is more wheezy than earlier and ${v.subj} ${v.verb('want')} ${v.poss} neb brought forward. ` +
              `${v.Subj} ${v.is} still talking in sentences.`
            : `${ctx.name} is a bit wheezy and ${v.verb('want')} to know whether ${v.subj} can have ` +
              `${v.poss} neb early. Observations are at ${v.poss} usual.`,
          interventions: [
            // Bronchospasm does not self-resolve overnight; nebs and steroids reverse it.
            insult(ctx, { label: 'Bronchospasm: V/Q', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.17, tauOn: 600, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Bronchospasm: HPV', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 1.2, tauOn: 900, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary: 'COPD exacerbation, day 2. Slowly improving on prednisone and scheduled nebulisers.',
      todo: ['Scheduled nebulisers at 22:00 and 04:00.'],
      contingencies: [
        `Saturation at home is 89–91% on 2L. Please do not chase a normal number — target ${ctx.voice.poss} baseline.`,
        'If tiring, think about non-invasive ventilation before a tube.',
      ],
    }),
    findings: () => (panel) =>
      panel === 'CXR'
        ? 'Hyperinflated lungs with flattened hemidiaphragms and a narrow cardiac silhouette. ' +
          'No focal consolidation — the chest film does not diagnose bronchospasm, and a normal one does not exclude it.'
        : null,
    medications: (ctx) => [
      { name: 'Prednisolone', detail: '40 mg orally daily', since: `day ${ctx.rng.int(1, 3)} of 5` },
      { name: 'Salbutamol/ipratropium nebulisers', detail: 'scheduled every 6 hours, plus as needed', since: 'admission' },
      { name: ctx.rng.pick(['Doxycycline', 'Co-amoxiclav']), detail: 'oral', since: `day ${ctx.rng.int(1, 3)} of 5` },
      { name: 'Home oxygen', detail: '2 L via nasal cannula — target saturation 88–92%', since: 'home therapy' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      // The gas the covering doctor most wants and least often looks for.
      prior('VBG', 210, [
        pv('pH', bySeverity(ctx, 7.37, 7.32), '', 2, { low: 7.32, high: 7.42 }),
        pv('pCO₂', bySeverityInt(ctx, 48, 61), 'mmHg', 0, { low: 41, high: 51 }),
        pv('HCO₃', bySeverityInt(ctx, 28, 33), 'mEq/L', 0, { low: 22, high: 26 }),
        pv('Lactate', 1.2, 'mmol/L', 1, { high: 2.0 }),
      ]),
      prior('VBG', 900, [
        pv('pH', bySeverity(ctx, 7.35, 7.29), '', 2, { low: 7.32, high: 7.42 }),
        pv('pCO₂', bySeverityInt(ctx, 52, 68), 'mmHg', 0, { low: 41, high: 51 }),
        pv('HCO₃', bySeverityInt(ctx, 29, 34), 'mEq/L', 0, { low: 22, high: 26 }),
      ]),
      prior('CXR', 960, [], 'Hyperinflated lungs with flattened hemidiaphragms. No consolidation or pneumothorax.'),
    ],
    expectedOrders: ['duoneb', 'steroids', 'o2-nc6', 'sit-up', 'bipap', 'hfnc'],
    contraindicatedOrders: ['ns-1000', 'morphine-comfort'],
  },

  {
    id: 'hypovolaemia',
    label: 'Dehydration and poor intake',
    tier: 'ward',
    ageRange: [70, 92],
    span: 2 * HOUR,
    admissionDx: 'Poor oral intake, acute kidney injury',
    hiddenDx: 'Hypovolaemia from poor intake and diuretics — corrects readily with fluid',
    teachingPoint:
      'Not everything that drops a blood pressure is shock. An empty, well-perfused patient who responds to a ' +
      'fluid bolus is the commonest overnight call there is, and recognising it saves both an unnecessary ' +
      'escalation and the harm of treating a full patient as if they were empty.',
    history: (ctx) => ctx.rng.sample(
      ['Chronic kidney disease', 'On furosemide at home', 'Frailty', 'Dementia', 'Recurrent falls', 'Hypertension'],
      3,
    ),
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(82, 94),
        svr: 15,
        edv: bySeverityInt(ctx, 102, 86),
      },
      rrOffset: 2,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.room}'s blood pressure is lower than it has been — ${v.subj} ${v.verb('feel')} fine and ${v.is} talking to me, ` +
            `but ${v.subj} ${v.has} not really drunk anything today and the urine output is down.`,
          interventions: [
            insult(ctx, { label: 'Hypovolaemia', category: 'scenario', kind: 'scenario', target: 'edv', delta: -18, tauOn: 2400, eliminationHalfLife: 43200 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary: `Admitted with poor oral intake and an acute kidney injury. Creatinine improving with gentle fluids. Home diuretics held.`,
      todo: ['Strict fluid balance.', 'Repeat renal function in the morning.'],
      contingencies: [
        `If the pressure drifts down, ${ctx.voice.subj} ${ctx.voice.is} more likely to be dry than septic — ` +
          'a bolus and a reassessment is reasonable before anything else.',
      ],
    }),
    medications: (ctx) => [
      { name: 'Furosemide', detail: '40 mg orally daily — HELD today for the AKI', since: 'home medication, held' },
      { name: ctx.rng.pick(['Lisinopril', 'Ramipril']), detail: 'oral — HELD today', since: 'home medication, held' },
      { name: 'Maintenance fluids', detail: 'saline at 50 mL/h', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('BMP', 420, [
        pv('Creatinine', bySeverity(ctx, 1.5, 2.3), 'mg/dL', 2, { high: 1.1 }),
        pv('Urea', bySeverityInt(ctx, 38, 62), 'mg/dL', 0, { high: 20 }),
        pv('Sodium', 143, 'mEq/L', 0, { low: 135, high: 145 }),
        pv('Potassium', 3.4, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
      ]),
      prior('BMP', 1500, [
        pv('Creatinine', bySeverity(ctx, 1.8, 2.8), 'mg/dL', 2, { high: 1.1 }),
        pv('Urea', bySeverityInt(ctx, 46, 74), 'mg/dL', 0, { high: 20 }),
      ]),
    ],
    expectedOrders: ['vitals-now', 'ns-500', 'ns-250', 'lab-bmp'],
    contraindicatedOrders: ['furosemide', 'norepi'],
  },

  {
    id: 'end-of-life-pneumonia',
    label: 'Aspiration pneumonia at the end of life',
    tier: 'ward',
    ageRange: [78, 96],
    span: 3 * HOUR,
    admissionDx: 'Aspiration pneumonia',
    hiddenDx: 'Progressive aspiration pneumonia in advanced dementia — the dying process',
    teachingPoint:
      'Escalation is not always the intervention. This patient is at the end of a long trajectory, and the ' +
      'meaningful clinical act overnight is a goals-of-care conversation, not another litre of fluid. ' +
      'Recognising who cannot be rescued is as much a clinical skill as recognising who can.',
    history: () => [
      'Advanced dementia — non-verbal, fully dependent',
      'Third aspiration pneumonia in six months',
      'Progressive weight loss, recurrent admissions',
    ],
    codeStatus: () => 'DNR/DNI',
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(88, 98),
        svr: 13.5,
        edv: ctx.rng.int(92, 102),
        qsQt: bySeverity(ctx, 0.12, 0.2),
        noTone: 0.2,
      },
      rrOffset: 2,
      tempOffset: 0.3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${ctx.name} in ${ctx.room} is satting in the high eighties and the breathing looks laboured. ` +
              `${v.Subj} ${v.isnt} distressed exactly, but ${v.subj} ${v.verb('look')} uncomfortable.`
            : g.wob >= 1
            ? `${ctx.name} in ${ctx.room} is breathing faster than earlier and the saturations have slipped. ` +
              `${v.Subj} ${v.isnt} distressed, but ${v.subj} ${v.verb('look')} tired.`
            : `${ctx.name} in ${ctx.room} is very tired and not taking much. ` +
              `Observations are unchanged, but ${v.subj} ${v.verb('look')} like ${v.subj} ${v.is} fading to me.`,
          interventions: [
            insult(ctx, { label: 'Pneumonia: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.1, tauOn: 3600, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumonia: sepsis', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.22, tauOn: 3600, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 150 * MIN),
          pageWhen: { axis: 'either', grade: 1 },
          page: (g) => (g.wob >= 1 || g.perf >= 1
            ? `${v.Subj} ${v.is} working harder and the pressure is drifting down. `
            : `${v.Subj} ${v.is} no better than ${v.subj} ${v.was} at handover. `) +
            `I don't think ${v.subj} ${v.is} going to turn around. Do you want to talk to the family?`,
          interventions: [
            insult(ctx, { label: 'Progressive decline', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.25, tauOn: 3600, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Decline: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.08, tauOn: 3600, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary: `Aspiration pneumonia, day 4 of antibiotics. Advanced dementia, admitted from a nursing home. Third admission in six months.`,
      todo: [
        `No goals-of-care discussion documented this admission. The family have not returned our calls — someone should try again.`,
      ],
      contingencies: [
        `${ctx.voice.Subj} ${ctx.voice.is} DNR/DNI. If ${ctx.voice.subj} ${ctx.voice.verb('deteriorate')}, the conversation to have is with the family, not the intensivist.`,
      ],
    }),
    findings: (_ctx, atHandover) => (panel, snap) => {
      if (panel !== 'CXR') return null;
      return snap.qsQtEffective - atHandover.qsQtEffective > 0.03
        ? 'Extensive bilateral consolidation, worse than the comparison film from admission. No new effusion.'
        : 'Bilateral basal consolidation, unchanged from the admission film.';
    },
    medications: () => [
      { name: 'Piperacillin–tazobactam', detail: '4.5 g IV every 6 hours', since: 'day 4 of admission' },
      { name: 'Morphine', detail: '2 mg subcutaneously every 4 hours as needed for breathlessness', since: 'day 3' },
      { name: 'Hyoscine butylbromide', detail: '20 mg subcutaneously as needed for secretions', since: 'day 4' },
      { name: 'Oxygen', detail: '2 L via nasal cannula, for comfort', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 600, [
        pv('WBC', bySeverity(ctx, 16.8, 22.4), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 9.8, 'g/dL', 1, { low: 12 }),
        pv('Platelets', 142, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('BMP', 600, [
        pv('Creatinine', bySeverity(ctx, 1.7, 2.6), 'mg/dL', 2, { high: 1.1 }),
        pv('Albumin', 2.1, 'g/dL', 1, { low: 3.5 }),
      ]),
      prior('CXR', 1800, [], 'Bilateral basal consolidation, worse than the film four days ago.'),
    ],
    expectedOrders: ['goals-of-care', 'comfort-care', 'morphine-comfort', 'call-attending'],
    contraindicatedOrders: ['intubate', 'norepi', 'transfer-icu'],
  },

  {
    id: 'pneumothorax',
    label: 'Post-procedural pneumothorax',
    tier: 'ward',
    ageRange: [34, 82],
    span: 90 * MIN,
    admissionDx: 'Pleural effusion — drained this afternoon',
    hiddenDx: 'Pneumothorax following pleural drainage, enlarging overnight',
    teachingPoint:
      'Obstructive physiology after a procedure is a mechanical problem with a mechanical answer. ' +
      'Rising filling pressure with a falling stroke volume and a unilaterally quiet chest is a pneumothorax ' +
      'until a film says otherwise — and no amount of oxygen or fluid substitutes for decompressing it.',
    history: (ctx) => ctx.rng.sample(
      ['Malignant pleural effusion', 'Heart failure', 'Previous thoracic surgery', 'COPD', 'Recent pleural tap'],
      2,
    ),
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(80, 92),
        svr: 15.5,
        edv: ctx.rng.int(112, 124),
        qsQt: bySeverity(ctx, 0.04, 0.08),
      },
      rrOffset: 4,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${ctx.name} in ${ctx.room} is much more breathless since the drain came out, and the saturations ` +
              `have come down. Air entry sounds much quieter on one side to me.`
            : `${ctx.name} in ${ctx.room} is a bit more breathless since the drain came out. ` +
              `Air entry sounds quieter on one side to me — I wanted you to hear it too.`,
          interventions: [
            insult(ctx, { label: 'Pneumothorax: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.13, tauOn: 1500, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumothorax: intrathoracic pressure', category: 'scenario', kind: 'scenario', target: 'cvp', delta: 8, tauOn: 1800, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumothorax: venous return↓', category: 'scenario', kind: 'scenario', target: 'edv', delta: -24, tauOn: 1800, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 90 * MIN),
          pageWhen: { axis: 'either', grade: 2 },
          page: (g) => g.perf >= 2
            ? `${v.Subj} ${v.is} worse — really struggling now, and the pressure has come down with it.`
            : g.wob >= 2
            ? `${v.Subj} ${v.is} worse — really struggling to breathe now.`
            : `That side still sounds very quiet to me and ${v.subj} ${v.is} no more comfortable than ` +
              `${v.subj} ${v.was} earlier, even though the numbers look reasonable.`,
          interventions: [
            insult(ctx, { label: 'Pneumothorax: enlarging', category: 'scenario', kind: 'scenario', target: 'cvp', delta: 5, tauOn: 1200, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumothorax: venous return↓↓', category: 'scenario', kind: 'scenario', target: 'edv', delta: -16, tauOn: 1200, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary: `Pleural effusion drained this afternoon — 1.2 litres off, ${ctx.voice.subj} felt much better afterwards. Post-procedure film was reported as satisfactory.`,
      todo: ['Repeat chest film in the morning.'],
      contingencies: [
        'If the breathlessness comes back after a drain, get a film before anything else — a post-procedural pneumothorax can declare hours later.',
      ],
    }),
    findings: (_ctx, atHandover) => (panel, snap) => {
      if (panel !== 'CXR') return null;
      // This patient was admitted with a drained pneumothorax, so the gate is the
      // rise above their own film rather than an absolute — a study taken before
      // the lung drops shows the residual, not a new collapse.
      const excess = snap.qsQtEffective - atHandover.qsQtEffective;
      // Tension physiology is the shunt together with the loss of venous return.
      if (excess > 0.07 && snap.edv < atHandover.edv - 12) {
        return 'Large pneumothorax with mediastinal shift away from the affected side and a depressed hemidiaphragm — under tension.';
      }
      if (excess > 0.03) {
        return 'Moderate pneumothorax — visible visceral pleural line with no lung markings peripherally. No mediastinal shift.';
      }
      return 'Small apical pneumothorax at the site of the removed drain, unchanged from the comparison film. Lung otherwise expanded.';
    },
    medications: () => [
      { name: 'Paracetamol', detail: '1 g orally every 6 hours', since: 'admission' },
      { name: 'Oxycodone', detail: '5 mg orally every 4 hours as needed', since: 'admission' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: () => [
      prior('CXR', 300, [], 'Post-drain-removal film: small apical residual pneumothorax, approximately 10%. No shift.'),
      prior('CXR', 1440, [], 'Chest drain in situ, lung fully re-expanded.'),
    ],
    expectedOrders: ['img-cxr', 'o2-nrb', 'chest-drain', 'vitals-now'],
    contraindicatedOrders: ['ns-1000', 'furosemide'],
  },

  {
    id: 'aspiration-event',
    label: 'Witnessed aspiration',
    tier: 'ward',
    ageRange: [58, 90],
    span: 2 * HOUR,
    admissionDx: 'Stroke — dysphagia, on modified diet',
    hiddenDx: 'Aspiration during the evening meal, with a developing chemical pneumonitis',
    teachingPoint:
      'A witnessed aspiration is one of the few overnight events where you know the mechanism at the time it ' +
      'happens. The work is supportive and immediate — position, suction, oxygen — and the judgement call is ' +
      'antibiotics, which treat infection that has not happened yet rather than the chemical injury that has.',
    history: (ctx) => [
      'Recent stroke with dysphagia',
      ...ctx.rng.sample(['Atrial fibrillation', 'Hypertension', 'Previous aspiration', 'Reduced consciousness', 'Nasogastric feeding'], 2),
    ],
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(78, 90), svr: 15, edv: ctx.rng.int(108, 120) },
      rrOffset: 4,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: (g) => `${ctx.name} coughed and choked during the evening meal. I've sat ${v.obj} up and suctioned. ` +
            (g.wob >= 2 ? `${v.Subj} ${v.verb('sound')} wet and ${v.subj} ${v.is} desaturating.`
              : g.wob >= 1 ? `${v.Subj} ${v.verb('sound')} rattly and ${v.subj} ${v.is} breathing faster than earlier.`
              : `${v.Subj} ${v.verb('sound')} a bit rattly but the observations are unchanged so far.`),
          interventions: [
            insult(ctx, { label: 'Aspiration: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.15, tauOn: 900, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'Aspiration: inflammation', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.14, tauOn: 3600, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 110 * MIN),
          // The temperature is charted, so this fires regardless; the oxygen
          // requirement is only mentioned when there actually is one.
          page: (g) => g.wob >= 1
            ? `Still needing more oxygen than before, and ${v.subj} ${v.verb('sound')} rattly. Temperature is creeping up.`
            : `${v.Subj} ${v.verb('sound')} rattly still and the temperature is creeping up. Breathing is settled.`,
          interventions: [
            insult(ctx, { label: 'Pneumonitis: progression', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.14, tauOn: 3600, eliminationHalfLife: 43200 }),
          ],
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary: `Stroke with dysphagia. Speech and language have ${ctx.voice.obj} on a modified diet with thickened fluids; ${ctx.voice.subj} ${ctx.voice.verb('cough')} on thin fluids.`,
      todo: ['Modified diet only — nothing thin by mouth.', 'Sit fully upright for meals.'],
      contingencies: [
        `If ${ctx.voice.subj} ${ctx.voice.verb('aspirate')}, sit ${ctx.voice.obj} up, suction, and give oxygen. Antibiotics only if a fever or infiltrate develops — the first few hours are chemical, not infective.`,
      ],
    }),
    findings: (_ctx, atHandover) => (panel, snap) => {
      if (panel !== 'CXR') return null;
      return snap.qsQtEffective - atHandover.qsQtEffective > 0.02
        ? 'Patchy airspace opacification in the dependent segments — right lower lobe and posterior right upper lobe. New since admission, consistent with aspiration.'
        : null;
    },
    medications: () => [
      { name: 'Modified diet', detail: 'level 5 minced and moist, thickened fluids — speech and language assessment', since: 'day 2' },
      { name: 'Aspirin', detail: '300 mg orally daily', since: 'admission' },
      { name: 'Atorvastatin', detail: '40 mg orally at night', since: 'admission' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: () => [
      prior('Swallow assessment', 1440, [], 'Speech and language: unsafe with thin fluids, overt cough. Level 5 diet with thickened fluids. Reassess in 48 hours.'),
      prior('CBC', 720, [
        pv('WBC', 9.4, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 12.9, 'g/dL', 1, { low: 12 }),
      ]),
    ],
    expectedOrders: ['sit-up', 'o2-nc6', 'img-cxr', 'abx'],
    contraindicatedOrders: ['morphine-comfort', 'trazodone'],
  },

  {
    id: 'benign-sundowning',
    label: 'Sundowning',
    tier: 'benign',
    ageRange: [76, 94],
    span: 6 * HOUR,
    admissionDx: 'Community-acquired pneumonia, completing antibiotics',
    hiddenDx: 'Sundowning in a patient with background cognitive impairment — no acute physiology',
    teachingPoint:
      'Confusion at night in an elderly inpatient is common, and the answer is almost never a sedative. ' +
      'The hard part is that it looks exactly like the early presentation of something serious, so the right ' +
      'move is a quick set of observations to exclude the dangerous causes and then a non-pharmacologic bundle — ' +
      'not a workup, and not haloperidol.',
    history: (ctx) => ctx.rng.sample(
      ['Mild cognitive impairment', 'Hearing loss', 'Poor vision', 'Lives alone', 'Previous delirium in hospital'],
      3,
    ),
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(76, 88), svr: 15.5, edv: ctx.rng.int(110, 122) },
      rrOffset: 3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.name} in ${ctx.room} is agitated and trying to get out of bed — ${v.subj} ${v.verb('think')} ` +
            `${v.subj} ${v.is} at home and ${v.verb('want')} to leave. Observations are all normal. Do you want anything for it?`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 130 * MIN),
          page: `Still unsettled and calling out. ${v.Subj} ${v.verb('settle')} when I sit with ${v.obj}, but I can't stay.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 300 * MIN),
          page: `${ctx.room} has finally gone off to sleep. Nothing else needed overnight.`,
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary: `Community-acquired pneumonia, day 4 and much improved. Afebrile, off oxygen, eating. For discharge home once the family can collect ${ctx.voice.obj}.`,
      todo: [`${ctx.voice.Subj} ${ctx.voice.verb('get')} muddled in the evenings — the family say this happens in hospital and settles at home.`],
      contingencies: [
        'If confused overnight, please check a set of observations and a glucose before assuming it is just the hospital — but this is almost certainly sundowning, and sedation will make it worse.',
      ],
    }),
    medications: () => [
      { name: 'Oxybutynin', detail: '5 mg orally twice daily', since: 'home medication' },
      { name: 'Donepezil', detail: '10 mg orally at night', since: 'home medication' },
      { name: 'Co-amoxiclav', detail: '625 mg orally three times daily', since: 'day 3 of 5' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: () => [
      prior('BMP', 660, [
        pv('Sodium', 134, 'mEq/L', 0, { low: 135, high: 145 }),
        pv('Creatinine', 1.1, 'mg/dL', 2, { high: 1.1 }),
      ]),
      prior('Urine culture', 2160, [], 'Mixed growth, likely contaminant. No dominant organism.'),
    ],
    expectedOrders: ['delirium-precautions', 'quetiapine', 'vitals-now'],
    contraindicatedOrders: ['haloperidol', 'lorazepam', 'trazodone', 'img-ctpe'],
  },

  {
    id: 'benign-anxiety',
    label: 'Anxiety with chest tightness',
    tier: 'benign',
    ageRange: [24, 58],
    span: 5 * HOUR,
    admissionDx: 'Atypical chest pain — cardiac workup complete and negative',
    hiddenDx: 'Anxiety. The chest pain is real and the heart is fine',
    teachingPoint:
      'The workup is already done and it is negative. Repeating it because the symptom recurs is not diligence, ' +
      'it is a failure to accept a result — and it costs the patient sleep, veins, and reassurance, while the ' +
      'time it takes belongs to somebody else on the ward.',
    history: (ctx) => ctx.rng.sample(
      ['Generalised anxiety disorder', 'Panic attacks', 'No cardiac risk factors', 'Reflux disease', 'Recent bereavement'],
      2,
    ),
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(82, 94), svr: 16, edv: ctx.rng.int(116, 128) },
      rrOffset: 3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.name} has chest tightness again and ${v.is} frightened. Heart rate 94, everything else normal. ` +
            `${v.Subj} ${v.verb('say')} it feels the same as before.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 140 * MIN),
          page: `${ctx.room} is asking whether the tests could have missed something. ${v.Subj} ${v.verb('want')} to talk to a doctor.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 290 * MIN),
          page: `Settled now after a chat. ${v.Subj} ${v.verb('say')} the tightness has gone.`,
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary:
        `Atypical chest pain. Serial troponins negative, EKGs normal, CT coronary angiogram clean. Cardiology have signed off. ` +
        `The pain is genuine but it is not the heart, and ${ctx.voice.subj} ${ctx.voice.has} been told so.`,
      todo: ['Discharge in the morning once the anxiety team have reviewed.'],
      contingencies: [
        'The tightness will very likely recur overnight. It has been fully investigated — please do not repeat the workup; reassurance is the treatment.',
      ],
    }),
    medications: () => [
      { name: 'Sertraline', detail: '50 mg orally daily', since: 'home medication' },
      { name: 'Aspirin', detail: '81 mg orally daily', since: 'admission' },
      { name: 'Paracetamol', detail: '1 g orally every 6 hours as needed', since: 'admission' },
    ],
    priorLabs: () => [
      prior('Troponin', 780, [pv('Troponin I', 0.01, 'ng/mL', 2, { high: 0.04 })]),
      prior('Troponin', 420, [pv('Troponin I', 0.01, 'ng/mL', 2, { high: 0.04 })]),
      prior('EKG', 780, [], 'Normal sinus rhythm at 74. No ischaemic changes.'),
      prior('CT PE protocol', 900, [], 'No pulmonary embolism. No other acute finding.'),
    ],
    expectedOrders: ['vitals-now', 'img-ekg'],
    contraindicatedOrders: ['img-ctpe', 'transfer-icu', 'lab-trop'],
  },

  {
    id: 'benign-cellulitis',
    label: 'Cellulitis, improving',
    tier: 'benign',
    ageRange: [34, 74],
    span: 6 * HOUR,
    admissionDx: 'Lower extremity cellulitis',
    hiddenDx: 'Uncomplicated cellulitis, improving — nothing is wrong',
    teachingPoint:
      'Most overnight pages are not emergencies, and the ward will page you about all of them. ' +
      'The cost of treating every page as a crisis is paid by the patient down the hall who is actually ' +
      'deteriorating. Triage is the skill: answer this one quickly and move on.',
    history: (ctx) => ctx.rng.sample(
      ['Obesity', 'Chronic venous stasis', 'Type 2 diabetes', 'Lymphoedema', 'Previous cellulitis'],
      2,
    ),
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(70, 82), svr: 15, edv: ctx.rng.int(116, 128) },
      rrOffset: 1,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `Hi doctor — ${ctx.room} is asking for something to help ${v.obj} sleep. ` +
            `${v.Subj} ${v.has} been up watching TV. Nothing else going on, vitals all fine.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 145 * MIN),
          page: `Sorry, ${ctx.room} again — the cannula in the left hand is puffy and running slow. ` +
            `The leg still looks better. Want me to just resite it?`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 365 * MIN),
          page: `${ctx.room} is asking if ${v.subj} can have something for a headache. Otherwise fine, vitals stable.`,
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary:
        `Lower limb cellulitis, day 3 of IV antibiotics. Erythema is receding and the margin is marked; afebrile for 48 hours. ` +
        `For a switch to oral antibiotics and discharge tomorrow.`,
      todo: [
        'Cannula in the left hand is three days old — resite it if it stops running.',
        `${ctx.voice.Subj} ${ctx.voice.has} not slept well in hospital and ${ctx.voice.has} asked about something to help.`,
        'Simple analgesia is written as required.',
      ],
      contingencies: [
        'If the erythema extends beyond the marked line, let the day team know and we will re-image.',
      ],
    }),
    medications: () => [
      { name: 'Flucloxacillin', detail: '1 g IV every 6 hours', since: 'day 2 of 7' },
      { name: 'Paracetamol', detail: '1 g orally every 6 hours as needed', since: 'admission' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'admission' },
    ],
    priorLabs: () => [
      prior('CBC', 720, [
        pv('WBC', 11.4, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 13.2, 'g/dL', 1, { low: 12 }),
      ]),
      prior('CRP', 720, [pv('CRP', 84, 'mg/L', 0, { high: 5 })]),
    ],
    expectedOrders: ['melatonin', 'iv-resite', 'acetaminophen'],
    contraindicatedOrders: ['img-ctpe', 'transfer-icu'],
  },

  {
    id: 'benign-post-op-pain',
    label: 'Post-operative pain and nausea',
    tier: 'benign',
    ageRange: [26, 70],
    span: 5 * HOUR,
    admissionDx: 'Post-operative day 1 — laparoscopic cholecystectomy',
    hiddenDx: 'Normal post-operative course — pain, nausea, and constipation',
    teachingPoint:
      'A page about nausea at 02:00 is still a page you have to answer, and answering it well takes a minute. ' +
      'The failure mode is not missing the diagnosis — there is not one — it is letting these calls crowd out ' +
      'the patient whose blood pressure is quietly falling two rooms away.',
    history: (ctx) => ctx.rng.sample(
      ['Gallstones', 'Obesity', 'Reflux disease', 'Anxiety', 'Previous caesarean section'],
      2,
    ),
    baseline: (ctx) => ({
      stateOverrides: { hr: ctx.rng.int(74, 88), svr: 15.5, edv: ctx.rng.int(114, 126) },
      rrOffset: 2,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.room} is feeling sick after the oxycodone. Not vomiting, but ${v.subj} ${v.verb('want')} something for it. Obs are fine.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 120 * MIN),
          page: `${ctx.room} is uncomfortable — shoulder tip pain from the gas, which I've told ${v.obj} is normal. ` +
            `Anything written up beyond the oxycodone?`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 300 * MIN),
          page: `${ctx.room} hasn't opened ${v.poss} bowels since the operation and is getting uncomfortable about it.`,
        },
      ];
    },
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary: `Day 1 after a laparoscopic cholecystectomy. Uncomplicated. Eating and drinking, mobilising with the physiotherapists. Home tomorrow.`,
      todo: [
        `Oxycodone as required — ${ctx.voice.subj} ${ctx.voice.has} been using it.`,
        'Remove the drain in the morning.',
      ],
      contingencies: [
        `Nothing anticipated. If ${ctx.voice.subj} ${ctx.voice.verb('develop')} a fever or worsening abdominal pain, call surgery.`,
      ],
    }),
    medications: () => [
      { name: 'Oxycodone', detail: '5 mg orally every 4 hours as needed', since: 'day 1 post-op' },
      { name: 'Paracetamol', detail: '1 g orally every 6 hours, regular', since: 'day 1 post-op' },
      { name: 'Enoxaparin', detail: '40 mg subcutaneously daily', since: 'day 1 post-op' },
      { name: 'Ondansetron', detail: '4 mg IV every 8 hours as needed', since: 'day 1 post-op' },
    ],
    priorLabs: () => [
      prior('CBC', 900, [
        pv('WBC', 12.1, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 11.8, 'g/dL', 1, { low: 12 }),
      ]),
    ],
    expectedOrders: ['ondansetron', 'acetaminophen', 'bowel-regimen'],
    contraindicatedOrders: ['img-ctpe', 'transfer-icu'],
  },

  // ─── Academic service ─────────────────────────────────────────────────────
  //
  // Patients a community hospital transfers out rather than admits. They are not
  // harder versions of the cases above — they are different diseases, and the
  // trap in each one is a treatment that is correct for the community case and
  // wrong here.

  {
    id: 'pah-rv-failure',
    label: 'Pulmonary arterial hypertension, decompensating',
    tier: 'critical',
    setting: 'academic',
    // Uncommon as a first overnight event, and unmistakable when it happens.
    weight: 0.3,
    ageRange: [28, 62],
    span: 3 * HOUR,
    admissionDx: 'Group 1 pulmonary arterial hypertension — volume overload',
    hiddenDx: 'Right ventricular failure in PAH, worsened by fluid and by interruption of prostacyclin',
    teachingPoint:
      'A failing right ventricle is not a left ventricle with a different address. Fluid makes it worse, ' +
      'systemic hypotension kills it because the right coronary perfuses in systole, and the thing that ' +
      'saves it is afterload reduction plus a pressor that supports the systemic pressure without raising PVR. ' +
      'Never interrupt a prostacyclin infusion — the half-life is minutes and rebound is lethal.',
    history: (ctx) => [
      ctx.rng.pick(['Idiopathic PAH, WHO functional class III', 'PAH from systemic sclerosis', 'Heritable PAH, BMPR2 mutation']),
      ctx.rng.pick(['Epoprostenol infusion via Hickman line', 'Treprostinil infusion, subcutaneous', 'Epoprostenol via tunnelled line']),
      'Ambrisentan and tadalafil',
      ctx.rng.pick(['Right heart catheterisation: mPAP 58, PVR 11 WU', 'Right heart catheterisation: mPAP 49, PVR 8 WU']),
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(88, 100),
        svr: 15,
        // A chronically pressure-loaded RV is hypertrophied, not weak — that is
        // what lets these patients walk around at a mean pulmonary pressure that
        // would put a normal right ventricle into shock. Decompensation is the
        // hypertrophy failing, which the script does, not a low starting point.
        pvr: bySeverity(ctx, 7.5, 9.5),
        rvEmax: bySeverity(ctx, 0.68, 0.58),
        rvedv: bySeverityInt(ctx, 155, 168),
        edv: ctx.rng.int(88, 98),
        cvp: bySeverity(ctx, 12, 14),
        qsQt: 0.08,
      },
      rrOffset: 4,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'either', grade: 1 },
          page: (g) => g.perf >= 2 || g.wob >= 2
            ? `${ctx.name} in ${ctx.room} is much worse — grey, cold hands, and ${v.subj} ${v.verb('say')} ` +
              `${v.subj} ${v.verb('feel')} like ${v.subj} ${v.is} going to pass out. The line site looks fine to me.`
            : `${ctx.name} in ${ctx.room} is more short of breath than earlier and the belly looks fuller. ` +
              `${v.Subj} ${v.verb('say')} this is how it feels before ${v.subj} ${v.verb('get')} admitted.`,
          interventions: [
            insult(ctx, { label: 'PAH: PVR crisis', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 4.2, tauOn: 1800, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'PAH: RV decompensation', category: 'scenario', kind: 'scenario', target: 'rvEmax', delta: -0.15, tauOn: 2400, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 95 * MIN),
          pageWhen: { axis: 'perf', grade: 2 },
          page: (g) => g.perf >= 3
            ? `${v.Subj} ${v.is} barely responsive and I cannot get a pressure. I need someone now.`
            : g.perf >= 2
            ? `The pressure has come right down and ${v.subj} ${v.is} mottled to the knees. ` +
              `${v.Subj} ${v.verb('look')} like ${v.subj} ${v.is} dying to me.`
            : `${v.Subj} ${v.is} no better and ${v.subj} ${v.verb('say')} the breathlessness is the same as ` +
              `the last time ${v.subj} ${v.verb('end')} up in the unit. The numbers are not telling me much.`,
          interventions: [
            insult(ctx, { label: 'PAH: RV ischaemia', category: 'scenario', kind: 'scenario', target: 'rvEmax', delta: -0.12, tauOn: 1500, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    findings: () => (panel, snap) => {
      if (panel === 'EKG') {
        return 'Right axis deviation, tall R in V1, right atrial enlargement and a strain pattern inferolaterally.';
      }
      if (panel === 'CXR') {
        return 'Enlarged central pulmonary arteries with peripheral pruning and a prominent right heart border. Lungs clear.';
      }
      if (panel === 'Bedside echo' && snap.rvedv > 250) {
        return 'Severely dilated, severely hypokinetic RV with septal flattening through systole and diastole. ' +
          'TAPSE 9 mm. Small, underfilled LV. Estimated RVSP above 80 mmHg.';
      }
      return null;
    },
    medications: (ctx) => [
      { name: ctx.rng.pick(['Epoprostenol', 'Treprostinil']), detail: 'continuous infusion via tunnelled line — DO NOT INTERRUPT', since: 'home medication, running' },
      { name: 'Ambrisentan', detail: '10 mg orally daily', since: 'home medication' },
      { name: 'Tadalafil', detail: '40 mg orally daily', since: 'home medication' },
      { name: 'Furosemide', detail: '80 mg IV twice daily', since: 'day 2 of admission' },
      { name: 'Spironolactone', detail: '25 mg orally daily', since: 'home medication' },
    ],
    priorLabs: (ctx) => [
      prior('BMP', 190, [
        pv('Sodium', 131, 'mEq/L', 0, { low: 135, high: 145 }),
        pv('Potassium', 4.4, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
        pv('Creatinine', bySeverity(ctx, 1.4, 2.1), 'mg/dL', 2, { high: 1.1 }),
        pv('Bicarbonate', 27, 'mEq/L', 0, { low: 22, high: 26 }),
      ]),
      prior('BNP', 300, [pv('NT-proBNP', bySeverity(ctx, 2400, 9800), 'pg/mL', 0, { high: 300, critical: true })]),
      prior('Lactate', 300, [pv('Lactate', bySeverity(ctx, 1.6, 2.6), 'mmol/L', 1, { high: 2.0 })]),
    ],
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Group 1 PAH admitted with volume overload, day 3. Diuresing slowly. Prostacyclin infusion running through ` +
        `${ctx.voice.poss} tunnelled line — pulmonary hypertension service are following.`,
      todo: ['Daily weights, strict input and output.', 'Repeat the BMP in the morning.'],
      contingencies: [
        'The prostacyclin line is life-sustaining. If it comes out or the pump alarms, restart it immediately and call the PH service — the half-life is minutes.',
        'Do not give fluid. A failing right ventricle does not respond to preload, it dilates.',
        'If the pressure drops, the pressor is noradrenaline or vasopressin — not phenylephrine, which raises the pulmonary resistance too.',
      ],
      misleading: 'Blood pressure has been soft all day. If it drops further, try a 500 mL bolus before calling anyone.',
    }),
    expectedOrders: ['o2-nrb', 'norepi', 'transfer-icu', 'img-echo', 'call-attending', 'hfnc'],
    contraindicatedOrders: ['ns-1000', 'ns-500', 'phenylephrine'],
  },

  {
    id: 'cirrhosis-sbp',
    label: 'Decompensated cirrhosis with spontaneous bacterial peritonitis',
    // Ward tier, not critical. SBP is usually a subacute presentation — the
    // patient has been quietly unwell for a day or two and is picked up by
    // someone paying attention, not by a crash call. It is dangerous over days
    // through the renal failure it causes, which is a different shape of danger
    // from bleeding out on your shift, and pretending otherwise made it a
    // haemodynamic emergency that it is not.
    tier: 'ward',
    setting: 'academic',
    ageRange: [38, 68],
    span: 5 * HOUR,
    admissionDx: 'Decompensated cirrhosis — ascites and acute kidney injury',
    hiddenDx: 'Spontaneous bacterial peritonitis precipitating hepatorenal physiology in a high-MELD cirrhotic',
    teachingPoint:
      'Cirrhosis is a distributive state before anything infects it: the splanchnic bed is already dilated, so a ' +
      'normal blood pressure in a high-MELD patient is a low one. This is a subacute illness — it will not kill ' +
      'anyone before morning — and what it costs is kidneys. The two things that change mortality are early ' +
      'antibiotics and albumin, albumin specifically because it is what prevents the hepatorenal syndrome. ' +
      'A tap confirms the diagnosis and belongs in the plan, but a covering doctor who starts the antibiotics ' +
      'and albumin overnight and leaves the paracentesis for the day team has done the job.',
    history: (ctx) => [
      ctx.rng.pick(['Alcohol-related cirrhosis, Child-Pugh C', 'NASH cirrhosis, Child-Pugh C', 'Cirrhosis from hepatitis C, treated']),
      `MELD-Na ${bySeverityInt(ctx, 22, 33)}`,
      ctx.rng.pick(['Two previous admissions with ascites this year', 'Previous hepatic encephalopathy', 'Oesophageal varices, banded twice']),
      'Listed for transplant assessment',
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(86, 98),
        // The splanchnic vasodilation of portal hypertension, before any sepsis.
        // Low, but a patient the day team left on a ward: the reserve this case
        // takes away is the reserve they were already short of.
        svr: bySeverity(ctx, 13.6, 12.8),
        edv: ctx.rng.int(104, 116),
        noTone: bySeverity(ctx, 0.06, 0.12),
      },
      // Every cirrhotic here is on a non-selective beta-blocker for their varices,
      // so the blunted chronotropic response belongs in the baseline rather than
      // being drawn as a background condition on top of the drug they are already
      // charted for. Prophylactic dose: blunted, not blocked.
      paramOverrides: { gainHr: 1.1, hgb: bySeverity(ctx, 9.6, 8.2) },
      rrOffset: 4,
      tempOffset: bySeverity(ctx, 0.1, 0.4),
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.name} in ${ctx.room} has a temperature and ${v.verb('say')} ${v.poss} belly is more sore than it was. ` +
            `${v.Subj} ${v.is} a bit vague with me but ${v.subj} ${v.verb('know')} where ${v.subj} ${v.is}.`,
          interventions: [
            insult(ctx, { label: 'SBP: inflammatory tone', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.10, tauOn: 3600, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 150 * MIN),
          pageWhen: { axis: 'perf', grade: 1, by: 60 * MIN },
          page: (g) => g.perf >= 2
            ? `${v.Subj} ${v.is} much more confused — pulling at the lines and ${v.subj} ${v.verb('have')} that flap. ` +
              `The pressure is down and ${v.subj} ${v.verb('have')} not passed urine since I came on.`
            : g.perf >= 1
            ? `${v.Subj} ${v.verb('seem')} more muddled than earlier and the pressure has drifted down. ` +
              `Urine output is poor — maybe 15 mL an hour.`
            : `Still febrile and the belly is no more comfortable. Urine output has dropped off — ` +
              `about 25 mL an hour. Nothing dramatic on the observations.`,
          interventions: [
            // Deliberately kept below the level that can kill overnight even in a
            // patient who cannot mount a tachycardia — and every cirrhotic here is
            // on a non-selective beta-blocker for their varices. The danger of
            // this illness is the kidneys over days, not the pressure tonight.
            insult(ctx, { label: 'SBP: vasoplegia', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.08, tauOn: 4200, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'Third-spacing into ascites', category: 'scenario', kind: 'scenario', target: 'edv', delta: -12, tauOn: 4800, eliminationHalfLife: 43200 }),
          ],
        },
      ];
    },
    findings: (ctx) => (panel, snap) => {
      if (panel === 'CXR') return 'Small bilateral effusions with elevated hemidiaphragms — consistent with tense ascites. No consolidation.';
      if (panel === 'Blood cultures' && snap.noTone > 0.25) {
        return `Two sets drawn. Gram stain pending. Note: an ascitic tap has not been sent — ` +
          `${ctx.voice.poss} peritoneal fluid is the sample that makes this diagnosis.`;
      }
      return null;
    },
    medications: (ctx) => [
      { name: 'Spironolactone', detail: '100 mg orally daily', since: 'home medication, held today' },
      { name: 'Furosemide', detail: '40 mg orally daily', since: 'home medication, held for the AKI' },
      { name: 'Lactulose', detail: '30 mL orally three times daily, titrated to three stools', since: 'home medication' },
      { name: 'Rifaximin', detail: '550 mg orally twice daily', since: 'home medication' },
      { name: ctx.rng.pick(['Norfloxacin', 'Ciprofloxacin']), detail: '400 mg orally daily — SBP prophylaxis', since: 'home medication' },
      { name: 'Pantoprazole', detail: '40 mg IV daily', since: 'day 1 of admission' },
    ],
    priorLabs: (ctx) => [
      prior('CMP', 260, [
        pv('Sodium', bySeverityInt(ctx, 132, 126), 'mEq/L', 0, { low: 135, high: 145 }),
        pv('Potassium', 4.8, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
        pv('Creatinine', bySeverity(ctx, 1.6, 2.9), 'mg/dL', 2, { high: 1.1, critical: true }),
        pv('Bilirubin', bySeverity(ctx, 4.2, 11.8), 'mg/dL', 1, { high: 1.2, critical: true }),
        pv('Albumin', bySeverity(ctx, 2.6, 1.9), 'g/dL', 1, { low: 3.5 }),
        pv('INR', bySeverity(ctx, 1.6, 2.4), '', 1, { high: 1.1 }),
      ]),
      prior('CBC', 260, [
        pv('WBC', bySeverity(ctx, 7.8, 12.4), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 9.6, 8.2), 'g/dL', 1, { low: 12 }),
        pv('Platelets', bySeverityInt(ctx, 88, 54), 'K/µL', 0, { low: 150 }),
      ]),
    ],
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Decompensated cirrhosis, admitted with tense ascites and an acute kidney injury. Five litres drained ` +
        `yesterday with albumin cover. Diuretics held. Hepatology reviewing for transplant workup.`,
      todo: ['Daily weights.', 'Repeat the creatinine in the morning.'],
      contingencies: [
        `If ${ctx.voice.subj} ${ctx.voice.verb('spike')} a temperature or the abdomen becomes more tender, start antibiotics. A tap confirms it and can wait for the day team if getting one overnight would delay treatment.`,
        'Any SBP gets albumin as well as antibiotics. It is what prevents the hepatorenal syndrome, and the kidneys are what this illness actually costs.',
        'Avoid NSAIDs and aminoglycosides entirely — the kidneys will not forgive either.',
      ],
      misleading: 'Blood pressure runs in the nineties systolic normally for this patient. Nothing to do about it.',
    }),
    expectedOrders: ['ceftriaxone', 'albumin', 'lab-cultures', 'lab-bmp', 'paracentesis'],
    contraindicatedOrders: ['ns-1000'],
  },

  {
    id: 'neutropenic-sepsis',
    label: 'Febrile neutropenia after stem cell transplant',
    tier: 'critical',
    setting: 'academic',
    ageRange: [24, 66],
    span: 3 * HOUR,
    admissionDx: 'Day +8 allogeneic stem cell transplant — neutropenic fever',
    hiddenDx: 'Gram-negative bacteraemia in profound neutropenia, progressing to septic shock',
    teachingPoint:
      'Neutropenic sepsis is a time-to-antibiotic disease and nothing else comes close: every hour of delay costs ' +
      'survival, and there is no examination finding to wait for because the patient has no neutrophils to make ' +
      'one with. No pus, no consolidation on the film, no peritonism. A fever in a neutropenic patient is a ' +
      'medical emergency at the moment it is measured.',
    history: (ctx) => [
      ctx.rng.pick(['AML in first remission', 'Myelodysplastic syndrome', 'ALL, second remission']),
      ctx.rng.pick(['Allogeneic transplant, day +8', 'Allogeneic transplant, day +11', 'Allogeneic transplant, day +6']),
      'Tunnelled central line in situ',
      'On tacrolimus for GVHD prophylaxis',
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(94, 106),
        svr: bySeverity(ctx, 14.2, 13.2),
        edv: ctx.rng.int(104, 114),
        noTone: bySeverity(ctx, 0.04, 0.1),
      },
      paramOverrides: { hgb: bySeverity(ctx, 8.8, 7.6) },
      rrOffset: 3,
      tempOffset: bySeverity(ctx, 0.6, 1.1),
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: (g) => `${ctx.name} in ${ctx.room} has spiked to ${bySeverity(ctx, 38.6, 39.4).toFixed(1)}. ` +
            `${v.Subj} ${v.is} neutropenic — the count this morning was ${bySeverity(ctx, 0.2, 0.05).toFixed(2)}. ` +
            (g.perf >= 1 ? `${v.Subj} ${v.verb('look')} unwell with it and the pressure is soft.`
              : `Observations are otherwise reasonable but I wanted you straight away.`),
          interventions: [
            insult(ctx, { label: 'Bacteraemia: inflammatory tone', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.24, tauOn: 1500, eliminationHalfLife: 36000 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 70 * MIN),
          pageWhen: { axis: 'perf', grade: 1 },
          page: (g) => g.perf >= 2
            ? `${v.Subj} ${v.is} shut down — cold, mottled, and I can barely get a pressure. ${v.Subj} ${v.is} rigoring.`
            : `Still febrile and the pressure has come down since I rang. ${v.Subj} ${v.verb('look')} washed out.`,
          interventions: [
            insult(ctx, { label: 'Septic vasoplegia', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.26, tauOn: 1800, eliminationHalfLife: 36000 }),
            insult(ctx, { label: 'Capillary leak', category: 'scenario', kind: 'scenario', target: 'edv', delta: -20, tauOn: 2400, eliminationHalfLife: 36000 }),
          ],
        },
      ];
    },
    findings: () => (panel) => {
      if (panel === 'CXR') {
        return 'Clear lung fields. No consolidation — note that a neutropenic patient may not form a radiographic infiltrate, ' +
          'so a normal film does not exclude pneumonia here.';
      }
      return null;
    },
    medications: (ctx) => [
      { name: 'Tacrolimus', detail: `${ctx.rng.pick(['1 mg', '1.5 mg', '2 mg'])} IV twice daily — GVHD prophylaxis`, since: 'day +1' },
      { name: 'Posaconazole', detail: '300 mg orally daily — antifungal prophylaxis', since: 'day −1' },
      { name: 'Aciclovir', detail: '400 mg orally twice daily', since: 'day −1' },
      { name: 'Levofloxacin', detail: '500 mg orally daily — antibacterial prophylaxis', since: 'day −1' },
      { name: 'Filgrastim', detail: '300 mcg subcutaneously daily', since: 'day +5' },
      { name: 'Ursodeoxycholic acid', detail: '300 mg orally twice daily', since: 'day −7' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 480, [
        pv('WBC', bySeverity(ctx, 0.4, 0.1), 'K/µL', 2, { low: 4, high: 11, critical: true }),
        pv('Absolute neutrophils', bySeverity(ctx, 0.2, 0.02), 'K/µL', 2, { low: 1.5, critical: true }),
        pv('Hgb', bySeverity(ctx, 8.8, 7.6), 'g/dL', 1, { low: 12 }),
        pv('Platelets', bySeverityInt(ctx, 28, 11), 'K/µL', 0, { low: 150, critical: true }),
      ]),
      prior('CMP', 480, [
        pv('Creatinine', bySeverity(ctx, 0.9, 1.5), 'mg/dL', 2, { high: 1.1 }),
        pv('Potassium', 3.6, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
        pv('Magnesium', 1.5, 'mg/dL', 1, { low: 1.7 }),
        pv('ALT', 62, 'U/L', 0, { high: 40 }),
      ]),
      prior('Tacrolimus level', 480, [pv('Tacrolimus', 11.4, 'ng/mL', 1, { low: 5, high: 12 })]),
    ],
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Day +8 allogeneic transplant, engraftment awaited. Counts at the nadir. Afebrile until this evening. ` +
        `Transplant team round at 08:00.`,
      todo: ['Daily counts.', 'Tacrolimus level with the morning bloods.'],
      contingencies: [
        `Any fever is neutropenic sepsis until proven otherwise. Cultures — peripheral and from each lumen — and broad-spectrum antibiotics within the hour. Do not wait for the cultures.`,
        `${ctx.voice.Subj} ${ctx.voice.has} no neutrophils, so there will be no pus, no infiltrate and no peritonism. The absence of findings means nothing.`,
        'Platelets are low. Avoid intramuscular injections and check before any procedure.',
      ],
      misleading: 'Temperature spiked once this afternoon and settled with paracetamol. Reasonable to give another dose and review in the morning.',
    }),
    expectedOrders: ['lab-cultures', 'pip-tazo', 'ns-1000', 'lab-lactate', 'transfer-icu', 'norepi'],
    contraindicatedOrders: ['acetaminophen', 'ceftriaxone'],
  },

  {
    id: 'sickle-acute-chest',
    label: 'Sickle cell disease — acute chest syndrome',
    tier: 'critical',
    setting: 'academic',
    ageRange: [19, 44],
    span: 3 * HOUR,
    admissionDx: 'Sickle cell vaso-occlusive crisis',
    hiddenDx: 'Acute chest syndrome evolving out of a vaso-occlusive crisis, worsened by under-treated pain and splinting',
    teachingPoint:
      'Acute chest syndrome is what a vaso-occlusive crisis becomes when the patient splints, hypoventilates and ' +
      'atelectases — which is to say it is partly caused by treating the pain too cautiously. Opioids and incentive ' +
      'spirometry are the prevention. The treatment is antibiotics, oxygen and, if it progresses, exchange ' +
      'transfusion rather than simple transfusion. A young patient with a normal blood pressure can be very close to ICU.',
    history: (ctx) => [
      'Sickle cell disease, HbSS',
      ctx.rng.pick(['Three admissions with crisis this year', 'Previous acute chest syndrome, needed exchange', 'Previous ICU admission with acute chest']),
      ctx.rng.pick(['On hydroxyurea', 'On hydroxyurea and voxelotor', 'Hydroxyurea, poorly adherent']),
      'Baseline haemoglobin 8.5',
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(92, 104),
        svr: 13.5,
        edv: ctx.rng.int(106, 116),
        qsQt: bySeverity(ctx, 0.05, 0.09),
      },
      paramOverrides: { hgb: bySeverity(ctx, 8.4, 6.9) },
      rrOffset: 5,
      tempOffset: bySeverity(ctx, 0.2, 0.7),
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${ctx.name} in ${ctx.room} is working hard to breathe and the saturations have dropped. ` +
              `${v.Subj} ${v.verb('say')} the pain has moved into ${v.poss} chest and it hurts to take a breath.`
            : `${ctx.name} in ${ctx.room} is still in a lot of pain and now ${v.subj} ${v.verb('say')} it is in ` +
              `${v.poss} chest as well. ${v.Subj} ${v.is} not taking deep breaths because of it.`,
          interventions: [
            insult(ctx, { label: 'Acute chest: shunt', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.15, tauOn: 3000, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Acute chest: pulmonary vasoconstriction', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 1.2, tauOn: 3000, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 100 * MIN),
          pageWhen: { axis: 'wob', grade: 2 },
          page: (g) => g.wob >= 3
            ? `${v.Subj} ${v.is} exhausted and the saturations are in the low eighties on the mask. I need help in here.`
            : `Worse — ${v.subj} ${v.verb('need')} more oxygen than an hour ago and ${v.subj} can only manage short sentences.`,
          interventions: [
            insult(ctx, { label: 'Acute chest: progression', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.09, tauOn: 3000, eliminationHalfLife: 86400 }),
          ],
          hgbDelta: -0.9 * bloodLossScale(ctx.severity),
        },
      ];
    },
    findings: (_ctx, atHandover) => (panel, snap) => {
      if (panel !== 'CXR') return null;
      const spread = snap.qsQtEffective - atHandover.qsQtEffective;
      if (spread > 0.10) return 'New multilobar airspace opacification, worse than the admission film — acute chest syndrome.';
      if (spread > 0.03) return 'New basal airspace opacification not present on admission.';
      return 'Clear lung fields. Note that the film lags the clinical picture in acute chest syndrome by several hours.';
    },
    medications: (ctx) => [
      { name: ctx.rng.pick(['Hydromorphone PCA', 'Morphine PCA']), detail: 'patient-controlled, 0.2 mg bolus, 8 minute lockout', since: 'admission' },
      { name: 'Ketorolac', detail: '15 mg IV every 6 hours', since: 'admission' },
      { name: 'Hydroxyurea', detail: '1000 mg orally daily', since: 'home medication' },
      { name: 'Folic acid', detail: '5 mg orally daily', since: 'home medication' },
      { name: 'Incentive spirometry', detail: '10 breaths hourly while awake', since: 'admission — poorly done today' },
      { name: 'Maintenance fluids', detail: 'dextrose–saline at 100 mL/h', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 420, [
        pv('WBC', bySeverity(ctx, 12.4, 18.6), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 8.4, 6.9), 'g/dL', 1, { low: 12, critical: true }),
        pv('Platelets', 388, 'K/µL', 0, { low: 150, high: 400 }),
        pv('Reticulocytes', bySeverity(ctx, 8.2, 14.1), '%', 1, { high: 2.5 }),
      ]),
      prior('LDH', 420, [pv('LDH', bySeverityInt(ctx, 420, 780), 'U/L', 0, { high: 250 })]),
    ],
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Sickle cell crisis, day 2. Pain improving on the PCA. Haemoglobin at ${ctx.voice.poss} baseline. ` +
        `Haematology aware, plan is discharge when the pain is oral-manageable.`,
      todo: ['Continue the PCA.', 'Repeat count in the morning.'],
      contingencies: [
        'If the pain moves to the chest, or the oxygen requirement rises, treat it as acute chest syndrome: antibiotics, oxygen and call haematology.',
        'Do not cut the analgesia. Under-treated pain causes splinting, and splinting is how a crisis becomes an acute chest.',
        'If it progresses, the treatment is exchange transfusion, not a simple top-up.',
      ],
      misleading: 'Requesting a lot of opioid. Consider weaning the PCA overnight so they can go home tomorrow.',
    }),
    expectedOrders: ['o2-nc6', 'ceftriaxone', 'img-cxr', 'morphine-comfort', 'hfnc', 'prbc'],
    contraindicatedOrders: ['ns-1000'],
  },

  {
    id: 'cf-exacerbation',
    label: 'Cystic fibrosis pulmonary exacerbation',
    tier: 'ward',
    setting: 'academic',
    ageRange: [19, 41],
    span: 3 * HOUR,
    admissionDx: 'Cystic fibrosis — infective pulmonary exacerbation',
    hiddenDx: 'Pseudomonas exacerbation on a very low respiratory reserve; the trap is their baseline, not their trajectory',
    teachingPoint:
      'These patients know their disease better than you do and their baseline is not yours: a saturation of 91% ' +
      'and an FEV1 of 30% may be exactly where they live. What matters is the delta from their own normal, the ' +
      'airway clearance that nobody remembers to prescribe, and the fact that their antibiotics are chosen from ' +
      'their own sputum history rather than from a guideline.',
    history: (ctx) => [
      'Cystic fibrosis, F508del homozygous',
      ctx.rng.pick(['Chronic Pseudomonas aeruginosa colonisation', 'Chronic Pseudomonas, previous MRSA', 'Pseudomonas and Aspergillus colonisation']),
      `Baseline FEV1 ${bySeverityInt(ctx, 42, 26)}% predicted`,
      ctx.rng.pick(['CF-related diabetes on insulin', 'Pancreatic insufficient, on enzymes', 'Previous pneumothorax']),
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(90, 100),
        svr: 14.5,
        edv: ctx.rng.int(104, 114),
        qsQt: bySeverity(ctx, 0.11, 0.19),
        pvr: 2.6,
      },
      rrOffset: 3,
      tempOffset: 0.3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${ctx.name} in ${ctx.room} is working much harder and coughing constantly without clearing anything. ` +
              `${v.Subj} ${v.verb('say')} this is worse than when ${v.subj} came in.`
            : `${ctx.name} in ${ctx.room} says ${v.subj} ${v.is} more chesty this evening and ${v.subj} ${v.verb('want')} ` +
              `to know whether ${v.subj} can have ${v.poss} physiotherapy again — ${v.subj} ${v.verb('feel')} full of it.`,
          interventions: [
            insult(ctx, { label: 'CF: mucus plugging', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.11, tauOn: 2700, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    findings: () => (panel) =>
      panel === 'CXR'
        ? 'Widespread bronchiectasis with upper lobe predominance, peribronchial thickening and mucus plugging. ' +
          'Chronic changes — compare with the previous films before calling anything new.'
        : null,
    medications: (ctx) => [
      { name: ctx.rng.pick(['Piperacillin–tazobactam', 'Meropenem', 'Ceftazidime']), detail: 'IV, dosed for CF clearance', since: `day ${ctx.rng.int(3, 8)} of 14` },
      { name: 'Tobramycin', detail: 'IV once daily, levels monitored', since: `day ${ctx.rng.int(3, 8)} of 14` },
      { name: 'Elexacaftor–tezacaftor–ivacaftor', detail: 'two tablets in the morning, one in the evening', since: 'home medication' },
      { name: 'Dornase alfa', detail: '2.5 mg nebulised daily', since: 'home medication' },
      { name: 'Hypertonic saline 7%', detail: 'nebulised twice daily, before physiotherapy', since: 'home medication' },
      { name: 'Creon', detail: 'with all meals and snacks', since: 'home medication' },
      { name: 'Airway clearance', detail: 'physiotherapy three times daily — only once today', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('Sputum culture', 2880, [], `Pseudomonas aeruginosa, mucoid. Sensitive to ceftazidime, meropenem and tobramycin; resistant to ciprofloxacin.`),
      prior('Tobramycin level', 360, [pv('Tobramycin trough', 0.6, 'mg/L', 1, { high: 1.0 })]),
      prior('CBC', 600, [
        pv('WBC', bySeverity(ctx, 11.2, 15.8), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 12.4, 'g/dL', 1, { low: 12 }),
        pv('Platelets', 402, 'K/µL', 0, { low: 150, high: 400 }),
      ]),
      prior('VBG', 200, [
        pv('pH', 7.38, '', 2, { low: 7.32, high: 7.42 }),
        pv('pCO₂', bySeverityInt(ctx, 46, 54), 'mmHg', 0, { low: 41, high: 51 }),
        pv('HCO₃', bySeverityInt(ctx, 27, 31), 'mEq/L', 0, { low: 22, high: 26 }),
      ]),
    ],
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary:
        `CF exacerbation, midway through a two-week course of IV antibiotics chosen from ${ctx.voice.poss} sputum ` +
        `sensitivities. Slowly improving. CF team review each morning.`,
      todo: ['Tobramycin level before the morning dose.', 'Physiotherapy three times daily.'],
      contingencies: [
        `${ctx.voice.Subj} ${ctx.voice.verb('sit')} at 90–92% on air. That is ${ctx.voice.poss} baseline — do not chase a normal number and do not put ${ctx.voice.obj} on high-flow oxygen for it.`,
        `${ctx.voice.Subj} ${ctx.voice.verb('know')} ${ctx.voice.poss} own regimen and will tell you if something has been missed. Listen to ${ctx.voice.obj}.`,
        'If more breathless, the first thing to check is whether airway clearance has actually been done.',
      ],
      misleading: 'Saturations have been in the low nineties. Consider oxygen if they drop further.',
    }),
    expectedOrders: ['physio-airway', 'duoneb', 'pip-tazo', 'img-cxr', 'sit-up'],
    contraindicatedOrders: ['morphine-comfort', 'ceftriaxone'],
  },

  {
    id: 'necrotising-pancreatitis',
    label: 'Necrotising pancreatitis',
    tier: 'critical',
    setting: 'academic',
    ageRange: [34, 68],
    span: 4 * HOUR,
    admissionDx: 'Severe acute pancreatitis',
    hiddenDx: 'Necrotising pancreatitis with SIRS, massive third-spacing and evolving ARDS',
    teachingPoint:
      'Severe pancreatitis is a capillary leak, not an infection, for the first several days — antibiotics do ' +
      'nothing and fluid does almost everything, in volumes that feel wrong until you see the urine output. ' +
      'The two organs that fail are the kidneys, from under-resuscitation, and the lungs, from the leak itself. ' +
      'A rising oxygen requirement in the first 48 hours is ARDS, not pneumonia.',
    history: (ctx) => [
      ctx.rng.pick(['Gallstone pancreatitis', 'Alcohol-related pancreatitis', 'Hypertriglyceridaemic pancreatitis']),
      ctx.rng.pick(['CT: 40% pancreatic necrosis', 'CT: 50% necrosis with peripancreatic collections', 'CT: extensive necrosis, no gas']),
      `BISAP ${bySeverityInt(ctx, 2, 4)} on admission`,
      ctx.rng.pick(['Type 2 diabetes', 'Obesity', 'Previous cholecystectomy declined']),
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(96, 108),
        svr: bySeverity(ctx, 14, 13),
        edv: bySeverityInt(ctx, 104, 96),
        noTone: bySeverity(ctx, 0.06, 0.14),
        qsQt: bySeverity(ctx, 0.06, 0.11),
      },
      rrOffset: 4,
      tempOffset: bySeverity(ctx, 0.3, 0.8),
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          pageWhen: { axis: 'either', grade: 1 },
          page: (g) => g.perf >= 2
            ? `${ctx.name} in ${ctx.room} has almost no urine in the bag and the pressure is down. ` +
              `${v.Subj} ${v.is} clammy and the belly is very distended.`
            : `${ctx.name} in ${ctx.room} has only put out about 20 mL an hour since I came on, and the heart rate ` +
              `is up. The belly looks more distended to me than it did at handover.`,
          interventions: [
            insult(ctx, { label: 'Pancreatitis: third-spacing', category: 'scenario', kind: 'scenario', target: 'edv', delta: -34, tauOn: 3000, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'SIRS: vasoplegia', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.34, tauOn: 2700, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 120 * MIN),
          pageWhen: { axis: 'wob', grade: 1 },
          page: (g) => g.wob >= 2
            ? `${v.Subj} ${v.is} working hard to breathe now and needing much more oxygen than earlier.`
            : `${v.Subj} ${v.is} breathing faster than earlier and I have had to put the oxygen up a little.`,
          interventions: [
            insult(ctx, { label: 'ARDS: shunt', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.16, tauOn: 3600, eliminationHalfLife: 86400 }),
          ],
        },
      ];
    },
    findings: (_ctx, atHandover) => (panel, snap) => {
      if (panel !== 'CXR') return null;
      return snap.qsQtEffective - atHandover.qsQtEffective > 0.05
        ? 'New bilateral airspace opacification in a diffuse, peripheral distribution with a normal cardiac silhouette — ' +
          'consistent with acute respiratory distress syndrome rather than with fluid overload.'
        : 'Small bilateral effusions with basal atelectasis. Elevated hemidiaphragms.';
    },
    medications: () => [
      { name: 'Lactated Ringer’s', detail: '200 mL/h — reduced from 300 mL/h this afternoon', since: 'admission' },
      { name: 'Hydromorphone', detail: '0.5 mg IV every 2 hours as needed', since: 'admission' },
      { name: 'Ondansetron', detail: '4 mg IV every 8 hours as needed', since: 'admission' },
      { name: 'Pantoprazole', detail: '40 mg IV daily', since: 'admission' },
      { name: 'Insulin sliding scale', detail: 'subcutaneous, four times daily', since: 'day 2' },
      { name: 'Nasojejunal feed', detail: 'trickle feed at 20 mL/h', since: 'day 2' },
    ],
    priorLabs: (ctx) => [
      prior('CMP', 300, [
        pv('Creatinine', bySeverity(ctx, 1.2, 2.2), 'mg/dL', 2, { high: 1.1 }),
        pv('Urea', bySeverityInt(ctx, 32, 58), 'mg/dL', 0, { high: 20, critical: true }),
        pv('Calcium', bySeverity(ctx, 8.2, 7.1), 'mg/dL', 1, { low: 8.5 }),
        pv('Glucose', bySeverityInt(ctx, 184, 268), 'mg/dL', 0, { high: 140 }),
        pv('Albumin', 2.4, 'g/dL', 1, { low: 3.5 }),
      ]),
      prior('CBC', 300, [
        pv('WBC', bySeverity(ctx, 16.4, 23.8), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', 13.8, 'g/dL', 1, { low: 12 }),
        pv('Haematocrit', bySeverity(ctx, 44, 51), '%', 0, { high: 45 }),
      ]),
      prior('Lactate', 240, [pv('Lactate', bySeverity(ctx, 2.2, 3.6), 'mmol/L', 1, { high: 2.0 })]),
      prior('CRP', 300, [pv('CRP', bySeverityInt(ctx, 210, 380), 'mg/L', 0, { high: 5, critical: true })]),
    ],
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Severe necrotising pancreatitis, day 3. Aggressive fluid resuscitation for the first 48 hours, rate cut ` +
        `back this afternoon. Nasojejunal feed running. Surgery are following but nothing operative planned.`,
      todo: ['Hourly urine output.', 'Repeat the creatinine and calcium in the morning.'],
      contingencies: [
        'If the urine output drops below 0.5 mL/kg/h, give fluid. This is a leak — they need far more than feels reasonable, and the kidneys are what pay for under-resuscitation.',
        'A rising oxygen requirement in the first few days is ARDS from the pancreatitis itself. It is not pneumonia and it does not need antibiotics.',
        `Do not start antibiotics for fever alone. Sterile necrosis is febrile, and infected necrosis does not usually appear before the second week — ${ctx.voice.subj} ${ctx.voice.verb('need')} a CT and a discussion, not an empirical guess.`,
      ],
      misleading: 'Fluid balance is strongly positive already. Would keep the rate where it is and consider a diuretic if the oxygen requirement rises.',
    }),
    expectedOrders: ['ns-1000', 'ns-500', 'vitals-now', 'lab-bmp', 'hold-nephrotoxics', 'transfer-icu'],
    contraindicatedOrders: ['furosemide'],
  },

  {
    id: 'sickle-vaso-occlusive',
    label: 'Sickle cell vaso-occlusive crisis',
    tier: 'ward',
    setting: 'academic',
    ageRange: [19, 46],
    span: 3 * HOUR,
    admissionDx: 'Sickle cell vaso-occlusive crisis',
    hiddenDx: 'An ordinary painful crisis that stays a painful crisis — and is made worse by under-treating the pain',
    teachingPoint:
      'Most crises are just crises. The commonest harm done to these patients overnight is not missing an acute ' +
      'chest — it is treating a person in genuine pain as though they were exaggerating, cutting the analgesia, ' +
      'and producing the splinting that turns a crisis into an acute chest. They know their own regimen and their ' +
      'own doses. The right overnight actions are analgesia, fluids, incentive spirometry, and looking at them.',
    history: (ctx) => [
      'Sickle cell disease, HbSS',
      ctx.rng.pick(['Two admissions with crisis this year', 'Four admissions with crisis this year', 'Usually managed at home']),
      ctx.rng.pick(['On hydroxyurea', 'On hydroxyurea and voxelotor', 'Declined hydroxyurea']),
      `Baseline haemoglobin ${bySeverity(ctx, 9.0, 8.0).toFixed(1)}`,
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(94, 106),
        svr: 13.5,
        edv: ctx.rng.int(106, 116),
        qsQt: bySeverity(ctx, 0.03, 0.06),
      },
      paramOverrides: { hgb: bySeverity(ctx, 9.0, 8.0) },
      rrOffset: 4,
      tempOffset: bySeverity(ctx, 0.1, 0.35),
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.name} in ${ctx.room} is asking for something more for the pain — ${v.subj} ${v.verb('say')} ` +
            `the PCA is not holding ${v.obj} and it is in ${v.poss} back and hips. Observations are unremarkable.`,
          interventions: [
            insult(ctx, { label: 'Crisis: splinting', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.05, tauOn: 3600, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 140 * MIN),
          page: (g) => g.wob >= 1
            ? `${v.Subj} ${v.is} still uncomfortable and not taking deep breaths. ${v.Subj} ${v.verb('sound')} ` +
              `a bit shallow to me, though the saturations are holding.`
            : `The pain is better since the last dose. ${v.Subj} ${v.is} managing the spirometer now and ` +
              `${v.verb('want')} to know when ${v.subj} can go home.`,
        },
      ];
    },
    findings: () => (panel) =>
      panel === 'CXR'
        ? 'Clear lung fields. Cardiomegaly and old infarcted bone changes in the humeral heads — chronic, not acute.'
        : null,
    medications: (ctx) => [
      { name: ctx.rng.pick(['Hydromorphone PCA', 'Morphine PCA']), detail: 'patient-controlled, 0.2 mg bolus, 8 minute lockout', since: 'admission' },
      { name: 'Ketorolac', detail: '15 mg IV every 6 hours', since: 'admission' },
      { name: 'Hydroxyurea', detail: '1000 mg orally daily', since: 'home medication' },
      { name: 'Folic acid', detail: '5 mg orally daily', since: 'home medication' },
      { name: 'Incentive spirometry', detail: '10 breaths hourly while awake', since: 'admission' },
      { name: 'Maintenance fluids', detail: 'dextrose–saline at 100 mL/h', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 480, [
        pv('WBC', bySeverity(ctx, 10.8, 14.2), 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 9.0, 8.0), 'g/dL', 1, { low: 12 }),
        pv('Platelets', 364, 'K/µL', 0, { low: 150, high: 400 }),
        pv('Reticulocytes', 6.8, '%', 1, { high: 2.5 }),
      ]),
      prior('CXR', 1320, [], 'Clear lung fields on admission. No consolidation.'),
    ],
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary:
        `Painful crisis, day 2. Pain slowly improving on the PCA. Haemoglobin at ${ctx.voice.poss} baseline, ` +
        `no chest symptoms. Haematology aware; plan is home once the pain is manageable orally.`,
      todo: ['Continue the PCA and the regular ketorolac.', 'Incentive spirometry hourly while awake.'],
      contingencies: [
        `${ctx.voice.Subj} ${ctx.voice.verb('know')} ${ctx.voice.poss} own doses. If ${ctx.voice.subj} ${ctx.voice.verb('ask')} for more, ${ctx.voice.subj} ${ctx.voice.is} in pain — treat it.`,
        'The thing to watch for is chest pain or a rising oxygen requirement, which would mean acute chest syndrome.',
        'Keep the spirometry going. Splinting is how a crisis becomes an acute chest.',
      ],
      misleading: 'Using a lot of PCA demand. Consider reducing the bolus overnight.',
    }),
    expectedOrders: ['morphine-comfort', 'incentive-spirometry', 'ns-500', 'vitals-now', 'ns-250'],
    contraindicatedOrders: ['lorazepam'],
  },

  {
    id: 'hepatic-encephalopathy',
    label: 'Hepatic encephalopathy',
    tier: 'ward',
    setting: 'academic',
    ageRange: [42, 72],
    span: 4 * HOUR,
    admissionDx: 'Cirrhosis — hepatic encephalopathy',
    hiddenDx: 'Grade 2 encephalopathy with a precipitant nobody has looked for — constipation and a missed lactulose dose',
    teachingPoint:
      'Encephalopathy is not a diagnosis, it is a symptom with a cause, and the overnight job is to find the cause: ' +
      'a missed lactulose dose, constipation, infection, a GI bleed, dehydration, or a sedative somebody prescribed. ' +
      'The two harms available tonight are sedating a confused cirrhotic — which deepens the encephalopathy and can ' +
      'be very hard to reverse — and treating the confusion without looking for what precipitated it.',
    history: (ctx) => [
      ctx.rng.pick(['Alcohol-related cirrhosis, Child-Pugh B', 'NASH cirrhosis, Child-Pugh B', 'Cirrhosis from hepatitis C']),
      `MELD-Na ${bySeverityInt(ctx, 15, 24)}`,
      ctx.rng.pick(['Three previous admissions with encephalopathy', 'Previous encephalopathy, precipitated by constipation', 'First episode was six months ago']),
      ctx.rng.pick(['Oesophageal varices, banded', 'Ascites, controlled on diuretics', 'Portal hypertensive gastropathy']),
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(80, 92),
        // Splanchnic vasodilation, but a haemodynamically well patient. The
        // disease here is neurological, not circulatory, and the model should not
        // pretend otherwise.
        svr: bySeverity(ctx, 14.2, 13.4),
        edv: ctx.rng.int(102, 112),
      },
      // Every cirrhotic here is on a non-selective beta-blocker for their varices,
      // so the blunted chronotropic response belongs in the baseline rather than
      // being drawn as a background condition on top of the drug they are already
      // charted for. Prophylactic dose: blunted, not blocked.
      paramOverrides: { gainHr: 1.1, hgb: bySeverity(ctx, 10.8, 9.6) },
      rrOffset: 2,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.name} in ${ctx.room} is more confused than at handover — ${v.subj} ${v.verb('think')} ` +
            `${v.subj} ${v.is} at work and ${v.subj} ${v.verb('keep')} trying to get out of bed. ` +
            `${v.Subj} ${v.has} that flap when I hold ${v.poss} hands out. Observations are all normal.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 90 * MIN),
          page: `Still muddled and now ${v.subj} ${v.verb('want')} to leave. I have looked back — ${v.subj} ` +
            `${v.has} not opened ${v.poss} bowels in four days and the evening lactulose was not given.`,
        },
        {
          at: jitter(ctx, ctx.declareAt + 200 * MIN),
          page: (g) => g.perf >= 1
            ? `${v.Subj} ${v.is} drowsier now — ${v.subj} ${v.verb('wake')} to voice but ${v.verb('drift')} straight off.`
            : `${v.Subj} ${v.is} settled and sleeping. Nothing further needed.`,
        },
      ];
    },
    findings: () => (panel, snap) => {
      if (panel === 'Ascitic fluid') {
        return snap.noTone > 0.25
          ? null
          : 'Note: the fluid is bland. If the encephalopathy has a precipitant it is not peritonitis.';
      }
      return null;
    },
    medications: (ctx) => [
      { name: 'Lactulose', detail: '30 mL orally three times daily, titrated to three stools — evening dose not given', since: 'home medication' },
      { name: 'Rifaximin', detail: '550 mg orally twice daily', since: 'home medication' },
      { name: 'Spironolactone', detail: '100 mg orally daily', since: 'home medication' },
      { name: ctx.rng.pick(['Propranolol', 'Carvedilol']), detail: 'oral — variceal prophylaxis', since: 'home medication' },
      { name: 'Thiamine', detail: '100 mg orally daily', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CMP', 400, [
        pv('Sodium', bySeverityInt(ctx, 136, 130), 'mEq/L', 0, { low: 135, high: 145 }),
        pv('Potassium', 3.3, 'mEq/L', 1, { low: 3.5, high: 5.1 }),
        pv('Creatinine', bySeverity(ctx, 0.9, 1.4), 'mg/dL', 2, { high: 1.1 }),
        pv('Bilirubin', bySeverity(ctx, 2.4, 5.1), 'mg/dL', 1, { high: 1.2 }),
        pv('Albumin', 2.9, 'g/dL', 1, { low: 3.5 }),
        pv('INR', bySeverity(ctx, 1.4, 1.8), '', 1, { high: 1.1 }),
      ]),
      prior('Ammonia', 400, [pv('Ammonia', bySeverityInt(ctx, 78, 132), 'µmol/L', 0, { high: 35 })]),
      prior('CBC', 400, [
        pv('WBC', 5.8, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 10.8, 9.6), 'g/dL', 1, { low: 12 }),
        pv('Platelets', bySeverityInt(ctx, 104, 68), 'K/µL', 0, { low: 150 }),
      ]),
    ],
    handoff: (ctx) => ({
      severityCall: 'stable',
      summary:
        `Cirrhosis admitted with encephalopathy, day 2. Clearer today than on admission. Back on ${ctx.voice.poss} ` +
        `usual lactulose and rifaximin. Hepatology reviewing in the morning.`,
      todo: ['Chart bowel movements — the lactulose is titrated to three a day.', 'Repeat the sodium in the morning.'],
      contingencies: [
        'If more confused, look for the precipitant before treating the confusion: bowels not open, a missed dose, infection, a bleed, or dehydration.',
        `Do not give ${ctx.voice.obj} a benzodiazepine or an antipsychotic for the agitation. It deepens the encephalopathy and it is hard to undo.`,
        'An ammonia level does not change management. The bowel chart does.',
      ],
      misleading: 'Gets agitated at night. A small dose of lorazepam settled them last admission.',
    }),
    expectedOrders: ['lactulose', 'delirium-precautions', 'lab-cultures', 'lab-cbc', 'rifaximin'],
    contraindicatedOrders: ['lorazepam', 'haloperidol', 'trazodone', 'morphine-comfort', 'quetiapine'],
  },

  {
    id: 'variceal-bleed',
    label: 'Bleeding oesophageal varices',
    tier: 'critical',
    setting: 'academic',
    ageRange: [40, 70],
    span: 3 * HOUR,
    admissionDx: 'Cirrhosis — haematemesis',
    hiddenDx: 'Rebleeding oesophageal varices in portal hypertension — a different disease from a bleeding ulcer',
    teachingPoint:
      'A variceal bleed is a portal pressure problem wearing a haemorrhage costume. Octreotide lowers the pressure ' +
      'driving it, antibiotics are given to every cirrhotic who bleeds because they halve mortality, and the ' +
      'definitive treatment is banding. Transfuse to a haemoglobin of 7 and no higher — over-transfusion raises ' +
      'portal pressure and makes the bleeding worse, which is the one place where more blood is the wrong answer.',
    history: (ctx) => [
      ctx.rng.pick(['Alcohol-related cirrhosis, Child-Pugh B', 'Alcohol-related cirrhosis, Child-Pugh C', 'Cirrhosis from hepatitis C']),
      `MELD-Na ${bySeverityInt(ctx, 16, 26)}`,
      ctx.rng.pick(['Grade 3 oesophageal varices, banded twice', 'Grade 2 varices, banded last month', 'Previous variceal bleed requiring TIPS discussion']),
      'On a non-selective beta-blocker for prophylaxis',
    ],
    baseline: (ctx) => ({
      stateOverrides: {
        hr: ctx.rng.int(88, 98),
        svr: bySeverity(ctx, 13.4, 12.6),
        edv: ctx.rng.int(100, 110),
      },
      // Every cirrhotic here is on a non-selective beta-blocker for their varices,
      // so the blunted chronotropic response belongs in the baseline rather than
      // being drawn as a background condition on top of the drug they are already
      // charted for. Prophylactic dose: blunted, not blocked.
      paramOverrides: { gainHr: 1.1, hgb: bySeverity(ctx, 10.4, 8.0) },
      rrOffset: 4,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: (g) => `${ctx.name} in ${ctx.room} has vomited a cupful of fresh blood. ` +
            (g.perf >= 1 ? `${v.Subj} ${v.is} pale and the heart rate is up.`
              : `${v.Subj} ${v.verb('look')} frightened but the observations are holding for now.`),
          interventions: [
            insult(ctx, { label: 'Variceal bleed: volume loss', category: 'scenario', kind: 'scenario', target: 'edv', delta: -18, tauOn: 1200, eliminationHalfLife: 86400 }),
          ],
          hgbDelta: -1.4 * bloodLossScale(ctx.severity),
        },
        {
          at: jitter(ctx, ctx.declareAt + 85 * MIN),
          urgent: true,
          page: (g) => `${v.Subj} ${v.is} vomiting blood again and there is a lot of it this time. ` +
            (g.perf >= 2 ? `${v.Subj} ${v.is} grey and clammy and I can barely get a pressure.`
              : g.perf >= 1 ? `${v.Subj} ${v.verb('look')} washed out and the pressure is coming down.`
              : `Observations are still holding, but this was a much bigger bleed.`),
          interventions: [
            insult(ctx, { label: 'Variceal rebleed', category: 'scenario', kind: 'scenario', target: 'edv', delta: -30, tauOn: 1800, eliminationHalfLife: 86400 }),
          ],
          // Scaled hard by severity: most variceal rebleeds are a frightening
          // cupful that stops, and the one that does not is a different night.
          hgbDelta: -1.4 * bloodLossScale(ctx.severity) * lerp(ctx.severity, 0.7, 1.8),
        },
      ];
    },
    findings: () => (panel, snap) => {
      if (panel === 'EKG') return null;
      if (panel === 'CXR') return 'Small right effusion. No aspiration change. No free air.';
      if (panel === 'Ascitic fluid' && snap.noTone < 0.2) {
        return 'Bland fluid — no peritonitis. Note that every cirrhotic who bleeds gets prophylactic antibiotics ' +
          'regardless of this result: it halves mortality, and the indication is the bleed, not an infection.';
      }
      return null;
    },
    medications: (ctx) => [
      { name: ctx.rng.pick(['Propranolol', 'Carvedilol']), detail: 'oral — HELD since admission', since: 'home medication, held' },
      { name: 'Pantoprazole', detail: '8 mg/h continuous infusion', since: 'admission' },
      { name: 'Ondansetron', detail: '4 mg IV every 8 hours as needed', since: 'admission' },
      { name: 'Lactulose', detail: '30 mL orally three times daily', since: 'home medication' },
      { name: 'Nil by mouth', detail: 'for endoscopy', since: 'admission' },
    ],
    priorLabs: (ctx) => [
      prior('CBC', 320, [
        pv('WBC', 7.4, 'K/µL', 1, { low: 4, high: 11 }),
        pv('Hgb', bySeverity(ctx, 9.4, 8.0), 'g/dL', 1, { low: 12, critical: true }),
        pv('Platelets', bySeverityInt(ctx, 92, 58), 'K/µL', 0, { low: 150 }),
      ]),
      prior('CMP', 320, [
        pv('Bilirubin', bySeverity(ctx, 2.8, 6.4), 'mg/dL', 1, { high: 1.2 }),
        pv('Albumin', 2.7, 'g/dL', 1, { low: 3.5 }),
        pv('INR', bySeverity(ctx, 1.5, 2.1), '', 1, { high: 1.1 }),
        pv('Creatinine', 1.1, 'mg/dL', 2, { high: 1.1 }),
      ]),
      prior('Endoscopy', 2880, [], 'Three columns of grade 3 oesophageal varices with red wale marks. Four bands applied. Portal hypertensive gastropathy in the fundus.'),
      prior('Type and screen', 900, [], 'Group A positive. Antibody screen negative. Four units crossmatched and held.'),
    ],
    handoff: (ctx) => ({
      severityCall: 'watcher',
      summary:
        `Cirrhosis with a variceal bleed, banded two days ago. No further haematemesis since. Haemoglobin has ` +
        `been stable. Beta-blocker held. Gastroenterology plan repeat banding in two weeks.`,
      todo: ['Repeat haemoglobin at 06:00.', 'Nil by mouth from midnight.'],
      contingencies: [
        `If ${ctx.voice.subj} ${ctx.voice.verb('bleed')} again: octreotide, antibiotics, and call gastroenterology tonight rather than in the morning.`,
        'Transfuse to a haemoglobin of 7 and stop. Over-transfusion raises portal pressure and makes the bleeding worse.',
        'Antibiotics go to every cirrhotic who bleeds, whether or not they look infected. It halves mortality.',
      ],
      misleading: 'If the haemoglobin drops, transfuse up to 10 to give some margin overnight.',
    }),
    expectedOrders: ['octreotide', 'ceftriaxone', 'prbc', 'consult-gi', 'transfer-icu', 'hold-rate-control'],
    contraindicatedOrders: ['ns-1000'],
  },
];

export const ARCHETYPE_BY_ID: Record<string, CaseArchetype> = Object.fromEntries(
  ARCHETYPES.map((a) => [a.id, a]),
);
