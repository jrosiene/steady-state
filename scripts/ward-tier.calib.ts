/**
 * Ward-tier stress: every ward-level archetype across many seeds (and so many
 * comorbidity combinations) at the severe end, untouched. A ward case should
 * not die overnight; this finds the combinations that make one.
 *   CALIBRATE=1 npx vitest run scripts/ward-tier.calib.ts
 */
import { it } from 'vitest';
import { ARCHETYPES } from '../src/game/content/archetypes';
import { soloShift } from '../src/game/testing';
import { SHIFT_DURATION_SEC } from '../src/game/types';

const SEEDS = Number(process.env.SEEDS ?? 30);
const ONLY = process.env.ONLY?.split(',');

it('ward tier stress', () => {
  const lines: string[] = [];
  for (const a of ARCHETYPES.filter((x) => x.tier === 'ward' && x.id !== 'end-of-life-pneumonia')) {
    if (ONLY && !ONLY.includes(a.id)) continue;
    const lost: string[] = [];
    for (let i = 0; i < SEEDS; i++) {
      for (const severity of [0.7, 1]) {
        const s = soloShift(a.id, { severity, seed: `WARD-${i}`, declareAt: 20 * 60 });
        while (s.engine.time < SHIFT_DURATION_SEC && s.patient.status === 'stable') s.engine.tick(120);
        if (s.patient.status !== 'stable') {
          lost.push(`${severity}/${i} ${s.patient.status} [${s.patient.case.comorbidities.join('+') || '-'}]`);
        }
      }
    }
    lines.push(`${a.id}: ${lost.length}/${SEEDS * 2} lost${lost.length ? '\n    ' + lost.join('\n    ') : ''}`);
  }
  console.log('\n' + lines.join('\n'));
});
