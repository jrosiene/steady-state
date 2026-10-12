import { it } from 'vitest';
import { DEFAULT_PARAMS, DEFAULT_STATE } from '../src/engine/constants';
import { stepPhysics } from '../src/game/physics';
it('perf', () => {
  let s = { ...DEFAULT_STATE };
  const ivs = [{ label: 'x', category: 'scenario' as const, kind: 'scenario' as const, target: 'noTone' as const, delta: 0.3, tauOn: 60, eliminationHalfLife: 1e6, startTime: 0 }];
  const t0 = performance.now();
  for (let i = 0; i < 300000; i++) s = stepPhysics(s, DEFAULT_PARAMS, ivs, 0.25);
  console.log(`PERF ${((performance.now() - t0) / 300).toFixed(2)} µs/step`);
});
