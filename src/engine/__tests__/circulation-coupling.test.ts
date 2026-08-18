import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import { derive, snapshot } from '../hemodynamics';
import { computeRVSV } from '../frank-starling';

/**
 * Two couplings that turn isolated ventricular/pulmonary mechanics into a
 * closed circulation. Both were absent from the original model, and both are
 * load-bearing for any case where the right heart or the wedge is the problem.
 */

describe('series circulation: LV output cannot exceed RV output', () => {
  it('leaves a healthy patient unconstrained', () => {
    // At baseline the RV delivers slightly more than the LV ejects, so the
    // constraint must not bind and normal physiology must be untouched.
    const snap = snapshot({ ...DEFAULT_STATE }, DEFAULT_PARAMS);
    const rvSv = computeRVSV(DEFAULT_STATE.rvedv, DEFAULT_STATE.rvEmax, DEFAULT_PARAMS);

    expect(rvSv).toBeGreaterThan(snap.sv);
    expect(snap.co).toBeGreaterThan(4.5);
    expect(snap.map).toBeGreaterThan(80);
  });

  it('collapses cardiac output when the right ventricle fails', () => {
    // Severe RV failure: dilated past its overdistension threshold with poor
    // contractility. The LV is entirely normal — only delivery is missing.
    const failedRv = {
      ...DEFAULT_STATE,
      rvedv: 300,
      rvEmax: 0.2,
      pvr: 10,
    };
    const d = derive(failedRv, DEFAULT_PARAMS);

    expect(d.rvSv).toBeLessThan(20);
    // The left ventricle must not out-pump the right.
    expect(d.sv).toBeLessThanOrEqual(d.rvSv + 1e-9);
    expect(d.co).toBeLessThan(2.0);
    // And the patient must be recognised as circulatory failing, not "compensated".
    expect(d.cardiovascularStatus).not.toBe('compensated');
  });

  it('scales LV output with RV output through the intermediate range', () => {
    const outputs = [0.5, 0.4, 0.3, 0.25].map((rvEmax) => {
      const d = derive({ ...DEFAULT_STATE, rvEmax, rvedv: 260 }, DEFAULT_PARAMS);
      return { rvEmax, sv: d.sv, rvSv: d.rvSv };
    });

    for (let i = 1; i < outputs.length; i++) {
      expect(outputs[i].sv).toBeLessThanOrEqual(outputs[i - 1].sv + 1e-9);
      expect(outputs[i].sv).toBeLessThanOrEqual(outputs[i].rvSv + 1e-9);
    }
  });
});

describe('hydrostatic pulmonary oedema drives shunt', () => {
  it('does not create shunt at a normal wedge', () => {
    const snap = snapshot({ ...DEFAULT_STATE }, DEFAULT_PARAMS);
    expect(snap.pcwp).toBeLessThan(DEFAULT_PARAMS.edemaPcwpThreshold);
    expect(snap.spO2).toBeGreaterThan(0.95);
  });

  it('desaturates a congested patient even on room air', () => {
    // Failing, volume-overloaded LV: a high EDV against reduced contractility
    // raises the wedge, which floods alveoli and creates true shunt.
    const d = derive({ ...DEFAULT_STATE, edv: 175, emax: 1.2 }, DEFAULT_PARAMS);

    expect(d.pcwp).toBeGreaterThan(25);
    expect(d.spO2).toBeLessThan(0.92);
  });

  it('improves oxygenation when preload is reduced', () => {
    // The clinical claim under test: offloading a wet patient fixes their
    // saturation because it fixes their filling pressure. This is why nitrates
    // and diuresis beat oxygen in cardiogenic pulmonary oedema.
    const wet = derive({ ...DEFAULT_STATE, edv: 175, emax: 1.2 }, DEFAULT_PARAMS);
    const offloaded = derive({ ...DEFAULT_STATE, edv: 140, emax: 1.2 }, DEFAULT_PARAMS);

    expect(offloaded.pcwp).toBeLessThan(wet.pcwp);
    expect(offloaded.spO2).toBeGreaterThan(wet.spO2 + 0.03);
  });

  it('responds less to oxygen than it does to preload reduction', () => {
    // Shunt is by definition refractory to supplemental oxygen — blood bypassing
    // flooded alveoli never meets the higher FiO2. Treating the pressure works;
    // turning up the oxygen largely does not. That contrast is the teaching point.
    const congested = { ...DEFAULT_STATE, edv: 175, emax: 1.2 };
    const roomAir = derive(congested, DEFAULT_PARAMS);
    const highFlow = derive({ ...congested, fiO2: 0.8 }, DEFAULT_PARAMS);
    const offloaded = derive({ ...congested, edv: 140 }, DEFAULT_PARAMS);

    const oxygenGain = highFlow.spO2 - roomAir.spO2;
    const offloadGain = offloaded.spO2 - roomAir.spO2;

    expect(offloadGain).toBeGreaterThan(oxygenGain);
  });
});

describe('anaemia does not manufacture lactic acidosis', () => {
  it('leaves resting lactate normal across the clinically common range', () => {
    // Chronic anaemia with a normal cardiac output does not produce lactate.
    // A threshold set at normal SvO2 used to make every anaemic patient acidotic
    // and seeded false death spirals in any case involving blood loss.
    for (const hgb of [15, 12, 10, 8]) {
      const params = { ...DEFAULT_PARAMS, hgb };
      const d = derive({ ...DEFAULT_STATE }, params);
      const target =
        1 + params.lactateSvO2Gain * Math.max(0, params.lactateSvO2Threshold - d.svO2);
      expect(target, `Hgb ${hgb}`).toBeCloseTo(1, 5);
    }
  });

  it('still generates lactate at genuinely critical oxygen delivery', () => {
    // Profound anaemia plus a low output must still cross the anaerobic threshold.
    const params = { ...DEFAULT_PARAMS, hgb: 5 };
    const d = derive({ ...DEFAULT_STATE, edv: 70, emax: 1.0 }, params);
    const target =
      1 + params.lactateSvO2Gain * Math.max(0, params.lactateSvO2Threshold - d.svO2);

    expect(d.svO2).toBeLessThan(0.4);
    expect(target).toBeGreaterThan(3);
  });
});
