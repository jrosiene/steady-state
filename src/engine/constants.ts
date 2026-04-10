import type { HemodynamicParams, HemodynamicState } from './types';

/** Default tuning for a healthy 70 kg adult at rest. */
export const DEFAULT_PARAMS: HemodynamicParams = {
  // --- LV Frank-Starling ---
  svMax: 130,   // mL — physiologic ceiling
  v0: 20,       // mL — dead volume
  km: 80,       // mL — half-max constant
  emaxRef: 2.0, // normalized LV reference contractility

  // LV overdistension
  edvCritBase: 250,
  overdistensionSteepness: 0.001,

  // --- RV Frank-Starling ---
  // Tuned so RVSV ≈ LVSV at baseline (both ~72 mL at resting HR=70)
  // RVEDV=150 → effectiveEDV=130 → rvSvBase = 120×130/210 = 74 mL ≈ 72 ✓
  rvSvMax: 120,
  rvV0: 20,
  rvKm: 80,
  rvEmaxRef: 0.5,      // RV operates at much lower systolic pressure than LV
  rvEdvCritBase: 280,  // RV is more distensible — threshold reached at higher volume
  rvOverdistensionSteepness: 0.001,

  // --- LV EDPVR (PCWP derivation) ---
  // LVEDP = (EDV - V0) × stiffness / emax
  // Normal: (120-20) × 0.2 / 2.0 = 10 mmHg  ✓
  // Cardiogenic (EDV=160, emax=0.8): (140) × 0.2 / 0.8 = 35 mmHg ✓
  lvEdpvrStiffness: 0.2,

  // --- Baroreflex ---
  mapSetpoint: 90,
  hrBaseline: 70,
  svrBaseline: 17,
  gainHr: 1.5,
  gainSvr: 0.45,
  tauHr: 3.0,
  tauSvr: 8.0,

  // --- Oxygenation / Fick ---
  vo2: 250,     // mL O2/min — resting O2 consumption
  hgb: 15,      // g/dL — normal hemoglobin
  paCO2: 40,    // mmHg — baseline arterial CO2 at normal CO
  co2RetentionGain: 3,   // mmHg paCO2 rise per L/min CO below reference
                          // CO=2: +7.5 mmHg → paCO2=47.5 → pH drops ~0.07 at lac=7.6
                          // CO=1: +10.5 mmHg → paCO2=50.5 → pH drops ~0.10 at lac=7.6
  co2RetentionCoRef: 4.5, // L/min — normal CO; below this, CO2 clearance is impaired
  rq: 0.8,      // respiratory quotient
  p50: 26.8,    // mmHg — standard P50 (normal pH/temp/2,3-DPG)
  hillN: 2.7,   // Hill curve cooperativity coefficient

  // --- Layer A: Instantaneous feedback couplings ---
  hpvSpO2Threshold: 0.93,    // HPV onset below SpO2 93%
  hpvGain: 15,               // +1.95 WU PVR at SpO2=0.80 (15 × 0.13)
  hypoxicVasoSpO2Threshold: 0.90,
  hypoxicVasoGain: 20,       // −2.0 WU SVR at SpO2=0.80 (20 × 0.10)
  rvlvRvedvThreshold: 195,   // mL — 130% of 150 mL baseline
  rvlvGain: 0.45,            // 0.45 mL LV EDV penalty per mL excess RVEDV

  // --- Layer B: Vasoactive mediator dynamics ---
  tauNoTone: 300,            // 5 min — NO mediators build up over minutes
  noToneSpO2Threshold: 0.93,
  noToneSpO2Gain: 4,         // noTone target = 0.52 at SpO2=0.80 (4 × 0.13)
  noToneSvrGain: 12,         // −8.4 WU SVR at noTone=0.7 (sepsis); −12 at max
  noTonePvrGain: 0.5,        // mild pulmonary vasodilation
  noToneEmaxGain: 0.5,       // −0.35 Emax at noTone=0.7 (17% depression)
  tauEt1Tone: 600,           // 10 min — ET-1 slower (chronic remodeling)
  et1ToneMpapThreshold: 18,  // mmHg — above upper limit of normal mPAP
  et1ToneMpapGain: 0.04,     // target=0.88 at mPAP=40 (0.04 × 22)
  et1TonePvrGain: 2.5,       // +2.5 WU PVR at full ET-1 saturation
  et1ToneSvrGain: 1.5,       // mild systemic vasoconstriction
  rvDilationSensitivity: 15, // mL RVEDV per WU PVR above pvrRef
  pvrRef: 1.5,               // baseline PVR reference (matches DEFAULT_STATE.pvr)
  rvedvRef: 150,             // resting RVEDV (matches DEFAULT_STATE.rvedv)
  edvRef: 120,               // resting EDV (matches DEFAULT_STATE.edv)
  rvVrGain: 1.25,            // mL RVEDV per mL EDV deviation; ≈ rvedvRef/edvRef = 150/120
                              // EDV=30 → RVEDV target = 150 + 1.25×(30−120) = 37 mL ✓
                              // EDV=160 (volume overload) → RVEDV target = 150 + 1.25×40 = 200 mL ✓
  tauRvAdaptation: 120,      // 2 min for acute RV dilation

  // --- Lactate / acid-base ---
  lactateSvO2Threshold: 0.65, // anaerobic threshold: SvO2 < 65% → lactate starts rising
  lactateSvO2Gain: 25,        // at SvO2=0.10 (floor): target = 1 + 25×0.55 = 14.75 mmol/L
                               // at SvO2=0.50: target = 1 + 25×0.15 = 4.75 (moderate shock)
  lactateMAPThreshold: 50,    // MAP < 50 → microvascular maldistribution adds to lactate target
  lactateMAPGain: 0.3,        // at MAP=40: +3 mmol/L; at MAP=30: +6 mmol/L
  lactateNoToneGain: 10,      // type B: at noTone=0.7 → +7 mmol/L → pH 7.24 (compensated warm sepsis)
                               // at noTone=1.0 → +10 mmol/L → SvO2 drops below threshold → spiral → arrest
  tauLactateRise: 180,        // 3 min to develop (anaerobic metabolism is rapid)
  tauLactateClear: 900,       // 15 min to clear (hepatic lactate clearance is slower)
  acidosisPhThreshold: 7.35,  // myocardial depression starts at mild acidosis
  acidosisEmaxGain: 7.0,      // pH=7.24 → penalty 0.77 → emaxEff=1.23 (38% ↓); unstable with SvO2<40%
                               // pH=7.20 → penalty 1.05 → emaxEff=0.95 (53% ↓); CO collapses → spiral
                               // pH=7.10 → penalty 1.75 → emaxEff=0.25 (88% ↓); near arrest
                               // pH=7.00 → penalty 2.45 → emaxEff=0.05 (clamped); full failure
                               // Raised from 3.5: prior gain allowed stable equilibrium at SvO2=36%
                               // (lactate=8, pH=7.24) — clinically incompatible with sustained life.
  acidosisSvrPhThreshold: 7.3, // vasoplegia onset: pH < 7.3 → SVR begins to fall
  acidosisSvrGain: 15,         // pH=7.1 → −3 WU; pH=7.0 → −4.5 WU; pH=6.9 → −6 WU
                                // baroreflex SVR maxes at 40 WU; penalty overcomes it below pH~7.0
  acidosisHrPhThreshold: 7.1,  // SA node depression starts: pH < 7.1 → HR ceiling begins to drop
  acidosisHrPhFloor: 6.8,      // at pH ≤ 6.8: HR clamped to hrMin (agonal rhythm)
                                // linear scaling: pH=7.0 → ceiling ~147; pH=6.9 → ceiling ~73
  lowFlowCoThreshold: 2.0,     // L/min: below this, pulmonary hypoperfusion adds effective shunt
  lowFlowQsQtGain: 0.4,        // at CO=0.04 → extra_shunt = 0.4×(2.0−0.04) = 0.78
                                // → effective qsQt ≈ 0.80 → SpO2 ≈ 27% (deeply cyanotic arrest) ✓
                                // at CO=1.0 → extra_shunt = 0.4×1.0 = 0.40 → SpO2 drops to ~60%

  // --- Afterload-sensitive SV (ESPVR) ---
  // SV penalty fraction = max(0, MAP − threshold) / (emaxEffective × gain)
  // Normal (Emax=2, MAP=190): (190−140)/(2×250) = 10% penalty
  // Failing (Emax=0.5, MAP=190): (190−140)/(0.5×250) = 40% penalty → rapid decompensation ✓
  // Toxic phenylephrine (SVR=50, CO→5, MAP≈255): (255−140)/(2×250) = 23% penalty → shock ✓
  afterloadMapThreshold: 140,
  afterloadSvGain: 250,

  // --- Physiologic clamps ---
  hrMin: 30,
  hrMax: 220,
  svrMin: 4,
  // 60 WU (~4800 dynes·s/cm⁵): allows toxic vasopressor levels. Also fixes a secondary
  // realism issue — the baroreflex SVR target at MAP=0 is 17+0.45×90=57.5 WU, which was
  // arbitrarily capped at 40. Now the full compensatory range can express.
  svrMax: 60,
  edvMin: 30,
  edvMax: 300,
  pvrMin: 0.5,
  pvrMax: 20,   // severe PH
  rvedvMin: 30,
  rvedvMax: 350,
  lactateMin: 0.5,
  lactateMax: 25,
};

/** Resting hemodynamic state for a healthy adult. */
export const DEFAULT_STATE: HemodynamicState = {
  // Systemic
  hr: 70,
  svr: 17,
  edv: 120,
  emax: 2.0,
  cvp: 5,
  hrMod: 0,

  // Pulmonary
  rvEmax: 0.5,   // matches rvEmaxRef → RV contractility scale = 1.0
  pvr: 1.5,      // WU — normal PVR (~120 dynes·s/cm⁵)
  rvedv: 150,    // mL — normal RVEDV (larger than LVEDV, RV more compliant)

  // Gas exchange
  qsQt: 0.02,    // 2% normal anatomic shunt
  fiO2: 0.21,    // room air

  // Vasoactive mediators
  noTone: 0,     // no excess NO/PGI2 at baseline
  et1Tone: 0,    // no ET-1 activation at baseline

  // Acid-base
  lactate: 1.0,  // mmol/L — normal resting lactate

  time: 0,
};
