import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const sourceRoot = resolve(process.argv[2] ?? 'coverage/shards');
const outputDir = resolve(process.argv[3] ?? 'coverage');
const mergedPath = resolve(outputDir, 'coverage-final.json');

function findCoverageFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...findCoverageFiles(path));
    else if (entry.isFile() && entry.name === 'coverage-final.json') files.push(path);
  }
  return files;
}

const files = findCoverageFiles(sourceRoot);
if (files.length === 0) {
  console.error(`No shard coverage-final.json files found under ${sourceRoot}`);
  process.exit(1);
}

const map = libCoverage.createCoverageMap({});
for (const file of files) {
  const shardMap = libCoverage.createCoverageMap(JSON.parse(readFileSync(file, 'utf8')));
  map.merge(shardMap);
}

mkdirSync(dirname(mergedPath), { recursive: true });
writeFileSync(mergedPath, `${JSON.stringify(map.toJSON(), null, 2)}\n`);

const context = libReport.createContext({ dir: outputDir, coverageMap: map });
for (const reporter of ['lcovonly', 'json-summary', 'json']) {
  reports.create(reporter).execute(context);
}

console.log(`Merged ${files.length} coverage shard reports into ${outputDir}`);
