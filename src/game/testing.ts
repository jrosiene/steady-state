import { ShiftEngine } from './shift';
import { generateWard } from './content/generate';
import { ARCHETYPE_BY_ID } from './content/archetypes';
import type { Severity } from './content/severity';
import type { PatientCase, PatientRuntime } from './types';

/**
 * Reference helpers for reasoning about generated wards.
 *
 * Once patients are sampled rather than written by hand, a test can no longer say
 * "Brennan is in trouble by 20:10" — there is no Brennan, and 20:10 moves with the
 * seed. Everything here exists so that tests and calibration runs address a case
 * by what it *is* (archetype and severity) and express timing relative to when the
 * case declares, which are the two things that stay true across every shift.
 */

/** Fixed seed for tests that need a stable ward without pinning the content. */
export const TEST_SEED = 'STEADYSTATE';

const MIN = 60;

export interface CaseOptions {
  severity?: Severity;
  seed?: string;
  /** When the case declares. Defaults to early, leaving the shift to play out. */
  declareAt?: number;
}

/** One archetype, alone on the ward, deterministically. */
export function makeCase(archetypeId: string, options: CaseOptions = {}): PatientCase {
  if (!ARCHETYPE_BY_ID[archetypeId]) throw new Error(`Unknown archetype: ${archetypeId}`);
  const ward = generateWard({
    seed: options.seed ?? `${TEST_SEED}:${archetypeId}:${options.severity ?? 'moderate'}`,
    only: [archetypeId],
    severity: options.severity ?? 'moderate',
    declareAt: options.declareAt ?? 20 * MIN,
  });
  return ward.cases[0];
}

export interface SoloShift {
  engine: ShiftEngine;
  patient: PatientRuntime;
  /** Sim-time the case declares itself. */
  declaresAt: number;
}

/** A started shift containing exactly one archetype. */
export function soloShift(archetypeId: string, options: CaseOptions = {}): SoloShift {
  const patientCase = makeCase(archetypeId, options);
  const engine = new ShiftEngine([patientCase], options.seed ?? TEST_SEED);
  engine.start();
  return { engine, patient: engine.patients[0], declaresAt: patientCase.declaresAt };
}

/** Advance the shift by `seconds`, in tick sizes a real frame might produce. */
export function advance(engine: ShiftEngine, seconds: number, tickSec = 30): void {
  const ticks = Math.ceil(seconds / tickSec);
  for (let i = 0; i < ticks; i++) engine.tick(tickSec);
}

/** Advance until the shift clock reaches `simTime`. */
export function advanceTo(engine: ShiftEngine, simTime: number, tickSec = 30): void {
  advance(engine, Math.max(0, simTime - engine.time), tickSec);
}

/**
 * Advance to `minutes` after the case declared.
 *
 * The durable way to express timing: "ninety minutes after the sepsis announced
 * itself" holds for every seed, where "23:30" holds for exactly one.
 */
export function advanceToDeclaration(
  shift: SoloShift,
  minutesAfter: number,
  tickSec = 30,
): void {
  advanceTo(shift.engine, shift.declaresAt + minutesAfter * MIN, tickSec);
}

/** Find a patient on a generated ward by what is wrong with them. */
export function findByArchetype(engine: ShiftEngine, archetypeId: string): PatientRuntime {
  const found = engine.patients.find((p) => p.case.archetypeId === archetypeId);
  if (!found) throw new Error(`No ${archetypeId} on this ward`);
  return found;
}

/** Every patient on the ward carrying a given archetype. */
export function allByArchetype(engine: ShiftEngine, archetypeId: string): PatientRuntime[] {
  return engine.patients.filter((p) => p.case.archetypeId === archetypeId);
}
