# Steady/State

A hospital night-shift game built on a real cardiovascular physiology engine.

You cover a list of patients from 19:00 to 07:00 — eight on a single ward, or up
to forty spread across several floors, on a community service or at a quaternary
academic centre. You never see any of them. You have a
phone, a set of nurses who page you, and an order entry system — and underneath
it all, a coupled ODE model of the heart, lungs and vasculature that decides what
actually happens to each patient.

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

**Vitals go stale.** Floor observations are every four hours — forty minutes once
a nurse has rung about someone. Between them you are reading history, and the
patient board shows you how old each set is. Continuous monitoring collapses that
gap, for the patients you think to order it on.

**Community or academic.** A community hospital and a quaternary centre see
genuinely different patients, and the academic ones are not harder versions of
the community ones — they are different diseases with different physiology and
different traps. The academic list carries pulmonary arterial hypertension,
high-MELD cirrhosis with spontaneous bacterial peritonitis, febrile neutropenia
after stem cell transplant, sickle cell acute chest syndrome, cystic fibrosis and
necrotising pancreatitis. In each of them the reflex that is correct for the
community case is wrong: fluid for the failing right ventricle, phenylephrine for
the pulmonary hypertensive, antibiotics for the sterile necrosis, a normal
saturation target for the patient who lives at 91%.

**You inherit what the day team was doing.** Every patient carries their active
medications and the results already drawn — the afternoon venous gas on the COPD
patient, the sputum sensitivities behind the antibiotic that is running, this
morning's neutrophil count, the tacrolimus level. None of it is simulated; it is
recorded history, because the reason a covering doctor reads the afternoon gas is
precisely that they were not there for it.

**Tachycardia comes before hypotension.** The model carries both limbs of the
reflex — the arterial baroreceptors that sense pressure and the cardiopulmonary
receptors that sense filling. A patient who is losing volume speeds up while
their blood pressure is still normal, which is the earliest sign there is and the
reason a compensated patient can look fine on a cuff reading right up until they
do not. Diastole shortens as the rate climbs, so tachycardia stops rescuing
cardiac output past a point — that is the mechanism by which compensated shock
becomes uncompensated.

**The right ventricle ejects against a pressure.** RV output is afterload
sensitive, the mirror of the left ventricle's ESPVR constraint, and pulmonary
artery pressure is driven by the flow that actually crosses the lung rather than
by the right ventricle's isolated pumping capacity. A hypertrophied RV tolerates
a mean pressure that stops a normal one, which is why a chronic patient walks
around at 55 mmHg and an acute embolus at 40 mmHg is in shock — and why
pulmonary vasodilators raise cardiac output rather than lowering blood pressure.

**Studies show what is wrong with the patient.** An infarct puts ST elevation on
the EKG, a pneumothorax appears on the chest film and grows on the next one, a
pneumonia is reported against the admission comparison. All of it is gated on the
physiology rather than on the hidden diagnosis, so a study ordered before the
event is genuinely, informatively normal.

**Nothing on a ward is instant.** Asking for a set of observations sends someone
to the bedside with a cuff, and the numbers arrive when they get back. The nurse
acknowledges an order a beat after you place it, not in the same frame. Both
delays are small; both exist so that asking never reads as free.

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

**Critical** — can kill within the shift:

| Archetype | Presents as | Actually |
|---|---|---|
| `urosepsis` | Pyelonephritis, improving | Urosepsis → septic shock |
| `pneumonia-sepsis` | Community-acquired pneumonia | Sepsis with a widening shunt |
| `adhf-mislabelled` | COPD exacerbation | Decompensated heart failure — the diagnosis is wrong |
| `pulmonary-embolism` | Routine post-op day 2 | Massive PE with RV failure |
| `gi-bleed` | Stable GI bleed | Rebleeding ulcer → haemorrhagic shock |
| `acs-cardiogenic` | Chest pain, troponins negative | Anterior STEMI → cardiogenic shock |

**Ward-level** — serious, and usually fixable:

| Archetype | Presents as | Actually |
|---|---|---|
| `copd-exacerbation` | COPD exacerbation | COPD exacerbation — the obvious answer is right |
| `hypovolaemia` | Poor intake, AKI | Dry. A bolus fixes it |
| `pneumothorax` | Pleural effusion, drained today | Post-procedural pneumothorax, enlarging |
| `aspiration-event` | Stroke with dysphagia | Witnessed aspiration → chemical pneumonitis |
| `end-of-life-pneumonia` | Aspiration pneumonia, DNR/DNI | Dying. The intervention is a conversation |

**Benign** — nothing is wrong, and the pages keep coming:

| Archetype | Presents as | Actually |
|---|---|---|
| `benign-cellulitis` | Cellulitis, improving | Cannot sleep |
| `benign-post-op-pain` | Day 1 post-op | Nausea, wind pain, constipation |
| `benign-sundowning` | Pneumonia, improving | Sundowning — looks like early sepsis, is not |
| `benign-anxiety` | Chest pain, workup negative | Anxiety. The workup is done and it was negative |

**Academic service only** — the patients a community hospital transfers out:

| Archetype | Presents as | Actually |
|---|---|---|
| `pah-rv-failure` | Group 1 PAH, volume overload | RV failure. Fluid makes it worse; phenylephrine makes it worse. Rare — a right ventricle failing for the first time overnight is a night you remember |
| `variceal-bleed` | Cirrhosis, banded varices | Rebleeding varices. Octreotide and antibiotics, and transfuse to 7 — more blood raises portal pressure |
| `neutropenic-sepsis` | Day +8 transplant, neutropenic fever | Gram-negative bacteraemia. No pus, no infiltrate, no time |
| `sickle-acute-chest` | Sickle cell crisis | Acute chest syndrome — caused partly by treating the pain too cautiously |
| `necrotising-pancreatitis` | Severe acute pancreatitis | Capillary leak and ARDS. Fluid, not antibiotics |
| `cirrhosis-sbp` | Decompensated cirrhosis, AKI | Spontaneous bacterial peritonitis. Subacute: it costs kidneys over days, not a pressure tonight. Antibiotics and albumin overnight; the tap can wait for the day team |
| `hepatic-encephalopathy` | Cirrhosis, confused | A symptom with a cause. Find the precipitant, and do not sedate a confused cirrhotic |
| `sickle-vaso-occlusive` | Sickle cell crisis | A crisis that stays a crisis. The harm available is under-treating the pain |
| `cf-exacerbation` | CF pulmonary exacerbation | CF exacerbation. The trap is their baseline, not their trajectory |

A ward staggers when its cases declare so problems arrive in sequence rather than
all at once.
Because `adhf-mislabelled` and `copd-exacerbation` are both admitted as "COPD
exacerbation", a ward can hold two of them — and telling which is which is the
whole job.

### Severity is continuous

Severity is a number in [0, 1], not a bucket — 0 is the mildest form of the
illness that still warrants a page, 1 is as bad as this case gets, and everything
between is real. Archetypes state what the case looks like at each end and the
generator interpolates. Holding the seed fixed and walking severity gives a clean
gradient: a urosepsis that survives the night at 0.2, dies at 05:00 if ignored at
0.6, and dies by 01:00 at 1.0.

Each *axis* of a case also draws its own value around the case severity, so a
sepsis can present with marked vasoplegia and modest third-spacing, or the
reverse. Two patients at the same overall severity are not the same patient.

Severity raises the ceiling on how bad things get; it deliberately does *not*
shorten the window in which the player can act, because scaling magnitude and
speed together produces cases that test reaction time rather than reasoning. What
it changes is the *management* — a mild decompensation forgives a slow, adequate
response; a severe one needs escalation and an inotrope, not just a diuretic.

### Comorbidities

Nine background conditions, sampled one or two per patient and orthogonal to
whatever is acutely wrong. Each is a real physiologic modifier and a real clinical
trap rather than a stat adjustment — a beta-blocked patient never mounts the
tachycardia that normally announces a bleed, a patient with pulmonary
hypertension has far less right ventricle in reserve when it is loaded, and
long-standing hypertension means the "normal" blood pressure that reassures you
is already a large fall for them. They appear in the past medical history, so the
information is always available to a player who reads the chart.

### How much variety

| Axis | Depth |
|---|---|
| Archetypes | 15 — 6 critical, 5 ward, 4 benign |
| Severity | continuous, with per-insult variation of ±0.16 around it |
| Comorbidities | 9, zero to two per patient |
| Distinct archetype combinations | ~190 per 200 generated wards |

On top of that: names, ages, pronouns, rooms, nurses, allergies, histories,
handoff quality and author, and declaration times all vary per shift.

These are admitted acute-care patients, already triaged to a general ward, so
severity never shows up as someone visibly peri-arrest at sign-out. Their 19:00
observations look like observations a day team would have been willing to leave
on the floor — which is exactly why the deterioration is a surprise, and why the
charted numbers are worth so little on their own. The exception is the patient on
comfort measures: a low blood pressure at the end of life is not a triage failure,
it is where that patient belongs.

Some severe physiology is also simply not correctable, and the game does not
pretend otherwise; what it avoids is a case lost before the player could act.

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
  modifiers.ts       Comorbidities — background physiology, orthogonal to the case
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
bar during play. The same seed and list size always deal the same patients, at
the same severities, declaring at the same times.

**Escalation is graded.** Every ladder has middle rungs, because most of a night
is spent between doing nothing and doing everything: a 250 mL fluid challenge you
reassess before committing; high-flow nasal oxygen between a mask and BiPAP; a
step-down bed between the ward and the unit; quetiapine between non-pharmacologic
delirium care and haloperidol; a named antibiotic instead of reaching for
vancomycin and piperacillin–tazobactam every time. Spectrum is modelled one way,
so a broader drug is credited for a narrower expectation and never the reverse.

**Comfort care is the end of a conversation.** You cannot write it before calling
the family — the nurse refuses, and says why. Goals of care is its own order, and
on the dying patient it is what the case is scored on.

**You can stop what the day team started.** Holding the beta-blocker in a patient
who needs their rate, or the diuretics and nephrotoxics in one whose kidneys are
being asked too much of, is a real overnight action — and one that only became
possible when the medication list started being handed over. Held drugs stay on
the chart, struck through, because the morning team needs to read what changed.

**How sick the ward is, is a slider.** It moves the centre of the severity
distribution without touching the spread and without changing which diagnoses are
on the list — so a quiet night is the same diseases caught earlier and milder, and
can still hold one patient who is genuinely unwell. A difficulty setting that
removed the variance would remove the triage.

**The acuity mix is not shown.** The list size is a choice; what is on the list
is not. Telling the player that three of their eight can kill them turns the first
hour into arithmetic instead of triage.

**Acuity does not scale with the list.** `composition(size)` grows the critical
and ward tiers sub-linearly, so covering forty is not five times as many people
dying — it is the same handful of real problems buried in five times the noise.
On a long list a proportion of the benign patients never page at all, because a
board where everyone calls teaches the player to work a queue rather than to
triage a list. Only benign cases fall silent; a real problem always declares
itself.

---

## Development

```bash
npm run dev      # dev server
npm test         # 284 unit tests (Vitest)
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
