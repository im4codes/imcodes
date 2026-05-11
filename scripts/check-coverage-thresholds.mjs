import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const summaryPath = resolve('coverage', 'coverage-summary.json');

const thresholds = {
  statements: readThreshold('COVERAGE_STATEMENTS', 75),
  lines: readThreshold('COVERAGE_LINES', 75),
  branches: readThreshold('COVERAGE_BRANCHES', 70),
  functions: readThreshold('COVERAGE_FUNCTIONS', 76),
};

function readThreshold(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(`${name} must be a number from 0 to 100; received ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return value;
}

function formatPct(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

if (!existsSync(summaryPath)) {
  console.error(`coverage summary not found at ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const total = summary.total;
if (!total) {
  console.error(`coverage summary at ${summaryPath} does not contain a total block`);
  process.exit(1);
}

let failed = false;
for (const [metric, minimum] of Object.entries(thresholds)) {
  const actual = Number(total[metric]?.pct ?? 0);
  const ok = actual >= minimum;
  const marker = ok ? 'PASS' : 'FAIL';
  console.log(`${marker} coverage ${metric}: ${formatPct(actual)} >= ${formatPct(minimum)}`);
  if (!ok) failed = true;
}

if (failed) {
  process.exit(1);
}
