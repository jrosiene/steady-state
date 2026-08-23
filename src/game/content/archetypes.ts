import type { CaseEvent, CodeStatus, HandoffSeverity, InterventionSpec } from '../types';
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
    rrOffset?: number;
  };
  script(ctx: ArchetypeContext): CaseEvent[];
  handoff(ctx: ArchetypeContext): HandoffDraft;
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
          page: `Sorry to bother you — ${ctx.name} in ${ctx.room} has spiked a temperature. ` +
            `${v.Subj} ${v.is} still making sense but ${v.subj} ${v.verb('seem')} a bit off to me.`,
          interventions: [
            insult(ctx, { label: 'Sepsis: inflammatory tone', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.25, tauOn: 900, eliminationHalfLife: 36000 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 80 * MIN),
          urgent: true,
          page: `${v.Subj} ${v.is} confused now — ${v.subj} ${v.isnt} sure where ${v.subj} ${v.is}. ` +
            `The pressure is down and the heart rate is up. I'm worried about ${v.obj}.`,
          interventions: [
            insult(ctx, { label: 'Sepsis: vasoplegia', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.28, tauOn: 1200, eliminationHalfLife: 36000 }),
            insult(ctx, { label: 'Sepsis: third-spacing', category: 'scenario', kind: 'scenario', target: 'edv', delta: -22, tauOn: 1800, eliminationHalfLife: 36000 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 170 * MIN),
          urgent: true,
          page: `${v.Subj} ${v.is} mottled up to the knees and barely rousable. I need someone up here.`,
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
    expectedOrders: ['vitals-now', 'lab-lactate', 'lab-cultures', 'abx', 'ns-1000', 'transfer-icu'],
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
        svr: 14.5,
        edv: ctx.rng.int(100, 112),
        qsQt: bySeverity(ctx, 0.06, 0.14),
        noTone: bySeverity(ctx, 0.07, 0.24),
      },
      rrOffset: 7,
      tempOffset: 0.3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: `${ctx.name} in ${ctx.room} is working harder to breathe and the saturations have come down. ` +
            `${v.Subj} ${v.is} warm to touch and the pressure is softer than it was.`,
          interventions: [
            insult(ctx, { label: 'Pneumonia: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.12, tauOn: 1800, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'Pneumonia: sepsis', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.3, tauOn: 1800, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 110 * MIN),
          urgent: true,
          page: `Getting worse. ${v.Subj} ${v.verb('look')} exhausted and I can barely get a pressure.`,
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
    expectedOrders: ['vitals-now', 'lab-lactate', 'abx', 'ns-1000', 'o2-nc6', 'transfer-icu'],
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
      rrOffset: 7,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: `${ctx.name} in ${ctx.room} is short of breath. The saturations are down and ${v.subj} ${v.isnt} ` +
            `tolerating lying flat. Sounds junky in both bases to me.`,
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
          urgent: true,
          page: `Worse — bolt upright, and ${v.subj} ${v.is} coughing up pink froth. I've put ${v.obj} on a non-rebreather.`,
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
          urgent: true,
          page: `Rapid one — ${ctx.room} just got back from the bathroom and ${v.subj} can't catch ${v.poss} breath. ` +
            `Saturations have dropped right off and the heart rate is up. ${v.Subj} ${v.verb('say')} it hurts to breathe in.`,
          interventions: [
            insult(ctx, { label: 'PE: PVR↑', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 5.5, tauOn: 240, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'PE: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.22, tauOn: 240, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 45 * MIN, 5 * MIN),
          urgent: true,
          page: `The pressure is dropping. ${v.Subj} ${v.is} grey, and ${v.subj} ${v.verb('keep')} telling me ${v.subj} ${v.is} going to die.`,
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
          page: `${v.Subj} ${v.is} bleeding again — the bed is soaked and it's frank blood this time. ${v.Subj} ${v.is} pale and clammy.`,
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
          page: `${ctx.room} woke up with crushing chest pain — ${v.subj} ${v.verb('say')} it's worse than what brought ${v.obj} in. ` +
            `${v.Subj} ${v.is} diaphoretic and grey.`,
          interventions: [
            insult(ctx, { label: 'STEMI: contractility↓', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.95, tauOn: 600, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 60 * MIN, 6 * MIN),
          urgent: true,
          page: `The pressure is down and ${v.subj} ${v.is} short of breath on top of the pain now.`,
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
      rrOffset: 8,
      tempOffset: 0.2,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: `${ctx.name} is wheezing all over and using ${v.poss} accessory muscles. ` +
            `${v.Subj} can only get out a few words at a time.`,
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
    expectedOrders: ['duoneb', 'steroids', 'o2-nc6', 'sit-up', 'bipap'],
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
    expectedOrders: ['vitals-now', 'ns-500', 'lab-bmp'],
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
      rrOffset: 9,
      tempOffset: 0.3,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          page: `${ctx.name} in ${ctx.room} is satting in the high eighties and the breathing looks laboured. ` +
            `${v.Subj} ${v.isnt} distressed exactly, but ${v.subj} ${v.verb('look')} uncomfortable.`,
          interventions: [
            insult(ctx, { label: 'Pneumonia: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.1, tauOn: 3600, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumonia: sepsis', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.22, tauOn: 3600, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 150 * MIN),
          page: `${v.Subj} ${v.is} working harder and the pressure is drifting down. I don't think ${v.subj} ${v.is} going to turn around. ` +
            `Do you want to talk to the family?`,
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
    expectedOrders: ['comfort-care', 'call-attending', 'morphine-comfort', 'delirium-precautions'],
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
      rrOffset: 5,
    }),
    script: (ctx) => {
      const v = ctx.voice;
      return [
        {
          at: ctx.declareAt,
          urgent: true,
          page: `${ctx.name} in ${ctx.room} is more breathless since the drain came out, and the saturations ` +
            `have come down. Air entry sounds much quieter on one side to me.`,
          interventions: [
            insult(ctx, { label: 'Pneumothorax: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.13, tauOn: 1500, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumothorax: intrathoracic pressure', category: 'scenario', kind: 'scenario', target: 'cvp', delta: 8, tauOn: 1800, eliminationHalfLife: 86400 }),
            insult(ctx, { label: 'Pneumothorax: venous return↓', category: 'scenario', kind: 'scenario', target: 'edv', delta: -24, tauOn: 1800, eliminationHalfLife: 86400 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 90 * MIN),
          urgent: true,
          page: `${v.Subj} ${v.is} worse — really struggling now, and the pressure has come down with it.`,
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
          page: `${ctx.name} coughed and choked during the evening meal and now ${v.subj} ${v.verb('sound')} wet and ` +
            `${v.is} desaturating. I've sat ${v.obj} up and suctioned.`,
          interventions: [
            insult(ctx, { label: 'Aspiration: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.15, tauOn: 900, eliminationHalfLife: 43200 }),
            insult(ctx, { label: 'Aspiration: inflammation', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.14, tauOn: 3600, eliminationHalfLife: 43200 }),
          ],
        },
        {
          at: jitter(ctx, ctx.declareAt + 110 * MIN),
          page: `Still needing more oxygen than before, and ${v.subj} ${v.verb('sound')} rattly. Temperature is creeping up.`,
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
    expectedOrders: ['vitals-now', 'delirium-precautions'],
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
    expectedOrders: ['ondansetron', 'acetaminophen', 'bowel-regimen'],
    contraindicatedOrders: ['img-ctpe', 'transfer-icu'],
  },
];

export const ARCHETYPE_BY_ID: Record<string, CaseArchetype> = Object.fromEntries(
  ARCHETYPES.map((a) => [a.id, a]),
);
