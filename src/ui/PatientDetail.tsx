import { useState } from 'react';
import type { PatientView, LabResult, Vitals, OrderCategory } from '../game/types';
import { ORDERS, ORDER_CATEGORIES } from '../game/orders';
import { ageLabel, clockTime, isAbnormal } from '../game/clinical';
import { HandoffCard } from './HandoffCard';

/**
 * The right-hand column: what is known about this patient, and everything the
 * player can do about it.
 */
export function PatientDetail({
  view,
  onOrder,
  time,
}: {
  view: PatientView;
  onOrder: (orderId: string) => void;
  time: number;
}) {
  const { runtime: p, displayVitals, vitalsAgeSec, live } = view;
  const dead = p.status === 'died';

  return (
    <div className="scroll">
      <div className="detail">
        <div className="section-title">Patient</div>
        <div className="chart-line">
          <strong>{p.case.name}</strong>, {p.case.age}{p.case.sex} · Room {p.case.room}
          <br />
          {p.case.admissionDx}
          <br />
          <span style={{ color: 'var(--text-faint)' }}>
            {p.case.history.join(' · ')}
          </span>
          <br />
          <span style={{ color: 'var(--text-faint)' }}>
            Allergies: {p.case.allergies} · {p.case.codeStatus}
          </span>
        </div>

        <details className="handoff-details">
          <summary>Day team handoff</summary>
          <HandoffCard handoff={p.case.handoff} compact />
        </details>

        <div className="section-title">Vitals</div>
        <VitalsCard vitals={displayVitals} ageSec={vitalsAgeSec} live={live} dead={dead} />

        {p.labs.length > 0 && (
          <>
            <div className="section-title">Results</div>
            {[...p.labs].reverse().map((l) => (
              <LabCard key={l.id} lab={l} />
            ))}
          </>
        )}

        {p.pendingLabs.length > 0 && (
          <>
            <div className="section-title">Pending</div>
            <div className="active-orders">
              {p.pendingLabs.map((l, i) => (
                <span key={i} className="order-chip pending">
                  {l.panel} · back ~{clockTime(l.resultsAt)}
                </span>
              ))}
            </div>
          </>
        )}

        {p.orders.length > 0 && (
          <>
            <div className="section-title">Orders placed</div>
            <div className="active-orders">
              {p.orders.map((o) => (
                <span
                  key={o.id}
                  className={`order-chip${time < o.effectiveAt ? ' pending' : ''}`}
                  title={time < o.effectiveAt ? `Takes effect ${clockTime(o.effectiveAt)}` : undefined}
                >
                  {o.label}
                  {time < o.effectiveAt ? ' …' : ''}
                </span>
              ))}
            </div>
          </>
        )}

        <div className="section-title">Place an order</div>
        <OrderPalette patient={view} onOrder={onOrder} disabled={dead} />
      </div>
    </div>
  );
}

function VitalsCard({
  vitals,
  ageSec,
  live,
  dead,
}: {
  vitals: Vitals | null;
  ageSec: number;
  live: boolean;
  dead: boolean;
}) {
  if (dead) {
    return <div className="vitals-card"><div className="empty" style={{ padding: 14 }}>Patient deceased.</div></div>;
  }
  if (!vitals) {
    return <div className="vitals-card"><div className="empty" style={{ padding: 14 }}>No vitals charted.</div></div>;
  }

  // Staleness is the point of this component: an hours-old set of vitals is a
  // statement about a patient who no longer exists.
  const staleClass = live ? '' : ageSec > 7200 ? ' very-stale' : ageSec > 3600 ? ' stale' : '';

  return (
    <div className="vitals-card">
      <div className={`staleness${staleClass}`}>
        {live ? (
          <>
            <span className="dot ok" />
            <span>LIVE · continuous monitoring</span>
          </>
        ) : (
          <span>Charted {clockTime(vitals.time)} · {ageLabel(ageSec)}</span>
        )}
      </div>

      <div className="vitals-grid">
        <Vital
          label="BP"
          value={`${vitals.sbp}/${vitals.dbp}`}
          bad={vitals.map < 60}
          warn={vitals.map < 70}
        />
        <Vital label="MAP" value={vitals.map} bad={vitals.map < 60} warn={vitals.map < 70} />
        <Vital label="HR" value={vitals.hr} bad={vitals.hr > 130 || vitals.hr < 45} warn={vitals.hr > 110} />
        <Vital label="RR" value={vitals.rr} bad={vitals.rr > 30} warn={vitals.rr > 22} />
        <Vital label="SpO₂" value={`${vitals.spo2}%`} bad={vitals.spo2 < 88} warn={vitals.spo2 < 93} />
        <Vital label="Temp" value={vitals.tempC.toFixed(1)} bad={vitals.tempC >= 39} warn={vitals.tempC >= 38.3 || vitals.tempC < 36} />
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
        O₂: {vitals.o2}
      </div>
    </div>
  );
}

function Vital({
  label,
  value,
  warn,
  bad,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
  bad?: boolean;
}) {
  return (
    <div className={`vital${bad ? ' bad' : warn ? ' warn' : ''}`}>
      <div className="vital-label">{label}</div>
      <div className="vital-value">{value}</div>
    </div>
  );
}

function LabCard({ lab }: { lab: LabResult }) {
  return (
    <div className="lab-card">
      <div className="lab-head">
        <span className="lab-panel-name">{lab.panel}</span>
        <span className="lab-time">drawn {clockTime(lab.drawnAt)}</span>
      </div>
      {lab.impression ? (
        <div className="lab-impression">{lab.impression}</div>
      ) : (
        <div className="lab-values">
          {lab.values.map((v) => (
            <span
              key={v.label}
              className={`lab-value${v.critical ? ' critical' : isAbnormal(v) ? ' abnormal' : ''}`}
            >
              <span className="lv-label">{v.label} </span>
              <span className="lv-num">{v.value.toFixed(v.decimals)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function OrderPalette({
  patient,
  onOrder,
  disabled,
}: {
  patient: PatientView;
  onOrder: (orderId: string) => void;
  disabled: boolean;
}) {
  const [tab, setTab] = useState<OrderCategory>('nursing');
  const p = patient.runtime;
  const placed = new Set(p.orders.map((o) => o.orderId));

  const visible = ORDERS.filter((o) => o.category === tab);

  return (
    <>
      <div className="order-tabs">
        {ORDER_CATEGORIES.map((c) => (
          <button
            key={c.id}
            className={`order-tab${c.id === tab ? ' active' : ''}`}
            onClick={() => setTab(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {visible.map((o) => {
        const alreadyPlaced = o.once === true && placed.has(o.id);
        const locked = o.requiresIcu === true && p.location !== 'icu';
        return (
          <button
            key={o.id}
            className={`order-btn${alreadyPlaced ? ' placed' : ''}`}
            disabled={disabled || alreadyPlaced}
            onClick={() => onOrder(o.id)}
            title={locked ? 'Requires ICU-level care' : undefined}
          >
            <div className="ob-label">
              {o.label}
              {locked && <span className="lock">ICU only</span>}
              {alreadyPlaced && <span className="ob-lead">ordered</span>}
            </div>
            <div className="ob-detail">{o.detail}</div>
            {o.leadTimeSec > 0 && (
              <div className="ob-lead">
                ~{Math.round(o.leadTimeSec / 60)} min to take effect
              </div>
            )}
            {o.lab && (
              <div className="ob-lead">
                result in ~{Math.round(o.lab.turnaroundSec / 60)} min
              </div>
            )}
          </button>
        );
      })}
    </>
  );
}
