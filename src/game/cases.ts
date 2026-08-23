import type { PatientCase } from './types';

const MIN = 60;
const HOUR = 3600;

/**
 * The ward for one night shift.
 *
 * Each case is built around a single decision the player has to get right, and
 * the illness scripts are staggered so that concerns arrive faster than they can
 * comfortably be handled. Triage — deciding which page matters — is the game.
 *
 * Physiology is never scripted directly to an outcome: events apply mechanistic
 * insults (preload loss, contractility loss, shunt, inflammatory tone) and the
 * engine decides what happens from there. A patient who is treated early and one
 * who is treated late receive exactly the same insult and diverge on their own.
 */
export const CASES: PatientCase[] = [
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'whitfield',
    name: 'Margaret Whitfield',
    age: 78,
    sex: 'F',
    room: '412',
    nurse: 'Priya',
    codeStatus: 'Full Code',
    allergies: 'Sulfa (rash)',
    admissionDx: 'Pyelonephritis, on ceftriaxone',
    history: ['Type 2 diabetes', 'CKD stage 3', 'Recurrent UTIs'],
    signout:
      'Admitted yesterday with flank pain and dysuria. Urine culture pending. ' +
      'Afebrile most of today on ceftriaxone. Day team thought she looked well enough for discharge tomorrow.',
    hiddenDx: 'Gram-negative urosepsis progressing to septic shock',
    teachingPoint:
      'Septic shock is a distributive problem: the cardiac output is high and the vascular tone is gone. ' +
      'Fluids and source control reverse it; waiting for the blood pressure to declare itself does not. ' +
      'Antibiotics take hours to work, so the clock that matters is the one that starts at the first abnormal vital sign.',
    stateOverrides: { hr: 84, svr: 15.5, edv: 108, noTone: 0.12 },
    rrOffset: 4,
    events: [
      {
        at: 40 * MIN,
        page: "Sorry to bother you — Mrs Whitfield in 412 spiked to 38.9. Her pressure is 96/54, heart rate 104. She's still making sense but she seems a bit off to me.",
        interventions: [
          { label: 'Sepsis: inflammatory tone', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.25, tauOn: 900, eliminationHalfLife: 36000 },
        ],
      },
      {
        at: 2 * HOUR,
        urgent: true,
        page: "Her BP is down to 84/48 and she's confused now — she didn't know where she was. Heart rate's 118. I'm worried about her.",
        interventions: [
          { label: 'Sepsis: vasoplegia', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.28, tauOn: 1200, eliminationHalfLife: 36000 },
          { label: 'Sepsis: third-spacing', category: 'scenario', kind: 'scenario', target: 'edv', delta: -22, tauOn: 1800, eliminationHalfLife: 36000 },
        ],
      },
      {
        at: 3 * HOUR + 30 * MIN,
        urgent: true,
        page: "She's mottled up to her knees and barely rousable. MAP is in the 50s. I need someone up here.",
        interventions: [
          { label: 'Sepsis: progression', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.3, tauOn: 1800, eliminationHalfLife: 36000 },
        ],
      },
    ],
    expectedOrders: ['vitals-now', 'lab-lactate', 'lab-cultures', 'abx', 'ns-1000', 'transfer-icu'],
    contraindicatedOrders: ['furosemide'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'brennan',
    name: 'Harold Brennan',
    age: 71,
    sex: 'M',
    room: '408',
    nurse: 'Danny',
    codeStatus: 'Full Code',
    allergies: 'NKDA',
    admissionDx: 'COPD exacerbation',
    history: ['COPD', 'Hypertension', 'Prior anterior MI (EF 30%)', 'Atrial fibrillation'],
    signout:
      'Admitted this morning as a COPD flare, started on steroids and nebs. ' +
      "Day team noted he's 'a bit wet' but attributed the hypoxia to his COPD. Net positive 2.4 litres since admission.",
    hiddenDx: 'Acute decompensated heart failure with flash pulmonary oedema — mislabelled as COPD',
    teachingPoint:
      'The admission diagnosis is a hypothesis, not a fact. This is cardiogenic pulmonary oedema: a high wedge ' +
      'floods alveoli and creates true shunt, which is why oxygen alone barely helps. Preload reduction — nitrates, ' +
      'diuresis, positive pressure — fixes the oxygenation because it fixes the pressure. A fluid bolus here makes it worse.',
    // emaxRef is deliberately left at the population value: emax 1.25 against a
    // reference of 2.0 is what makes this a failing ventricle (contractility scale
    // 0.63) and what puts his overdistension threshold low enough that the volume
    // he is carrying tips him into flash oedema.
    stateOverrides: { hr: 88, svr: 16.5, emax: 1.25, edv: 152, qsQt: 0.05 },
    // Eccentric remodelling after his anterior MI. The default overdistension
    // threshold scales down with contractility, which is right for an acutely
    // stunned ventricle but wrong for a chronically dilated one — a remodelled
    // heart lives at volumes that would flatten a normal ventricle. Without this
    // he falls off the descending limb the moment he third-spaces, and dies of
    // pump failure rather than the pulmonary oedema this case is teaching.
    paramOverrides: { edvCritBase: 420 },
    rrOffset: 7,
    events: [
      {
        at: 70 * MIN,
        urgent: true,
        page: "Mr Brennan in 408 is short of breath. He's satting 88% on his 2 litres and he won't lie flat. Sounds junky in both bases to me.",
        interventions: [
          // Onset stretched deliberately. Flash oedema is genuinely fast, but the
          // window from first page to arrest has to be long enough to read the
          // thread, think, and get three orders in — otherwise the case tests
          // reaction speed rather than clinical reasoning.
          { label: 'ADHF: contractility↓', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.3, tauOn: 1800, eliminationHalfLife: 36000 },
          { label: 'ADHF: volume overload', category: 'scenario', kind: 'scenario', target: 'edv', delta: 34, tauOn: 2400, eliminationHalfLife: 36000 },
        ],
      },
      {
        at: 2 * HOUR + 30 * MIN,
        urgent: true,
        page: "He's worse — sitting bolt upright, sat 84%, and he's coughing up pink froth. I've got him on a non-rebreather.",
        interventions: [
          { label: 'Flash oedema', category: 'scenario', kind: 'scenario', target: 'edv', delta: 26, tauOn: 600, eliminationHalfLife: 36000 },
        ],
      },
    ],
    expectedOrders: ['nitro', 'furosemide', 'bipap', 'img-cxr', 'img-echo', 'sit-up'],
    contraindicatedOrders: ['ns-500', 'ns-1000', 'prbc'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'okonkwo',
    name: 'Delia Okonkwo',
    age: 54,
    sex: 'F',
    room: '419',
    nurse: 'Rosa',
    codeStatus: 'Full Code',
    allergies: 'NKDA',
    admissionDx: 'POD#2 total knee arthroplasty — pain control',
    history: ['Obesity', 'Oestrogen-containing contraception', 'Osteoarthritis'],
    signout:
      'Routine post-op. Ambulating with physio. Was supposed to go home today but pain was not controlled. ' +
      'Chemical DVT prophylaxis was held yesterday for a haematoma at the surgical site.',
    hiddenDx: 'Massive pulmonary embolism with right ventricular failure',
    teachingPoint:
      'Sudden hypoxaemia with hypotension and a clear chest is obstructive shock until proven otherwise. ' +
      'The failing ventricle is the right one: it is pressure-overloaded, dilating, and bowing the septum into the LV. ' +
      'Volume makes RV failure worse, not better. The treatment is to reduce the afterload — anticoagulation, and lysis if unstable.',
    stateOverrides: { hr: 79, svr: 14.5, edv: 128 },
    rrOffset: 3,
    events: [
      {
        at: 4 * HOUR,
        urgent: true,
        page: "Rapid one — 419 just got back from the bathroom and she can't catch her breath. Sat's 84% on room air, heart rate 128, BP 92/60. She says her chest hurts when she breathes in.",
        interventions: [
          { label: 'PE: PVR↑', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 5.5, tauOn: 240, eliminationHalfLife: 86400 },
          // Dead-space ventilation plus reflex shunting through unobstructed lung —
          // enough to put her in the mid-80s on room air, matching the nurse's report.
          { label: 'PE: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.22, tauOn: 240, eliminationHalfLife: 86400 },
        ],
      },
      {
        at: 4 * HOUR + 45 * MIN,
        urgent: true,
        page: "Her pressure is dropping — 78/52 now. She's grey and she's telling me she feels like she's going to die.",
        interventions: [
          // Clot propagates without anticoagulation: RV afterload climbs further,
          // the ventricle dilates, and the septum bows into the LV. Enough to be
          // lethal if ignored, but slow enough that lysis started on recognition
          // still gets ahead of it.
          { label: 'PE: clot propagation', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 2.2, tauOn: 2400, eliminationHalfLife: 86400 },
          { label: 'PE: RV failure', category: 'scenario', kind: 'scenario', target: 'rvEmax', delta: -0.10, tauOn: 2400, eliminationHalfLife: 86400 },
        ],
      },
    ],
    expectedOrders: ['o2-nrb', 'img-echo', 'heparin', 'transfer-icu', 'thrombolysis', 'img-ctpe'],
    contraindicatedOrders: ['ns-1000', 'furosemide'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'castellanos',
    name: 'Raymond Castellanos',
    age: 63,
    sex: 'M',
    room: '405',
    nurse: 'Danny',
    codeStatus: 'Full Code',
    allergies: 'NKDA',
    admissionDx: 'Upper GI bleed — melaena, Hgb 9.8',
    history: ['Peptic ulcer disease', 'Daily NSAIDs for back pain', 'Alcohol use disorder'],
    signout:
      'Two units transfused in the ED, Hgb came up to 9.8 and held. GI planning to scope in the morning. ' +
      'On a pantoprazole drip. Has been stable all afternoon.',
    hiddenDx: 'Rebleeding peptic ulcer causing haemorrhagic shock',
    teachingPoint:
      'Haemorrhagic shock is a volume problem, and the only definitive treatments are blood and haemostasis. ' +
      'A vasopressor raises the blood pressure by squeezing an empty tank — the number improves while the tissue perfusion does not. ' +
      'Tachycardia and a narrowing pulse pressure precede hypotension by a long way in a healthy vasculature.',
    paramOverrides: { hgb: 9.8 },
    stateOverrides: { hr: 95, svr: 13, edv: 104 },
    rrOffset: 4,
    events: [
      {
        at: HOUR + 20 * MIN,
        page: "405 had another melaenic stool, a big one. He's a bit tachy at 104 but his pressure is holding at 112/70.",
        interventions: [
          { label: 'GI bleed: volume loss', category: 'scenario', kind: 'scenario', target: 'edv', delta: -20, tauOn: 900, eliminationHalfLife: 86400 },
        ],
        hgbDelta: -1.2,
      },
      {
        at: 4 * HOUR,
        urgent: true,
        page: "He's bleeding again — the bed is soaked and it's frank blood this time. HR 132, BP 84/52. He's pale and clammy.",
        interventions: [
          // A rebleeding ulcer oozes over hours rather than exsanguinating at once.
          // The slow onset is what makes the case winnable: blood takes half an hour
          // to arrive from the bank, and the player needs to still have a patient when
          // it does. Ignored, the same insult is lethal by the small hours.
          { label: 'GI rebleed', category: 'scenario', kind: 'scenario', target: 'edv', delta: -34, tauOn: 4500, eliminationHalfLife: 86400 },
        ],
        hgbDelta: -2.2,
      },
    ],
    expectedOrders: ['lab-cbc', 'prbc', 'consult-gi', 'ns-1000', 'transfer-icu'],
    contraindicatedOrders: ['norepi', 'furosemide'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'penhale',
    name: 'Arthur Penhale',
    age: 68,
    sex: 'M',
    room: '415',
    nurse: 'Priya',
    codeStatus: 'Full Code',
    allergies: 'Penicillin (anaphylaxis)',
    admissionDx: 'COPD exacerbation',
    history: ['Severe COPD (FEV1 34%)', '50 pack-year smoking history', 'Home O2 2L'],
    signout:
      'Second day of treatment for a genuine COPD flare. On scheduled nebs and prednisone, improving slowly. ' +
      'Baseline saturation at home is 89–91%.',
    hiddenDx: 'COPD exacerbation with acute bronchospasm — the admission diagnosis is correct',
    teachingPoint:
      'Not every deterioration is a hidden diagnosis. This is bronchospasm, the obvious treatment is the right one, ' +
      'and the skill being tested is recognising that quickly and not spending the night working it up. ' +
      'Note his baseline saturation: chasing a normal number in a patient who lives at 90% causes harm.',
    stateOverrides: { hr: 87, svr: 14, edv: 114, qsQt: 0.13, pvr: 2.4 },
    rrOffset: 8,
    tempOffset: 0.2,
    events: [
      {
        at: 3 * HOUR + 20 * MIN,
        urgent: true,
        page: "Mr Penhale is wheezing all over and he's using his accessory muscles. Sat 86% on his 2 litres. He can only get out a few words at a time.",
        interventions: [
          // Bronchospasm does not self-resolve overnight. Left untreated he stays
          // hypoxic and tires; treated, the nebs and steroids reverse it quickly.
          { label: 'Bronchospasm: V/Q', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.17, tauOn: 600, eliminationHalfLife: 86400 },
          { label: 'Bronchospasm: HPV', category: 'scenario', kind: 'scenario', target: 'pvr', delta: 1.2, tauOn: 900, eliminationHalfLife: 86400 },
        ],
      },
    ],
    expectedOrders: ['duoneb', 'steroids', 'o2-nc6', 'sit-up', 'bipap'],
    contraindicatedOrders: ['ns-1000'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'demir',
    name: 'Yusuf Demir',
    age: 59,
    sex: 'M',
    room: '402',
    nurse: 'Rosa',
    codeStatus: 'Full Code',
    allergies: 'NKDA',
    admissionDx: 'Chest pain — rule out acute coronary syndrome',
    history: ['Hyperlipidaemia', 'Hypertension', 'Family history of premature CAD'],
    signout:
      'Two troponins negative, EKG unremarkable on arrival. Chest pain free since the ED. ' +
      'Planned for a stress test in the morning, likely discharge after.',
    hiddenDx: 'Anterior STEMI with cardiogenic shock',
    teachingPoint:
      'Cardiogenic shock is a pump problem: low output, high filling pressures, and pulmonary oedema together. ' +
      'The distinguishing feature from sepsis is that the patient is cold and congested rather than warm and dry. ' +
      'Fluid worsens it; the definitive treatment is reperfusion, and every minute of delay costs myocardium.',
    stateOverrides: { hr: 73, svr: 17, edv: 126 },
    rrOffset: 2,
    events: [
      {
        at: 6 * HOUR,
        urgent: true,
        page: "402 woke up with crushing chest pain, says it's worse than what brought him in. He's diaphoretic and grey. BP 98/70, HR 110.",
        interventions: [
          { label: 'STEMI: contractility↓', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.95, tauOn: 600, eliminationHalfLife: 86400 },
        ],
      },
      {
        at: 7 * HOUR,
        urgent: true,
        page: "His pressure is 82/60 now and he's short of breath on top of the pain. Sat's drifted to 89% on room air.",
        interventions: [
          { label: 'STEMI: infarct extension', category: 'scenario', kind: 'scenario', target: 'emax', delta: -0.45, tauOn: 900, eliminationHalfLife: 86400 },
        ],
      },
    ],
    expectedOrders: ['img-ekg', 'lab-trop', 'aspirin', 'consult-cards', 'transfer-icu', 'img-echo'],
    contraindicatedOrders: ['ns-1000', 'ns-500'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'marsh',
    name: 'Eileen Marsh',
    age: 84,
    sex: 'F',
    room: '421',
    nurse: 'Priya',
    codeStatus: 'DNR/DNI',
    allergies: 'NKDA',
    admissionDx: 'Aspiration pneumonia',
    history: [
      'Advanced dementia — non-verbal, fully dependent',
      'Third aspiration pneumonia in six months',
      'Weight loss, recurrent admissions',
    ],
    signout:
      'Fourth day of antibiotics, not really turning the corner. Family has been hard to reach. ' +
      'No goals-of-care conversation documented this admission. DNR/DNI confirmed on arrival.',
    hiddenDx: 'Progressive aspiration pneumonia in advanced dementia — the dying process',
    teachingPoint:
      'Escalation is not always the intervention. This patient is at the end of a long trajectory, and the ' +
      'meaningful clinical act overnight is a goals-of-care conversation, not another litre of fluid. ' +
      'Recognising which patients cannot be rescued is as much a clinical skill as recognising which can.',
    stateOverrides: { hr: 94, svr: 13.5, edv: 96, qsQt: 0.16, noTone: 0.2 },
    rrOffset: 9,
    tempOffset: 0.3,
    events: [
      {
        at: 3 * HOUR,
        page: "Mrs Marsh in 421 is satting 88% on 3 litres and her breathing looks laboured. She's not distressed, but she doesn't look comfortable either.",
        interventions: [
          { label: 'Pneumonia: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.1, tauOn: 3600, eliminationHalfLife: 86400 },
          { label: 'Pneumonia: sepsis', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.22, tauOn: 3600, eliminationHalfLife: 86400 },
        ],
      },
      {
        at: 5 * HOUR + 30 * MIN,
        page: "She's working harder to breathe and her pressure is drifting down. I don't think she's going to turn around. Do you want to talk to the family?",
        interventions: [
          { label: 'Progressive decline', category: 'scenario', kind: 'scenario', target: 'noTone', delta: 0.25, tauOn: 3600, eliminationHalfLife: 86400 },
          { label: 'Decline: shunt↑', category: 'scenario', kind: 'scenario', target: 'qsQt', delta: 0.08, tauOn: 3600, eliminationHalfLife: 86400 },
        ],
      },
    ],
    expectedOrders: ['comfort-care', 'call-attending', 'morphine-comfort', 'delirium-precautions'],
    contraindicatedOrders: ['intubate', 'norepi', 'transfer-icu'],
  },

  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'fitzgerald',
    name: 'Bonnie Fitzgerald',
    age: 44,
    sex: 'F',
    room: '410',
    nurse: 'Danny',
    codeStatus: 'Full Code',
    allergies: 'Codeine (nausea)',
    admissionDx: 'Lower extremity cellulitis',
    history: ['Obesity', 'Chronic venous stasis'],
    signout:
      'Responding nicely to IV antibiotics, erythema is receding and already marked. Likely discharge tomorrow on orals.',
    hiddenDx: 'Uncomplicated cellulitis, improving — nothing is wrong',
    teachingPoint:
      'Most overnight pages are not emergencies, and the ward will page you about all of them. ' +
      'The cost of treating every page as a crisis is paid by the patient down the hall who is actually deteriorating. ' +
      'Triage is the skill: answer this one quickly and move on.',
    stateOverrides: { hr: 76, svr: 15, edv: 122 },
    rrOffset: 1,
    events: [
      {
        at: 15 * MIN,
        page: "Hi doctor — 410 is asking for something to help her sleep. She's been up watching TV and says she can never sleep in hospital. Nothing else going on, her vitals are all fine.",
      },
      {
        at: 2 * HOUR + 40 * MIN,
        page: "Sorry, 410 again — her IV in the left hand is puffy and running slow. Erythema on the leg still looks better. Want me to just resite it?",
      },
      {
        at: 6 * HOUR + 20 * MIN,
        page: "410 wants to know if she can have something for a headache. She's otherwise fine, vitals stable, sleeping on and off.",
      },
    ],
    // Each of her pages has a matching order. Answering her quickly and moving on
    // is the correct play; working her up is the failure mode.
    expectedOrders: ['melatonin', 'iv-resite', 'acetaminophen'],
    contraindicatedOrders: ['img-ctpe', 'transfer-icu'],
  },
];
