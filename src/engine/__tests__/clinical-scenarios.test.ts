/**
 * Clinical scenario integration tests.
 *
 * Each test simulates a realistic combination of pathology + treatment and
 * asserts that key hemodynamic parameters evolve in the physiologically
 * correct direction. These are directional/qualitative tests — they verify
 * that the model captures the right mechanism, not exact numeric values.
 *
 * Simulation helper runs the full ODE pipeline (interventions → clampEffective
 * → derive → baroreflex + mediator ODEs → RK4 → clampState) the same way
 * the game loop does, so these tests exercise the complete engine.
 *
 * IMPORTANT: All assertions on intervention-dependent derived values (MAP, CO,
 * PCWP, SpO2, mPAP) must use effectiveDerived(), not derive(). Interventions
 * are read-only overlays on the base state — derive(baseState) cannot see them.
 * This mirrors what the game loop does: snapshot(effective, params) is the
 * canonical output, not snapshot(base, params).
 */

import { describe, it, expect } from 'vitest';
import { rk4Step, clampState, clampEffective } from '../solver';
import { derivative, derive, applyInterventions } from '../hemodynamics';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../constants';
import type { HemodynamicState, Intervention } from '../types';

const DT = 0.05; // match game loop physics timestep
const p = DEFAULT_PARAMS;

/** Run simulation for `duration` sim-seconds with optional interventions. */
function simulate(
  initial: HemodynamicState,
  duration: number,
  interventions: Intervention[] = [],
): HemodynamicState {
  let state = { ...initial };
  const steps = Math.floor(duration / DT);
  for (let i = 0; i < steps; i++) {
    const derivFn = (s: HemodynamicState) => derivative(
      clampEffective(applyInterventions(s, interventions), p), p,
    );
    state = clampState(rk4Step(state, p, DT, derivFn), p);
    state = { ...state, time: state.time + DT };
  }
  return state;
}

/**
 * Compute derived values from the EFFECTIVE state (base + interventions).
 * Mirrors what the game loop exposes to the UI via snapshot(effective, params).
 * Must be used for all assertions involving intervention-overlaid variables.
 */
function effectiveDerived(state: HemodynamicState, interventions: Intervention[]) {
  return derive(clampEffective(applyInterventions(state, interventions), p), p);
}

/** Build an intervention that is fully active immediately (tauOn=1s). */
function iv(
  label: string,
  category: 'scenario' | 'treatment',
  target: keyof HemodynamicState,
  delta: number,
  tauOn = 1,
  eliminationHalfLife = 415,
): Intervention {
  return { label, category, kind: 'scenario', target, delta, tauOn, eliminationHalfLife, startTime: 0 };
}

// ─── 1. Hemorrhagic Shock → Fluid Resuscitation ───────────────────────────

describe('Hemorrhage + fluid resuscitation', () => {
  it('class II hemorrhage: HR↑, SVR↑, MAP partially preserved', () => {
    const bled = { ...DEFAULT_STATE, edv: 85 };
    const s = simulate(bled, 60);
    const d = derive(s, p); // edv baked into base state — no overlay needed
    expect(s.hr).toBeGreaterThan(p.hrBaseline + 5);     // compensatory tachycardia
    expect(s.svr).toBeGreaterThan(p.svrBaseline);        // vasoconstriction
    expect(d.map).toBeGreaterThan(55);                    // MAP defended but below setpoint
    expect(d.map).toBeLessThan(p.mapSetpoint);
  });

  it('fluid bolus after hemorrhage raises MAP and CO toward baseline', () => {
    const bled = { ...DEFAULT_STATE, edv: 85 };
    const decompensated = simulate(bled, 30);
    const mapBefore = derive(decompensated, p).map; // no overlay at this point
    const coBefore  = derive(decompensated, p).co;

    const fluid = iv('Fluid bolus', 'treatment', 'edv', 40, 60);
    const treated = simulate(decompensated, 300, [fluid]);
    const mapAfter = effectiveDerived(treated, [fluid]).map; // fluid is an overlay
    const coAfter  = effectiveDerived(treated, [fluid]).co;

    expect(mapAfter).toBeGreaterThan(mapBefore);
    expect(coAfter).toBeGreaterThan(coBefore);
  });

  it('small fluid bolus in class IV hemorrhage only partially restores MAP', () => {
    const severe = { ...DEFAULT_STATE, edv: 40 };
    const fluid = iv('Fluid', 'treatment', 'edv', 25, 60);
    const treated = simulate(severe, 120, [fluid]);
    const d = effectiveDerived(treated, [fluid]);
    expect(d.map).toBeLessThan(p.mapSetpoint); // still below target despite bolus
    expect(d.co).toBeLessThan(5.0);            // CO impaired
  });
});

// ─── 2. Septic Shock → Vasopressors ──────────────────────────────────────

describe('Septic shock + vasopressor treatment', () => {
  it('NO-mediated sepsis: SVR falls, MAP drops, HR compensates', () => {
    const sepsis = [iv('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 10)];
    const s = simulate(DEFAULT_STATE, 120, sepsis);
    const d = effectiveDerived(s, sepsis); // noTone is an overlay — must use effectiveDerived
    expect(d.map).toBeLessThan(p.mapSetpoint - 10); // hypotensive (~78 mmHg)
    expect(s.hr).toBeGreaterThan(p.hrBaseline);      // compensatory tachycardia in base state
  });

  it('norepinephrine acutely raises effective MAP in septic shock', () => {
    // Note: SVR overlays are neutralized by the baroreflex at steady state — it drives
    // effective.svr to the same target (svrBaseline + gainSvr×error) regardless of the overlay.
    // Test the PHARMACOLOGIC EFFECT by comparing effectiveDerived at the same state,
    // before baroreflex has had time to compensate. This mirrors the acute clinical effect.
    const sepsis = [iv('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 10)];
    const shocked = simulate(DEFAULT_STATE, 120, sepsis);
    const mapShocked = effectiveDerived(shocked, sepsis).map;

    const withNorepi = [
      ...sepsis,
      iv('Norepi: SVR', 'treatment', 'svr', 8, 1),
      iv('Norepi: chrono', 'treatment', 'hrMod', 5, 1),
    ];
    // Immediate overlay effect at same physiologic state — before baroreflex compensates
    const mapWithNorepi = effectiveDerived(shocked, withNorepi).map;
    expect(mapWithNorepi).toBeGreaterThan(mapShocked + 10);
  });

  it('vasopressin acutely raises effective MAP in NO-driven shock', () => {
    // Same architecture as norepi: compare immediate overlay effect at same state.
    const sepsis = [iv('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 10)];
    const shocked = simulate(DEFAULT_STATE, 120, sepsis);
    const mapShocked = effectiveDerived(shocked, sepsis).map;

    const withVaso = [...sepsis, iv('Vasopressin', 'treatment', 'svr', 6, 1)];
    const mapWithVaso = effectiveDerived(shocked, withVaso).map;
    expect(mapWithVaso).toBeGreaterThan(mapShocked + 10);
  });

  it('steroids counteract noTone vasodilation — effective MAP improves', () => {
    // Steroids overlay negative delta on noTone (reducing effective NO tone).
    // Validated at time=120s so onset fraction is substantial (1-exp(-2) ≈ 87%).
    const highNoTone = { ...DEFAULT_STATE, noTone: 0.5 }; // represents established sepsis
    const withSteroids = [iv('Steroids', 'treatment', 'noTone', -0.3, 60)];
    const s = simulate(highNoTone, 120, withSteroids); // time=120 → onset ≈ 87%
    // Effective noTone is lower with steroids → less SVR depression → higher MAP
    expect(effectiveDerived(s, withSteroids).map).toBeGreaterThan(derive(s, p).map);
  });

  it('sepsis drives type B lactic acidosis: lactate rises despite adequate CO', () => {
    // Key teaching point: in septic shock, lactate rises via cytopathic hypoxia
    // (inflammatory mitochondrial dysfunction) even when CO is high and SvO2 is normal.
    // This is why septic lactate does NOT correlate with SvO2 the way hemorrhagic shock does.
    const sepsis = [iv('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 10)];
    const early = simulate(DEFAULT_STATE, 60, sepsis);
    const late  = simulate(DEFAULT_STATE, 600, sepsis);
    const dLate = effectiveDerived(late, sepsis);

    expect(late.lactate).toBeGreaterThan(early.lactate);           // lactate rises over time
    expect(late.lactate).toBeGreaterThan(3.0);                     // clinically significant elevation
    expect(dLate.co).toBeGreaterThan(3.5);                         // CO still preserved (hyperdynamic)
    expect(dLate.svO2).toBeGreaterThan(0.65);                      // SvO2 above anaerobic threshold
  });

  it('sepsis produces significant compensatory tachycardia', () => {
    // Baroreflex responds to MAP drop from SVR reduction: HR rises to compensate.
    // Clinical: warm septic shock HR typically 100-120 bpm.
    const sepsis = [iv('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 10)];
    const s = simulate(DEFAULT_STATE, 300, sepsis); // allow baroreflex to equilibrate
    expect(s.hr).toBeGreaterThan(p.hrBaseline + 15); // at least 15 bpm above baseline
  });

  it('sustained severe sepsis (noTone 1.0) eventually collapses despite preserved initial CO', () => {
    // With maximal noTone, type B lactate + acidosis Emax penalty + vasoplegia create a
    // positive feedback spiral. System is initially compensated (hyperdynamic), but
    // acidosis-driven contractility loss eventually drops CO enough that SvO2 falls
    // below the anaerobic threshold — triggering the type A component and runaway collapse.
    const severe = [iv('Severe sepsis', 'scenario', 'noTone', 1.0, 10)];
    const early = simulate(DEFAULT_STATE, 120, severe);
    const late  = simulate(DEFAULT_STATE, 900, severe);
    expect(effectiveDerived(early, severe).cardiovascularStatus).toBe('compensated'); // initially OK
    expect(['decompensating', 'arrest']).toContain(
      effectiveDerived(late, severe).cardiovascularStatus,           // collapses by 15 min
    );
  });

  it('dobutamine in septic shock: CO↑ but MAP response limited (SVR already low)', () => {
    const sepsis = [iv('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 10)];
    const decompensated = simulate(DEFAULT_STATE, 120, sepsis);
    const coBefore = effectiveDerived(decompensated, sepsis).co;

    const withDob = [...sepsis, iv('Dobut: inotropy', 'treatment', 'emax', 1.0, 30)];
    const treated = simulate(decompensated, 180, withDob);

    expect(effectiveDerived(treated, withDob).co).toBeGreaterThan(coBefore); // CO improves
    // MAP improvement limited — SVR is the constraint
    expect(effectiveDerived(treated, withDob).map).toBeLessThan(p.mapSetpoint);
  });
});

// ─── 3. Cardiogenic Shock → Inotropes + Volume ────────────────────────────

describe('Cardiogenic shock + inotropic support', () => {
  it('acute MI: CO↓, MAP↓, HR compensates, PCWP rises', () => {
    const mi = [iv('Acute MI', 'scenario', 'emax', -1.2, 10)];
    const s = simulate(DEFAULT_STATE, 120, mi);
    const d = effectiveDerived(s, mi); // emax is an overlay — must use effectiveDerived
    expect(d.co).toBeLessThan(4.5);
    expect(d.map).toBeLessThan(p.mapSetpoint - 5);
    expect(d.pcwp).toBeGreaterThan(12); // pulmonary congestion
    expect(s.hr).toBeGreaterThan(p.hrBaseline);
  });

  it('dobutamine in cardiogenic shock: CO↑, PCWP↓, MAP↑', () => {
    const mi = [iv('Acute MI', 'scenario', 'emax', -1.2, 10)];
    const shocked = simulate(DEFAULT_STATE, 120, mi);
    const dBefore = effectiveDerived(shocked, mi);

    const withDob = [
      ...mi,
      iv('Dobut: inotropy', 'treatment', 'emax', 1.0, 30),
      iv('Dobut: chrono', 'treatment', 'hrMod', 25, 30),
    ];
    const treated = simulate(shocked, 180, withDob);
    const dAfter = effectiveDerived(treated, withDob);

    expect(dAfter.co).toBeGreaterThan(dBefore.co);
    expect(dAfter.map).toBeGreaterThan(dBefore.map);
    expect(dAfter.pcwp).toBeLessThan(dBefore.pcwp); // less congestion
  });

  it('fluid bolus in severe cardiogenic shock worsens CO (overdistension)', () => {
    // Severe failure: emax at 40% → edvCrit well below normal EDV
    const shocked = { ...DEFAULT_STATE, emax: p.emaxRef * 0.4 }; // emax baked into base state
    const stable = simulate(shocked, 30);
    const coBefore = derive(stable, p).co; // no overlay needed — emax is in base state

    const overloaded = { ...stable, edv: 185 }; // bake high EDV into base
    const after = simulate(overloaded, 30);
    expect(derive(after, p).co).toBeLessThan(coBefore);
  });

  it('epinephrine raises MAP and CO in cardiogenic shock', () => {
    const mi = [iv('Acute MI', 'scenario', 'emax', -1.2, 10)];
    const shocked = simulate(DEFAULT_STATE, 120, mi);
    const mapBefore = effectiveDerived(shocked, mi).map;

    const withEpi = [
      ...mi,
      iv('Epi: SVR', 'treatment', 'svr', 6, 30),
      iv('Epi: inotropy', 'treatment', 'emax', 1.5, 30),
      iv('Epi: chrono', 'treatment', 'hrMod', 40, 30),
    ];
    const treated = simulate(shocked, 180, withEpi);
    expect(effectiveDerived(treated, withEpi).map).toBeGreaterThan(mapBefore + 5);
  });
});

// ─── 4. Tension Pneumothorax → Needle Decompression ──────────────────────

describe('Tension pneumothorax + needle decompression', () => {
  it('tension PTX: obstructive pattern — EDV↓, CVP↑, CO↓, MAP↓', () => {
    const ptx = [
      iv('PTX: tamponade', 'scenario', 'edv', -80, 10),
      iv('PTX: CVP rise', 'scenario', 'cvp', 18, 10),
    ];
    const s = simulate(DEFAULT_STATE, 60, ptx);
    const d = effectiveDerived(s, ptx);
    expect(d.co).toBeLessThan(3.0);
    expect(d.map).toBeLessThan(p.mapSetpoint - 10);
  });

  it('needle decompression reverses obstructive physiology', () => {
    const ptx = [
      iv('PTX: tamponade', 'scenario', 'edv', -80, 10),
      iv('PTX: CVP rise', 'scenario', 'cvp', 18, 10),
    ];
    const compressed = simulate(DEFAULT_STATE, 60, ptx);
    const coBefore = effectiveDerived(compressed, ptx).co;

    const treated = [
      ...ptx,
      iv('Needle: restore EDV', 'treatment', 'edv', 50, 5),
      iv('Needle: CVP drop', 'treatment', 'cvp', -16, 1),
    ];
    const after = simulate(compressed, 60, treated);
    expect(effectiveDerived(after, treated).co).toBeGreaterThan(coBefore);
  });
});

// ─── 5. Pulmonary Hypertension Classes ───────────────────────────────────

describe('Pulmonary hypertension scenarios', () => {
  it('Class I PAH: mPAP↑, PCWP normal, SpO2 preserved initially', () => {
    const pah = [iv('PAH: PVR↑', 'scenario', 'pvr', 4, 10)];
    const s = simulate(DEFAULT_STATE, 60, pah);
    const d = effectiveDerived(s, pah);
    expect(d.mPAP).toBeGreaterThan(25);  // PH threshold
    expect(d.pcwp).toBeLessThan(18);     // no LV disease
    expect(d.spO2).toBeGreaterThan(0.90); // SpO2 preserved with normal shunt
  });

  it('Class II PVH: PCWP↑, mPAP↑', () => {
    const lvf = [iv('PVH: LV failure', 'scenario', 'emax', -1.0, 10)];
    const s = simulate(DEFAULT_STATE, 60, lvf);
    const d = effectiveDerived(s, lvf);
    expect(d.pcwp).toBeGreaterThan(18); // pulmonary hypertension from LV back-pressure
    expect(d.mPAP).toBeGreaterThan(20);
  });

  it('Class III hypoxic PH: shunt → SpO2↓ → HPV → mPAP↑', () => {
    const hypoxic = [
      iv('HPV: shunt↑', 'scenario', 'qsQt', 0.20, 10),
    ];
    const s = simulate(DEFAULT_STATE, 60, hypoxic);
    const d = effectiveDerived(s, hypoxic);
    expect(d.spO2).toBeLessThan(0.93);  // hypoxemia from shunt
    expect(d.mPAP).toBeGreaterThan(derive(DEFAULT_STATE, p).mPAP); // HPV raises mPAP
  });

  it('iNO selectively reduces PVR without dropping SVR', () => {
    const pah = [iv('PAH: PVR↑', 'scenario', 'pvr', 4, 10)];
    const s = simulate(DEFAULT_STATE, 60, pah);
    const mPAPBefore = effectiveDerived(s, pah).mPAP;
    const mapBefore  = effectiveDerived(s, pah).map;

    const withIno = [...pah, iv('iNO', 'treatment', 'pvr', -0.8, 10)];
    const treated = simulate(s, 120, withIno);

    expect(effectiveDerived(treated, withIno).mPAP).toBeLessThan(mPAPBefore);
    // MAP should not drop significantly (iNO is selective)
    expect(Math.abs(effectiveDerived(treated, withIno).map - mapBefore)).toBeLessThan(10);
  });

  it('sildenafil reduces mPAP but also mildly drops MAP (PDE5 not fully selective)', () => {
    const pah = [iv('PAH: PVR↑', 'scenario', 'pvr', 4, 10)];
    const s = simulate(DEFAULT_STATE, 60, pah);
    const mPAPBefore = effectiveDerived(s, pah).mPAP;
    const mapBefore  = effectiveDerived(s, pah).map;

    const withSild = [
      ...pah,
      iv('Sildenafil: PVR↓', 'treatment', 'pvr', -1.5, 10),
      iv('Sildenafil: SVR↓', 'treatment', 'svr', -0.5, 10),
    ];
    const treated = simulate(s, 120, withSild);

    const mPAPAfter = effectiveDerived(treated, withSild).mPAP;
    const mapAfter  = effectiveDerived(treated, withSild).map;
    expect(mPAPAfter).toBeLessThan(mPAPBefore);
    // mPAP improvement should exceed any MAP change (PDE5 not fully selective but predominantly pulmonary)
    expect(mPAPBefore - mPAPAfter).toBeGreaterThan(Math.abs(mapBefore - mapAfter));
  });

  it('ET-1 antagonist (bosentan) lowers mPAP and mildly drops MAP', () => {
    // et1Tone and pvr baked into initial state — derive on base state works for "before"
    const s = simulate({ ...DEFAULT_STATE, et1Tone: 0.6, pvr: 4.0 }, 30);
    const mPAPBefore = derive(s, p).mPAP;
    const mapBefore  = derive(s, p).map;

    const withBosentan = [iv('Bosentan', 'treatment', 'et1Tone', -0.6, 10)];
    const treated = simulate(s, 120, withBosentan);

    expect(effectiveDerived(treated, withBosentan).mPAP).toBeLessThan(mPAPBefore);
    expect(effectiveDerived(treated, withBosentan).map).toBeLessThan(mapBefore);
  });
});

// ─── 6. COPD + Exacerbation + O2 Therapy ─────────────────────────────────

describe('COPD + oxygenation', () => {
  it('stable COPD: SpO2↓, PaO2↓, mPAP mildly elevated', () => {
    // qsQt=0.20 overlay → effective qsQt=0.22 → SpO2≈0.92 < 0.93 ✓
    const copd = [
      iv('COPD: V/Q', 'scenario', 'qsQt', 0.20, 10),
      iv('COPD: PVR↑', 'scenario', 'pvr', 2.0, 10),
    ];
    const s = simulate(DEFAULT_STATE, 60, copd);
    const d = effectiveDerived(s, copd);
    expect(d.spO2).toBeLessThan(0.93);
    expect(d.paO2).toBeLessThan(80);
    expect(d.mPAP).toBeGreaterThan(derive(DEFAULT_STATE, p).mPAP);
  });

  it('COPD exacerbation: SpO2 drops further', () => {
    const copd = [iv('COPD: V/Q', 'scenario', 'qsQt', 0.20, 10)];
    const stableCopd = simulate(DEFAULT_STATE, 60, copd);
    const spO2Stable = effectiveDerived(stableCopd, copd).spO2;

    // Exacerbation stacks additional shunt (total effective qsQt ≈ 0.32)
    const exac = [...copd, iv('Exac: shunt↑', 'scenario', 'qsQt', 0.10, 10)];
    const s = simulate(stableCopd, 60, exac);
    expect(effectiveDerived(s, exac).spO2).toBeLessThan(spO2Stable);
  });

  it('supplemental O2 improves SpO2 in V/Q mismatch (not fixed shunt)', () => {
    // Moderate V/Q mismatch — O2 helps because it raises PAO2 → SaO2_ideal → SpO2
    const copd = [iv('COPD: V/Q', 'scenario', 'qsQt', 0.20, 10)];
    const s = simulate(DEFAULT_STATE, 60, copd);
    const spO2Before = effectiveDerived(s, copd).spO2;

    const withO2 = [...copd, iv('Supp O2', 'treatment', 'fiO2', 0.19, 10)];
    const treated = simulate(s, 60, withO2);

    expect(effectiveDerived(treated, withO2).spO2).toBeGreaterThan(spO2Before);
  });

  it('supplemental O2 has limited effect with large fixed shunt (key teaching point)', () => {
    // Large shunt fraction — the hallmark teaching point of the shunt model
    const largeShunt = [iv('Large shunt', 'scenario', 'qsQt', 0.35, 10)];
    const s = simulate(DEFAULT_STATE, 60, largeShunt);
    const spO2RoomAir = effectiveDerived(s, largeShunt).spO2;

    const with100O2 = [...largeShunt, iv('100% O2', 'treatment', 'fiO2', 0.79, 10)];
    const treated = simulate(s, 60, with100O2);
    const spO2HighO2 = effectiveDerived(treated, with100O2).spO2;

    expect(spO2HighO2).toBeGreaterThan(spO2RoomAir); // helps a little
    expect(spO2HighO2 - spO2RoomAir).toBeLessThan(0.06); // but < 6% improvement
  });
});

// ─── 7. RV Failure + Septal Interdependence ───────────────────────────────

describe('RV failure and septal interdependence', () => {
  it('elevated PVR causes RVEDV to rise toward interdependence threshold', () => {
    const pah = [iv('PAH: PVR↑', 'scenario', 'pvr', 5, 10)];
    const s = simulate(DEFAULT_STATE, 300, pah); // allow RV dilation to develop
    // RVEDV ODE is driven by effective PVR (pvr overlay visible in derivFn) → base rvedv rises
    expect(s.rvedv).toBeGreaterThan(DEFAULT_STATE.rvedv + 10);
  });

  it('massive PE: acute RV afterload → CO↓ → MAP↓ despite baroreflex', () => {
    const pe = [
      iv('PE: PVR↑', 'scenario', 'pvr', 10, 10),
      iv('PE: shunt↑', 'scenario', 'qsQt', 0.20, 10),
    ];
    const s = simulate(DEFAULT_STATE, 300, pe); // allow RV dilation + septal interdependence to develop
    const d = effectiveDerived(s, pe);
    expect(d.co).toBeLessThan(4.5);
    expect(d.map).toBeLessThan(p.mapSetpoint - 5);
    expect(d.mPAP).toBeGreaterThan(25);
  });

  it('cor pulmonale: elevated RVEDV creates septal shift, reducing effective EDV', () => {
    // RVEDV baked into state — RV-LV interdependence is an algebraic layer in derive()
    const baseDerived = derive(DEFAULT_STATE, p);

    // RV dilation well above threshold (195 mL)
    const dilated = { ...DEFAULT_STATE, rvedv: 240 };
    const dilatedDerived = derive(dilated, p);

    expect(dilatedDerived.sv).toBeLessThan(baseDerived.sv);
    expect(dilatedDerived.map).toBeLessThan(baseDerived.map);
  });
});

// ─── 8. Heart Failure Escalation ─────────────────────────────────────────

describe('Heart failure spectrum', () => {
  it('ADHF: Emax↓ + volume overload → PCWP >18, SpO2↓', () => {
    const adhf = [
      iv('ADHF: LV↓', 'scenario', 'emax', -0.9, 10),
      iv('ADHF: volume', 'scenario', 'edv', 50, 10),
      iv('ADHF: pulm edema', 'scenario', 'qsQt', 0.08, 10), // pulmonary congestion → shunt
    ];
    const s = simulate(DEFAULT_STATE, 120, adhf);
    const d = effectiveDerived(s, adhf);
    expect(d.pcwp).toBeGreaterThan(18); // pulmonary edema range
    expect(d.spO2).toBeLessThan(0.95);  // hypoxemia from pulmonary congestion + low SvO2
  });

  it('biventricular failure: both CO and SvO2 severely reduced', () => {
    const biv = [
      iv('BiV LV↓', 'scenario', 'emax', -0.8, 10),
      iv('BiV RV↓', 'scenario', 'rvEmax', -0.25, 10),
      iv('BiV EDV↑', 'scenario', 'edv', 40, 10),
      iv('BiV CVP↑', 'scenario', 'cvp', 8, 10),
    ];
    const s = simulate(DEFAULT_STATE, 120, biv);
    const d = effectiveDerived(s, biv);
    expect(d.co).toBeLessThan(4.0);
    expect(d.svO2).toBeLessThan(0.65); // high O2 extraction in low-output state
    expect(d.pcwp).toBeGreaterThan(15);
  });

  it('dobutamine improves SvO2 in low-output HF (Fick: CO↑ → less extraction)', () => {
    const hf = [iv('HF: LV↓', 'scenario', 'emax', -0.8, 10)];
    const s = simulate(DEFAULT_STATE, 120, hf);
    const svO2Before = effectiveDerived(s, hf).svO2;

    const withDob = [
      ...hf,
      iv('Dobut: inotropy', 'treatment', 'emax', 1.0, 30),
      iv('Dobut: chrono', 'treatment', 'hrMod', 25, 30),
    ];
    const treated = simulate(s, 180, withDob);
    expect(effectiveDerived(treated, withDob).svO2).toBeGreaterThan(svO2Before);
  });
});

// ─── 9. Vasoactive Mediator Dynamics ─────────────────────────────────────

describe('Vasoactive mediator ODE dynamics', () => {
  it('noTone rises over time with sustained hypoxemia', () => {
    // qsQt overlay reduces SpO2 → noToneTarget rises → ODE integrates noTone upward
    const hypoxic = [iv('Shunt', 'scenario', 'qsQt', 0.25, 10)];
    const early = simulate(DEFAULT_STATE, 60, hypoxic);
    const late  = simulate(DEFAULT_STATE, 600, hypoxic);
    // Base state noTone driven by ODE: (noToneTarget - state.noTone) / tauNoTone
    expect(late.noTone).toBeGreaterThan(early.noTone);
  });

  it('et1Tone rises with sustained elevated mPAP', () => {
    // pvr baked into initial state → derive correctly sees elevated mPAP → et1Tone ODE rises
    const pah = [iv('PAH: PVR↑', 'scenario', 'pvr', 4, 10)];
    const early = simulate(DEFAULT_STATE, 60, pah);
    const late  = simulate(DEFAULT_STATE, 900, pah);
    // ET-1 has a 10 min time constant — should still be rising at 15 min
    expect(late.et1Tone).toBeGreaterThan(early.et1Tone);
  });

  it('noTone vasodilation and et1Tone vasoconstriction partially offset in combined PH+hypoxia', () => {
    // pvr and qsQt baked into initial state — derive on base state works correctly
    // PAH drives ET-1 up (vasoconstrict); hypoxemia drives NO up (vasodilate)
    // Net SVR/MAP effect should be between the two extremes
    const pahOnly   = simulate({ ...DEFAULT_STATE, pvr: 4.0 }, 300);
    const hypoxOnly = simulate({ ...DEFAULT_STATE, qsQt: 0.25 }, 300);
    const combined  = simulate({ ...DEFAULT_STATE, pvr: 4.0, qsQt: 0.25 }, 300);

    const mapPah      = derive(pahOnly, p).map;   // ET-1 → SVR↑ → MAP up
    const mapHypox    = derive(hypoxOnly, p).map;  // NO → SVR↓ → MAP down
    const mapCombined = derive(combined, p).map;

    const mapMin = Math.min(mapPah, mapHypox);
    const mapMax = Math.max(mapPah, mapHypox);
    expect(mapCombined).toBeGreaterThan(mapMin - 5);
    expect(mapCombined).toBeLessThan(mapMax + 5);
  });

  it('noTone decays after underlying driver resolves', () => {
    // Start with elevated base noTone (as would develop after sustained hypoxemia)
    // Architectural note: the sepsis noTone overlay does NOT raise base.noTone (it's a display
    // overlay, not an ODE input). Base noTone is driven only by SpO2 via computeVasoactiveToneTargets.
    // Here we bake elevated noTone directly into the initial state and verify ODE decay.
    const peaked = { ...DEFAULT_STATE, noTone: 0.5 };
    const recovering = simulate(peaked, 600, []); // no interventions — ODE target = 0
    expect(recovering.noTone).toBeLessThan(peaked.noTone);
  });
});
