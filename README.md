# Steady/State

A hospital night-shift game built on a real cardiovascular physiology engine.

You cover eight patients on a general medical ward from 19:00 to 07:00. You never
see any of them. You have a phone, a set of nurses who page you, and an order
entry system — and underneath it all, a coupled ODE model of the heart, lungs and
vasculature that decides what actually happens to each patient.

Nothing is scripted to an outcome. Illness scripts apply *mechanistic* insults —
preload loss, contractility loss, shunt, inflammatory tone — and the physiology
takes it from there. A patient treated at 20:10 and one treated at 21:30 receive
exactly the same insult and diverge on their own.

**Live:** [sim.jrlab.org](https://sim.jrlab.org)

---

## The game

```bash
npm install
npm run dev      # http://localhost:5173
```

Take the pager. The shift runs at 15–120× compression — twelve hours in six to
forty-eight minutes of real time, defaulting to 30× — and pauses whenever you like.

### What makes it hard

**Vitals go stale.** Floor observations are every four hours. Between them you are
reading history, and the patient board shows you how old each set is. Continuous
monitoring collapses that gap — for the patients you think to order it on.

**The nurse sees more than the chart does.** Asking how someone looks, whether
they are confused, or whether they are making urine costs nothing and is always
current. Perfusion and mentation degrade well before a cuff pressure declares
itself, so the players who ask find deterioration first.

**Orders take time.** Pharmacy verifies, nurses draw up, blood comes from the
bank. Antibiotics take hours to work. The clock that matters starts when you
decide, not when the drug lands.

**The floor has limits.** Vasoactive infusions and ventilators need an ICU bed,
and beds take time to arrange. Deciding to escalate is itself a treatment, and
frequently the one that decides the night.

**Most pages are not emergencies.** One patient asks for a sleeping tablet three
times. The cost of treating every page as a crisis is paid by the patient down
the hall — so the order set includes the ordinary night-float material (melatonin,
paracetamol, delirium precautions, a bowel regimen, resiting a cannula) alongside
the resuscitation drugs. Note that paracetamol lowers the *charted* temperature
without touching the sepsis underneath it.

### The ward

Eight patients, each built around one decision:

| Patient | Presents as | Actually |
|---|---|---|
| Whitfield, 78F | Pyelonephritis, improving | Urosepsis → septic shock |
| Brennan, 71M | COPD exacerbation | Decompensated heart failure — the admission diagnosis is wrong |
| Okonkwo, 54F | POD#2 knee replacement | Massive PE with RV failure |
| Castellanos, 63M | Stable GI bleed | Rebleeding ulcer → haemorrhagic shock |
| Penhale, 68M | COPD exacerbation | COPD exacerbation — the obvious answer is correct |
| Demir, 59M | Chest pain, troponins negative | Anterior STEMI → cardiogenic shock |
| Marsh, 84F | Aspiration pneumonia, DNR/DNI | Dying. The intervention is a goals-of-care conversation |
| Fitzgerald, 44F | Cellulitis, improving | Nothing. She just cannot sleep |

Because outcomes come from physiology rather than from a script, the traps are
real: a fluid bolus in Brennan raises his wedge, floods more alveoli, and drops
his saturation. Nothing special-cases it — that is simply what the model does.

At 07:00 you get a debrief: what was actually wrong with each patient, what you
ordered, how long you took from the moment they became unstable, and the teaching
point attached to the case that earned it.

---

## The physiology engine

The engine predates the game and is also usable on its own — the briefing screen
has a link to a test bench where you can drive a single patient, apply scenarios
and treatments, and watch the traces.

### Systemic circuit
- Frank-Starling curve with ascending (Michaelis-Menten) and descending (overdistension) limbs
- LV contractility (Emax), preload (EDV), afterload (SVR), CVP
- Baroreflex: first-order HR and SVR regulation defending a MAP setpoint
- Afterload-sensitive SV via an ESPVR constraint

### Pulmonary circuit
- RV Frank-Starling with its own Emax and RVEDV — RV failure is modelled independently of LV
- PCWP from the LV EDPVR — rises with volume overload or systolic failure
- mPAP = RVCO × PVR + PCWP, supporting all four PH classes
- **RV-LV interdependence**: RVEDV dilation bows the septum leftward (the D-sign), reducing LV filling
- **Series-circulation constraint**: sustained LV output cannot exceed RV output, so a failed RV brings the whole circulation down with it

### Gas exchange
- Two-compartment shunt model (Riley) with a Hill dissociation curve
- Fick-based SvO2, so low output amplifies the shunt effect
- **Hydrostatic pulmonary oedema → shunt**: once PCWP exceeds plasma oncotic pressure, alveoli flood and become true shunt. This is what makes cardiogenic pulmonary oedema hypoxaemic, why oxygen alone barely helps, and why preload reduction fixes the saturation
- Low-flow pulmonary hypoperfusion as an effective shunt

### Vasoactive mediators
Instantaneous reflexes (HPV, hypoxic vasodilation) plus ODE-integrated mediator
tones (NO/PGI2, endothelin-1) that couple pulmonary hypertension and hypoxaemia
back into systemic haemodynamics.

### Reflex control
The baroreflex regulates the patient's own intrinsic tone, so drug effects add on
top of it rather than inside the loop. Vasopressors are therefore partially
opposed — `delta / (1 + gainSvr × CO)` survives — and reflex bradycardia on a pure
α1 agonist emerges rather than being scripted.

### Acid-base
Lactate as a first-order ODE driven by oxygen delivery, perfusion pressure, and
inflammatory tone, feeding pH → myocardial depression, vasoplegia, and SA-node
suppression. This is the failure spiral, and it is what makes late recognition
qualitatively different from early recognition rather than merely worse.

---

## Architecture

```
src/engine/          Physiology. Pure functions, no UI, no game concepts.
  types.ts           HemodynamicState, HemodynamicParams, DerivedValues, Intervention
  constants.ts       DEFAULT_PARAMS / DEFAULT_STATE (healthy 70 kg adult at rest)
  frank-starling.ts  Generic Starling curve + LV/RV wrappers
  baroreflex.ts      First-order HR/SVR regulation
  pulmonary.ts       PCWP, RV output, mPAP, TPG
  oxygenation.ts     Alveolar gas equation, Hill curve, Fick SvO2, shunt mixing
  vasoactive.ts      Layer A reflexes + Layer B mediator ODE targets
  hemodynamics.ts    derive() pipeline, derivative(), intervention overlay
  solver.ts          RK4 integrator, clamps
  patient.ts         Gaussian patient sampling

src/game/            The night shift.
  physics.ts         stepPhysics() — one patient, one timestep (shared by bench and ward)
  shift.ts           ShiftEngine: owns every patient, every channel, every outcome
  cases.ts           The eight patients and their illness scripts
  orders.ts          Order catalogue with lead times and ICU gating
  clinical.ts        Physiology → charted vitals, labs, imaging, gestalt
  nurse.ts           Nurse replies and escalation thresholds
  consults.ts        Attending and specialty advice, reasoned from live physiology
  scoring.ts         End-of-shift debrief

src/ui/              React components for the shift.
src/bench/           The original single-patient engine test bench.
```

### Key invariants

**Interventions are a read-only overlay.** ODE integration uses the effective
state (base + interventions) to compute targets, but integrates only the base
state. Deltas never compound, and when a drug wears off the patient returns to
their intrinsic physiology.

**The engine knows nothing about the game.** No case, order, or nurse concept
appears in `src/engine`. The game layer observes physiology and applies
interventions; it never reaches in to set an outcome.

**True state and observed state are separate.** `runtime.state` is what is
happening; `runtime.lastVitals` is what the player knows. Only monitoring closes
the gap. The UI renders the observed state and never leaks the true one.

---

## Development

```bash
npm run dev      # dev server
npm test         # 244 unit tests (Vitest)
npm run lint
npm run build    # production build → dist/
```

Deployed via Cloudflare Pages — every push to `main` triggers a rebuild.

---

## Status

A research and education prototype. The physiology is modelled at the level of
detail appropriate for teaching haemodynamic reasoning to students and residents.
It is not a validated clinical decision support tool, and the drug kinetics in
particular are deliberately simplified.
