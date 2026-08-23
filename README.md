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

**The handoff is uneven.** Each patient comes with a written sign-out in the
shape a real one takes — a one-liner, the jobs left for overnight, and "if this
happens, do that" — and they vary from thorough to almost nothing. Empty sections
are shown as empty, because a missing contingency plan is information. The fullest
handoff on the ward is on the patient who needs it least; two of the thinnest are
on people who die if you leave them. You can re-read any of them from the chart.

**Most pages are not emergencies.** One patient asks for a sleeping tablet three
times. The cost of treating every page as a crisis is paid by the patient down
the hall — so the order set includes the ordinary night-float material (melatonin,
paracetamol, delirium precautions, a bowel regimen, resiting a cannula) alongside
the resuscitation drugs. Note that paracetamol lowers the *charted* temperature
without touching the sepsis underneath it.

### The ward is dealt, not written

Every shift is generated from a seed. Patients are drawn from a library of
**case archetypes** — the clinical content — and then assigned names, ages,
pronouns, rooms and nurses sampled independently. A name carries no clinical
information, so a returning player has to read the patient in front of them
rather than recall what a given name did last time.

| Archetype | Presents as | Actually |
|---|---|---|
| `urosepsis` | Pyelonephritis, improving | Urosepsis → septic shock |
| `pneumonia-sepsis` | Community-acquired pneumonia | Sepsis with a widening shunt |
| `adhf-mislabelled` | COPD exacerbation | Decompensated heart failure — the diagnosis is wrong |
| `pulmonary-embolism` | Routine post-op day 2 | Massive PE with RV failure |
| `gi-bleed` | Stable GI bleed | Rebleeding ulcer → haemorrhagic shock |
| `acs-cardiogenic` | Chest pain, troponins negative | Anterior STEMI → cardiogenic shock |
| `copd-exacerbation` | COPD exacerbation | COPD exacerbation — the obvious answer is right |
| `hypovolaemia` | Poor intake, AKI | Dry. A bolus fixes it |
| `end-of-life-pneumonia` | Aspiration pneumonia, DNR/DNI | Dying. The intervention is a conversation |
| `benign-cellulitis`, `benign-post-op-pain` | Improving | Nothing is wrong |

Each ward draws three critical cases, three ward-level ones and two benign, and
staggers when they declare so problems arrive in sequence rather than all at once.
Because `adhf-mislabelled` and `copd-exacerbation` are both admitted as "COPD
exacerbation", a ward can hold two of them — and telling which is which is the
whole job.

### Severity

Every case is dealt at **mild**, **moderate** or **severe**, which changes both
the starting physiology and the size of the insult. Severity raises the ceiling
on how bad things get; it deliberately does *not* shorten the window in which the
player can act, because scaling magnitude and speed together produces cases that
test reaction time rather than reasoning.

What it does change is the *management*. A mild decompensation forgives a slow,
adequate response. A severe one needs escalation and an inotrope, not just a
diuretic — the correct answer is different, not merely more urgent.

These are admitted acute-care patients, already triaged to a general ward, so
severity never shows up as someone visibly peri-arrest at sign-out. Their 19:00
observations look like observations a day team would have been willing to leave
on the floor — which is exactly why the deterioration is a surprise, and why the
charted numbers are worth so little on their own. Some severe physiology is also
simply not correctable, and the game does not pretend otherwise; what it avoids
is a case lost before the player could act.

### Codes

An arrest starts a real resuscitation rather than a coin flip. The critical care
team run ACLS in two-minute cycles — rhythm checks, an airway, adrenaline,
defibrillation where the rhythm is shockable — for up to sixteen minutes, and the
messages report it as it happens.

The rhythm follows from how the patient got there: a primary pump failure
fibrillates, a bleeding or obstructed patient arrests in PEA, and one who has been
profoundly acidotic for an hour arrests in asystole. Return of circulation is
rolled per cycle from the things that actually move in-hospital arrest survival —
whether it was witnessed, whether the rhythm is shockable, whether the reversible
cause is being treated, and how acidotic the myocardium already is — decaying with
each failed cycle.

The resulting rates land about where the real ones do:

| Preparation | ROSC |
|---|---|
| Unwitnessed, cause untreated | ~15% |
| Monitored, cause untreated | ~30–45% |
| Monitored, cause being treated | ~60% |

Every one of those differences was decided hours before the pulse was lost. ROSC
puts the patient in the ICU, intubated and on noradrenaline, with a stunned
myocardium and an oxygen debt — and whatever caused the arrest still running
underneath. A team who restore circulation twice and lose it again within minutes
stop, because at that point the problem is the physiology and not the effort.

The clearest result from calibrating it: with the cause properly treated, most
patients never arrest at all.

Because outcomes come from physiology rather than from a script, the traps are
real: a fluid bolus in the mislabelled heart failure patient raises the wedge,
floods more alveoli, and drops the saturation. Nothing special-cases it — that is
simply what the model does.

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
  orders.ts          Order catalogue with lead times and ICU gating
  clinical.ts        Physiology → charted vitals, labs, imaging, gestalt
  nurse.ts           Nurse replies and escalation thresholds
  consults.ts        Attending and specialty advice, reasoned from live physiology
  scoring.ts         End-of-shift debrief
  testing.ts         Reference helpers for addressing generated content

src/game/content/    Ward generation.
  archetypes.ts      The clinical library, written against no particular patient
  demographics.ts    Names, ages, rooms, nurses — sampled independently
  severity.ts        How hard a case bites tonight
  voice.ts           Pronouns and verb agreement for generated prose
  rng.ts             Seeded PRNG — a shift is fully determined by its seed
  generate.ts        Composes a balanced ward from a seed

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

**Content is addressed by archetype, never by name.** Patient names, ages and
rooms are sampled per shift, so nothing durable can refer to them. Tests,
calibration runs and the debrief all address a case by `archetypeId` and
`severity`, and express timing relative to `declaresAt` rather than to a
wall-clock time that moves with the seed. `src/game/testing.ts` provides the
helpers — `soloShift`, `advanceToDeclaration`, `findByArchetype` — that make a
generated ward testable.

**Every shift is reproducible.** The seed is shown on the briefing and in the top
bar during play. The same seed always deals the same eight patients, at the same
severities, declaring at the same times.

---

## Development

```bash
npm run dev      # dev server
npm test         # 274 unit tests (Vitest)
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
