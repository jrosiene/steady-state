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

/** Time compression options. At 60× the twelve-hour shift takes twelve minutes. */
const SPEEDS = [
  { value: 30, label: '30×' },
  { value: 60, label: '60×' },
  { value: 120, label: '120×' },
  { value: 240, label: '240×' },
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
  const [timeScale, setTimeScale] = useState(60);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // Clear the unread badge while the player is actually reading the thread.
  useEffect(() => {
    if (selected && selected.runtime.unread > 0) {
      engine.markRead(selected.runtime);
    }
  });

  // These are plain functions rather than useCallback: the engine is mutable and
  // the tree re-renders every animation frame anyway, so memoising the handlers
  // saves nothing and only blocks the React Compiler from optimising the component.
  const selectPatient = (id: string) => {
    setSelectedId(id);
    setRefusal(null);
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
    setEngine(new ShiftEngine());
    setSelectedId(null);
    setPaused(false);
    setRefusal(null);
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
          onStart={() => {
            engine.start();
            setSelectedId(engine.patients[0]?.case.id ?? null);
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
            night shift · {Math.round(progress * 100)}% through
          </div>
        </div>

        <span className="spacer" />

        {engine.unreadTotal > 0 && (
          <span className="clock-sub">
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
          <span>
            Urgent page waiting:{' '}
            {urgent.map((v) => `${v.runtime.case.room} ${v.runtime.case.name}`).join(' · ')}
          </span>
        </div>
      )}

      {refusal && (
        <div className="alert-strip" style={{ background: '#2e2410', borderColor: 'var(--watch)', color: '#f5e0b0' }}>
          <span>{refusal}</span>
          <span className="spacer" />
          <button className="link-btn" onClick={() => setRefusal(null)}>dismiss</button>
        </div>
      )}

      <div className="workspace">
        <div className="column">
          <div className="column-head">Patients ({views.filter((v) => v.runtime.status !== 'died').length})</div>
          <PatientBoard views={views} selectedId={selectedId} onSelect={selectPatient} />
        </div>

        <div className="column">
          <div className="column-head">
            {selected
              ? `${selected.runtime.case.nurse} · Room ${selected.runtime.case.room}`
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

        <div className="column">
          <div className="column-head">Chart &amp; orders</div>
          {selected ? (
            <PatientDetail view={selected} onOrder={handleOrder} time={engine.time} />
          ) : (
            <div className="empty">Select a patient.</div>
          )}
        </div>
      </div>
    </div>
  );
}
