import { describe, it, expect } from 'vitest';
import { computePCWP, computeRVOutput, computeMPAP, computeTPG } from '../pulmonary';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';

describe('computePCWP', () => {
  const p = DEFAULT_PARAMS;

  it('returns ~10 mmHg at normal resting state', () => {
    // (120-20) × 0.2 / 2.0 = 10 mmHg
    expect(computePCWP(120, 2.0, p)).toBeCloseTo(10, 0);
  });

  it('rises with increased EDV (volume overload)', () => {
    const pcwpNormal = computePCWP(120, 2.0, p);
    const pcwpHigh   = computePCWP(180, 2.0, p);
    expect(pcwpHigh).toBeGreaterThan(pcwpNormal);
  });

  it('rises with reduced emax (systolic failure)', () => {
    const pcwpNormal  = computePCWP(120, 2.0, p);
    const pcwpFailing = computePCWP(120, 0.8, p);
    expect(pcwpFailing).toBeGreaterThan(pcwpNormal);
  });

  it('reaches pulmonary edema range (>18 mmHg) in cardiogenic shock', () => {
    // Acute MI: EDV=160 (dilation), emax=0.8
    const pcwp = computePCWP(160, 0.8, p);
    expect(pcwp).toBeGreaterThan(18);
  });

  it('never drops below 2 mmHg (floor)', () => {
    expect(computePCWP(0, 5.0, p)).toBeGreaterThanOrEqual(2);
  });
});

describe('computeRVOutput', () => {
  const p = DEFAULT_PARAMS;

  it('produces ~72 mL SV at resting state (matching LV output)', () => {
    const { rvSv } = computeRVOutput(150, 0.5, 70, p);
    expect(rvSv).toBeGreaterThan(65);
    expect(rvSv).toBeLessThan(85);
  });

  it('CO = HR × SV / 1000', () => {
    const { rvSv, rvCo } = computeRVOutput(150, 0.5, 70, p);
    expect(rvCo).toBeCloseTo((70 * rvSv) / 1000, 5);
  });

  it('increases with higher RVEDV (RV Starling)', () => {
    const low  = computeRVOutput(100, 0.5, 70, p);
    const high = computeRVOutput(180, 0.5, 70, p);
    expect(high.rvSv).toBeGreaterThan(low.rvSv);
  });

  it('decreases with reduced RV contractility', () => {
    const normal  = computeRVOutput(150, 0.5, 70, p);
    const failing = computeRVOutput(150, 0.2, 70, p);
    expect(failing.rvSv).toBeLessThan(normal.rvSv);
  });
});

describe('computeMPAP', () => {
  it('returns ~17–20 mmHg at resting state (normal PH threshold < 20)', () => {
    const p = DEFAULT_PARAMS;
    const { rvCo } = computeRVOutput(DEFAULT_STATE.rvedv, DEFAULT_STATE.rvEmax, DEFAULT_STATE.hr, p);
    const pcwp = computePCWP(DEFAULT_STATE.edv, DEFAULT_STATE.emax, p);
    const mPAP = computeMPAP(rvCo, DEFAULT_STATE.pvr, pcwp);
    expect(mPAP).toBeGreaterThan(12);
    expect(mPAP).toBeLessThan(22);
  });

  it('exceeds 25 mmHg (PH) with elevated PVR (Class I)', () => {
    const mPAP = computeMPAP(5.0, 5.0, 10); // high PVR, normal PCWP
    expect(mPAP).toBeGreaterThan(25);
  });

  it('exceeds 25 mmHg with elevated PCWP (Class II)', () => {
    const mPAP = computeMPAP(5.0, 1.5, 22); // normal PVR, high PCWP
    expect(mPAP).toBeGreaterThan(25);
  });

  it('responds to both PVR and PCWP additively', () => {
    const mPAPBase   = computeMPAP(5.0, 1.5, 10);
    const mPAPHighPVR  = computeMPAP(5.0, 5.0, 10);
    const mPAPHighPCWP = computeMPAP(5.0, 1.5, 25);
    expect(mPAPHighPVR).toBeGreaterThan(mPAPBase);
    expect(mPAPHighPCWP).toBeGreaterThan(mPAPBase);
  });
});

describe('computeTPG', () => {
  it('normal TPG < 12 mmHg (passive congestion)', () => {
    const tpg = computeTPG(20, 12);
    expect(tpg).toBe(8);
    expect(tpg).toBeLessThan(12);
  });

  it('elevated TPG (>12 mmHg) indicates intrinsic vascular disease', () => {
    const tpg = computeTPG(40, 15); // high PVR on top of congestion
    expect(tpg).toBeGreaterThan(12);
  });
});
