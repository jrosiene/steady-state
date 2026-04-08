import { describe, it, expect } from 'vitest';
import {
  computeAlveolarPO2,
  hillSaturation,
  hillPO2,
  computeSvO2,
  computeOxygenation,
} from '../oxygenation';
import { DEFAULT_PARAMS } from '../constants';

const p = DEFAULT_PARAMS;

describe('computeAlveolarPO2', () => {
  it('room air PAO2 ≈ 99 mmHg', () => {
    // 0.21 × (760-47) - 40/0.8 = 0.21×713 - 50 = 149.7 - 50 = 99.7
    expect(computeAlveolarPO2(0.21, p)).toBeCloseTo(99.7, 0);
  });

  it('100% O2 PAO2 ≈ 663 mmHg', () => {
    expect(computeAlveolarPO2(1.0, p)).toBeCloseTo(663, 0);
  });

  it('increases monotonically with FiO2', () => {
    expect(computeAlveolarPO2(0.5, p)).toBeGreaterThan(computeAlveolarPO2(0.3, p));
  });
});

describe('hillSaturation', () => {
  it('≈97% at PaO2=100 mmHg (normal)', () => {
    expect(hillSaturation(100, p)).toBeCloseTo(0.972, 2);
  });

  it('≈90% at PaO2=60 mmHg (the 60/90 rule)', () => {
    expect(hillSaturation(60, p)).toBeCloseTo(0.9, 1);
  });

  it('≈75% at PaO2=40 mmHg (mixed venous territory)', () => {
    expect(hillSaturation(40, p)).toBeCloseTo(0.75, 1);
  });

  it('returns 0 at PaO2 ≤ 0', () => {
    expect(hillSaturation(0, p)).toBe(0);
    expect(hillSaturation(-10, p)).toBe(0);
  });

  it('approaches 1 at very high PaO2', () => {
    expect(hillSaturation(600, p)).toBeGreaterThan(0.99);
  });
});

describe('hillPO2 (inverse Hill)', () => {
  it('is the inverse of hillSaturation', () => {
    const sat = hillSaturation(80, p);
    expect(hillPO2(sat, p)).toBeCloseTo(80, 0);
  });

  it('round-trips correctly across the physiologic range', () => {
    for (const pO2 of [30, 50, 80, 100, 150]) {
      const sat = hillSaturation(pO2, p);
      expect(hillPO2(sat, p)).toBeCloseTo(pO2, 0);
    }
  });
});

describe('computeSvO2', () => {
  it('≈73% at rest (normal Fick)', () => {
    // CO=5.0, Hgb=15, VO2=250: SvO2 = 0.972 - 250/(5×15×1.34×10) = 0.972 - 0.249 ≈ 0.72
    expect(computeSvO2(5.0, 0.972, p)).toBeCloseTo(0.72, 1);
  });

  it('falls with low CO (Fick: less O2 delivery → more extraction)', () => {
    const svO2Normal = computeSvO2(5.0, 0.97, p);
    const svO2Low    = computeSvO2(2.5, 0.97, p);
    expect(svO2Low).toBeLessThan(svO2Normal);
  });

  it('never drops below 0.1 (clamp)', () => {
    expect(computeSvO2(0.1, 0.97, p)).toBeGreaterThanOrEqual(0.1);
  });
});

describe('computeOxygenation (full pipeline)', () => {
  it('SpO2 ≈ 97% on room air with minimal shunt', () => {
    const { spO2 } = computeOxygenation(0.21, 0.02, 5.0, p);
    expect(spO2).toBeGreaterThan(0.95);
    expect(spO2).toBeLessThan(0.99);
  });

  it('PaO2 ≈ 90–130 mmHg on room air at rest', () => {
    const { paO2 } = computeOxygenation(0.21, 0.02, 5.0, p);
    expect(paO2).toBeGreaterThan(90);
    expect(paO2).toBeLessThan(130);
  });

  it('SpO2 falls with high shunt fraction', () => {
    const { spO2: spO2Low  } = computeOxygenation(0.21, 0.02, 5.0, p);
    const { spO2: spO2High } = computeOxygenation(0.21, 0.30, 5.0, p);
    expect(spO2High).toBeLessThan(spO2Low);
  });

  it('SpO2 barely improves with 100% O2 when shunt is large (key teaching point)', () => {
    const { spO2: spO2RoomAir } = computeOxygenation(0.21, 0.30, 5.0, p);
    const { spO2: spO2HighO2  } = computeOxygenation(1.0,  0.30, 5.0, p);
    // O2 helps a little but not much — shunt is perfusion without ventilation
    expect(spO2HighO2).toBeGreaterThan(spO2RoomAir);
    expect(spO2HighO2 - spO2RoomAir).toBeLessThan(0.06); // < 6% improvement
  });

  it('SpO2 significantly improves with O2 when shunt is small (V/Q mismatch)', () => {
    const { spO2: spO2RoomAir } = computeOxygenation(0.21, 0.05, 5.0, p);
    const { spO2: spO2HighO2  } = computeOxygenation(1.0,  0.05, 5.0, p);
    expect(spO2HighO2).toBeGreaterThan(spO2RoomAir + 0.01);
  });

  it('SvO2 falls with low CO (Fick principle)', () => {
    const { svO2: svO2Normal } = computeOxygenation(0.21, 0.02, 5.0, p);
    const { svO2: svO2Low    } = computeOxygenation(0.21, 0.02, 2.0, p);
    expect(svO2Low).toBeLessThan(svO2Normal);
  });

  it('all values are finite and in valid ranges', () => {
    const { spO2, paO2, svO2 } = computeOxygenation(0.21, 0.02, 5.0, p);
    expect(Number.isFinite(spO2)).toBe(true);
    expect(Number.isFinite(paO2)).toBe(true);
    expect(Number.isFinite(svO2)).toBe(true);
    expect(spO2).toBeGreaterThan(0);
    expect(spO2).toBeLessThanOrEqual(1);
    expect(paO2).toBeGreaterThan(0);
    expect(svO2).toBeGreaterThan(0);
    expect(svO2).toBeLessThanOrEqual(1);
  });
});
