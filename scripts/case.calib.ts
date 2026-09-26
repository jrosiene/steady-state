/**
 * Per-archetype trajectory probe.
 *
 *   CASE=copd-exacerbation SEV=0.2,0.6,1 ORDERS="duoneb@10,steroids@10" \
 *     CALIBRATE=1 npx vitest run scripts/case.calib.ts
 *
 * ORDERS is a comma list of orderId@minutesAfterDeclaration. Prints hourly
 * snapshots and the outcome, for eyeballing a case while authoring it.
 */
import { it } from 'vitest';
import { advanceToDeclaration, soloShift } from '../src/game/testing';
import { SHIFT_DURATION_SEC } from '../src/game/types';
import { respiratoryRate } from '../src/game/clinical';

const CASE = process.env.CASE ?? 'copd-exacerbation';
const SEVS = (process.env.SEV ?? '0.2,0.6,1').split(',').map(Number);
const ORDERS = (process.env.ORDERS ?? '').split(',').filter(Boolean).map((o) => {
  const [id, at] = o.split('@');
  return { id, at: Number(at ?? 0) };
});
const STEP_MIN = Number(process.env.STEP ?? 30);

it(`probe ${CASE}`, () => {
  const out: string[] = [];
  for (const severity of SEVS) {
    const shift = soloShift(CASE, { severity });
    const { engine, patient: p } = shift;
    out.push(`\n== ${CASE} severity ${severity} (declares ${Math.round(shift.declaresAt / 60)} min) ` +
      `orders: ${ORDERS.map((o) => `${o.id}@${o.at}`).join(' ') || 'none'}`);
    const pending = [...ORDERS].sort((a, b) => a.at - b.at);
    let worstPh = 8;
    let maxCo2 = 0;
    for (let minute = -15; engine.time < SHIFT_DURATION_SEC - 300 && p.status !== 'died'; minute += 5) {
      while (pending.length && pending[0].at <= minute) {
        const o = pending.shift()!;
        const err = engine.placeOrder(p, o.id);
        if (err) out.push(`   order ${o.id}: ${err}`);
      }
      advanceToDeclaration(shift, minute, 30);
      const s = engine.snapshot(p);
      worstPh = Math.min(worstPh, s.pH);
      maxCo2 = Math.max(maxCo2, s.paCO2);
      if ((minute + 15) % STEP_MIN === 0) {
        out.push(`  +${String(minute).padStart(4)}m  MAP ${s.map.toFixed(0).padStart(3)} HR ${s.hr.toFixed(0).padStart(3)} ` +
          `RR ${String(respiratoryRate(s, p.case.rrOffset)).padStart(2)} SpO2 ${(s.spO2 * 100).toFixed(0)} FiO2 ${s.fiO2.toFixed(2)} ` +
          `PaCO2 ${s.paCO2.toFixed(0).padStart(3)} pH ${s.pH.toFixed(2)} lac ${s.lactate.toFixed(1)} ` +
          `cns ${s.cnsDepression.toFixed(2)} VE ${s.ve.toFixed(1)}/${s.veDemand.toFixed(1)}/${s.veCapacity.toFixed(1)} ` +
          `${s.cardiovascularStatus} ${p.o2Device} [${p.status}]`);
      }
    }
    out.push(`  outcome: ${p.status}${p.outcome ? ` — ${p.outcome.summary}` : ''}; worst pH ${worstPh.toFixed(2)}, max PaCO2 ${maxCo2.toFixed(0)}`);
    const pages = p.messages.filter((m) => m.kind === 'page').map((m) => `    page ${Math.round(m.time / 60)}m: ${m.text}`);
    out.push(...pages.slice(0, 6));
  }
  console.log(out.join('\n'));
});
