import type { HemodynamicState, HemodynamicParams, Intervention } from '../engine/types';
import { applyInterventions, overlayDerivative } from '../engine/hemodynamics';
import { rk4Step, clampState, clampEffective } from '../engine/solver';

/**
 * Fixed physics timestep in sim-seconds for the single-patient test bench.
 *
 * 50ms is safe with RK4 for all ODE time constants in this model:
 *   - Fastest: tauHr = 3s → dt/τ = 0.017; RK4 error ≈ O((dt/τ)⁴) ≈ 8×10⁻⁸ per step
 *   - Baroreflex, mediator tones (tauNoTone=300s, tauEt1=600s) are even more stable
 */
export const PHYSICS_DT = 0.05;

/**
 * Coarser timestep used by the shift engine, which integrates many patients
 * concurrently at high time compression.
 *
 * At dt=0.25 the fastest time constant (tauHr = 3s) gives dt/τ = 0.083, so RK4
 * local error is still ≈ O((dt/τ)⁴) ≈ 5×10⁻⁵ per step — far below the resolution
 * of anything the UI displays. The 5× step reduction is what makes simulating a
 * full ward at 120× wall-clock compression affordable.
 */
export const WARD_PHYSICS_DT = 0.25;

/**
 * Advance one patient's hemodynamic state by a single fixed timestep.
 *
 * Key invariant: interventions are a READ-ONLY OVERLAY on the base state. ODE
 * targets are computed from the EFFECTIVE state (base + interventions) so
 * feedback loops see the full clinical picture, but only the BASE state is
 * integrated, so intervention deltas never compound across steps. The
 * derivative itself lives in the engine (`overlayDerivative`) — this is only
 * the glue that applies overlays and integrates.
 */
export function stepPhysics(
  base: HemodynamicState,
  params: HemodynamicParams,
  interventions: Intervention[],
  dt: number,
): HemodynamicState {
  const derivWithOverlay = (state: HemodynamicState, p: HemodynamicParams): HemodynamicState =>
    overlayDerivative(state, clampEffective(applyInterventions(state, interventions), p), p);

  return clampState(rk4Step(base, params, dt, derivWithOverlay), params);
}
