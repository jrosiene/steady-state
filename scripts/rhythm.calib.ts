/**
 * AF calibration: rate, output, pressure and wedge across the situations the
 * rhythm model must get right.   CALIBRATE=1 npx vitest run scripts/rhythm.calib.ts
 */
import { it } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../src/engine/constants';
import { snapshot, applyInterventions } from '../src/engine/hemodynamics';
import { clampEffective } from '../src/engine/solver';
import { stepPhysics } from '../src/game/physics';
import type { HemodynamicParams, HemodynamicState, Intervention, Snapshot } from '../src/engine/types';

function run(state: Partial<HemodynamicState>, params: Partial<HemodynamicParams> = {}, ivs: Intervention[] = [], seconds = 1800): Snapshot {
  const p = { ...DEFAULT_PARAMS, ...params };
  let s: HemodynamicState = { ...DEFAULT_STATE, ...state };
  p.edvRef = s.edv; p.hrBaseline = s.hr; p.svrBaseline = s.svr;
  p.mapSetpoint = snapshot(s, p).map;
  for (let t = 0; t < seconds; t += 0.25) s = stepPhysics(s, p, ivs, 0.25);
  return snapshot(clampEffective(applyInterventions(s, ivs), p), p);
}
const iv = (target: keyof HemodynamicState, delta: number): Intervention =>
  ({ label: String(target), category: 'scenario', kind: 'scenario', target, delta, tauOn: 30, eliminationHalfLife: 1e6, startTime: 0 });
const f = (x: number, d = 0) => x.toFixed(d);
const line = (l: string, s: Snapshot) => `${l.padEnd(34)} HR ${f(s.hr).padStart(3)} (drive ${f(s.hrEffective === s.hr ? s.hr : s.hr)}) SV ${f(s.sv).padStart(3)} CO ${f(s.co, 1)} MAP ${f(s.map).padStart(3)} PCWP ${f(s.pcwp).padStart(2)} SpO2 ${f(s.spO2 * 100)} lac ${f(s.lactate, 1)}`;

it('rhythm', () => {
  const out: string[] = [];
  const normal = {};
  out.push(line('normal sinus', run(normal)));
  out.push(line('normal AF', run(normal, {}, [iv('afib', 1)])));
  out.push(line('normal AF RVR (rest rate 150)', run(normal, { afRestRate: 150 }, [iv('afib', 1)])));
  out.push(line('normal RVR + AV block .3', run(normal, { afRestRate: 150 }, [iv('afib', 1), iv('avBlock', 0.3)])));
  out.push(line('normal AF + AV block .3', run(normal, {}, [iv('afib', 1), iv('avBlock', 0.3)])));
  const stiff = { edv: 110, emax: 2.4 };
  const stiffP = { lvEdpvrStiffness: 0.32, atrialKickFraction: 0.32, afRestRate: 150 };
  out.push(line('HFpEF sinus', run(stiff, stiffP)));
  out.push(line('HFpEF AF', run(stiff, stiffP, [iv('afib', 1)])));
  out.push(line('HFpEF AF + AV block .35', run(stiff, stiffP, [iv('afib', 1), iv('avBlock', 0.35)])));
  const sepsis = [iv('noTone', 0.6), iv('edv', -15)];
  out.push(line('sepsis sinus', run({}, {}, sepsis, 3600)));
  out.push(line('sepsis AF', run({}, {}, [...sepsis, iv('afib', 1)], 3600)));
  out.push(line('sepsis AF + AV block .35', run({}, {}, [...sepsis, iv('afib', 1), iv('avBlock', 0.35)], 3600)));
  const hfref = { edv: 150, emax: 1.3 };
  out.push(line('HFrEF sinus', run(hfref)));
  out.push(line('HFrEF AF', run(hfref, { afRestRate: 150 }, [iv('afib', 1)])));
  out.push(line('HFrEF AF + dilt (block, -inotropy)', run(hfref, { afRestRate: 150 }, [iv('afib', 1), iv('avBlock', 0.35), iv('emax', -0.35), iv('svr', -2)])));
  out.push(line('HFrEF AF + digoxin-like block', run(hfref, { afRestRate: 150 }, [iv('afib', 1), iv('avBlock', 0.3)])));
  console.log('\n' + out.join('\n'));
});
