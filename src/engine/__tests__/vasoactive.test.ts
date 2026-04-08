import { describe, it, expect } from 'vitest';
import {
  computeHPV,
  computeHypoxicVasodilation,
  computeRVLVInterdependence,
  computeRvedvTarget,
  computeVasoactiveToneTargets,
} from '../vasoactive';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import { derive } from '../hemodynamics';

const p = DEFAULT_PARAMS;

describe('computeHPV (Hypoxic Pulmonary Vasoconstriction)', () => {
  it('returns 0 at normal SpO2 (above threshold)', () => {
    expect(computeHPV(0.97, p)).toBe(0);
    expect(computeHPV(0.93, p)).toBe(0); // exactly at threshold
  });

  it('returns positive PVR boost below threshold', () => {
    expect(computeHPV(0.85, p)).toBeGreaterThan(0);
  });

  it('is approximately +2 WU at SpO2=0.80', () => {
    // hpvGain=15, threshold=0.93: 15 × (0.93 − 0.80) = 1.95 WU
    expect(computeHPV(0.80, p)).toBeCloseTo(1.95, 1);
  });

  it('increases monotonically as SpO2 falls', () => {
    expect(computeHPV(0.85, p)).toBeGreaterThan(computeHPV(0.90, p));
    expect(computeHPV(0.75, p)).toBeGreaterThan(computeHPV(0.85, p));
  });

  it('never returns a negative value', () => {
    expect(computeHPV(1.0, p)).toBeGreaterThanOrEqual(0);
    expect(computeHPV(0.5, p)).toBeGreaterThan(0);
  });
});

describe('computeHypoxicVasodilation (Systemic)', () => {
  it('returns 0 at SpO2 above 0.90 (threshold)', () => {
    expect(computeHypoxicVasodilation(0.95, p)).toBe(0);
    expect(computeHypoxicVasodilation(0.90, p)).toBe(0);
  });

  it('returns SVR reduction below threshold', () => {
    expect(computeHypoxicVasodilation(0.85, p)).toBeGreaterThan(0);
  });

  it('is approximately −2 WU at SpO2=0.80', () => {
    // hypoxicVasoGain=20, threshold=0.90: 20 × (0.90 − 0.80) = 2 WU
    expect(computeHypoxicVasodilation(0.80, p)).toBeCloseTo(2.0, 1);
  });

  it('HPV threshold (0.93) precedes systemic vasodilation (0.90)', () => {
    // HPV kicks in earlier to preserve V/Q before systemic collapse
    expect(computeHPV(0.91, p)).toBeGreaterThan(0);
    expect(computeHypoxicVasodilation(0.91, p)).toBe(0);
  });
});

describe('computeRVLVInterdependence (Septal Shift)', () => {
  it('returns 0 at baseline RVEDV (150 mL, below threshold of 195)', () => {
    expect(computeRVLVInterdependence(150, p)).toBe(0);
  });

  it('returns 0 at threshold (195 mL)', () => {
    expect(computeRVLVInterdependence(195, p)).toBe(0);
  });

  it('returns positive EDV penalty above threshold', () => {
    expect(computeRVLVInterdependence(200, p)).toBeGreaterThan(0);
  });

  it('penalty ≈ 24.75 mL at RVEDV=250 mL', () => {
    // rvlvGain=0.45: 0.45 × (250 − 195) = 24.75 mL
    expect(computeRVLVInterdependence(250, p)).toBeCloseTo(24.75, 1);
  });

  it('increases monotonically with RVEDV above threshold', () => {
    expect(computeRVLVInterdependence(250, p)).toBeGreaterThan(computeRVLVInterdependence(220, p));
    expect(computeRVLVInterdependence(300, p)).toBeGreaterThan(computeRVLVInterdependence(250, p));
  });
});

describe('computeRvedvTarget (RV Afterload Dilation)', () => {
  it('returns rvedvRef at pvrRef (no dilation at rest)', () => {
    expect(computeRvedvTarget(p.pvrRef, p.rvedvRef, p)).toBeCloseTo(p.rvedvRef, 5);
  });

  it('increases RVEDV target when PVR exceeds reference', () => {
    expect(computeRvedvTarget(3.0, p.rvedvRef, p)).toBeGreaterThan(p.rvedvRef);
  });

  it('exceeds interdependence threshold (195 mL) at moderate PH (PVR = 4.5 WU)', () => {
    // +3 WU above ref: 150 + 15 × 3 = 195 mL exactly at threshold
    expect(computeRvedvTarget(4.5, p.rvedvRef, p)).toBeCloseTo(195, 0);
  });

  it('produces significant dilation at severe PH (PVR = 7 WU)', () => {
    // +5.5 WU above ref: 150 + 15 × 5.5 = 232.5 mL → well above threshold
    expect(computeRvedvTarget(7.0, p.rvedvRef, p)).toBeCloseTo(232.5, 1);
  });
});

describe('computeVasoactiveToneTargets', () => {
  it('both targets are 0 at normal baseline', () => {
    const { noToneTarget, et1ToneTarget } = computeVasoactiveToneTargets(0.97, 17, p);
    expect(noToneTarget).toBe(0);
    expect(et1ToneTarget).toBe(0);
  });

  it('noToneTarget rises with hypoxemia', () => {
    const { noToneTarget } = computeVasoactiveToneTargets(0.80, 17, p);
    expect(noToneTarget).toBeGreaterThan(0);
  });

  it('noToneTarget ≈ 0.52 at SpO2=0.80', () => {
    // noToneSpO2Gain=4, threshold=0.93: 4 × (0.93 − 0.80) = 0.52
    const { noToneTarget } = computeVasoactiveToneTargets(0.80, 17, p);
    expect(noToneTarget).toBeCloseTo(0.52, 2);
  });

  it('noToneTarget is clamped to 1 at extreme hypoxemia', () => {
    const { noToneTarget } = computeVasoactiveToneTargets(0.50, 17, p);
    expect(noToneTarget).toBe(1);
  });

  it('et1ToneTarget rises above mPAP threshold (18 mmHg)', () => {
    const { et1ToneTarget } = computeVasoactiveToneTargets(0.97, 30, p);
    expect(et1ToneTarget).toBeGreaterThan(0);
  });

  it('et1ToneTarget ≈ 0.48 at mPAP=30 mmHg', () => {
    // et1ToneMpapGain=0.04, threshold=18: 0.04 × (30 − 18) = 0.48
    const { et1ToneTarget } = computeVasoactiveToneTargets(0.97, 30, p);
    expect(et1ToneTarget).toBeCloseTo(0.48, 2);
  });

  it('et1ToneTarget is 0 at normal mPAP (below threshold)', () => {
    const { et1ToneTarget } = computeVasoactiveToneTargets(0.97, 15, p);
    expect(et1ToneTarget).toBe(0);
  });

  it('et1ToneTarget is clamped to 1 at extreme PH', () => {
    const { et1ToneTarget } = computeVasoactiveToneTargets(0.97, 60, p);
    expect(et1ToneTarget).toBe(1);
  });
});

describe('Vasoactive integration: PH → ET-1 → PVR amplification', () => {
  it('elevated mPAP raises et1ToneTarget, which would increase PVR in derive()', () => {
    // At baseline, no ET-1 activation
    const baseState = DEFAULT_STATE;
    const baseDerived = derive(baseState, p);
    expect(baseDerived.mPAP).toBeLessThan(p.et1ToneMpapThreshold + 2);

    // With elevated PVR (PAH scenario), mPAP rises above threshold
    const pahState = { ...DEFAULT_STATE, pvr: 5.5 };
    const pahDerived = derive(pahState, p);
    expect(pahDerived.mPAP).toBeGreaterThan(p.et1ToneMpapThreshold);

    // ET-1 target should be positive → over time et1Tone rises → PVR rises further
    const { et1ToneTarget } = computeVasoactiveToneTargets(pahDerived.spO2, pahDerived.mPAP, p);
    expect(et1ToneTarget).toBeGreaterThan(0);
  });

  it('high noTone reduces MAP via SVR and Emax depression', () => {
    const baseDerived = derive(DEFAULT_STATE, p);
    const sepsisState = { ...DEFAULT_STATE, noTone: 0.7 };
    const sepsisDerived = derive(sepsisState, p);

    // SVR is reduced, Emax is reduced → MAP drops
    expect(sepsisDerived.map).toBeLessThan(baseDerived.map);
  });

  it('RVEDV above threshold produces EDV penalty reducing MAP', () => {
    const baseState = DEFAULT_STATE;
    const rvDilatedState = { ...DEFAULT_STATE, rvedv: 250 };

    const baseDerived = derive(baseState, p);
    const dilatedDerived = derive(rvDilatedState, p);

    // Septal shift reduces effective EDV → SV↓ → CO↓ → MAP↓
    expect(dilatedDerived.sv).toBeLessThan(baseDerived.sv);
    expect(dilatedDerived.map).toBeLessThan(baseDerived.map);
  });
});
