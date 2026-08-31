import { useEffect, useState } from 'react';
import { ShiftEngine } from './game/shift';
import { clockTime } from './game/clinical';
import { SHIFT_DURATION_SEC } from './game/types';
import { PatientBoard } from './ui/PatientBoard';
import { ChatThread } from './ui/ChatThread';
import { PatientDetail } from './ui/PatientDetail';
import { Briefing } from './ui/Briefing';
import { Report } from './ui/Report';
import EngineBench from './bench/EngineBench';
import './ui/game.css';

/**
 * Time compression options, with the wall-clock length of the shift.
 *
 * The default is 30×, not 60×. Deteriorations are deliberately quick — Brennan
 * goes from his first page to dead in about fifty sim-minutes — and at 60× that
 * is under a minute of real time, which is not long enough to read a thread,
 * think, and place three orders, least of all on a phone. The clock should be
 * pressing, not simply faster than the interface.
 */
const SPEEDS = [
  { value: 15, label: '15× · 48 min shift' },
  { value: 30, label: '30× · 24 min shift' },
  { value: 60, label: '60× · 12 min shift' },
  { value: 120, label: '120× · 6 min shift' },
];

/** Largest wall-clock step accepted per frame, guarding against tab-away. */
const MAX_WALL_DT = 0.1;

/** UI repaint interval (ms). Physics runs at full rate regardless. */
const UI_FRAME_MS = 70;

export default function App() {
  // The engine is a long-lived mutable object rather than derived state, but it
  // lives in useState so that render never reads a ref — starting a new shift is
  // the only thing that replaces it.
  const [engine, setEngine] = useState(() => new ShiftEngine());

  const [, forceRender] = useState(0);
  const [paused, setPaused] = useState(false);
  const [timeScale, setTimeScale] = useState(30);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Which column is showing on a narrow screen. Ignored by the desktop layout,
  // where all three are visible at once.
  const [pane, setPane] = useState<MobilePane>('patients');
  const [showBench, setShowBench] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (paused) return;

    let raf = 0;
    let lastWall = performance.now();
    let lastPaint = 0;

    const frame = (now: number) => {
      // Clamp the wall-clock step so returning to a backgrounded tab does not
      // fast-forward the ward by however long the player was away.
      const wallDt = Math.min((now - lastWall) / 1000, MAX_WALL_DT);
      lastWall = now;

      engine.tick(wallDt * timeScale);

      // Repaint on a fixed cadence: physics can run far faster than any display
      // needs to, and re-rendering eight patients at 60 fps is waste.
      if (now - lastPaint >= UI_FRAME_MS) {
        lastPaint = now;
        forceRender((n) => n + 1);
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [engine, paused, timeScale]);

  const views = engine.views();
  const selected = views.find((v) => v.runtime.case.id === selectedId) ?? null;

  // Clear the unread badge only while the thread is genuinely on screen.
  //
  // On a phone the thread shares the viewport with two other panes, so a selected
  // patient is not necessarily a visible one. Marking read on selection alone
  // would swallow pages the player never saw — the opposite of what this game is
  // about — so the narrow layout additionally requires the thread pane to be open.
  useEffect(() => {
    if (!selected || selected.runtime.unread === 0) return;
    const narrow = window.matchMedia('(max-width: 860px)').matches;
    if (narrow && pane !== 'thread') return;
    engine.markRead(selected.runtime);
  });

  // These are plain functions rather than useCallback: the engine is mutable and
  // the tree re-renders every animation frame anyway, so memoising the handlers
  // saves nothing and only blocks the React Compiler from optimising the component.
  const selectPatient = (id: string) => {
    setSelectedId(id);
    setRefusal(null);
    setPane('thread');
  };

  const handleOrder = (orderId: string) => {
    if (!selected) return;
    setRefusal(engine.placeOrder(selected.runtime, orderId));
  };

  const handleAsk = (questionId: string) => {
    if (!selected) return;
    engine.askQuestion(selected.runtime, questionId);
  };

  const restart = () => {
    // A fresh seed, so the next night is a different ward rather than a retry —
    // but the same size of list, since that is a preference, not part of the deal.
    setEngine(new ShiftEngine(undefined, undefined, engine.size, engine.setting));
    setSelectedId(null);
    setPaused(false);
    setRefusal(null);
    setPane('patients');
  };

  // Unopened urgent pages, surfaced as a banner so a crashing patient cannot be
  // missed simply because a different thread happens to be open.
  const urgent = views.filter((v) => engine.hasUnreadUrgent(v.runtime));

  if (showBench) {
    return (
      <div>
        <div className="topbar">
          <span className="brand">Steady<span>/</span>State</span>
          <span className="clock-sub">Physiology test bench</span>
          <span className="spacer" />
          <button className="ctrl" onClick={() => setShowBench(false)}>
            ← Back to the night shift
          </button>
        </div>
        <EngineBench />
      </div>
    );
  }

  if (engine.phase === 'briefing') {
    return (
      <div className="app">
        <Briefing
          cases={engine.patients.map((p) => p.case)}
          seed={engine.seed}
          size={engine.size}
          setting={engine.setting}
          onReroll={(seed, size, setting) =>
            setEngine(new ShiftEngine(
              undefined, seed, size ?? engine.size, setting ?? engine.setting,
            ))}
          onStart={() => {
            engine.start();
            setSelectedId(engine.patients[0]?.case.id ?? null);
            setPane('patients');
            forceRender((n) => n + 1);
          }}
          onBench={() => setShowBench(true)}
        />
      </div>
    );
  }

  if (engine.phase === 'ended') {
    return (
      <div className="app">
        <Report patients={engine.patients} onRestart={restart} />
      </div>
    );
  }

  const progress = Math.min(1, engine.time / SHIFT_DURATION_SEC);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">Steady<span>/</span>State</span>

        <div>
          <div className="clock">{clockTime(engine.time)}</div>
          <div className="clock-sub">
            night shift · {Math.round(progress * 100)}% through · ward {engine.seed}
          </div>
        </div>

        <span className="spacer" />

        {engine.unreadTotal > 0 && (
          <span className="clock-sub unread-note">
            {engine.unreadTotal} unread message{engine.unreadTotal === 1 ? '' : 's'}
          </span>
        )}

        <select
          className="ctrl"
          value={timeScale}
          onChange={(e) => setTimeScale(Number(e.target.value))}
        >
          {SPEEDS.map((s) => (
            <option key={s.value} value={s.value}>{s.label} speed</option>
          ))}
        </select>

        <button className="ctrl primary" onClick={() => setPaused((p) => !p)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      {urgent.length > 0 && (
        <div className="alert-strip">
          <span className="dot critical" />
          <span>Urgent page:</span>
          {urgent.map((v) => (
            <button
              key={v.runtime.case.id}
              className="alert-jump"
              onClick={() => selectPatient(v.runtime.case.id)}
            >
              {v.runtime.case.room} {v.runtime.case.name}
            </button>
          ))}
        </div>
      )}

      {refusal && (
        <div className="alert-strip" style={{ background: '#2e2410', borderColor: 'var(--watch)', color: '#f5e0b0' }}>
          <span>{refusal}</span>
          <span className="spacer" />
          <button className="link-btn" onClick={() => setRefusal(null)}>dismiss</button>
        </div>
      )}

      <div className="workspace" data-pane={pane}>
        <div className="column column-patients">
          <div className="column-head">Patients ({views.filter((v) => v.runtime.status !== 'died').length})</div>
          <PatientBoard views={views} selectedId={selectedId} onSelect={selectPatient} />
        </div>

        <div className="column column-thread">
          <div className="column-head">
            {/* The patient is what the thread is about; the nurse is who is on the
                other end of it. Naming only the nurse made a page that mentioned
                the patient by name read as if it had come from another room. */}
            {selected
              ? `${selected.runtime.case.name} · Room ${selected.runtime.case.room} · ${selected.runtime.case.nurse}`
              : 'Messages'}
            {selected?.runtime.location === 'icu' && <span className="tag icu">ICU</span>}
            {selected?.live && <span className="tag live">Monitored</span>}
            {selected?.runtime.status === 'died' && <span className="tag dead">Deceased</span>}
          </div>
          {selected ? (
            <ChatThread
              patient={selected.runtime}
              onAsk={handleAsk}
              disabled={selected.runtime.status === 'died'}
            />
          ) : (
            <div className="empty">Select a patient to see their messages.</div>
          )}
        </div>

        <div className="column column-chart">
          <div className="column-head">Chart &amp; orders</div>
          {selected ? (
            <PatientDetail view={selected} onOrder={handleOrder} time={engine.time} />
          ) : (
            <div className="empty">Select a patient.</div>
          )}
        </div>
      </div>

      <nav className="tabbar">
        <button
          className={`tab${pane === 'patients' ? ' active' : ''}`}
          onClick={() => setPane('patients')}
        >
          Patients
          {engine.unreadTotal > 0 && <span className="tab-badge">{engine.unreadTotal}</span>}
        </button>
        <button
          className={`tab${pane === 'thread' ? ' active' : ''}`}
          onClick={() => setPane('thread')}
          disabled={!selected}
        >
          Messages
          {selected && selected.runtime.unread > 0 && (
            <span className="tab-badge">{selected.runtime.unread}</span>
          )}
        </button>
        <button
          className={`tab${pane === 'chart' ? ' active' : ''}`}
          onClick={() => setPane('chart')}
          disabled={!selected}
        >
          Chart &amp; orders
        </button>
      </nav>
    </div>
  );
}

type MobilePane = 'patients' | 'thread' | 'chart';
