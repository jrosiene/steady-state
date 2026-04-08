import type { HemodynamicParams, HemodynamicState } from './types';

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
    hr:     Math.min(params.hrMax,    Math.max(params.hrMin,    state.hr)),
    svr:    Math.min(params.svrMax,   Math.max(params.svrMin,   state.svr)),
    edv:    Math.min(params.edvMax,   Math.max(params.edvMin,   state.edv)),
    emax:   Math.max(0.05,  state.emax),
    cvp:    Math.max(0,     state.cvp),
    hrMod:  state.hrMod,
    rvEmax: Math.max(0.05,  state.rvEmax),
    pvr:    Math.min(params.pvrMax,   Math.max(params.pvrMin,   state.pvr)),
    rvedv:  Math.min(params.rvedvMax, Math.max(params.rvedvMin, state.rvedv)),
    qsQt:    Math.min(0.95,  Math.max(0,    state.qsQt)),
    fiO2:    Math.min(1.0,   Math.max(0.21, state.fiO2)),
    noTone:  Math.min(1.0,   Math.max(0,    state.noTone)),
    et1Tone: Math.min(1.0,   Math.max(0,    state.et1Tone)),
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
    hr:    Math.min(params.hrMax,  Math.max(params.hrMin,  state.hr)),
    svr:   Math.min(params.svrMax, Math.max(params.svrMin, state.svr)),
    edv:   Math.min(params.edvMax, Math.max(params.edvMin, state.edv)),
    emax:  Math.max(0.1, state.emax),
    cvp:   Math.max(0, state.cvp),
    hrMod: Math.max(0, state.hrMod),
    // Pulmonary
    rvEmax: Math.max(0.05, state.rvEmax),
    pvr:    Math.min(params.pvrMax,   Math.max(params.pvrMin,   state.pvr)),
    rvedv:  Math.min(params.rvedvMax, Math.max(params.rvedvMin, state.rvedv)),
    // Gas exchange
    qsQt:    Math.min(0.95, Math.max(0,    state.qsQt)),
    fiO2:    Math.min(1.0,  Math.max(0.21, state.fiO2)),
    // Vasoactive tones
    noTone:  Math.min(1.0,  Math.max(0,    state.noTone)),
    et1Tone: Math.min(1.0,  Math.max(0,    state.et1Tone)),
  };
}
