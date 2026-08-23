import type { HemodynamicParams, HemodynamicState } from '../../engine/types';
import type { Rng } from './rng';

/**
 * Background physiology the patient brought with them.
 *
 * Comorbidities are orthogonal to what is acutely wrong, and they change how the
 * same insult plays out — which is where most of the variety in a real ward comes
 * from. A patient on a beta-blocker does not mount a tachycardia when they bleed;
 * one with chronic lung disease starts closer to the edge of their oxygen
 * reserve. Sampling a couple of these per patient multiplies the space far more
 * cheaply than writing more archetypes, and each one is a real clinical trap
 * rather than a stat adjustment.
 */
export interface Comorbidity {
  id: string;
  /** Appears in the past medical history. */
  label: string;
  /** Relative sampling weight. */
  weight: number;
  minAge?: number;
  /** Archetypes that already imply this, so it is not doubled up. */
  skipFor?: string[];
  apply(ctx: ModifierTarget, rng: Rng): void;
}

export interface ModifierTarget {
  params: Partial<HemodynamicParams>;
  state: Partial<HemodynamicState>;
}

export const COMORBIDITIES: Comorbidity[] = [
  {
    id: 'beta-blocked',
    label: 'On a beta-blocker',
    weight: 3,
    minAge: 45,
    apply(t, rng) {
      // The important one. A blunted chronotropic response means the tachycardia
      // that normally announces hypovolaemia never arrives, and the patient looks
      // deceptively well right up until the pressure goes.
      t.params.gainHr = (t.params.gainHr ?? 1.5) * rng.real(0.35, 0.55);
      t.params.hrMax = 155;
      t.state.hr = (t.state.hr ?? 70) - rng.int(8, 16);
    },
  },
  {
    id: 'ckd',
    label: 'Chronic kidney disease',
    weight: 2.5,
    minAge: 50,
    skipFor: ['urosepsis'],
    apply(t, rng) {
      // Anaemia of chronic disease narrows the oxygen-delivery margin.
      t.params.hgb = (t.params.hgb ?? 15) - rng.real(1.8, 3.2);
    },
  },
  {
    id: 'frailty',
    label: 'Frailty, limited functional reserve',
    weight: 2.5,
    minAge: 72,
    apply(t, rng) {
      t.params.svMax = (t.params.svMax ?? 130) * rng.real(0.84, 0.92);
      t.params.emaxRef = (t.params.emaxRef ?? 2.0) * rng.real(0.86, 0.94);
    },
  },
  {
    id: 'obesity',
    label: 'Obesity',
    weight: 2.5,
    apply(t, rng) {
      // Basal atelectasis plus a higher metabolic demand.
      t.state.qsQt = (t.state.qsQt ?? 0.02) + rng.real(0.02, 0.045);
      t.params.vo2 = (t.params.vo2 ?? 250) + rng.int(25, 60);
    },
  },
  {
    id: 'chronic-lung',
    label: 'Chronic lung disease',
    weight: 2,
    minAge: 50,
    skipFor: ['copd-exacerbation', 'adhf-mislabelled'],
    apply(t, rng) {
      t.state.qsQt = (t.state.qsQt ?? 0.02) + rng.real(0.04, 0.08);
      t.state.pvr = (t.state.pvr ?? 1.5) + rng.real(0.4, 0.9);
    },
  },
  {
    id: 'pulmonary-hypertension',
    label: 'Pulmonary hypertension',
    weight: 1.2,
    minAge: 55,
    apply(t, rng) {
      // Leaves the right ventricle with far less to give when it is loaded.
      t.state.pvr = (t.state.pvr ?? 1.5) + rng.real(1.0, 2.0);
      t.state.rvEmax = (t.state.rvEmax ?? 0.5) * rng.real(0.8, 0.9);
    },
  },
  {
    id: 'anaemia',
    label: 'Chronic anaemia',
    weight: 2,
    skipFor: ['gi-bleed'],
    apply(t, rng) {
      t.params.hgb = (t.params.hgb ?? 15) - rng.real(2.5, 4.5);
    },
  },
  {
    id: 'hypertension',
    label: 'Long-standing hypertension',
    weight: 3,
    minAge: 45,
    apply(t, rng) {
      // A vasculature used to running high, defending a higher pressure — so the
      // "normal" blood pressure that reassures you is already a big fall for them.
      t.params.mapSetpoint = (t.params.mapSetpoint ?? 90) + rng.int(6, 14);
      t.state.svr = (t.state.svr ?? 17) + rng.real(0.8, 2.0);
    },
  },
  {
    id: 'athletic',
    label: 'Physically fit, low resting heart rate',
    weight: 1,
    apply(t, rng) {
      t.params.svMax = (t.params.svMax ?? 130) * rng.real(1.08, 1.18);
      t.state.hr = (t.state.hr ?? 70) - rng.int(8, 14);
    },
  },
];

/**
 * Draw the comorbidities this patient carries.
 *
 * Most patients have one or two. Weighted sampling without replacement, filtered
 * by age and by whether the archetype already implies the condition.
 */
export function sampleComorbidities(
  rng: Rng,
  archetypeId: string,
  age: number,
  count: number,
): Comorbidity[] {
  const eligible = COMORBIDITIES.filter(
    (c) => (c.minAge === undefined || age >= c.minAge) && !(c.skipFor ?? []).includes(archetypeId),
  );

  const chosen: Comorbidity[] = [];
  const pool = [...eligible];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0);
    let roll = rng.next() * total;
    let index = 0;
    while (index < pool.length - 1 && roll > pool[index].weight) {
      roll -= pool[index].weight;
      index += 1;
    }
    chosen.push(pool.splice(index, 1)[0]);
  }
  return chosen;
}

/** Apply a set of comorbidities onto a case's overrides. */
export function applyComorbidities(
  comorbidities: Comorbidity[],
  target: ModifierTarget,
  rng: Rng,
): void {
  for (const c of comorbidities) c.apply(target, rng);
}
