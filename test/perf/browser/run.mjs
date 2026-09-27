#!/usr/bin/env node
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { runHarness } from './many-windows.spec.mjs';

const outputDir = process.env.IMC_PERF_OUTPUT ?? `perf-results/${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(outputDir, { recursive: true });
process.env.IMC_PERF_OUTPUT = outputDir;
const loadAverage = async () => {
  try { return (await readFile('/proc/loadavg', 'utf8')).trim(); } catch { return 'unknown'; }
};
process.env.IMC_PERF_CHECKPOINT = `${outputDir}/checkpoint.json`;
let interrupted = false;
const writeInterrupted = async () => {
  if (interrupted) return;
  interrupted = true;
  try {
    const checkpoint = JSON.parse(await readFile(process.env.IMC_PERF_CHECKPOINT, 'utf8'));
    const result = { workload: { sessions: [] }, correctness: { fullStream: false, hiddenFinal: false, restored: false, toggled: false, authoritativeBackfill: false, failures: ['harness interrupted after bounded watchdog'] }, restoreMs: 0, restoreTotalMs: 0, windowCurve: checkpoint.windowCurve ?? [], stallDiagnostics: checkpoint.stallDiagnostics ?? [], longChats: {}, serverDebug: [], metrics: { longTask: { p50: 0, p95: 0, max: 0 }, inputDelay: { p95: 0 }, heapBytes: { first: 0, last: 0, delta: 0 }, fps: { frames: 0, dropped: 0 }, ws: { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, byType: {}, framesByType: {}, seqGaps: [], sockets: {}, byMode: {}, sessionModes: {}, bufferedAmount: { p95: 0, max: 0 }, expectedHiddenFullBytes: 0, hiddenSummaryBytes: 0 } } };
    const report = { schema: 1, generatedAt: new Date().toISOString(), revision: process.env.IMC_PERF_REVISION ?? 'unknown', harness: { sha: process.env.IMC_PERF_HARNESS_SHA ?? 'unknown', dirty: process.env.IMC_PERF_HARNESS_DIRTY === '1', lockWaitMs: Number(process.env.IMC_PERF_LOCK_WAIT_MS ?? 0), loadAverageBefore: process.env.IMC_PERF_LOADAVG_BEFORE ?? 'unknown', loadAverageAfter: await loadAverage() }, interrupted: true, targets: { longTaskP95Ms: 50, inputP95Ms: 100, restoreWorstTaskMs: 100, hiddenBytesReduction: 0.8, heapStable: true }, checks: { correctness: false }, result };
    await writeFile(`${outputDir}/results.json`, JSON.stringify(report, null, 2) + '\n');
    await writeFile(`${outputDir}/summary.md`, `# Many-windows browser performance\n\n- Verdict: FAIL (bounded harness watchdog)\n- Stalled at: ${checkpoint.stalledAt ?? 'unknown'}\n`);
  } finally { process.exit(1); }
};
process.once('SIGTERM', writeInterrupted); process.once('SIGINT', writeInterrupted);
const watchdogMs = Number(process.env.IMC_PERF_WATCHDOG_MS ?? Math.max(180_000, Number(process.env.IMC_PERF_DURATION_MS ?? 10_000) + Number(process.env.IMC_PERF_OPEN_TIMEOUT_MS ?? 120_000) + 60_000));
const watchdog = setTimeout(() => { void writeInterrupted(); }, watchdogMs);
watchdog.unref?.();
const result = await runHarness();
clearTimeout(watchdog);
const targets = { longTaskP95Ms: 50, inputP95Ms: 100, restoreWorstTaskMs: 100, hiddenBytesReduction: 0.8, heapStable: true };
const checks = {
  longTaskP95: result.metrics.longTask.p95 < targets.longTaskP95Ms,
  inputP95: result.metrics.inputDelay.p95 < targets.inputP95Ms,
  restore: result.restoreMs < targets.restoreWorstTaskMs,
  hiddenBytesReduction: result.metrics.ws.expectedHiddenFullBytes > 0
    && 1 - (result.metrics.ws.hiddenSummaryBytes / result.metrics.ws.expectedHiddenFullBytes) >= targets.hiddenBytesReduction,
  correctness: Object.entries(result.correctness).every(([key, value]) => key === 'failures'
    ? Array.isArray(value) && value.length === 0
    : key === 'longChats'
      ? Object.values(value).every(Boolean)
      : value === true),
};
const report = { schema: 1, generatedAt: new Date().toISOString(), revision: process.env.IMC_PERF_REVISION ?? 'unknown', harness: { sha: process.env.IMC_PERF_HARNESS_SHA ?? 'unknown', dirty: process.env.IMC_PERF_HARNESS_DIRTY === '1', lockWaitMs: Number(process.env.IMC_PERF_LOCK_WAIT_MS ?? 0), loadAverageBefore: process.env.IMC_PERF_LOADAVG_BEFORE ?? 'unknown', loadAverageAfter: await loadAverage() }, targets, checks, result };
await writeFile(`${outputDir}/results.json`, `${JSON.stringify(report, null, 2)}\n`);
const hiddenReduction = result.metrics.ws.expectedHiddenFullBytes > 0 ? 1 - (result.metrics.ws.hiddenSummaryBytes / result.metrics.ws.expectedHiddenFullBytes) : 0;
await writeFile(`${outputDir}/summary.md`, `# Many-windows browser performance\n\n- Revision: \`${report.revision}\`\n- Long Task p95: ${result.metrics.longTask.p95.toFixed(2)} ms (target < ${targets.longTaskP95Ms})\n- Input delay p95: ${result.metrics.inputDelay.p95.toFixed(2)} ms (target < ${targets.inputP95Ms})\n- Hidden bytes reduction: ${(hiddenReduction * 100).toFixed(1)}% (target ≥ ${targets.hiddenBytesReduction * 100}%)\n- Restore 20 windows (worst single page): ${result.restoreMs} ms (total ${result.restoreTotalMs} ms; target < ${targets.restoreWorstTaskMs})\n- Correctness: ${checks.correctness ? 'PASS' : 'FAIL'}\n\nMachine-readable data: [results.json](./results.json)\n`);
const exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
process.stdout.write(`${JSON.stringify({ outputDir, checks, revision: report.revision })}\n`, () => {
  // A wedged renderer can leave Playwright IPC handles alive; always emit the
  // verdict and terminate deterministically after the report is flushed.
  process.exit(exitCode);
});
