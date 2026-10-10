#!/usr/bin/env node
/**
 * Top self-time and inclusive-time frames of a CDP `Profiler.stop` result
 * (what the many-windows harness writes as `<session>.profile.json`).
 *
 *   node test/perf/browser/cpuprofile-top.mjs <profile.json> [topN=10]
 */
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
if (!file) { console.error('usage: cpuprofile-top.mjs <profile.json> [topN]'); process.exit(2); }
const topN = Number(topArg ?? 10);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const profile = raw.profile ?? raw;
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const self = new Map();
const total = new Map();
let all = 0;
const label = (node) => {
  const frame = node.callFrame;
  const url = frame.url ? frame.url.replace(/^https?:\/\/[^/]+/, '') : '';
  return `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
};
for (let i = 0; i < profile.samples.length; i += 1) {
  const dt = profile.timeDeltas[i] ?? 0;
  all += dt;
  const leaf = profile.samples[i];
  self.set(leaf, (self.get(leaf) ?? 0) + dt);
  const seen = new Set();
  for (let id = leaf; id !== undefined; id = parent.get(id)) {
    const key = label(nodes.get(id));
    if (seen.has(key)) continue;
    seen.add(key);
    total.set(key, (total.get(key) ?? 0) + dt);
  }
}
const selfByLabel = new Map();
for (const [id, dt] of self) selfByLabel.set(label(nodes.get(id)), (selfByLabel.get(label(nodes.get(id))) ?? 0) + dt);
const fmt = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, topN)
  .map(([name, dt]) => `${(dt / 1000).toFixed(0).padStart(8)} ms ${((dt / all) * 100).toFixed(1).padStart(5)}%  ${name}`).join('\n');
const idle = [...selfByLabel].filter(([name]) => /^\((idle|program|garbage collector)\)/.test(name)).reduce((sum, [, dt]) => sum + dt, 0);
console.log(`profile ${file}: ${(all / 1000).toFixed(0)} ms sampled, ${(((all - (selfByLabel.get('(idle) :0') ?? 0)) / all) * 100).toFixed(1)}% non-idle`);
console.log(`\nTOP ${topN} SELF TIME\n${fmt(selfByLabel)}`);
console.log(`\nTOP ${topN} TOTAL (inclusive) TIME\n${fmt(total)}`);
void idle;
