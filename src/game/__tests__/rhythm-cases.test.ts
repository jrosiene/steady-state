/**
 * Atrial fibrillation on the ward.
 *
 * Same rhythm, three ventricles, three answers to "should I slow it down?" —
 * plus the things a covering doctor sees: an irregular pulse on the chart, AF
 * on the EKG, and a cardioversion that fixes the rhythm and nothing else.
 */
import { describe, it, expect } from 'vitest';
import { advance, advanceToDeclaration, soloShift } from '../testing';
import { generateWard } from '../content/generate';

const MIN = 60;
const snapOf = (s: ReturnType<typeof soloShift>) => s.engine.snapshot(s.patient);

describe('what the player can see', () => {
  it('charts an irregular pulse and reads AF on the EKG', () => {
    const s = soloShift('af-rvr-hfpef', { severity: 0.6 });
    advanceToDeclaration(s, 20);
    s.engine.placeOrder(s.patient, 'vitals-now');
    s.engine.placeOrder(s.patient, 'img-ekg');
    advance(s.engine, 20 * MIN);
    expect(s.patient.lastVitals?.irregular).toBe(true);
    expect(s.patient.lastVitals!.hr).toBeGreaterThan(130);
    const ekg = s.patient.labs.find((l) => l.panel === 'EKG')!;
    expect(ekg.impression).toMatch(/Atrial fibrillation with rapid ventricular response/);
  });

  it('pages about the rhythm', () => {
    const s = soloShift('af-rvr-hfpef', { severity: 0.6 });
    advanceToDeclaration(s, 30);
    const page = s.patient.messages.find((m) => m.kind === 'page');
    expect(page?.text).toMatch(/irregular/);
  });
});

describe('a stiff ventricle: slow it down', () => {
  it('fills the lungs in AF and gives it back with rate control', () => {
    const left = soloShift('af-rvr-hfpef', { severity: 0.85 });
    advanceToDeclaration(left, 60);
    const untreated = snapOf(left);

    const treated = soloShift('af-rvr-hfpef', { severity: 0.85 });
    advanceToDeclaration(treated, 5);
    treated.engine.placeOrder(treated.patient, 'metoprolol-iv');
    advanceToDeclaration(treated, 60);
    const controlled = snapOf(treated);

    expect(untreated.hr).toBeGreaterThan(150);
    expect(controlled.hr).toBeLessThan(untreated.hr - 30);
    expect(controlled.pcwp).toBeLessThan(untreated.pcwp - 4);
    expect(controlled.spO2).toBeGreaterThan(untreated.spO2);
  });

  it('is not helped by a liter of fluid', () => {
    const s = soloShift('af-rvr-hfpef', { severity: 0.85 });
    const before = (() => { advanceToDeclaration(s, 20); return snapOf(s); })();
    s.engine.placeOrder(s.patient, 'ns-1000');
    advanceToDeclaration(s, 70);
    expect(snapOf(s).pcwp).toBeGreaterThan(before.pcwp);
    expect(snapOf(s).spO2).toBeLessThanOrEqual(before.spO2);
  });
});

describe('a failing ventricle: slow it down with the right drug', () => {
  it('drops the pressure with diltiazem, and not with amiodarone', () => {
    const dilt = soloShift('af-rvr-hfref', { severity: 0.6 });
    advanceToDeclaration(dilt, 5);
    const mapBefore = snapOf(dilt).map;
    dilt.engine.placeOrder(dilt.patient, 'diltiazem');
    advanceToDeclaration(dilt, 25);

    const amio = soloShift('af-rvr-hfref', { severity: 0.6 });
    advanceToDeclaration(amio, 5);
    amio.engine.placeOrder(amio.patient, 'amiodarone');
    advanceToDeclaration(amio, 60);

    expect(snapOf(dilt).map).toBeLessThan(mapBefore - 6);
    expect(snapOf(amio).map).toBeGreaterThan(snapOf(dilt).map);
    expect(snapOf(amio).hr).toBeLessThan(125);
  });
});

describe('sepsis: treat the sepsis', () => {
  it('kills if ignored, and a mild one does not', () => {
    const severe = soloShift('af-rvr-sepsis', { severity: 0.85 });
    advanceToDeclaration(severe, 300, 60);
    expect(severe.patient.status).toBe('died');

    const mild = soloShift('af-rvr-sepsis', { severity: 0.3 });
    advanceToDeclaration(mild, 600, 60);
    expect(mild.patient.status).not.toBe('died');
  });

  it('brings the rate down with fluid and antibiotics, without touching the AV node', () => {
    const s = soloShift('af-rvr-sepsis', { severity: 0.85 });
    advanceToDeclaration(s, 45);
    const rvr = snapOf(s).hr;
    for (const id of ['ns-1000', 'pip-tazo', 'lab-cultures']) s.engine.placeOrder(s.patient, id);
    advanceToDeclaration(s, 120, 60);
    expect(s.patient.status).not.toBe('died');
    expect(snapOf(s).hr).toBeLessThan(rvr);
    expect(snapOf(s).avBlock).toBe(0);
  });
});

describe('cardioversion', () => {
  it('restores sinus rhythm and stops the case\'s AF', () => {
    const s = soloShift('af-rvr-hfpef', { severity: 0.6 });
    advanceToDeclaration(s, 10);
    s.engine.placeOrder(s.patient, 'cardioversion');
    advanceToDeclaration(s, 45);
    expect(snapOf(s).afib).toBeLessThan(0.05);
    expect(snapOf(s).hr).toBeLessThan(110);
  });

  it('does nothing about the sepsis that caused it', () => {
    const s = soloShift('af-rvr-sepsis', { severity: 0.85 });
    advanceToDeclaration(s, 40);
    s.engine.placeOrder(s.patient, 'cardioversion');
    advanceToDeclaration(s, 300, 60);
    expect(s.patient.status).toBe('died');
  });
});

describe('permanent AF as a background', () => {
  it('appears on some wards and hands them over rate-controlled', () => {
    let found = 0;
    for (let i = 0; i < 40 && found < 3; i++) {
      for (const c of generateWard({ seed: `CHRONICAF${i}` }).cases) {
        if (!c.comorbidities.includes('Permanent atrial fibrillation, rate-controlled')) continue;
        found += 1;
        expect(c.stateOverrides?.afib).toBe(1);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
