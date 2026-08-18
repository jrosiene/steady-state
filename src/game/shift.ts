import type { HemodynamicState, HemodynamicParams, Intervention, Snapshot } from '../engine/types';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../engine/constants';
import { snapshot as computeSnapshot, applyInterventions, interventionEffect } from '../engine/hemodynamics';
import { clampEffective } from '../engine/solver';
import { stepPhysics, WARD_PHYSICS_DT } from './physics';
import { CASES } from './cases';
import { ORDER_BY_ID, O2_LABEL_PREFIX } from './orders';
import { chartVitals, resolveLabPanel, clockTime } from './clinical';
import { answerQuestion, vitalsConcern, NURSE_QUESTIONS } from './nurse';
import { attendingAdvice, specialtyAdvice } from './consults';
import {
  SHIFT_DURATION_SEC,
  type ChatMessage,
  type MessageKind,
  type PatientCase,
  type PatientRuntime,
  type PatientView,
  type ShiftPhase,
  type Vitals,
} from './types';

/** Routine observation intervals, in sim-seconds. */
const VITALS_INTERVAL_FLOOR = 4 * 3600;
const VITALS_INTERVAL_ICU = 3600;

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

/** Time from arrest to the resuscitation resolving. */
const ARREST_RESOLUTION_SEC = 8 * 60;

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

  constructor(cases: PatientCase[] = CASES) {
    this.patients = cases.map((c) => createRuntime(c));
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
      this.applyPendingEffects(p);
      this.fireCaseEvents(p);
      this.resolveLabs(p);
      this.routineObservations(p);
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
      ? chartVitals(snap, this.time, p.o2Device, p.case.tempOffset, p.case.rrOffset)
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
      if (ev.page) {
        this.post(p, 'nurse', p.case.nurse, ev.page, 'page', ev.urgent);
        p.lastPageAt = this.time;
      }
    });
  }

  // ─── Observation ──────────────────────────────────────────────────────────

  private routineObservations(p: PatientRuntime) {
    if (p.monitored) {
      // Continuous monitoring keeps the chart current without a nurse walking in.
      p.lastVitals = chartVitals(this.snapshot(p), this.time, p.o2Device, p.case.tempOffset, p.case.rrOffset);
      p.lastVitalsAt = this.time;
      return;
    }

    const interval = p.location === 'icu' ? VITALS_INTERVAL_ICU : VITALS_INTERVAL_FLOOR;
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
  takeVitals(p: PatientRuntime) {
    const snap = this.snapshot(p);
    const vitals = chartVitals(snap, this.time, p.o2Device, p.case.tempOffset, p.case.rrOffset);
    p.lastVitals = vitals;
    p.lastVitalsAt = this.time;

    this.post(p, 'nurse', p.case.nurse, formatVitals(vitals), 'vitals', false, true);

    const concern = vitalsConcern(vitals, snap);
    if (concern) {
      this.post(p, 'nurse', p.case.nurse, concern.text, 'page', concern.urgent);
      p.lastPageAt = this.time;
    }
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
          ? `I can't start ${order.label.toLowerCase()} until she's physically in the unit — we're still waiting on the bed.`
          : `I can't run ${order.label.toLowerCase()} on the floor. She'd need to go to the unit first.`,
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
    this.post(p, 'nurse', p.case.nurse, order.ack, 'ack', false, true);

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

    if (orderId === 'vitals-now') {
      this.takeVitals(p);
    }

    if (order.leadTimeSec > 0 || order.startsMonitoring || order.raisesHgb || order.o2Device) {
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

    if (order.o2Device) p.o2Device = order.o2Device;
    if (order.startsMonitoring) p.monitored = true;
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
      case 'consult-cards':
        this.post(p, 'system', 'Consult', specialtyAdvice(orderId, this.snapshot(p)), 'reply');
        break;

      case 'comfort-care':
        this.post(p, 'system', 'Goals of care', `Family reached and agreeable. ${p.case.name} is now comfort-focused: symptom management only, no escalation.`, 'event');
        break;

      case 'prbc':
        this.post(p, 'nurse', p.case.nurse, "Both units are in. I'll send a repeat count.", 'reply');
        break;
    }
  }

  /** Record how quickly the player acted once the patient became unstable. */
  private trackResponsiveness(p: PatientRuntime, category: string) {
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

  // ─── Arrest and outcomes ──────────────────────────────────────────────────

  private resolveArrest(p: PatientRuntime) {
    const snap = this.snapshot(p);

    if (p.status === 'arrested') {
      if (p.arrestResolvesAt !== null && this.time >= p.arrestResolvesAt) {
        this.concludeResuscitation(p);
      }
      return;
    }

    if (snap.cardiovascularStatus !== 'arrest') {
      if (p.firstUnstableAt === null && snap.cardiovascularStatus !== 'compensated') {
        p.firstUnstableAt = this.time;
      }
      return;
    }

    // The patient has arrested.
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
          : `${p.case.name} died at ${clockTime(this.time)}. Her code status was honoured — no resuscitation was attempted.`,
        'event',
        true,
      );
      this.version += 1;
      return;
    }

    p.status = 'arrested';
    p.arrestResolvesAt = this.time + ARREST_RESOLUTION_SEC;
    p.monitored = true;
    this.post(p, 'system', 'Code blue', `Code blue called on ${p.case.name} in ${p.case.room}. CPR in progress.`, 'event', true);
    this.version += 1;
  }

  /**
   * Decide whether the arrest is survivable.
   *
   * Survival turns on preparedness, not luck: an arrest that is witnessed and
   * monitored, or one that happens somewhere with a team already at the bedside,
   * gets immediate high-quality CPR. An unwitnessed arrest on a ward bed does not,
   * and that difference is the whole argument for escalating early.
   */
  private concludeResuscitation(p: PatientRuntime) {
    const witnessed =
      p.location === 'icu' ||
      (p.rapidResponseAt !== null && this.time - p.rapidResponseAt <= RRT_WITNESS_WINDOW);

    if (!witnessed) {
      p.status = 'died';
      p.outcome = {
        status: 'died',
        at: this.time,
        summary:
          `Died at ${clockTime(this.time)}. Unwitnessed arrest in a ward bed; ` +
          'down time before CPR began was not survivable.',
      };
      this.post(p, 'system', 'Code blue', `Resuscitation was unsuccessful. Time of death ${clockTime(this.time)}.`, 'event', true);
      this.version += 1;
      return;
    }

    // ROSC. The patient returns on full support — intubated, on an inopressor —
    // which buys time but does not treat whatever caused the arrest. If the
    // underlying physiology is not corrected, they will arrest again.
    p.status = 'stable';
    p.arrestResolvesAt = null;
    p.location = 'icu';
    p.monitored = true;
    p.o2Device = 'Vent';

    const t = p.state.time;
    p.interventions.push(
      { label: 'Post-arrest: vasopressor', category: 'treatment', kind: 'infusion', target: 'svr', delta: 11, tauOn: 60, eliminationHalfLife: 150, startTime: t },
      { label: 'Post-arrest: inotrope', category: 'treatment', kind: 'infusion', target: 'emax', delta: 0.9, tauOn: 60, eliminationHalfLife: 150, startTime: t },
      { label: `${O2_LABEL_PREFIX} Vent`, category: 'treatment', kind: 'infusion', target: 'fiO2', delta: 0.79, tauOn: 60, eliminationHalfLife: 300, startTime: t },
    );

    this.post(
      p,
      'system',
      'Code blue',
      `ROSC after ${Math.round(ARREST_RESOLUTION_SEC / 60)} minutes of CPR. ${p.case.name} is intubated and on ` +
      'noradrenaline in the ICU. The arrest bought time — it did not treat the cause.',
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
    unread: 0,
    lastReadAt: 0,
    firedEvents: [],
    lastPageAt: -Infinity,
    lastVitalsAt: 0,
    firstUnstableAt: null,
    firstActionAt: null,
    rapidResponseAt: null,
    arrestResolvesAt: null,
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
