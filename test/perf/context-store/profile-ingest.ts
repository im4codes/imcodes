/** Per-iteration ingest profile (component split) on a scratch production-shaped DB. */
import { performance } from 'node:perf_hooks';
import * as store from '../../../src/store/context-store.js';

const dbPath = process.env.IMCODES_CONTEXT_DB_PATH?.trim();
if (!dbPath || dbPath.includes('/.imcodes/')) throw new Error('IMCODES_CONTEXT_DB_PATH must be a scratch DB');
const ns = { scope: 'personal', userId: 'synthetic-user', projectId: 'github.com/synthetic/project-0' } as const;
store.getContextMeta('__warm__');
const rows: string[] = [];
for (let i = 0; i < 25; i += 1) {
  const target = { namespace: ns, kind: 'session' as const, sessionName: `deck_synth0_w${i % 60}` };
  const t0 = performance.now();
  const ev = store.recordContextEvent({ target, eventType: 'assistant.text', content: `p ${i} ${'x'.repeat(400)}` });
  const t1 = performance.now();
  const dirty = store.listDirtyTargets(ns);
  const t2 = performance.now();
  store.estimateStagedTokenUpperBound(target);
  const t3 = performance.now();
  store.getLatestRecentSummaryUpdatedAtForTarget(target);
  const t4 = performance.now();
  rows.push(`i=${i} record=${(t1 - t0).toFixed(1)} dirty=${(t2 - t1).toFixed(1)} est=${(t3 - t2).toFixed(1)} latest=${(t4 - t3).toFixed(1)} dirtyN=${dirty.length} ${ev.id.slice(0, 0)}`);
}
console.log(rows.join('\n'));
