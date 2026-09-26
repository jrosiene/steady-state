/**
 * Ventilation and CO2.
 *
 * Each test is a piece of bedside respiratory physiology the model has to
 * reproduce from mechanism rather than from a lookup: Winter's formula, the
 * apneic rise in PaCO2, the hypoventilating patient whose oxygen hides the
 * problem, and the CO2 retainer whose oxygen causes it.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import { applyInterventions, derive, snapshot } from '../hemodynamics';
import { clampEffective } from '../solver';
import { computeVentilation, ventilatoryDemand, paCO2Derivative, arterialPh } from '../ventilation';
import { stepPhysics } from '../../game/physics';
import type { HemodynamicParams, HemodynamicState, Intervention, Snapshot } from '../types';

const DT = 0.25;

function run(
  state: Partial<HemodynamicState>,
  params: Partial<HemodynamicParams> = {},
  seconds = 3600,
  ivs: Intervention[] = [],
  pinLactate?: number,
): Snapshot {
  const p = { ...DEFAULT_PARAMS, ...params };
  let s: HemodynamicState = { ...DEFAULT_STATE, ...state };
  for (let t = 0; t < seconds; t += DT) {
    s = stepPhysics(s, p, ivs, DT);
    if (pinLactate !== undefined) s = { ...s, lactate: pinLactate };
  }
  return snapshot(clampEffective(applyInterventions(s, ivs), p), p);
}

/** A chronic CO2 retainer: reset setpoint, compensated bicarbonate, blunted response, little reserve. */
const RETAINER: Partial<HemodynamicParams> = {
  paCO2Setpoint: 50, hco3Baseline: 30, veMax: 9, ventCo2Gain: 0.12,
  // Adapted to living near their ceiling, as the ward generator would set it.
  fatigueLoadThreshold: 1,
};
const RETAINER_STATE: Partial<HemodynamicState> = {
  paCO2: 50, qsQt: 0.12, deadSpace: 0.3, pvr: 2.4, fiO2: 0.28,
};
const EXACERBATION: Partial<HemodynamicState> = { ...RETAINER_STATE, qsQt: 0.29, deadSpace: 0.42 };

describe('resting ventilation', () => {
  it('holds a normal adult at PaCO2 40, pH 7.39, RR 13', () => {
    const s = run({});
    expect(s.paCO2).toBeCloseTo(40, 0);
    expect(s.pH).toBeCloseTo(7.39, 2);
    expect(s.rr).toBeCloseTo(13, 0);
    expect(s.ve).toBeCloseTo(DEFAULT_PARAMS.veRef, 1);
  });

  it('balances CO2 production and clearance at rest', () => {
    const d = derive(DEFAULT_STATE, DEFAULT_PARAMS);
    const rate = paCO2Derivative(40, d.va, DEFAULT_PARAMS.vo2 * DEFAULT_PARAMS.rq, DEFAULT_PARAMS);
    expect(Math.abs(rate)).toBeLessThan(0.002); // mmHg/s
  });
});

describe('metabolic acidosis is compensated to Winter\'s formula', () => {
  // Expected PaCO2 = 1.5 × HCO3 + 8 ± 2.
  for (const hco3 of [8, 12, 16]) {
    it(`HCO3 ${hco3} (renal) → PaCO2 ${1.5 * hco3 + 8} ± 2`, () => {
      const s = run({}, { hco3Baseline: hco3 }, 1800);
      expect(s.paCO2).toBeGreaterThan(1.5 * hco3 + 8 - 2);
      expect(s.paCO2).toBeLessThan(1.5 * hco3 + 8 + 2);
    });
  }

  it('compensates a lactic acidosis too', () => {
    const s = run({}, {}, 1800, [], 1 + (24 - 20)); // HCO3 20
    expect(s.hco3).toBeCloseTo(20, 0);
    expect(s.paCO2).toBeGreaterThan(36);
    expect(s.paCO2).toBeLessThan(40);
  });

  it('shows the Kussmaul pattern: deeper and faster', () => {
    const s = run({}, { hco3Baseline: 8 }, 1800);
    // Mass balance: PaCO2 ~21 needs VA ≈ 0.863 × 200 / 21 ≈ 8.2 L/min.
    expect(s.ve).toBeGreaterThan(1.6 * DEFAULT_PARAMS.veRef);
    expect(s.vt).toBeGreaterThan(0.55);
    expect(s.rr).toBeGreaterThan(18);
  });
});

describe('the acidosis penalties are metabolic, not respiratory', () => {
  it('does not put a hypercapnic patient into cardiogenic shock', () => {
    const s = run({ ventDepression: 0.9 });
    expect(s.pH).toBeLessThan(7.28);          // a real respiratory acidosis
    expect(s.pHMetabolic).toBeCloseTo(7.39, 2); // no base deficit
    expect(s.emaxEffective).toBeCloseTo(DEFAULT_PARAMS.emaxRef, 1);
    expect(s.map).toBeGreaterThan(85);
  });

  it('leaves the calibrated septic picture unchanged except for the displayed pH', () => {
    const sepsis: Intervention = {
      label: 'sepsis', category: 'scenario', kind: 'scenario', target: 'noTone',
      delta: 0.7, tauOn: 300, eliminationHalfLife: 1e6, startTime: 0,
    };
    const s = run({}, {}, 3600, [sepsis]);
    // Same hemodynamics the uncompensated engine produced (MAP 66, CO 3.2, lactate 8)…
    expect(s.map).toBeCloseTo(66, -1);
    expect(s.lactate).toBeCloseTo(8, 0);
    // …but now breathing it off: a compensated pH rather than 7.20.
    expect(s.paCO2).toBeLessThan(34);
    expect(s.pH).toBeGreaterThan(7.3);
  });
});

describe('hypoventilation', () => {
  it('raises PaCO2 about 4 mmHg a minute during apnea', () => {
    const s = run({ ventDepression: 1 }, {}, 300);
    expect(s.paCO2).toBeGreaterThan(55);
    expect(s.paCO2).toBeLessThan(65);
  });

  it('retains CO2 progressively with opioid dose, and slows the rate', () => {
    const light = run({ ventDepression: 0.3 });
    const heavy = run({ ventDepression: 0.95 });
    expect(light.paCO2).toBeLessThan(43);
    expect(heavy.paCO2).toBeGreaterThan(60);
    expect(heavy.rr).toBeLessThan(7);
    // Opioid breathing is slow and deep, not shallow.
    expect(heavy.vt).toBeGreaterThan(light.vt);
  });

  it('desaturates on room air, and supplemental oxygen hides it', () => {
    const roomAir = run({ ventDepression: 0.95 });
    const onO2 = run({ ventDepression: 0.95, fiO2: 0.28 });
    expect(roomAir.spO2).toBeLessThan(0.93);
    expect(onO2.spO2).toBeGreaterThan(0.96);
    // Same ventilatory failure underneath.
    expect(Math.abs(onO2.paCO2 - roomAir.paCO2)).toBeLessThan(3);
  });

  it('is not hypoventilation once a ventilator is doing the breathing', () => {
    const s = run({ ventDepression: 0.95, ventSupport: 1 });
    expect(s.paCO2).toBeLessThan(44);
  });
});

describe('non-chemical drive', () => {
  it('makes pneumonia hypocapnic and tachypneic', () => {
    const s = run({ qsQt: 0.25 });
    expect(s.paCO2).toBeLessThan(36);
    expect(s.rr).toBeGreaterThan(20);
  });

  it('makes a PE hypocapnic despite the dead space it creates', () => {
    const s = run({ qsQt: 0.15, deadSpace: 0.15, pvr: 6 });
    expect(s.paCO2).toBeLessThan(36);
  });

  it('breathes a rapid shallow pattern in a stiff lung', () => {
    const pneumonia = run({ qsQt: 0.25 });
    const kussmaul = run({}, { hco3Baseline: 12 }, 1800);
    // Similar minute ventilation, very different pattern.
    expect(pneumonia.vt).toBeLessThan(kussmaul.vt);
  });
});

describe('the chronic CO2 retainer', () => {
  it('lives at their own PaCO2 with a compensated pH', () => {
    const s = run(RETAINER_STATE, RETAINER);
    expect(s.paCO2).toBeCloseTo(50, 0);
    expect(s.pH).toBeGreaterThan(7.36);
    expect(s.hco3).toBeCloseTo(30, 0);
  });

  it('retains acutely in an exacerbation, because there is no ventilatory reserve', () => {
    const s = run(EXACERBATION, RETAINER);
    expect(s.paCO2).toBeGreaterThan(55);
    expect(s.pH).toBeLessThan(7.34);
    expect(s.veDemand).toBeGreaterThan(s.veCapacity); // asking for more than can be delivered
  });

  it('retains further on high-flow oxygen, with a saturation that looks fine', () => {
    const lowFlow = run(EXACERBATION, RETAINER);
    const nrb = run({ ...EXACERBATION, fiO2: 0.85 }, RETAINER);
    expect(nrb.paCO2).toBeGreaterThan(lowFlow.paCO2 + 8);
    expect(nrb.pH).toBeLessThan(7.26);
    expect(nrb.spO2).toBeGreaterThan(0.9);
  });

  it('is rescued by non-invasive ventilation', () => {
    const niv = run({ ...EXACERBATION, ventSupport: 0.6, fiO2: 0.35 }, RETAINER);
    expect(niv.paCO2).toBeLessThan(52);
    expect(niv.pH).toBeGreaterThan(7.35);
  });
});

describe('controller components', () => {
  it('responds about 2 L/min per mmHg of CO2 above setpoint', () => {
    const base = { paCO2: 40, hco3: 24, spO2: 0.97, qsQtEffective: 0.02, pcwp: 10, mPAP: 15 };
    const d0 = ventilatoryDemand(base, DEFAULT_PARAMS);
    const d5 = ventilatoryDemand({ ...base, paCO2: 45 }, DEFAULT_PARAMS);
    const slope = ((d5 - d0) * DEFAULT_PARAMS.veRef) / 5;
    expect(slope).toBeGreaterThan(1.5);
    expect(slope).toBeLessThan(3);
  });

  it('loses respiratory muscle capacity in a low-output state', () => {
    const inp = {
      paCO2: 40, hco3: 24, spO2: 0.97, qsQtEffective: 0.02, pcwp: 10, mPAP: 15,
      ventDepression: 0, deadSpace: 0, ventSupport: 0, respFatigue: 0, fiO2: 0.21, qsQt: 0.02,
    };
    const normal = computeVentilation({ ...inp, co: 5 }, DEFAULT_PARAMS);
    const shocked = computeVentilation({ ...inp, co: 1 }, DEFAULT_PARAMS);
    expect(shocked.veCapacity).toBeLessThan(normal.veCapacity / 2);
  });

  it('uses Henderson–Hasselbalch', () => {
    expect(arterialPh(24, 40)).toBeCloseTo(7.39, 2);
    expect(arterialPh(24, 80)).toBeCloseTo(7.09, 2);
  });
});
