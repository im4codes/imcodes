#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const criticalDistFiles = [
  'dist/src/index.js',
  'dist/src/daemon/command-handler.js',
  'dist/src/daemon/server-link.js',
  'dist/src/daemon/timeline-history-worker.js',
  'dist/src/daemon/timeline-history-sanitize.js',
  'dist/src/daemon/timeline-detail-store.js',
  'dist/src/daemon/fs-list-worker.js',
  'dist/src/daemon/fs-git-status-worker.js',
  'dist/src/daemon/fs-list-pool.js',
  'dist/src/daemon/fs-git-status-pool.js',
  'dist/src/daemon/latency-tracer.js',
];

function execGit(args, fallback) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const builtAt = new Date().toISOString();
const gitSha = execGit(['rev-parse', 'HEAD'], 'unknown');
const gitBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], '') || null;
const dirty = execGit(['status', '--porcelain'], '');
let npmVersion = 'unknown';
try {
  npmVersion = execFileSync('npm', ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // optional metadata only
}

const critical = {};
for (const rel of criticalDistFiles) {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) {
    throw new Error(`critical dist file missing: ${rel}`);
  }
  critical[rel] = sha256File(abs);
}

const buildId = createHash('sha256')
  .update(`${gitSha}|${dirty ? 'dirty' : 'clean'}|${builtAt}|${process.versions.node}`)
  .digest('hex')
  .slice(0, 12);

const manifest = {
  schemaVersion: 1,
  buildId,
  gitSha,
  gitDirty: dirty.length > 0,
  gitBranch,
  builtAt,
  node: process.versions.node,
  npmVersion,
  packageVersion: packageJson.version,
  critical,
};

writeFileSync(join(repoRoot, 'dist/.build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote dist/.build-manifest.json (${buildId})`);
