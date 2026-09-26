/**
 * Atrial fibrillation.
 *
 * What the rhythm model has to reproduce from mechanism: a ventricular rate
 * set by AV-nodal conduction and sympathetic tone, the cost of losing the
 * atrial kick and of irregular short cycles, and the three bedside answers to
 * "should I slow this down?" — yes in a stiff ventricle, not with diltiazem in
 * a failing one, and not before the sepsis in a septic one.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import { applyInterventions, derive, snapshot } from '../hemodynamics';
import { clampEffective } from '../solver';
import { afStrokeLoss, fillingFraction, laBackupVolume, ventricularRate } from '../rhythm';
import { stepPhysics } from '../../game/physics';
import type { HemodynamicParams, HemodynamicState, Intervention, Snapshot } from '../types';

function run(
  state: Partial<HemodynamicState>,
  params: Partial<HemodynamicParams> = {},
  ivs: Intervention[] = [],
  seconds = 1800,
): Snapshot {
  const p = { ...DEFAULT_PARAMS, ...params };
  let s: HemodynamicState = { ...DEFAULT_STATE, ...state };
  // Centre the reflexes on this patient's own resting state, as the ward does.
  p.edvRef = s.edv; p.hrBaseline = s.hr; p.svrBaseline = s.svr;
  p.mapSetpoint = snapshot(s, p).map;
  for (let t = 0; t < seconds; t += 0.25) s = stepPhysics(s, p, ivs, 0.25);
  return snapshot(clampEffective(applyInterventions(s, ivs), p), p);
}

const on = (target: keyof HemodynamicState, delta: number): Intervention => ({
  label: String(target), category: 'scenario', kind: 'scenario', target, delta,
  tauOn: 30, eliminationHalfLife: 1e6, startTime: 0,
});

const STIFF = { edv: 110, emax: 2.4 };
const STIFF_P = { lvEdpvrStiffness: 0.32, atrialKickFraction: 0.32, afRestRate: 150 };
const HFREF = { edv: 150, emax: 1.3 };
const RVR = { afRestRate: 150 };

describe('ventricular rate in AF', () => {
  it('is the sinus drive in sinus rhythm', () => {
    expect(ventricularRate(84, 0, 0.5, DEFAULT_PARAMS)).toBe(84);
  });

  it('rises with sympathetic drive and falls with AV block', () => {
    const rest = ventricularRate(70, 1, 0, DEFAULT_PARAMS);
    const stressed = ventricularRate(120, 1, 0, DEFAULT_PARAMS);
    const blocked = ventricularRate(120, 1, 0.35, DEFAULT_PARAMS);
    expect(rest).toBeCloseTo(DEFAULT_PARAMS.afRestRate, 0);
    expect(stressed).toBeGreaterThan(rest + 30);
    expect(blocked).toBeLessThan(stressed - 40);
  });

  it('is capped by AV-nodal refractoriness', () => {
    expect(ventricularRate(220, 1, 0, DEFAULT_PARAMS)).toBeLessThanOrEqual(DEFAULT_PARAMS.afMaxRate);
  });

  it('is reported as the pulse', () => {
    const s = snapshot({ ...DEFAULT_STATE, afib: 1 }, { ...DEFAULT_PARAMS, ...RVR });
    expect(s.hr).toBeCloseTo(150, 0);
    expect(s.hrEffective).toBe(s.hr);
  });
});

describe('what AF costs', () => {
  it('loses the atrial kick at any rate', () => {
    expect(fillingFraction(70, 1, DEFAULT_PARAMS)).toBeCloseTo(1 - DEFAULT_PARAMS.atrialKickFraction, 5);
    expect(fillingFraction(70, 0, DEFAULT_PARAMS)).toBe(1);
  });

  it('loses more stroke output to short cycles the faster it goes, and more in a stiff heart', () => {
    const slow = afStrokeLoss(100, 1, DEFAULT_PARAMS);
    const fast = afStrokeLoss(160, 1, DEFAULT_PARAMS);
    const stiff = afStrokeLoss(160, 1, { ...DEFAULT_PARAMS, lvEdpvrStiffness: 0.32 });
    expect(fast).toBeGreaterThan(slow * 2);
    expect(stiff).toBeGreaterThan(fast);
    expect(afStrokeLoss(160, 0, DEFAULT_PARAMS)).toBe(0);
  });

  it('holds volume back in the atrium, mostly as a function of rate', () => {
    const fast = laBackupVolume(120, 160, 1, DEFAULT_PARAMS);
    const controlled = laBackupVolume(120, 90, 1, DEFAULT_PARAMS);
    expect(fast).toBeGreaterThan(controlled * 2);
  });

  it('leaves a normal heart roughly where sinus rhythm had it', () => {
    const sinus = run({});
    const af = run({}, RVR, [on('afib', 1)]);
    expect(af.hr).toBeGreaterThan(140);
    expect(Math.abs(af.co - sinus.co)).toBeLessThan(1);
    expect(af.map).toBeGreaterThan(80);
  });

  it('leaves sinus rhythm exactly as it was', () => {
    const d = derive(DEFAULT_STATE, DEFAULT_PARAMS);
    expect(d.hrEffective).toBe(DEFAULT_STATE.hr);
    expect(d.co).toBeCloseTo(5.06, 2);
  });
});

describe('should I slow it down?', () => {
  it('yes, in a stiff ventricle: output rises and the wedge falls', () => {
    const rvr = run(STIFF, STIFF_P, [on('afib', 1)]);
    const controlled = run(STIFF, STIFF_P, [on('afib', 1), on('avBlock', 0.35)]);
    expect(rvr.pcwp).toBeGreaterThan(18);
    expect(controlled.co).toBeGreaterThan(rvr.co + 0.5);
    expect(controlled.pcwp).toBeLessThan(rvr.pcwp - 5);
  });

  it('not with diltiazem in a failing ventricle', () => {
    const rvr = run(HFREF, RVR, [on('afib', 1)]);
    const diltiazem = run(HFREF, RVR, [on('afib', 1), on('avBlock', 0.35), on('emax', -0.35), on('svr', -2)]);
    const digoxinLike = run(HFREF, RVR, [on('afib', 1), on('avBlock', 0.3)]);
    expect(diltiazem.map).toBeLessThan(rvr.map - 5);
    expect(diltiazem.co).toBeLessThan(rvr.co);
    expect(digoxinLike.co).toBeGreaterThanOrEqual(rvr.co);
    expect(digoxinLike.pcwp).toBeLessThan(rvr.pcwp);
  });

  it('not first, in sepsis: the rate is compensation and slowing it buys nothing', () => {
    const sepsis = [on('noTone', 0.6), on('edv', -15)];
    const af = run({}, {}, [...sepsis, on('afib', 1)], 3600);
    const controlled = run({}, {}, [...sepsis, on('afib', 1), on('avBlock', 0.35)], 3600);
    const sinus = run({}, {}, sepsis, 3600);
    expect(af.hr).toBeGreaterThan(sinus.hr + 25); // sympathetic drive conducted
    expect(af.map).toBeLessThan(sinus.map);       // AF made it worse
    expect(controlled.map).toBeLessThan(af.map + 3); // and slowing it did not fix it
  });
});
