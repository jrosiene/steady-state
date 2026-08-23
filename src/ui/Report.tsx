import type { PatientRuntime } from '../game/types';
import { buildReport, responseLabel } from '../game/scoring';

/**
 * The morning debrief.
 *
 * The score is secondary. What matters is the pairing shown for each patient:
 * what was actually wrong, what you did, and how long it took you to do it —
 * with the teaching point attached to the case that earned it.
 */
export function Report({
  patients,
  onRestart,
}: {
  patients: PatientRuntime[];
  onRestart: () => void;
}) {
  const report = buildReport(patients);

  return (
    <div className="centered">
      <div className="sheet">
        <h1>07:00 — <span>Handover</span></h1>
        <p className="lede">{report.headline}</p>

        <div className="scoreboard">
          <div className="score">
            <div className="score-num" style={{ color: report.died > 0 ? 'var(--critical)' : 'var(--ok)' }}>
              {report.died}
            </div>
            <div className="score-label">Died</div>
          </div>
          <div className="score">
            <div className="score-num" style={{ color: 'var(--accent)' }}>{report.transferred}</div>
            <div className="score-label">Escalated to ICU</div>
          </div>
          <div className="score">
            <div className="score-num">{Math.round(report.managementScore * 100)}%</div>
            <div className="score-label">Key management</div>
          </div>
          <div className="score">
            <div
              className="score-num"
              style={{ color: report.harmCount > 0 ? 'var(--critical)' : 'var(--text)' }}
            >
              {report.harmCount}
            </div>
            <div className="score-label">Harmful orders</div>
          </div>
        </div>

        {report.medianResponseMinutes !== null && (
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            Median time from a patient becoming unstable to your first treatment:{' '}
            <strong style={{ color: 'var(--text)' }}>
              {responseLabel(report.medianResponseMinutes)}
            </strong>
            .
          </p>
        )}

        <h2>Case by case</h2>
        {report.debriefs.map((d) => (
          <div key={d.patient.case.id} className={`debrief ${d.outcomeTone}`}>
            <div className="debrief-top">
              <span className="handoff-name">{d.patient.case.name}</span>
              <span className="handoff-meta">
                Room {d.patient.case.room} · {d.patient.case.age}{d.patient.case.sex}
              </span>
              {d.responseMinutes !== null && (
                <span className="handoff-meta">
                  response {responseLabel(d.responseMinutes)}
                </span>
              )}
            </div>

            <div className="debrief-outcome">{d.outcomeLine}</div>

            <div className="debrief-dx">
              <b>What was actually going on:</b> {d.hiddenDx}
            </div>

            <div className="debrief-handoff">{d.handoffNote}</div>

            {(d.hits.length > 0 || d.misses.length > 0 || d.harms.length > 0) && (
              <div className="debrief-cols">
                <div className="debrief-list">
                  <div className="hd">You did</div>
                  {d.hits.length === 0 && (
                    <div style={{ color: 'var(--text-faint)' }}>Nothing from the key management set.</div>
                  )}
                  {d.hits.map((h) => <div key={h} className="hit">{h}</div>)}
                  {d.harms.map((h) => <div key={h} className="harm">{h} — harmful here</div>)}
                </div>
                <div className="debrief-list">
                  <div className="hd">Would have helped</div>
                  {d.misses.length === 0 && (
                    <div style={{ color: 'var(--ok)' }}>Nothing missed.</div>
                  )}
                  {d.misses.map((m) => <div key={m} className="miss">{m}</div>)}
                </div>
              </div>
            )}

            <div className="teaching">{d.teachingPoint}</div>
          </div>
        ))}

        <button className="start-btn" onClick={onRestart}>
          Work another night →
        </button>
      </div>
    </div>
  );
}
