import { describe, it, expect } from 'vitest';
import { rk4Step, clampState } from '../solver';
import { derivative, derive, applyInterventions } from '../hemodynamics';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import type { HemodynamicState, Intervention } from '../types';

const DT = 0.01;
const p = DEFAULT_PARAMS;

/** Run the simulation for `duration` sim-seconds, returning the final state. */
function simulate(
  initial: HemodynamicState,
  duration: number,
  interventions: Intervention[] = [],
): HemodynamicState {
  let state = { ...initial };
  const steps = Math.floor(duration / DT);
  for (let i = 0; i < steps; i++) {
    const effective = applyInterventions(state, interventions);
    state = clampState(rk4Step(effective, p, DT, derivative), p);
  }
  return state;
}

describe('Integration: simulation stability', () => {
  it('resting state remains stable over 60 seconds', () => {
    const final = simulate(DEFAULT_STATE, 60);
    const d = derive(final, p);
    expect(d.map).toBeCloseTo(p.mapSetpoint, 0);
    expect(final.hr).toBeCloseTo(p.hrBaseline, 0);
    expect(final.svr).toBeCloseTo(p.svrBaseline, 0);
  });

  it('does not produce NaN or Infinity over 300 seconds', () => {
    const final = simulate(DEFAULT_STATE, 300);
    for (const key of ['hr', 'svr', 'edv', 'emax', 'cvp'] as const) {
      expect(Number.isFinite(final[key])).toBe(true);
    }
  });
});

describe('Integration: hemorrhage scenario', () => {
  it('compensates for moderate hemorrhage (EDV drop)', () => {
    // Simulate acute blood loss: EDV drops from 120 → 80
    const hemorrhage: HemodynamicState = { ...DEFAULT_STATE, edv: 80 };
    const final = simulate(hemorrhage, 30);
    const d = derive(final, p);

    // Baroreflex should partially compensate:
    // - HR should increase above baseline
    expect(final.hr).toBeGreaterThan(p.hrBaseline);
    // - SVR should increase above baseline
    expect(final.svr).toBeGreaterThan(p.svrBaseline);
    // - MAP should be below setpoint but not catastrophically
    expect(d.map).toBeGreaterThan(50);
    expect(d.map).toBeLessThan(p.mapSetpoint);
  });

  it('severe hemorrhage overwhelms compensation', () => {
    // Massive blood loss: EDV drops to 40
    const severe: HemodynamicState = { ...DEFAULT_STATE, edv: 40 };
    const final = simulate(severe, 30);
    const d = derive(final, p);

    // HR should be elevated (compensatory tachycardia)
    expect(final.hr).toBeGreaterThan(p.hrBaseline);
    // MAP should be well below setpoint
    expect(d.map).toBeLessThan(p.mapSetpoint - 10);
  });
});

describe('Integration: vasopressor intervention', () => {
  it('norepinephrine raises MAP toward setpoint', () => {
    // Start hypotensive, then apply vasopressor
    const hypotensive: HemodynamicState = { ...DEFAULT_STATE, svr: 8 };

    // First let the patient decompensate briefly
    const decompensated = simulate(hypotensive, 10);
    const mapBefore = derive(decompensated, p).map;

    // Apply norepinephrine (increases SVR by 8 Wood units)
    const norepi: Intervention = {
      label: 'Norepinephrine',
      category: 'treatment',
      target: 'svr',
      delta: 8,
      tauOn: 30,
      tauOff: 60,
      startTime: decompensated.time,
    };

    const treated = simulate(decompensated, 120, [norepi]);
    const mapAfter = derive(treated, p).map;

    expect(mapAfter).toBeGreaterThan(mapBefore);
  });
});

describe('Integration: fluid bolus', () => {
  it('increasing EDV raises CO and MAP', () => {
    const baseline = derive(DEFAULT_STATE, p);

    // Fluid bolus: EDV increases by 30 mL
    const bolused: HemodynamicState = { ...DEFAULT_STATE, edv: 150 };
    const after = simulate(bolused, 30);
    const afterDerived = derive(after, p);

    // CO should increase (higher preload → higher SV via Starling)
    expect(afterDerived.co).toBeGreaterThan(baseline.co * 0.95);
  });
});

describe('Integration: cardiogenic shock', () => {
  it('reduced contractility drops CO despite compensation', () => {
    // Emax drops to 50% of normal
    const shocked: HemodynamicState = { ...DEFAULT_STATE, emax: p.emaxRef * 0.5 };
    const final = simulate(shocked, 30);
    const d = derive(final, p);

    // MAP should be below setpoint
    expect(d.map).toBeLessThan(p.mapSetpoint);
    // HR should be elevated (compensating)
    expect(final.hr).toBeGreaterThan(p.hrBaseline);
    // CO should be reduced
    expect(d.co).toBeLessThan(5.0);
  });

  it('fluid bolus in severe cardiogenic shock worsens CO', () => {
    // Severe failure: Emax at 40% → edvCrit = 250 * 0.4 = 100
    const shocked: HemodynamicState = { ...DEFAULT_STATE, emax: p.emaxRef * 0.4 };
    const stabilized = simulate(shocked, 30);
    const coBefore = derive(stabilized, p).co;

    // Give aggressive fluid: push EDV well above the overdistension threshold
    const overloaded: HemodynamicState = { ...stabilized, edv: 180 };
    const after = simulate(overloaded, 30);
    const coAfter = derive(after, p).co;

    // CO should worsen — the failing ventricle can't handle the volume
    expect(coAfter).toBeLessThan(coBefore);
  });
});
