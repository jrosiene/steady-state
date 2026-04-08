import { describe, it, expect } from 'vitest';
import { derive, snapshot, derivative, interventionEffect, applyInterventions } from '../hemodynamics';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import type { Intervention } from '../types';

describe('derive', () => {
  const p = DEFAULT_PARAMS;
  const s = DEFAULT_STATE;

  it('computes physiologically reasonable resting values', () => {
    const d = derive(s, p);
    expect(d.sv).toBeGreaterThan(60);
    expect(d.sv).toBeLessThan(90);
    expect(d.co).toBeGreaterThan(4);
    expect(d.co).toBeLessThan(7);
    expect(d.map).toBeGreaterThan(80);
    expect(d.map).toBeLessThan(100);
  });

  it('MAP is near setpoint at resting state', () => {
    const d = derive(s, p);
    // SV≈72.2 → CO≈5.06 → MAP≈90.9, close to setpoint of 90
    expect(Math.abs(d.map - p.mapSetpoint)).toBeLessThan(2);
  });

  it('CO = HR * SV / 1000', () => {
    const d = derive(s, p);
    expect(d.co).toBeCloseTo((s.hr * d.sv) / 1000, 5);
  });

  it('MAP = CO * SVR + CVP', () => {
    const d = derive(s, p);
    expect(d.map).toBeCloseTo(d.co * s.svr + s.cvp, 5);
  });
});

describe('snapshot', () => {
  it('contains both state and derived fields', () => {
    const snap = snapshot(DEFAULT_STATE, DEFAULT_PARAMS);
    // State fields
    expect(snap.hr).toBe(DEFAULT_STATE.hr);
    expect(snap.edv).toBe(DEFAULT_STATE.edv);
    // Derived fields
    expect(snap.sv).toBeDefined();
    expect(snap.co).toBeDefined();
    expect(snap.map).toBeDefined();
  });
});

describe('derivative', () => {
  it('returns small HR/SVR derivatives near equilibrium', () => {
    const d = derivative(DEFAULT_STATE, DEFAULT_PARAMS);
    // Not exactly zero because resting MAP is ~90.9, slightly above setpoint
    expect(Math.abs(d.hr)).toBeLessThan(0.5);
    expect(Math.abs(d.svr)).toBeLessThan(0.1);
  });

  it('time derivative is always 1', () => {
    const d = derivative(DEFAULT_STATE, DEFAULT_PARAMS);
    expect(d.time).toBe(1);
  });

  it('EDV, Emax, CVP, hrMod derivatives are 0 (no intrinsic dynamics)', () => {
    const d = derivative(DEFAULT_STATE, DEFAULT_PARAMS);
    expect(d.edv).toBe(0);
    expect(d.emax).toBe(0);
    expect(d.cvp).toBe(0);
    expect(d.hrMod).toBe(0);
  });

  it('hrMod elevates HR target (direct chronotropy drives HR up at setpoint MAP)', () => {
    const withChrono = { ...DEFAULT_STATE, hrMod: 30 };
    const d = derivative(withChrono, DEFAULT_PARAMS);
    // With hrMod=30 at setpoint MAP, HR target = 70+30=100, current HR=70 → dHr > 0
    expect(d.hr).toBeGreaterThan(0);
  });
});

describe('interventionEffect', () => {
  const baseIntervention: Intervention = {
    label: 'test',
    category: 'treatment',
    target: 'svr',
    delta: 5,
    tauOn: 10,
    tauOff: 20,
    startTime: 0,
  };

  it('returns 0 before start time', () => {
    expect(interventionEffect(baseIntervention, -1)).toBe(0);
  });

  it('returns 0 at start time', () => {
    expect(interventionEffect(baseIntervention, 0)).toBeCloseTo(0, 5);
  });

  it('approaches full delta over time', () => {
    // After 5 time constants, should be ~99.3% of delta
    const effect = interventionEffect(baseIntervention, 50);
    expect(effect).toBeCloseTo(5, 0);
  });

  it('increases monotonically during onset', () => {
    const e1 = interventionEffect(baseIntervention, 5);
    const e2 = interventionEffect(baseIntervention, 10);
    const e3 = interventionEffect(baseIntervention, 20);
    expect(e1).toBeLessThan(e2);
    expect(e2).toBeLessThan(e3);
  });

  it('decays after stop time', () => {
    const stopped: Intervention = { ...baseIntervention, stopTime: 50 };
    const atStop = interventionEffect(stopped, 50);
    const afterStop = interventionEffect(stopped, 100);
    expect(afterStop).toBeLessThan(atStop);
  });

  it('decays toward zero after stop', () => {
    const stopped: Intervention = { ...baseIntervention, stopTime: 50 };
    // Long after stopping
    const effect = interventionEffect(stopped, 500);
    expect(effect).toBeCloseTo(0, 1);
  });
});

describe('applyInterventions', () => {
  it('returns unmodified state with no interventions', () => {
    const result = applyInterventions(DEFAULT_STATE, []);
    expect(result).toEqual(DEFAULT_STATE);
  });

  it('adds intervention effect to target variable', () => {
    const intervention: Intervention = {
      label: 'test',
      category: 'treatment',
      target: 'svr',
      delta: 5,
      tauOn: 1,
      tauOff: 1,
      startTime: 0,
    };
    // At time=10, effect should be nearly full (5)
    const state = { ...DEFAULT_STATE, time: 10 };
    const result = applyInterventions(state, [intervention]);
    expect(result.svr).toBeGreaterThan(state.svr);
    expect(result.svr).toBeCloseTo(state.svr + 5, 0);
  });

  it('stacks multiple interventions additively', () => {
    const i1: Intervention = { label: 'a', category: 'treatment', target: 'svr', delta: 3, tauOn: 1, tauOff: 1, startTime: 0 };
    const i2: Intervention = { label: 'b', category: 'treatment', target: 'svr', delta: 2, tauOn: 1, tauOff: 1, startTime: 0 };
    const state = { ...DEFAULT_STATE, time: 10 };
    const result = applyInterventions(state, [i1, i2]);
    expect(result.svr).toBeCloseTo(state.svr + 5, 0);
  });
});
