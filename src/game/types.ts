import type {
  HemodynamicState,
  HemodynamicParams,
  Intervention,
  InterventionKind,
  Snapshot,
} from '../engine/types';
import type { Severity, SeverityBand } from './content/severity';
import type { Voice } from './content/voice';
// Type-only, and therefore erased: clinical.ts owns the bedside grading, and a
// scripted page now has to be able to speak in its terms.
import type { Gestalt } from './clinical';

// ─── Time ───────────────────────────────────────────────────────────────────

/** Shift starts at 19:00 and runs 12 hours to 07:00. Sim-time 0 = 19:00. */
export const SHIFT_START_HOUR = 19;
export const SHIFT_DURATION_SEC = 12 * 3600;

// ─── Clinical observations ──────────────────────────────────────────────────

/**
 * A recorded set of vitals — what the nurse actually measured and charted.
 *
 * The player never sees live physiology on a floor patient; they see the last
 * charted set and how stale it is. This gap between the true state and the
 * observed state is the central tension of the game.
 */
export interface Vitals {
  /** Sim-time (seconds since shift start) the vitals were taken. */
  time: number;
  hr: number;
  sbp: number;
  dbp: number;
  map: number;
  rr: number;
  spo2: number;
  tempC: number;
  /** O2 delivery device in place when measured, e.g. "RA", "2L NC". */
  o2: string;
}

/** One analyte within a lab panel. */
export interface LabValue {
  label: string;
  value: number;
  unit: string;
  decimals: number;
  /** Reference range used to flag the value. */
  low?: number;
  high?: number;
  /** True when the value should be highlighted as critical, not merely abnormal. */
  critical?: boolean;
}

/** A resulted lab panel. */
export interface LabResult {
  id: string;
  panel: string;
  drawnAt: number;
  resultedAt: number;
  values: LabValue[];
  /** Narrative read for imaging/EKG-style results that aren't numeric. */
  impression?: string;
}

/** A lab that has been ordered but has not resulted yet. */
export interface PendingLab {
  orderId: string;
  panel: string;
  drawnAt: number;
  resultsAt: number;
}

// ─── Messaging ──────────────────────────────────────────────────────────────

export type MessageAuthor = 'nurse' | 'doctor' | 'system';

export type MessageKind =
  | 'page'      // nurse-initiated concern
  | 'reply'     // nurse answering a question
  | 'ack'       // nurse acknowledging an order
  | 'vitals'    // charted vitals posted to the thread
  | 'result'    // lab/imaging result posted
  | 'order'     // the player's order, echoed into the thread
  | 'question'  // the player's question
  | 'event';    // system narration (arrest, transfer, death)

export interface ChatMessage {
  id: string;
  author: MessageAuthor;
  authorName: string;
  text: string;
  time: number;
  kind: MessageKind;
  /** Urgent messages drive the unread badge and the triage list ordering. */
  urgent?: boolean;
}

// ─── Orders ─────────────────────────────────────────────────────────────────

export type OrderCategory =
  | 'comfort'
  | 'fluids'
  | 'pressors'
  | 'respiratory'
  | 'meds'
  | 'labs'
  | 'imaging'
  | 'nursing'
  | 'disposition';

/**
 * A physiologic effect an order produces, as a template.
 * Becomes a real `Intervention` once stamped with a start time.
 */
export interface InterventionSpec {
  label: string;
  category: 'scenario' | 'treatment';
  kind: InterventionKind;
  target: keyof HemodynamicState;
  delta: number;
  tauOn: number;
  eliminationHalfLife: number;
}

export interface OrderDef {
  id: string;
  label: string;
  category: OrderCategory;
  /** Short clinical description shown in the order palette. */
  detail: string;
  /**
   * Sim-seconds between placing the order and the physiologic effect starting.
   * Models the real latency of nursing, pharmacy verification, and administration.
   */
  leadTimeSec: number;
  /**
   * What the nurse says back when the order is placed.
   *
   * A function where the reply needs to refer to the patient, so acknowledgements
   * read correctly for whoever the order was actually placed on.
   */
  ack: string | ((v: Voice) => string);
  interventions?: InterventionSpec[];
  /** For diagnostic orders: the panel to resolve and how long it takes. */
  lab?: { panel: string; turnaroundSec: number };
  /** Vasoactive infusions cannot be run on a general medical floor. */
  requiresIcu?: boolean;
  /** Orders that only make sense once (intubation, transfer). */
  once?: boolean;
  /** Raises Hgb — handled specially since Hgb is a param, not a state variable. */
  raisesHgb?: number;
  /** Marks the patient as continuously monitored (live vitals). */
  startsMonitoring?: boolean;
  /** Changes the charted O2 delivery device. */
  o2Device?: string;
  /**
   * Hours of antipyresis (°C suppression of the charted temperature) this order
   * provides. It lowers the number on the chart without touching the inflammatory
   * process driving it — which is exactly the clinical trap worth modelling.
   */
  antipyreticHours?: number;
}

/** An order the player has actually placed. */
export interface PlacedOrder {
  id: string;
  orderId: string;
  label: string;
  category: OrderCategory;
  placedAt: number;
  effectiveAt: number;
}

// ─── Cases ──────────────────────────────────────────────────────────────────

/**
 * The kind of service the shift is on.
 *
 * Not a difficulty setting. A community hospital and a quaternary academic centre
 * see genuinely different patients: the community list is the bread and butter of
 * internal medicine, while the academic list carries the people nobody else can
 * look after — pulmonary hypertension, decompensated cirrhosis, transplant
 * recipients, cystic fibrosis, sickle cell disease. Those cases are not harder
 * versions of the community ones; they are different diseases with different
 * physiology and different traps.
 */
export type Setting = 'community' | 'academic';

/** A medication the day team already has running. */
export interface InheritedMed {
  name: string;
  /** Dose and route, as it reads on the chart. */
  detail: string;
  /** How long it has been going — "day 3 of 7", "since admission". */
  since: string;
}

/**
 * A result the day team already has.
 *
 * Authored rather than simulated, because it is a historical fact the player is
 * inheriting rather than a measurement they are taking: the shift does not model
 * the two days before it started, and the reason a covering doctor reads the
 * afternoon gas is precisely that they were not there for it.
 */
export interface PriorLab {
  panel: string;
  /** Minutes before the shift began. */
  minutesBefore: number;
  values: LabValue[];
  impression?: string;
}

/**
 * When a nurse actually picks up the phone.
 *
 * An insult applied at time T does not produce a patient who looks unwell at
 * time T — it produces one who looks unwell as the insult ramps in over the next
 * ten or twenty minutes, and at a low severity it may never produce one at all.
 * Pages used to fire on the same schedule as the insults they described, so the
 * nurse announced a patient who was "using accessory muscles, only a few words at
 * a time" at the exact moment that patient was still comfortable and conversant
 * — and stayed comfortable, on every other channel the player could check.
 *
 * A page carrying a trigger is held back until the bedside catches up.
 */
export interface PageTrigger {
  /** Which axis of the bedside look this page is about. */
  axis: 'wob' | 'perf' | 'either';
  /** Hold until that axis reaches this grade. Defaults to 1 — visibly not right. */
  grade?: 1 | 2 | 3;
  /**
   * Send anyway this many sim-seconds after `at`.
   *
   * A nurse asked to keep an eye on someone rings eventually even if the numbers
   * never move; what changes is what they say, because the text is written
   * against the grade they actually find.
   */
  by?: number;
}

/** A message queued to arrive at a later sim-time. */
export interface PendingMessage {
  at: number;
  author: MessageAuthor;
  authorName: string;
  text: string;
  kind: MessageKind;
  urgent: boolean;
  /** Read on arrival — acknowledgements are not news. */
  silent: boolean;
}

/** A scripted beat in a case's illness trajectory. */
export interface CaseEvent {
  /** Sim-seconds after shift start when this fires. */
  at: number;
  /** Physiologic insult applied at this moment. */
  interventions?: InterventionSpec[];
  /**
   * Nurse page. Given as a function when the words depend on how the patient
   * looks by the time the call is actually made.
   */
  page?: string | ((gestalt: Gestalt) => string);
  /**
   * Hold the page until the physiology is visible at the bedside.
   *
   * When set, `urgent` is derived at send time from the grade the nurse finds
   * rather than authored, so a mild exacerbation is a routine call and a severe
   * one is a rapid response — from the same line of script.
   */
  pageWhen?: PageTrigger;
  urgent?: boolean;
  /**
   * Change in haemoglobin (g/dL) at this moment — blood loss.
   * Hgb is a parameter rather than a state variable, so bleeding is applied
   * directly to params instead of through the intervention overlay.
   */
  hgbDelta?: number;
}

export type CodeStatus = 'Full Code' | 'DNR/DNI' | 'DNR, OK to intubate';

/** The day team's illness-severity call. Not always right. */
export type HandoffSeverity = 'stable' | 'watcher' | 'unstable';

/**
 * How complete the written handoff is.
 *
 * Recorded so the debrief can say what the player was working from. Handoff
 * quality tracks how interesting the day team found the patient far more than it
 * tracks how sick they are, which is why the fullest sign-out on this ward is on
 * the woman with cellulitis and the thinnest are on two of the people who die.
 */
export type HandoffQuality = 'thorough' | 'adequate' | 'thin';

/**
 * The written sign-out, in the shape a real one takes: a one-liner, the jobs left
 * for overnight, and the "if this happens, do that" planning that is the first
 * thing to get dropped when the day team is busy.
 *
 * The absences matter as much as the content. An empty contingency list is not a
 * formatting artefact — it is the day team having failed to think past the end of
 * their own shift, and the player should be able to see that they are working
 * without a net.
 */
export interface Handoff {
  /** Who wrote it, and how senior they are. */
  author: string;
  /** The day team's own read on how sick this patient is. */
  severity: HandoffSeverity;
  /** The one-line summary: why they are here and where they have got to. */
  summary: string;
  /** Jobs explicitly left for the night. */
  todo: string[];
  /** Anticipatory guidance. Frequently missing, occasionally wrong. */
  contingencies: string[];
  quality: HandoffQuality;
}

export interface PatientCase {
  /** Unique within a ward. Not stable across seeds — use archetypeId in tests. */
  id: string;
  /**
   * Stable identifier for the clinical content, independent of who has it.
   *
   * This is the durable handle: patient names, ages and rooms are sampled per
   * shift, so anything that needs to refer to a case — a test, the debrief, a
   * calibration run — refers to the archetype and severity instead.
   */
  archetypeId: string;
  /** How hard this instance bites tonight, continuous from 0 to 1. */
  severity: Severity;
  /** Coarse label for the same thing, for display and grouping. */
  severityBand: SeverityBand;
  /** Background conditions this patient brought with them. */
  comorbidities: string[];
  name: string;
  age: number;
  /** Charted sex marker. */
  sex: string;
  /** Pronouns and verb agreement, so generated prose reads correctly. */
  voice: Voice;
  room: string;
  nurse: string;
  codeStatus: CodeStatus;
  allergies: string;
  /** The working diagnosis on the handoff — may be wrong. */
  admissionDx: string;
  history: string[];
  /** Written sign-out from the day team. */
  handoff: Handoff;
  /** The real problem. Revealed only in the debrief. */
  hiddenDx: string;
  /** What this case is meant to teach. Shown in the debrief. */
  teachingPoint: string;
  /** Patient-specific physiology tuning. */
  paramOverrides?: Partial<HemodynamicParams>;
  stateOverrides?: Partial<HemodynamicState>;
  /** Baseline temperature offset (°C) added to the inflammation-derived temp. */
  tempOffset?: number;
  /**
   * Baseline respiratory rate offset (breaths/min).
   *
   * Chronic lung disease is modelled — shunt and congestion drive ventilation
   * directly — so this carries only what the model has no representation for:
   * pain, deconditioning, frailty, anxiety. A resting tachypnoea is often the
   * first thing a nurse notices, and it should come from the right place.
   */
  rrOffset?: number;
  /**
   * This patient's ventilatory drive at the moment they were handed over.
   *
   * The reference against which work of breathing is judged. Without it, a
   * patient whose chronic lung disease already puts them at a shunt fraction of
   * 0.15 reads as working hard while they sleep, and the one signal that should
   * mean "something changed" means nothing at all. Computed once at generation,
   * from the case's own baseline physiology.
   */
  baselineDrive: number;
  /**
   * Sim-time at which this case first declares itself.
   *
   * Recorded explicitly so that anything reasoning about the case — a test, the
   * calibration harness — can express itself relative to the moment the problem
   * starts, rather than against a wall-clock time that changes with every seed.
   */
  declaresAt: number;
  /** Which service this patient turned up on. */
  setting: Setting;
  /**
   * What the day team has running.
   *
   * You cannot decide whether to broaden antibiotics without knowing what is
   * already up, or whether a rate is a new problem without knowing they are on a
   * beta-blocker. Inherited orders are the part of a handover that survives
   * whatever the written summary left out.
   */
  medications: InheritedMed[];
  /** Results the day team already has, from before the shift started. */
  priorLabs: LabResult[];
  /** Illness script. */
  events: CaseEvent[];
  /**
   * Findings this particular case can show on a diagnostic study, once the
   * physiology that produces them is actually present.
   *
   * The generic readings in `resolveLabPanel` know only what the engine models —
   * wedge pressure, shunt, pulmonary vascular resistance — which left whole
   * classes of disease radiographically and electrically silent. An infarct could
   * not put ST elevation on an EKG, a pneumothorax could not appear on a chest
   * film, and a lobar pneumonia read as clear lung fields. A player who ordered
   * the right test got nothing back and reasonably concluded the test was
   * decorative.
   *
   * Gated on state, never on the hidden label: the finding appears when the
   * insult that causes it has taken hold, and a study ordered before that is
   * genuinely, informatively normal.
   */
  findings?: (panel: string, snap: Snapshot) => string | null;
  /** Order ids that represent correct management, for the debrief. */
  expectedOrders: string[];
  /** Order ids that are actively harmful in this case, for the debrief. */
  contraindicatedOrders?: string[];
}

// ─── Runtime ────────────────────────────────────────────────────────────────

export type PatientLocation = 'floor' | 'icu';

/**
 * Presenting rhythm at the arrest.
 *
 * Not cosmetic: shockable rhythms carry markedly better outcomes than PEA or
 * asystole, and which one a patient arrests in follows from how they got there.
 * A primary cardiac event tends to fibrillate; a patient who has been bleeding or
 * obstructed for an hour arrests in PEA; one who has been profoundly acidotic for
 * longer than that arrests in asystole.
 */
export type CodeRhythm = 'VF' | 'pulseless VT' | 'PEA' | 'asystole';

/**
 * A running resuscitation.
 *
 * The code team is physically at the bedside and runs ACLS themselves — the
 * covering doctor is on the phone and does not direct compressions. What the
 * player's decisions determine is the ground the code starts from: whether the
 * arrest was witnessed and monitored, whether the reversible cause had been
 * treated, and how acidotic the patient already was. Those are the things that
 * actually move survival, and they were all decided before the pulse was lost.
 */
export interface CodeState {
  startedAt: number;
  /** Completed two-minute ACLS cycles. */
  cycle: number;
  /** Sim-time of the next rhythm check. */
  nextCycleAt: number;
  rhythm: CodeRhythm;
  shocks: number;
  epiDoses: number;
  intubated: boolean;
  /** Monitored or directly observed at the moment of arrest. */
  witnessed: boolean;
  /** Whether the underlying cause was being treated. Re-checked each cycle. */
  causeAddressed: boolean;
}

export type PatientStatus =
  | 'stable'
  | 'arrested'
  | 'died'
  | 'transferred';

export interface PatientOutcome {
  status: PatientStatus;
  /** Sim-time the outcome was determined. */
  at: number;
  summary: string;
}

/**
 * A non-physiologic order effect waiting for its lead time to elapse
 * (arrival in the ICU, telemetry going on, blood finishing transfusing).
 * Physiologic effects need no queue — their interventions are start-time stamped.
 */
export interface PendingEffect {
  at: number;
  orderId: string;
}

/** Live per-patient state owned by the shift engine. */
export interface PatientRuntime {
  case: PatientCase;
  state: HemodynamicState;
  params: HemodynamicParams;
  interventions: Intervention[];
  location: PatientLocation;
  status: PatientStatus;
  /**
   * Haemoglobin the patient is trending toward (g/dL).
   *
   * Bleeding and transfusion both move haemoglobin over tens of minutes, not
   * instantly. Stepping `params.hgb` directly would drop oxygen-carrying capacity
   * between one tick and the next, which crashes SvO2 hard enough to trip the
   * acidosis feedback loop and kill a patient faster than any treatment could
   * physically arrive.
   */
  hgbTarget: number;
  /** Continuous telemetry — when true the player sees live vitals. */
  monitored: boolean;
  o2Device: string;
  lastVitals: Vitals | null;
  labs: LabResult[];
  pendingLabs: PendingLab[];
  messages: ChatMessage[];
  orders: PlacedOrder[];
  pendingEffects: PendingEffect[];
  /**
   * Nurse replies not yet sent.
   *
   * A nurse is a person at the other end of a phone, not a return value. Posting
   * their acknowledgement in the same frame as the order made the ward feel like
   * a form submission, and a set of observations that appeared the instant it was
   * asked for quietly implied nobody had to walk anywhere to take it.
   */
  pendingMessages: PendingMessage[];
  unread: number;
  /**
   * Sim-time until which an antipyretic is suppressing the charted temperature.
   *
   * Paracetamol treats the number, not the sepsis. A player who gives it and then
   * reads the chart to decide how the patient is doing has blinded one of their
   * own instruments while the inflammatory process carries on underneath.
   */
  antipyreticUntil: number;
  /**
   * Sim-time the player last opened this thread.
   *
   * Message-level read state, rather than just a count, so the UI can ask the
   * precise question it needs: is there an *urgent* page here that the player
   * has not yet seen?
   */
  lastReadAt: number;
  /** Indices of case events already fired. */
  firedEvents: number[];
  /**
   * Pages whose insult has been applied but whose words are not true yet.
   *
   * Each entry is the index of a case event carrying a `pageWhen` trigger,
   * waiting for the patient to actually look the way the page describes.
   */
  pendingPages: { event: number; sendBy: number }[];
  /** Sim-time of the last nurse-initiated page, for escalation pacing. */
  lastPageAt: number;
  /**
   * The worst bedside grade the nurse has already communicated.
   *
   * The reference for calling back: a nurse rings when the patient is worse than
   * the last thing they said, not on a timer, and not again about a picture the
   * doctor already has.
   */
  reportedGrade: number;
  /** Sim-time of the last charted vitals, for routine-rounds pacing. */
  lastVitalsAt: number;
  /** Sim-time the patient first met shock criteria — drives late-recognition scoring. */
  firstUnstableAt: number | null;
  /** Sim-time the player first placed a therapeutic order after instability. */
  firstActionAt: number | null;
  /** Sim-time a rapid response was called, if ever. */
  rapidResponseAt: number | null;
  /** The running resuscitation, while one is in progress. */
  code: CodeState | null;
  /** How many times circulation has been restored tonight. */
  roscCount: number;
  /** Sim-time of the most recent ROSC, for recognising an immediate re-arrest. */
  lastRoscAt: number | null;
  outcome: PatientOutcome | null;
}

/** Everything the UI needs to render one patient, computed per frame. */
export interface PatientView {
  runtime: PatientRuntime;
  /** True physiology — only surfaced to the UI when monitored or in ICU. */
  snapshot: Snapshot;
  /** Vitals the player is entitled to see right now. */
  displayVitals: Vitals | null;
  /** Seconds since displayVitals were taken. */
  vitalsAgeSec: number;
  live: boolean;
}

export type ShiftPhase = 'briefing' | 'running' | 'ended';
