import type { PatientCase } from '../game/types';
import { HandoffCard } from './HandoffCard';
import { composition } from '../game/content/generate';

/**
 * List sizes offered on the briefing screen.
 *
 * Eight is a single ward and the size everything is tuned against. The larger
 * numbers are cross-cover: the same handful of real problems buried in a great
 * deal more noise, which is the actual difficulty of a busy night.
 */
const SIZES = [8, 16, 24, 40] as const;

function sizeNote(size: number): string {
  const want = composition(size);
  return `${want.critical} who could go off, ${want.ward} ward-level, ${want.benign} quiet`;
}

/**
 * The handoff.
 *
 * Everything here is what the day team believed at 19:00 — including the parts
 * that are wrong. The player starts with exactly the information a real covering
 * doctor starts with, which is less than they would like.
 */
export function Briefing({
  cases,
  seed,
  size,
  onStart,
  onReroll,
  onBench,
}: {
  cases: PatientCase[];
  seed: string;
  size: number;
  onStart: () => void;
  onReroll: (seed?: string, size?: number) => void;
  onBench: () => void;
}) {
  return (
    <div className="centered">
      <div className="sheet">
        <h1>Steady<span>/</span>State — <span>Night Shift</span></h1>
        <p className="lede">
          It is 19:00. You are the covering doctor for {cases.length}{' '}
          {cases.length === 1 ? 'patient' : 'patients'} until 07:00
          {cases.length > 8 ? ', spread across several floors' : ' on a general medical ward'}.
          You will not lay eyes on any of them — you have
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

        <h2>How many are you holding?</h2>
        <p className="lede" style={{ marginBottom: 14 }}>
          Acuity does not scale with the size of the list. A longer list is not more
          people dying — it is the same handful of real problems buried in more noise,
          and the night is harder because finding them is harder.
        </p>
        <div className="size-bar">
          {SIZES.map((n) => (
            <button
              key={n}
              className={`size-btn${n === size ? ' active' : ''}`}
              onClick={() => onReroll(undefined, n)}
            >
              <span className="size-n">{n}</span>
              <span className="size-note">{sizeNote(n)}</span>
            </button>
          ))}
        </div>

        <h2>Sign-out from the day team</h2>
        <p className="lede" style={{ marginBottom: 14 }}>
          {cases.length} written handoffs of varying quality. Some anticipate what might
          go wrong tonight; some were written by someone already halfway out of the
          building. You can re-read any of them from the patient's chart later.
        </p>

        <div className="seed-bar">
          <span className="seed-label">Ward</span>
          <code className="seed-value">{seed}</code>
          <span className="seed-note">
            This ward was dealt from that seed — the same seed and size always deal the
            same patients. Note it down if you want this night again.
          </span>
          <button className="ctrl" onClick={() => onReroll()}>Deal another ward</button>
        </div>
        {cases.map((c) => (
          <div key={c.id} className="handoff">
            <div className="handoff-top">
              <span className="handoff-name">{c.name}</span>
              <span className="handoff-meta">
                {c.age}{c.sex} · Room {c.room} · {c.nurse} covering
              </span>
              {c.codeStatus !== 'Full Code' && <span className="tag dnr">{c.codeStatus}</span>}
            </div>
            <div className="handoff-dx">{c.admissionDx}</div>
            <HandoffCard handoff={c.handoff} />
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
