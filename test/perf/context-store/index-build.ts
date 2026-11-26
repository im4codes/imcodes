/** Time each cursor-driven maintenance index build (upgrade path) on a scratch DB. */
import { performance } from 'node:perf_hooks';
import * as store from '../../../src/store/context-store.js';

const dbPath = process.env.IMCODES_CONTEXT_DB_PATH?.trim();
if (!dbPath || dbPath.includes('/.imcodes/')) throw new Error('IMCODES_CONTEXT_DB_PATH must be a scratch DB');
let t0 = performance.now();
store.getContextMeta('__warm__');
console.log(JSON.stringify({ step: 'ensureDb (upgrade over existing DB)', ms: +(performance.now() - t0).toFixed(1) }));
for (let i = 0; i < 40; i += 1) {
  t0 = performance.now();
  const r = store.ensureContextStoreMaintenanceIndexes();
  console.log(JSON.stringify({ step: `index step ${i}`, ms: +(performance.now() - t0).toFixed(1), ...r }));
  if (r.done) break;
}
