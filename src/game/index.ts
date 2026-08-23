export { SimClock } from './clock';
export { SimulationLoop } from './loop';
export type { SimulationState, SnapshotCallback } from './loop';
export { stepPhysics, PHYSICS_DT, WARD_PHYSICS_DT } from './physics';

export { ShiftEngine, isInactive, formatVitals } from './shift';
export { generateWard, WARD_SIZE } from './content/generate';
export type { WardOptions, GeneratedWard } from './content/generate';
export { ARCHETYPES, ARCHETYPE_BY_ID } from './content/archetypes';
export type { CaseArchetype, ArchetypeContext } from './content/archetypes';
export { makeRng, randomSeed } from './content/rng';
export type { Rng } from './content/rng';
export { makeVoice } from './content/voice';
export type { Voice, Gender } from './content/voice';
export {
  SEVERITY_BANDS, bandOf, severityOf, clampSeverity, lerp,
  insultScale, onsetScale, bloodLossScale, sampleSeverity, varyAxis, severityLabel,
} from './content/severity';
export type { Severity, SeverityBand } from './content/severity';
export { COMORBIDITIES, sampleComorbidities } from './content/modifiers';
export type { Comorbidity } from './content/modifiers';
export { ORDERS, ORDER_BY_ID, ORDER_CATEGORIES, O2_LABEL_PREFIX } from './orders';
export { NURSE_QUESTIONS, answerQuestion, vitalsConcern } from './nurse';
export { attendingAdvice, specialtyAdvice } from './consults';
export { buildReport, responseLabel } from './scoring';
export type { PatientDebrief, ShiftReport } from './scoring';
export {
  chartVitals,
  resolveLabPanel,
  describeAppearance,
  acuityLabel,
  clockTime,
  ageLabel,
  isAbnormal,
  bloodPressure,
  respiratoryRate,
  temperature,
} from './clinical';
export * from './types';
