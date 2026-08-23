import type { PatientRuntime } from './types';
import { ORDER_BY_ID } from './orders';
import { clockTime } from './clinical';

export interface PatientDebrief {
  patient: PatientRuntime;
  /** Whether the patient came through the shift intact. */
  outcomeTone: 'good' | 'mixed' | 'bad';
  outcomeLine: string;
  /** Correct management the player ordered. */
  hits: string[];
  /** Correct management the player missed. */
  misses: string[];
  /** Actively harmful orders the player placed. */
  harms: string[];
  /** Minutes from the patient becoming unstable to the first therapeutic order. */
  responseMinutes: number | null;
  teachingPoint: string;
  hiddenDx: string;
  /** What the day team's written handoff gave the player to work from. */
  handoffNote: string;
}

export interface ShiftReport {
  debriefs: PatientDebrief[];
  died: number;
  arrested: number;
  transferred: number;
  stable: number;
  /** Fraction of expected management captured across all patients, 0–1. */
  managementScore: number;
  harmCount: number;
  medianResponseMinutes: number | null;
  headline: string;
}

/**
 * Build the end-of-shift debrief.
 *
 * The scoring is deliberately not a single number pretending to be objective.
 * What matters pedagogically is the pairing: what was actually happening, what
 * you did about it, and how long it took you — per patient, so the lesson is
 * attached to the case that taught it.
 */
export function buildReport(patients: PatientRuntime[]): ShiftReport {
  const debriefs = patients.map(buildDebrief);

  const died = debriefs.filter((d) => d.patient.status === 'died').length;
  const arrested = debriefs.filter((d) =>
    d.patient.status === 'arrested' ||
    d.patient.messages.some((m) => m.authorName === 'Code blue'),
  ).length;
  const transferred = debriefs.filter((d) => d.patient.location === 'icu' && d.patient.status !== 'died').length;
  const stable = debriefs.filter((d) => d.patient.status !== 'died' && d.patient.location === 'floor').length;

  let expectedTotal = 0;
  let hitTotal = 0;
  for (const d of debriefs) {
    expectedTotal += d.hits.length + d.misses.length;
    hitTotal += d.hits.length;
  }

  const responses = debriefs
    .map((d) => d.responseMinutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  const medianResponseMinutes = responses.length
    ? responses[Math.floor(responses.length / 2)]
    : null;

  const harmCount = debriefs.reduce((n, d) => n + d.harms.length, 0);
  const managementScore = expectedTotal > 0 ? hitTotal / expectedTotal : 1;

  return {
    debriefs,
    died,
    arrested,
    transferred,
    stable,
    managementScore,
    harmCount,
    medianResponseMinutes,
    headline: headline(died, arrested, managementScore, harmCount),
  };
}

function buildDebrief(patient: PatientRuntime): PatientDebrief {
  const placed = new Set(patient.orders.map((o) => o.orderId));

  const hits = patient.case.expectedOrders
    .filter((id) => placed.has(id))
    .map(orderLabel);
  const misses = patient.case.expectedOrders
    .filter((id) => !placed.has(id))
    .map(orderLabel);
  const harms = (patient.case.contraindicatedOrders ?? [])
    .filter((id) => placed.has(id))
    .map(orderLabel);

  const responseMinutes =
    patient.firstUnstableAt !== null && patient.firstActionAt !== null
      ? Math.round((patient.firstActionAt - patient.firstUnstableAt) / 60)
      : null;

  return {
    patient,
    outcomeTone: outcomeTone(patient),
    outcomeLine: patient.outcome?.summary ?? 'Still under your care at handover.',
    hits,
    misses,
    harms,
    responseMinutes,
    teachingPoint: patient.case.teachingPoint,
    hiddenDx: patient.case.hiddenDx,
    handoffNote: handoffNote(patient),
  };
}

/**
 * What the player was working from.
 *
 * Worth naming in the debrief because a thin handoff genuinely changes how hard
 * a case was, and because noticing that you have been handed nothing is a skill
 * in itself — the moment to ask more questions is when the sign-out is short.
 */
function handoffNote(patient: PatientRuntime): string {
  const { handoff } = patient.case;
  const died = patient.status === 'died';
  const missedSeverity = handoff.severity === 'stable' && died;

  if (missedSeverity) {
    return handoff.contingencies.length === 0
      ? 'The day team signed this patient out as stable and left no contingency plan.'
      : 'The day team signed this patient out as stable.';
  }

  switch (handoff.quality) {
    case 'thorough':
      return 'The handoff was thorough, and anticipated what happened.';
    case 'adequate':
      return handoff.contingencies.length === 0
        ? 'The handoff covered the basics but left no contingency plan.'
        : 'The handoff covered the basics, though not what actually happened.';
    default:
      return 'You were handed very little on this patient.';
  }
}

function outcomeTone(patient: PatientRuntime): 'good' | 'mixed' | 'bad' {
  const comfortFocused = patient.orders.some((o) => o.orderId === 'comfort-care');

  if (patient.status === 'died') {
    // A death that was expected, discussed, and managed for comfort is not the
    // same event as a death from an unrecognised deterioration, and the debrief
    // should not pretend otherwise.
    return comfortFocused || patient.case.codeStatus === 'DNR/DNI' ? 'mixed' : 'bad';
  }
  if (patient.messages.some((m) => m.authorName === 'Code blue')) return 'mixed';
  return 'good';
}

function orderLabel(id: string): string {
  return ORDER_BY_ID[id]?.label ?? id;
}

function headline(died: number, arrested: number, score: number, harms: number): string {
  if (died === 0 && arrested === 0 && score > 0.7 && harms === 0) {
    return 'A good night. Everyone you were covering was still there at handover, and the sick ones got what they needed in time.';
  }
  if (died === 0 && arrested === 0) {
    return 'Nobody died on your watch. There is room to be quicker and more decisive, but the shift held.';
  }
  if (died === 0) {
    return 'You had a code but got them back. Look at what the trajectory was doing before the arrest — that is where the shift was decided.';
  }
  if (died === 1) {
    return 'You lost a patient tonight. Work through the debrief below and find the moment the outcome was still open.';
  }
  return 'A hard night with more than one death. The pattern worth studying is which deteriorations you saw late and why.';
}

/** Format a debrief's response time for display. */
export function responseLabel(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes <= 0) return 'immediate';
  return `${minutes} min`;
}

export { clockTime };
