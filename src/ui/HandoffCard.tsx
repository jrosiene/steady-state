import type { Handoff } from '../game/types';

/**
 * The written sign-out, rendered so its gaps are as visible as its content.
 *
 * An empty contingency list is shown explicitly rather than hidden, because
 * "nobody wrote down what to do if this patient turns" is information the night
 * doctor is entitled to notice — and on this ward it is usually the patients
 * with the shortest handoffs who need one.
 */
export function HandoffCard({ handoff, compact }: { handoff: Handoff; compact?: boolean }) {
  return (
    <div className={`handoff-card${compact ? ' compact' : ''}`}>
      <div className="handoff-byline">
        <span className={`sev sev-${handoff.severity}`}>{severityLabel(handoff.severity)}</span>
        <span>signed out by {handoff.author}</span>
      </div>

      <p className="handoff-summary">{handoff.summary}</p>

      <div className="handoff-section">
        <div className="handoff-label">Overnight</div>
        {handoff.todo.length > 0 ? (
          <ul className="handoff-list">
            {handoff.todo.map((t) => <li key={t}>{t}</li>)}
          </ul>
        ) : (
          <div className="handoff-empty">Nothing listed.</div>
        )}
      </div>

      <div className="handoff-section">
        <div className="handoff-label">If things change</div>
        {handoff.contingencies.length > 0 ? (
          <ul className="handoff-list">
            {handoff.contingencies.map((c) => <li key={c}>{c}</li>)}
          </ul>
        ) : (
          <div className="handoff-empty">No contingency plan documented.</div>
        )}
      </div>
    </div>
  );
}

/** The day team's own read on the patient — which is not always the right one. */
function severityLabel(severity: Handoff['severity']): string {
  switch (severity) {
    case 'unstable': return 'Unstable';
    case 'watcher': return 'Watcher';
    default: return 'Stable';
  }
}
