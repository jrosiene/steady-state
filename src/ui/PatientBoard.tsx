import type { PatientView } from '../game/types';
import { acuityLabel, ageLabel } from '../game/clinical';

/**
 * The patient board.
 *
 * Deliberately shows only what a covering doctor would actually have: the last
 * charted vitals and how old they are. The acuity dot is computed from the true
 * physiology for monitored patients and from the last charted set otherwise, so
 * an unmonitored patient can look calm on this list while deteriorating in the room.
 */
export function PatientBoard({
  views,
  selectedId,
  onSelect,
}: {
  views: PatientView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="scroll">
      {views.map((v) => (
        <PatientCard
          key={v.runtime.case.id}
          view={v}
          selected={v.runtime.case.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function PatientCard({
  view,
  selected,
  onSelect,
}: {
  view: PatientView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { runtime: p, displayVitals, vitalsAgeSec, live } = view;
  const dead = p.status === 'died';

  // Acuity is read from the observed vitals unless the patient is monitored —
  // the board must not leak physiology the player has not earned.
  const acuity = dead
    ? 'gone'
    : live
      ? acuityLabel(view.snapshot, view.runtime.case.baselineDrive)
      : acuityFromVitals(displayVitals);

  return (
    <button
      className={`patient-card${selected ? ' selected' : ''}${dead ? ' gone' : ''}`}
      onClick={() => onSelect(p.case.id)}
    >
      <div className="pc-top">
        <span className={`dot ${acuity}`} />
        <span className="pc-room">{p.case.room}</span>
        <span className="pc-name">{p.case.name}</span>
        {p.unread > 0 && <span className="badge">{p.unread}</span>}
      </div>

      <div className="pc-dx">{p.case.admissionDx}</div>

      <div className="pc-vitals">
        {dead ? (
          <span style={{ color: 'var(--dead)' }}>Deceased</span>
        ) : displayVitals ? (
          <>
            <span>{displayVitals.sbp}/{displayVitals.dbp}</span>
            <span>♥ {displayVitals.hr}</span>
            <span>SpO₂ {displayVitals.spo2}%</span>
          </>
        ) : (
          <span>No vitals charted</span>
        )}
      </div>

      <div className="pc-age">
        {p.case.age}{p.case.sex} ·{' '}
        {dead
          ? '—'
          : live
            ? 'monitored, live'
            : displayVitals
              ? `vitals ${ageLabel(vitalsAgeSec)}`
              : '—'}
        {p.location === 'icu' && !dead && <span className="tag icu" style={{ marginLeft: 6 }}>ICU</span>}
        {p.case.codeStatus === 'DNR/DNI' && <span className="tag dnr" style={{ marginLeft: 6 }}>DNR</span>}
      </div>
    </button>
  );
}

/**
 * Acuity inferred from charted numbers alone.
 *
 * This is intentionally cruder than `acuityLabel`, which sees lactate and
 * cardiac output. A blood pressure cuff cannot detect occult hypoperfusion, and
 * neither can this.
 */
function acuityFromVitals(v: PatientView['displayVitals']): string {
  if (!v) return 'ok';
  if (v.map < 55 || v.spo2 < 88 || v.hr > 130) return 'critical';
  if (v.map < 65 || v.spo2 < 91 || v.hr > 115) return 'unstable';
  if (v.map < 72 || v.spo2 < 94 || v.hr > 100 || v.tempC >= 38.3) return 'watch';
  return 'ok';
}
