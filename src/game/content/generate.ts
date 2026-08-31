import type { Handoff, HandoffQuality, PatientCase } from '../types';
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

  const chosen = options.only
    ? options.only.map((id) => requireArchetype(id))
    : chooseArchetypes(rng, size);

  // Declaration slots spread across the shift so concerns arrive in sequence
  // rather than all at once, with each case given room to play out before 07:00.
  const slots = options.declareAt !== undefined
    ? chosen.map(() => options.declareAt!)
    : declarationSlots(rng, chosen);
  const nextDemographics = makeCast(rng, chosen.length);

  const cases = chosen.map((archetype, i) => {
    const severity = options.severity !== undefined
      ? clampSeverity(options.severity)
      : pickSeverity(rng, archetype);
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
      hiddenDx: archetype.hiddenDx,
      teachingPoint: archetype.teachingPoint,
      paramOverrides: target.params,
      stateOverrides: target.state,
      tempOffset: base.tempOffset,
      rrOffset: base.rrOffset,
      baselineDrive: respiratoryDrive(computeSnapshot(
        { ...DEFAULT_STATE, ...target.state },
        { ...DEFAULT_PARAMS, ...target.params },
      )),
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

/** Draw archetypes to the composition for this size. */
function chooseArchetypes(rng: Rng, size: number): CaseArchetype[] {
  const want = composition(size);
  const picked = [
    ...drawTier(rng, 'critical', want.critical),
    ...drawTier(rng, 'ward', want.ward),
    ...drawTier(rng, 'benign', want.benign),
  ];
  return rng.shuffle(picked).slice(0, size);
}

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
function drawTier(rng: Rng, tier: CaseArchetype['tier'], count: number): CaseArchetype[] {
  const pool = ARCHETYPES.filter((a) => a.tier === tier);
  const drawn: CaseArchetype[] = [];
  while (drawn.length < count) {
    drawn.push(...rng.shuffle(pool).slice(0, count - drawn.length));
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
function pickSeverity(rng: Rng, archetype: CaseArchetype): Severity {
  if (archetype.tier === 'benign') return sampleSeverity(rng, 0.2, 0.18);
  if (archetype.tier === 'critical') return sampleSeverity(rng, 0.52, 0.42);
  return sampleSeverity(rng, 0.38, 0.36);
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
  'Dr Okafor', 'Dr Lindqvist', 'Dr Nakamura', 'Dr Achterberg', 'Dr Sridhar',
  'Dr Villanueva', 'Dr Considine', 'Ms Halvorsen', 'Mr Trakas', 'Dr Bello',
];

const ROLES = [
  'day intern', 'day resident', 'day hospitalist', 'physician associate',
  'day registrar', 'covering resident',
];

