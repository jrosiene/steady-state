import type { Handoff, HandoffQuality, PatientCase, Setting } from '../types';
import { SHIFT_DURATION_SEC } from '../types';
import { makeRng, randomSeed, type Rng } from './rng';
import { applyComorbidities, sampleComorbidities } from './modifiers';
import { makeCast } from './demographics';
import { ARCHETYPES, ARCHETYPE_BY_ID, type ArchetypeContext, type CaseArchetype, type HandoffDraft } from './archetypes';
import { bandOf, clampSeverity, sampleSeverity, type Severity } from './severity';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../../engine/constants';
import { snapshot as computeSnapshot } from '../../engine/hemodynamics';
import { respiratoryDrive } from '../clinical';

const MIN = 60;

/** Default ward size. Eight is what one covering doctor is realistically holding. */
export const WARD_SIZE = 8;

/** Largest list the game will deal. Past this the board stops being readable. */
export const MAX_WARD_SIZE = 60;

/**
 * Where the slider starts, and the zero point the severity shift is measured from.
 *
 * Deliberately below the middle. An ordinary night is one where several patients
 * need a decision and it would be uncommon for any of them to die without one;
 * that is the night the game should open on, and it leaves most of the slider's
 * travel above it for the nights that are not ordinary.
 */
export const DEFAULT_ACUITY = 0.35;

/**
 * How far the ends of the acuity slider move the centre of the severity draw.
 *
 * ±0.26 on a scale where 1 is as bad as a case gets. Enough that the quiet end
 * is a night of ward-level problems and the heavy end is one where several
 * patients are genuinely in trouble, without either end becoming a different
 * game: the diseases are the same, and so is the spread around them.
 */
export const ACUITY_SHIFT = 0.26;

/**
 * The composition rule for a night.
 *
 * Fixed ratios rather than a free draw: a ward of eight benign patients is not a
 * shift, and a ward of eight crashing ones is not a shift either — it is a queue.
 * The tension the game is built on needs a majority of quiet patients so that
 * finding the sick one is an act of triage rather than of arithmetic.
 *
 * Acuity grows sub-linearly with the size of the list, which is the part that
 * scaling naively would get wrong. Covering forty patients does not mean five
 * times as many people are dying — it means the same handful of real problems
 * are buried in five times as much noise, and the night is harder because
 * finding them is harder, not because the ward is a mass casualty. The exponents
 * are chosen so that a list of eight reproduces the hand-tuned 3/3/2 exactly.
 */
export function composition(size: number): { critical: number; ward: number; benign: number } {
  const scale = size / WARD_SIZE;
  const critical = Math.max(1, Math.round(3 * scale ** 0.45));
  const ward = Math.max(1, Math.round(3 * scale ** 0.6));
  return { critical, ward, benign: Math.max(0, size - critical - ward) };
}

export interface WardOptions {
  seed?: string;
  size?: number;
  /** Force particular archetypes, for tests and for teaching a specific case. */
  only?: string[];
  /** Force a severity across the ward, for tests. Continuous, 0 to 1. */
  severity?: Severity;
  /** Which service the shift is on. Defaults to community. */
  setting?: Setting;
  /**
   * How sick the ward is, 0 to 1. Defaults to 0.5.
   *
   * Shifts where the severity distribution sits rather than changing what is on
   * the list, so a quiet night is the same diseases caught earlier and milder,
   * not a different ward. See `ACUITY_SHIFT`.
   */
  acuity?: number;
  /** Force when every case declares. Tests use this to get a known clock. */
  declareAt?: number;
}

export interface GeneratedWard {
  seed: string;
  cases: PatientCase[];
}

/**
 * Build one night's ward.
 *
 * Deterministic in the seed: the same seed yields the same eight patients, the
 * same severities, and the same event times. That is what makes generated
 * content testable and a good shift replayable.
 */
export function generateWard(options: WardOptions = {}): GeneratedWard {
  const seed = options.seed ?? randomSeed();
  const rng = makeRng(seed);
  const size = clampWardSize(options.size ?? WARD_SIZE);
  const setting = options.setting ?? 'community';
  const acuity = Math.max(0, Math.min(1, options.acuity ?? DEFAULT_ACUITY));

  const chosen = options.only
    ? options.only.map((id) => requireArchetype(id))
    : chooseArchetypes(rng, size, setting);

  // Declaration slots spread across the shift so concerns arrive in sequence
  // rather than all at once, with each case given room to play out before 07:00.
  const slots = options.declareAt !== undefined
    ? chosen.map(() => options.declareAt!)
    : declarationSlots(rng, chosen);
  const nextDemographics = makeCast(rng, chosen.length);

  const cases = chosen.map((archetype, i) => {
    const severity = options.severity !== undefined
      ? clampSeverity(options.severity)
      : pickSeverity(rng, archetype, acuity);
    const demo = nextDemographics(archetype.ageRange);
    const ctx: ArchetypeContext = {
      severity,
      rng,
      voice: demo.voice,
      name: demo.name,
      room: demo.room,
      age: demo.age,
      declareAt: slots[i],
    };

    // Patients you never hear about.
    //
    // On a list of eight everyone calls, because eight patients who all stay
    // silent is not a shift. On a list of forty that is wrong in a way that
    // matters: most of a cross-cover list is people whose night passes without
    // anyone picking up the phone, and a board where every single patient pages
    // teaches the player that the board is a queue to be worked through rather
    // than a list to be triaged. Only benign cases fall silent — a real problem
    // always declares itself.
    const quiet = archetype.tier === 'benign' && rng.chance(quietChance(size));

    const base = archetype.baseline(ctx);

    // Background physiology, layered on top of whatever is acutely wrong. Most
    // patients carry one or two conditions; they are what make the same insult
    // behave differently in different people.
    const comorbidities = sampleComorbidities(
      rng,
      archetype.id,
      demo.age,
      rng.chance(0.18) ? 0 : rng.chance(0.55) ? 1 : 2,
    );
    const target = {
      params: { ...(base.paramOverrides ?? {}) },
      state: { ...(base.stateOverrides ?? {}) },
    };
    applyComorbidities(comorbidities, target, rng);

    // The patient's own physiology at 19:00 — the comparison film, and the
    // reference for anything that has to reason about change rather than about
    // an absolute.
    const atHandover = computeSnapshot(
      { ...DEFAULT_STATE, ...target.state },
      { ...DEFAULT_PARAMS, ...target.params },
    );

    return {
      id: `${archetype.id}-${demo.room}`,
      archetypeId: archetype.id,
      severity,
      severityBand: bandOf(severity),
      comorbidities: comorbidities.map((c) => c.label),
      name: demo.name,
      age: demo.age,
      sex: demo.voice.marker,
      voice: demo.voice,
      room: demo.room,
      nurse: demo.nurse,
      codeStatus: archetype.codeStatus?.(ctx) ?? 'Full Code',
      allergies: demo.allergies,
      admissionDx: archetype.admissionDx,
      // Comorbidities appear in the history, so the information is available to a
      // player who reads the chart — a beta-blocker is only a trap if it was
      // written down and overlooked.
      history: [...archetype.history(ctx), ...comorbidities.map((c) => c.label)],
      handoff: buildHandoff(rng, archetype, ctx),
      setting: archetype.setting ?? setting,
      medications: archetype.medications?.(ctx) ?? [],
      priorLabs: (archetype.priorLabs?.(ctx) ?? []).map((l, n) => ({
        id: `${demo.room}-prior-${n}`,
        panel: l.panel,
        drawnAt: -l.minutesBefore * MIN,
        resultedAt: -l.minutesBefore * MIN + 40 * MIN,
        values: l.values,
        impression: l.impression,
      })),
      hiddenDx: archetype.hiddenDx,
      teachingPoint: archetype.teachingPoint,
      paramOverrides: target.params,
      stateOverrides: target.state,
      tempOffset: base.tempOffset,
      rrOffset: base.rrOffset,
      baselineDrive: respiratoryDrive(atHandover),
      findings: archetype.findings?.(ctx, atHandover),
      declaresAt: slots[i],
      events: quiet ? [] : archetype.script(ctx).sort((a, b) => a.at - b.at),
      expectedOrders: archetype.expectedOrders,
      contraindicatedOrders: archetype.contraindicatedOrders,
    } satisfies PatientCase;
  });

  // Present the board in room order, the way a real list is kept.
  cases.sort((a, b) => a.room.localeCompare(b.room));
  return { seed, cases };
}

/**
 * The chance a benign patient simply never calls, by list size.
 *
 * Zero at a single ward, rising to roughly half on a long list. Tuned so a list
 * of forty produces a plausible overnight page volume rather than the sum of
 * forty scripts.
 */
function quietChance(size: number): number {
  if (size <= WARD_SIZE) return 0;
  return Math.min(0.55, (size - WARD_SIZE) / 60);
}

/** Ward sizes the generator will honour. */
export function clampWardSize(size: number): number {
  return Math.max(1, Math.min(MAX_WARD_SIZE, Math.round(size)));
}

function requireArchetype(id: string): CaseArchetype {
  const archetype = ARCHETYPE_BY_ID[id];
  if (!archetype) throw new Error(`Unknown archetype: ${id}`);
  return archetype;
}

/** Draw archetypes to the composition for this size and service. */
function chooseArchetypes(rng: Rng, size: number, setting: Setting): CaseArchetype[] {
  const want = composition(size);
  const picked = [
    ...drawTier(rng, 'critical', want.critical, setting),
    ...drawTier(rng, 'ward', want.ward, setting),
    ...drawTier(rng, 'benign', want.benign, setting),
  ];
  return rng.shuffle(picked).slice(0, size);
}

/**
 * How much of an academic list is made of the cases only an academic centre
 * admits, rather than the bread and butter every hospital sees.
 *
 * Not all of it. A quaternary service still admits pneumonia and heart failure;
 * what makes it a different job is that the transplant recipient and the
 * pulmonary hypertension patient are on the same list, and are the ones you
 * cannot reason about from first principles at three in the morning.
 */
const ACADEMIC_SHARE = 0.55;

/**
 * Draw `count` archetypes from one tier, repeating only once the tier is spent.
 *
 * Sampling without replacement is right for a list of eight and impossible for a
 * list of forty — there are four benign archetypes and a big list needs twenty-six
 * of them. Cycling through reshuffled copies of the whole tier keeps the draw even
 * rather than letting the same diagnosis come up four times while another never
 * appears. Two patients sharing an archetype are not the same patient in any case:
 * severity is continuous, comorbidities and demographics are sampled separately,
 * and the handoff is written to a different standard.
 */
function drawTier(
  rng: Rng,
  tier: CaseArchetype['tier'],
  count: number,
  setting: Setting,
): CaseArchetype[] {
  const inTier = ARCHETYPES.filter((a) => a.tier === tier);
  const general = inTier.filter((a) => a.setting === undefined);
  const specialist = inTier.filter((a) => a.setting === 'academic');

  // A community service simply never sees the specialist cases.
  if (setting === 'community' || specialist.length === 0) {
    return fill(rng, general.length > 0 ? general : inTier, count);
  }

  const wanted = Math.round(count * ACADEMIC_SHARE);
  const fromSpecialist = Math.min(count, wanted);
  return rng.shuffle([
    ...fill(rng, specialist, fromSpecialist),
    ...fill(rng, general, count - fromSpecialist),
  ]);
}

/** Draw `count` from `pool`, cycling through reshuffled copies once it is spent. */
function fill(rng: Rng, pool: CaseArchetype[], count: number): CaseArchetype[] {
  const drawn: CaseArchetype[] = [];
  if (pool.length === 0) return drawn;
  // Expanded by weight, so a case that is genuinely uncommon on a night list
  // turns up at roughly the rate it does in life. A right ventricle failing for
  // the first time overnight happens; it does not happen every third shift.
  const bag: CaseArchetype[] = pool.flatMap(
    (a) => Array<CaseArchetype>(Math.max(1, Math.round((a.weight ?? 1) * 4))).fill(a),
  );

  while (drawn.length < count) {
    // One pass takes distinct archetypes only, so a ward never carries the same
    // diagnosis twice while the pool still has something unused. Weighting biases
    // which of them the pass reaches first, because a heavier archetype has more
    // copies in the bag and so a likelier early position in the shuffle.
    const takenThisPass = new Set<CaseArchetype>();
    for (const archetype of rng.shuffle(bag)) {
      if (drawn.length >= count) break;
      if (takenThisPass.has(archetype)) continue;
      takenThisPass.add(archetype);
      drawn.push(archetype);
    }
  }
  return drawn;
}

/**
 * Severity, drawn continuously and biased by what the archetype is for.
 *
 * Critical cases centre just below the midpoint so most nights are survivable,
 * with a long enough tail that a genuinely dangerous one turns up often enough to
 * matter. Ward-level cases sit lower. Benign cases have no severity worth
 * speaking of.
 */
function pickSeverity(rng: Rng, archetype: CaseArchetype, acuity: number): Severity {
  // Acuity slides the centre of the distribution; the spread is untouched, so
  // even a quiet night can turn up one genuinely sick patient and a heavy one
  // still has patients who are fine. A difficulty setting that removed the
  // variance would remove the triage.
  //
  // The centres sit low on purpose. Admitted ward patients are robust: it is
  // uncommon for one to be on a trajectory that ends in death before morning
  // without anybody doing anything, and much more common for several to need a
  // decision overnight that changes how the night goes. The first calibration
  // conflated those, and produced a default night where a ward of eight left
  // completely alone lost two patients — and where even the quietest setting on
  // the slider lost one in nearly two thirds of wards. A "critical" tier names
  // what a case *can* do at the top of its range, not what it usually does.
  const shift = (acuity - DEFAULT_ACUITY) * 2 * ACUITY_SHIFT;

  // These centres are read at DEFAULT_ACUITY, where the shift is zero — so they
  // are the ordinary night, not the middle of the slider's travel.
  if (archetype.tier === 'benign') return sampleSeverity(rng, 0.15 + shift * 0.4, 0.16);
  if (archetype.tier === 'critical') return sampleSeverity(rng, 0.21 + shift, 0.34);
  return sampleSeverity(rng, 0.24 + shift * 0.8, 0.32);
}

/**
 * When each case declares itself.
 *
 * Cases are spread across the usable part of the shift and nudged apart, so the
 * player faces a sequence of problems rather than a simultaneous pile-up. Each
 * slot leaves room for the case to run its course before the shift ends.
 */
function declarationSlots(rng: Rng, chosen: CaseArchetype[]): number[] {
  const earliest = 12 * MIN;
  const order = rng.shuffle(chosen.map((_, i) => i));
  const slots: number[] = new Array(chosen.length);

  order.forEach((caseIndex, position) => {
    const archetype = chosen[caseIndex];
    // Leave an hour after the last scripted beat so outcomes land inside the shift.
    const latest = Math.max(earliest, SHIFT_DURATION_SEC - archetype.span - 60 * MIN);
    const band = (latest - earliest) / Math.max(1, chosen.length);
    const start = earliest + band * position;
    slots[caseIndex] = Math.round(Math.min(latest, start + rng.real(0, band * 0.85)));
  });

  return slots;
}

/**
 * Turn the archetype's full draft into the handoff that actually got written.
 *
 * Quality is sampled, so the same clinical case can arrive well or badly handed
 * over on different nights. A thorough sign-out carries everything; an adequate
 * one keeps a single line — and where the day team had anchored on the wrong
 * diagnosis, that line is the confidently wrong one, which is more dangerous than
 * silence. A thin one leaves the night doctor with nothing to work from.
 */
function buildHandoff(rng: Rng, archetype: CaseArchetype, ctx: ArchetypeContext): Handoff {
  const draft: HandoffDraft = archetype.handoff(ctx);
  const quality = pickQuality(rng, archetype);
  const author = `${rng.pick(AUTHORS)}, ${rng.pick(ROLES)}`;

  let contingencies: string[];
  switch (quality) {
    case 'thorough':
      contingencies = draft.contingencies;
      break;
    case 'adequate':
      contingencies = draft.misleading
        ? [draft.misleading]
        : draft.contingencies.slice(0, 1);
      break;
    default:
      contingencies = [];
  }

  return {
    author,
    severity: quality === 'thin' ? downgrade(draft.severityCall) : draft.severityCall,
    summary: draft.summary,
    // A thin handoff loses the detail as well as the planning.
    todo: quality === 'thin' ? draft.todo.slice(0, 1) : draft.todo,
    contingencies,
    quality,
  };
}

/**
 * How well this patient got handed over.
 *
 * Independent of how sick they are, which is the observation worth encoding:
 * sign-out quality tracks how much time the day team had and how interesting they
 * found the patient, not how much trouble the night is about to bring.
 */
function pickQuality(rng: Rng, archetype: CaseArchetype): HandoffQuality {
  const roll = rng.next();
  if (archetype.tier === 'benign') {
    // Nobody is rushed writing up the patient going home tomorrow.
    return roll < 0.55 ? 'thorough' : 'adequate';
  }
  return roll < 0.3 ? 'thorough' : roll < 0.68 ? 'adequate' : 'thin';
}

/** A rushed sign-out also under-calls how sick the patient is. */
function downgrade(severity: Handoff['severity']): Handoff['severity'] {
  return severity === 'unstable' ? 'watcher' : 'stable';
}

const AUTHORS = [
  'Dr. Okafor', 'Dr. Lindqvist', 'Dr. Nakamura', 'Dr. Achterberg', 'Dr. Sridhar',
  'Dr. Villanueva', 'Dr. Considine', 'Dr. Halvorsen', 'Trakas, NP', 'Bello, PA-C',
];

const ROLES = [
  'day intern', 'day resident', 'day hospitalist', 'PGY-2',
  'nocturnist signing out', 'teaching service resident',
];

