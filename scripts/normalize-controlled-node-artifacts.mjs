#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TARGETS = ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'];

function sameFile(left, right) {
  const a = statSync(left);
  const b = statSync(right);
  if (a.size !== b.size) return false;
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  return hash(left) === hash(right);
}

function mergeEntry(source, destination) {
  if (!existsSync(destination)) {
    renameSync(source, destination);
    return;
  }
  const sourceStat = statSync(source);
  const destinationStat = statSync(destination);
  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    for (const name of readdirSync(source)) mergeEntry(join(source, name), join(destination, name));
    rmSync(source, { recursive: true, force: true });
    return;
  }
  if (sourceStat.isFile() && destinationStat.isFile() && sameFile(source, destination)) {
    rmSync(source, { force: true });
    return;
  }
  throw new Error(`conflicting controlled-node artifact: ${destination}`);
}

function mergeDirectoryContents(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) mergeEntry(join(source, name), join(destination, name));
  rmSync(source, { recursive: true, force: true });
}

const root = resolve(process.argv[2] ?? 'server/controlled-node-artifacts');
const nestedRoot = join(root, 'dist-node-exe');
mergeDirectoryContents(nestedRoot, root);

const workerRoot = join(root, 'remote-desktop-worker');
mkdirSync(workerRoot, { recursive: true });
for (const target of TARGETS) {
  const source = join(root, target);
  if (existsSync(source)) mergeEntry(source, join(workerRoot, target));
}

console.log(`normalized controlled-node artifacts under ${root}`);
