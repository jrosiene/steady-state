import { CASES } from '../game/cases';

/**
 * The handoff.
 *
 * Everything here is what the day team believed at 19:00 — including the parts
 * that are wrong. The player starts with exactly the information a real covering
 * doctor starts with, which is less than they would like.
 */
export function Briefing({ onStart, onBench }: { onStart: () => void; onBench: () => void }) {
  return (
    <div className="centered">
      <div className="sheet">
        <h1>Steady<span>/</span>State — <span>Night Shift</span></h1>
        <p className="lede">
          It is 19:00. You are the covering doctor for eight patients on a general
          medical ward until 07:00. You will not lay eyes on any of them — you have
          a phone, a set of nurses who will page you, and an order entry system.
          Everything you know arrives through those channels, and every number you
          see was true at the moment it was taken.
        </p>

        <div className="rules">
          <div className="rule">
            <h3>Vitals go stale</h3>
            <p>
              Floor observations are every four hours. Between them, you are working
              from history. Ask for a set, or put the patient on continuous monitoring
              if you want to see them change.
            </p>
          </div>
          <div className="rule">
            <h3>Ask the nurse</h3>
            <p>
              How a patient looks, whether they are confused, whether they are making
              urine — all of it is free, current, and often available long before a
              blood pressure declares itself.
            </p>
          </div>
          <div className="rule">
            <h3>Orders take time</h3>
            <p>
              Pharmacy verifies, nurses draw up, blood comes from the bank. Antibiotics
              take hours to work. The clock starts when you decide, not when the drug lands.
            </p>
          </div>
          <div className="rule">
            <h3>The floor has limits</h3>
            <p>
              Vasoactive infusions and ventilators need an ICU bed, and beds take time
              to arrange. Deciding to escalate is itself a treatment, and it is often
              the one that matters most.
            </p>
          </div>
        </div>

        <h2>Sign-out from the day team</h2>
        {CASES.map((c) => (
          <div key={c.id} className="handoff">
            <div className="handoff-top">
              <span className="handoff-name">{c.name}</span>
              <span className="handoff-meta">
                {c.age}{c.sex} · Room {c.room} · {c.nurse} covering
              </span>
              {c.codeStatus !== 'Full Code' && <span className="tag dnr">{c.codeStatus}</span>}
            </div>
            <div className="handoff-dx">{c.admissionDx}</div>
            <div className="handoff-body">{c.signout}</div>
            <div className="handoff-hx">PMH: {c.history.join(' · ')} · Allergies: {c.allergies}</div>
          </div>
        ))}

        <button className="start-btn" onClick={onStart}>
          Take the pager →
        </button>

        <div style={{ marginTop: 26 }}>
          <button className="link-btn" onClick={onBench}>
            Open the physiology test bench instead
          </button>
        </div>
      </div>
    </div>
  );
}
