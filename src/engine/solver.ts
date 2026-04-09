import type { HemodynamicParams, HemodynamicState } from './types';

/**
 * NaN-safe clamp. Math.min/Math.max propagate NaN silently — if a non-finite
 * value ever appears (e.g. 0/0 in an intermediate RK4 stage), it would be
 * preserved by a naive clamp and corrupt all downstream calculations.
 * This returns the fallback value when v is not finite.
 */
function safeClamp(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/**
 * Generic state derivative function signature.
 * Takes current state + params, returns dState/dt.
 */
type DerivativeFn = (
  state: HemodynamicState,
  params: HemodynamicParams,
) => HemodynamicState;

/** All numeric keys in HemodynamicState that we integrate. */
const STATE_KEYS: (keyof HemodynamicState)[] = [
  'hr', 'svr', 'edv', 'emax', 'cvp', 'hrMod',
  'rvEmax', 'pvr', 'rvedv', 'qsQt', 'fiO2',
  'noTone', 'et1Tone',
  'lactate',
  'time',
];

/** Add two states element-wise: a + b. */
function addStates(
  a: HemodynamicState,
  b: HemodynamicState,
): HemodynamicState {
  const result = { ...a };
  for (const key of STATE_KEYS) {
    (result[key] as number) = (a[key] as number) + (b[key] as number);
  }
  return result;
}

/** Scale a state by a scalar: s × a. */
function scaleState(
  a: HemodynamicState,
  s: number,
): HemodynamicState {
  const result = { ...a };
  for (const key of STATE_KEYS) {
    (result[key] as number) = (a[key] as number) * s;
  }
  return result;
}

/**
 * 4th-order Runge-Kutta integrator.
 *
 * Advances the state by one timestep `dt` using the classical RK4 method.
 * More stable than Euler for the same step size, important when baroreflex
 * gains are high.
 */
export function rk4Step(
  state: HemodynamicState,
  params: HemodynamicParams,
  dt: number,
  derivFn: DerivativeFn,
): HemodynamicState {
  const k1 = derivFn(state, params);
  const k2 = derivFn(addStates(state, scaleState(k1, dt / 2)), params);
  const k3 = derivFn(addStates(state, scaleState(k2, dt / 2)), params);
  const k4 = derivFn(addStates(state, scaleState(k3, dt)), params);

  // weighted average: (k1 + 2*k2 + 2*k3 + k4) / 6
  const weighted = scaleState(
    addStates(
      addStates(k1, scaleState(k2, 2)),
      addStates(scaleState(k3, 2), k4),
    ),
    1 / 6,
  );

  return addStates(state, scaleState(weighted, dt));
}

/**
 * Clamp the effective (base + intervention overlay) state before passing to derive().
 * Interventions apply additive deltas without bounds checking, so stacked scenarios
 * (e.g. cor pulmonale + COPD + HPV) can push rvEmax or qsQt out of valid range,
 * causing negative contractility scaling or shunt fractions > 1.
 *
 * Uses the same param-based bounds as clampState so the two are consistent.
 */
export function clampEffective(
  state: HemodynamicState,
  params: HemodynamicParams,
): HemodynamicState {
  return {
    ...state,
    hr:      safeClamp(state.hr,      params.hrMin,    params.hrMax,    params.hrBaseline),
    svr:     safeClamp(state.svr,     params.svrMin,   params.svrMax,   params.svrBaseline),
    edv:     safeClamp(state.edv,     params.edvMin,   params.edvMax,   params.edvRef),
    emax:    safeClamp(state.emax,    0.05, 10, params.emaxRef),
    cvp:     safeClamp(state.cvp,     0,    30, 5),
    hrMod:   Number.isFinite(state.hrMod)   ? state.hrMod   : 0,
    rvEmax:  safeClamp(state.rvEmax,  0.05, 5,  params.rvEmaxRef),
    pvr:     safeClamp(state.pvr,     params.pvrMin,   params.pvrMax,   params.pvrRef),
    rvedv:   safeClamp(state.rvedv,   params.rvedvMin, params.rvedvMax, params.rvedvRef),
    qsQt:    safeClamp(state.qsQt,    0,    0.95, 0.02),
    fiO2:    safeClamp(state.fiO2,    0.21, 1.0,  0.21),
    noTone:  safeClamp(state.noTone,  0,    1.0,  0),
    et1Tone: safeClamp(state.et1Tone, 0,    1.0,  0),
    lactate: safeClamp(state.lactate, params.lactateMin, params.lactateMax, 1.0),
  };
}

/**
 * Clamp state variables to physiologic ranges defined in params.
 * Call after each integration step to prevent runaway values.
 */
export function clampState(
  state: HemodynamicState,
  params: HemodynamicParams,
): HemodynamicState {
  return {
    ...state,
    // Systemic
    hr:    safeClamp(state.hr,    params.hrMin,  params.hrMax,  params.hrBaseline),
    svr:   safeClamp(state.svr,   params.svrMin, params.svrMax, params.svrBaseline),
    edv:   safeClamp(state.edv,   params.edvMin, params.edvMax, params.edvRef),
    emax:  safeClamp(state.emax,  0.1, 10, params.emaxRef),
    cvp:   safeClamp(state.cvp,   0, 30, 5),
    hrMod: safeClamp(state.hrMod, 0, 100, 0),
    // Pulmonary
    rvEmax: safeClamp(state.rvEmax, 0.05, 5,  params.rvEmaxRef),
    pvr:    safeClamp(state.pvr,    params.pvrMin,   params.pvrMax,   params.pvrRef),
    rvedv:  safeClamp(state.rvedv,  params.rvedvMin, params.rvedvMax, params.rvedvRef),
    // Gas exchange
    qsQt:    safeClamp(state.qsQt,    0,    0.95, 0.02),
    fiO2:    safeClamp(state.fiO2,    0.21, 1.0,  0.21),
    // Vasoactive tones
    noTone:  safeClamp(state.noTone,  0, 1.0, 0),
    et1Tone: safeClamp(state.et1Tone, 0, 1.0, 0),
    // Acid-base
    lactate: safeClamp(state.lactate, params.lactateMin, params.lactateMax, 1.0),
  };
}
