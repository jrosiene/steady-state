import { useEffect, useRef, useState, useCallback } from 'react';
import type { Snapshot, HemodynamicState, Intervention } from './engine/types';
import type { PatientProfile } from './engine/patient';
import { interventionEffect } from './engine/hemodynamics';
import { DEFAULT_PARAMS, DEFAULT_STATE } from './engine/constants';
import { snapshot as computeSnapshot, applyInterventions } from './engine/hemodynamics';
import { samplePatient } from './engine/patient';
import { SimulationLoop } from './game/loop';
import { SimClock } from './game/clock';
import './App.css';

function App() {
  const [snap, setSnap] = useState<Snapshot>(() =>
    computeSnapshot(DEFAULT_STATE, DEFAULT_PARAMS),
  );
  const [running, setRunning] = useState(false);
  const [timeScale, setTimeScale] = useState(1);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [patient, setPatient] = useState<PatientProfile | null>(null);

  const loopRef = useRef<SimulationLoop | null>(null);
  const historyRef = useRef<Snapshot[]>([]);
  const lastHistoryTime = useRef(0);

  useEffect(() => {
    const clock = new SimClock(timeScale);
    const simState = {
      hemodynamics: { ...DEFAULT_STATE },
      params: { ...DEFAULT_PARAMS },
      interventions: [] as Intervention[],
      clock,
    };

    const loop = new SimulationLoop(simState, (s) => {
      setSnap(s);
      setInterventions([...simState.interventions]);
      if (s.time - lastHistoryTime.current >= 0.5) {
        lastHistoryTime.current = s.time;
        historyRef.current = [...historyRef.current.slice(-599), s];
        setHistory(historyRef.current);
      }
    });
    loopRef.current = loop;
    return () => loop.pause();
  }, []);

  useEffect(() => {
    if (loopRef.current) {
      loopRef.current.state.clock.setTimeScale(timeScale);
    }
  }, [timeScale]);

  const toggleRunning = useCallback(() => {
    if (!loopRef.current) return;
    if (running) {
      loopRef.current.pause();
    } else {
      loopRef.current.start();
    }
    setRunning(!running);
  }, [running]);

  const doReset = useCallback((profile?: PatientProfile) => {
    if (!loopRef.current) return;
    loopRef.current.pause();
    const state = profile ? { ...profile.initialState } : { ...DEFAULT_STATE };
    const params = profile ? { ...profile.params } : { ...DEFAULT_PARAMS };
    loopRef.current.state.hemodynamics = state;
    loopRef.current.state.params = params;
    loopRef.current.state.interventions = [];
    setRunning(false);
    setSnap(computeSnapshot(state, params));
    setInterventions([]);
    historyRef.current = [];
    lastHistoryTime.current = 0;
    setHistory([]);
  }, []);

  const reset = useCallback(() => doReset(), [doReset]);

  const newPatient = useCallback(() => {
    const profile = samplePatient();
    setPatient(profile);
    doReset(profile);
  }, [doReset]);

  const setParam = useCallback(
    (key: keyof HemodynamicState, value: number) => {
      if (!loopRef.current) return;
      (loopRef.current.state.hemodynamics[key] as number) = value;
      if (!running) {
        const effective = applyInterventions(
          loopRef.current.state.hemodynamics,
          loopRef.current.state.interventions,
        );
        setSnap(computeSnapshot(effective, loopRef.current.state.params));
      }
    },
    [running],
  );

  const addIntervention = useCallback(
    (label: string, category: 'scenario' | 'treatment', target: keyof HemodynamicState, delta: number, tauOn: number, tauOff: number) => {
      if (!loopRef.current) return;
      const intervention: Intervention = {
        label,
        category,
        target,
        delta,
        tauOn,
        tauOff,
        startTime: loopRef.current.state.hemodynamics.time,
      };
      loopRef.current.state.interventions.push(intervention);
      setInterventions([...loopRef.current.state.interventions]);
    },
    [],
  );

  const removeIntervention = useCallback((index: number) => {
    if (!loopRef.current) return;
    // Stop the intervention (triggers offset decay) rather than removing instantly
    const intervention = loopRef.current.state.interventions[index];
    if (intervention && !intervention.stopTime) {
      intervention.stopTime = loopRef.current.state.hemodynamics.time;
      setInterventions([...loopRef.current.state.interventions]);
    }
  }, []);

  const clearByCategory = useCallback((category: 'scenario' | 'treatment') => {
    if (!loopRef.current) return;
    const time = loopRef.current.state.hemodynamics.time;
    for (const i of loopRef.current.state.interventions) {
      if (i.category === category && !i.stopTime) {
        i.stopTime = time;
      }
    }
    setInterventions([...loopRef.current.state.interventions]);
  }, []);

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Steady/State — Engine Test Bench</h1>

      <div style={styles.controlBar}>
        <button onClick={toggleRunning} style={styles.button}>
          {running ? '⏸ Pause' : '▶ Run'}
        </button>
        <button onClick={reset} style={styles.button}>
          ↺ Reset
        </button>
        <button onClick={newPatient} style={{ ...styles.button, borderColor: '#6688aa' }}>
          New Patient
        </button>
        <label style={styles.label}>
          Time Scale:
          <select
            value={timeScale}
            onChange={(e) => setTimeScale(Number(e.target.value))}
            style={styles.select}
          >
            <option value={1}>1x (real-time)</option>
            <option value={5}>5x</option>
            <option value={10}>10x</option>
            <option value={60}>60x (1 min/sec)</option>
            <option value={300}>300x (5 min/sec)</option>
          </select>
        </label>
      </div>

      {patient && (
        <div style={styles.patientBanner}>
          <span style={{ color: '#6688aa', fontWeight: 600 }}>Patient: </span>
          {patient.descriptor}
          <span style={{ color: '#555', marginLeft: 12, fontSize: 11 }}>
            MAP setpoint {patient.params.mapSetpoint.toFixed(0)} mmHg · HR baseline {patient.params.hrBaseline.toFixed(0)} bpm · SVR baseline {patient.params.svrBaseline.toFixed(1)} WU
          </span>
        </div>
      )}

      <div style={styles.mainGrid}>
        {/* Systemic Vitals Monitor */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>Vitals Monitor</h2>
          <div style={styles.vitalsGrid}>
            <VitalDisplay label="MAP" value={snap.map} unit="mmHg" color="#ff4444" warn={snap.map < 65 || snap.map > 110} />
            <VitalDisplay label="HR" value={snap.hr} unit="bpm" color="#44ff44" warn={snap.hr > 120 || snap.hr < 50} />
            <VitalDisplay label="SV" value={snap.sv} unit="mL" color="#4488ff" warn={snap.sv < 40} />
            <VitalDisplay label="CO" value={snap.co} unit="L/min" color="#ffaa44" warn={snap.co < 3.5} />
            <VitalDisplay label="SVR" value={snap.svr} unit="WU" color="#ff88ff" />
            <VitalDisplay label="CVP" value={snap.cvp} unit="mmHg" color="#88ffff" warn={snap.cvp > 15} />
            <VitalDisplay label="EDV" value={snap.edv} unit="mL" color="#aaaaaa" />
            <VitalDisplay label="Emax" value={snap.emax} unit="" color="#aaaaaa" />
          </div>
          <div style={styles.timeDisplay}>
            Sim Time: {formatTime(snap.time)}
          </div>
        </div>

        {/* Pulmonary Monitor */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>Pulmonary Monitor</h2>
          <div style={styles.vitalsGrid}>
            <VitalDisplay label="SpO2" value={snap.spO2 * 100} unit="%" color="#00ccff"
              warn={snap.spO2 < 0.94} />
            <VitalDisplay label="PaO2" value={snap.paO2} unit="mmHg" color="#44aaff"
              warn={snap.paO2 < 60} />
            <VitalDisplay label="SvO2" value={snap.svO2 * 100} unit="%" color="#8888ff"
              warn={snap.svO2 < 0.60} />
            <VitalDisplay label="mPAP" value={snap.mPAP} unit="mmHg" color="#ffcc44"
              warn={snap.mPAP > 25} />
            <VitalDisplay label="PCWP" value={snap.pcwp} unit="mmHg" color="#ff8844"
              warn={snap.pcwp > 18} />
            <VitalDisplay label="PVR" value={snap.pvr} unit="WU" color="#ccaa44"
              warn={snap.pvr > 3} />
            <VitalDisplay label="RVEDV" value={snap.rvedv} unit="mL" color="#aaaaaa"
              warn={snap.rvedv > 195} />
            <VitalDisplay label="NO tone" value={snap.noTone * 100} unit="%" color="#44ffaa"
              warn={snap.noTone > 0.4} />
            <VitalDisplay label="ET-1 tone" value={snap.et1Tone * 100} unit="%" color="#ff6644"
              warn={snap.et1Tone > 0.3} />
            <VitalDisplay label="RV Emax" value={snap.rvEmax} unit="" color="#aaaaaa" />
          </div>
          <div style={{ ...styles.timeDisplay, fontSize: 11 }}>
            FiO2: {(snap.fiO2 * 100).toFixed(0)}% · Qs/Qt: {(snap.qsQt * 100).toFixed(0)}%
          </div>
        </div>

        {/* State Sliders */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>Direct State Control</h2>
          <StateSlider label="EDV (Preload)" value={snap.edv} min={30} max={300} unit="mL" onChange={(v) => setParam('edv', v)} />
          <StateSlider label="Emax (Contractility)" value={snap.emax} min={0.2} max={5} step={0.1} unit="" onChange={(v) => setParam('emax', v)} />
          <StateSlider label="CVP" value={snap.cvp} min={0} max={30} unit="mmHg" onChange={(v) => setParam('cvp', v)} />
          <StateSlider label="HR (override)" value={snap.hr} min={30} max={220} unit="bpm" onChange={(v) => setParam('hr', v)} disabled={running} hint={running ? 'Baroreflex-driven while running' : undefined} />
          <StateSlider label="SVR (override)" value={snap.svr} min={4} max={40} step={0.5} unit="WU" onChange={(v) => setParam('svr', v)} disabled={running} hint={running ? 'Baroreflex-driven while running' : undefined} />
        </div>

        {/* Scenarios — spans 2 grid columns, buttons in 2-column internal grid */}
        <div style={{ ...styles.panel, gridColumn: 'span 2' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h2 style={{ ...styles.panelTitle, marginBottom: 0 }}>Clinical Scenarios</h2>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#666' }}>Run at 10–60x to watch</span>
              <button onClick={() => clearByCategory('scenario')} style={styles.clearBtn}>Stop All</button>
            </div>
          </div>

          {/* Section: Acute */}
          <div style={styles.scenarioSection}>Acute</div>
          <div style={styles.scenarioGrid}>
            <ScenarioButton label="Hemorrhage II" description="EDV −30 mL over ~2 min"
              onClick={() => addIntervention('Hemorrhage II', 'scenario', 'edv', -30, 60, 600)} />
            <ScenarioButton label="Hemorrhage IV" description="EDV −70 mL over ~3 min"
              onClick={() => addIntervention('Hemorrhage IV', 'scenario', 'edv', -70, 90, 600)} />
            <ScenarioButton label="Septic Shock" description="NO↑ → SVR↓ + Emax↓; third-spacing → EDV↓"
              onClick={() => {
                addIntervention('Sepsis: NO↑', 'scenario', 'noTone', 0.7, 300, 900);
                addIntervention('Sepsis: third-spacing', 'scenario', 'edv', -20, 180, 600);
              }} />
            <ScenarioButton label="Cardiogenic Shock" description="Emax −1.2 over ~3 min (acute MI)"
              onClick={() => addIntervention('Acute MI', 'scenario', 'emax', -1.2, 90, 1800)} />
            <ScenarioButton label="Tension Pneumothorax" description="EDV −50 mL, CVP +12 over ~2 min"
              onClick={() => {
                addIntervention('Tension PTX: tamponade', 'scenario', 'edv', -50, 60, 30);
                addIntervention('Tension PTX: CVP rise', 'scenario', 'cvp', 12, 60, 30);
              }} />
            <ScenarioButton label="Massive PE" description="PVR +5 WU acutely → RV crisis → ↓CO → shock"
              onClick={() => {
                addIntervention('PE: PVR↑', 'scenario', 'pvr', 5, 120, 3600);
                addIntervention('PE: shunt↑', 'scenario', 'qsQt', 0.15, 120, 3600);
              }} />
          </div>

          {/* Section: Pulmonary Hypertension */}
          <div style={styles.scenarioSection}>Pulmonary Hypertension <span style={{ fontWeight: 400, color: '#666' }}>— mPAP &gt; 20 mmHg</span></div>
          <div style={styles.scenarioGrid}>
            <ScenarioButton label="Class I — PAH" description="PVR +4 WU over ~10 min. ET-1 loop activates."
              onClick={() => addIntervention('PAH: PVR↑', 'scenario', 'pvr', 4, 600, 1800)} />
            <ScenarioButton label="Class II — LV Failure" description="Emax −1.0 → PCWP↑ → mPAP↑"
              onClick={() => addIntervention('PVH: LV failure', 'scenario', 'emax', -1.0, 300, 1800)} />
            <ScenarioButton label="Class III — Hypoxic" description="Qs/Qt +0.15 → SpO2↓ → HPV → PVR +2 WU"
              onClick={() => {
                addIntervention('HPV: shunt↑', 'scenario', 'qsQt', 0.15, 300, 1800);
                addIntervention('HPV: PVR↑', 'scenario', 'pvr', 2, 600, 1800);
              }} />
            <ScenarioButton label="Class IV — CTEPH" description="PVR +6 WU over ~15 min. Fixed obstruction."
              onClick={() => addIntervention('CTEPH: PVR↑', 'scenario', 'pvr', 6, 900, 3600)} />
          </div>

          {/* Section: Respiratory */}
          <div style={styles.scenarioSection}>Respiratory</div>
          <div style={styles.scenarioGrid}>
            <ScenarioButton label="COPD (Stable)" description="Qs/Qt +0.12, PVR +2 WU. Chronic V/Q mismatch."
              onClick={() => {
                addIntervention('COPD: V/Q mismatch', 'scenario', 'qsQt', 0.12, 600, 3600);
                addIntervention('COPD: HPV/PVR↑', 'scenario', 'pvr', 2.0, 900, 3600);
              }} />
            <ScenarioButton label="COPD Exacerbation" description="Qs/Qt +0.25 over ~3 min. Acute bronchospasm."
              onClick={() => {
                addIntervention('COPD-E: shunt↑', 'scenario', 'qsQt', 0.25, 180, 1800);
                addIntervention('COPD-E: PVR↑', 'scenario', 'pvr', 1.5, 300, 1800);
              }} />
          </div>

          {/* Section: Heart Failure */}
          <div style={styles.scenarioSection}>Heart Failure</div>
          <div style={styles.scenarioGrid}>
            <ScenarioButton label="Acute Decompensated LVF" description="Emax −0.9, EDV +50 mL → PCWP↑, SpO2↓"
              onClick={() => {
                addIntervention('ADHF: LV↓', 'scenario', 'emax', -0.9, 300, 3600);
                addIntervention('ADHF: volume overload', 'scenario', 'edv', 50, 600, 3600);
              }} />
            <ScenarioButton label="Cor Pulmonale" description="PVR +2.5 → RVEDV dilates → septal shift → MAP↓"
              onClick={() => {
                addIntervention('CorPulm: PVR↑', 'scenario', 'pvr', 2.5, 600, 3600);
                addIntervention('CorPulm: RV↓', 'scenario', 'rvEmax', -0.3, 600, 3600);
                addIntervention('CorPulm: CVP↑', 'scenario', 'cvp', 10, 600, 3600);
              }} />
            <ScenarioButton label="Biventricular Failure" description="LV + RV both fail. EDV +40, CVP +8."
              onClick={() => {
                addIntervention('BiV HF: LV↓', 'scenario', 'emax', -0.8, 600, 3600);
                addIntervention('BiV HF: RV↓', 'scenario', 'rvEmax', -0.25, 600, 3600);
                addIntervention('BiV HF: LV dilation', 'scenario', 'edv', 40, 900, 3600);
                addIntervention('BiV HF: CVP↑', 'scenario', 'cvp', 8, 600, 3600);
              }} />
          </div>
        </div>

        {/* Treatments — full-width row, 4-column button grid */}
        <div style={{ ...styles.panel, gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h2 style={{ ...styles.panelTitle, marginBottom: 0 }}>Treatments</h2>
            <button onClick={() => clearByCategory('treatment')} style={styles.clearBtn}>
              Stop All Treatments
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <ScenarioButton label="Norepinephrine" description="α1: SVR +8 WU; mild β1: HR +5 bpm. Onset ~2 min."
              onClick={() => {
                addIntervention('Norepi: SVR', 'treatment', 'svr', 8, 120, 300);
                addIntervention('Norepi: chrono', 'treatment', 'hrMod', 5, 120, 300);
              }} />
            <ScenarioButton label="Phenylephrine" description="Pure α1: SVR +5 WU. Reflex brady automatic. Onset ~30s."
              onClick={() => addIntervention('Phenylephrine', 'treatment', 'svr', 5, 30, 180)} />
            <ScenarioButton label="Epinephrine" description="α1+β1: SVR +6, Emax +1.5, HR +40 bpm. Onset ~2 min."
              onClick={() => {
                addIntervention('Epi: SVR', 'treatment', 'svr', 6, 120, 300);
                addIntervention('Epi: inotropy', 'treatment', 'emax', 1.5, 120, 300);
                addIntervention('Epi: chronotropy', 'treatment', 'hrMod', 40, 120, 300);
              }} />
            <ScenarioButton label="Dobutamine" description="β1: Emax +1.0, HR +25 bpm. Onset ~2 min."
              onClick={() => {
                addIntervention('Dobut: inotropy', 'treatment', 'emax', 1.0, 120, 300);
                addIntervention('Dobut: chronotropy', 'treatment', 'hrMod', 25, 120, 300);
              }} />
            <ScenarioButton label="Vasopressin" description="Pure V1: SVR +6 WU. No chronotropy. Ideal for NO-driven shock."
              onClick={() => addIntervention('Vasopressin', 'treatment', 'svr', 6, 30, 180)} />
            <ScenarioButton label="Fluid Bolus (1L NS)" description="EDV +40 mL over ~10 min."
              onClick={() => addIntervention('1L NS bolus', 'treatment', 'edv', 40, 600, 3600)} />
            <ScenarioButton label="Needle Decompression" description="CVP −10, onset ~10s."
              onClick={() => addIntervention('Needle decompression', 'treatment', 'cvp', -10, 10, 30)} />
            <ScenarioButton label="Supplemental O2 (40%)" description="FiO2 +0.19. Onset ~30s."
              onClick={() => addIntervention('Supp O2 40%', 'treatment', 'fiO2', 0.19, 30, 120)} />
            <ScenarioButton label="Inhaled iNO" description="PVR −0.8 WU, ~5 min onset. Selective — no SVR drop."
              onClick={() => addIntervention('iNO/PGI2', 'treatment', 'pvr', -0.8, 300, 600)} />
            <ScenarioButton label="Sildenafil (PDE5i)" description="PVR −1.5, SVR −0.5 WU. Onset ~30 min. Watch MAP."
              onClick={() => {
                addIntervention('Sildenafil: PVR↓', 'treatment', 'pvr', -1.5, 1800, 14400);
                addIntervention('Sildenafil: SVR↓', 'treatment', 'svr', -0.5, 1800, 14400);
              }} />
            <ScenarioButton label="Bosentan (ET-1 blocker)" description="et1Tone −0.6 → PVR + SVR both fall. Watch MAP."
              onClick={() => addIntervention('Bosentan: ET-1↓', 'treatment', 'et1Tone', -0.6, 3600, 28800)} />
            <ScenarioButton label="Methylprednisolone" description="noTone −0.4. Counters NO vasodilation in sepsis."
              onClick={() => addIntervention('Steroids: NO↓', 'treatment', 'noTone', -0.4, 1800, 21600)} />
          </div>
        </div>

        {/* Active Interventions */}
        <div style={{ ...styles.panel, gridColumn: '1 / -1' }}>
          <h2 style={styles.panelTitle}>Active Interventions</h2>
          <InterventionList
            interventions={interventions}
            currentTime={snap.time}
            onRemove={removeIntervention}
          />
        </div>

        {/* Trend Charts */}
        <div style={{ ...styles.panel, gridColumn: '1 / -1' }}>
          <h2 style={styles.panelTitle}>Trends</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12 }}>
            <SystemicTrendChart history={history} />
            <PulmonaryTrendChart history={history} />
          </div>
          <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Interventions &amp; Scenarios Timeline</div>
          <InterventionTimeline history={history} interventions={interventions} />
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function VitalDisplay({ label, value, unit, color, warn }: {
  label: string; value: number; unit: string; color: string; warn?: boolean;
}) {
  return (
    <div style={{ ...styles.vital, borderColor: warn ? '#ff0000' : color }}>
      <div style={{ color: '#888', fontSize: 12 }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 'bold', fontFamily: 'monospace' }}>
        {value.toFixed(1)}
      </div>
      <div style={{ color: '#666', fontSize: 11 }}>{unit}</div>
    </div>
  );
}

function StateSlider({ label, value, min, max, step = 1, unit, onChange, disabled, hint }: {
  label: string; value: number; min: number; max: number; step?: number;
  unit: string; onChange: (v: number) => void; disabled?: boolean; hint?: string;
}) {
  return (
    <div style={{ marginBottom: 12, opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <span>{label}</span>
        <span style={{ fontFamily: 'monospace' }}>{value.toFixed(step < 1 ? 1 : 0)} {unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} disabled={disabled} style={{ width: '100%' }} />
      {hint && <div style={{ fontSize: 11, color: '#888', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  );
}

function ScenarioButton({ label, description, onClick }: {
  label: string; description: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} style={styles.scenarioBtn}>
      <strong>{label}</strong>
      <span style={{ fontSize: 11, color: '#aaa' }}>{description}</span>
    </button>
  );
}

function InterventionList({ interventions, currentTime, onRemove }: {
  interventions: Intervention[]; currentTime: number; onRemove: (i: number) => void;
}) {
  // Filter to interventions that still have meaningful effect
  const active = interventions
    .map((intervention, index) => ({ intervention, index }))
    .filter(({ intervention }) => Math.abs(interventionEffect(intervention, currentTime)) > 0.01);

  if (active.length === 0) {
    return <div style={{ color: '#666', fontSize: 13, textAlign: 'center', padding: 8 }}>No active interventions</div>;
  }

  // Group by label; preserve insertion order of first occurrence
  const groupOrder: string[] = [];
  const groups = new Map<string, typeof active>();
  for (const item of active) {
    const key = item.intervention.label;
    if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key); }
    groups.get(key)!.push(item);
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {groupOrder.map((label) => {
        const group = groups.get(label)!;
        const count = group.length;
        // Use the most-recently-started member's category/target for display
        const rep = group[group.length - 1].intervention;
        const isStopping = group.every((g) => g.intervention.stopTime !== undefined);
        const totalEffect = group.reduce((sum, g) => sum + interventionEffect(g.intervention, currentTime), 0);
        const pct = rep.delta !== 0 ? Math.round((Math.abs(totalEffect) / (Math.abs(rep.delta) * count)) * 100) : 0;
        const color = rep.category === 'scenario' ? '#ff6666' : '#66bb66';

        // "remove one": stop the most recent non-stopped member
        const removable = [...group].reverse().find((g) => !g.intervention.stopTime);

        return (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px', background: '#2a2a2a', borderRadius: 4,
            border: `1px solid ${isStopping ? '#555' : color}`,
            opacity: isStopping ? 0.6 : 1,
            fontSize: 12,
          }}>
            <span style={{ color, fontWeight: 600 }}>
              {rep.category === 'scenario' ? '!' : '+'}
            </span>
            <span>{label}</span>
            {count > 1 && (
              <span style={{
                background: color, color: '#111', borderRadius: 10,
                padding: '1px 6px', fontSize: 10, fontWeight: 700,
              }}>×{count}</span>
            )}
            <span style={{ color: '#888', fontFamily: 'monospace', fontSize: 11 }}>
              {totalEffect >= 0 ? '+' : ''}{totalEffect.toFixed(1)} {rep.target} ({pct}%)
            </span>
            {removable && (
              <button
                onClick={() => onRemove(removable.index)}
                style={{
                  background: 'none', border: 'none', color: '#888',
                  cursor: 'pointer', fontSize: 14, padding: '0 2px',
                }}
                title={count > 1 ? `Remove one dose (${count - 1} remain)` : 'Stop this intervention'}
              >
                ×
              </button>
            )}
            {isStopping && (
              <span style={{ color: '#888', fontSize: 10, fontStyle: 'italic' }}>wearing off</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

const INTERVENTION_COLORS: Record<string, string> = {
  scenario: 'rgba(255,102,102,0.15)',
  treatment: 'rgba(102,187,102,0.15)',
};
const INTERVENTION_LINE_COLORS: Record<string, string> = {
  scenario: '#ff6666',
  treatment: '#66bb66',
};

interface ChartTrace {
  label: string;
  getValue: (s: Snapshot) => number;
  color: string;
  min: number;
  max: number;
}

function VitalsChart({ history, traces, title }: {
  history: Snapshot[];
  traces: ChartTrace[];
  title: string;
}) {
  if (history.length < 2) {
    return <div style={{ color: '#666', textAlign: 'center', padding: 20 }}>Run the simulation to see trends...</div>;
  }

  const width = 600;
  const height = 200;
  const pad = { top: 8, right: 64, bottom: 22, left: 40 };

  const tMin = history[0].time;
  const tMax = history[history.length - 1].time;
  const tRange = Math.max(tMax - tMin, 1);

  const x = (t: number) => pad.left + ((t - tMin) / tRange) * (width - pad.left - pad.right);
  const y = (val: number, min: number, max: number) =>
    pad.top + (1 - Math.max(0, Math.min(1, (val - min) / (max - min)))) * (height - pad.top - pad.bottom);

  return (
    <div>
      <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>{title}</div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', maxHeight: 220, background: '#111', borderRadius: 4 }}>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((frac) => (
          <line key={frac}
            x1={pad.left} x2={width - pad.right}
            y1={pad.top + frac * (height - pad.top - pad.bottom)}
            y2={pad.top + frac * (height - pad.top - pad.bottom)}
            stroke="#2a2a2a" strokeDasharray="4,4" />
        ))}
        {/* Traces */}
        {traces.map(({ getValue, color, min, max, label }) => (
          <polyline key={label} fill="none" stroke={color} strokeWidth={1.5}
            points={history.map((s) => `${x(s.time)},${y(getValue(s), min, max)}`).join(' ')} />
        ))}
        {/* Legend */}
        {traces.map(({ label, color }, i) => (
          <text key={label} x={width - pad.right + 5} y={pad.top + 12 + i * 16}
            fill={color} fontSize={10} fontFamily="monospace">
            {label}
          </text>
        ))}
        {/* Time axis */}
        <text x={width / 2} y={height - 4} fill="#555" fontSize={10}
          textAnchor="middle" fontFamily="monospace">
          {formatTime(tMin)} → {formatTime(tMax)}
        </text>
      </svg>
    </div>
  );
}

function SystemicTrendChart({ history }: { history: Snapshot[] }) {
  const traces: ChartTrace[] = [
    { label: 'MAP',  getValue: (s) => s.map,  color: '#ff4444', min: 30,  max: 140 },
    { label: 'HR',   getValue: (s) => s.hr,   color: '#44ff44', min: 30,  max: 180 },
    { label: 'CO',   getValue: (s) => s.co,   color: '#ffaa44', min: 0,   max: 12  },
    { label: 'SV',   getValue: (s) => s.sv,   color: '#4488ff', min: 0,   max: 130 },
    { label: 'SVR',  getValue: (s) => s.svr,  color: '#ff88ff', min: 4,   max: 32  },
  ];
  return <VitalsChart history={history} traces={traces} title="Systemic: MAP (red) · HR (green) · CO (orange) · SV (blue) · SVR (pink)" />;
}

function PulmonaryTrendChart({ history }: { history: Snapshot[] }) {
  const traces: ChartTrace[] = [
    { label: 'SpO2%', getValue: (s) => s.spO2 * 100,   color: '#00ccff', min: 70, max: 100 },
    { label: 'mPAP',  getValue: (s) => s.mPAP,          color: '#ffcc44', min: 8,  max: 60  },
    { label: 'PCWP',  getValue: (s) => s.pcwp,          color: '#ff8844', min: 2,  max: 40  },
    { label: 'NO%',   getValue: (s) => s.noTone  * 100, color: '#44ffaa', min: 0,  max: 100 },
    { label: 'ET1%',  getValue: (s) => s.et1Tone * 100, color: '#ff6644', min: 0,  max: 100 },
  ];
  return <VitalsChart history={history} traces={traces} title="Pulmonary: SpO2% (cyan) · mPAP (yellow) · PCWP (orange) · NO% (green) · ET-1% (red-orange)" />;
}

function InterventionTimeline({ history, interventions }: { history: Snapshot[]; interventions: Intervention[] }) {
  if (history.length < 2) return null;

  const tMin = history[0].time;
  const tMax = history[history.length - 1].time;

  // Only interventions visible in current window
  const visible = interventions.filter((i) => {
    const end = i.stopTime != null ? i.stopTime + i.tauOff * 3 : tMax;
    return end >= tMin && i.startTime <= tMax;
  });

  if (visible.length === 0) return null;

  const rowH = 18;
  const pad = { left: 130, right: 10, top: 4, bottom: 4 };
  const width = 800;
  const height = pad.top + pad.bottom + visible.length * rowH;

  const x = (t: number) => pad.left + Math.max(0, Math.min(1, (t - tMin) / Math.max(tMax - tMin, 1))) * (width - pad.left - pad.right);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', background: '#111', borderRadius: 4, display: 'block' }}>
      {visible.map((iv, i) => {
        const lineColor = INTERVENTION_LINE_COLORS[iv.category];
        const barColor  = INTERVENTION_COLORS[iv.category];
        const x1 = x(iv.startTime);
        const endT = iv.stopTime != null ? Math.min(iv.stopTime + iv.tauOff * 3, tMax) : tMax;
        const x2 = x(endT);
        const yTop = pad.top + i * rowH;

        return (
          <g key={i}>
            {/* Row background (alternating) */}
            {i % 2 === 0 && <rect x={0} y={yTop} width={width} height={rowH} fill="rgba(255,255,255,0.02)" />}
            {/* Label */}
            <text x={pad.left - 4} y={yTop + rowH * 0.72} textAnchor="end"
              fill={lineColor} fontSize={9} fontFamily="monospace">
              {iv.label}
            </text>
            {/* Duration bar */}
            <rect x={x1} y={yTop + 3} width={Math.max(2, x2 - x1)} height={rowH - 6}
              fill={barColor} rx={2} />
            {/* Start tick */}
            <line x1={x1} x2={x1} y1={yTop} y2={yTop + rowH}
              stroke={lineColor} strokeWidth={1} opacity={0.7} />
          </g>
        );
      })}
      {/* Time axis */}
      <text x={pad.left + (width - pad.left - pad.right) / 2} y={height - 1}
        fill="#444" fontSize={9} textAnchor="middle" fontFamily="monospace">
        {formatTime(tMin)} → {formatTime(tMax)}
      </text>
    </svg>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- Styles ---

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 1100, margin: '0 auto', padding: 20,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#e0e0e0', background: '#1a1a1a', minHeight: '100vh',
  },
  title: { fontSize: 22, fontWeight: 600, marginBottom: 16, color: '#fff' },
  controlBar: {
    display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20,
    padding: '10px 16px', background: '#252525', borderRadius: 8,
  },
  button: {
    padding: '8px 16px', background: '#333', color: '#e0e0e0',
    border: '1px solid #555', borderRadius: 6, cursor: 'pointer', fontSize: 14,
  },
  clearBtn: {
    padding: '5px 12px', background: '#2a2a2a', color: '#aaa',
    border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 12, width: '100%',
  },
  label: { fontSize: 13, color: '#aaa', display: 'flex', alignItems: 'center', gap: 8 },
  select: { padding: '4px 8px', background: '#333', color: '#e0e0e0', border: '1px solid #555', borderRadius: 4 },
  mainGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 },
  panel: { background: '#222', borderRadius: 8, padding: 16, border: '1px solid #333' },
  panelTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12, color: '#ccc' },
  vitalsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  vital: { padding: 10, background: '#1a1a1a', borderRadius: 6, textAlign: 'center' as const, border: '2px solid' },
  timeDisplay: { marginTop: 12, textAlign: 'center' as const, fontFamily: 'monospace', fontSize: 14, color: '#888' },
  patientBanner: {
    marginBottom: 12, padding: '8px 14px', background: '#1e2530',
    borderRadius: 6, border: '1px solid #334', fontSize: 13, color: '#aab',
  },
  scenarioBtn: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start',
    width: '100%', padding: '6px 10px', marginBottom: 0, background: '#2a2a2a',
    color: '#e0e0e0', border: '1px solid #444', borderRadius: 6, cursor: 'pointer', fontSize: 12,
  },
  scenarioGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 10,
  },
  scenarioSection: {
    fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase' as const,
    letterSpacing: '0.06em', marginBottom: 6, marginTop: 4,
  },
};

export default App;
