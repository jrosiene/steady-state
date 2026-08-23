import { describe, it, expect } from 'vitest';
import { ShiftEngine, roscChance, causeIsBeingTreated } from '../shift';
import { ORDER_BY_ID } from '../orders';
import { assessAppearance, describeAppearance, acuityLabel } from '../clinical';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../../engine/constants';
import { snapshot as computeSnapshot } from '../../engine/hemodynamics';
import { buildReport } from '../scoring';
import { ARCHETYPES } from '../content/archetypes';
import { generateWard, WARD_SIZE } from '../content/generate';
import { makeRng } from '../content/rng';
import { makeVoice } from '../content/voice';
import { SEVERITY_BANDS, bandOf, insultScale, onsetScale } from '../content/severity';
import {
  TEST_SEED,
  advance as run,
  advanceToDeclaration,
  soloShift,
  makeCase,
  findByArchetype,
  type SoloShift,
} from '../testing';
import { SHIFT_DURATION_SEC } from '../types';

const MIN = 60;

/**
 * Tests address cases by archetype and express timing relative to when the case
 * declares. Both survive reseeding; a patient name and a wall-clock time do not.
 */
function shiftOf(id: string, severity: 'mild' | 'moderate' | 'severe' | number = 'moderate'): SoloShift {
  return soloShift(id, { severity });
}

function startedWard(seed = TEST_SEED): ShiftEngine {
  const e = new ShiftEngine(undefined, seed);
  e.start();
  return e;
}

/** Run a solo case to the end of the shift and report how it went. */
function outcomeOf(id: string, severity: 'mild' | 'moderate' | 'severe' | number, orders: { afterMin: number; ids: string[] }[] = []) {
  const s = shiftOf(id, severity);
  const plan = [...orders];
  while (s.engine.time < SHIFT_DURATION_SEC && s.engine.phase === 'running') {
    run(s.engine, 60, 60);
    while (plan.length && s.engine.time >= s.declaresAt + plan[0].afterMin * MIN) {
      for (const orderId of plan[0].ids) s.engine.placeOrder(s.patient, orderId);
      plan.shift();
    }
  }
  return { ...s, snap: s.engine.snapshot(s.patient), died: s.patient.status === 'died' };
}

// ─── Generation ─────────────────────────────────────────────────────────────

describe('seeded generation', () => {
  it('produces an identical ward from the same seed', () => {
    const a = generateWard({ seed: 'REPEAT1' });
    const b = generateWard({ seed: 'REPEAT1' });

    expect(a.cases.map((c) => c.name)).toEqual(b.cases.map((c) => c.name));
    expect(a.cases.map((c) => c.archetypeId)).toEqual(b.cases.map((c) => c.archetypeId));
    expect(a.cases.map((c) => c.severity)).toEqual(b.cases.map((c) => c.severity));
    expect(a.cases.map((c) => c.declaresAt)).toEqual(b.cases.map((c) => c.declaresAt));
  });

  it('produces different wards from different seeds', () => {
    const a = generateWard({ seed: 'ALPHA' });
    const b = generateWard({ seed: 'BRAVO' });
    expect(a.cases.map((c) => c.name)).not.toEqual(b.cases.map((c) => c.name));
  });

  it('decouples names from diagnoses across seeds', () => {
    // The core requirement: a name must carry no clinical information, or a
    // returning player stops reading the patient and starts recalling the answer.
    const pairs = new Map<string, Set<string>>();
    for (let i = 0; i < 40; i++) {
      for (const c of generateWard({ seed: `SEED${i}` }).cases) {
        if (!pairs.has(c.name)) pairs.set(c.name, new Set());
        pairs.get(c.name)!.add(c.archetypeId);
      }
    }
    const reused = [...pairs.values()].filter((s) => s.size > 1);
    expect(reused.length).toBeGreaterThan(0);
  });

  it('gives every ward a distinct cast and distinct rooms', () => {
    for (let i = 0; i < 25; i++) {
      const { cases } = generateWard({ seed: `CAST${i}` });
      expect(new Set(cases.map((c) => c.room)).size, `seed CAST${i}`).toBe(cases.length);
      expect(new Set(cases.map((c) => c.name)).size, `seed CAST${i}`).toBe(cases.length);
      expect(new Set(cases.map((c) => c.archetypeId)).size).toBe(cases.length);
    }
  });

  it('composes a ward with both quiet and critical patients', () => {
    for (let i = 0; i < 25; i++) {
      const { cases } = generateWard({ seed: `MIX${i}` });
      expect(cases).toHaveLength(WARD_SIZE);

      const tiers = cases.map((c) => ARCHETYPES.find((a) => a.id === c.archetypeId)!.tier);
      expect(tiers.filter((t) => t === 'critical').length).toBeGreaterThanOrEqual(2);
      expect(tiers.filter((t) => t === 'benign').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('staggers declarations so problems arrive in sequence', () => {
    const { cases } = generateWard({ seed: 'STAGGER' });
    const times = cases.map((c) => c.declaresAt).sort((a, b) => a - b);

    // Nothing declares before the player has read the board, and everything has
    // room to play out before 07:00.
    expect(times[0]).toBeGreaterThanOrEqual(10 * MIN);
    expect(times[times.length - 1]).toBeLessThan(SHIFT_DURATION_SEC - 45 * MIN);
    // They are genuinely spread, not clustered.
    expect(times[times.length - 1] - times[0]).toBeGreaterThan(3 * 3600);
  });

  it('varies severity continuously across the ward', () => {
    const values: number[] = [];
    const bands = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const c of generateWard({ seed: `SEV${i}` }).cases) {
        values.push(c.severity);
        bands.add(c.severityBand);
        expect(c.severity).toBeGreaterThanOrEqual(0);
        expect(c.severity).toBeLessThanOrEqual(1);
        expect(c.severityBand).toBe(bandOf(c.severity));
      }
    }
    // All three bands turn up...
    expect(bands).toEqual(new Set(SEVERITY_BANDS));
    // ...and severity is a genuine continuum, not three clustered values.
    expect(new Set(values.map((v) => v.toFixed(3))).size).toBeGreaterThan(values.length * 0.8);
  });

  it('varies handoff quality independently of how sick the patient is', () => {
    const byQuality = new Map<string, Set<string>>();
    for (let i = 0; i < 30; i++) {
      for (const c of generateWard({ seed: `HQ${i}` }).cases) {
        if (!byQuality.has(c.archetypeId)) byQuality.set(c.archetypeId, new Set());
        byQuality.get(c.archetypeId)!.add(c.handoff.quality);
      }
    }
    // The same clinical case must be capable of arriving well or badly handed over.
    const varied = [...byQuality.values()].filter((s) => s.size > 1);
    expect(varied.length).toBeGreaterThan(3);
  });
});

describe('the random number generator', () => {
  it('is deterministic and reproducible', () => {
    const a = makeRng('X');
    const b = makeRng('X');
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('respects bounds', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const n = rng.int(3, 9);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(9);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('samples without replacement', () => {
    const rng = makeRng('S');
    const items = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 50; i++) {
      const drawn = rng.sample(items, 3);
      expect(drawn).toHaveLength(3);
      expect(new Set(drawn).size).toBe(3);
    }
  });
});

describe('pronouns and verb agreement', () => {
  it('agrees for she, he and they', () => {
    expect(makeVoice('female').verb('look')).toBe('looks');
    expect(makeVoice('male').verb('look')).toBe('looks');
    expect(makeVoice('nonbinary').verb('look')).toBe('look');

    expect(makeVoice('nonbinary').is).toBe('are');
    expect(makeVoice('female').is).toBe('is');
    expect(makeVoice('nonbinary').has).toBe('have');
  });

  it('handles the sibilant and -y verbs the ward actually uses', () => {
    const v = makeVoice('male');
    expect(v.verb('watch')).toBe('watches');
    expect(v.verb('go')).toBe('goes');
    expect(v.verb('try')).toBe('tries');
    expect(v.verb('need')).toBe('needs');
  });

  it('never leaves an unresolved template in generated prose', () => {
    for (let i = 0; i < 15; i++) {
      for (const c of generateWard({ seed: `PROSE${i}` }).cases) {
        const prose = [
          c.handoff.summary,
          ...c.handoff.todo,
          ...c.handoff.contingencies,
          ...c.events.map((e) => e.page ?? ''),
        ].join(' ');
        expect(prose, c.archetypeId).not.toMatch(/\$\{|\bundefined\b|\[object/);
      }
    }
  });
});

describe('severity', () => {
  it('scales insult magnitude and onset in opposite directions', () => {
    expect(insultScale(0.1)).toBeLessThan(insultScale(0.5));
    expect(insultScale(0.5)).toBeLessThan(insultScale(0.9));
    // Severity raises the ceiling; it must not shorten the window to act, or the
    // case tests reaction time rather than reasoning.
    expect(onsetScale(0.9)).toBeLessThan(onsetScale(0.1));
    expect(onsetScale(0.9)).toBeGreaterThan(1.0);
  });

  it('interpolates smoothly rather than in steps', () => {
    const scales = [0, 0.25, 0.5, 0.75, 1].map(insultScale);
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThan(scales[i - 1]);
    }
    // Evenly spaced input gives evenly spaced output — no bucket boundaries.
    const steps = scales.slice(1).map((v, i) => v - scales[i]);
    for (const step of steps) expect(step).toBeCloseTo(steps[0], 6);
  });

  it('varies each insult independently within a case', () => {
    // Two patients at identical overall severity should not be the same patient:
    // the axes of the illness vary around it.
    const deltas = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const c = makeCase('urosepsis', { severity: 0.6, seed: `AXIS${i}` });
      deltas.add(c.events[0].interventions!.map((iv: { delta: number }) => iv.delta.toFixed(4)).join('|'));
    }
    expect(deltas.size).toBeGreaterThan(8);
  });

  it('makes a severe case worse than a mild one for every critical archetype', () => {
    const critical = ARCHETYPES.filter((a) => a.tier === 'critical');
    for (const archetype of critical) {
      const mild = outcomeOf(archetype.id, 0.12);
      const severe = outcomeOf(archetype.id, 0.92);
      // Untreated, more severity must mean a worse endpoint.
      const mildScore = mild.died ? 0 : mild.snap.map;
      const severeScore = severe.died ? 0 : severe.snap.map;
      expect(severeScore, `${archetype.id} severe vs mild`).toBeLessThanOrEqual(mildScore);
    }
  }, 60_000);
});

// ─── Lifecycle and observation ──────────────────────────────────────────────

describe('ShiftEngine lifecycle', () => {
  it('starts in briefing and does not advance until started', () => {
    const engine = new ShiftEngine(undefined, TEST_SEED);
    expect(engine.phase).toBe('briefing');
    run(engine, 3600);
    expect(engine.time).toBe(0);
  });

  it('ends after twelve hours with an outcome for everyone', () => {
    const engine = startedWard();
    run(engine, SHIFT_DURATION_SEC + 600, 300);
    expect(engine.phase).toBe('ended');
    expect(engine.patients.every((p) => p.outcome !== null)).toBe(true);
  }, 40_000);

  it('keeps every patient compensated at sign-out, on any seed', () => {
    for (const seed of ['BASE1', 'BASE2', 'BASE3', 'BASE4', 'BASE5', 'BASE6', 'BASE7', 'BASE8']) {
      const engine = startedWard(seed);
      run(engine, 8 * MIN, 30);
      for (const p of engine.patients) {
        const snap = engine.snapshot(p);
        expect(snap.cardiovascularStatus, `${seed}/${p.case.archetypeId}`).toBe('compensated');
        expect(snap.map).toBeGreaterThan(58);
      }
    }
  }, 30_000);

  it('gives every patient a signed-out set of vitals before the shift starts', () => {
    const engine = new ShiftEngine(undefined, TEST_SEED);
    for (const p of engine.patients) {
      expect(p.lastVitals).not.toBeNull();
      expect(p.lastVitals!.sbp).toBeGreaterThan(60);
    }
  });
});

describe('observation model', () => {
  it('does not refresh floor vitals between routine rounds', () => {
    const s = shiftOf('urosepsis');
    run(s.engine, 30 * MIN, 60);
    expect(s.patient.lastVitals!.time).toBe(0);
  });

  it('gives live vitals once the patient is monitored', () => {
    const s = shiftOf('urosepsis');
    s.engine.placeOrder(s.patient, 'telemetry');
    run(s.engine, 20 * MIN, 60);

    expect(s.patient.monitored).toBe(true);
    const view = s.engine.view(s.patient);
    expect(view.live).toBe(true);
    expect(view.vitalsAgeSec).toBeLessThan(60);
  });

  it('charts a fresh set on request', () => {
    const s = shiftOf('urosepsis');
    run(s.engine, 45 * MIN, 60);
    s.engine.placeOrder(s.patient, 'vitals-now');
    expect(s.patient.lastVitals!.time).toBeGreaterThan(40 * MIN);
  });

  it('pages the doctor when a nurse finds concerning vitals', () => {
    const s = shiftOf('urosepsis', 'severe');
    advanceToDeclaration(s, 150, 60);
    expect(s.patient.messages.filter((m) => m.kind === 'page').length).toBeGreaterThan(0);
    expect(s.patient.unread).toBeGreaterThan(0);
  });
});

// ─── Illness trajectories, by archetype ─────────────────────────────────────

describe('illness trajectories', () => {
  it('urosepsis progresses to shock when untreated', () => {
    const s = shiftOf('urosepsis', 'severe');
    advanceToDeclaration(s, 220, 60);
    const snap = s.engine.snapshot(s.patient);
    expect(snap.map).toBeLessThan(72);
    expect(snap.lactate).toBeGreaterThan(2.5);
  });

  it('urosepsis responds to timely fluids, antibiotics and escalation', () => {
    const treated = outcomeOf('urosepsis', 'moderate', [
      { afterMin: 6, ids: ['ns-1000', 'abx', 'telemetry', 'lab-lactate'] },
      { afterMin: 90, ids: ['transfer-icu'] },
      { afterMin: 130, ids: ['norepi'] },
    ]);
    const ignored = outcomeOf('urosepsis', 'moderate');

    expect(treated.died).toBe(false);
    expect(treated.snap.map).toBeGreaterThan(ignored.snap.map);
  }, 30_000);

  it('pulmonary embolism produces RV strain with a low wedge', () => {
    const s = shiftOf('pulmonary-embolism', 'moderate');
    advanceToDeclaration(s, 30, 60);

    const snap = s.engine.snapshot(s.patient);
    // The signature of obstructive shock: high pulmonary pressures, normal filling.
    expect(snap.mPAP).toBeGreaterThan(28);
    expect(snap.pcwp).toBeLessThan(18);
    expect(snap.rvedv).toBeGreaterThan(180);
    expect(snap.spO2).toBeLessThan(0.92);
  });

  it('pulmonary embolism is survivable with prompt anticoagulation and lysis', () => {
    const treated = outcomeOf('pulmonary-embolism', 'moderate', [
      { afterMin: 5, ids: ['o2-nrb', 'telemetry', 'img-echo', 'heparin', 'transfer-icu'] },
      { afterMin: 25, ids: ['thrombolysis'] },
    ]);
    expect(treated.died).toBe(false);
    expect(treated.snap.map).toBeGreaterThan(70);
  }, 30_000);

  it('GI bleed drops haemoglobin and preload; transfusion reverses both', () => {
    const s = shiftOf('gi-bleed', 'moderate');
    advanceToDeclaration(s, 180, 60);

    const bleeding = s.engine.snapshot(s.patient);
    const hgbBefore = s.patient.params.hgb;
    expect(bleeding.edv).toBeLessThan(112);

    s.engine.placeOrder(s.patient, 'prbc');
    s.engine.placeOrder(s.patient, 'ns-1000');
    run(s.engine, 3 * 3600, 60);

    expect(s.patient.params.hgb).toBeGreaterThan(hgbBefore);
    expect(s.patient.status).not.toBe('died');
  }, 30_000);

  it('COPD exacerbation improves with bronchodilators and steroids', () => {
    const s = shiftOf('copd-exacerbation', 'moderate');
    advanceToDeclaration(s, 25, 60);
    const worst = s.engine.snapshot(s.patient).spO2;

    s.engine.placeOrder(s.patient, 'duoneb');
    s.engine.placeOrder(s.patient, 'steroids');
    s.engine.placeOrder(s.patient, 'o2-nc6');
    run(s.engine, 2 * 3600, 60);

    expect(s.engine.snapshot(s.patient).spO2).toBeGreaterThan(worst);
  });

  it('hypovolaemia corrects with a modest fluid bolus', () => {
    const s = shiftOf('hypovolaemia', 'moderate');
    advanceToDeclaration(s, 45, 60);
    const dry = s.engine.snapshot(s.patient).map;

    s.engine.placeOrder(s.patient, 'ns-500');
    run(s.engine, 90 * MIN, 60);

    expect(s.engine.snapshot(s.patient).map).toBeGreaterThan(dry);
    expect(s.patient.status).not.toBe('died');
  });

  it('leaves benign patients stable all night while still paging', () => {
    for (const archetype of ARCHETYPES.filter((a) => a.tier === 'benign')) {
      const s = shiftOf(archetype.id, 'mild');
      run(s.engine, SHIFT_DURATION_SEC, 300);

      expect(s.patient.status, archetype.id).not.toBe('died');
      expect(s.engine.snapshot(s.patient).cardiovascularStatus).toBe('compensated');
      expect(s.patient.messages.filter((m) => m.kind === 'page').length).toBeGreaterThanOrEqual(3);
    }
  }, 40_000);

  it('makes every critical archetype lethal if wholly ignored', () => {
    for (const archetype of ARCHETYPES.filter((a) => a.tier === 'critical')) {
      const ignored = outcomeOf(archetype.id, 'severe');
      expect(ignored.died || ignored.snap.cardiovascularStatus !== 'compensated', archetype.id).toBe(true);
    }
  }, 60_000);
});

describe('cardiogenic physiology and the fluid trap', () => {
  it('raises the wedge and desaturates the mislabelled heart failure patient', () => {
    const s = shiftOf('adhf-mislabelled', 'moderate');
    advanceToDeclaration(s, 75, 60);

    const snap = s.engine.snapshot(s.patient);
    expect(snap.pcwp).toBeGreaterThan(22);
    expect(snap.spO2).toBeLessThan(0.92);
  });

  it('makes fluid worse and preload reduction better', () => {
    // Deliberately a milder case: at high severity both arms pin against the
    // wedge ceiling and the comparison stops measuring anything.
    const fluids = shiftOf('adhf-mislabelled', 0.3);
    advanceToDeclaration(fluids, 5, 60);
    fluids.engine.placeOrder(fluids.patient, 'ns-1000');
    run(fluids.engine, 100 * MIN, 60);

    const offload = shiftOf('adhf-mislabelled', 0.3);
    advanceToDeclaration(offload, 5, 60);
    offload.engine.placeOrder(offload.patient, 'nitro');
    offload.engine.placeOrder(offload.patient, 'furosemide');
    run(offload.engine, 100 * MIN, 60);

    const wet = fluids.engine.snapshot(fluids.patient);
    const dry = offload.engine.snapshot(offload.patient);
    expect(dry.pcwp).toBeLessThan(wet.pcwp);
    expect(dry.spO2).toBeGreaterThan(wet.spO2);
  }, 20_000);
});

// ─── Orders ─────────────────────────────────────────────────────────────────

describe('orders', () => {
  it('refuses vasoactive infusions on the ward and allows them in the ICU', () => {
    const s = shiftOf('urosepsis');
    expect(s.engine.placeOrder(s.patient, 'norepi')).toMatch(/ICU/i);
    expect(s.patient.orders.some((o) => o.orderId === 'norepi')).toBe(false);

    s.engine.placeOrder(s.patient, 'transfer-icu');
    run(s.engine, 20 * MIN, 60);
    expect(s.patient.location).toBe('icu');
    expect(s.engine.placeOrder(s.patient, 'norepi')).toBeNull();
  });

  it('delays drug effect by the order lead time', () => {
    const s = shiftOf('urosepsis');
    const before = s.engine.snapshot(s.patient).edv;

    s.engine.placeOrder(s.patient, 'ns-1000');
    run(s.engine, 3 * MIN, 30);
    expect(s.engine.snapshot(s.patient).edv).toBeCloseTo(before, 1);

    run(s.engine, 25 * MIN, 30);
    expect(s.engine.snapshot(s.patient).edv).toBeGreaterThan(before + 5);
  });

  it('replaces oxygen devices rather than stacking them', () => {
    const s = shiftOf('copd-exacerbation');
    s.engine.placeOrder(s.patient, 'o2-nc6');
    run(s.engine, 10 * MIN, 30);
    const nc6 = s.engine.snapshot(s.patient).fiO2;

    s.engine.placeOrder(s.patient, 'o2-nc');
    run(s.engine, 10 * MIN, 30);
    const nc2 = s.engine.snapshot(s.patient).fiO2;

    expect(nc2).toBeLessThan(nc6);
    expect(s.patient.o2Device).toBe('2L NC');
  });

  it('enforces once-only orders', () => {
    const s = shiftOf('urosepsis');
    expect(s.engine.placeOrder(s.patient, 'transfer-icu')).toBeNull();
    expect(s.engine.placeOrder(s.patient, 'transfer-icu')).toMatch(/already/i);
    expect(s.patient.orders.filter((o) => o.orderId === 'transfer-icu')).toHaveLength(1);
  });

  it('resolves ordered labs after their turnaround time', () => {
    const s = shiftOf('urosepsis');
    s.engine.placeOrder(s.patient, 'lab-lactate');
    run(s.engine, 10 * MIN, 60);
    expect(s.patient.labs).toHaveLength(0);

    run(s.engine, 20 * MIN, 60);
    expect(s.patient.labs).toHaveLength(1);
    expect(s.patient.labs[0].panel).toBe('Lactate');
  });

  it('reports imaging findings that match the underlying physiology', () => {
    const s = shiftOf('pulmonary-embolism', 'moderate');
    advanceToDeclaration(s, 20, 60);
    s.engine.placeOrder(s.patient, 'img-echo');
    run(s.engine, 30 * MIN, 60);

    const echo = s.patient.labs.find((l) => l.panel === 'Bedside echo');
    expect(echo?.impression).toMatch(/right ventricle|D-sign/i);
  });

  it('acknowledges every order in the patient\'s own voice', () => {
    for (const seed of ['ACK1', 'ACK2']) {
      const engine = startedWard(seed);
      for (const p of engine.patients) {
        for (const id of Object.keys(ORDER_BY_ID)) {
          const def = ORDER_BY_ID[id];
          const ack = typeof def.ack === 'function' ? def.ack(p.case.voice) : def.ack;
          expect(ack.length, id).toBeGreaterThan(0);
          expect(ack).not.toMatch(/\$\{|undefined/);
        }
      }
    }
  });
});

// ─── Nurse ──────────────────────────────────────────────────────────────────

describe('nurse interaction', () => {
  it('answers questions from true physiology, not stale vitals', () => {
    const s = shiftOf('urosepsis', 'severe');
    advanceToDeclaration(s, 130, 60);
    expect(s.patient.status).toBe('stable');

    s.engine.askQuestion(s.patient, 'look');
    const reply = s.patient.messages[s.patient.messages.length - 1];
    expect(reply.author).toBe('nurse');
    expect(s.engine.view(s.patient).vitalsAgeSec).toBeGreaterThan(3600);
  });

  it('answers every question without a broken template, for any voice', () => {
    const engine = startedWard('VOICES');
    run(engine, 5 * MIN, 60);
    for (const p of engine.patients) {
      for (const q of ['look', 'mental', 'breathing', 'urine', 'access', 'meds', 'callback']) {
        engine.askQuestion(p, q);
        const reply = p.messages[p.messages.length - 1];
        expect(reply.text, `${p.case.archetypeId}/${q}`).not.toMatch(/\$\{|undefined|\[object/);
        expect(reply.text.length).toBeGreaterThan(4);
      }
    }
  });

  it('does not count the doctor\'s own messages as unread', () => {
    const s = shiftOf('benign-cellulitis');
    s.engine.markRead(s.patient);
    s.engine.placeOrder(s.patient, 'vitals-now');
    expect(s.patient.messages.some((m) => m.author === 'doctor')).toBe(true);
    expect(s.patient.unread).toBe(0);
  });
});

describe('the bedside look never reassures about a patient in trouble', () => {
  it('does not call a breathless patient comfortable', () => {
    // Far enough in to be breathless, well short of the arrest.
    const s = shiftOf('adhf-mislabelled', 0.3);
    advanceToDeclaration(s, 50, 30);

    const snap = s.engine.snapshot(s.patient);
    expect(s.patient.status).toBe('stable');
    expect(snap.spO2).toBeLessThan(0.94);

    const look = describeAppearance(snap);
    expect(look).not.toMatch(/comfortable/i);
    expect(look).toMatch(/breath|crackles|froth|cyanotic/i);
  });

  it('reports congestion before the saturation falls', () => {
    const congested = { ...DEFAULT_STATE, edv: 168, emax: 1.3 };
    const snap = computeSnapshot(congested, DEFAULT_PARAMS);

    expect(snap.spO2).toBeGreaterThan(0.93);
    expect(snap.pcwp).toBeGreaterThan(22);
    expect(assessAppearance(snap).wob).toBeGreaterThanOrEqual(1);
    expect(describeAppearance(snap)).not.toMatch(/comfortable/i);
  });

  it('still calls a well patient comfortable', () => {
    expect(describeAppearance(computeSnapshot({ ...DEFAULT_STATE }, DEFAULT_PARAMS))).toMatch(/comfortable/i);
  });

  it('keeps the triage dot to what a monitor can actually show', () => {
    const occult = computeSnapshot({ ...DEFAULT_STATE, lactate: 6 }, DEFAULT_PARAMS);
    expect(occult.map).toBeGreaterThan(70);
    expect(acuityLabel(occult)).toBe('ok');
  });
});

// ─── Comfort orders and handoffs ────────────────────────────────────────────

describe('comfort and routine orders', () => {
  it('offers an answer to every page a benign patient generates', () => {
    for (const archetype of ARCHETYPES.filter((a) => a.tier === 'benign')) {
      expect(archetype.expectedOrders.length, archetype.id).toBeGreaterThanOrEqual(2);
      for (const id of archetype.expectedOrders) {
        const order = ORDER_BY_ID[id];
        expect(order, `${archetype.id} → ${id}`).toBeDefined();
        // Answering a benign page must never require escalating the patient.
        // It may reasonably involve a quick set of observations or a single
        // reassuring test — excluding the dangerous thing is part of the answer.
        expect(order.requiresIcu ?? false, `${archetype.id} → ${id}`).toBe(false);
        expect(['comfort', 'nursing', 'labs', 'imaging']).toContain(order.category);
      }
    }
  });

  it('masks the fever without touching the sepsis', () => {
    const s = shiftOf('urosepsis', 'severe');
    advanceToDeclaration(s, 40, 60);

    s.engine.placeOrder(s.patient, 'vitals-now');
    const febrile = s.patient.lastVitals!.tempC;
    const toneBefore = s.engine.snapshot(s.patient).noTone;

    s.engine.placeOrder(s.patient, 'acetaminophen');
    run(s.engine, 30 * MIN, 60);
    s.engine.placeOrder(s.patient, 'vitals-now');

    expect(s.patient.lastVitals!.tempC).toBeLessThan(febrile);
    expect(s.engine.snapshot(s.patient).noTone).toBeGreaterThanOrEqual(toneBefore);
  });

  it('does not count a sleeping tablet as responding to a deteriorating patient', () => {
    const s = shiftOf('adhf-mislabelled', 'moderate');
    advanceToDeclaration(s, 10, 60);
    expect(s.patient.firstUnstableAt).not.toBeNull();

    s.engine.placeOrder(s.patient, 'melatonin');
    expect(s.patient.firstActionAt).toBeNull();

    s.engine.placeOrder(s.patient, 'nitro');
    expect(s.patient.firstActionAt).not.toBeNull();
  });
});

describe('day team handoffs', () => {
  it('gives every generated patient a usable handoff', () => {
    for (let i = 0; i < 15; i++) {
      for (const c of generateWard({ seed: `HO${i}` }).cases) {
        expect(c.handoff.summary.length, c.archetypeId).toBeGreaterThan(40);
        expect(c.handoff.author).toMatch(/,/);
        expect(['thorough', 'adequate', 'thin']).toContain(c.handoff.quality);
        if (c.handoff.quality === 'thin') expect(c.handoff.contingencies).toHaveLength(0);
      }
    }
  });

  it('produces handoffs across the whole range of completeness', () => {
    const qualities = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const c of generateWard({ seed: `HQ2-${i}` }).cases) qualities.add(c.handoff.quality);
    }
    expect(qualities.size).toBe(3);
  });

  it('names what the player was working from in the debrief', () => {
    const engine = startedWard('DEBRIEF');
    run(engine, SHIFT_DURATION_SEC, 300);
    for (const d of buildReport(engine.patients).debriefs) {
      expect(d.handoffNote.length).toBeGreaterThan(20);
    }
  }, 40_000);
});

// ─── Robustness ─────────────────────────────────────────────────────────────

describe('numerical stability', () => {
  it('keeps every patient finite across full untreated shifts on many seeds', () => {
    for (const seed of ['ST1', 'ST2', 'ST3']) {
      const engine = startedWard(seed);
      run(engine, SHIFT_DURATION_SEC, 120);

      for (const p of engine.patients) {
        for (const [key, value] of Object.entries(engine.snapshot(p))) {
          if (typeof value !== 'number') continue;
          expect(Number.isFinite(value), `${seed}/${p.case.archetypeId}.${key}`).toBe(true);
        }
      }
    }
  }, 120_000);

  it('survives an aggressive, contradictory order set', () => {
    const s = shiftOf('urosepsis', 'severe');
    s.engine.placeOrder(s.patient, 'transfer-icu');
    run(s.engine, 20 * MIN, 60);

    for (const id of ['norepi', 'epinephrine', 'vasopressin', 'dobutamine', 'ns-1000', 'furosemide', 'nitro', 'intubate', 'trazodone', 'morphine-comfort']) {
      s.engine.placeOrder(s.patient, id);
    }
    run(s.engine, 4 * 3600, 60);

    const snap = s.engine.snapshot(s.patient);
    expect(Number.isFinite(snap.map)).toBe(true);
    expect(snap.map).toBeGreaterThanOrEqual(0);
  }, 20_000);
});

describe('content integrity', () => {
  it('references only orders that exist from every archetype', () => {
    for (const a of ARCHETYPES) {
      for (const id of [...a.expectedOrders, ...(a.contraindicatedOrders ?? [])]) {
        expect(ORDER_BY_ID[id], `${a.id} → ${id}`).toBeDefined();
      }
    }
  });

  it('gives every archetype a teaching point and a hidden diagnosis', () => {
    for (const a of ARCHETYPES) {
      expect(a.teachingPoint.length, a.id).toBeGreaterThan(80);
      expect(a.hiddenDx.length, a.id).toBeGreaterThan(10);
      expect(a.span).toBeGreaterThan(0);
    }
  });

  it('gives every order an acknowledgement and a description', () => {
    for (const id of Object.keys(ORDER_BY_ID)) {
      expect(ORDER_BY_ID[id].detail.length, id).toBeGreaterThan(0);
    }
  });

  it('can find any archetype on a ward that contains it', () => {
    const engine = startedWard('FIND');
    const first = engine.patients[0];
    expect(findByArchetype(engine, first.case.archetypeId)).toBe(first);
    expect(() => findByArchetype(engine, 'not-a-real-archetype')).toThrow();
  });
});

// ─── Resuscitation ──────────────────────────────────────────────────────────

/**
 * Drive a case to arrest and report what the code did.
 * Preparation is varied, not the physiology, so the arms differ only in the
 * decisions the player made before the pulse was lost.
 */
function codeTrial(
  archetypeId: string,
  seed: number,
  opts: { monitor?: boolean; treat?: string[] } = {},
) {
  const s = soloShift(archetypeId, { severity: 'severe', seed: `CODE${seed}` });
  let setup = false;
  while (s.engine.time < SHIFT_DURATION_SEC && s.engine.phase === 'running') {
    run(s.engine, 60, 60);
    if (!setup && s.engine.time >= s.declaresAt) {
      if (opts.monitor) s.engine.placeOrder(s.patient, 'telemetry');
      for (const o of opts.treat ?? []) s.engine.placeOrder(s.patient, o);
      setup = true;
    }
  }
  return {
    coded: s.patient.messages.some((m) => m.text.startsWith('Code blue,')),
    roscCount: s.patient.roscCount,
    died: s.patient.status === 'died',
    patient: s.patient,
  };
}

describe('code blue', () => {
  it('runs ACLS in cycles with a rhythm, an airway and adrenaline', () => {
    const t = codeTrial('acs-cardiogenic', 1, { monitor: true });
    expect(t.coded).toBe(true);

    const codeMsgs = t.patient.messages.filter((m) => m.authorName === 'Code blue');
    const all = codeMsgs.map((m) => m.text).join(' ');
    expect(all).toMatch(/rhythm is (VF|pulseless VT|PEA|asystole)/);
    expect(all).toMatch(/airway secured/);
    expect(all).toMatch(/adrenaline given/);
  }, 30_000);

  it('never resuscitates a patient who is DNR/DNI', () => {
    const s = soloShift('end-of-life-pneumonia', { severity: 'severe' });
    run(s.engine, SHIFT_DURATION_SEC, 120);

    expect(s.patient.case.codeStatus).toBe('DNR/DNI');
    expect(s.patient.messages.some((m) => m.text.startsWith('Code blue,'))).toBe(false);
    if (s.patient.status === 'died') {
      expect(s.patient.outcome!.summary).toMatch(/DNR|comfort/i);
    }
  }, 30_000);

  it('gives a witnessed arrest a far better chance than an unwitnessed one', () => {
    // The single largest determinant of surviving an in-hospital arrest, and one
    // the player decides hours earlier by ordering monitoring.
    let unwitnessed = 0;
    let witnessed = 0;
    for (let i = 0; i < 14; i++) {
      if (codeTrial('acs-cardiogenic', i).roscCount > 0) unwitnessed++;
      if (codeTrial('acs-cardiogenic', i, { monitor: true }).roscCount > 0) witnessed++;
    }
    expect(witnessed).toBeGreaterThan(unwitnessed);
  }, 120_000);

  it('improves the odds when the reversible cause is being treated', () => {
    let untreated = 0;
    let treated = 0;
    for (let i = 0; i < 14; i++) {
      if (codeTrial('acs-cardiogenic', i, { monitor: true }).roscCount > 0) untreated++;
      const t = codeTrial('acs-cardiogenic', i, { monitor: true, treat: ['aspirin', 'transfer-icu'] });
      if (t.roscCount > 0) treated++;
    }
    expect(treated).toBeGreaterThanOrEqual(untreated);
  }, 120_000);

  it('puts a resuscitated patient in the ICU, intubated and supported', () => {
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      const t = codeTrial('acs-cardiogenic', i, { monitor: true, treat: ['aspirin', 'transfer-icu'] });
      if (t.roscCount > 0) {
        found = true;
        expect(t.patient.location).toBe('icu');
        expect(t.patient.monitored).toBe(true);
        const rosc = t.patient.messages.find((m) => m.text.startsWith('ROSC'));
        expect(rosc?.text).toMatch(/intubated/);
        expect(rosc?.text).toMatch(/noradrenaline/);
      }
    }
    expect(found).toBe(true);
  }, 120_000);

  it('stops after repeated ROSC is lost again within minutes', () => {
    // A team who have restarted the heart twice and watched it stop again are not
    // going to restart it a third time; the problem is the physiology.
    for (let i = 0; i < 12; i++) {
      const t = codeTrial('acs-cardiogenic', i, { monitor: true });
      expect(t.patient.roscCount).toBeLessThanOrEqual(2);
    }
  }, 120_000);

  it('is reproducible from the seed', () => {
    const a = codeTrial('acs-cardiogenic', 99, { monitor: true });
    const b = codeTrial('acs-cardiogenic', 99, { monitor: true });
    expect(a.roscCount).toBe(b.roscCount);
    expect(a.died).toBe(b.died);
  }, 40_000);

  it('bounds and decays the per-cycle chance of ROSC', () => {
    const snap = computeSnapshot({ ...DEFAULT_STATE }, DEFAULT_PARAMS);
    const base = {
      startedAt: 0, nextCycleAt: 0, rhythm: 'VF' as const, shocks: 0,
      epiDoses: 0, intubated: true, witnessed: true, causeAddressed: true,
    };
    const first = roscChance({ ...base, cycle: 1 }, snap);
    const later = roscChance({ ...base, cycle: 5 }, snap);

    expect(first).toBeGreaterThan(later);
    expect(first).toBeLessThanOrEqual(0.6);
    expect(later).toBeGreaterThanOrEqual(0.01);

    // Unwitnessed asystole is the worst case and must stay the worst case.
    const worst = roscChance({ ...base, cycle: 1, rhythm: 'asystole', witnessed: false, causeAddressed: false }, snap);
    expect(worst).toBeLessThan(first);
  });

  it('counts diagnostics as knowing the cause, not treating it', () => {
    const s = soloShift('urosepsis', { severity: 'severe' });
    s.engine.placeOrder(s.patient, 'lab-lactate');
    s.engine.placeOrder(s.patient, 'lab-cultures');
    expect(causeIsBeingTreated(s.patient)).toBe(false);

    s.engine.placeOrder(s.patient, 'ns-1000');
    s.engine.placeOrder(s.patient, 'abx');
    expect(causeIsBeingTreated(s.patient)).toBe(true);
  });
});

describe('ward patients look ward-appropriate at sign-out', () => {
  it('hands over observations a day team would have left on the floor', () => {
    // These patients were triaged to a general ward. Severity must express itself
    // in how they evolve, not in a patient who is already visibly peri-arrest.
    for (let i = 0; i < 12; i++) {
      const engine = new ShiftEngine(undefined, `TRIAGE${i}`);
      for (const p of engine.patients) {
        const v = p.lastVitals!;
        const where = `${p.case.archetypeId}/${p.case.severityBand}`;

        // A patient on comfort measures is exempt: a low blood pressure at the end
        // of life is not a triage failure, it is where that patient belongs.
        const comfortFocused = p.case.codeStatus === 'DNR/DNI';
        if (!comfortFocused) expect(v.map, where).toBeGreaterThanOrEqual(62);

        expect(v.spo2, where).toBeGreaterThanOrEqual(88);
        expect(v.hr, where).toBeLessThanOrEqual(115);
        expect(v.rr, where).toBeLessThanOrEqual(26);
      }
    }
  });
});

// ─── Depth of the generated space ───────────────────────────────────────────

describe('severity is a continuum, not three buckets', () => {
  it('degrades outcomes monotonically as severity rises', () => {
    // With the seed fixed, only severity varies — so the trend has to be clean.
    // (Across seeds the per-axis draws legitimately swamp it, which is the point
    // of the per-axis variation and not a defect in the scale.)
    const results = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0].map((sev) => {
      const s = soloShift('urosepsis', { severity: sev, seed: 'MONO' });
      run(s.engine, SHIFT_DURATION_SEC, 120);
      const snap = s.engine.snapshot(s.patient);
      // Dead scores zero; otherwise score by remaining perfusion.
      return s.patient.status === 'died' ? 0 : snap.map;
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i], `severity step ${i}`).toBeLessThanOrEqual(results[i - 1] + 0.5);
    }
    // The ends must genuinely differ: mild survives, severe does not.
    expect(results[0]).toBeGreaterThan(70);
    expect(results[results.length - 1]).toBe(0);
  }, 90_000);

  it('lets a mild case survive being ignored', () => {
    // Without this the bottom of the range is just "lethal but slower", and every
    // page on the ward is an emergency.
    const s = soloShift('urosepsis', { severity: 0.05, seed: 'MILD' });
    run(s.engine, SHIFT_DURATION_SEC, 120);
    expect(s.patient.status).not.toBe('died');
  }, 40_000);

  it('produces different presentations at identical overall severity', () => {
    const shapes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const c = makeCase('pneumonia-sepsis', { severity: 0.55, seed: `SHAPE${i}` });
      const first = c.events[0].interventions!;
      // The ratio between the two axes of the illness, not just its overall size.
      shapes.add((first[0].delta / first[1].delta).toFixed(3));
    }
    expect(shapes.size).toBeGreaterThan(10);
  });
});

describe('comorbidities', () => {
  it('records them in the history so a careful reader can find them', () => {
    let withComorbidity = 0;
    for (let i = 0; i < 10; i++) {
      for (const c of generateWard({ seed: `CM${i}` }).cases) {
        if (c.comorbidities.length > 0) {
          withComorbidity++;
          for (const label of c.comorbidities) expect(c.history).toContain(label);
        }
      }
    }
    expect(withComorbidity).toBeGreaterThan(30);
  });

  it('blunts the tachycardic response when the patient is beta-blocked', () => {
    // The clinical trap worth having: a bleeding patient who never mounts a
    // tachycardia looks reassuring right up until the pressure goes.
    const findWith = (want: boolean) => {
      for (let i = 0; i < 200; i++) {
        const c = makeCase('gi-bleed', { severity: 0.7, seed: `BB${i}` });
        const blocked = c.comorbidities.includes('On a beta-blocker');
        if (blocked === want) return c;
      }
      throw new Error(`no gi-bleed ${want ? 'with' : 'without'} beta-blockade`);
    };

    const measure = (c: ReturnType<typeof findWith>) => {
      const engine = new ShiftEngine([c], 'BB');
      engine.start();
      run(engine, c.declaresAt + 100 * MIN, 60);
      return engine.snapshot(engine.patients[0]).hr;
    };

    const blockedHr = measure(findWith(true));
    const normalHr = measure(findWith(false));
    expect(blockedHr).toBeLessThan(normalHr);
  }, 40_000);

  it('keeps every comorbidity combination physiologically valid', () => {
    for (let i = 0; i < 20; i++) {
      const engine = new ShiftEngine(undefined, `CMV${i}`);
      for (const p of engine.patients) {
        const snap = engine.snapshot(p);
        const where = `${p.case.archetypeId}: ${p.case.comorbidities.join('+')}`;
        expect(Number.isFinite(snap.map), where).toBe(true);
        expect(p.params.hgb, where).toBeGreaterThan(5);
        expect(snap.cardiovascularStatus, where).toBe('compensated');
      }
    }
  });
});

describe('library depth', () => {
  it('offers enough of each tier that a ward is not a fixed set', () => {
    const byTier = (tier: string) => ARCHETYPES.filter((a) => a.tier === tier).length;
    // Composition draws 3 critical, 3 ward, 2 benign. Each pool must exceed its
    // draw, or that slice of the ward is identical every single night.
    expect(byTier('critical')).toBeGreaterThan(3);
    expect(byTier('ward')).toBeGreaterThan(3);
    expect(byTier('benign')).toBeGreaterThan(2);
  });

  it('generates many distinct wards', () => {
    const combos = new Set<string>();
    for (let i = 0; i < 120; i++) {
      combos.add(generateWard({ seed: `DEPTH${i}` }).cases.map((c) => c.archetypeId).sort().join(','));
    }
    expect(combos.size).toBeGreaterThan(80);
  });
});
