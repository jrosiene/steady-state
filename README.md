# Steady/State

A real-time cardiovascular physiology simulator built for medical education. Models the heart, lungs, and vasculature as a coupled ODE system, rendered in an EMR-style interface where you can apply clinical scenarios and treatments and watch the physiology respond over time.

**Live:** [sim.jrlab.org](https://sim.jrlab.org)

---

## What it simulates

### Systemic circuit
- Frank-Starling curve with ascending (Michaelis-Menten) and descending (overdistension) limbs
- LV contractility (Emax), preload (EDV), afterload (SVR), CVP
- Baroreflex: first-order HR and SVR regulation defending a MAP setpoint
- Direct chronotropy (β1 agonists shift HR target; phenylephrine reflex brady is emergent)

### Pulmonary circuit
- RV Frank-Starling (separate Emax, RVEDV) — RV failure modeled independently of LV
- PCWP from LV EDPVR — rises with volume overload or systolic failure
- mPAP = RVCO × PVR + PCWP — supports all four PH classes:
  - Class I (PAH): PVR↑ with normal PCWP
  - Class II (LV failure): PCWP↑ → mPAP↑
  - Class III (hypoxic HPV): V/Q mismatch → SpO2↓ → PVR↑
  - Class IV (CTEPH): fixed mechanical PVR↑
- **RV-LV ventricular interdependence**: RVEDV dilation above threshold bows the septum leftward, reducing effective LV filling (the D-sign) → CO↓ → MAP↓ even with preserved SVR

### Gas exchange
- Two-compartment shunt model (Riley): SpO2 = SaO2_ideal × (1−Qs/Qt) + SvO2 × Qs/Qt
- Hill oxygen-hemoglobin dissociation curve (P50 = 26.8 mmHg, n = 2.7)
- Fick-based SvO2: falls when CO drops, amplifying shunt effect in low-output states
- Teaching property preserved: large shunt barely responds to supplemental O2

### Vasoactive mediator layer
Instantaneous reflexes and ODE-integrated mediator tones that couple pulmonary hypertension and hypoxemia back to systemic hemodynamics:

| Mechanism | Trigger | Effect |
|---|---|---|
| HPV (Layer A) | SpO2 < 93% | PVR↑ — lung shunts blood away from hypoxic units |
| Hypoxic vasodilation (Layer A) | SpO2 < 90% | SVR↓ — peripheral tissue adenosine/NO |
| RV-LV interdependence (Layer A) | RVEDV > 195 mL | Effective EDV↓ → SV↓ → MAP↓ |
| NO/PGI2 tone (Layer B ODE) | SpO2↓, inflammation | SVR↓, Emax↓, mild PVR↓ — septic physiology |
| ET-1 tone (Layer B ODE) | mPAP > 18 mmHg | PVR↑↑, mild SVR↑ — self-amplifying PH loop |
| RVEDV afterload dilation (ODE) | PVR↑ | RVEDV target rises → septal shift develops |

### Patient variability
Each "New Patient" samples physiologic parameters (MAP setpoint, HR baseline, SVR, Emax, PVR, Hgb, etc.) from Gaussian distributions with physiologically calibrated coefficients of variation, producing a realistic population spread.

---

## Clinical scenarios

| Scenario | Primary mechanism |
|---|---|
| Hemorrhage (Class II/IV) | EDV↓ → CO↓ → baroreflex compensation |
| Septic shock | noTone↑ (NO/PGI2) → SVR↓ + Emax↓ + third-spacing |
| Cardiogenic shock (acute MI) | Emax↓ → PCWP↑ + CO↓ |
| Tension pneumothorax | EDV↓ + CVP↑ (obstructive physiology) |
| PAH (Class I) | PVR↑ → ET-1 tone → self-amplifying PVR loop |
| LV failure / PVH (Class II) | Emax↓ → PCWP↑ → mPAP↑ |
| Hypoxic PH (Class III) | Qs/Qt↑ → SpO2↓ → HPV → PVR↑ |
| CTEPH (Class IV) | Fixed mechanical PVR↑ |
| COPD stable / exacerbation | V/Q mismatch → chronic HPV → cor pulmonale trajectory |
| Massive PE | Acute PVR↑ → RV afterload crisis → septal shift → MAP↓ |
| Acute decompensated LV HF | Emax↓ + volume overload → PCWP↑ + pulmonary edema |
| Cor pulmonale | PVR↑ → RVEDV dilation → RVLV interdependence → MAP↓ |
| Biventricular failure | Both ventricles failing simultaneously |

## Treatments

Norepinephrine, Epinephrine, Dobutamine, Phenylephrine, Vasopressin, Fluid bolus, Needle decompression, Supplemental O2, Inhaled NO, Sildenafil (PDE5i), Bosentan (ET-1 antagonist), Methylprednisolone — each with physiologically modeled receptor profiles, onset/offset kinetics, and mechanistic effects on the vasoactive tone layer.

---

## Architecture

```
src/engine/
  types.ts          — HemodynamicState, HemodynamicParams, DerivedValues, Intervention
  constants.ts      — DEFAULT_PARAMS and DEFAULT_STATE (healthy 70 kg adult at rest)
  frank-starling.ts — Generic Starling curve + LV/RV wrappers
  baroreflex.ts     — First-order HR/SVR regulation
  pulmonary.ts      — PCWP, RV output, mPAP, TPG
  oxygenation.ts    — Alveolar gas equation, Hill curve, Fick SvO2, shunt mixing
  vasoactive.ts     — Layer A reflexes + Layer B ODE targets
  hemodynamics.ts   — derive() two-pass pipeline, derivative(), interventionEffect()
  solver.ts         — RK4 integrator, clampState, clampEffective
  patient.ts        — Gaussian patient sampling

src/game/
  clock.ts          — Wall-time → sim-time with configurable compression (1x–300x)
  loop.ts           — requestAnimationFrame loop, fixed 50ms physics timestep
```

### ODE system

The simulator integrates 14 state variables with RK4 at a 50ms timestep:

| Variable | Dynamics |
|---|---|
| `hr` | Baroreflex (tauHr ≈ 3s) |
| `svr` | Baroreflex (tauSvr ≈ 8s) |
| `noTone` | Hypoxia + inflammation → NO/PGI2 buildup (tau ≈ 5 min) |
| `et1Tone` | mPAP↑ → ET-1 synthesis (tau ≈ 10 min, self-amplifying) |
| `rvedv` | RV afterload dilation (tau ≈ 2 min) |
| All others | Driven by intervention overlays (derivative = 0) |

Interventions are a **read-only overlay** on base state — never baked in. This ensures intervention deltas don't compound across physics steps while still feeding into all feedback loops (baroreflex, HPV, mediator ODEs).

---

## Development

```bash
npm install
npm run dev      # local dev server at http://localhost:5173
npm test         # 133 unit tests (Vitest)
npm run build    # production build → dist/
```

Deployed via Cloudflare Pages — every push to `main` triggers a rebuild.

---

## Status

This is a research/education prototype. The physiology is modeled at the level of detail appropriate for teaching hemodynamic reasoning to medical students and residents — not a validated clinical decision support tool.
