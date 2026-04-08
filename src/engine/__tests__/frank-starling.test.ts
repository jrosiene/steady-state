import { describe, it, expect } from 'vitest';
import { computeSV } from '../frank-starling';
import { DEFAULT_PARAMS } from '../constants';

describe('Frank-Starling: computeSV', () => {
  const p = DEFAULT_PARAMS;

  it('returns ~72 mL at resting EDV=120, normal contractility', () => {
    const sv = computeSV(120, p.emaxRef, p);
    // effectiveEDV=100, SV = 130*100/180 ≈ 72.2
    expect(sv).toBeCloseTo(72.2, 0);
  });

  it('returns 0 when EDV equals dead volume', () => {
    expect(computeSV(p.v0, p.emaxRef, p)).toBe(0);
  });

  it('returns 0 when EDV is below dead volume', () => {
    expect(computeSV(p.v0 - 10, p.emaxRef, p)).toBe(0);
  });

  it('increases with higher EDV (Starling mechanism)', () => {
    const svLow = computeSV(80, p.emaxRef, p);
    const svMid = computeSV(120, p.emaxRef, p);
    const svHigh = computeSV(200, p.emaxRef, p);
    expect(svLow).toBeLessThan(svMid);
    expect(svMid).toBeLessThan(svHigh);
  });

  it('shows diminishing returns at high EDV (plateau behavior)', () => {
    const delta1 = computeSV(100, p.emaxRef, p) - computeSV(80, p.emaxRef, p);
    const delta2 = computeSV(200, p.emaxRef, p) - computeSV(180, p.emaxRef, p);
    expect(delta2).toBeLessThan(delta1);
  });

  it('scales linearly with contractility (Emax) below overdistension threshold', () => {
    // Use EDV=80 — well below overdistension threshold even at half Emax
    // (edvCrit at half Emax = 220 * 0.5 = 110, so 80 is safe)
    const svNormal = computeSV(80, p.emaxRef, p);
    const svHalf = computeSV(80, p.emaxRef * 0.5, p);
    expect(svHalf).toBeCloseTo(svNormal * 0.5, 1);
  });

  it('never exceeds SVmax even with extreme contractility', () => {
    const sv = computeSV(300, p.emaxRef * 10, p);
    expect(sv).toBeLessThanOrEqual(p.svMax);
  });

  it('never returns negative values', () => {
    const sv = computeSV(0, 0.1, p);
    expect(sv).toBeGreaterThanOrEqual(0);
  });

  // --- Overdistension (descending limb) ---

  it('healthy heart: no overdistension penalty at normal EDV', () => {
    // edvCrit = 250 * (2.0/2.0) = 250, EDV=120 is well below
    const sv = computeSV(120, p.emaxRef, p);
    const svNoOverdistension = (p.svMax * 100) / (100 + p.km) * 1.0;
    expect(sv).toBeCloseTo(svNoOverdistension, 1);
  });

  it('healthy heart: SV declines at very high EDV (overdistension)', () => {
    // Past edvCrit=250, SV should start declining
    const svAtCrit = computeSV(250, p.emaxRef, p);
    const svPastCrit = computeSV(300, p.emaxRef, p);
    expect(svPastCrit).toBeLessThan(svAtCrit);
  });

  it('failing heart: overdistension threshold is lower', () => {
    const lowEmax = p.emaxRef * 0.4; // severe failure
    // edvCrit = 250 * 0.4 = 100
    // SV at EDV=90 (below threshold) vs EDV=180 (well above)
    const svBelow = computeSV(90, lowEmax, p);
    const svAbove = computeSV(180, lowEmax, p);
    // Despite higher EDV, SV should be lower due to overdistension
    expect(svAbove).toBeLessThan(svBelow);
  });

  it('fluid bolus worsens SV in cardiogenic shock', () => {
    const lowEmax = p.emaxRef * 0.4;
    // edvCrit = 250 * 0.4 = 100
    // At EDV=120 (above crit), adding more fluid makes it worse
    const svBefore = computeSV(120, lowEmax, p);
    const svAfterBolus = computeSV(160, lowEmax, p);
    expect(svAfterBolus).toBeLessThan(svBefore);
  });
});
