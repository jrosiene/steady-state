import { describe, it, expect } from 'vitest';
import { samplePatient } from '../patient';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';

describe('samplePatient', () => {
  it('returns params within physiologic bounds', () => {
    for (let i = 0; i < 20; i++) {
      const { params } = samplePatient();
      expect(params.mapSetpoint).toBeGreaterThanOrEqual(70);
      expect(params.mapSetpoint).toBeLessThanOrEqual(110);
      expect(params.hrBaseline).toBeGreaterThanOrEqual(45);
      expect(params.hrBaseline).toBeLessThanOrEqual(95);
      expect(params.svrBaseline).toBeGreaterThanOrEqual(10);
      expect(params.svrBaseline).toBeLessThanOrEqual(26);
      expect(params.gainHr).toBeGreaterThan(0);
      expect(params.gainSvr).toBeGreaterThan(0);
      expect(params.tauHr).toBeGreaterThan(0);
      expect(params.tauSvr).toBeGreaterThan(0);
    }
  });

  it('returns initial state within physiologic bounds', () => {
    for (let i = 0; i < 20; i++) {
      const { initialState } = samplePatient();
      expect(initialState.edv).toBeGreaterThanOrEqual(80);
      expect(initialState.edv).toBeLessThanOrEqual(160);
      expect(initialState.cvp).toBeGreaterThanOrEqual(2);
      expect(initialState.cvp).toBeLessThanOrEqual(10);
      expect(initialState.hrMod).toBe(0); // no drug effect at baseline
    }
  });

  it('initial state HR matches sampled hrBaseline', () => {
    const { params, initialState } = samplePatient();
    expect(initialState.hr).toBe(params.hrBaseline);
  });

  it('initial state emax matches sampled emaxRef', () => {
    const { params, initialState } = samplePatient();
    expect(initialState.emax).toBe(params.emaxRef);
  });

  it('produces different results on successive calls (not seeded)', () => {
    const p1 = samplePatient().params;
    const p2 = samplePatient().params;
    // Probability of exact match is negligible with floats
    expect(p1.mapSetpoint).not.toBe(p2.mapSetpoint);
  });

  it('returns a non-empty descriptor string', () => {
    for (let i = 0; i < 10; i++) {
      const { descriptor } = samplePatient();
      expect(typeof descriptor).toBe('string');
      expect(descriptor.length).toBeGreaterThan(0);
    }
  });

  it('sampled params include all required fields from DEFAULT_PARAMS', () => {
    const { params } = samplePatient();
    for (const key of Object.keys(DEFAULT_PARAMS) as (keyof typeof DEFAULT_PARAMS)[]) {
      expect(params[key]).toBeDefined();
      expect(typeof params[key]).toBe('number');
    }
  });

  it('sampled initial state includes all required fields from DEFAULT_STATE', () => {
    const { initialState } = samplePatient();
    for (const key of Object.keys(DEFAULT_STATE) as (keyof typeof DEFAULT_STATE)[]) {
      expect(initialState[key]).toBeDefined();
    }
  });

  it('population mean is approximately centered on defaults (over 100 samples)', () => {
    const n = 100;
    let sumMap = 0, sumHr = 0;
    for (let i = 0; i < n; i++) {
      const { params } = samplePatient();
      sumMap += params.mapSetpoint;
      sumHr  += params.hrBaseline;
    }
    // Within 5% of population mean
    expect(sumMap / n).toBeCloseTo(DEFAULT_PARAMS.mapSetpoint, -1);
    expect(sumHr  / n).toBeCloseTo(DEFAULT_PARAMS.hrBaseline,  -1);
  });
});
