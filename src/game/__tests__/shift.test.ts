import { describe, it, expect } from 'vitest';
import { ShiftEngine, roscChance, causeIsBeingTreated } from '../shift';
import { ORDER_BY_ID, ORDERS } from '../orders';
import { assessAppearance, describeAppearance, acuityLabel, resolveLabPanel, type Gestalt } from '../clinical';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../../engine/constants';
import { snapshot as computeSnapshot } from '../../engine/hemodynamics';
import { buildReport, ordersSatisfiedBy } from '../scoring';
import { ARCHETYPES, ARCHETYPE_BY_ID } from '../content/archetypes';
import { generateWard, composition, WARD_SIZE } from '../content/generate';
import { makeRng } from '../content/rng';
import { makeVoice } from '../content/voice';
import { NURSE_QUESTIONS } from '../nurse';
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
    // Pages are written against the bedside grade they are delivered at, so every
    // branch has to be rendered — a broken template hiding in the tier that only
    // fires on a mild case is exactly the one that would reach a player.
    const grades: Gestalt[] = [0, 1, 2, 3].flatMap((n) => [
      { wob: n as 0 | 1 | 2 | 3, perf: 0 as const, text: '' },
      { wob: 0 as const, perf: n as 0 | 1 | 2 | 3, text: '' },
      { wob: n as 0 | 1 | 2 | 3, perf: n as 0 | 1 | 2 | 3, text: '' },
    ]);

    for (let i = 0; i < 15; i++) {
      for (const c of generateWard({ seed: `PROSE${i}` }).cases) {
        const pages = c.events.flatMap((e) =>
          typeof e.page === 'function' ? grades.map(e.page) : [e.page ?? ''],
        );
        const prose = [
          c.handoff.summary,
          ...c.handoff.todo,
          ...c.handoff.contingencies,
          ...pages,
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
    run(s.engine, 5 * MIN, 30);   // someone has to go and take them
    expect(s.patient.lastVitals!.time).toBeGreaterThan(45 * MIN);
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

  it('GI bleed drops hemoglobin and preload; transfusion reverses both', () => {
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

  it('hypovolemia corrects with a modest fluid bolus', () => {
    const s = shiftOf('hypovolemia', 'moderate');
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
  it('raises the wedge and desaturates the mislabeled heart failure patient', () => {
    const s = shiftOf('adhf-mislabeled', 'moderate');
    advanceToDeclaration(s, 75, 60);

    const snap = s.engine.snapshot(s.patient);
    expect(snap.pcwp).toBeGreaterThan(22);
    expect(snap.spO2).toBeLessThan(0.92);
  });

  it('makes fluid worse and preload reduction better', () => {
    // Deliberately a mild case: once either arm pins against the wedge ceiling
    // the comparison stops measuring anything, and per-insult jitter means the
    // margin has to be generous rather than just below the worst severity.
    const fluids = shiftOf('adhf-mislabeled', 0.15);
    advanceToDeclaration(fluids, 5, 60);
    fluids.engine.placeOrder(fluids.patient, 'ns-1000');
    run(fluids.engine, 100 * MIN, 60);

    const offload = shiftOf('adhf-mislabeled', 0.15);
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
    // A patient nobody has called about is on four-hourly observations, so the
    // chart is hours old while the bedside is current — which is the whole
    // reason asking is worth doing.
    const s = soloShift('benign-cellulitis', { severity: 0.5, declareAt: 20 * 60 });
    run(s.engine, 3 * 3600, 60);
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
    // Far enough in to be breathless, well short of the arrest. Kept early
    // because per-insult jitter means how fast a given case runs is not a
    // function of severity alone.
    const s = shiftOf('adhf-mislabeled', 0.3);
    advanceToDeclaration(s, 30, 30);

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
        // It may reasonably involve a quick set of vitals or a single
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
    run(s.engine, 5 * MIN, 30);
    const febrile = s.patient.lastVitals!.tempC;
    const toneBefore = s.engine.snapshot(s.patient).noTone;

    s.engine.placeOrder(s.patient, 'acetaminophen');
    run(s.engine, 30 * MIN, 60);
    s.engine.placeOrder(s.patient, 'vitals-now');
    run(s.engine, 5 * MIN, 30);

    expect(s.patient.lastVitals!.tempC).toBeLessThan(febrile);
    expect(s.engine.snapshot(s.patient).noTone).toBeGreaterThanOrEqual(toneBefore);
  });

  it('does not count a sleeping tablet as responding to a deteriorating patient', () => {
    const s = shiftOf('adhf-mislabeled', 'moderate');
    advanceToDeclaration(s, 40, 60);
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
  it('runs ACLS in cycles with a rhythm, an airway and epinephrine', () => {
    const t = codeTrial('acs-cardiogenic', 1, { monitor: true });
    expect(t.coded).toBe(true);

    const codeMsgs = t.patient.messages.filter((m) => m.authorName === 'Code blue');
    const all = codeMsgs.map((m) => m.text).join(' ');
    expect(all).toMatch(/rhythm is (VF|pulseless VT|PEA|asystole)/);
    expect(all).toMatch(/airway secured/);
    expect(all).toMatch(/epinephrine given/);
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
        expect(rosc?.text).toMatch(/norepinephrine/);
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
        expect(v.rr, where).toBeLessThanOrEqual(28);
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

// ─── What the nurse says matches what the nurse can see ─────────────────────

/**
 * Language that asserts a patient is visibly sick.
 *
 * A page containing any of this is making a claim about the bedside, and the
 * bedside has to support it. The original failure was a nurse announcing a
 * patient "using accessory muscles, only a few words at a time" at the same
 * moment the appearance query returned "comfortable and conversant" and the
 * charted observations were unremarkable — three channels describing three
 * different patients, because the page was authored prose fired on a timer while
 * the insult it described was still ramping in.
 */
const DISTRESS_LANGUAGE = [
  /accessory muscle/i,
  /few words at a time/i,
  /can'?t finish a sentence/i,
  /short phrases/i,
  /barely (rousable|get a pressure)/i,
  /mottled/i,
  /really struggling/i,
  /pink froth/i,
  /bolt upright/i,
  /exhausted/i,
  /working (much )?harder/i,
  /gray\b/i,
  /diaphoretic/i,
  /cool all the way up to the elbows/i,
];

function claimsDistress(text: string): boolean {
  return DISTRESS_LANGUAGE.some((re) => re.test(text));
}

describe('a page never describes a patient the player cannot find', () => {
  it('claims distress only when the bedside actually shows it', () => {
    const offenders: string[] = [];

    for (const archetype of ARCHETYPES) {
      for (const severity of [0, 0.25, 0.5, 0.75, 1]) {
        const s = soloShift(archetype.id, { severity, declareAt: 20 * 60 });
        const seen = new Set<string>();

        for (let minute = 0; minute < 11 * 60; minute++) {
          run(s.engine, 60, 30);
          const gestalt = assessAppearance(
            s.engine.snapshot(s.patient),
            s.patient.case.baselineDrive,
          );

          for (const message of s.patient.messages) {
            if (message.author !== 'nurse' || seen.has(message.id)) continue;
            seen.add(message.id);
            if (!claimsDistress(message.text)) continue;
            if (Math.max(gestalt.wob, gestalt.perf) >= 1) continue;
            offenders.push(
              `${archetype.id}@${severity}: "${message.text.slice(0, 90)}" ` +
              `(wob ${gestalt.wob}, perf ${gestalt.perf})`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('escalates urgency from the patient rather than from the script', () => {
    // The same line of script, played mild and played severe. A mild
    // exacerbation is a routine call; a severe one is a rapid response.
    const urgentPages = (severity: number) => {
      const s = soloShift('copd-exacerbation', { severity, declareAt: 20 * 60 });
      run(s.engine, 5 * 3600, 30);
      return s.patient.messages.filter((m) => m.author === 'nurse' && m.urgent).length;
    };

    expect(urgentPages(0)).toBe(0);
    expect(urgentPages(1)).toBeGreaterThan(0);
  });
});

describe('the nurse keeps watching after they have called', () => {
  it('calls back when the patient is worse than the last report', () => {
    const s = soloShift('adhf-mislabeled', { severity: 0.7, declareAt: 20 * 60 });
    run(s.engine, 2 * 3600, 30);

    const callbacks = s.patient.messages.filter((m) => /Calling you back|since I last looked/.test(m.text));
    expect(callbacks.length).toBeGreaterThan(0);

    // And the escalation is monotone: each callback describes a worse patient
    // than the one before, because the trigger is a rise against what has
    // already been said.
    const grades = callbacks.map((m) => (/worse than when I called/.test(m.text) ? 2 : 1));
    expect(Math.max(...grades)).toBe(2);
  });

  it('says nothing about a patient who was handed over sick and stays that way', () => {
    // A chronic-lung patient sits above the population's normal respiratory rate
    // all night. Grading work of breathing against their own baseline is what
    // stops that being reported as a deterioration.
    const s = soloShift('benign-cellulitis', { severity: 0.5, declareAt: 20 * 60 });
    run(s.engine, 6 * 3600, 30);
    const callbacks = s.patient.messages.filter((m) => /Calling you back|since I last looked/.test(m.text));
    expect(callbacks).toEqual([]);
  });
});

describe('respiratory rate moves before the saturation does', () => {
  it('shows the work a bronchospastic patient is doing', () => {
    const s = soloShift('copd-exacerbation', { severity: 0.6, declareAt: 20 * 60 });
    advanceToDeclaration(s, 25, 30);

    const snap = s.engine.snapshot(s.patient);
    const vitals = s.patient.lastVitals!;

    // The saturation is defended by the effort; the effort is what shows.
    expect(snap.spO2).toBeGreaterThan(0.88);
    expect(vitals.rr).toBeGreaterThan(24);
    expect(assessAppearance(snap, s.patient.case.baselineDrive).wob).toBeGreaterThanOrEqual(1);
  });

  it('does not answer "how is their breathing" with a saturation alone', () => {
    const s = soloShift('copd-exacerbation', { severity: 0.6, declareAt: 20 * 60 });
    advanceToDeclaration(s, 25, 30);

    s.engine.askQuestion(s.patient, 'breathing');
    const answer = s.patient.messages[s.patient.messages.length - 1].text;
    expect(answer).not.toMatch(/^Easy/);
    expect(answer).toMatch(/\d\d/);
  });
});

// ─── Lists longer than one ward ─────────────────────────────────────────────

describe('covering more than one ward', () => {
  it('grows acuity sub-linearly with the size of the list', () => {
    // Five times the patients is not five times the emergencies. A longer list
    // is more noise around the same handful of real problems.
    const small = composition(8);
    const large = composition(40);

    expect(small).toEqual({ critical: 3, ward: 3, benign: 2 });
    expect(large.critical + large.ward + large.benign).toBe(40);
    expect(large.critical).toBeLessThan(small.critical * 5);
    expect(large.benign / 40).toBeGreaterThan(small.benign / 8);
  });

  it('deals a long list without a duplicate name or bed', () => {
    for (const size of [16, 24, 40, 60]) {
      const { cases } = generateWard({ seed: `LIST${size}`, size });
      expect(cases, `size ${size}`).toHaveLength(size);
      expect(new Set(cases.map((c) => c.room)).size, `rooms at ${size}`).toBe(size);
      expect(new Set(cases.map((c) => c.name)).size, `names at ${size}`).toBe(size);
    }
  });

  it('repeats a diagnosis only once the tier is spent, and evenly', () => {
    // Twenty-six benign patients have to come from four benign archetypes, so
    // repeats are unavoidable; what matters is that they are spread rather than
    // one diagnosis appearing eight times while another never appears.
    const { cases } = generateWard({ seed: 'REPEATS', size: 40 });
    const benign = cases.filter((c) => ARCHETYPE_BY_ID[c.archetypeId].tier === 'benign');
    const counts = new Map<string, number>();
    for (const c of benign) counts.set(c.archetypeId, (counts.get(c.archetypeId) ?? 0) + 1);

    expect(counts.size).toBe(ARCHETYPES.filter((a) => a.tier === 'benign').length);
    expect(Math.max(...counts.values()) - Math.min(...counts.values())).toBeLessThanOrEqual(1);
  });

  it('leaves part of a long list silent, and none of a single ward', () => {
    const ward = generateWard({ seed: 'QUIET8', size: 8 });
    expect(ward.cases.every((c) => c.events.length > 0)).toBe(true);

    const long = generateWard({ seed: 'QUIET40', size: 40 });
    const silent = long.cases.filter((c) => c.events.length === 0);
    expect(silent.length).toBeGreaterThan(0);
    // Only benign patients go quiet — a real problem always declares itself.
    expect(silent.every((c) => ARCHETYPE_BY_ID[c.archetypeId].tier === 'benign')).toBe(true);
  });

  it('still has something to do on every size of list', () => {
    // Four hours rather than twelve: enough for the early declarations to land,
    // and a full night at forty patients is minutes of wall clock in a suite
    // that already runs long.
    for (const size of [8, 40]) {
      const engine = new ShiftEngine(undefined, `PLAY${size}`, size);
      engine.start();
      expect(engine.size).toBe(size);
      for (let i = 0; i < 4 * 3600 / 60; i++) engine.tick(60);

      const urgent = engine.patients.reduce(
        (n, p) => n + p.messages.filter((m) => m.urgent).length, 0,
      );
      expect(urgent, `size ${size}`).toBeGreaterThan(0);
    }
  });
});

// ─── Nothing on a ward is instant ───────────────────────────────────────────

describe('the nurse is a person, not a return value', () => {
  it('takes a beat to acknowledge an order', () => {
    const s = soloShift('copd-exacerbation', { severity: 0.5, declareAt: 20 * 60 });
    run(s.engine, 40 * 60, 30);

    const before = s.patient.messages.length;
    s.engine.placeOrder(s.patient, 'duoneb');
    // The order echoes immediately; the reply does not.
    expect(s.patient.messages.length).toBe(before + 1);
    expect(s.patient.messages[before].author).toBe('doctor');

    run(s.engine, 120, 10);
    const ack = s.patient.messages.slice(before).find((m) => m.kind === 'ack');
    expect(ack).toBeDefined();
    expect(ack!.time).toBeGreaterThan(s.patient.messages[before].time);
  });

  it('makes someone walk to the bedside before vitals appear', () => {
    const s = soloShift('copd-exacerbation', { severity: 0.5, declareAt: 20 * 60 });
    run(s.engine, 40 * 60, 30);

    const chartedBefore = s.patient.lastVitalsAt;
    s.engine.placeOrder(s.patient, 'vitals-now');
    run(s.engine, 60, 10);
    expect(s.patient.lastVitalsAt, 'vitals should not be instant').toBe(chartedBefore);

    run(s.engine, 150, 10);
    expect(s.patient.lastVitalsAt).toBeGreaterThan(chartedBefore);
  });

  it('charts the vitals as of when they were taken, not when they were asked for', () => {
    const s = soloShift('adhf-mislabeled', { severity: 0.6, declareAt: 20 * 60 });
    run(s.engine, 35 * 60, 30);

    const askedAt = s.engine.time;
    s.engine.placeOrder(s.patient, 'vitals-now');
    run(s.engine, 300, 10);

    // A deteriorating patient's numbers reflect the walk, which is the point.
    expect(s.patient.lastVitals!.time).toBeGreaterThan(askedAt);
  });
});

// ─── Warning before the cliff ───────────────────────────────────────────────

describe('a patient who is losing volume says so before the pressure does', () => {
  it('raises the heart rate while the blood pressure is still normal', () => {
    // The cardiopulmonary reflex. Without it the arterial baroreflex defended the
    // pressure successfully, had no error to act on, and nothing else in the model
    // knew the tank was emptying — so a patient could bleed for six hours with an
    // unremarkable heart rate and then arrest with no warning at all.
    const s = soloShift('gi-bleed', { severity: 0.7, declareAt: 20 * 60 });
    const restingHr = s.engine.snapshot(s.patient).hr;

    advanceToDeclaration(s, 200, 30);
    const snap = s.engine.snapshot(s.patient);

    expect(s.patient.status).toBe('stable');
    expect(snap.map, 'still compensating').toBeGreaterThan(70);
    expect(snap.hr - restingHr, 'tachycardia precedes hypotension').toBeGreaterThan(12);
  });

  it('settles the heart rate again when the volume is replaced', () => {
    const bled = soloShift('gi-bleed', { severity: 0.7, declareAt: 20 * 60 });
    advanceToDeclaration(bled, 200, 30);
    const before = bled.engine.snapshot(bled.patient).hr;

    bled.engine.placeOrder(bled.patient, 'prbc');
    run(bled.engine, 90 * MIN, 30);
    expect(bled.engine.snapshot(bled.patient).hr).toBeLessThan(before);
  });

  it('gives the player a window between decompensation and arrest', () => {
    // The complaint this exists for: the acidosis→contractility loop turned over
    // fast enough that a patient sat at a MAP of 91 and arrested six minutes
    // later. Lethal is fine; unwatchable is not.
    const s = soloShift('gi-bleed', { severity: 0.8, declareAt: 20 * 60 });

    let declined = 0;
    let died = 0;
    for (let minute = 0; minute < 12 * 60; minute++) {
      run(s.engine, MIN, 15);
      const snap = s.engine.snapshot(s.patient);
      if (!declined && snap.map < 70) declined = minute;
      if (s.patient.status === 'died') { died = minute; break; }
    }

    expect(died, 'an untreated severe hemorrhage still dies').toBeGreaterThan(0);
    expect(died - declined, 'minutes from decompensating to arrest').toBeGreaterThan(12);
  });
});

describe('a fast heart is not a full one', () => {
  it('costs filling once diastole is short', () => {
    const slow = computeSnapshot({ ...DEFAULT_STATE, hr: 70 }, DEFAULT_PARAMS);
    const fast = computeSnapshot({ ...DEFAULT_STATE, hr: 170 }, DEFAULT_PARAMS);

    // Rate still buys output overall — but not proportionally, because the
    // ventricle it is emptying has had less time to fill.
    expect(fast.sv).toBeLessThan(slow.sv);
    expect(fast.co / slow.co).toBeLessThan(170 / 70);
  });

  it('leaves an ordinary sinus tachycardia essentially unpenalised', () => {
    const rest = computeSnapshot({ ...DEFAULT_STATE, hr: 70 }, DEFAULT_PARAMS);
    const tachy = computeSnapshot({ ...DEFAULT_STATE, hr: 105 }, DEFAULT_PARAMS);
    expect(tachy.sv / rest.sv).toBeGreaterThan(0.99);
  });
});

describe('arrest rhythm follows the cause, not the numbers at the end', () => {
  it('does not fibrillate a patient who bled to death', () => {
    // PCWP is (EDV − V0) × stiffness / emax, so at the contractility clamp floor
    // the wedge diverges however empty the patient is. Every terminal patient
    // therefore read as congested, and hemorrhages arrested in VF.
    const rhythms = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const engine = new ShiftEngine(
        [makeCase('gi-bleed', { severity: 0.85, seed: `RHYTHM${i}` })], `RHYTHM${i}`,
      );
      engine.start();
      const p = engine.patients[0];
      for (let t = 0; t < 12 * 60; t++) {
        engine.tick(MIN);
        if (p.code) { rhythms.add(p.code.rhythm); break; }
        if (p.status === 'died') break;
      }
    }
    expect(rhythms.size).toBeGreaterThan(0);
    expect([...rhythms].every((r) => r === 'PEA' || r === 'asystole')).toBe(true);
  });
});

// ─── Studies that show what is wrong with the patient ───────────────────────

describe('a diagnostic study can find the diagnosis', () => {
  it('puts an infarct on the EKG once the muscle is dying', () => {
    const s = soloShift('acs-cardiogenic', { severity: 0.6, declareAt: 20 * 60 });

    // Before the event the tracing is genuinely unremarkable.
    const early = resolveLabPanel('EKG', s.engine.snapshot(s.patient), s.patient.params,
      0, 0, 'a', s.patient.case.findings);
    expect(early.impression).toMatch(/No acute isch/i);

    advanceToDeclaration(s, 25, 30);
    const late = resolveLabPanel('EKG', s.engine.snapshot(s.patient), s.patient.params,
      0, 0, 'b', s.patient.case.findings);
    expect(late.impression).toMatch(/ST elevation/i);
    // And it does not also claim two other diagnoses in the same line.
    expect(late.impression).not.toMatch(/S1Q3T3/);
  });

  it('shows a pneumothorax growing on successive films', () => {
    const s = soloShift('pneumothorax', { severity: 0.75, declareAt: 20 * 60 });
    const film = () => resolveLabPanel('CXR', s.engine.snapshot(s.patient), s.patient.params,
      0, 0, 'x', s.patient.case.findings).impression!;

    expect(film()).toMatch(/small apical|unchanged/i);
    advanceToDeclaration(s, 30, 30);
    expect(film()).toMatch(/pneumothorax/i);
    advanceToDeclaration(s, 90, 30);
    expect(film()).toMatch(/tension|mediastinal shift|Large pneumothorax/i);
  });

  it('never tells a patient with a finding that their lungs are clear', () => {
    for (const id of ['pneumonia-sepsis', 'aspiration-event', 'pneumothorax', 'adhf-mislabeled']) {
      const s = soloShift(id, { severity: 0.7, declareAt: 20 * 60 });
      advanceToDeclaration(s, 60, 30);
      const impression = resolveLabPanel('CXR', s.engine.snapshot(s.patient), s.patient.params,
        0, 0, 'x', s.patient.case.findings).impression!;
      expect(impression, id).not.toMatch(/Clear lung fields/);
      expect(impression, id).not.toMatch(/consolidation.*No focal consolidation/i);
    }
  });
});

describe('you can ring the attending back', () => {
  it('takes the call a second time', () => {
    const s = soloShift('gi-bleed', { severity: 0.8, declareAt: 20 * 60 });
    expect(s.engine.placeOrder(s.patient, 'consult-gi')).toBeNull();
    run(s.engine, 20 * MIN, 30);
    expect(s.engine.placeOrder(s.patient, 'consult-gi'), 'a second call is not refused').toBeNull();
  });

  it('answers from the patient in front of them, not from the first call', () => {
    const s = soloShift('gi-bleed', { severity: 0.85, declareAt: 20 * 60 });
    const advice = () => s.patient.messages.filter((m) => m.authorName === 'Consult').pop()!.text;

    s.engine.placeOrder(s.patient, 'consult-gi');
    run(s.engine, 15 * MIN, 30);
    const first = advice();

    // Call back once the patient has actually changed — which is the moment the
    // call is worth making, and the moment `once: true` used to refuse it.
    for (let i = 0; i < 12 * 60; i++) {
      run(s.engine, MIN, 30);
      if (s.patient.status !== 'stable') break;
      if (s.engine.snapshot(s.patient).map < 70) break;
    }
    expect(s.patient.status, 'still callable about').toBe('stable');

    expect(s.engine.placeOrder(s.patient, 'consult-gi')).toBeNull();
    run(s.engine, 15 * MIN, 30);
    const second = advice();

    expect(second).not.toBe(first);
    expect(second).toMatch(/I remember/);
  });
});

// ─── Community and academic services ────────────────────────────────────────

describe('the service you are working on', () => {
  it('keeps specialist cases off a community list entirely', () => {
    const specialist = new Set(
      ARCHETYPES.filter((a) => a.setting === 'academic').map((a) => a.id),
    );
    expect(specialist.size).toBeGreaterThan(0);

    for (let i = 0; i < 25; i++) {
      const { cases } = generateWard({ seed: `COMM${i}`, setting: 'community' });
      expect(cases.some((c) => specialist.has(c.archetypeId)), `seed ${i}`).toBe(false);
    }
  });

  it('puts specialist cases on an academic list without crowding out the rest', () => {
    const specialist = new Set(
      ARCHETYPES.filter((a) => a.setting === 'academic').map((a) => a.id),
    );
    let seen = 0;
    let total = 0;
    for (let i = 0; i < 25; i++) {
      for (const c of generateWard({ seed: `ACAD${i}`, setting: 'academic' }).cases) {
        total += 1;
        if (specialist.has(c.archetypeId)) seen += 1;
      }
    }
    // Roughly half, by design — a quaternary service still admits pneumonia.
    expect(seen / total).toBeGreaterThan(0.25);
    expect(seen / total).toBeLessThan(0.75);
  });

  it('hands over every specialist case in a state a ward would accept', () => {
    for (const archetype of ARCHETYPES.filter((a) => a.setting === 'academic')) {
      for (const severity of [0.2, 0.5, 0.8]) {
        const s = soloShift(archetype.id, { severity });
        const v = s.patient.lastVitals!;
        const where = `${archetype.id}@${severity}`;

        expect(v.map, where).toBeGreaterThanOrEqual(62);
        expect(v.spo2, where).toBeGreaterThanOrEqual(88);
        expect(s.patient.status, where).toBe('stable');
      }
    }
  });

  it('can kill every specialist critical case, and no specialist ward one', () => {
    for (const archetype of ARCHETYPES.filter((a) => a.setting === 'academic')) {
      const s = soloShift(archetype.id, { severity: 0.85, declareAt: 20 * 60 });
      for (let i = 0; i < 12 * 60; i++) {
        run(s.engine, MIN, 30);
        if (s.patient.status !== 'stable') break;
      }
      const lost = s.patient.status !== 'stable';
      expect(lost, `${archetype.id} (${archetype.tier})`).toBe(archetype.tier === 'critical');
    }
  });
});

// ─── What the day team leaves behind ────────────────────────────────────────

describe('inherited orders and results', () => {
  it('hands over the medications on every patient', () => {
    for (const setting of ['community', 'academic'] as const) {
      for (const c of generateWard({ seed: `MEDS-${setting}`, setting }).cases) {
        expect(c.medications.length, `${c.archetypeId}`).toBeGreaterThan(0);
        for (const m of c.medications) {
          expect(m.name).toBeTruthy();
          expect(m.detail).toBeTruthy();
          expect(m.since).toBeTruthy();
        }
      }
    }
  });

  it('dates prior results before the shift began', () => {
    for (const c of generateWard({ seed: 'PRIOR', setting: 'academic' }).cases) {
      for (const l of c.priorLabs) {
        expect(l.drawnAt, `${c.archetypeId}/${l.panel}`).toBeLessThan(0);
        expect(l.values.length + (l.impression ? 1 : 0)).toBeGreaterThan(0);
      }
    }
  });

  it('leaves the afternoon gas on a COPD patient for whoever looks', () => {
    // The specific thing a covering doctor wants at 02:00 and cannot generate:
    // what this patient's carbon dioxide was doing while someone was watching.
    const c = makeCase('copd-exacerbation', { severity: 0.6 });
    const gases = c.priorLabs.filter((l) => l.panel === 'VBG');
    expect(gases.length).toBeGreaterThanOrEqual(2);

    const pco2 = gases[0].values.find((v) => v.label.startsWith('pCO'))!;
    expect(pco2.value).toBeGreaterThan(45);
    // Two of them, so the trend is readable rather than a single number.
    expect(gases[0].drawnAt).not.toBe(gases[1].drawnAt);
  });

  it('records the sensitivities behind the antibiotic that is running', () => {
    const c = makeCase('cf-exacerbation', { severity: 0.5 });
    const culture = c.priorLabs.find((l) => l.panel === 'Sputum culture');
    expect(culture?.impression).toMatch(/Pseudomonas/);
    expect(c.medications.some((m) => /Tobramycin/i.test(m.name))).toBe(true);
  });
});

// ─── The right ventricle ────────────────────────────────────────────────────

describe('the right ventricle ejects against a pressure', () => {
  it('drives pulmonary pressure from the flow that crosses the lung', () => {
    // mPAP was computed from the RV's isolated pumping capacity, so a dilated RV
    // on the flat of its Starling curve reported eleven liters a minute while the
    // series constraint held the real circulation at five — and mPAP came out
    // above the systemic pressure, which is not a state a body can be in.
    const dilated = computeSnapshot(
      { ...DEFAULT_STATE, rvedv: 240, pvr: 8, edv: 92 }, DEFAULT_PARAMS,
    );
    expect(dilated.mPAP).toBeLessThan(dilated.map);
    expect(dilated.mPAP).toBeCloseTo(dilated.co * 8 + dilated.pcwp, 0);
  });

  it('loses output when the pressure it ejects against rises', () => {
    const rest = computeSnapshot({ ...DEFAULT_STATE }, DEFAULT_PARAMS);
    const loaded = computeSnapshot({ ...DEFAULT_STATE, pvr: 9 }, DEFAULT_PARAMS);
    expect(loaded.mPAP).toBeGreaterThan(rest.mPAP);
    expect(loaded.co).toBeLessThan(rest.co);
  });

  it('lets a hypertrophied right ventricle tolerate what stops a normal one', () => {
    // The reason a chronic PAH patient walks around at a mean pulmonary pressure
    // that puts an acute pulmonary embolus into shock.
    const acute = computeSnapshot({ ...DEFAULT_STATE, pvr: 9, rvEmax: 0.5 }, DEFAULT_PARAMS);
    const adapted = computeSnapshot({ ...DEFAULT_STATE, pvr: 9, rvEmax: 0.9 }, DEFAULT_PARAMS);
    expect(adapted.co).toBeGreaterThan(acute.co);
  });
});

describe('a background condition shades a case, it does not decide it', () => {
  it('never hands over a hemoglobin incompatible with life', () => {
    for (let i = 0; i < 40; i++) {
      for (const setting of ['community', 'academic'] as const) {
        for (const c of generateWard({ seed: `HGB${i}`, setting }).cases) {
          const hgb = c.paramOverrides?.hgb;
          if (hgb !== undefined) expect(hgb, c.archetypeId).toBeGreaterThanOrEqual(6);
        }
      }
    }
  });

  it('keeps the severity continuum monotone rather than letting one modifier flip it', () => {
    // Anemia acts entirely through the SvO2 → lactate → contractility spiral,
    // which is the highest-gain loop in the model. Stacked onto a case that
    // already fails along that axis it stopped being a modifier: the same
    // cardiogenic patient died at 127 minutes without it and 15 with it.
    const survivalMinutes: number[] = [];
    for (const severity of [0.35, 0.45, 0.55, 0.65]) {
      const s = soloShift('adhf-mislabeled', { severity, declareAt: 20 * 60 });
      let lost = 12 * 60;
      for (let i = 0; i < 12 * 60; i++) {
        run(s.engine, MIN, 30);
        if (s.patient.status !== 'stable') { lost = i; break; }
      }
      survivalMinutes.push(lost);
    }
    // No single step collapses by more than half — a modifier narrows the margin,
    // it does not replace the disease.
    for (let i = 1; i < survivalMinutes.length; i++) {
      expect(survivalMinutes[i], `step ${i}`).toBeGreaterThan(survivalMinutes[i - 1] * 0.4);
    }
  });
});

// ─── Clinical shape of the academic cases ───────────────────────────────────

describe('the academic library covers the range, not just the extremes', () => {
  it('offers a sickle cell crisis that stays a crisis', () => {
    // Most crises are just crises. The commonest harm done overnight is not
    // missing an acute chest — it is treating a person in real pain as though
    // they were exaggerating, and producing the splinting that causes one.
    for (const severity of [0.2, 0.5, 0.9]) {
      const s = soloShift('sickle-vaso-occlusive', { severity, declareAt: 20 * 60 });
      for (let i = 0; i < 12 * 60; i++) run(s.engine, MIN, 30);
      expect(s.patient.status, `severity ${severity}`).toBe('stable');
    }
    expect(ARCHETYPE_BY_ID['sickle-vaso-occlusive'].contraindicatedOrders)
      .toContain('lorazepam');
  });

  it('makes hepatic encephalopathy a hunt for the precipitant, not a pressure problem', () => {
    const s = soloShift('hepatic-encephalopathy', { severity: 0.7, declareAt: 20 * 60 });
    const opening = s.engine.snapshot(s.patient).map;
    for (let i = 0; i < 12 * 60; i++) run(s.engine, MIN, 30);

    // Hemodynamically uneventful all night, which is the point: the illness is
    // neurological and the model should not pretend otherwise.
    expect(s.patient.status).toBe('stable');
    expect(Math.abs(s.engine.snapshot(s.patient).map - opening)).toBeLessThan(20);

    // The precipitant is in the messages and in the medication list.
    const said = s.patient.messages.map((m) => m.text).join(' ');
    expect(said).toMatch(/bowel movement/i);
    expect(s.patient.case.medications.some((m) => /Lactulose/i.test(m.name))).toBe(true);

    const harms = ARCHETYPE_BY_ID['hepatic-encephalopathy'].contraindicatedOrders ?? [];
    expect(harms).toContain('lorazepam');
    expect(harms).toContain('haloperidol');
  });

  it('separates a variceal bleed from a bleeding ulcer', () => {
    const varices = ARCHETYPE_BY_ID['variceal-bleed'];
    // Portal pressure, not just volume: octreotide and antibiotics are what make
    // this a different disease from the peptic ulcer next door.
    expect(varices.expectedOrders).toContain('octreotide');
    // Antibiotics for every cirrhotic who bleeds — the indication is the bleed.
    expect(varices.expectedOrders).toContain('ceftriaxone');
    expect(ARCHETYPE_BY_ID['gi-bleed'].expectedOrders).not.toContain('octreotide');

    const c = makeCase('variceal-bleed', { severity: 0.5 });
    expect(c.priorLabs.some((l) => /Endoscopy/i.test(l.panel))).toBe(true);
    expect(c.handoff.summary + c.teachingPoint).toMatch(/varic/i);
  });

  it('treats spontaneous bacterial peritonitis as the subacute illness it is', () => {
    const sbp = ARCHETYPE_BY_ID['cirrhosis-sbp'];
    // Dangerous over days, through the kidneys — not a hemodynamic emergency
    // that kills before morning.
    expect(sbp.tier).toBe('ward');
    expect(sbp.expectedOrders.slice(0, 2)).toEqual(['ceftriaxone', 'albumin']);

    for (const severity of [0.3, 0.7, 1]) {
      const s = soloShift('cirrhosis-sbp', { severity, declareAt: 20 * 60 });
      for (let i = 0; i < 12 * 60; i++) run(s.engine, MIN, 30);
      expect(s.patient.status, `severity ${severity}`).toBe('stable');
    }
  });

  it('makes a right ventricle failing for the first time overnight a rare night', () => {
    let pah = 0;
    let total = 0;
    for (let i = 0; i < 60; i++) {
      for (const c of generateWard({ seed: `RARE${i}`, setting: 'academic' }).cases) {
        total += 1;
        if (c.archetypeId === 'pah-rv-failure') pah += 1;
      }
    }
    // Present, but not a case you meet every third shift.
    expect(pah).toBeGreaterThan(0);
    expect(pah / total).toBeLessThan(0.035);
  });
});

describe('a ward-level case is serious, not lethal', () => {
  it('does not lose a ward or benign patient overnight, at any severity', () => {
    const lost: string[] = [];
    for (const archetype of ARCHETYPES.filter((a) => a.tier !== 'critical')) {
      // The exception, and the only one: a dying patient on comfort measures is
      // the case whose whole point is that the intervention is a conversation.
      if (archetype.id === 'end-of-life-pneumonia') continue;

      for (const severity of [0.3, 0.6, 0.9, 1]) {
        const s = soloShift(archetype.id, { severity, declareAt: 20 * 60 });
        for (let i = 0; i < 12 * 60; i++) {
          run(s.engine, MIN, 30);
          if (s.patient.status !== 'stable') break;
        }
        if (s.patient.status !== 'stable') {
          lost.push(`${archetype.id}@${severity} (${s.patient.case.comorbidities.join('+') || 'no comorbidities'})`);
        }
      }
    }
    expect(lost).toEqual([]);
  });
});

describe('the nurse says a thing once', () => {
  it('does not re-read the same observations down the phone all night', () => {
    // A subacute illness sits on an abnormal set of numbers for hours. Announcing
    // them afresh every observation round is an alarm, not a colleague, and the
    // player learns to stop reading the channel.
    const s = soloShift('cirrhosis-sbp', { severity: 0.6, declareAt: 20 * 60 });
    for (let i = 0; i < 12 * 60; i++) run(s.engine, MIN, 30);

    const flags = s.patient.messages
      .filter((m) => /Just flagging this|I need you to know about this one/.test(m.text))
      .map((m) => m.text.replace(/\d+/g, '#'));

    expect(new Set(flags).size).toBe(flags.length);
  });
});

// ─── Rungs between doing nothing and doing everything ───────────────────────

describe('the escalation ladders have middle rungs', () => {
  it('grades oxygen from a cannula to positive pressure without a gap', () => {
    const reached = (orderId: string) => {
      const s = soloShift('adhf-mislabeled', { severity: 0.5, declareAt: 20 * 60 });
      run(s.engine, 55 * MIN, 20);
      s.engine.placeOrder(s.patient, orderId);
      run(s.engine, 20 * MIN, 20);
      return s.engine.snapshot(s.patient).spO2;
    };

    const cannula = reached('o2-nc6');
    const mask = reached('o2-nrb');
    const highFlow = reached('hfnc');
    const positive = reached('bipap');

    // High flow does what a mask cannot — some recruitment — without being BiPAP.
    expect(highFlow).toBeGreaterThan(mask);
    expect(positive).toBeGreaterThan(highFlow);
    expect(mask).toBeGreaterThanOrEqual(cannula);
  });

  it('replaces the oxygen device rather than stacking on it', () => {
    const s = soloShift('adhf-mislabeled', { severity: 0.5, declareAt: 20 * 60 });
    run(s.engine, 55 * MIN, 20);
    s.engine.placeOrder(s.patient, 'o2-nrb');
    run(s.engine, 5 * MIN, 20);
    s.engine.placeOrder(s.patient, 'hfnc');
    run(s.engine, 15 * MIN, 20);

    const running = s.patient.interventions.filter(
      (i) => i.label.startsWith('O2:') && i.stopTime === undefined && i.target === 'fiO2',
    );
    expect(running).toHaveLength(1);
    expect(s.engine.snapshot(s.patient).fiO2).toBeLessThanOrEqual(1);
  });

  it('offers a fluid challenge smaller than a commitment', () => {
    const given = (orderId: string) => {
      const s = soloShift('hypovolemia', { severity: 0.6, declareAt: 20 * 60 });
      run(s.engine, 60 * MIN, 30);
      const before = s.engine.snapshot(s.patient).edv;
      s.engine.placeOrder(s.patient, orderId);
      run(s.engine, 25 * MIN, 30);
      return s.engine.snapshot(s.patient).edv - before;
    };
    const challenge = given('ns-250');
    const bolus = given('ns-500');
    expect(challenge).toBeGreaterThan(0);
    expect(challenge).toBeLessThan(bolus);
  });

  it('puts a rung between non-pharmacologic delirium care and haloperidol', () => {
    expect(ORDER_BY_ID['quetiapine']).toBeDefined();
    expect(ORDER_BY_ID['quetiapine'].category).toBe('comfort');
    expect(ORDER_BY_ID['incentive-spirometry']).toBeDefined();
    expect(ARCHETYPE_BY_ID['benign-sundowning'].expectedOrders).toContain('quetiapine');
  });

  it('offers a bed between the ward and the unit', () => {
    const s = soloShift('adhf-mislabeled', { severity: 0.4, declareAt: 20 * 60 });
    run(s.engine, 40 * MIN, 30);
    expect(s.engine.placeOrder(s.patient, 'step-down')).toBeNull();
    run(s.engine, 35 * MIN, 30);
    // Continuous monitoring, without the ICU-only treatments.
    expect(s.patient.monitored).toBe(true);
    expect(s.patient.location).not.toBe('icu');
    expect(s.engine.placeOrder(s.patient, 'norepi')).not.toBeNull();
  });
});

describe('choosing an antibiotic, not reaching for all of them', () => {
  it('credits a broader drug for a narrower expectation, and not the reverse', () => {
    const treat = (archetypeId: string, orderId: string) => {
      const s = soloShift(archetypeId, { severity: 0.6, declareAt: 20 * 60 });
      run(s.engine, 40 * MIN, 30);
      s.engine.placeOrder(s.patient, orderId);
      return ordersSatisfiedBy(s.patient);
    };

    // Urosepsis wants ceftriaxone; vanc-and-zosyn covers the organism too.
    expect(treat('urosepsis', 'abx').has('ceftriaxone')).toBe(true);
    expect(treat('urosepsis', 'pip-tazo').has('ceftriaxone')).toBe(true);

    // Neutropenic sepsis wants pseudomonal cover, and ceftriaxone has none.
    expect(treat('neutropenic-sepsis', 'ceftriaxone').has('pip-tazo')).toBe(false);
    expect(ARCHETYPE_BY_ID['neutropenic-sepsis'].contraindicatedOrders)
      .toContain('ceftriaxone');
  });
});

describe('comfort care is the end of a conversation', () => {
  it('refuses to write it before the family has been called', () => {
    const s = soloShift('end-of-life-pneumonia', { severity: 0.6, declareAt: 20 * 60 });
    run(s.engine, 40 * MIN, 30);

    const refusal = s.engine.placeOrder(s.patient, 'comfort-care');
    expect(refusal).not.toBeNull();
    expect(s.patient.messages[s.patient.messages.length - 1].text).toMatch(/family/i);
    expect(s.patient.orders.some((o) => o.orderId === 'comfort-care')).toBe(false);

    expect(s.engine.placeOrder(s.patient, 'goals-of-care')).toBeNull();
    run(s.engine, 20 * MIN, 30);
    expect(s.engine.placeOrder(s.patient, 'comfort-care')).toBeNull();
  });

  it('counts the conversation as management on the case that needs it', () => {
    expect(ARCHETYPE_BY_ID['end-of-life-pneumonia'].expectedOrders).toContain('goals-of-care');
  });
});

describe('stopping something the day team started', () => {
  it('crosses the medication off the chart', () => {
    const s = soloShift('variceal-bleed', { severity: 0.6, declareAt: 20 * 60 });
    run(s.engine, 30 * MIN, 30);

    const blocker = s.patient.case.medications.find(
      (m) => /propranolol|carvedilol/i.test(m.name),
    );
    expect(blocker, 'every cirrhotic here is on one').toBeDefined();

    expect(s.engine.placeOrder(s.patient, 'hold-rate-control')).toBeNull();
    run(s.engine, 10 * MIN, 30);
    expect(
      s.patient.heldMeds.some((h) => blocker!.name.toLowerCase().includes(h)),
    ).toBe(true);
  });
});

describe('the acuity slider changes how sick the ward is, not who is on it', () => {
  it('slides the severity distribution monotonically', () => {
    const meanSeverity = (acuity: number) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 40; i++) {
        for (const c of generateWard({ seed: `ACUITY${i}`, acuity }).cases) {
          sum += c.severity;
          n += 1;
        }
      }
      return sum / n;
    };

    const quiet = meanSeverity(0);
    const normal = meanSeverity(0.5);
    const bad = meanSeverity(1);
    expect(quiet).toBeLessThan(normal);
    expect(normal).toBeLessThan(bad);
  });

  it('keeps the spread, so a quiet night can still hold one sick patient', () => {
    const severities: number[] = [];
    for (let i = 0; i < 60; i++) {
      for (const c of generateWard({ seed: `SPREAD${i}`, acuity: 0.15 }).cases) {
        severities.push(c.severity);
      }
    }
    // A difficulty setting that removed the variance would remove the triage.
    expect(Math.max(...severities)).toBeGreaterThan(0.5);
    expect(Math.min(...severities)).toBeLessThan(0.1);
  });

  it('does not change which diagnoses are on the list', () => {
    const idsAt = (acuity: number) =>
      new Set(generateWard({ seed: 'SAMEWARD', acuity }).cases.map((c) => c.archetypeId));
    expect([...idsAt(0)].sort()).toEqual([...idsAt(1)].sort());
  });
});

// ─── The ward speaks American ───────────────────────────────────────────────

/**
 * Words and constructions that mark a hospital as British.
 *
 * The content drifted this way because the physiology reads the same in both
 * dialects and the prose does not: a nurse who charts "observations", pages the
 * "registrar", and asks whether the patient has "opened their bowels" is working
 * somewhere the player has never been. Held as a test rather than a style note
 * because it is the kind of thing that comes back one page at a time.
 */
const BRITISH = [
  /\bregistrar/i,
  /\bconsultant\b/i,
  /opened (his|her|their) bowels/i,
  /\bobservations\b/i,
  /\bobs are\b/i,
  /haemo|aemia\b|aemic\b|oedema|oesoph|melaena/i,
  /\blitres?\b/i,
  /nebulis|catheteris|hospitalis|recognis|stabilis/i,
  /\bparacetamol|adrenaline|salbutamol|co-amoxiclav|flucloxacillin/i,
  /glyceryl trinitrate/i,
  /nil by mouth/i,
  /\bunwell\b/i,
  /\btrolley\b/i,
  /\bbloods\b/i,
  /air entry/i,
  /\brousable\b/i,
  /\bresite\b/i,
  /as required\b/i,
  /\blaboured\b/i,
  /\bafterwards\b/i,
  /\bgrey\b/i,
  /in (him|her|them)self\b/i,
  // Collective nouns take a singular verb in American English.
  /(family|team|cardiology|hepatology|surgery|service|pharmacy|respiratory) (have|are)\b/i,
];

/** Every string a player can actually be shown. */
function playerFacingText(): string[] {
  const out: string[] = [];
  const grades: Gestalt[] = [0, 1, 2, 3].map((n) => ({
    wob: n as 0 | 1 | 2 | 3, perf: n as 0 | 1 | 2 | 3, text: '',
  }));

  for (const order of ORDERS) {
    out.push(order.label, order.detail);
    out.push(typeof order.ack === 'function' ? order.ack(makeVoice('female')) : order.ack);
    if (order.requires) out.push(order.requires.refusal);
  }

  for (let seed = 0; seed < 6; seed++) {
    for (const setting of ['community', 'academic'] as const) {
      for (const c of generateWard({ seed: `VOICE${seed}`, setting }).cases) {
        out.push(c.admissionDx, c.hiddenDx, c.teachingPoint, ...c.history);
        out.push(c.handoff.summary, ...c.handoff.todo, ...c.handoff.contingencies);
        for (const m of c.medications) out.push(m.name, m.detail, m.since);
        for (const l of c.priorLabs) {
          out.push(l.panel, l.impression ?? '');
          for (const v of l.values) out.push(v.label);
        }
        for (const e of c.events) {
          if (!e.page) continue;
          if (typeof e.page === 'string') out.push(e.page);
          else for (const g of grades) out.push(e.page(g));
        }
      }
    }
  }
  return out;
}

describe('the ward speaks American', () => {
  it('has no British usage anywhere a player can see it', () => {
    const offenders: string[] = [];
    for (const line of playerFacingText()) {
      for (const pattern of BRITISH) {
        const hit = line.match(pattern);
        if (hit) offenders.push(`"${hit[0]}" in: ${line.slice(0, 90)}`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('keeps the nurse question prompts American too', () => {
    for (const q of NURSE_QUESTIONS) {
      for (const pattern of BRITISH) {
        expect(q.text, q.id).not.toMatch(pattern);
      }
    }
  });
});
