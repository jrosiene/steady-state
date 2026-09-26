/**
 * Ventilation on the ward.
 *
 * The bedside consequences of PaCO2 being physiology: an oximeter that reads
 * fine on a patient who has nearly stopped breathing, a reversal agent that
 * wears off before the drug it reverses, and a well-meant non-rebreather that
 * narcotizes a CO2 retainer.
 */
import { describe, it, expect } from 'vitest';
import { advance, advanceToDeclaration, soloShift } from '../testing';
import { answerQuestion } from '../nurse';
import { respiratoryRate } from '../clinical';
import { ORDERS, O2_LABEL_PREFIX } from '../orders';

const MIN = 60;

function snapOf(s: ReturnType<typeof soloShift>) {
  return s.engine.snapshot(s.patient);
}

describe('opioid oversedation', () => {
  it('hides behind a normal saturation while the rate falls', () => {
    const s = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(s, 60);
    const snap = snapOf(s);
    expect(s.patient.o2Device).toBe('2L NC');
    expect(snap.spO2).toBeGreaterThan(0.94);
    expect(respiratoryRate(snap, s.patient.case.rrOffset)).toBeLessThan(9);
    expect(snap.cnsDepression).toBeGreaterThan(0.6);
    expect(snap.paCO2).toBeGreaterThan(45);
  });

  it('kills if ignored, and a mild one does not', () => {
    const severe = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(severe, 240, 60);
    expect(severe.patient.status).toBe('died');

    const mild = soloShift('opioid-oversedation', { severity: 0.3 });
    advanceToDeclaration(mild, 600, 60);
    expect(mild.patient.status).not.toBe('died');
  });

  it('wakes within minutes of naloxone', () => {
    const s = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(s, 50);
    expect(snapOf(s).cnsDepression).toBeGreaterThan(0.6);
    s.engine.placeOrder(s.patient, 'naloxone');
    advance(s.engine, 12 * MIN);
    expect(snapOf(s).cnsDepression).toBeLessThan(0.2);
    expect(snapOf(s).rr).toBeGreaterThan(12);
  });

  it('re-sedates when the naloxone wears off and the PCA is still running', () => {
    const s = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(s, 50);
    s.engine.placeOrder(s.patient, 'naloxone');
    advanceToDeclaration(s, 150);
    expect(snapOf(s).cnsDepression).toBeGreaterThan(0.5);
  });

  it('stays awake once the opioids are actually stopped', () => {
    const s = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(s, 50);
    s.engine.placeOrder(s.patient, 'naloxone');
    s.engine.placeOrder(s.patient, 'hold-opioids');
    advanceToDeclaration(s, 240, 60);
    expect(s.patient.status).not.toBe('died');
    expect(snapOf(s).cnsDepression).toBeLessThan(0.35);
    expect(s.patient.heldMeds).toContain('pca');
  });

  it('lets the nurse describe what they see', () => {
    const s = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(s, 60);
    const mental = answerQuestion('mental', s.patient, snapOf(s));
    const breathing = answerQuestion('breathing', s.patient, snapOf(s));
    expect(mental.toLowerCase()).toMatch(/wake|rub/);
    expect(breathing).toMatch(/^Slow/);
  });

  it('shows the hypercapnia on an arterial gas', () => {
    const s = soloShift('opioid-oversedation', { severity: 0.85 });
    advanceToDeclaration(s, 60);
    s.engine.placeOrder(s.patient, 'lab-abg');
    advance(s.engine, 30 * MIN);
    const abg = s.patient.labs.find((l) => l.panel === 'ABG')!;
    const paCO2 = abg.values.find((v) => v.label === 'PaCO₂')!;
    expect(paCO2.value).toBeGreaterThan(50);
  });
});

describe('the chronic CO2 retainer', () => {
  it('hands over an afternoon gas that matches the patient tonight', () => {
    const s = soloShift('copd-exacerbation', { severity: 0.6, declareAt: 3 * 60 * MIN });
    const afternoon = s.patient.case.priorLabs.find((l) => l.panel === 'VBG' && l.drawnAt === -210 * MIN)!;
    const priorPco2 = afternoon.values.find((v) => v.label === 'pCO₂')!.value;

    s.engine.placeOrder(s.patient, 'lab-vbg');
    advance(s.engine, 30 * MIN);
    const tonight = s.patient.labs.find((l) => l.panel === 'VBG')!;
    const pco2 = tonight.values.find((v) => v.label === 'pCO₂')!.value;
    expect(Math.abs(pco2 - priorPco2)).toBeLessThan(6);
    expect(pco2).toBeGreaterThan(50);
  });

  it('retains on a non-rebreather and is rescued by BiPAP', () => {
    const nrb = soloShift('copd-exacerbation', { severity: 1 });
    nrb.engine.placeOrder(nrb.patient, 'o2-nrb');
    advanceToDeclaration(nrb, 30);
    const onNrb = snapOf(nrb).paCO2;

    const niv = soloShift('copd-exacerbation', { severity: 1 });
    advanceToDeclaration(niv, 0);
    for (const id of ['duoneb', 'steroids', 'bipap']) niv.engine.placeOrder(niv.patient, id);
    advanceToDeclaration(niv, 90);
    const onNiv = snapOf(niv);

    expect(onNrb).toBeGreaterThan(onNiv.paCO2 + 20);
    expect(onNiv.pH).toBeGreaterThan(7.33);
  });
});

describe('oxygen-induced hypercapnia', () => {
  it('charts the device the nurse put on', () => {
    const s = soloShift('copd-o2-narcosis', { severity: 0.85 });
    advanceToDeclaration(s, 20);
    expect(s.patient.o2Device).toBe('NRB 15L');
    expect(snapOf(s).fiO2).toBeGreaterThan(0.8);
  });

  it('narcotizes on the non-rebreather, and turning it down reverses it', () => {
    const left = soloShift('copd-o2-narcosis', { severity: 1 });
    advanceToDeclaration(left, 120, 60);
    const untreated = snapOf(left);
    expect(untreated.paCO2).toBeGreaterThan(80);
    expect(untreated.spO2).toBeGreaterThan(0.9); // the reassuring number

    const fixed = soloShift('copd-o2-narcosis', { severity: 1 });
    advanceToDeclaration(fixed, 20);
    fixed.engine.placeOrder(fixed.patient, 'o2-nc');
    advanceToDeclaration(fixed, 120, 60);
    expect(fixed.patient.o2Device).toBe('2L NC');
    expect(snapOf(fixed).paCO2).toBeLessThan(untreated.paCO2 - 15);
  });
});

describe('oxygen devices take all of themselves off', () => {
  it('stops BiPAP recruitment, preload and ventilation when switched to a cannula', () => {
    const s = soloShift('copd-exacerbation', { severity: 0.6 });
    s.engine.placeOrder(s.patient, 'bipap');
    advance(s.engine, 30 * MIN);
    s.engine.placeOrder(s.patient, 'o2-nc');
    advance(s.engine, 10 * MIN);
    const stillRunning = s.patient.interventions.filter((iv) =>
      iv.label.includes('BiPAP') && iv.stopTime === undefined);
    expect(stillRunning).toEqual([]);
  });

  it('gives every device component the device prefix', () => {
    for (const order of ORDERS.filter((o) => o.o2Device)) {
      for (const iv of order.interventions ?? []) {
        if (iv.kind === 'bolus') continue; // induction drugs are given, not worn
        expect(iv.label.startsWith(O2_LABEL_PREFIX), `${order.id}: ${iv.label}`).toBe(true);
      }
    }
  });
});

describe('sedatives act on breathing', () => {
  it('depresses ventilation more in a patient with sleep apnea', () => {
    const plain = soloShift('benign-post-op-pain', { severity: 0.3 });
    const osa = soloShift('opioid-oversedation', { severity: 0.3 });
    for (const s of [plain, osa]) {
      s.engine.placeOrder(s.patient, 'hydromorphone');
    }
    advance(plain.engine, 30 * MIN);
    advance(osa.engine, 30 * MIN);
    expect(osa.patient.params.sedativeSensitivity).toBeGreaterThan(1.2);
    expect(snapOf(osa).cnsDepression).toBeGreaterThan(snapOf(plain).cnsDepression);
  });
});
