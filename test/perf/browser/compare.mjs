#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('usage: node test/perf/browser/compare.mjs <results.json> [...]');
  process.exit(2);
}
const rows = [];
for (const file of inputs) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  const result = report.result;
  const ws = result.metrics.ws;
  const reduction = ws.expectedHiddenFullBytes ? 1 - ws.hiddenSummaryBytes / ws.expectedHiddenFullBytes : 0;
  const correctness = Object.entries(result.correctness).every(([key, value]) => key === 'failures'
    ? Array.isArray(value) && value.length === 0
    : key === 'longChats' ? Object.values(value).every(Boolean) : value === true);
  rows.push({ revision: report.revision, longTaskP95Ms: result.metrics.longTask.p95, inputP95Ms: result.metrics.inputDelay.p95, hiddenReduction: reduction, restoreWorstMs: result.restoreMs, correctness, file });
}
const markdown = ['| Revision | Long Task p95 (ms) | Input p95 (ms) | Hidden reduction | Restore worst (ms) | Correctness |', '|---|---:|---:|---:|---:|:---:|', ...rows.map((r) => `| ${r.revision} | ${r.longTaskP95Ms.toFixed(2)} | ${r.inputP95Ms.toFixed(2)} | ${(r.hiddenReduction * 100).toFixed(1)}% | ${r.restoreWorstMs} | ${r.correctness ? 'PASS' : 'FAIL'} |`)].join('\n');
const output = process.env.IMC_PERF_COMPARE_OUTPUT;
if (output) {
  await writeFile(`${output}.json`, `${JSON.stringify({ schema: 1, rows }, null, 2)}\n`);
  await writeFile(`${output}.md`, `${markdown}\n`);
}
console.log(markdown);
