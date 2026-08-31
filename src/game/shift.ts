import type { HemodynamicState, HemodynamicParams, Intervention, Snapshot } from '../engine/types';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../engine/constants';
import { snapshot as computeSnapshot, applyInterventions, interventionEffect } from '../engine/hemodynamics';
import { clampEffective } from '../engine/solver';
import { stepPhysics, WARD_PHYSICS_DT } from './physics';
import { generateWard } from './content/generate';
import { makeRng, type Rng } from './content/rng';
import { ORDER_BY_ID, O2_LABEL_PREFIX } from './orders';
import { assessAppearance, chartVitals, resolveLabPanel, clockTime, type Gestalt } from './clinical';
import { answerQuestion, vitalsConcern, NURSE_QUESTIONS } from './nurse';
import { attendingAdvice, specialtyAdvice } from './consults';
import {
  SHIFT_DURATION_SEC,
  type CaseEvent,
  type ChatMessage,
  type MessageKind,
  type PatientCase,
  type PatientRuntime,
  type CodeRhythm,
  type CodeState,
  type PatientView,
  type ShiftPhase,
  type Vitals,
} from './types';

/**
 * How long a nurse holds a page that the patient has not yet earned.
 *
 * Thirty minutes: long enough that a slow-burning case declares itself on the
 * physiology rather than on a timer, short enough that a genuinely mild problem
 * still gets mentioned before the night is over.
 */
const PAGE_PATIENCE = 30 * 60;

/** Routine observation intervals, in sim-seconds. */
const VITALS_INTERVAL_FLOOR = 4 * 3600;
const VITALS_INTERVAL_ICU = 3600;
/**
 * Observations on someone the nurse is already worried about.
 *
 * Forty minutes: a ward patient escalated to hourly-or-better obs, which is what
 * happens in practice the moment anyone rings the doctor about them.
 */
const VITALS_INTERVAL_WATCHED = 40 * 60;
/** Minimum gap between nurse-initiated calls, so a fast decline is not a wall of text. */
const CALLBACK_COOLDOWN = 8 * 60;

/**
 * How long a deteriorating patient can go unnoticed before the nurse happens to
 * lay eyes on them outside the routine schedule.
 *
 * This is the safety net that keeps an unmonitored patient from dying in total
 * silence — but it is deliberately slow. A player who never asks and never
 * monitors will get the news later than one who does, which is the point.
 */
const NOTICE_INTERVAL_CRITICAL = 18 * 60;
const NOTICE_INTERVAL_SHOCK = 45 * 60;

/**
 * Time constant for haemoglobin change (seconds).
 *
 * Covers both directions: blood lost into the gut and blood transfused back in
 * equilibrate over roughly half an hour, not instantaneously. Getting this
 * timescale right matters more than it looks — oxygen-carrying capacity feeds
 * SvO2, which feeds lactate, which feeds the acidosis-contractility loop, so a
 * step change in haemoglobin detonates a feedback spiral that no treatment
 * arriving at realistic speed could ever catch.
 */
const TAU_HGB = 1800;

/** One ACLS cycle: rhythm check to rhythm check. */
const CODE_CYCLE_SEC = 2 * 60;

/**
 * Cycles before the team stops.
 *
 * Eight two-minute cycles is sixteen minutes of ACLS, which is about how long a
 * resuscitation runs before the room agrees there is nothing more to do.
 */
const MAX_CODE_CYCLES = 8;

/**
 * A re-arrest inside this window is the same resuscitation, not a new one.
 *
 * A patient whose circulation fails again three minutes after ROSC has not had
 * two codes; they have had one long one that keeps failing. Logging each as a
 * fresh event reads wrong and, worse, hands the team unlimited attempts.
 */
const RE_ARREST_WINDOW = 15 * 60;

/** Restorations of circulation before the team accepts it is not working. */
const MAX_ROSC_ATTEMPTS = 2;

/**
 * Window after a rapid response call within which an arrest counts as witnessed
 * and prepared-for. Beyond this, the team has stood down.
 */
const RRT_WITNESS_WINDOW = 20 * 60;

/**
 * Maximum physics steps processed per tick.
 *
 * A safety valve against a pathological dt (a tab left in the background, a
 * debugger pause), not a routine throttle: the UI clamps wall-clock dt before it
 * ever reaches here, so at the highest time compression a frame asks for only a
 * few dozen steps. The bound is set high enough that ordinary calls — including
 * the coarse ticks used in tests — are never silently truncated, because dropping
 * sim time would desynchronise the clock from the illness scripts.
 */
const MAX_STEPS_PER_TICK = 8000;

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * The night shift.
 *
 * Owns every patient's physiology and every channel through which the player
 * learns about it. The engine deliberately keeps the true state and the observed
 * state separate: `runtime.state` is what is happening, `runtime.lastVitals` is
 * what the player knows, and only monitoring collapses the gap between them.
 */
export class ShiftEngine {
  patients: PatientRuntime[];
  time = 0;
  phase: ShiftPhase = 'briefing';
  /** Bumped on every observable change so React can re-render cheaply. */
  version = 0;

  private snapshots = new Map<string, Snapshot>();
  /**
   * Seeded from the ward seed, so resuscitations are reproducible.
   * A code is the one place the game rolls dice, and a replayed seed has to
   * replay the same night — including whether the code worked.
   */
  private rng: Rng;

  /** The seed this ward was generated from, so a shift can be replayed. */
  readonly seed: string;

  /** How many patients the player is holding. Fixed for the life of the shift. */
  readonly size: number;

  constructor(cases?: PatientCase[], seed?: string, size?: number) {
    if (cases) {
      this.seed = seed ?? 'custom';
      this.patients = cases.map((c) => createRuntime(c));
    } else {
      const ward = generateWard({ seed, size });
      this.seed = ward.seed;
      this.patients = ward.cases.map((c) => createRuntime(c));
    }
    this.size = this.patients.length;
    this.rng = makeRng(`${this.seed}:code`);
    this.refreshSnapshots();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.phase === 'briefing') {
      this.phase = 'running';
      this.version += 1;
    }
  }

  /** Advance the shift by `dt` sim-seconds. */
  tick(dt: number) {
    if (this.phase !== 'running') return;

    let remaining = Math.min(dt, WARD_PHYSICS_DT * MAX_STEPS_PER_TICK);
    while (remaining > 1e-9) {
      const step = Math.min(WARD_PHYSICS_DT, remaining);
      remaining -= step;
      this.time += step;

      for (const p of this.patients) {
        if (isInactive(p)) continue;
        p.state = stepPhysics(p.state, p.params, p.interventions, step);

        // First-order approach to the haemoglobin target.
        if (Math.abs(p.hgbTarget - p.params.hgb) > 1e-4) {
          const alpha = 1 - Math.exp(-step / TAU_HGB);
          p.params = { ...p.params, hgb: p.params.hgb + (p.hgbTarget - p.params.hgb) * alpha };
        }
      }
    }

    this.refreshSnapshots();

    for (const p of this.patients) {
      if (isInactive(p)) continue;
      this.deliverPendingMessages(p);
      this.applyPendingEffects(p);
      this.fireCaseEvents(p);
      this.resolveLabs(p);
      this.routineObservations(p);
      this.checkGestaltRise(p);
      this.checkDeterioration(p);
      this.resolveArrest(p);
      this.pruneInterventions(p);
    }

    if (this.time >= SHIFT_DURATION_SEC) {
      this.endShift();
    }

    this.version += 1;
  }

  private endShift() {
    this.phase = 'ended';
    for (const p of this.patients) {
      if (p.outcome) continue;
      const snap = this.snapshot(p);
      p.outcome = {
        status: p.status === 'transferred' ? 'transferred' : 'stable',
        at: this.time,
        summary: describeEndState(p, snap),
      };
    }
  }

  // ─── Physiology views ─────────────────────────────────────────────────────

  private refreshSnapshots() {
    for (const p of this.patients) {
      const effective = clampEffective(
        applyInterventions(p.state, p.interventions),
        p.params,
      );
      this.snapshots.set(p.case.id, computeSnapshot(effective, p.params));
    }
  }

  snapshot(p: PatientRuntime): Snapshot {
    return this.snapshots.get(p.case.id)!;
  }

  /**
   * Temperature offset applied when charting, in °C.
   *
   * Antipyresis is deliberately modelled here rather than in the engine: it must
   * change the recorded number without touching the inflammatory tone driving it,
   * so a player who treats the fever and then trusts the chart has blinded one of
   * their own instruments while the sepsis carries on underneath.
   */
  private tempOffsetFor(p: PatientRuntime): number {
    const base = p.case.tempOffset ?? 0;
    return this.time < p.antipyreticUntil ? base - 0.9 : base;
  }

  /**
   * What the player is entitled to see for one patient.
   *
   * Monitored patients render live physiology; everyone else renders the last
   * charted set with its age, which is the information a covering doctor
   * actually has at 3 a.m.
   */
  view(p: PatientRuntime): PatientView {
    const snap = this.snapshot(p);
    const live = p.monitored && !isInactive(p);
    const displayVitals = live
      ? chartVitals(snap, this.time, p.o2Device, this.tempOffsetFor(p), p.case.rrOffset)
      : p.lastVitals;
    return {
      runtime: p,
      snapshot: snap,
      displayVitals,
      vitalsAgeSec: displayVitals ? this.time - displayVitals.time : Infinity,
      live,
    };
  }

  views(): PatientView[] {
    return this.patients.map((p) => this.view(p));
  }

  get unreadTotal(): number {
    return this.patients.reduce((n, p) => n + p.unread, 0);
  }

  // ─── Case scripts ─────────────────────────────────────────────────────────

  private fireCaseEvents(p: PatientRuntime) {
    p.case.events.forEach((ev, i) => {
      if (p.firedEvents.includes(i) || this.time < ev.at) return;
      p.firedEvents.push(i);

      if (ev.interventions) {
        for (const spec of ev.interventions) {
          p.interventions.push({ ...spec, startTime: p.state.time });
        }
      }
      if (ev.hgbDelta) {
        p.hgbTarget = Math.max(3, p.hgbTarget + ev.hgbDelta);
      }
      if (!ev.page) return;

      // The insult starts now; the phone call waits for the patient to show it.
      if (ev.pageWhen) {
        p.pendingPages.push({ event: i, sendBy: this.time + (ev.pageWhen.by ?? PAGE_PATIENCE) });
        return;
      }
      this.sendPage(p, ev.page, ev.urgent === true);
    });

    this.drainPendingPages(p);
  }

  /**
   * Release held pages once the bedside catches up with the script.
   *
   * A page is sent when the axis it is about reaches the grade it describes, or
   * when the nurse's patience runs out — whichever comes first. Either way the
   * words are generated against the gestalt at the moment of sending, so a page
   * that goes out early because the deadline expired describes a patient who is
   * only slightly off rather than one who is dying.
   */
  private drainPendingPages(p: PatientRuntime) {
    if (p.pendingPages.length === 0) return;

    const gestalt = assessAppearance(this.snapshot(p), p.case.baselineDrive);
    const still: { event: number; sendBy: number }[] = [];

    for (const pending of p.pendingPages) {
      const ev = p.case.events[pending.event];
      const trigger = ev.pageWhen!;
      const grade = trigger.axis === 'wob' ? gestalt.wob
        : trigger.axis === 'perf' ? gestalt.perf
        : Math.max(gestalt.wob, gestalt.perf);

      if (grade < (trigger.grade ?? 1) && this.time < pending.sendBy) {
        still.push(pending);
        continue;
      }
      // Urgency is what the nurse finds, not what the script hoped for.
      this.sendPage(p, ev.page!, grade >= 2, gestalt);
    }

    p.pendingPages = still;
  }

  private sendPage(
    p: PatientRuntime,
    page: NonNullable<CaseEvent['page']>,
    urgent: boolean,
    gestalt?: Gestalt,
  ) {
    const body = typeof page === 'string'
      ? page
      : page(gestalt ?? assessAppearance(this.snapshot(p), p.case.baselineDrive));

    this.post(p, 'nurse', p.case.nurse, body, 'page', urgent);
    p.lastPageAt = this.time;
    if (urgent) this.markUnstable(p);
  }

  // ─── Observation ──────────────────────────────────────────────────────────

  private routineObservations(p: PatientRuntime) {
    if (p.monitored) {
      // Continuous monitoring keeps the chart current without a nurse walking in.
      p.lastVitals = chartVitals(this.snapshot(p), this.time, p.o2Device, this.tempOffsetFor(p), p.case.rrOffset);
      p.lastVitalsAt = this.time;
      return;
    }

    // A patient the nurse has already reported on is being watched, not left for
    // the next routine round.
    const interval = p.location === 'icu' ? VITALS_INTERVAL_ICU
      : p.reportedGrade > 0 ? VITALS_INTERVAL_WATCHED
      : VITALS_INTERVAL_FLOOR;
    if (this.time - p.lastVitalsAt < interval) return;

    this.takeVitals(p);
  }

  /**
   * Chart a set of vitals, posting them to the thread and paging only if they
   * are concerning.
   *
   * The vitals line itself never marks the thread unread: charting is routine,
   * and a badge on every observation round would drown the pages that matter.
   * Concern is what raises the alarm.
   */
  takeVitals(p: PatientRuntime, { silent = false } = {}) {
    const snap = this.snapshot(p);
    const vitals = chartVitals(snap, this.time, p.o2Device, this.tempOffsetFor(p), p.case.rrOffset);
    p.lastVitals = vitals;
    p.lastVitalsAt = this.time;

    this.post(p, 'nurse', p.case.nurse, formatVitals(vitals), 'vitals', false, true);

    // `silent` charts the numbers without the commentary, for the case where the
    // nurse has just said the same thing in their own words.
    const concern = silent ? null : vitalsConcern(vitals, snap, p.case.baselineDrive);
    if (concern) {
      this.post(p, 'nurse', p.case.nurse, concern.text, 'page', concern.urgent);
      p.lastPageAt = this.time;
      if (concern.urgent) this.markUnstable(p);
    }
  }

  /**
   * The call-back: a nurse rings again when the patient is worse than the last
   * thing they told you.
   *
   * Without this the only unprompted channel was `checkDeterioration`, which
   * keys off cardiovascular status — so a patient drowning at a saturation of 60%
   * with an intact blood pressure was 'compensated', said nothing, and turned up
   * four hours later on the routine observation round already unsalvageable. That
   * is not how a ward works. Whoever paged you about someone keeps looking at
   * them, and rings back when the picture changes for the worse.
   *
   * The trigger is a *rise* against what has already been reported, which is why
   * a patient who was handed over unwell does not page immediately, and a patient
   * who improves and then deteriorates again pages a second time.
   */
  private checkGestaltRise(p: PatientRuntime) {
    if (p.status !== 'stable' || isInactive(p)) return;

    const snap = this.snapshot(p);
    if (snap.cardiovascularStatus === 'arrest') return;

    const gestalt = assessAppearance(snap, p.case.baselineDrive);
    const grade = Math.max(gestalt.wob, gestalt.perf);

    // Improvement resets the reference: the nurse's sense of the patient tracks
    // the patient, so getting better and worse again is worth a second call.
    if (grade <= p.reportedGrade) {
      p.reportedGrade = grade;
      return;
    }
    if (this.time - p.lastPageAt < CALLBACK_COOLDOWN) return;

    p.reportedGrade = grade;
    const v = p.case.voice;
    const lead = grade >= 2
      ? `Calling you back about ${p.case.room} — ${v.subj} ${v.is} worse than when I rang.`
      : `Just so you know, ${p.case.room} has changed since I last looked.`;

    this.post(p, 'nurse', p.case.nurse, `${lead} ${capitalise(gestalt.text)}.`, 'page', grade >= 2);
    p.lastPageAt = this.time;
    if (grade >= 2) this.markUnstable(p);

    // The nurse who went in to look also charts what they found — the numbers,
    // without repeating back the impression they have just given.
    this.takeVitals(p, { silent: true });
  }

  /**
   * Unscheduled notice: a nurse walking past a patient who is visibly unwell.
   * Rate-limited so a deteriorating patient produces escalating concern rather
   * than a wall of identical pages.
   */
  private checkDeterioration(p: PatientRuntime) {
    if (p.status !== 'stable') return;
    const snap = this.snapshot(p);
    const status = snap.cardiovascularStatus;
    if (status === 'compensated' || status === 'arrest') return;

    const interval = status === 'decompensating'
      ? NOTICE_INTERVAL_CRITICAL
      : NOTICE_INTERVAL_SHOCK;

    if (this.time - p.lastPageAt < interval) return;

    // The nurse takes a set when they notice, so the chart catches up too.
    this.takeVitals(p);
    p.lastPageAt = this.time;
  }

  // ─── Labs ─────────────────────────────────────────────────────────────────

  private resolveLabs(p: PatientRuntime) {
    const due = p.pendingLabs.filter((l) => this.time >= l.resultsAt);
    if (due.length === 0) return;
    p.pendingLabs = p.pendingLabs.filter((l) => this.time < l.resultsAt);

    for (const pending of due) {
      // Labs reflect the physiology at the moment the sample was drawn, not now.
      const result = resolveLabPanel(
        pending.panel,
        this.snapshot(p),
        p.params,
        pending.drawnAt,
        this.time,
        nextId('lab'),
        p.case.findings,
      );
      p.labs.push(result);
      this.post(p, 'system', 'Results', formatLab(result), 'result', isCriticalResult(result));
    }
  }

  // ─── Orders ───────────────────────────────────────────────────────────────

  /**
   * Place an order. Returns null on success, or a refusal message explaining
   * why the order cannot be carried out.
   */
  placeOrder(p: PatientRuntime, orderId: string): string | null {
    const order = ORDER_BY_ID[orderId];
    if (!order) return 'Unknown order.';
    if (isInactive(p)) return 'This patient is no longer under your care.';

    if (order.once && p.orders.some((o) => o.orderId === orderId)) {
      return `${order.label} is already ordered.`;
    }

    // Vasoactive infusions and mechanical ventilation cannot run on a ward bed.
    // This is the constraint that forces the escalation decision to be made
    // explicitly and early, rather than discovered at the moment of crisis.
    if (order.requiresIcu && p.location !== 'icu') {
      const transferPending = p.pendingEffects.some((e) => e.orderId === 'transfer-icu');
      this.post(
        p,
        'nurse',
        p.case.nurse,
        transferPending
          ? `I can't start ${order.label.toLowerCase()} until ${p.case.voice.subj} ${p.case.voice.is} physically in the unit — we're still waiting on the bed.`
          : `I can't run ${order.label.toLowerCase()} on the floor. ${p.case.voice.Subj} would need to go to the unit first.`,
        'reply',
        false,
      );
      return `${order.label} requires ICU-level care.`;
    }

    const effectiveAt = this.time + order.leadTimeSec;

    p.orders.push({
      id: nextId('order'),
      orderId,
      label: order.label,
      category: order.category,
      placedAt: this.time,
      effectiveAt,
    });

    this.post(p, 'doctor', 'You', `Order: ${order.label}`, 'order');
    // Acknowledgements are not news — the player is looking at this thread right
    // now, having just acted in it. Counting them as unread would bury real pages.
    const ack = typeof order.ack === 'function' ? order.ack(p.case.voice) : order.ack;
    this.postLater(p, this.replyDelay(), 'nurse', p.case.nurse, ack, 'ack', false, true);

    // Oxygen devices replace one another rather than stacking.
    if (order.o2Device) {
      for (const iv of p.interventions) {
        if (iv.label.startsWith(O2_LABEL_PREFIX) && iv.stopTime === undefined) {
          iv.stopTime = p.state.time;
        }
      }
    }

    if (order.interventions) {
      for (const spec of order.interventions) {
        // Future-dated: interventionEffect returns 0 until the start time passes.
        p.interventions.push({ ...spec, startTime: p.state.time + order.leadTimeSec });
      }
    }

    if (order.lab) {
      p.pendingLabs.push({
        orderId,
        panel: order.lab.panel,
        drawnAt: this.time,
        resultsAt: this.time + order.leadTimeSec + order.lab.turnaroundSec,
      });
    }

    if (order.leadTimeSec > 0 || order.startsMonitoring || order.raisesHgb || order.o2Device
        || orderId === 'vitals-now') {
      p.pendingEffects.push({ at: effectiveAt, orderId });
    } else {
      this.applyOrderEffect(p, orderId);
    }

    this.trackResponsiveness(p, order.category);
    this.version += 1;
    return null;
  }

  private applyPendingEffects(p: PatientRuntime) {
    const due = p.pendingEffects.filter((e) => this.time >= e.at);
    if (due.length === 0) return;
    p.pendingEffects = p.pendingEffects.filter((e) => this.time < e.at);
    for (const e of due) this.applyOrderEffect(p, e.orderId);
  }

  private applyOrderEffect(p: PatientRuntime, orderId: string) {
    const order = ORDER_BY_ID[orderId];
    if (!order) return;

    // The nurse has now been in and taken them.
    if (orderId === 'vitals-now') this.takeVitals(p);

    if (order.o2Device) p.o2Device = order.o2Device;
    if (order.startsMonitoring) p.monitored = true;
    if (order.antipyreticHours) {
      p.antipyreticUntil = this.time + order.antipyreticHours * 3600;
    }
    if (order.raisesHgb) {
      p.hgbTarget = Math.min(18, p.hgbTarget + order.raisesHgb);
    }

    switch (orderId) {
      case 'transfer-icu':
        p.location = 'icu';
        if (p.status === 'stable') p.status = 'transferred';
        this.post(p, 'system', 'Bed control', `${p.case.name} has arrived in the ICU. You can now run vasoactive infusions.`, 'event');
        break;

      case 'rapid-response':
        p.rapidResponseAt = this.time;
        this.post(p, 'system', 'Rapid response', 'RRT and respiratory are at the bedside. The patient is on a monitor.', 'event');
        break;

      case 'call-attending':
        this.post(p, 'system', 'Dr Adeyemi (attending)', attendingAdvice(p, this.snapshot(p)), 'reply');
        break;

      case 'consult-gi':
      case 'consult-cards': {
        // A call-back is a different conversation from a first referral, and the
        // answer is read off the patient as they are now.
        const calledBefore = p.orders.filter((o) => o.orderId === orderId).length > 1;
        this.post(
          p, 'system', 'Consult',
          specialtyAdvice(orderId, p, this.snapshot(p), calledBefore),
          'reply',
        );
        break;
      }

      case 'comfort-care':
        this.post(p, 'system', 'Goals of care', `Family reached and agreeable. ${p.case.name} is now comfort-focused: symptom management only, no escalation.`, 'event');
        break;

      case 'prbc':
        this.post(p, 'nurse', p.case.nurse, "Both units are in. I'll send a repeat count.", 'reply');
        break;
    }
  }

  /**
   * Start the response clock.
   *
   * Deliberately triggered by the first urgent page as well as by decompensation.
   * A patient who compensates right up to the cliff — which is most of them —
   * would otherwise leave almost no measurable window, and the question worth
   * scoring is how long the player took from being told something was wrong, not
   * from the moment the pressure finally failed.
   */
  private markUnstable(p: PatientRuntime) {
    if (p.firstUnstableAt === null) p.firstUnstableAt = this.time;
  }

  /** Record how quickly the player acted once the patient became unstable. */
  private trackResponsiveness(p: PatientRuntime, category: string) {
    // 'comfort' is deliberately excluded: a sleeping tablet is not a response to
    // a deteriorating patient, and counting it as one would flatter the player.
    const therapeutic = category === 'fluids' || category === 'pressors'
      || category === 'respiratory' || category === 'meds' || category === 'disposition';
    if (therapeutic && p.firstUnstableAt !== null && p.firstActionAt === null) {
      p.firstActionAt = this.time;
    }
  }

  // ─── Player questions ─────────────────────────────────────────────────────

  askQuestion(p: PatientRuntime, questionId: string) {
    const question = NURSE_QUESTIONS.find((q) => q.id === questionId);
    if (!question || isInactive(p)) return;
    this.post(p, 'doctor', 'You', question.text, 'question');
    this.post(p, 'nurse', p.case.nurse, answerQuestion(questionId, p, this.snapshot(p)), 'reply');
    this.version += 1;
  }

  markRead(p: PatientRuntime) {
    p.lastReadAt = this.time;
    if (p.unread !== 0) {
      p.unread = 0;
      this.version += 1;
    }
  }

  /** True when this patient has an urgent page the player has not opened. */
  hasUnreadUrgent(p: PatientRuntime): boolean {
    if (p.status === 'died') return false;
    return p.unread > 0 && p.messages.some((m) => m.urgent && m.time > p.lastReadAt);
  }

  // ─── Arrest and resuscitation ─────────────────────────────────────────────

  private resolveArrest(p: PatientRuntime) {
    const snap = this.snapshot(p);

    if (p.status === 'arrested') {
      if (p.code && this.time >= p.code.nextCycleAt) this.runCodeCycle(p);
      return;
    }

    if (snap.cardiovascularStatus !== 'arrest') {
      if (snap.cardiovascularStatus !== 'compensated') this.markUnstable(p);
      return;
    }

    this.beginArrest(p, snap);
  }

  private beginArrest(p: PatientRuntime, snap: Snapshot) {
    const comfortFocused = p.orders.some((o) => o.orderId === 'comfort-care');
    const dnr = p.case.codeStatus === 'DNR/DNI';

    if (dnr || comfortFocused) {
      p.status = 'died';
      p.outcome = {
        status: 'died',
        at: this.time,
        summary: comfortFocused
          ? `Died at ${clockTime(this.time)} with comfort measures in place, family present.`
          : `Died at ${clockTime(this.time)}. DNR/DNI honoured; no resuscitation attempted.`,
      };
      this.post(
        p,
        'system',
        'Ward',
        comfortFocused
          ? `${p.case.name} died peacefully at ${clockTime(this.time)}. The family were at the bedside.`
          : `${p.case.name} died at ${clockTime(this.time)}. The code status was honoured — no resuscitation was attempted.`,
        'event',
        true,
      );
      this.version += 1;
      return;
    }

    // Repeated failure of the same resuscitation. A team who have restored
    // circulation twice and watched it fail again within minutes stop, because the
    // problem is the physiology and not the effort.
    if (
      p.lastRoscAt !== null &&
      this.time - p.lastRoscAt < RE_ARREST_WINDOW &&
      p.roscCount >= MAX_ROSC_ATTEMPTS
    ) {
      p.status = 'died';
      p.outcome = {
        status: 'died',
        at: this.time,
        summary:
          `Died at ${clockTime(this.time)} after ${p.roscCount} periods of return of circulation, ` +
          'each lost again within minutes. The underlying cause was never reversed.',
      };
      this.post(
        p,
        'system',
        'Code blue',
        `${p.case.name} has arrested again, minutes after the last ROSC. The team have stopped — ` +
          `they can restart the heart but nothing has treated what is stopping it. Time of death ${clockTime(this.time)}.`,
        'event',
        true,
      );
      this.version += 1;
      return;
    }

    // Witnessed means someone saw it happen or the monitor caught it. That single
    // fact does more for survival than anything the code team will do next, and it
    // was decided hours earlier by whether the player put them on a monitor.
    const witnessed =
      p.monitored ||
      p.location === 'icu' ||
      (p.rapidResponseAt !== null && this.time - p.rapidResponseAt <= RRT_WITNESS_WINDOW);

    p.status = 'arrested';
    p.monitored = true;
    p.code = {
      startedAt: this.time,
      cycle: 0,
      nextCycleAt: this.time + CODE_CYCLE_SEC,
      rhythm: this.arrestRhythm(p, this.snapshot(p)),
      shocks: 0,
      epiDoses: 0,
      // A patient who arrests again after a ROSC still has the tube in.
      intubated: p.o2Device === 'Vent',
      witnessed,
      causeAddressed: causeIsBeingTreated(p),
    };

    this.post(
      p,
      'system',
      'Code blue',
      `Code blue, room ${p.case.room}. ${witnessed ? 'Witnessed arrest' : 'Found unresponsive'} — ` +
        `CPR in progress, rhythm is ${p.code.rhythm}. Critical care are at the bedside.`,
      'event',
      true,
    );
    void snap;
    this.version += 1;
  }

  /**
   * What rhythm the patient arrests in, from how they got there.
   *
   * A primary pump failure fibrillates. Someone who has been bleeding, obstructed
   * or hypoxic arrests in PEA — a heart still trying to beat against a problem
   * nobody has fixed. Someone profoundly acidotic for an hour has nothing left and
   * arrests in asystole, which is the rhythm with almost no survivors.
   */
  private arrestRhythm(p: PatientRuntime, snap: Snapshot): CodeRhythm {
    if (snap.pH < 7.0) return this.rng.chance(0.72) ? 'asystole' : 'PEA';

    // A full ventricle is part of the definition, and the reason it has to be
    // stated: PCWP is (EDV − V0) × stiffness / emax, so as contractility
    // approaches its clamp floor the wedge diverges no matter how empty the
    // patient is. Every terminal patient therefore looked congested, and a
    // haemorrhage that had bled its way down to an end-diastolic volume of 68
    // arrested in ventricular fibrillation — which is not a rhythm a bleeding
    // patient arrests in, and told the player the wrong thing about why.
    const filled = snap.edv > p.params.edvRef * 0.85;
    const primaryCardiac = filled && snap.emaxEffective < 1.0 && snap.pcwp > 20;
    if (primaryCardiac && this.rng.chance(0.45)) {
      return this.rng.chance(0.7) ? 'VF' : 'pulseless VT';
    }
    return this.rng.chance(0.78) ? 'PEA' : 'asystole';
  }

  /** One two-minute cycle of ACLS. */
  private runCodeCycle(p: PatientRuntime) {
    const code = p.code!;
    code.cycle += 1;
    code.nextCycleAt = this.time + CODE_CYCLE_SEC;
    // Re-checked every cycle, so a player who works out the cause mid-code and
    // orders the treatment still changes the odds.
    code.causeAddressed = causeIsBeingTreated(p);

    const t = p.state.time;
    const beats: string[] = [];

    // The airway goes in first.
    if (!code.intubated) {
      code.intubated = true;
      p.o2Device = 'Vent';
      p.interventions.push(
        { label: `${O2_LABEL_PREFIX} Vent`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.79, tauOn: 30, eliminationHalfLife: 600, startTime: t },
        { label: 'Vent recruitment', category: 'treatment', kind: 'infusion', target: 'qsQt', delta: -0.1, tauOn: 120, eliminationHalfLife: 600, startTime: t },
      );
      beats.push('airway secured and the tube is confirmed');
    }

    // Shock a shockable rhythm; adrenaline every other cycle otherwise.
    if (code.rhythm === 'VF' || code.rhythm === 'pulseless VT') {
      code.shocks += 1;
      beats.push(`shocked at ${code.shocks === 1 ? 200 : 360} joules`);
      // Repeated shocks degrade a fibrillating heart toward PEA or asystole.
      if (code.shocks >= 2 && this.rng.chance(0.4)) {
        code.rhythm = this.rng.chance(0.6) ? 'PEA' : 'asystole';
        beats.push(`rhythm has degenerated to ${code.rhythm}`);
      }
    }

    if (code.cycle % 2 === 1) {
      code.epiDoses += 1;
      p.interventions.push(
        { label: 'Adrenaline (code)', category: 'treatment', kind: 'bolus', target: 'svr', delta: 7, tauOn: 30, eliminationHalfLife: 180, startTime: t },
        { label: 'Adrenaline (code, inotropy)', category: 'treatment', kind: 'bolus', target: 'emax', delta: 0.6, tauOn: 30, eliminationHalfLife: 180, startTime: t },
      );
      beats.push(`adrenaline given, dose ${code.epiDoses}`);
    }

    // Report what the team did before checking whether it worked. Rolling first
    // and narrating second loses the beat entirely on a cycle that achieves ROSC —
    // the airway went in and the adrenaline was given, and nobody heard about it.
    const askAboutCause = code.cycle === 2 && !code.causeAddressed;
    const detail = beats.length > 0 ? ` — ${beats.join(', ')}` : '';
    this.post(
      p,
      'system',
      'Code blue',
      `${minutesInto(code, this.time)} minutes in. Rhythm check: ${code.rhythm}${detail}.` +
        (askAboutCause ? ' The team are asking whether there is a reversible cause they should be treating.' : ''),
      'event',
      askAboutCause,
    );

    const snap = this.snapshot(p);
    if (this.rng.chance(roscChance(code, snap))) {
      this.achieveRosc(p, code);
      return;
    }

    if (code.cycle >= MAX_CODE_CYCLES) {
      this.concludeCode(p, code);
      return;
    }

    this.version += 1;
  }

  /**
   * Return of spontaneous circulation.
   *
   * The post-arrest state is set explicitly rather than integrated out of the
   * arrest, because ROSC genuinely is a discontinuity: circulation resumes at once
   * onto a heart that has been stunned and a metabolic debt that has not yet been
   * repaid. Whatever caused the arrest is still running underneath, which is why a
   * patient who is not also treated will simply arrest again.
   */
  private achieveRosc(p: PatientRuntime, code: CodeState) {
    const minutes = minutesInto(code, this.time);
    const t = p.state.time;

    p.status = 'stable';
    p.code = null;
    p.roscCount += 1;
    p.lastRoscAt = this.time;
    p.location = 'icu';
    p.monitored = true;
    p.o2Device = 'Vent';

    p.state = {
      ...p.state,
      hr: 98,
      svr: 18,
      // Post-arrest myocardial stunning: the heart resumes, weakened.
      emax: Math.max(0.6, p.state.emax * 0.78),
      // The oxygen debt is real, but restored circulation starts repaying it —
      // and leaving it at the arrest value puts the pH low enough that the
      // acidosis penalty alone re-arrests the patient within a minute.
      lactate: Math.min(p.state.lactate, 7),
    };

    p.interventions.push(
      { label: 'Post-arrest: noradrenaline', category: 'treatment', kind: 'infusion', target: 'svr', delta: 9, tauOn: 60, eliminationHalfLife: 150, startTime: t },
      { label: 'Post-arrest: inotrope', category: 'treatment', kind: 'infusion', target: 'emax', delta: 0.7, tauOn: 60, eliminationHalfLife: 150, startTime: t },
    );

    this.post(
      p,
      'system',
      'Code blue',
      `ROSC at ${clockTime(this.time)}, after ${minutes} minutes of CPR and ${code.epiDoses} dose${code.epiDoses === 1 ? '' : 's'} of adrenaline. ` +
        `${p.case.name} is intubated, on noradrenaline, and going to the unit. ` +
        `The arrest bought time — it did not treat whatever caused it.`,
      'event',
      true,
    );
    this.version += 1;
  }

  /** The team stops. */
  private concludeCode(p: PatientRuntime, code: CodeState) {
    const minutes = minutesInto(code, this.time);
    p.status = 'died';
    p.code = null;
    p.outcome = {
      status: 'died',
      at: this.time,
      summary: code.witnessed
        ? `Died at ${clockTime(this.time)} after ${minutes} minutes of resuscitation for ${code.rhythm}.`
        : `Died at ${clockTime(this.time)}. Unwitnessed arrest on a ward bed; ${minutes} minutes of CPR without response.`,
    };
    this.post(
      p,
      'system',
      'Code blue',
      `${minutes} minutes of ACLS with no return of circulation. The team agreed to stop. ` +
        `Time of death ${clockTime(this.time)}.`,
      'event',
      true,
    );
    this.version += 1;
  }

  // ─── Housekeeping ─────────────────────────────────────────────────────────

  /** Drop interventions that have fully washed out so the overlay stays O(active). */
  private pruneInterventions(p: PatientRuntime) {
    if (p.interventions.length < 24) return;
    const t = p.state.time;
    p.interventions = p.interventions.filter(
      (iv) => iv.stopTime === undefined || Math.abs(interventionEffect(iv, t)) > 0.001,
    );
  }

  private post(
    p: PatientRuntime,
    author: ChatMessage['author'],
    authorName: string,
    text: string,
    kind: MessageKind,
    urgent = false,
    silent = false,
  ) {
    p.messages.push({
      id: nextId('msg'),
      author,
      authorName,
      text,
      time: this.time,
      kind,
      urgent,
    });
    if (author !== 'doctor' && !silent) p.unread += 1;
  }

  /**
   * Post a message after a short delay, as though someone had to do something
   * before they could reply.
   */
  private postLater(
    p: PatientRuntime,
    delaySec: number,
    author: ChatMessage['author'],
    authorName: string,
    text: string,
    kind: MessageKind,
    urgent = false,
    silent = false,
  ) {
    p.pendingMessages.push({
      at: this.time + delaySec,
      author,
      authorName,
      text,
      kind,
      urgent,
      silent,
    });
  }

  private deliverPendingMessages(p: PatientRuntime) {
    if (p.pendingMessages.length === 0) return;
    const due = p.pendingMessages.filter((m) => this.time >= m.at);
    if (due.length === 0) return;
    p.pendingMessages = p.pendingMessages.filter((m) => this.time < m.at);
    for (const m of due) {
      this.post(p, m.author, m.authorName, m.text, m.kind, m.urgent, m.silent);
    }
  }

  /**
   * How long the nurse takes to text back.
   *
   * Short and variable. The point is not to make the player wait — it is that a
   * reply arriving in the same instant as the order reads as a machine, and one
   * arriving a beat later reads as a person who looked up from what they were
   * doing. Sim-seconds, so it scales with the shift speed the player chose.
   */
  private replyDelay(): number {
    return this.rng.int(20, 55);
  }
}

// ─── Construction ───────────────────────────────────────────────────────────

function createRuntime(c: PatientCase): PatientRuntime {
  const params: HemodynamicParams = { ...DEFAULT_PARAMS, ...c.paramOverrides };
  const state: HemodynamicState = { ...DEFAULT_STATE, ...c.stateOverrides };

  // Keep the reference volumes consistent with any overridden resting state, so
  // the venous-return coupling and RV dilation model are centred on this patient.
  params.edvRef = state.edv;
  params.rvedvRef = state.rvedv;
  params.pvrRef = state.pvr;
  params.hrBaseline = state.hr;
  params.svrBaseline = state.svr;
  // emaxRef is intentionally NOT re-derived from a case's emax override.
  // Contractility is meaningful only relative to the population reference: a case
  // that sets emax below emaxRef is declaring a weak ventricle, and rebasing the
  // reference onto it would silently restore normal contractility and normal
  // output. A case that genuinely wants a different reference sets it explicitly.

  // Anchor the baroreflex to the pressure this patient actually generates at rest.
  //
  // Without this, every case would defend the population setpoint of 90 mmHg and
  // immediately drift away from its own starting vitals — a patient with chronic
  // heart failure would be dragged toward a blood pressure they have not had in
  // years. Setting the setpoint to the resting MAP makes the error term zero at
  // t=0, so each patient begins in genuine equilibrium and only moves when
  // something is actually done to them.
  if (c.paramOverrides?.mapSetpoint === undefined) {
    params.mapSetpoint = computeSnapshot(state, params).map;
  }

  // How this patient looked when the day team handed them over.
  const handoverGestalt = assessAppearance(computeSnapshot(state, params), c.baselineDrive);

  const runtime: PatientRuntime = {
    case: c,
    state,
    params,
    interventions: [] as Intervention[],
    location: 'floor',
    status: 'stable',
    hgbTarget: params.hgb,
    monitored: false,
    o2Device: c.stateOverrides?.fiO2 && c.stateOverrides.fiO2 > 0.21 ? '2L NC' : 'RA',
    lastVitals: null,
    labs: [],
    pendingLabs: [],
    messages: [],
    orders: [],
    pendingEffects: [],
    pendingMessages: [],
    unread: 0,
    antipyreticUntil: -Infinity,
    lastReadAt: 0,
    firedEvents: [],
    pendingPages: [],
    lastPageAt: -Infinity,
    // Seeded from how the patient looks at handover, so someone who arrives on
    // the shift already unwell is not paged about for being what they were.
    reportedGrade: Math.max(handoverGestalt.wob, handoverGestalt.perf),
    lastVitalsAt: 0,
    firstUnstableAt: null,
    firstActionAt: null,
    rapidResponseAt: null,
    code: null,
    roscCount: 0,
    lastRoscAt: null,
    outcome: null,
  };

  // Sign-out vitals: what the day team charted before handing over.
  const snap = computeSnapshot(state, params);
  runtime.lastVitals = chartVitals(snap, 0, runtime.o2Device, c.tempOffset, c.rrOffset);

  return runtime;
}

/** Patients who no longer need physiology stepped or events fired. */
export function isInactive(p: PatientRuntime): boolean {
  return p.status === 'died';
}

// ─── Resuscitation odds ─────────────────────────────────────────────────────

/**
 * Per-cycle chance of return of spontaneous circulation.
 *
 * Calibrated against what in-hospital arrest actually achieves. A witnessed,
 * monitored arrest with a reversible cause already being treated comes out around
 * 55–60% ROSC across a full code; an unwitnessed asystolic arrest in a patient who
 * has been acidotic for an hour comes out near 10%. Those are roughly the real
 * numbers, and the spread between them is entirely made of decisions the player
 * took hours earlier.
 *
 * The per-cycle chance decays: a heart that has not restarted in the first four
 * minutes is markedly less likely to restart in the next four.
 */
export function roscChance(code: CodeState, snap: Snapshot): number {
  // Whether anyone saw it happen dominates everything else.
  let p = code.witnessed ? 0.18 : 0.05;

  // Shockable rhythms are the ones with survivors.
  if (code.rhythm === 'VF' || code.rhythm === 'pulseless VT') p += 0.12;

  // Treating the cause is what makes the arrest reversible rather than terminal.
  if (code.causeAddressed) p += 0.1;

  // A profoundly acidotic myocardium does not respond to adrenaline.
  if (snap.pH < 7.0) p -= 0.06;

  p *= Math.pow(0.7, Math.max(0, code.cycle - 1));
  return Math.max(0.01, Math.min(0.6, p));
}

/**
 * Whether the reversible cause is actually being treated.
 *
 * Read from the orders the player has standing: two or more of the case's key
 * therapeutic measures counts as the cause being addressed. Diagnostics do not
 * count — knowing what is wrong does not resuscitate anybody.
 */
export function causeIsBeingTreated(p: PatientRuntime): boolean {
  const placed = new Set(p.orders.map((o) => o.orderId));
  const therapeutic = p.case.expectedOrders.filter((id) => {
    if (!placed.has(id)) return false;
    const category = ORDER_BY_ID[id]?.category;
    return category !== 'labs' && category !== 'imaging' && category !== 'nursing';
  });
  return therapeutic.length >= 2;
}

/** Whole minutes since the code started. */
function minutesInto(code: CodeState, now: number): number {
  return Math.max(1, Math.round((now - code.startedAt) / 60));
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function formatVitals(v: Vitals): string {
  return (
    `Vitals — BP ${v.sbp}/${v.dbp} (MAP ${v.map}) · HR ${v.hr} · RR ${v.rr} · ` +
    `SpO₂ ${v.spo2}% on ${v.o2} · T ${v.tempC.toFixed(1)}°C`
  );
}

function formatLab(result: ReturnType<typeof resolveLabPanel>): string {
  if (result.impression) return `${result.panel}: ${result.impression}`;
  const parts = result.values.map(
    (v) => `${v.label} ${v.value.toFixed(v.decimals)}${v.unit ? ' ' + v.unit : ''}`,
  );
  return `${result.panel} — ${parts.join(' · ')}`;
}

function isCriticalResult(result: ReturnType<typeof resolveLabPanel>): boolean {
  return result.values.some((v) => v.critical);
}

function describeEndState(p: PatientRuntime, snap: Snapshot): string {
  if (p.location === 'icu') {
    return snap.cardiovascularStatus === 'compensated'
      ? 'Stabilised and handed over in the ICU.'
      : 'Still critically unwell in the ICU at handover.';
  }
  switch (snap.cardiovascularStatus) {
    case 'compensated':
      return 'Stable on the ward at handover.';
    case 'shock':
      return 'Still in shock on a ward bed at handover — never escalated.';
    default:
      return 'Critically unwell on a ward bed at handover — never escalated.';
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
