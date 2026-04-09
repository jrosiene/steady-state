import { describe, it, expect } from 'vitest';
import { rk4Step, clampState } from '../solver';
import { derivative } from '../hemodynamics';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import type { HemodynamicState, HemodynamicParams } from '../types';

describe('rk4Step', () => {
  it('advances time by dt', () => {
    const next = rk4Step(DEFAULT_STATE, DEFAULT_PARAMS, 0.01, derivative);
    expect(next.time).toBeCloseTo(DEFAULT_STATE.time + 0.01, 10);
  });

  it('preserves equilibrium — state barely changes at setpoint', () => {
    const next = rk4Step(DEFAULT_STATE, DEFAULT_PARAMS, 0.01, derivative);
    expect(next.hr).toBeCloseTo(DEFAULT_STATE.hr, 2);
    expect(next.svr).toBeCloseTo(DEFAULT_STATE.svr, 2);
    expect(next.edv).toBe(DEFAULT_STATE.edv);
  });

  it('HR increases when starting from low MAP', () => {
    // Drop SVR to lower MAP below setpoint
    const lowSVR: HemodynamicState = { ...DEFAULT_STATE, svr: 10 };
    const next = rk4Step(lowSVR, DEFAULT_PARAMS, 0.1, derivative);
    expect(next.hr).toBeGreaterThan(lowSVR.hr);
  });

  it('is more accurate than Euler for the same step size', () => {
    // Simple test: RK4 on a known ODE. Use y' = -y (exponential decay).
    // We repurpose the solver with a custom derivative function.
    const decayState: HemodynamicState = {
      hr: 100, svr: 0, edv: 0, emax: 0, cvp: 0, hrMod: 0,
      rvEmax: 0, pvr: 0, rvedv: 0, qsQt: 0, fiO2: 0, noTone: 0, et1Tone: 0, lactate: 1, time: 0,
    };
    const decayDeriv = (s: HemodynamicState, _p: HemodynamicParams): HemodynamicState => ({
      hr: -s.hr, svr: 0, edv: 0, emax: 0, cvp: 0, hrMod: 0,
      rvEmax: 0, pvr: 0, rvedv: 0, qsQt: 0, fiO2: 0, noTone: 0, et1Tone: 0, lactate: 0, time: 1,
    });

    const dt = 0.1;
    const exact = 100 * Math.exp(-dt); // 90.484...

    // RK4
    const rk4Result = rk4Step(decayState, DEFAULT_PARAMS, dt, decayDeriv);

    // Euler (manual)
    const eulerResult = decayState.hr + (-decayState.hr) * dt; // 90

    expect(Math.abs(rk4Result.hr - exact)).toBeLessThan(Math.abs(eulerResult - exact));
  });
});

describe('clampState', () => {
  const p = DEFAULT_PARAMS;

  it('leaves in-range values untouched', () => {
    const clamped = clampState(DEFAULT_STATE, p);
    expect(clamped.hr).toBe(DEFAULT_STATE.hr);
    expect(clamped.svr).toBe(DEFAULT_STATE.svr);
    expect(clamped.edv).toBe(DEFAULT_STATE.edv);
  });

  it('clamps HR to hrMax', () => {
    const high: HemodynamicState = { ...DEFAULT_STATE, hr: 300 };
    expect(clampState(high, p).hr).toBe(p.hrMax);
  });

  it('clamps HR to hrMin', () => {
    const low: HemodynamicState = { ...DEFAULT_STATE, hr: 10 };
    expect(clampState(low, p).hr).toBe(p.hrMin);
  });

  it('clamps SVR within bounds', () => {
    const high: HemodynamicState = { ...DEFAULT_STATE, svr: 100 };
    const low: HemodynamicState = { ...DEFAULT_STATE, svr: 1 };
    expect(clampState(high, p).svr).toBe(p.svrMax);
    expect(clampState(low, p).svr).toBe(p.svrMin);
  });

  it('prevents negative Emax', () => {
    const bad: HemodynamicState = { ...DEFAULT_STATE, emax: -1 };
    expect(clampState(bad, p).emax).toBeGreaterThan(0);
  });

  it('prevents negative CVP', () => {
    const bad: HemodynamicState = { ...DEFAULT_STATE, cvp: -5 };
    expect(clampState(bad, p).cvp).toBe(0);
  });

  it('prevents negative hrMod', () => {
    const bad: HemodynamicState = { ...DEFAULT_STATE, hrMod: -10 };
    expect(clampState(bad, p).hrMod).toBe(0);
  });
});
