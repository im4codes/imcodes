import { readFileSync } from 'node:fs';

const [baseFile, fixedFile] = process.argv.slice(2);
if (!baseFile || !fixedFile) throw new Error('usage: send-latency-compare.mjs <base.json> <fixed.json>');
const base = JSON.parse(readFileSync(baseFile, 'utf8'));
const fixed = JSON.parse(readFileSync(fixedFile, 'utf8'));
const ms = (value) => (typeof value === 'number' ? `${Math.round(value)} ms` : 'n/a');
const rows = [];
for (const series of ['idle', 'block']) {
  for (const metric of ['spinnerMs', 'ackMs']) {
    for (const stat of ['p50', 'p95', 'max']) {
      rows.push(`| ${series}${series === 'block' ? ` (${base.blockMs} ms main-thread block)` : ''} | ${metric === 'spinnerMs' ? 'click -> spinner ends' : 'click -> accepted ack frame'} ${stat} | ${ms(base[series].summary[metric][stat])} | ${ms(fixed[series].summary[metric][stat])} |`);
    }
  }
}
console.log(`| series | metric | ${base.revision} | ${fixed.revision} |\n|---|---|---|---|\n${rows.join('\n')}`);
console.log(`\nend reasons  base: ${JSON.stringify(base.block.summary.endReasons)}  fixed: ${JSON.stringify(fixed.block.summary.endReasons)}`);
