import type { OrderDef, OrderCategory } from './types';

/**
 * Prefix marking an intervention as an oxygen-delivery device.
 *
 * Devices replace each other rather than stacking: putting a patient on a
 * non-rebreather after nasal cannula should deliver an FiO2 of ~0.80, not the
 * sum of both. The shift engine stops any intervention carrying this prefix
 * when a new device is ordered.
 */
export const O2_LABEL_PREFIX = 'O2:';

/**
 * The order set available on a night shift.
 *
 * Lead times are the real latency between placing an order and the drug reaching
 * the patient — nursing acknowledgement, pharmacy verification, and administration.
 * They are the reason a late order and a timely order produce different outcomes
 * even when the drug is identical.
 */
export const ORDERS: OrderDef[] = [
  // ─── Fluids / blood ───────────────────────────────────────────────────────
  {
    id: 'ns-500',
    label: '500 mL NS bolus',
    category: 'fluids',
    detail: 'Crystalloid bolus over 30 min. Raises preload.',
    leadTimeSec: 300,
    ack: "Got it — hanging 500 of saline now.",
    interventions: [
      { label: '500 mL NS', category: 'treatment', kind: 'bolus', target: 'edv', delta: 20, tauOn: 600, eliminationHalfLife: 5400 },
    ],
  },
  {
    id: 'ns-1000',
    label: '1 L NS bolus',
    category: 'fluids',
    detail: 'Crystalloid bolus wide open. Raises preload substantially.',
    leadTimeSec: 300,
    ack: "Starting a litre wide open.",
    interventions: [
      { label: '1 L NS', category: 'treatment', kind: 'bolus', target: 'edv', delta: 40, tauOn: 600, eliminationHalfLife: 5400 },
    ],
  },
  {
    id: 'prbc',
    label: 'Transfuse 2 units PRBC',
    category: 'fluids',
    detail: 'Packed red cells. Restores volume and oxygen-carrying capacity.',
    leadTimeSec: 1800,
    ack: "Type and screen is back — I'll get the blood from the bank and start it.",
    raisesHgb: 2.4,
    interventions: [
      // Blood stays intravascular far longer than crystalloid.
      { label: '2u PRBC', category: 'treatment', kind: 'bolus', target: 'edv', delta: 42, tauOn: 1200, eliminationHalfLife: 43200 },
    ],
  },

  // ─── Vasoactives (ICU only) ───────────────────────────────────────────────
  {
    id: 'norepi',
    label: 'Norepinephrine infusion',
    category: 'pressors',
    detail: 'α1 vasoconstriction with mild β1 support. First-line for vasodilatory shock.',
    leadTimeSec: 600,
    requiresIcu: true,
    ack: "Levophed is up and titrating to a MAP of 65.",
    interventions: [
      { label: 'Norepinephrine (SVR)', category: 'treatment', kind: 'infusion', target: 'svr', delta: 8, tauOn: 120, eliminationHalfLife: 150 },
      { label: 'Norepinephrine (chrono)', category: 'treatment', kind: 'infusion', target: 'hrMod', delta: 5, tauOn: 120, eliminationHalfLife: 150 },
    ],
  },
  {
    id: 'vasopressin',
    label: 'Vasopressin infusion',
    category: 'pressors',
    detail: 'V1 agonist. Catecholamine-sparing second agent in septic shock.',
    leadTimeSec: 600,
    requiresIcu: true,
    ack: "Vasopressin running at 0.03 units a minute, fixed dose.",
    interventions: [
      { label: 'Vasopressin', category: 'treatment', kind: 'infusion', target: 'svr', delta: 6, tauOn: 30, eliminationHalfLife: 1080 },
    ],
  },
  {
    id: 'dobutamine',
    label: 'Dobutamine infusion',
    category: 'pressors',
    detail: 'β1 inotrope. Raises contractility and heart rate; can drop SVR.',
    leadTimeSec: 600,
    requiresIcu: true,
    ack: "Dobutamine started at 5 mics.",
    interventions: [
      { label: 'Dobutamine (inotropy)', category: 'treatment', kind: 'infusion', target: 'emax', delta: 1.0, tauOn: 120, eliminationHalfLife: 150 },
      { label: 'Dobutamine (chrono)', category: 'treatment', kind: 'infusion', target: 'hrMod', delta: 25, tauOn: 120, eliminationHalfLife: 150 },
      { label: 'Dobutamine (vasodil)', category: 'treatment', kind: 'infusion', target: 'svr', delta: -1.5, tauOn: 120, eliminationHalfLife: 150 },
    ],
  },
  {
    id: 'epinephrine',
    label: 'Epinephrine infusion',
    category: 'pressors',
    detail: 'α1 + β1. Potent inopressor for refractory shock.',
    leadTimeSec: 600,
    requiresIcu: true,
    ack: "Epi drip is up.",
    interventions: [
      { label: 'Epinephrine (SVR)', category: 'treatment', kind: 'infusion', target: 'svr', delta: 6, tauOn: 120, eliminationHalfLife: 120 },
      { label: 'Epinephrine (inotropy)', category: 'treatment', kind: 'infusion', target: 'emax', delta: 1.5, tauOn: 120, eliminationHalfLife: 120 },
      { label: 'Epinephrine (chrono)', category: 'treatment', kind: 'infusion', target: 'hrMod', delta: 40, tauOn: 120, eliminationHalfLife: 120 },
    ],
  },

  // ─── Respiratory ──────────────────────────────────────────────────────────
  {
    id: 'o2-nc',
    label: 'Nasal cannula 2 L',
    category: 'respiratory',
    detail: 'Low-flow oxygen, FiO2 ≈ 0.28.',
    leadTimeSec: 120,
    o2Device: '2L NC',
    ack: "He's on 2 litres.",
    interventions: [
      { label: `${O2_LABEL_PREFIX} 2L NC`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.07, tauOn: 60, eliminationHalfLife: 120 },
    ],
  },
  {
    id: 'o2-nc6',
    label: 'Nasal cannula 6 L',
    category: 'respiratory',
    detail: 'High-flow nasal oxygen, FiO2 ≈ 0.44.',
    leadTimeSec: 120,
    o2Device: '6L NC',
    ack: "Turned him up to 6 litres.",
    interventions: [
      { label: `${O2_LABEL_PREFIX} 6L NC`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.23, tauOn: 60, eliminationHalfLife: 120 },
    ],
  },
  {
    id: 'o2-nrb',
    label: 'Non-rebreather mask',
    category: 'respiratory',
    detail: 'FiO2 ≈ 0.85. Does little for a large shunt.',
    leadTimeSec: 120,
    o2Device: 'NRB 15L',
    ack: "Non-rebreather is on at 15 litres.",
    interventions: [
      { label: `${O2_LABEL_PREFIX} NRB`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.64, tauOn: 60, eliminationHalfLife: 120 },
    ],
  },
  {
    id: 'bipap',
    label: 'BiPAP',
    category: 'respiratory',
    detail: 'Positive pressure recruits alveoli and unloads the LV by dropping preload.',
    leadTimeSec: 600,
    o2Device: 'BiPAP',
    ack: "Respiratory is at the bedside setting up BiPAP.",
    interventions: [
      { label: `${O2_LABEL_PREFIX} BiPAP`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.29, tauOn: 120, eliminationHalfLife: 180 },
      // PEEP recruits flooded alveoli — the mechanism that makes NIV work in edema.
      { label: 'BiPAP recruitment', category: 'treatment', kind: 'infusion', target: 'qsQt', delta: -0.08, tauOn: 300, eliminationHalfLife: 300 },
      // Raised intrathoracic pressure reduces venous return.
      { label: 'BiPAP preload↓', category: 'treatment', kind: 'infusion', target: 'edv', delta: -12, tauOn: 300, eliminationHalfLife: 300 },
    ],
  },
  {
    id: 'intubate',
    label: 'Intubate and ventilate',
    category: 'respiratory',
    detail: 'Definitive airway. Sedation and positive pressure both drop preload and SVR.',
    leadTimeSec: 600,
    once: true,
    o2Device: 'Vent',
    requiresIcu: true,
    ack: "Anaesthesia is on the way for the tube.",
    interventions: [
      { label: `${O2_LABEL_PREFIX} Vent`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.79, tauOn: 120, eliminationHalfLife: 300 },
      { label: 'Vent recruitment', category: 'treatment', kind: 'infusion', target: 'qsQt', delta: -0.10, tauOn: 300, eliminationHalfLife: 600 },
      // Peri-intubation hypotension: sedation vasodilates, PPV drops venous return.
      { label: 'Induction vasodilation', category: 'treatment', kind: 'bolus', target: 'svr', delta: -4, tauOn: 120, eliminationHalfLife: 1800 },
      { label: 'PPV preload↓', category: 'treatment', kind: 'infusion', target: 'edv', delta: -15, tauOn: 300, eliminationHalfLife: 600 },
    ],
  },
  {
    id: 'duoneb',
    label: 'Duonebs (albuterol/ipratropium)',
    category: 'respiratory',
    detail: 'Bronchodilation improves V/Q matching. Mild tachycardia.',
    leadTimeSec: 300,
    ack: "Starting nebs now.",
    interventions: [
      { label: 'Duonebs (V/Q)', category: 'treatment', kind: 'bolus', target: 'qsQt', delta: -0.10, tauOn: 600, eliminationHalfLife: 7200 },
      { label: 'Duonebs (chrono)', category: 'treatment', kind: 'bolus', target: 'hrMod', delta: 12, tauOn: 600, eliminationHalfLife: 5400 },
    ],
  },

  // ─── Medications ──────────────────────────────────────────────────────────
  {
    id: 'abx',
    label: 'Broad-spectrum antibiotics',
    category: 'meds',
    detail: 'Vancomycin + piperacillin-tazobactam. Reverses the septic driver over hours.',
    leadTimeSec: 1200,
    ack: "Pharmacy is verifying — I'll run the vanc and zosyn as soon as they're up.",
    interventions: [
      // Source control is slow: the inflammatory tone falls over hours, not minutes.
      { label: 'Antibiotics', category: 'treatment', kind: 'bolus', target: 'noTone', delta: -0.55, tauOn: 5400, eliminationHalfLife: 43200 },
    ],
  },
  {
    id: 'steroids',
    label: 'Methylprednisolone IV',
    category: 'meds',
    detail: 'Anti-inflammatory. Reduces airway oedema and vasodilatory tone.',
    leadTimeSec: 600,
    ack: "Solu-Medrol given.",
    interventions: [
      { label: 'Steroids (NO↓)', category: 'treatment', kind: 'bolus', target: 'noTone', delta: -0.3, tauOn: 1800, eliminationHalfLife: 14400 },
      { label: 'Steroids (V/Q)', category: 'treatment', kind: 'bolus', target: 'qsQt', delta: -0.06, tauOn: 3600, eliminationHalfLife: 14400 },
    ],
  },
  {
    id: 'furosemide',
    label: 'Furosemide 40 mg IV',
    category: 'meds',
    detail: 'Loop diuretic. Offloads preload — helps congestion, harms hypovolaemia.',
    leadTimeSec: 300,
    ack: "Lasix in. I'll watch her urine output.",
    interventions: [
      { label: 'Furosemide (preload↓)', category: 'treatment', kind: 'bolus', target: 'edv', delta: -38, tauOn: 900, eliminationHalfLife: 10800 },
      { label: 'Furosemide (CVP↓)', category: 'treatment', kind: 'bolus', target: 'cvp', delta: -4, tauOn: 900, eliminationHalfLife: 10800 },
    ],
  },
  {
    id: 'nitro',
    label: 'Nitroglycerin infusion',
    category: 'meds',
    detail: 'Venodilator. Drops preload and afterload — the fast fix for flash pulmonary oedema.',
    leadTimeSec: 420,
    ack: "Nitro drip is on, titrating up.",
    interventions: [
      { label: 'Nitroglycerin (preload↓)', category: 'treatment', kind: 'infusion', target: 'edv', delta: -22, tauOn: 180, eliminationHalfLife: 240 },
      { label: 'Nitroglycerin (afterload↓)', category: 'treatment', kind: 'infusion', target: 'svr', delta: -3.5, tauOn: 180, eliminationHalfLife: 240 },
    ],
  },
  {
    id: 'heparin',
    label: 'Heparin infusion',
    category: 'meds',
    detail: 'Anticoagulation stops clot propagation. It does not dissolve existing clot.',
    leadTimeSec: 900,
    ack: "Heparin bolus given, drip running per protocol.",
    interventions: [
      { label: 'Heparin', category: 'treatment', kind: 'infusion', target: 'pvr', delta: -1.2, tauOn: 10800, eliminationHalfLife: 43200 },
    ],
  },
  {
    id: 'thrombolysis',
    label: 'Systemic thrombolysis (tPA)',
    category: 'meds',
    detail: 'Lyses clot and unloads the RV. Reserved for haemodynamically unstable PE.',
    leadTimeSec: 900,
    once: true,
    ack: "tPA is drawn up — confirming the dose with pharmacy now.",
    interventions: [
      // Lysis unloads the RV over the following hour — the only treatment that
      // reverses the obstruction fast enough to matter in a crashing patient.
      { label: 'tPA (clot lysis)', category: 'treatment', kind: 'bolus', target: 'pvr', delta: -6.0, tauOn: 1800, eliminationHalfLife: 86400 },
      { label: 'tPA (shunt↓)', category: 'treatment', kind: 'bolus', target: 'qsQt', delta: -0.14, tauOn: 1800, eliminationHalfLife: 86400 },
    ],
  },
  {
    id: 'ppi',
    label: 'Pantoprazole infusion',
    category: 'meds',
    detail: 'Acid suppression to stabilise clot over an upper GI bleeding source.',
    leadTimeSec: 600,
    ack: "Protonix drip started.",
  },
  {
    id: 'aspirin',
    label: 'Aspirin 325 mg',
    category: 'meds',
    detail: 'Antiplatelet therapy for suspected acute coronary syndrome.',
    leadTimeSec: 300,
    ack: "Chewed the aspirin.",
  },

  // ─── Labs / imaging ───────────────────────────────────────────────────────
  { id: 'lab-lactate', label: 'Lactate', category: 'labs', detail: 'Marker of tissue hypoperfusion.', leadTimeSec: 0, lab: { panel: 'Lactate', turnaroundSec: 1500 }, ack: "Drawing a lactate." },
  { id: 'lab-vbg', label: 'Venous blood gas', category: 'labs', detail: 'pH, pCO₂, bicarbonate, lactate.', leadTimeSec: 0, lab: { panel: 'VBG', turnaroundSec: 1200 }, ack: "Sending a VBG." },
  { id: 'lab-abg', label: 'Arterial blood gas', category: 'labs', detail: 'Oxygenation and ventilation.', leadTimeSec: 0, lab: { panel: 'ABG', turnaroundSec: 1500 }, ack: "I'll call respiratory for an ABG." },
  { id: 'lab-cbc', label: 'CBC', category: 'labs', detail: 'Haemoglobin, white count, platelets.', leadTimeSec: 0, lab: { panel: 'CBC', turnaroundSec: 2400 }, ack: "CBC sent." },
  { id: 'lab-bmp', label: 'Basic metabolic panel', category: 'labs', detail: 'Renal function and electrolytes.', leadTimeSec: 0, lab: { panel: 'BMP', turnaroundSec: 2700 }, ack: "BMP sent." },
  { id: 'lab-trop', label: 'Troponin', category: 'labs', detail: 'Myocardial injury marker.', leadTimeSec: 0, lab: { panel: 'Troponin', turnaroundSec: 2700 }, ack: "Troponin sent." },
  { id: 'lab-cultures', label: 'Blood cultures ×2', category: 'labs', detail: 'Draw before antibiotics when feasible.', leadTimeSec: 0, lab: { panel: 'Blood cultures', turnaroundSec: 1800 }, ack: "Getting two sets from separate sites." },
  { id: 'img-ekg', label: '12-lead EKG', category: 'imaging', detail: 'Rhythm, ischaemia, strain pattern.', leadTimeSec: 0, lab: { panel: 'EKG', turnaroundSec: 600 }, ack: "Doing the EKG now." },
  { id: 'img-cxr', label: 'Portable chest X-ray', category: 'imaging', detail: 'Oedema, consolidation, pneumothorax.', leadTimeSec: 0, lab: { panel: 'CXR', turnaroundSec: 2100 }, ack: "Ordered the portable film." },
  { id: 'img-ctpe', label: 'CT pulmonary angiogram', category: 'imaging', detail: 'Definitive test for pulmonary embolism. Requires transport.', leadTimeSec: 0, lab: { panel: 'CT PE protocol', turnaroundSec: 3000 }, ack: "Calling CT — she'll need a nurse to travel with her." },
  { id: 'img-echo', label: 'Bedside echo', category: 'imaging', detail: 'Ventricular function, filling, RV strain. Fast and at the bedside.', leadTimeSec: 0, lab: { panel: 'Bedside echo', turnaroundSec: 1500 }, ack: "I'll get the ultrasound machine." },

  // ─── Nursing ──────────────────────────────────────────────────────────────
  {
    id: 'vitals-now',
    label: 'Full set of vitals now',
    category: 'nursing',
    detail: 'A current, complete set of vitals.',
    leadTimeSec: 0,
    ack: "Going in to get them.",
  },
  {
    id: 'telemetry',
    label: 'Continuous monitoring',
    category: 'nursing',
    detail: 'Telemetry and continuous pulse oximetry — gives you live vitals.',
    leadTimeSec: 300,
    once: true,
    startsMonitoring: true,
    ack: "Putting her on the monitor and pulse ox.",
  },
  {
    id: 'sit-up',
    label: 'Sit upright',
    category: 'nursing',
    detail: 'Upright positioning improves V/Q matching and work of breathing.',
    leadTimeSec: 60,
    ack: "Sat him all the way up.",
    interventions: [
      { label: 'Upright positioning', category: 'treatment', kind: 'infusion', target: 'qsQt', delta: -0.03, tauOn: 300, eliminationHalfLife: 1800 },
    ],
  },

  // ─── Disposition ──────────────────────────────────────────────────────────
  {
    id: 'rapid-response',
    label: 'Call rapid response',
    category: 'disposition',
    detail: 'Brings the RRT nurse and respiratory to the bedside with a monitor.',
    leadTimeSec: 180,
    once: true,
    startsMonitoring: true,
    ack: "Calling it overhead now.",
  },
  {
    id: 'transfer-icu',
    label: 'Transfer to ICU',
    category: 'disposition',
    detail: 'Higher level of care. Required before vasoactive infusions can run.',
    leadTimeSec: 900,
    once: true,
    startsMonitoring: true,
    ack: "ICU has a bed — I'll get report and we'll move her.",
  },
  {
    id: 'call-attending',
    label: 'Call the attending',
    category: 'disposition',
    detail: 'Curbside the on-call attending for their read on the case.',
    leadTimeSec: 240,
    ack: "I'll page them for you.",
  },
  {
    id: 'consult-gi',
    label: 'Consult GI',
    category: 'disposition',
    detail: 'Gastroenterology for endoscopic evaluation and haemostasis.',
    leadTimeSec: 600,
    once: true,
    ack: "Paging the GI fellow.",
  },
  {
    id: 'consult-cards',
    label: 'Consult cardiology',
    category: 'disposition',
    detail: 'Cardiology for ischaemia and pump failure.',
    leadTimeSec: 600,
    once: true,
    ack: "Paging cardiology.",
  },
  {
    id: 'comfort-care',
    label: 'Transition to comfort care',
    category: 'disposition',
    detail: 'Goals-of-care conversation and symptom-directed treatment only.',
    leadTimeSec: 600,
    once: true,
    ack: "I'll get the family on the phone and set up a morphine drip for comfort.",
  },
];

export const ORDER_BY_ID: Record<string, OrderDef> = Object.fromEntries(
  ORDERS.map((o) => [o.id, o]),
);

export const ORDER_CATEGORIES: { id: OrderCategory; label: string }[] = [
  { id: 'nursing', label: 'Nursing' },
  { id: 'labs', label: 'Labs' },
  { id: 'imaging', label: 'Imaging' },
  { id: 'fluids', label: 'Fluids' },
  { id: 'respiratory', label: 'Respiratory' },
  { id: 'meds', label: 'Medications' },
  { id: 'pressors', label: 'Vasoactives' },
  { id: 'disposition', label: 'Disposition' },
];
