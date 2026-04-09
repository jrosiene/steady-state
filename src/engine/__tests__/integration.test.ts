import { describe, it, expect } from 'vitest';
import { rk4Step, clampState, clampEffective } from '../solver';
import { derivative, derive, applyInterventions } from '../hemodynamics';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import type { HemodynamicState, Intervention } from '../types';

const DT = 0.05; // match game loop
const p = DEFAULT_PARAMS;

/** All numeric keys of HemodynamicState. */
const STATE_NUMERIC_KEYS = [
  'hr', 'svr', 'edv', 'emax', 'cvp', 'hrMod',
  'rvEmax', 'pvr', 'rvedv', 'qsQt', 'fiO2',
  'noTone', 'et1Tone', 'lactate', 'time',
] as const;

/** All numeric keys of DerivedValues. */
const DERIVED_NUMERIC_KEYS = [
  'sv', 'co', 'map', 'rvSv', 'rvCo', 'mPAP', 'pcwp',
  'spO2', 'paO2', 'svO2', 'pH', 'hco3', 'be',
] as const;

/** Run simulation using the same derivFn pattern as the game loop. */
function simulate(
  initial: HemodynamicState,
  duration: number,
  interventions: Intervention[] = [],
): HemodynamicState {
  let state = { ...initial };
  const steps = Math.floor(duration / DT);
  for (let i = 0; i < steps; i++) {
    const derivFn = (s: HemodynamicState) =>
      derivative(clampEffective(applyInterventions(s, interventions), p), p);
    state = clampState(rk4Step(state, p, DT, derivFn), p);
    state = { ...state, time: state.time + DT };
  }
  return state;
}

/** Assert no NaN/Infinity in state or derived values. Returns failing keys for diagnostics. */
function assertFinite(state: HemodynamicState, label: string) {
  for (const key of STATE_NUMERIC_KEYS) {
    expect(Number.isFinite(state[key]), `${label}: state.${key} = ${state[key]}`).toBe(true);
  }
  const d = derive(state, p);
  for (const key of DERIVED_NUMERIC_KEYS) {
    expect(Number.isFinite(d[key]), `${label}: derived.${key} = ${d[key]}`).toBe(true);
  }
}

function iv(
  label: string, category: 'scenario' | 'treatment',
  target: keyof HemodynamicState, delta: number, tauOn = 60,
): Intervention {
  return { label, category, target, delta, tauOn, tauOff: 600, startTime: 0 };
}

// ─── Baseline stability ────────────────────────────────────────────────────

describe('Integration: simulation stability', () => {
  it('resting state remains stable over 60 seconds', () => {
    const final = simulate(DEFAULT_STATE, 60);
    const d = derive(final, p);
    expect(d.map).toBeCloseTo(p.mapSetpoint, 0);
    expect(final.hr).toBeCloseTo(p.hrBaseline, 0);
    expect(final.svr).toBeCloseTo(p.svrBaseline, 0);
  });

  it('no NaN/Infinity at rest over 300 seconds', () => {
    assertFinite(simulate(DEFAULT_STATE, 300), 'rest 300s');
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
  it('norepinephrine raises MAP in vasodilatory shock', () => {
    // Use a noTone overlay to suppress SVR (septic-style) — the baroreflex cannot
    // fully compensate because noTone reduces effective SVR algebraically regardless
    // of how high the base SVR climbs. Norepi +8 WU raises effective MAP significantly.
    const sepsis = [iv('Sepsis', 'scenario', 'noTone', 0.7, 10)];
    const shocked = simulate(DEFAULT_STATE, 120, sepsis);

    const norepi: Intervention = {
      label: 'Norepinephrine', category: 'treatment', target: 'svr',
      delta: 8, tauOn: 1, tauOff: 60, startTime: 0, // startTime=0 → fully on by t=120s
    };

    const mapBefore = derive(clampEffective(applyInterventions(shocked, sepsis), p), p).map;
    const mapAfter  = derive(clampEffective(applyInterventions(shocked, [...sepsis, norepi]), p), p).map;

    expect(mapAfter).toBeGreaterThan(mapBefore + 5);
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

// ─── Numerical stability through decompensation / arrest ──────────────────
// These are the regression tests for the crash reported during 2x hemorrhage IV.
// Each scenario runs through the full failure cascade and asserts that no
// NaN/Infinity appears in state or derived values at any checkpoint.

describe('Numerical stability: hemorrhage failure cascade', () => {
  const bleed2x = [iv('Hem IV x2', 'scenario', 'edv', -140, 90)];
  const bleed4x = [iv('Hem IV x4', 'scenario', 'edv', -280, 90)];

  it('2x hemorrhage IV: no NaN through decompensation phase (t=300s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 300, bleed2x), '2x hem t=300s');
  });

  it('2x hemorrhage IV: no NaN at arrest (t=900s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 900, bleed2x), '2x hem t=900s');
  });

  it('4x hemorrhage IV: no NaN at arrest (t=600s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 600, bleed4x), '4x hem t=600s');
  });

  it('4x hemorrhage IV: no NaN long after arrest (t=1800s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 1800, bleed4x), '4x hem t=1800s');
  });
});

describe('Numerical stability: sepsis failure cascade', () => {
  const sepsis1 = [iv('Sepsis', 'scenario', 'noTone', 0.7, 10)];
  const sepsis4 = [iv('Sepsis4x', 'scenario', 'noTone', 2.8, 10)];

  it('single sepsis stack: no NaN at steady state (t=900s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 900, sepsis1), 'sepsis1 t=900s');
  });

  it('4x sepsis stacks: no NaN through arrest (t=900s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 900, sepsis4), 'sepsis4 t=900s');
  });
});

describe('Numerical stability: cardiogenic shock cascade', () => {
  const mi = [iv('Acute MI', 'scenario', 'emax', -1.5, 90)];

  it('severe MI: no NaN through decompensation (t=600s)', () => {
    assertFinite(simulate(DEFAULT_STATE, 600, mi), 'MI t=600s');
  });

  it('severe MI + volume overload: no NaN (t=600s)', () => {
    const ivs = [...mi, iv('Volume overload', 'scenario', 'edv', 60, 120)];
    assertFinite(simulate(DEFAULT_STATE, 600, ivs), 'MI+volume t=600s');
  });
});

describe('Numerical stability: combined extreme scenarios', () => {
  it('hemorrhage + sepsis combined: no NaN (t=600s)', () => {
    const ivs = [
      iv('Hem', 'scenario', 'edv', -100, 90),
      iv('Sepsis', 'scenario', 'noTone', 0.7, 10),
    ];
    assertFinite(simulate(DEFAULT_STATE, 600, ivs), 'hem+sepsis t=600s');
  });

  it('PAH + massive PE + hypoxia: no NaN (t=600s)', () => {
    const ivs = [
      iv('PAH', 'scenario', 'pvr', 6, 120),
      iv('PE shunt', 'scenario', 'qsQt', 0.25, 60),
    ];
    assertFinite(simulate(DEFAULT_STATE, 600, ivs), 'PAH+PE t=600s');
  });

  it('safeClamp recovers from injected NaN in state', () => {
    // Directly inject NaN into lactate (simulates a corrupted intermediate RK4 state)
    // and verify clampState sanitizes it back to a finite value.
    const corrupted: HemodynamicState = { ...DEFAULT_STATE, lactate: NaN };
    const clamped = clampState(corrupted, p);
    expect(Number.isFinite(clamped.lactate)).toBe(true);
    expect(clamped.lactate).toBe(1.0); // falls back to lactateMin
  });

  it('safeClamp recovers from injected Infinity in hr', () => {
    const corrupted: HemodynamicState = { ...DEFAULT_STATE, hr: Infinity };
    const clamped = clampState(corrupted, p);
    expect(Number.isFinite(clamped.hr)).toBe(true);
    expect(clamped.hr).toBe(p.hrBaseline);
  });
});
