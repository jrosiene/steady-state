import type { Snapshot } from '../engine/types';
import type { PatientRuntime } from './types';

/**
 * Advice from someone more senior, reasoned from the patient's actual physiology
 * rather than from the case's hidden label.
 *
 * This is the game's hint system, and it is deliberately built the way a good
 * curbside works: the attending does not name the diagnosis, they name the
 * physiologic pattern and tell you what would distinguish the possibilities.
 * A player who has already gathered data gets a sharper answer than one who
 * calls with nothing, because the reasoning runs off the same numbers.
 */
export function attendingAdvice(patient: PatientRuntime, snap: Snapshot): string {
  const v = patient.case.voice;
  const shocked = snap.map < 70;
  const hypoxic = snap.spO2 < 0.92;
  const congested = snap.pcwp > 20;
  const lowOutput = snap.co < 3.5;
  const vasodilated = snap.svr < 13;
  const rvStrained = snap.rvedv > 185 && snap.mPAP > 27;
  const acidotic = snap.pH < 7.3;

  // Obstructive: a pressure-overloaded RV with a low wedge is mechanical until
  // proven otherwise.
  if (rvStrained && snap.pcwp < 18) {
    return (
      `That combination — sudden hypoxaemia, a clear-ish chest, and a patient who is tanking — ` +
      `makes me think obstructive physiology rather than anything you will fix with volume. ` +
      `If the right ventricle is the problem, filling it further makes it worse. ` +
      `Get an echo at the bedside; if the RV is dilated and the septum is flat you have your answer. ` +
      `Anticoagulate unless there is a hard contraindication, and if ${v.subj} ${v.verb('stay')} hypotensive, ` +
      `that is the threshold where systemic lysis stops being optional. ${v.Subj} ${v.verb('need')} the unit either way.`
    );
  }

  // Cardiogenic: cold and congested.
  if (lowOutput && congested) {
    return (
      `Low output with high filling pressures is a pump problem. Cold and congested, not warm and dry — ` +
      `so this is not sepsis, and fluid will drown ${v.obj}. Get an EKG and a troponin right now if you have not. ` +
      `If there is ST elevation this is a reperfusion decision and the clock is myocardium. ` +
      `Call cardiology, and get ${v.obj} somewhere you can run an inotrope.`
    );
  }

  // Distributive: warm, vasodilated, acidotic.
  if (shocked && vasodilated) {
    return (
      `High output with no vascular tone is distributive shock, and at ${patient.case.age} with that history ` +
      `I would be looking hard for a source. The two things that change the trajectory are fluid and antibiotics, ` +
      `and antibiotics take hours to work — so the delay you are deciding about now is the one that matters. ` +
      `Cultures if you can get them fast, but do not hold the antibiotics for them. ` +
      `If ${v.subj} ${v.verb('need')} a pressor to hold a MAP of 65, ${v.subj} ${v.verb('need')} the unit.`
    );
  }

  // Hypovolaemic / haemorrhagic.
  if (shocked && snap.edv < 90 && !congested) {
    return (
      `Empty tank. Tachycardic, under-filled, narrow pulse pressure — ${v.subj} ${v.has} lost volume, and if ` +
      `${v.subj} ${v.is} bleeding then the only two treatments are blood and stopping the bleeding. A pressor here ` +
      `just squeezes an empty circuit and makes the number look better while the gut and the kidneys go without. ` +
      `Transfuse, get GI involved tonight rather than in the morning, and move ${v.obj} where ${v.subj} can be watched.`
    );
  }

  // Pure respiratory failure.
  if (hypoxic && !shocked) {
    if (congested) {
      return (
        `If the wedge is up, the alveoli are wet, and that is why oxygen alone is not doing much — ` +
        `you are trying to oxygenate blood that is passing flooded lung. Take the preload down: ` +
        `nitrates work faster than a diuretic, and positive pressure does both jobs at once. ` +
        `Sit ${v.obj} up while you are waiting for any of it.`
      );
    }
    return (
      `Sounds like airway obstruction rather than parenchyma or pump. Bronchodilators and steroids, ` +
      `and do not chase a normal saturation in someone whose baseline is 90 — target ${v.poss} baseline, not yours. ` +
      `If ${v.subj} ${v.is} tiring, non-invasive ventilation before ${v.subj} ${v.verb('need')} a tube.`
    );
  }

  if (acidotic) {
    return (
      `That lactate and pH tell you the tissue is not getting what it needs, whatever the blood pressure says. ` +
      `Work out which kind of shock this is before you treat it — the examination and a bedside echo ` +
      `will get you there faster than another round of labs.`
    );
  }

  if (patient.case.codeStatus === 'DNR/DNI') {
    return (
      `Before you escalate anything here, look at the trajectory. Repeated admissions, not turning around on day four ` +
      `of appropriate treatment — that is a dying patient, and no amount of fluid changes it. The valuable thing you ` +
      `can do tonight is get the family on the phone and find out what ${v.subj} would have wanted. ` +
      `That is a real intervention, not a failure to intervene.`
    );
  }

  return (
    `Nothing in what you are describing sounds like it needs me tonight. Keep an eye on the trend rather ` +
    `than any single number, and call me back if the picture changes.`
  );
}

/**
 * Specialty consult responses, likewise reasoned from physiology.
 *
 * Repeatable on purpose. A consultant's answer is a read on the patient in front
 * of them, so the same referral made two hours later is a different conversation
 * — and the moment it is most worth making the call again is exactly the moment
 * the patient has changed.
 */
export function specialtyAdvice(
  orderId: string,
  patient: PatientRuntime,
  snap: Snapshot,
  calledBefore = false,
): string {
  const v = patient.case.voice;
  const again = calledBefore ? 'Yes, I remember — ' : '';

  if (orderId === 'consult-gi') {
    const shocked = snap.map < 70;
    const activeBleed = snap.edv < 95;
    if (shocked) {
      return `GI fellow: ${again}that pressure changes things. We are not scoping ${v.obj} on the ward and we are not ` +
        `scoping ${v.obj} unresuscitated either — get blood into ${v.obj} and get ${v.obj} to the unit, and we will ` +
        `come and do it there. Call interventional radiology in parallel if ${v.subj} ${v.verb('keep')} dropping.`;
    }
    return activeBleed
      ? `GI fellow: ${again}we will scope ${v.obj} tonight. Keep transfusing to a haemoglobin of 7, keep the PPI drip running, ` +
        `and make sure ${v.subj} ${v.is} in a monitored bed before we start — I do not want to be sedating ${v.obj} on the ward.`
      : `GI fellow: ${again}sounds stable at the moment. Keep the PPI drip going and we will scope first thing. ` +
        `Call me back tonight if ${v.subj} ${v.verb('drop')} the pressure or ${v.verb('have')} another large bleed.`;
  }

  if (orderId === 'consult-cards') {
    const poorPump = snap.emaxEffective < 1.2;
    const congested = snap.pcwp > 22;
    if (poorPump) {
      return `Cardiology: ${again}with that pressure and those filling pressures I am treating this as cardiogenic shock. ` +
        `We are activating the lab. Aspirin, heparin, and do not give ${v.obj} fluid — get ${v.obj} to the unit now.`;
    }
    if (congested) {
      return `Cardiology: ${again}the pump is holding but ${v.subj} ${v.is} wet. This is a preload problem tonight, not a ` +
        `catheter one — nitrates and a diuretic, and sit ${v.obj} up. Call me back if the pressure comes off with it.`;
    }
    return `Cardiology: ${again}nothing here that needs the lab tonight. Cycle the troponins, keep ${v.obj} on telemetry, ` +
      `and we will see ${v.obj} in the morning.`;
  }

  return 'Consult acknowledged.';
}
