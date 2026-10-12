/**
 * Obesity on the ward.
 *
 * Obesity hypoventilation decompensating overnight — sleep, a bedtime opioid
 * and the oxygen given for the desaturation that follows — and what each of
 * the obvious answers does: BiPAP fixes it, sitting up helps the oxygen and
 * not the CO2, naloxone helps only as long as it lasts.
 */
import { describe, it, expect } from 'vitest';
import { advance, advanceToDeclaration, soloShift } from '../testing';
import { generateWard } from '../content/generate';

const MIN = 60;
const snapOf = (s: ReturnType<typeof soloShift>) => s.engine.snapshot(s.patient);

describe('obesity hypoventilation overnight', () => {
  it('hands over awake with a compensated hypercapnia and a bicarbonate nobody explained', () => {
    const s = soloShift('ohs-overnight', { severity: 0.85 });
    advanceToDeclaration(s, -10);
    const snap = snapOf(s);
    expect(snap.paCO2).toBeGreaterThan(47);
    expect(snap.pH).toBeGreaterThan(7.36);
    expect(snap.atelectasis).toBeGreaterThan(0.04);
    const bmp = s.patient.case.priorLabs.find((l) => l.panel === 'BMP')!;
    expect(bmp.values.find((v) => v.label === 'Bicarbonate')!.value).toBeGreaterThan(30);
  });

  it('retains asleep on oxygen, with a saturation that hides it', () => {
    const s = soloShift('ohs-overnight', { severity: 0.85 });
    advanceToDeclaration(s, -10);
    const awake = snapOf(s);
    advanceToDeclaration(s, 75);
    const asleep = snapOf(s);
    expect(s.patient.o2Device).toBe('6L NC');
    expect(asleep.paCO2).toBeGreaterThan(awake.paCO2 + 15);
    expect(asleep.pH).toBeLessThan(7.3);
    expect(asleep.spO2).toBeGreaterThan(0.92);
    expect(asleep.atelectasis).toBeGreaterThan(awake.atelectasis * 1.5);
  });

  it('is corrected by BiPAP: ventilation and recruited bases', () => {
    const s = soloShift('ohs-overnight', { severity: 0.85 });
    advanceToDeclaration(s, 70);
    const before = snapOf(s);
    s.engine.placeOrder(s.patient, 'bipap');
    advanceToDeclaration(s, 160);
    const after = snapOf(s);
    expect(after.paCO2).toBeLessThan(before.paCO2 - 10);
    expect(after.pH).toBeGreaterThan(7.33);
    expect(after.atelectasis).toBeLessThan(before.atelectasis * 0.6);
  });

  it('sitting up opens the bases but does not fix the CO2', () => {
    const s = soloShift('ohs-overnight', { severity: 0.85 });
    advanceToDeclaration(s, 70);
    const before = snapOf(s);
    s.engine.placeOrder(s.patient, 'sit-up');
    advanceToDeclaration(s, 160);
    const after = snapOf(s);
    expect(after.atelectasis).toBeLessThan(before.atelectasis * 0.8);
    expect(after.spO2).toBeGreaterThan(before.spO2);
    expect(after.paCO2).toBeGreaterThan(before.paCO2 - 6);
  });

  it('naloxone reverses the opioid, not the sleep', () => {
    const s = soloShift('ohs-overnight', { severity: 0.85 });
    advanceToDeclaration(s, 70);
    const before = snapOf(s);
    s.engine.placeOrder(s.patient, 'naloxone');
    advance(s.engine, 15 * MIN);
    const reversed = snapOf(s);
    expect(reversed.cnsDepression).toBeLessThan(before.cnsDepression - 0.2);
    // Still asleep, still hypoventilating.
    expect(reversed.paCO2).toBeGreaterThan(60);
  });

  it('survives the night untreated, acidemic', () => {
    const s = soloShift('ohs-overnight', { severity: 1 });
    let worst = 8;
    for (let m = 0; m <= 600; m += 30) {
      advanceToDeclaration(s, m, 60);
      worst = Math.min(worst, snapOf(s).pH);
    }
    expect(s.patient.status).not.toBe('died');
    expect(worst).toBeLessThan(7.27);
  });
});

describe('obesity as a background', () => {
  it('carries collapsed bases and a heavy chest wall into the case', () => {
    let found = 0;
    for (let i = 0; i < 40 && found < 3; i++) {
      for (const c of generateWard({ seed: `OBESE${i}` }).cases) {
        if (!c.comorbidities.includes('Obesity')) continue;
        found += 1;
        expect(c.paramOverrides?.atelectasisProne).toBeGreaterThan(0);
        expect(c.paramOverrides?.chestWallLoad).toBeGreaterThan(0);
        expect(c.stateOverrides?.atelectasis).toBeGreaterThan(0);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
