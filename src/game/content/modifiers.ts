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
  /**
   * Conditions acting on the same physiology as this one; at most one is drawn.
   *
   * Beta-blockade and athletic conditioning both take away the compensatory
   * tachycardia. A patient carrying both cannot respond to anything, and a
   * background condition that removes a compensatory mechanism outright has
   * stopped describing the person and started deciding the case.
   */
  excludes?: string[];
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
    excludes: ['athletic'],
    /**
     * The cirrhosis cases are on a non-selective beta-blocker for their varices —
     * it is in their medication list and in their baseline. Drawing the
     * comorbidity on top counted the same drug twice, and the doubled blockade
     * was enough on its own to turn a ward-level illness into a death.
     */
    skipFor: [
      'cirrhosis-sbp', 'hepatic-encephalopathy', 'variceal-bleed',
      // The bradycardia here is the disease. Another rate-limiting condition on
      // top of it is not a background feature, it is a second diagnosis.
      'post-meningitis-dysautonomia',
      // Same reasoning: a rate that falls as the posterior fossa swells is the
      // warning sign the case is built around, and a patient who is bradycardic
      // to begin with has no such sign to give.
      'post-stroke-vertigo',
    ],
    apply(t, rng) {
      // The important one. A blunted chronotropic response means the tachycardia
      // that normally announces hypovolemia never arrives, and the patient looks
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
    skipFor: [
      'urosepsis', 'post-meningitis-dysautonomia', 'new-dialysis-uremia',
      // The graft is the kidney function in this case, and the whole point is
      // that it is preload-dependent rather than chronically scarred.
      'renal-transplant-aki',
    ],
    // Same physiology as chronic anemia by the time it reaches the model, so
    // only one of the two is ever drawn.
    excludes: ['anemia'],
    apply(t, rng) {
      // Anemia of chronic disease narrows the oxygen-delivery margin. Toward a
      // value rather than subtracted from it: on a case that is anemic in its
      // own right, subtracting took an already-low hemoglobin below the
      // anaerobic threshold at sign-out, so the patient was in a lactate spiral
      // from minute zero and the case had been decided before it started.
      t.params.hgb = Math.min(t.params.hgb ?? 15, rng.real(9.4, 11.2));
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
    skipFor: [
      'copd-exacerbation', 'adhf-mislabeled', 'cf-exacerbation', 'pah-rv-failure',
      'meth-pah-right-failure', 'withdrawal-in-pah',
    ],
    apply(t, rng) {
      t.state.qsQt = (t.state.qsQt ?? 0.02) + rng.real(0.04, 0.08);
      t.state.pvr = (t.state.pvr ?? 1.5) + rng.real(0.4, 0.9);
    },
  },
  {
    id: 'pulmonary-hypertension',
    label: 'Pulmonary hypertension',
    weight: 1.2,
    // Now that RV output is afterload-sensitive, adding pulmonary resistance to a
    // case whose whole mechanism is pulmonary resistance is not a background
    // condition — it is a second disease.
    skipFor: ['pulmonary-embolism', 'pah-rv-failure', 'meth-pah-right-failure', 'withdrawal-in-pah'],
    minAge: 55,
    apply(t, rng) {
      // Leaves the right ventricle with far less to give when it is loaded.
      t.state.pvr = (t.state.pvr ?? 1.5) + rng.real(1.0, 2.0);
      t.state.rvEmax = (t.state.rvEmax ?? 0.5) * rng.real(0.8, 0.9);
    },
  },
  {
    id: 'anemia',
    label: 'Chronic anemia',
    weight: 2,
    excludes: ['ckd'],
    /**
     * Skipped where oxygen delivery is already the axis the case fails along.
     *
     * A background condition should narrow the margin, not decide the outcome.
     * Anemia acts entirely through the SvO2 → lactate → contractility spiral,
     * which is the highest-gain loop in the model, so on a case that is already
     * failing through that loop it stopped being a modifier: the same
     * cardiogenic patient died at 127 minutes without it and 15 minutes with it.
     * Cases that are themselves anemic set their own hemoglobin.
     */
    skipFor: [
      'gi-bleed', 'adhf-mislabeled', 'acs-cardiogenic',
      'sickle-acute-chest', 'neutropenic-sepsis', 'cirrhosis-sbp',
      // A bradycardic patient runs a low cardiac output by definition, so their
      // oxygen delivery margin is the narrow thing about them already. Adding
      // anemia put mixed venous saturation below the anaerobic threshold at
      // sign-out and the spiral ran from minute one regardless of the case —
      // which made severity 0.2 lethal while 0.8 survived.
      'post-meningitis-dysautonomia',
      'new-dialysis-uremia',
    ],
    apply(t, rng) {
      // Toward a characteristic value, never subtracted from whatever the case
      // already set. Subtracting stacked on archetypes that are anemic in their
      // own right — a stem cell transplant at day +8, a sickle cell crisis — and
      // produced hemoglobins of 2, which is not a comorbidity, it is a corpse.
      t.params.hgb = Math.min(t.params.hgb ?? 15, rng.real(9.2, 10.8));
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
    excludes: ['beta-blocked'],
    skipFor: ['post-meningitis-dysautonomia', 'post-stroke-vertigo'],
    apply(t, rng) {
      t.params.svMax = (t.params.svMax ?? 130) * rng.real(1.08, 1.18);
      t.state.hr = (t.state.hr ?? 70) - rng.int(8, 14);
      // Reserve, not just a low number. The resting rate becomes the rate the
      // reflex defends from, so lowering it alone took away the compensation an
      // athlete actually has more of — and a fit patient decompensated sooner
      // than an unfit one, which is backwards. Being fit means responding harder.
      t.params.gainHr = (t.params.gainHr ?? 1.5) * rng.real(1.2, 1.35);
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
    const picked = pool.splice(index, 1)[0];
    chosen.push(picked);

    // Anything acting on the same physiology drops out of the draw.
    for (const id of picked.excludes ?? []) {
      const clash = pool.findIndex((c) => c.id === id);
      if (clash >= 0) pool.splice(clash, 1);
    }
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

  // Background conditions describe the person the disease happened to. They can
  // narrow the margin the patient starts with; they must not, on their own,
  // hand over someone already incompatible with life — that is the archetype's
  // job to do deliberately, at a severity the player can see coming.
  if (target.params.hgb !== undefined) {
    target.params.hgb = Math.max(6.0, target.params.hgb);
  }
}
