import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const coverageDir = resolve('coverage');
const finalJsonPath = resolve(coverageDir, 'coverage-final.json');
const summaryPath = resolve(coverageDir, 'coverage-summary.json');

if (!existsSync(finalJsonPath)) {
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
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
