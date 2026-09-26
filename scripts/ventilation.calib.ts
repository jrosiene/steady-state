/**
 * Ventilation calibration: steady states the CO2 model has to reproduce.
 * Run with:  CALIBRATE=1 npx vitest run scripts/ventilation.calib.ts
 */
import { it } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../src/engine/constants';
import { snapshot, applyInterventions } from '../src/engine/hemodynamics';
import { clampEffective } from '../src/engine/solver';
import { stepPhysics } from '../src/game/physics';
import type { HemodynamicParams, HemodynamicState, Intervention, Snapshot } from '../src/engine/types';

function run(
  state: Partial<HemodynamicState>,
  params: Partial<HemodynamicParams> = {},
  seconds = 3600,
  ivs: Intervention[] = [],
  pinLactate?: number,
): Snapshot {
  const p = { ...DEFAULT_PARAMS, ...params };
  let s: HemodynamicState = { ...DEFAULT_STATE, ...state };
  for (let t = 0; t < seconds; t += 0.25) {
    s = stepPhysics(s, p, ivs, 0.25);
    s = { ...s, time: s.time, lactate: pinLactate ?? s.lactate };
  }
  return snapshot(clampEffective(applyInterventions(s, ivs), p), p);
}

const f = (x: number, d = 1) => x.toFixed(d);
function line(label: string, s: Snapshot) {
  return `${label.padEnd(38)} PaCO2 ${f(s.paCO2).padStart(5)}  pH ${f(s.pH, 2)}  HCO3 ${f(s.hco3).padStart(4)}  ` +
    `VE ${f(s.ve).padStart(5)} dem ${f(s.veDemand).padStart(5)} cap ${f(s.veCapacity).padStart(4)}  RR ${f(s.rr, 0).padStart(3)}  VT ${f(s.vt * 1000, 0).padStart(4)}  ` +
    `SpO2 ${f(s.spO2 * 100, 0)}  PaO2 ${f(s.paO2, 0).padStart(3)}  MAP ${f(s.map, 0)}  CO ${f(s.co)}  lac ${f(s.lactate)} wedge ${f(s.pcwp,0)}`;
}

it('ventilation steady states', () => {
  const out: string[] = [];
  out.push(line('rest', run({})));

  out.push('— metabolic acidosis (Winter: 1.5×HCO3 + 8 ± 2) —');
  for (const hco3 of [16, 20]) {
    const s = run({}, {}, 1800, [], 1 + (24 - hco3));
    out.push(line(`lactic, HCO3 ${hco3} (Winter ${1.5 * hco3 + 8})`, s));
  }
  for (const hco3 of [8, 12, 16]) {
    const s = run({}, { hco3Baseline: hco3 }, 1800);
    out.push(line(`renal, HCO3 ${hco3} (Winter ${1.5 * hco3 + 8})`, s));
  }

  out.push('— opioid depression (room air) —');
  for (const dep of [0.3, 0.6, 0.8, 0.9, 0.95]) {
    out.push(line(`dep ${dep}`, run({ ventDepression: dep })));
  }
  out.push(line('dep 0.9 on 2L (FiO2 .28)', run({ ventDepression: 0.9, fiO2: 0.28 })));
  const apnea = run({ ventDepression: 1 }, {}, 300);
  out.push(line('apnea 5 min (expect ~+20)', apnea));

  out.push('— non-chemical drive —');
  out.push(line('pneumonia qsQt .25', run({ qsQt: 0.25 })));
  out.push(line('PE qsQt .15 deadSpace .15 pvr 6', run({ qsQt: 0.15, deadSpace: 0.15, pvr: 6 })));
  out.push(line('edema (edv 160 emax 1.15)', run({ edv: 160, emax: 1.15 })));

  out.push('— COPD retainer —');
  const copd: Partial<HemodynamicParams> = {
    paCO2Setpoint: Number(process.env.SP ?? 50), hco3Baseline: Number(process.env.HB ?? 30),
    veMax: Number(process.env.VEMAX ?? 11), ventCo2Gain: Number(process.env.CO2G ?? 0.12),
  };
  const copdState = { paCO2: copd.paCO2Setpoint, qsQt: 0.12, deadSpace: 0.3, pvr: 2.4, fiO2: 0.28 };
  out.push(line('stable on 2L', run(copdState, copd)));
  out.push(line('stable on RA', run({ ...copdState, fiO2: 0.21 }, copd)));
  const exac = { ...copdState, qsQt: 0.29, deadSpace: 0.42 };
  out.push(line('exacerbation on 2L', run(exac, copd)));
  out.push(line('exacerbation on NRB (FiO2 .85)', run({ ...exac, fiO2: 0.85 }, copd)));
  out.push(line('exacerbation on 2L + BiPAP (support .5)', run({ ...exac, ventSupport: 0.5, fiO2: 0.4 }, copd)));
  out.push(line('stable + morphine (dep .3)', run({ ...copdState, ventDepression: 0.3 }, copd)));
  out.push(line('stable on NRB 1h', run({ ...copdState, fiO2: 0.85 }, copd)));
  out.push(line('exac on NRB, 20 min', run({ ...exac, fiO2: 0.85 }, copd, 1200)));
  out.push(line('exac on NRB, 2 h', run({ ...exac, fiO2: 0.85 }, copd, 7200)));
  out.push(line('exac + BiPAP .6 FiO2 .35', run({ ...exac, ventSupport: 0.6, fiO2: 0.35 }, copd)));

  out.push('— shock —');
  const sepsis: Intervention = { label: 'sepsis', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.7, tauOn: 300, eliminationHalfLife: 1e6, startTime: 0 };
  out.push(line('sepsis noTone .7 overlay', run({}, {}, 3600, [sepsis])));
  out.push(line('cardiogenic emax .6', run({ emax: 0.6 }, {}, 3600)));
  console.log('\n' + out.join('\n'));
});
