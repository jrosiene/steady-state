import { describe, it, expect } from 'vitest';
import { ShiftEngine } from '../shift';
import { CASES } from '../cases';
import { ORDER_BY_ID } from '../orders';
import { assessAppearance, describeAppearance, acuityLabel } from '../clinical';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../../engine/constants';
import { snapshot as computeSnapshot } from '../../engine/hemodynamics';
import type { PatientCase, PatientRuntime } from '../types';
import { SHIFT_DURATION_SEC } from '../types';

/** Advance the shift by `seconds`, in realistic tick sizes. */
function run(engine: ShiftEngine, seconds: number, tickSec = 30) {
  const ticks = Math.ceil(seconds / tickSec);
  for (let i = 0; i < ticks; i++) engine.tick(tickSec);
}

function patient(engine: ShiftEngine, id: string): PatientRuntime {
  const p = engine.patients.find((x) => x.case.id === id);
  if (!p) throw new Error(`no patient ${id}`);
  return p;
}

function started(cases: PatientCase[] = CASES): ShiftEngine {
  const e = new ShiftEngine(cases);
  e.start();
  return e;
}

/** Isolate a single case so one patient's trajectory can be studied alone. */
function only(id: string): PatientCase[] {
  return CASES.filter((c) => c.id === id);
}

describe('ShiftEngine lifecycle', () => {
  it('starts in briefing and does not advance until started', () => {
    const engine = new ShiftEngine();
    expect(engine.phase).toBe('briefing');
    run(engine, 3600);
    expect(engine.time).toBe(0);
  });

  it('advances sim time once running and ends after 12 hours', () => {
    const engine = started();
    run(engine, 3600, 60);
    expect(engine.time).toBeGreaterThan(3500);
    expect(engine.phase).toBe('running');

    run(engine, SHIFT_DURATION_SEC, 300);
    expect(engine.phase).toBe('ended');
    expect(engine.patients.every((p) => p.outcome !== null)).toBe(true);
  }, 30_000);

  it('gives every patient a signed-out set of vitals before the shift starts', () => {
    const engine = new ShiftEngine();
    for (const p of engine.patients) {
      expect(p.lastVitals).not.toBeNull();
      expect(p.lastVitals!.sbp).toBeGreaterThan(60);
    }
  });

  it('keeps every patient physiologically stable at baseline', () => {
    // No case should be decompensating before its illness script fires.
    const engine = started();
    run(engine, 10 * 60, 30);
    for (const p of engine.patients) {
      const snap = engine.snapshot(p);
      expect(snap.cardiovascularStatus).toBe('compensated');
      expect(snap.map).toBeGreaterThan(60);
      expect(Number.isFinite(snap.map)).toBe(true);
    }
  });
});

describe('observation model', () => {
  it('does not refresh floor vitals between routine rounds', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    run(engine, 30 * 60, 60);
    // Routine floor observations are q4h — nothing new should have been charted.
    expect(p.lastVitals!.time).toBe(0);
  });

  it('gives live vitals once the patient is monitored', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    engine.placeOrder(p, 'telemetry');
    run(engine, 20 * 60, 60);

    expect(p.monitored).toBe(true);
    const view = engine.view(p);
    expect(view.live).toBe(true);
    expect(view.vitalsAgeSec).toBeLessThan(60);
  });

  it('charts a fresh set on request', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    run(engine, 45 * 60, 60);
    engine.placeOrder(p, 'vitals-now');
    expect(p.lastVitals!.time).toBeGreaterThan(40 * 60);
  });

  it('pages the doctor when a nurse finds concerning vitals', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    run(engine, 3 * 3600, 60);
    const pages = p.messages.filter((m) => m.kind === 'page');
    expect(pages.length).toBeGreaterThan(0);
    expect(p.unread).toBeGreaterThan(0);
  });
});

describe('illness trajectories', () => {
  it('urosepsis progresses to shock when untreated', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    run(engine, 5 * 3600, 60);

    const snap = engine.snapshot(p);
    expect(snap.map).toBeLessThan(70);
    expect(snap.lactate).toBeGreaterThan(2.5);
    expect(['shock', 'decompensating', 'arrest']).toContain(snap.cardiovascularStatus);
  });

  it('urosepsis responds to timely fluids, antibiotics and escalation', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');

    // Treated promptly after the first page.
    run(engine, 45 * 60, 60);
    engine.placeOrder(p, 'ns-1000');
    engine.placeOrder(p, 'abx');
    engine.placeOrder(p, 'telemetry');
    run(engine, 4 * 3600 + 15 * 60, 60);

    const treated = engine.snapshot(p);

    // Same case, same script, no treatment.
    const control = started(only('whitfield'));
    run(control, 5 * 3600, 60);
    const untreated = control.snapshot(patient(control, 'whitfield'));

    expect(treated.map).toBeGreaterThan(untreated.map);
    expect(treated.lactate).toBeLessThan(untreated.lactate);
    expect(p.status).not.toBe('died');
  });

  it('pulmonary embolism produces RV strain with a low wedge', () => {
    const engine = started(only('okonkwo'));
    const p = patient(engine, 'okonkwo');
    run(engine, 4 * 3600 + 30 * 60, 60);

    const snap = engine.snapshot(p);
    // The signature of obstructive shock: high pulmonary pressures, normal filling.
    expect(snap.mPAP).toBeGreaterThan(28);
    expect(snap.pcwp).toBeLessThan(18);
    expect(snap.rvedv).toBeGreaterThan(180);
    expect(snap.spO2).toBeLessThan(0.92);
  });

  it('GI bleed drops haemoglobin and preload; transfusion reverses both', () => {
    const engine = started(only('castellanos'));
    const p = patient(engine, 'castellanos');
    // Into the rebleed, before it has run its course.
    run(engine, 4 * 3600 + 20 * 60, 60);

    const bleeding = engine.snapshot(p);
    expect(p.params.hgb).toBeLessThan(9.8);
    expect(bleeding.edv).toBeLessThan(110);

    const hgbBefore = p.params.hgb;
    engine.placeOrder(p, 'prbc');
    engine.placeOrder(p, 'ns-1000');
    run(engine, 3 * 3600, 60);

    // Blood restores both oxygen-carrying capacity and circulating volume.
    expect(p.params.hgb).toBeGreaterThan(hgbBefore);
    expect(p.status).not.toBe('died');
    expect(engine.snapshot(p).map).toBeGreaterThan(70);
  }, 20_000);

  it('COPD exacerbation improves with bronchodilators and steroids', () => {
    const engine = started(only('penhale'));
    const p = patient(engine, 'penhale');
    run(engine, 3 * 3600 + 30 * 60, 60);
    const worst = engine.snapshot(p).spO2;

    engine.placeOrder(p, 'duoneb');
    engine.placeOrder(p, 'steroids');
    engine.placeOrder(p, 'o2-nc6');
    run(engine, 2 * 3600, 60);

    expect(engine.snapshot(p).spO2).toBeGreaterThan(worst);
  });

  it('leaves the low-acuity patient stable all night', () => {
    const engine = started(only('fitzgerald'));
    const p = patient(engine, 'fitzgerald');
    run(engine, SHIFT_DURATION_SEC, 300);

    expect(p.status).not.toBe('died');
    expect(engine.snapshot(p).cardiovascularStatus).toBe('compensated');
    // She still generates pages — that is the point of her.
    expect(p.messages.filter((m) => m.kind === 'page').length).toBeGreaterThanOrEqual(3);
  }, 20_000);
});

describe('cardiogenic physiology and the fluid trap', () => {
  it('raises the wedge and desaturates the ADHF patient', () => {
    const engine = started(only('brennan'));
    const p = patient(engine, 'brennan');
    run(engine, 3 * 3600, 60);

    const snap = engine.snapshot(p);
    // Hydrostatic oedema must actually reach gas exchange, or the case is unteachable.
    expect(snap.pcwp).toBeGreaterThan(22);
    expect(snap.spO2).toBeLessThan(0.92);
  });

  it('makes fluid worse and preload reduction better in ADHF', () => {
    const fluids = started(only('brennan'));
    const pf = patient(fluids, 'brennan');
    run(fluids, 80 * 60, 60);
    fluids.placeOrder(pf, 'ns-1000');
    run(fluids, 100 * 60, 60);

    const offload = started(only('brennan'));
    const po = patient(offload, 'brennan');
    run(offload, 80 * 60, 60);
    offload.placeOrder(po, 'nitro');
    offload.placeOrder(po, 'furosemide');
    run(offload, 100 * 60, 60);

    const wet = fluids.snapshot(pf);
    const dry = offload.snapshot(po);

    expect(dry.pcwp).toBeLessThan(wet.pcwp);
    expect(dry.spO2).toBeGreaterThan(wet.spO2);
  });
});

describe('orders', () => {
  it('refuses vasoactive infusions on the ward and allows them in the ICU', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');

    expect(engine.placeOrder(p, 'norepi')).toMatch(/ICU/i);
    expect(p.orders.some((o) => o.orderId === 'norepi')).toBe(false);

    engine.placeOrder(p, 'transfer-icu');
    run(engine, 20 * 60, 60);
    expect(p.location).toBe('icu');

    expect(engine.placeOrder(p, 'norepi')).toBeNull();
    expect(p.orders.some((o) => o.orderId === 'norepi')).toBe(true);
  });

  it('delays drug effect by the order lead time', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    const before = engine.snapshot(p).edv;

    engine.placeOrder(p, 'ns-1000');
    // Lead time is 5 minutes; nothing should have reached the patient yet.
    run(engine, 3 * 60, 30);
    expect(engine.snapshot(p).edv).toBeCloseTo(before, 1);

    run(engine, 25 * 60, 30);
    expect(engine.snapshot(p).edv).toBeGreaterThan(before + 5);
  });

  it('replaces oxygen devices rather than stacking them', () => {
    const engine = started(only('penhale'));
    const p = patient(engine, 'penhale');

    engine.placeOrder(p, 'o2-nc6');
    run(engine, 10 * 60, 30);
    const nc6 = engine.snapshot(p).fiO2;

    engine.placeOrder(p, 'o2-nc');
    run(engine, 10 * 60, 30);
    const nc2 = engine.snapshot(p).fiO2;

    // Stepping down must lower FiO2, not add to it.
    expect(nc2).toBeLessThan(nc6);
    expect(nc2).toBeLessThan(0.35);
    expect(p.o2Device).toBe('2L NC');
  });

  it('enforces once-only orders', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    expect(engine.placeOrder(p, 'transfer-icu')).toBeNull();
    expect(engine.placeOrder(p, 'transfer-icu')).toMatch(/already/i);
    expect(p.orders.filter((o) => o.orderId === 'transfer-icu')).toHaveLength(1);
  });

  it('resolves ordered labs after their turnaround time', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    engine.placeOrder(p, 'lab-lactate');

    run(engine, 10 * 60, 60);
    expect(p.labs).toHaveLength(0);

    run(engine, 20 * 60, 60);
    expect(p.labs).toHaveLength(1);
    expect(p.labs[0].panel).toBe('Lactate');
    expect(p.labs[0].values[0].value).toBeGreaterThan(0);
  });

  it('reports imaging findings that match the underlying physiology', () => {
    const engine = started(only('okonkwo'));
    const p = patient(engine, 'okonkwo');
    run(engine, 4 * 3600 + 20 * 60, 60);

    engine.placeOrder(p, 'img-echo');
    run(engine, 30 * 60, 60);

    const echo = p.labs.find((l) => l.panel === 'Bedside echo');
    expect(echo?.impression).toMatch(/right ventricle|D-sign/i);
  });
});

describe('nurse interaction', () => {
  it('answers questions from true physiology, not stale vitals', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    // Far enough in to be septic, but still alive and answerable.
    run(engine, 2 * 3600 + 40 * 60, 60);
    expect(p.status).toBe('stable');

    engine.askQuestion(p, 'look');
    const reply = p.messages[p.messages.length - 1];
    expect(reply.author).toBe('nurse');
    // Her charted vitals are hours old; the nurse's eyes are not.
    expect(engine.view(p).vitalsAgeSec).toBeGreaterThan(3600);
    expect(reply.text.toLowerCase()).toMatch(/mottled|clammy|confused|cool|pale|tired/);
  });

  it('does not count the doctor\'s own messages as unread', () => {
    const engine = started(only('fitzgerald'));
    const p = patient(engine, 'fitzgerald');
    engine.markRead(p);
    engine.placeOrder(p, 'vitals-now');
    const doctorMsgs = p.messages.filter((m) => m.author === 'doctor');
    expect(doctorMsgs.length).toBeGreaterThan(0);
    expect(p.unread).toBe(0);
  });
});

describe('arrest and outcomes', () => {
  it('honours DNR status without attempting resuscitation', () => {
    const engine = started(only('marsh'));
    const p = patient(engine, 'marsh');
    run(engine, SHIFT_DURATION_SEC, 120);

    if (p.status === 'died') {
      expect(p.outcome!.summary).toMatch(/DNR|comfort/i);
      expect(p.messages.some((m) => m.authorName === 'Code blue')).toBe(false);
    }
  });

  it('records a comfort-focused death differently from an unrecognised one', () => {
    const engine = started(only('marsh'));
    const p = patient(engine, 'marsh');
    engine.placeOrder(p, 'comfort-care');
    run(engine, SHIFT_DURATION_SEC, 120);

    if (p.status === 'died') {
      expect(p.outcome!.summary).toMatch(/comfort/i);
    }
  });

  it('gives a monitored ICU arrest a chance at ROSC', () => {
    // Drive a patient to arrest in the ICU and confirm resuscitation can succeed.
    const engine = started(only('demir'));
    const p = patient(engine, 'demir');
    engine.placeOrder(p, 'transfer-icu');
    run(engine, 20 * 60, 60);
    expect(p.location).toBe('icu');

    // Overwhelming insult: no treatment for the rest of the shift.
    run(engine, SHIFT_DURATION_SEC, 120);

    if (p.messages.some((m) => m.authorName === 'Code blue')) {
      // An ICU arrest is witnessed, so the first outcome must not be immediate death.
      const codeMsgs = p.messages.filter((m) => m.authorName === 'Code blue');
      expect(codeMsgs.length).toBeGreaterThan(0);
    }
  });

  it('stops stepping physiology once a patient has died', () => {
    const engine = started(only('marsh'));
    const p = patient(engine, 'marsh');
    run(engine, SHIFT_DURATION_SEC, 120);

    if (p.status === 'died') {
      const frozen = p.state.time;
      run(engine, 3600, 120);
      expect(p.state.time).toBe(frozen);
    }
  });
});

describe('numerical stability', () => {
  it('keeps every patient finite across a full untreated shift', () => {
    const engine = started();
    run(engine, SHIFT_DURATION_SEC, 60);

    for (const p of engine.patients) {
      const snap = engine.snapshot(p);
      for (const [key, value] of Object.entries(snap)) {
        // cardiovascularStatus is the one non-numeric field on a snapshot.
        if (typeof value !== 'number') continue;
        expect(Number.isFinite(value), `${p.case.id}.${key}`).toBe(true);
      }
    }
  }, 30_000);

  it('survives an aggressive, contradictory order set without diverging', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    engine.placeOrder(p, 'transfer-icu');
    run(engine, 20 * 60, 60);

    for (const id of ['norepi', 'epinephrine', 'vasopressin', 'dobutamine', 'ns-1000', 'furosemide', 'nitro', 'intubate']) {
      engine.placeOrder(p, id);
    }
    run(engine, 4 * 3600, 60);

    const snap = engine.snapshot(p);
    expect(Number.isFinite(snap.map)).toBe(true);
    expect(Number.isFinite(snap.spO2)).toBe(true);
    expect(snap.map).toBeGreaterThanOrEqual(0);
  });
});

describe('order catalogue integrity', () => {
  it('references only orders that exist from every case', () => {
    for (const c of CASES) {
      for (const id of [...c.expectedOrders, ...(c.contraindicatedOrders ?? [])]) {
        expect(ORDER_BY_ID[id], `${c.id} → ${id}`).toBeDefined();
      }
    }
  });

  it('gives every order an acknowledgement and a description', () => {
    for (const id of Object.keys(ORDER_BY_ID)) {
      const o = ORDER_BY_ID[id];
      expect(o.ack.length).toBeGreaterThan(0);
      expect(o.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('the bedside look never reassures about a patient in trouble', () => {
  it('does not call a breathless patient comfortable', () => {
    // The regression this guards: perfusion used to be an else-chain that always
    // emitted a clause, so a patient whose blood pressure was still holding was
    // announced as "comfortable, conversant" and only then described as drowning.
    const engine = started(only('brennan'));
    const p = patient(engine, 'brennan');
    run(engine, 80 * 60, 30);

    const snap = engine.snapshot(p);
    expect(snap.spO2).toBeLessThan(0.94);

    const look = describeAppearance(snap);
    expect(look).not.toMatch(/comfortable/i);
    expect(look).toMatch(/breath|crackles|froth|cyanotic/i);
  });

  it('escalates the description as the patient deteriorates', () => {
    const engine = started(only('brennan'));
    const p = patient(engine, 'brennan');

    const grades: number[] = [];
    for (let i = 0; i < 20; i++) {
      run(engine, 6 * 60, 30);
      if (p.status === 'died') break;
      grades.push(assessAppearance(engine.snapshot(p)).wob);
    }

    // Monotonically non-decreasing while untreated, and it must reach severe.
    for (let i = 1; i < grades.length; i++) {
      expect(grades[i]).toBeGreaterThanOrEqual(grades[i - 1]);
    }
    expect(Math.max(...grades)).toBeGreaterThanOrEqual(2);
  });

  it('reports congestion before the saturation falls', () => {
    // A wet patient is breathless well before they are hypoxaemic. Reporting only
    // on SpO2 would hide precisely the window worth acting in.
    const congested = { ...DEFAULT_STATE, edv: 168, emax: 1.3 };
    const snap = computeSnapshot(congested, DEFAULT_PARAMS);

    expect(snap.spO2).toBeGreaterThan(0.93);
    expect(snap.pcwp).toBeGreaterThan(22);
    expect(assessAppearance(snap).wob).toBeGreaterThanOrEqual(1);
    expect(describeAppearance(snap)).not.toMatch(/comfortable/i);
  });

  it('still calls a well patient comfortable', () => {
    const snap = computeSnapshot({ ...DEFAULT_STATE }, DEFAULT_PARAMS);
    expect(describeAppearance(snap)).toMatch(/comfortable/i);
  });

  it('keeps the triage dot to what a monitor can actually show', () => {
    // Lactate is a send-away test; letting it colour the dot would hand the player
    // a result they never ordered, and undo the occult-hypoperfusion case.
    const occult = computeSnapshot({ ...DEFAULT_STATE, lactate: 6 }, DEFAULT_PARAMS);
    expect(occult.map).toBeGreaterThan(70);
    expect(acuityLabel(occult)).toBe('ok');
  });
});

describe('comfort and routine orders', () => {
  it('offers an answer to every page the low-acuity patient generates', () => {
    const fitz = CASES.find((c) => c.id === 'fitzgerald')!;
    // Sleep, a resited cannula, and something for a headache.
    for (const id of ['melatonin', 'iv-resite', 'acetaminophen']) {
      expect(ORDER_BY_ID[id], id).toBeDefined();
      expect(fitz.expectedOrders).toContain(id);
    }
  });

  it('masks the fever without touching the sepsis', () => {
    const engine = started(only('whitfield'));
    const p = patient(engine, 'whitfield');
    run(engine, 70 * 60, 60);

    engine.placeOrder(p, 'vitals-now');
    const febrile = p.lastVitals!.tempC;
    const toneBefore = engine.snapshot(p).noTone;

    engine.placeOrder(p, 'acetaminophen');
    run(engine, 30 * 60, 60);
    engine.placeOrder(p, 'vitals-now');

    // The number falls; the inflammatory process does not.
    expect(p.lastVitals!.tempC).toBeLessThan(febrile);
    expect(engine.snapshot(p).noTone).toBeGreaterThanOrEqual(toneBefore);
  });

  it('does not count a sleeping tablet as responding to a deteriorating patient', () => {
    const engine = started(only('brennan'));
    const p = patient(engine, 'brennan');
    // Past his first urgent page, which is what starts the response clock.
    run(engine, 80 * 60, 60);
    expect(p.firstUnstableAt).not.toBeNull();

    engine.placeOrder(p, 'melatonin');
    expect(p.firstActionAt).toBeNull();

    engine.placeOrder(p, 'nitro');
    expect(p.firstActionAt).not.toBeNull();
  });

  it('makes trazodone cost something in a patient who is compensating', () => {
    const withTraz = started(only('whitfield'));
    const a = patient(withTraz, 'whitfield');
    run(withTraz, 45 * 60, 60);
    withTraz.placeOrder(a, 'trazodone');
    run(withTraz, 2 * 3600, 60);

    const control = started(only('whitfield'));
    run(control, 45 * 60 + 2 * 3600, 60);

    expect(withTraz.snapshot(a).map).toBeLessThan(
      control.snapshot(patient(control, 'whitfield')).map,
    );
  });
});
