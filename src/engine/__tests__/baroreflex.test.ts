import { describe, it, expect } from 'vitest';
import { computeBaroreflex } from '../baroreflex';
import { DEFAULT_PARAMS } from '../constants';

describe('Baroreflex: computeBaroreflex', () => {
  const p = DEFAULT_PARAMS;
  const hrMod = 0; // no pharmacologic chronotropy by default

  it('returns near-zero derivatives at equilibrium (MAP=setpoint)', () => {
    const { dHr, dSvr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, p.mapSetpoint, hrMod, p);
    expect(Math.abs(dHr)).toBeLessThan(0.01);
    expect(Math.abs(dSvr)).toBeLessThan(0.01);
  });

  it('increases HR when MAP drops (sympathetic activation)', () => {
    const { dHr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, 60, hrMod, p);
    expect(dHr).toBeGreaterThan(0);
  });

  it('increases SVR when MAP drops', () => {
    const { dSvr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, 60, hrMod, p);
    expect(dSvr).toBeGreaterThan(0);
  });

  it('decreases HR when MAP rises (parasympathetic tone)', () => {
    const { dHr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, 120, hrMod, p);
    expect(dHr).toBeLessThan(0);
  });

  it('decreases SVR when MAP rises', () => {
    const { dSvr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, 120, hrMod, p);
    expect(dSvr).toBeLessThan(0);
  });

  it('responds proportionally to error magnitude', () => {
    const mild   = computeBaroreflex(p.hrBaseline, p.svrBaseline, 80, hrMod, p);
    const severe = computeBaroreflex(p.hrBaseline, p.svrBaseline, 50, hrMod, p);
    expect(Math.abs(severe.dHr)).toBeGreaterThan(Math.abs(mild.dHr));
    expect(Math.abs(severe.dSvr)).toBeGreaterThan(Math.abs(mild.dSvr));
  });

  it('HR derivative is faster than SVR derivative (shorter tau)', () => {
    const map = 60;
    const error = p.mapSetpoint - map;
    const hrTarget  = p.hrBaseline  + p.gainHr  * error;
    const svrTarget = p.svrBaseline + p.gainSvr * error;

    const { dHr, dSvr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, map, hrMod, p);

    const hrFraction  = dHr  / (hrTarget  - p.hrBaseline);
    const svrFraction = dSvr / (svrTarget - p.svrBaseline);
    expect(hrFraction).toBeGreaterThan(svrFraction);
  });

  it('clamps HR target within physiologic range', () => {
    const { dHr } = computeBaroreflex(p.hrBaseline, p.svrBaseline, 0, hrMod, p);
    const maxDHr = (p.hrMax - p.hrBaseline) / p.tauHr;
    expect(dHr).toBeLessThanOrEqual(maxDHr + 0.01);
  });

  it('hrMod shifts HR target upward (direct β1 chronotropy)', () => {
    // At setpoint MAP, hrMod=0 → dHr≈0; hrMod=+30 → dHr>0 (driving toward higher target)
    const { dHr: dHrBase } = computeBaroreflex(p.hrBaseline, p.svrBaseline, p.mapSetpoint, 0, p);
    const { dHr: dHrMod }  = computeBaroreflex(p.hrBaseline, p.svrBaseline, p.mapSetpoint, 30, p);
    expect(dHrMod).toBeGreaterThan(dHrBase);
  });

  it('hrMod does not affect SVR target', () => {
    const { dSvr: dSvrBase } = computeBaroreflex(p.hrBaseline, p.svrBaseline, p.mapSetpoint, 0, p);
    const { dSvr: dSvrMod }  = computeBaroreflex(p.hrBaseline, p.svrBaseline, p.mapSetpoint, 30, p);
    expect(dSvrMod).toBeCloseTo(dSvrBase, 5);
  });

  it('phenylephrine (SVR up, no hrMod) causes reflex bradycardia automatically', () => {
    // SVR↑ → MAP↑ → negative error → HR target drops below baseline → dHr < 0
    // Simulate: HR at baseline, MAP elevated by vasopressor
    const { dHr } = computeBaroreflex(p.hrBaseline, p.svrBaseline + 5, 105, 0, p);
    expect(dHr).toBeLessThan(0);
  });
});
