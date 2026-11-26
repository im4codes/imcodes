#!/usr/bin/env node
/**
 * Like cpuprofile-top.mjs, but maps minified app frames back to source through
 * the sourcemaps of a build made with IMC_PERF_SOURCEMAP=1.
 *
 *   node test/perf/browser/cpuprofile-mapped.mjs <profile.json> <dir-with-.map-files> [topN=25]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const [file, mapDir, topArg] = process.argv.slice(2);
if (!file || !mapDir) { console.error('usage: cpuprofile-mapped.mjs <profile.json> <mapDir> [topN]'); process.exit(2); }
const topN = Number(topArg ?? 25);
const require = createRequire(import.meta.url);
const { TraceMap, originalPositionFor } = require(process.env.TRACE_MAPPING ?? '@jridgewell/trace-mapping');
const maps = new Map();
const mapFor = (url) => {
  const name = url.split('/').pop();
  if (!maps.has(name)) {
    // The profiled build and the sourcemap build can differ only in the chunk
    // hash (a build stamp); fall back to the chunk's prefix when the exact file is absent.
    let path = `${mapDir}/${name}.map`;
    if (!existsSync(path)) {
      const prefix = `${name.split('-')[0]}-`;
      const alt = readdirSync(mapDir).find((entry) => entry.startsWith(prefix) && entry.endsWith('.js.map'));
      path = alt ? `${mapDir}/${alt}` : '';
    }
    maps.set(name, path ? new TraceMap(readFileSync(path, 'utf8')) : null);
  }
  return maps.get(name);
};
const profile = JSON.parse(readFileSync(file, 'utf8')).profile;
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const labelCache = new Map();
const label = (id) => {
  if (labelCache.has(id)) return labelCache.get(id);
  const frame = nodes.get(id).callFrame;
  let text = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}`;
  const map = frame.url ? mapFor(frame.url) : null;
  if (map) {
    const o = originalPositionFor(map, { line: frame.lineNumber + 1, column: frame.columnNumber });
    if (o.source) text = `${(o.name || frame.functionName || '(anon)')} ${o.source.replace(/^(\.\.\/)+/, '')}:${o.line}`;
  }
  labelCache.set(id, text);
  return text;
};
const self = new Map(); const total = new Map(); let all = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const dt = profile.timeDeltas[i] ?? 0; all += dt;
  const leaf = profile.samples[i];
  self.set(label(leaf), (self.get(label(leaf)) ?? 0) + dt);
  const seen = new Set();
  for (let id = leaf; id !== undefined; id = parent.get(id)) {
    const key = label(id);
    if (seen.has(key)) continue; seen.add(key);
    total.set(key, (total.get(key) ?? 0) + dt);
  }
}
const fmt = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, topN)
  .map(([name, dt]) => `${(dt / 1000).toFixed(0).padStart(8)} ms ${((dt / all) * 100).toFixed(1).padStart(5)}%  ${name}`).join('\n');
console.log(`${file}: ${(all / 1000).toFixed(0)} ms sampled`);
console.log(`\nTOP ${topN} SELF\n${fmt(self)}\n\nTOP ${topN} TOTAL\n${fmt(total)}`);
