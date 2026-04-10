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

  // --- Oxygenation ---
  /** Arterial O2 saturation (0–1). From two-compartment shunt model. */
  spO2: number;
  /** Arterial PO2 (mmHg). Derived from SpO2 via inverse Hill curve. */
  paO2: number;
  /** Mixed venous O2 saturation (0–1). Estimated from Fick equation. */
  svO2: number;

  // --- Blood gases / acid-base ---
  /** Arterial pH. Derived from lactate (metabolic component) + paCO2 (constant) via Henderson-Hasselbalch. */
  pH: number;
  /** Bicarbonate (mEq/L). Falls ~1 mEq/L per 1 mmol/L lactate rise above 1 (pure anion-gap acidosis). */
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
  /** Baroreflex gain for SVR (Wood units per mmHg error). */
  gainSvr: number;
  /** HR time constant (seconds). */
  tauHr: number;
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
  /** Baseline arterial CO2 (mmHg) at normal cardiac output. */
  paCO2: number;
  /**
   * CO2 retention gain: mmHg paCO2 rise per L/min CO below co2RetentionCoRef.
   * Mechanism: low cardiac output → impaired pulmonary CO2 clearance →
   * rising PaCO2 → superimposed respiratory acidosis on top of metabolic.
   * This mixed acidosis (type A lactic + respiratory) is the clinical pattern
   * in cardiogenic shock and late-stage hemodynamic failure.
   * Hook: set to 0 for mechanically ventilated patients (CO2 normalized by vent).
   */
  co2RetentionGain: number;
  /** Reference CO above which CO2 clearance is adequate (L/min). */
  co2RetentionCoRef: number;
  /** Respiratory quotient (VCO2/VO2). */
  rq: number;
  /** Hill curve P50 (mmHg). PaO2 at which Hgb is 50% saturated. */
  p50: number;
  /** Hill curve exponent. */
  hillN: number;

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
