/**
 * Acuity calibration: deaths on untouched wards across the slider.
 *
 * Not part of the unit suite — it integrates dozens of twelve-hour wards.
 * Run with:  npm run calibrate
 *
 * Counts only unexpected deaths: the comfort-care patient dies untouched at
 * every setting by design, and counting that puts a floor under the quiet end
 * (see the README's acuity table).
 */
import { it } from 'vitest';
import { ShiftEngine } from '../src/game/shift';
import { SHIFT_DURATION_SEC } from '../src/game/types';

const WARDS = Number(process.env.CAL_WARDS ?? 24);
const ACUITIES = [0, 0.35, 0.7, 1];
const EXPECTED_DEATHS = new Set(['end-of-life-pneumonia']);

it('acuity table', () => {
  const rows: string[] = ['| Acuity | Deaths per ward | Wards losing someone | Who died |', '|---|---|---|---|'];
  for (const acuity of ACUITIES) {
    let deaths = 0;
    let wardsLosing = 0;
    const who = new Map<string, number>();
    for (let i = 0; i < WARDS; i++) {
      const engine = new ShiftEngine(undefined, `CAL-${i}`, 8, 'community', acuity);
      engine.start();
      for (let t = 0; t < SHIFT_DURATION_SEC + 60; t += 60) engine.tick(60);
      const died = engine.patients.filter((p) =>
        p.status === 'died' && !EXPECTED_DEATHS.has(p.case.archetypeId));
      deaths += died.length;
      if (died.length > 0) wardsLosing += 1;
      for (const p of died) who.set(p.case.archetypeId, (who.get(p.case.archetypeId) ?? 0) + 1);
    }
    const list = [...who.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ');
    rows.push(`| ${acuity.toFixed(2)} | ${(deaths / WARDS).toFixed(2)} | ${Math.round((100 * wardsLosing) / WARDS)}% | ${list} |`);
  }
  console.log('\n' + rows.join('\n'));
});
