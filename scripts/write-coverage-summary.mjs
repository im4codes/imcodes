import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const coverageDir = resolve('coverage');
const finalJsonPath = resolve(coverageDir, 'coverage-final.json');
const summaryPath = resolve(coverageDir, 'coverage-summary.json');

function normalizeCoverageSummaryFile() {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function emptyMetric() {
  return { covered: 0, total: 0 };
}

function emptyAggregate() {
  return {
    statements: emptyMetric(),
    lines: emptyMetric(),
    branches: emptyMetric(),
    functions: emptyMetric(),
  };
}

function addMetric(target, source) {
  target.covered += Number(source?.covered ?? 0);
  target.total += Number(source?.total ?? 0);
}

function classifyModule(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.includes('/shared/') || normalized.startsWith('shared/')) return 'shared';
  if (normalized.includes('/server/src/') || normalized.startsWith('server/src/')) return 'server';
  if (normalized.includes('/web/src/') || normalized.startsWith('web/src/')) return 'web';
  if (normalized.includes('/src/') || normalized.startsWith('src/')) return 'daemon';
  return null;
}

function pct(metric) {
  if (!metric.total) return 100;
  return Math.round((metric.covered / metric.total) * 10000) / 100;
}

function formatMetric(metric) {
  return `${pct(metric).toFixed(2)}% (${metric.covered}/${metric.total})`;
}

function printCoverageSummary(summary) {
  if (!summary.total) return;

  console.log(
    `Coverage total: lines ${formatMetric(summary.total.lines)}, ` +
    `branches ${formatMetric(summary.total.branches)}, ` +
    `functions ${formatMetric(summary.total.functions)}, ` +
    `statements ${formatMetric(summary.total.statements)}`,
  );

  const modules = new Map();
  for (const [filePath, fileSummary] of Object.entries(summary)) {
    if (filePath === 'total') continue;
    const moduleName = classifyModule(filePath);
    if (!moduleName) continue;
    if (!modules.has(moduleName)) modules.set(moduleName, emptyAggregate());
    const aggregate = modules.get(moduleName);
    addMetric(aggregate.statements, fileSummary.statements);
    addMetric(aggregate.lines, fileSummary.lines);
    addMetric(aggregate.branches, fileSummary.branches);
    addMetric(aggregate.functions, fileSummary.functions);
  }

  if (modules.size === 0) return;
  console.log('Coverage by module:');
  for (const moduleName of ['shared', 'daemon', 'server', 'web']) {
    const aggregate = modules.get(moduleName);
    if (!aggregate) continue;
    console.log(
      `- ${moduleName}: lines ${formatMetric(aggregate.lines)}, ` +
      `branches ${formatMetric(aggregate.branches)}, ` +
      `functions ${formatMetric(aggregate.functions)}`,
    );
  }
}

if (!existsSync(finalJsonPath)) {
  if (existsSync(summaryPath)) {
    printCoverageSummary(normalizeCoverageSummaryFile());
    process.exit(0);
  }

  console.error(`coverage-final.json not found at ${finalJsonPath}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(finalJsonPath, 'utf8'));
const map = libCoverage.createCoverageMap(raw);

mkdirSync(dirname(summaryPath), { recursive: true });

const context = libReport.createContext({
  dir: coverageDir,
  coverageMap: map,
});

reports.create('json-summary').execute(context);

if (!existsSync(summaryPath)) {
  console.error(`Failed to generate coverage summary at ${summaryPath}`);
  process.exit(1);
}

// Normalize formatting for deterministic diffs if the reporter wrote minified JSON.
printCoverageSummary(normalizeCoverageSummaryFile());
