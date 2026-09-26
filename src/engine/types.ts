/**
 * Core hemodynamic state — the minimal set of variables that define
 * the cardiovascular system at any point in time.
 *
 * Convention: SI-adjacent clinical units throughout.
 *   Pressures: mmHg
 *   Volumes: mL
 *   Flows: L/min
 *   Resistance: Wood units (mmHg·min/L)
 *   Time: seconds (sim-time)
 *   Rates: bpm (HR)
 */

/**
 * Cardiovascular failure status — derived each tick from MAP, CO, and pH.
 * Used by the game loop to trigger scenario outcomes and failure modes.
 */
export type CardiovascularStatus = 'compensated' | 'shock' | 'decompensating' | 'arrest';

/** Dynamic state variables — these change over time via the ODE system. */
export interface HemodynamicState {
  // --- Systemic circuit ---
  /** Heart rate (bpm). Driven by baroreflex. */
  hr: number;
  /** Systemic vascular resistance (Wood units). Driven by baroreflex. */
  svr: number;
  /** LV end-diastolic volume (mL). Modified by fluid status / venous return. */
  edv: number;
  /** LV maximal elastance — contractility index (normalized). */
  emax: number;
  /** Central venous pressure (mmHg). */
  cvp: number;
  /** Pharmacologic HR offset (bpm). β1 agonists shift baroreflex HR target. */
  hrMod: number;

  // --- Pulmonary circuit ---
  /** RV maximal elastance (normalized). Separate from LV — models RV failure independently. */
  rvEmax: number;
  /** Pulmonary vascular resistance (Wood units). Core variable for PH classification. */
  pvr: number;
  /** RV end-diastolic volume (mL). */
  rvedv: number;

  // --- Gas exchange ---
  /** Intrapulmonary shunt fraction (Qs/Qt, 0–1). Modified by V/Q mismatch scenarios. */
  qsQt: number;
  /** Inspired O2 fraction (0.21–1.0). Modified by supplemental O2 intervention. */
  fiO2: number;

  // --- Vasoactive mediator tones (Layer B) ---
  /**
   * NO/PGI2-like mediator tone (0–1).
   * Rises with hypoxemia (iNOS activation) and inflammation (sepsis).
   * Effects: SVR↓, mild PVR↓, mild Emax↓ (myocardial depression).
   */
  noTone: number;
  /**
   * Endothelin-1-like mediator tone (0–1).
   * Rises with elevated mPAP (endothelial shear/stretch → ET-1 synthesis).
   * Self-amplifying: ET-1 raises PVR → mPAP↑ → more ET-1.
   * Effects: PVR↑↑, mild SVR↑.
   */
  et1Tone: number;

  /**
   * Blood lactate (mmol/L). First-order ODE driven by SvO2 deficit.
   * Rises when oxygen delivery is insufficient (anaerobic threshold ~SvO2 < 0.65).
   * Clears slowly via hepatic metabolism when perfusion is restored.
   * Feeds back into pH → acidosis-driven myocardial depression → failure spiral.
   */
  lactate: number;

  // --- Ventilation ---
  /**
   * Arterial PCO2 (mmHg). Integrated from a CO2 mass balance: metabolic
   * production in, alveolar ventilation out. See ventilation.ts.
   */
  paCO2: number;
  /**
   * Depression of the ventilatory controller, 0–1. Opioids, benzodiazepines,
   * sedation. Scales the whole chemoreflex — including its response to CO2,
   * which is why an overdose retains rather than merely breathing a little less.
   * Driven by intervention overlays (derivative = 0).
   */
  ventDepression: number;
  /**
   * Alveolar dead-space fraction from disease (0–1): ventilated lung that is not
   * perfused, or is so over-ventilated relative to its perfusion that the extra
   * air is wasted. Emphysema, bronchospasm with gas trapping, PE.
   * Driven by overlays and baseline (derivative = 0).
   */
  deadSpace: number;
  /**
   * Ventilatory support, 0 (spontaneous) to 1 (controlled mechanical
   * ventilation). NIV sits between. Adds capacity and shields the controller
   * from sedation. Driven by overlays (derivative = 0).
   */
  ventSupport: number;
  /**
   * Respiratory muscle fatigue, 0 (fresh) to 1 (exhausted). ODE: rises when the
   * patient's own breathing load stays above what the diaphragm can sustain, and
   * recovers slowly with rest or ventilatory support. Scales capacity down —
   * the positive feedback by which a patient working hard to breathe tires.
   */
  respFatigue: number;

  // --- Rhythm (see rhythm.ts) ---
  /**
   * Atrial fibrillation, 0 (sinus) to 1 (AF). Driven by overlays — onset is a
   * case event, conversion is stopping it. Continuous so transitions ramp.
   */
  afib: number;
  /**
   * AV-nodal blockade from drugs, 0–1: the fraction by which the conducted
   * ventricular rate in AF is reduced. Driven by overlays (derivative = 0).
   */
  avBlock: number;

  /** Current simulation time (seconds). */
  time: number;
}

/** Values derived algebraically each tick — never integrated directly. */
export interface DerivedValues {
  // --- Systemic ---
  /** Effective LV maximal elastance after noTone and acidosis penalties (functional contractility). */
  emaxEffective: number;
  /** LV stroke volume (mL). */
  sv: number;
  /** Cardiac output (L/min). HR × SV / 1000. */
  co: number;
  /** Mean arterial pressure (mmHg). CO × SVR + CVP. */
  map: number;

  // --- Pulmonary ---
  /** RV stroke volume (mL). Should equal LV SV at steady state. */
  rvSv: number;
  /** RV cardiac output (L/min). */
  rvCo: number;
  /** Mean pulmonary artery pressure (mmHg). RVCO × PVR + PCWP. */
  mPAP: number;
  /** Pulmonary capillary wedge pressure (mmHg). Approximates LAP/LVEDP. */
  pcwp: number;
  /**
   * The shunt fraction actually in play: the anatomic/parenchymal shunt plus
   * whatever low-flow and hydrostatic edema are adding on top.
   *
   * Published because it is the load the patient is *working against*, and work
   * of breathing rises to defend gas exchange before the saturation falls. A
   * reader that only sees `spO2` sees the outcome of the effort and misses the
   * effort itself.
   */
  qsQtEffective: number;

  // --- Oxygenation ---
  /** Arterial O2 saturation (0–1). From two-compartment shunt model. */
  spO2: number;
  /** Arterial PO2 (mmHg). Derived from SpO2 via inverse Hill curve. */
  paO2: number;
  /** Mixed venous O2 saturation (0–1). Estimated from Fick equation. */
  svO2: number;

  // --- Blood gases / acid-base ---
  /** Arterial pH, Henderson–Hasselbalch from bicarbonate and the integrated PaCO2. */
  pH: number;
  /**
   * pH the fixed-acid load alone would produce at a PaCO2 of 40 — the base
   * deficit, in pH units. Drives the acidosis penalties (myocardial depression,
   * vasoplegia, SA-node suppression), which are metabolic phenomena; a
   * respiratory acidosis of the same arterial pH is much better tolerated.
   */
  pHMetabolic: number;
  /**
   * The pH the acidosis penalties act on: metabolic pH, lowered by whatever part
   * of the respiratory acidosis exceeds the tolerated range.
   */
  pHPenalty: number;
  /**
   * Bicarbonate (mEq/L). The patient's renal baseline, less ~1 mEq/L per mmol/L
   * of lactate above 1 (anion-gap acidosis titrates bicarbonate one for one).
   */
  hco3: number;
  /** Base excess (mEq/L). Negative in metabolic acidosis. */
  be: number;

  // --- Failure status ---
  /**
   * Cardiovascular failure status derived from MAP, CO, and pH each tick.
   * 'compensated': MAP ≥ 50, CO ≥ 2, pH ≥ 7.2
   * 'shock':       MAP < 50 or CO < 2 or pH < 7.2
   * 'decompensating': MAP < 35 or CO < 1 or pH < 7.1
   * 'arrest':      MAP < 20 or pH < 6.9 — irreversible without intervention
   */
  cardiovascularStatus: CardiovascularStatus;

  // --- Ventilation ---
  /** Minute ventilation achieved (L/min). */
  ve: number;
  /** Minute ventilation the chemoreflex is asking for (L/min), before sedation and fatigue. */
  veDemand: number;
  /** Sustainable ventilation the respiratory muscles can deliver (L/min). */
  veCapacity: number;
  /** Alveolar ventilation (L/min) — what clears CO2. */
  va: number;
  /** Respiratory rate (breaths/min), before any case-specific offset. */
  rr: number;
  /** Tidal volume (L). */
  vt: number;
  /** Total physiologic dead-space fraction, VD/VT. */
  vdVt: number;
  /**
   * Depression of consciousness, 0 alert → 1 unrousable: drug sedation plus CO2
   * narcosis relative to this patient's own PaCO2 setpoint. What a nurse sees.
   */
  cnsDepression: number;
  /**
   * Breathing load: the patient's own share of the ventilation (support
   * excluded) as a fraction of their unfatigued capacity. Drives fatigue.
   */
  breathingLoad: number;

  // --- Rhythm ---
  /**
   * The rate the ventricles actually beat at (bpm). Equal to the sinus drive in
   * sinus rhythm; in AF, set by AV-nodal conduction. `snapshot()` reports this
   * as `hr`, because it is the pulse a nurse counts and a monitor shows.
   */
  hrEffective: number;
}

/** Full snapshot = dynamic state + derived values. */
export interface Snapshot extends HemodynamicState, DerivedValues {}

/** Tunable constants for the hemodynamic model. */
export interface HemodynamicParams {
  // --- Frank-Starling curve ---
  /** Maximum achievable stroke volume (mL). */
  svMax: number;
  /** Dead volume / x-intercept of EDPVR (mL). */
  v0: number;
  /** Half-max constant for the Starling curve (mL). */
  km: number;
  /** Reference Emax for contractility scaling. */
  emaxRef: number;

  // --- Overdistension (descending limb of Starling curve) ---
  /**
   * Base EDV threshold above which overdistension penalty begins (mL).
   * Scales inversely with contractility impairment: a failing heart
   * overdistends at lower volumes.
   */
  edvCritBase: number;
  /** Controls how steeply SV declines past the overdistension threshold. */
  overdistensionSteepness: number;

  // --- Baroreflex ---
  /** MAP setpoint the baroreflex defends (mmHg). */
  mapSetpoint: number;
  /** Resting HR when MAP is at setpoint (bpm). */
  hrBaseline: number;
  /** Resting SVR when MAP is at setpoint (Wood units). */
  svrBaseline: number;
  /** Baroreflex gain for HR (bpm per mmHg error). */
  gainHr: number;
  /**
   * Cardiopulmonary reflex gain (bpm at complete unloading of the ventricle).
   *
   * Applied to the fractional filling deficit, so a patient down 30% on their own
   * resting end-diastolic volume gains 0.3 × this many beats per minute. This is
   * the limb that makes tachycardia precede hypotension in hemorrhage.
   */
  gainHrVolume: number;
  /** Baroreflex gain for SVR (Wood units per mmHg error). */
  gainSvr: number;
  /** HR time constant (seconds). */
  tauHr: number;

  // --- Rhythm (rhythm.ts) ---
  /** Ventricular response in AF at resting sympathetic tone, untreated (bpm). */
  afRestRate: number;
  /** Extra ventricular rate in AF per bpm of sinus drive above baseline. */
  afSympGain: number;
  /** Floor on the conducted AF rate however much AV block is on board (bpm). */
  afMinRate: number;
  /** Ceiling set by AV-nodal refractoriness (bpm). */
  afMaxRate: number;
  /**
   * Fraction of end-diastolic volume contributed by atrial contraction, lost in
   * AF. ~0.2 in a normal heart; up to ~0.35 in a stiff, hypertrophied one that
   * fills late (HFpEF, aortic stenosis).
   */
  atrialKickFraction: number;
  /** Multiplier on the rate-dependent filling penalty in AF (irregular short cycles). */
  afFillPenaltyMultiplier: number;
  /**
   * Left-atrial pressure rise per mL of filling lost to AF (mmHg/mL), at normal
   * LV stiffness. Scaled by lvEdpvrStiffness, so a stiff ventricle backs up more.
   */
  laBackupGain: number;
  /** Share of the lost atrial kick that stays in the atrium as backup volume. */
  laKickShare: number;
  /**
   * Stroke output lost to AF irregularity per unit of (rate − 80) / 80, at
   * normal stiffness (scaled by √stiffness). The pulse deficit.
   */
  afPulseDeficitGain: number;

  // --- Rate-dependent diastolic filling ---
  /** Heart rate above which diastole is short enough to cost filling (bpm). */
  filltimeHrThreshold: number;
  /** Fraction of end-diastolic volume lost per unit of fractional rate excess. */
  filltimeGain: number;
  /** Floor on the filling fraction, so an extreme rate cannot empty the ventricle. */
  filltimeFloor: number;
  /** SVR time constant (seconds). */
  tauSvr: number;

  // --- RV Starling (parallel structure to LV params) ---
  rvSvMax: number;
  rvV0: number;
  rvKm: number;
  rvEmaxRef: number;
  rvEdvCritBase: number;
  rvOverdistensionSteepness: number;

  // --- LV EDPVR (for PCWP) ---
  /**
   * Ceiling on pulmonary capillary wedge pressure (mmHg).
   *
   * LVEDP is computed as (EDV − V0) × stiffness / emax, which diverges as
   * contractility approaches its clamp floor: a near-arrest ventricle produced
   * wedge pressures in the hundreds. That was harmless while PCWP only fed mPAP,
   * but once it drives alveolar flooding it becomes a positive feedback loop —
   * unbounded wedge → unbounded shunt → hypoxemia → lower contractility.
   *
   * A wedge cannot rise without limit in any case. Beyond roughly 45–55 mmHg the
   * alveoli are frankly flooded and the pulmonary capillaries are failing; there
   * is no physiology left above that, only arithmetic.
   */
  pcwpMax: number;
  /**
   * LV chamber stiffness constant.
   * LVEDP = (EDV - V0) × lvEdpvrStiffness / emax
   * Tuned so normal EDV/emax → PCWP ≈ 10 mmHg.
   */
  lvEdpvrStiffness: number;

  // --- Oxygenation / Fick ---
  /** Resting O2 consumption (mL O2/min). Used for Fick-based SvO2 estimate. */
  vo2: number;
  /** Hemoglobin concentration (g/dL). */
  hgb: number;
  /** Respiratory quotient (VCO2/VO2). */
  rq: number;
  /** Hill curve P50 (mmHg). PaO2 at which Hgb is 50% saturated. */
  p50: number;
  /** Hill curve exponent. */
  hillN: number;

  // --- Ventilation (see ventilation.ts) ---
  /**
   * The PaCO2 this patient's chemoreceptors defend (mmHg). 40 normally; reset
   * upward in chronic hypercapnia, which is what lets a COPD patient live at 55.
   */
  paCO2Setpoint: number;
  /**
   * Bicarbonate with no fixed acid on board (mEq/L). 24 normally; raised by
   * renal compensation in a chronic CO2 retainer, lowered in chronic kidney disease.
   */
  hco3Baseline: number;
  /** Resting minute ventilation at a drive of 1 (L/min). */
  veRef: number;
  /** Resting respiratory rate at a drive of 1 (breaths/min). */
  rrRef: number;
  /** RR ∝ (VE/veRef)^this. Below 1: tidal volume carries part of any increase. */
  rrVeExponent: number;
  /** Rapid-shallow pattern shift per unit of shunt above 4% (J-receptor). */
  rrShallowShuntGain: number;
  /** Rapid-shallow pattern shift per mmHg of wedge above the edema threshold. */
  rrShallowEdemaGain: number;
  /** Anatomic dead space (L per breath). */
  vdAnatomic: number;
  /** Effective whole-body CO2 capacitance (mL CO2 per mmHg). Sets the apneic rise rate. */
  co2Capacitance: number;
  /** Drive per mmHg PaCO2 above setpoint (fraction of resting ventilation). */
  ventCo2Gain: number;
  /**
   * PaCO2 above setpoint at which CO2 narcosis begins depressing the controller
   * (mmHg). Past this, hypercapnia sedates the respiratory centre it is meant to
   * be stimulating — the positive feedback by which hypercapnic failure ends.
   */
  narcosisThreshold: number;
  /** Additional ventilatory depression per mmHg above the narcosis threshold. */
  narcosisGain: number;
  /**
   * Multiplier on drug-induced ventilatory depression (1 = typical adult).
   * Obstructive sleep apnea, frailty and age all make the same dose of opioid
   * do more; this is where that lives, so the order carries the dose and the
   * patient carries the vulnerability.
   */
  sedativeSensitivity: number;
  /**
   * Fraction of sedative depression that also comes off ventilatory capacity:
   * accessory muscles and upper-airway tone that a loaded patient needs.
   */
  sedationCapacityShare: number;
  /**
   * How much of sedative depression falls on rate rather than depth. Opioid
   * breathing is slow, not shallow: rate is scaled by (1 − this × depression).
   */
  rrDepressionShare: number;
  /** Drive per mmHg PaCO2 below setpoint — the flat limb of the dog-leg. */
  ventCo2GainLow: number;
  /** Drive per mEq/L bicarbonate below baseline (fixed-acid chemoreflex). */
  ventMetabolicGain: number;
  /** Drive per unit SpO2 below ventHypoxicSpO2Threshold (carotid body). */
  ventHypoxicGain: number;
  ventHypoxicSpO2Threshold: number;
  /** Non-chemical drive per unit shunt above 4% (J-receptor / stretch). */
  ventShuntGain: number;
  /** Non-chemical drive per mmHg wedge above the edema threshold. */
  ventEdemaGain: number;
  /** Non-chemical drive per mmHg mean PA pressure above 25 (pulmonary vascular receptors). */
  ventPapGain: number;
  /** Deficit (mEq/L) at which the metabolic drive has doubled its linear value. */
  ventMetabolicCurvature: number;
  /** Sustainable minute ventilation with a normal circulation (L/min). */
  veMax: number;
  /** CO below which respiratory muscle capacity falls in proportion (L/min). */
  ventFatigueCoRef: number;
  /**
   * Breathing load (fraction of unfatigued capacity) the respiratory muscles can
   * sustain indefinitely. Around 0.4–0.5 in health; set per patient from their
   * handover load when they live close to their ceiling, because chronically
   * loaded muscles are adapted to it.
   */
  fatigueLoadThreshold: number;
  /** Load excess over threshold that fatigues at the base rate (1/tauFatigue). */
  fatigueLoadRange: number;
  /** Fraction of capacity lost at full fatigue. */
  fatigueCapacityGain: number;
  /** Time to exhaustion at an excess load of fatigueLoadRange (seconds). */
  tauFatigue: number;
  /** Time constant for recovery (seconds). Slower: a tired diaphragm needs hours. */
  tauFatigueRecovery: number;
  /**
   * Loss of sustainable ventilation per mmHg of wedge above the edema threshold:
   * capacity is divided by (1 + this × excess). A wet lung is a stiff lung.
   */
  edemaComplianceGain: number;
  /** Capacity added at full ventilatory support (L/min). */
  ventSupportCapacity: number;
  /**
   * Alveolar dead space added per unit (shunt above 5%) × (FiO2 above 0.21).
   * Oxygen releases hypoxic vasoconstriction and returns perfusion to poorly
   * ventilated units — the V/Q mechanism of oxygen-induced hypercapnia.
   */
  ventO2DeadSpaceGain: number;

  // --- Layer A: Instantaneous feedback couplings ---
  /** SpO2 threshold below which HPV kicks in (0.93 = 93%). */
  hpvSpO2Threshold: number;
  /** PVR boost per unit SpO2 deficit below hpvSpO2Threshold (WU / fraction). */
  hpvGain: number;
  /** SpO2 threshold below which hypoxic systemic vasodilation occurs (0.90). */
  hypoxicVasoSpO2Threshold: number;
  /** SVR reduction per unit SpO2 deficit below hypoxicVasoSpO2Threshold (WU / fraction). */
  hypoxicVasoGain: number;
  /** RVEDV above which RV-LV septal shift compresses LV diastolic filling (mL). */
  rvlvRvedvThreshold: number;
  /** LV EDV penalty per mL of RVEDV above rvlvRvedvThreshold (mL EDV / mL RVEDV). */
  rvlvGain: number;

  // --- Layer B: Vasoactive mediator dynamics ---
  /** Time constant for NO-tone first-order dynamics (seconds). */
  tauNoTone: number;
  /** SpO2 below which hypoxia drives noTone upward. */
  noToneSpO2Threshold: number;
  /** Gain mapping SpO2 deficit to noTone target. */
  noToneSpO2Gain: number;
  /** SVR reduction per unit noTone (WU). */
  noToneSvrGain: number;
  /** PVR reduction per unit noTone (WU). Mild — NO causes pulmonary vasodilation. */
  noTonePvrGain: number;
  /** Emax depression per unit noTone. Models septic cardiomyopathy. */
  noToneEmaxGain: number;
  /** Time constant for ET-1 tone dynamics (seconds). */
  tauEt1Tone: number;
  /** mPAP above which ET-1 production is upregulated (mmHg). */
  et1ToneMpapThreshold: number;
  /** Gain mapping mPAP excess above threshold to et1Tone target. */
  et1ToneMpapGain: number;
  /** PVR increase per unit et1Tone (WU). */
  et1TonePvrGain: number;
  /** SVR increase per unit et1Tone (WU). Mild systemic vasoconstriction. */
  et1ToneSvrGain: number;
  /** Sensitivity of RVEDV dilation to afterload (mL RVEDV per WU of PVR above pvrRef). */
  rvDilationSensitivity: number;
  /** Reference PVR for RVEDV dilation calculation (WU). Equal to resting PVR. */
  pvrRef: number;
  /** Resting RVEDV around which dilation is calculated (mL). */
  rvedvRef: number;
  /** Reference EDV for venous return coupling (mL). Should match patient's resting EDV. */
  edvRef: number;
  /**
   * Venous return coupling gain: mL RVEDV change per mL EDV deviation from edvRef.
   * Reflects that both ventricles fill from the same venous return.
   * At baseline rvVrGain ≈ rvedvRef/edvRef ≈ 1.25 (RV slightly more compliant than LV).
   * With EDV=30 (severe hemorrhage): RVEDV target drops to ~37 mL (5:1 ratio → 1.25:1) ✓
   */
  rvVrGain: number;
  /** Time constant for RVEDV adaptation to PVR changes (seconds). */
  tauRvAdaptation: number;

  // --- Lactate / acid-base ---
  /** SvO2 below which anaerobic metabolism begins and lactate rises (0–1). */
  lactateSvO2Threshold: number;
  /** Gain mapping SvO2 deficit to lactate target (mmol/L per unit SvO2 deficit). */
  lactateSvO2Gain: number;
  /**
   * MAP below which microvascular maldistribution independently drives lactate accumulation.
   * Even at maximum O2 extraction (SvO2 floor), low perfusion pressure causes regional
   * hypoperfusion — lactate rises faster than the SvO2 model can capture.
   */
  lactateMAPThreshold: number;
  /** Gain mapping MAP deficit below lactateMAPThreshold to additional lactate target (mmol/L per mmHg). */
  lactateMAPGain: number;
  /**
   * Type B lactic acidosis gain: inflammatory/mitochondrial dysfunction driven by noTone.
   * Models the direct cytopathic hypoxia of sepsis — cells fail to utilize O2 even when
   * delivery is adequate (high CO, normal SvO2). This is why septic shock lactate does
   * not correlate with SvO2 the way hemorrhagic shock lactate does.
   * At noTone=0.7 (single sepsis stack): +7 mmol/L → pH ~7.24 (mild acidosis, compensated)
   * At noTone=1.0 (severe/stacked):     +10 mmol/L → drives SvO2 below threshold → spiral
   */
  lactateNoToneGain: number;
  /** Time constant for lactate rise when DO2 is inadequate (seconds). */
  tauLactateRise: number;
  /** Time constant for lactate clearance when DO2 is restored (seconds). Hepatic clearance is slower. */
  tauLactateClear: number;
  /** pH threshold below which acidosis begins depressing myocardial contractility. */
  acidosisPhThreshold: number;
  /**
   * pH drop from CO2 above this patient's setpoint that is tolerated before it
   * counts toward the acidosis penalties. 0.2 ≈ PaCO2 at 1.6× setpoint: permissive
   * hypercapnia goes unpunished; narcotic levels of CO2 do not.
   */
  respiratoryAcidosisTolerance: number;
  /** Emax penalty per unit pH deficit below acidosisPhThreshold. */
  acidosisEmaxGain: number;
  /**
   * pH threshold below which acidosis causes progressive SVR reduction (vasoplegia).
   * Mechanism: acidosis impairs vascular smooth muscle Ca²⁺ sensitivity and
   * reduces catecholamine receptor responsiveness — the baroreflex cannot fully
   * compensate once this penalty exceeds the available SVR headroom.
   */
  acidosisSvrPhThreshold: number;
  /** SVR reduction per unit pH deficit below acidosisSvrPhThreshold (WU). */
  acidosisSvrGain: number;
  /**
   * pH at which acidosis begins capping the maximum achievable HR (SA node depression).
   * H⁺ directly inhibits SA node automaticity and desensitizes β-adrenergic receptors.
   * Above this threshold: full baroreflex HR range available.
   * Below acidosisHrPhFloor: HR clamped to hrMin (agonal rhythm).
   */
  acidosisHrPhThreshold: number;
  /** pH below which HR is clamped to hrMin (agonal/asystole). */
  acidosisHrPhFloor: number;
  /**
   * CO threshold below which pulmonary hypoperfusion is modeled as an effective shunt.
   * When CO falls below this, the oxygenation model adds an effective Qs/Qt component
   * to reflect that insufficient pulmonary blood flow → SpO2 falls toward SvO2.
   * At CO=0: effective shunt fraction approaches 1 → SpO2 = SvO2 (deeply cyanotic).
   */
  lowFlowCoThreshold: number;
  /** Additional Qs/Qt per L/min CO deficit below lowFlowCoThreshold. */
  lowFlowQsQtGain: number;

  /**
   * PCWP above which hydrostatic pressure overcomes plasma oncotic pressure and
   * fluid transudates into the alveoli (Starling forces across the pulmonary
   * capillary). Flooded alveoli are perfused but not ventilated — true shunt.
   *
   * ~18 mmHg is the classical threshold for radiographic interstitial edema;
   * alveolar flooding follows above ~25 mmHg.
   */
  edemaPcwpThreshold: number;
  /**
   * Additional Qs/Qt per mmHg of PCWP above edemaPcwpThreshold.
   * This is what makes cardiogenic pulmonary edema hypoxemic, and what makes
   * preload reduction (diuresis, nitrates, PEEP) improve oxygenation.
   */
  edemaQsQtGain: number;

  // --- Afterload-sensitive SV (ESPVR) ---
  /**
   * MAP threshold above which arterial afterload begins reducing SV.
   * Below this pressure, ejection is preload/contractility-limited as normal.
   * At MAP > threshold: LV cannot fully empty against the elevated end-systolic
   * pressure — ESV rises, SV falls (ESPVR constraint).
   *
   * Set to 140 mmHg (onset of hypertensive emergency). Below this, even multiple
   * vasopressors at moderate dose have no direct SV penalty.
   */
  afterloadMapThreshold: number;
  /** Mean pulmonary artery pressure above which RV stroke volume starts to fall (mmHg). */
  rvAfterloadMpapThreshold: number;
  /** Divisor scaling the RV afterload penalty; larger means more tolerant. */
  rvAfterloadSvGain: number;
  /**
   * Afterload gain (mmHg × dimensionless Emax⁻¹ → SV fraction).
   * SV penalty fraction = (MAP − threshold) / (emaxEffective × afterloadSvGain)
   *
   * Higher value = more tolerant of elevated afterload (flatter ESPVR slope).
   * Normal heart (Emax=2): at MAP=240, penalty = 100/500 = 20% SV reduction.
   * Failing heart (Emax=0.5): at MAP=190, penalty = 50/125 = 40% SV reduction.
   *
   * Inverse relationship with Emax captures the clinical reality that a stronger
   * ventricle tolerates high afterload better than a failing one.
   */
  afterloadSvGain: number;

  // --- Physiologic clamps ---
  hrMin: number;
  hrMax: number;
  svrMin: number;
  svrMax: number;
  edvMin: number;
  edvMax: number;
  pvrMin: number;
  pvrMax: number;
  rvedvMin: number;
  rvedvMax: number;
  lactateMin: number;
  lactateMax: number;
}

/**
 * Kinetic class of an intervention.
 *
 * 'scenario'  — Disease/clinical event. Stoppable; uses physiological reversal t½.
 * 'infusion'  — Titratable IV drug. Stoppable; uses pharmacological elimination t½.
 * 'bolus'     — One-time irreversible dose (IV fluid, oral drug, procedure).
 *               Cannot be stopped. Follows Bateman absorption-elimination curve
 *               (rises with tauOn, decays with eliminationHalfLife).
 */
export type InterventionKind = 'scenario' | 'infusion' | 'bolus';

/**
 * An active intervention modifying a single parameter over time.
 *
 * Kinetics:
 *   infusion/scenario:  effect = delta × (1 − e^{−t/tauOn})  while running
 *                                levelAtStop × e^{−ke × elapsedSinceStop}  after stop
 *   bolus:              effect = delta × Bateman(ka, ke, t)   (normalized to peak = delta)
 *                                where ka = 1/tauOn, ke = ln2/eliminationHalfLife
 *
 * Future clearance module hook: scale eliminationHalfLife per patient
 * (e.g., renally impaired → ×2; hepatic failure → ×3) to model accumulation.
 */
export interface Intervention {
  /** Human-readable label for UI display. */
  label: string;
  /** Category: 'scenario' for clinical events, 'treatment' for player actions. */
  category: 'scenario' | 'treatment';
  /** Kinetic class: determines onset shape and whether the intervention is reversible. */
  kind: InterventionKind;
  /** Which state variable this intervention targets. */
  target: keyof HemodynamicState;
  /** The peak delta (bolus) or steady-state delta (infusion/scenario). */
  delta: number;
  /** Onset / absorption time constant (seconds). Controls rise rate for all kinds. */
  tauOn: number;
  /**
   * Elimination half-life (seconds).
   *
   * For infusions/scenarios: t½ after stopTime.
   * For boluses: t½ of the terminal elimination phase (onset phase controlled by tauOn).
   *
   * Design hook for clearance module: a hepatic/renal impairment factor can be applied
   * to this field at effect-computation time without mutating the intervention record.
   */
  eliminationHalfLife: number;
  /** Sim-time when the intervention was started. */
  startTime: number;
  /**
   * Sim-time when the intervention was stopped.
   * Undefined for still-running infusions/scenarios.
   * Always undefined for bolus (cannot be recalled).
   */
  stopTime?: number;
}
