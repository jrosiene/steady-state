/**
 * Atelectasis and the obese chest.
 *
 * What the model has to reproduce: a lean patient does not lose their bases
 * whatever they are given; an obese one carries a few percent of shunt awake
 * and much more asleep, sedated or on high oxygen; end-expiratory pressure and
 * sitting up give it back within minutes; and a heavy chest wall leaves less
 * ventilatory reserve.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import { applyInterventions, snapshot } from '../hemodynamics';
import { clampEffective } from '../solver';
import { atelectasisTarget, recruitedFraction } from '../atelectasis';
import { ventilatoryCapacity } from '../ventilation';
import { stepPhysics } from '../../game/physics';
import type { HemodynamicParams, HemodynamicState, Intervention, Snapshot } from '../types';

const OBESE: Partial<HemodynamicParams> = { atelectasisProne: 0.05, chestWallLoad: 0.2, vo2: 300 };

function run(
  params: Partial<HemodynamicParams>,
  ivs: Intervention[] = [],
  seconds = 3600,
  state: Partial<HemodynamicState> = {},
): Snapshot {
  const p = { ...DEFAULT_PARAMS, ...params };
  let s: HemodynamicState = { ...DEFAULT_STATE, atelectasis: p.atelectasisProne, ...state };
  for (let t = 0; t < seconds; t += 0.25) s = stepPhysics(s, p, ivs, 0.25);
  return snapshot(clampEffective(applyInterventions(s, ivs), p), p);
}

const on = (target: keyof HemodynamicState, delta: number, startTime = 0): Intervention => ({
  label: String(target), category: 'scenario', kind: 'scenario', target, delta,
  tauOn: 60, eliminationHalfLife: 1e6, startTime,
});

describe('who gets it', () => {
  it('never in a lean patient, whatever they are given', () => {
    const p = DEFAULT_PARAMS;
    expect(atelectasisTarget(0.2, 2, 1, 1, 0, p)).toBe(0);
    const sedated = run({}, [on('ventDepression', 0.5), on('fiO2', 0.79)]);
    expect(sedated.atelectasis).toBe(0);
  });

  it('a few percent in an obese patient awake on room air', () => {
    const awake = run(OBESE);
    expect(awake.atelectasis).toBeGreaterThan(0.04);
    expect(awake.atelectasis).toBeLessThan(0.07);
    expect(awake.spO2).toBeGreaterThan(0.9);
  });
});

describe('what makes it worse', () => {
  it('sedation: no sighs, shallow breaths, collapsing bases over an hour', () => {
    const awake = run(OBESE);
    const sedated = run(OBESE, [on('ventDepression', 0.4)]);
    expect(sedated.atelectasis).toBeGreaterThan(awake.atelectasis * 1.4);
    expect(sedated.paO2).toBeLessThan(awake.paO2 - 5);
  });

  it('high oxygen: absorption atelectasis', () => {
    const p = { ...DEFAULT_PARAMS, ...OBESE };
    const vt = p.veRef / p.rrRef;
    expect(atelectasisTarget(vt, p.veRef, 0, 1.0, 0, p)).toBeGreaterThan(atelectasisTarget(vt, p.veRef, 0, 0.3, 0, p) * 1.4);
  });

  it('collapses slowly', () => {
    const tenMinutes = run(OBESE, [on('ventDepression', 0.4)], 600);
    const twoHours = run(OBESE, [on('ventDepression', 0.4)], 7200);
    expect(twoHours.atelectasis - tenMinutes.atelectasis).toBeGreaterThan(0.02);
  });
});

describe('what reopens it', () => {
  it('holds more open the more pressure it gets', () => {
    expect(recruitedFraction(0, DEFAULT_PARAMS)).toBe(0);
    expect(recruitedFraction(5, DEFAULT_PARAMS)).toBeCloseTo(0.5, 5);
    expect(recruitedFraction(10, DEFAULT_PARAMS)).toBeGreaterThan(0.6);
  });

  it('PEEP recruits within minutes, and oxygenation follows', () => {
    const sedated = { ...OBESE, atelectasisProne: 0.1 };
    const collapsed = run(sedated, [on('ventDepression', 0.4)], 7200);
    const opened = run(sedated, [on('ventDepression', 0.4), on('peep', 8, 7200)], 7200 + 1200);
    expect(opened.atelectasis).toBeLessThan(collapsed.atelectasis * 0.55);
    expect(opened.spO2).toBeGreaterThan(collapsed.spO2 + 0.02);
  });

  it('does nothing for a consolidated lung that has no collapsed units', () => {
    const pneumonia = run({}, [], 600, { qsQt: 0.2 });
    const withPeep = run({}, [on('peep', 8)], 600, { qsQt: 0.2 });
    expect(withPeep.spO2).toBeCloseTo(pneumonia.spO2, 3);
  });
});

describe('the heavy chest wall', () => {
  it('leaves less ventilatory reserve', () => {
    const lean = ventilatoryCapacity(5, 0, DEFAULT_PARAMS);
    const obese = ventilatoryCapacity(5, 0, { ...DEFAULT_PARAMS, ...OBESE }, 0, 0, 0, 0.06);
    expect(obese).toBeLessThan(lean * 0.8);
    expect(obese).toBeGreaterThan(lean * 0.6);
  });

  it('works nearer its ceiling at rest', () => {
    expect(run(OBESE).breathingLoad).toBeGreaterThan(run({}).breathingLoad * 1.4);
  });
});
